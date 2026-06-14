/**
 * ADR-100: Долг внимания — структурное решение проблемы голодания внимания в группах.
 *
 * Полю давления не хватает измерения временного интегрирования, из-за чего чистая жадная выборка + ограниченные ресурсы = системное голодание.
 * Attention debt накладывается на NSV как stored pressure (эффект хранения MCT),
 * постепенно накапливая конкурентное преимущество у давящих каналов, которые постоянно игнорируются.
 *
 * Рекуррентная формула:
 *   D_h(n) = D_h(n-1) × (1 - δ) + 1[target ≠ h] × API_h(n)
 *
 * Бонус NSV:
 *   NSV_debt(a, h, n) = NSV(a, h, n) + μ_D × tanh(D_h / κ_D)
 *
 * Чистая функция API, не хранит состояние.
 *
 * @see docs/adr/100-attention-debt.md §9
 * @see paper-pomdp/ §7 Discussion: Multi-Channel Attention Allocation as Fair RMAB
 */

/** Базовый масштаб dt (секунды). Формула затухания (1-δ)^(dt/BASE) сохраняет числовую согласованность с тиковым интервалом 60s. */
const DT_BASE_S = 60;

export interface AttentionDebtConfig {
  /** Коэффициент затухания, предотвращающий бесконечное накопление. */
  delta: number;
  // ADR-218 Phase 2: muD/kappaD удалены (computeDebtBonus удалён).
  // delta сохранён для использования в updateAttentionDebt.
}

export const DEFAULT_ATTENTION_DEBT_CONFIG: AttentionDebtConfig = {
  delta: 0.05,
};

/** Если канал не получал новых сообщений дольше этого порога → только затухание долга, без накопления. */
const STALE_THRESHOLD_MS = 7 * 24 * 3600 * 1000; // 7 дней

/**
 * Обновляет debt map: долг внимания каждого канала.
 *
 * D_h(n) = D_h(n-1) × (1 - δ) + 1[target(n-1) ≠ h] × API_h(n)
 *
 * - Выбранный channel: долг только затухает (без накопления)
 * - Невыбранный channel с давлением: долг растёт
 * - Channel без давления (API_h=0): долг только затухает (мёртвые группы не накапливают)
 * - Channel без новых сообщений дольше STALE_THRESHOLD: только затухание (холодные каналы не накапливают)
 *
 * @param prevDebt - debt map предыдущего тика
 * @param channelPressures - channel → вклад давления этого канала (API_h(n))
 * @param selectedTarget - цель, выбранная на предыдущем тике (null = молчание)
 * @param config - параметры затухания
 * @param dt - шаг времени текущего тика (секунды). Используется для масштабирования затухания (1-δ)^(dt/60).
 * @param lastIncomingMs - channel → время настенных часов последнего входящего сообщения (ms).
 *   Каналы без сообщений дольше STALE_THRESHOLD только затухают без накопления,
 *   при поступлении нового сообщения накопление автоматически восстанавливается — управляется сообщениями, а не временем.
 * @param nowMs - текущее время настенных часов (ms).
 * @returns новый debt map (исходный map не изменяется)
 */
export function updateAttentionDebt(
  prevDebt: Map<string, number>,
  channelPressures: Map<string, number>,
  selectedTarget: string | null,
  config: AttentionDebtConfig,
  dt: number = DT_BASE_S,
  lastIncomingMs?: Map<string, number>,
  nowMs?: number,
): Map<string, number> {
  const now = nowMs ?? Date.now();
  const newDebt = new Map<string, number>();
  // Объединяем все известные каналы: присутствующие в prevDebt + присутствующие в channelPressures
  const allChannels = new Set([...prevDebt.keys(), ...channelPressures.keys()]);

  for (const ch of allChannels) {
    const prev = prevDebt.get(ch) ?? 0;
    const pressure = channelPressures.get(ch) ?? 0;
    const wasSelected = ch === selectedTarget;

    // Определение холодного канала: нет новых сообщений более 7 дней → только затухание, без накопления долга.
    // При поступлении нового сообщения last_incoming_ms обновляется → isStale=false → нормальное накопление восстанавливается.
    const lastMsg = lastIncomingMs?.get(ch);
    const isStale = lastMsg != null && lastMsg > 0 && now - lastMsg > STALE_THRESHOLD_MS;

    // D_h(n) = D_h(n-1) × (1-δ)^(dt/60) + 1[target ≠ h] × API_h(n)
    // При dt=60s вырождается в прежнее поведение (1-δ)^1
    const decayed = prev * (1 - config.delta) ** (dt / DT_BASE_S);
    const accumulated = wasSelected || isStale ? 0 : pressure;
    const debt = decayed + accumulated;

    // Сохраняем только значимый долг (предотвращаем бесконечный рост map)
    if (debt > 1e-6) {
      newDebt.set(ch, debt);
    }
  }

  return newDebt;
}

// ADR-218 Phase 2: computeDebtBonus удалён.
// U_coverage заменён на U_fairness (post-scoring pass в iaus-scorer.ts).
// updateAttentionDebt сохранён — накопление долга по-прежнему используется для мониторинга давления и как входные данные channelPressures.

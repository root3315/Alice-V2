/**
 * Model-tiering (#23): решает, идёт ли тик по Opus-маршруту.
 *
 * Opus задействуется ТОЛЬКО для реальной ops-работы в работач — когда к Алисе
 * там обращаются (вопрос / код-ревью / триаж) или прилетел инцидент. Автономные
 * патрули и фоновая болтовня в работач остаются на sonnet: Opus «просто так»
 * не жжём (и не упираемся в его лимиты ради ерунды).
 *
 * Сигнал «к ней обращаются» берём из ChannelAttrs — его выставляет telegram/mapper.ts
 * на directed-сообщение (reply / @mention / личка): pending_directed++ и
 * last_directed_ms = now. Инцидент попадает сюда же через WS-4 (events.ts), где для
 * ops-инцидента senderIsBot принудительно false → mapper засчитывает его как directed.
 *
 * Чистая функция (env и часы передаются аргументами) — тестируется напрямую.
 */

/** Окно «активной задачи»: ответ/ревью может занять несколько тиков (grep→read→reason→reply). */
export const OPS_OPUS_WINDOW_MS = 10 * 60_000;

/** Минимально нужные поля канала (подмножество ChannelAttrs). */
export interface OpsDirectedSignal {
  pending_directed?: number;
  last_directed_ms?: number;
}

/**
 * true ⟺ тик идёт в работач И к Алисе там сейчас реально обращаются:
 *   - есть необработанное directed-сообщение (pending_directed > 0), либо
 *   - её адресовали в пределах окна (свежий last_directed_ms).
 *
 * Иначе (другой канал, нет ops-канала, или автономный патруль в работач) → false.
 */
export function shouldUseOpsModel(
  channelId: string | null,
  opsChannelId: string | undefined,
  channel: OpsDirectedSignal | null,
  nowMs: number,
  windowMs: number = OPS_OPUS_WINDOW_MS,
): boolean {
  if (!opsChannelId || channelId !== opsChannelId || !channel) return false;
  const pending = channel.pending_directed ?? 0;
  const lastMs = channel.last_directed_ms ?? 0;
  return pending > 0 || (lastMs > 0 && nowMs - lastMs < windowMs);
}

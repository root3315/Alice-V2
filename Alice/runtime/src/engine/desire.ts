/**
 * ADR-185 §1: Промежуточный слой Desire — tension → вывод явных целей.
 *
 * Вставляет слой Desire между сигналами давления и оценкой IAUS, агрегируя
 * разрозненные per-target сигналы напряжения в семантические цели («хочу написать Мише», «надо ответить в тот тред»).
 *
 * Desire действует как пост-CF мультипликативный буст (аналогично ADR-182 D1 Momentum), а не как Consideration:
 * - urgency производится из измерений tension и разделяет источник данных со specialist Considerations → как Consideration даст double-count
 * - Post-CF boost не меняет количество Consideration n → повторная калибровка CF не нужна
 * - Нежелаемые target не штрафуются (в отличие от почти-вето-эффекта схемы на основе Consideration)
 *
 * @see docs/adr/185-ecm-cross-pollination.md §1
 * @see docs/adr/182-v-maximizer-refactor.md D1 Momentum Bonus (прецедент)
 */

import { safeDisplayName } from "../graph/display.js";
import type { TensionVector } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { effectiveObligation } from "../pressure/signal-decay.js";

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

export type DesireType =
  | "fulfill_duty" // P5 высокий
  | "reconnect" // P3 высокий
  | "resolve_thread" // P4 высокий
  | "reduce_backlog" // P1 высокий
  | "explore"; // P6 высокий

export interface Desire {
  type: DesireType;
  targetId: string;
  /** urgency ∈ (0, 1] — чем выше, тем срочнее. */
  urgency: number;
  /** Человекочитаемая метка (например "reply to Миша"). */
  label: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Константы
// ═══════════════════════════════════════════════════════════════════════════

const MAX_DESIRES = 10;

/** Минимальный порог каждого измерения для генерации desire. Ниже порога → сигнал недостаточно силён, явная цель не формируется. */
const DESIRE_THRESHOLDS: Record<DesireType, number> = {
  fulfill_duty: 0.2,
  reconnect: 0.3,
  resolve_thread: 0.4,
  reduce_backlog: 0.5,
  explore: 0.3,
};

// ═══════════════════════════════════════════════════════════════════════════
// Основные функции
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Выводит список явных Desire из tensionMap.
 *
 * Обходит вектор напряжений каждой сущности channel, проверяет превышение порога по 5 измерениям.
 * Полученные desires сортируются по убыванию urgency, берётся top MAX_DESIRES.
 *
 * Чистая функция, без зависимостей от DB/LLM.
 */
export function deriveDesires(
  tensionMap: Map<string, TensionVector>,
  G: WorldModel,
  nowMs: number,
): Desire[] {
  const desires: Desire[] = [];

  for (const [entityId, t] of tensionMap) {
    const name = safeDisplayName(G, entityId);

    // P5: Обязанность ответить — используем effectiveObligation (с затуханием)
    const obligation = G.has(entityId) ? effectiveObligation(G, entityId, nowMs) : 0;
    if (obligation > DESIRE_THRESHOLDS.fulfill_duty) {
      desires.push({
        type: "fulfill_duty",
        targetId: entityId,
        urgency: Math.min(1, obligation),
        label: `reply to ${name}`,
      });
    }

    // P3: Охлаждение отношений
    if (t.tau3 > DESIRE_THRESHOLDS.reconnect) {
      desires.push({
        type: "reconnect",
        targetId: entityId,
        urgency: Math.min(1, t.tau3),
        label: `reconnect with ${name}`,
      });
    }

    // P4: Расхождение треда
    if (t.tau4 > DESIRE_THRESHOLDS.resolve_thread) {
      desires.push({
        type: "resolve_thread",
        targetId: entityId,
        urgency: Math.min(1, t.tau4),
        label: `resolve thread in ${name}`,
      });
    }

    // P1: Накопленные непрочитанные
    if (t.tau1 > DESIRE_THRESHOLDS.reduce_backlog) {
      desires.push({
        type: "reduce_backlog",
        targetId: entityId,
        urgency: Math.min(1, t.tau1),
        label: `reduce backlog for ${name}`,
      });
    }

    // P6: Любопытство
    if (t.tau6 > DESIRE_THRESHOLDS.explore) {
      desires.push({
        type: "explore",
        targetId: entityId,
        urgency: Math.min(1, t.tau6),
        label: `explore ${name}`,
      });
    }
  }

  // Сортируем по убыванию urgency, обрезаем до MAX_DESIRES
  desires.sort((a, b) => b.urgency - a.urgency);
  return desires.slice(0, MAX_DESIRES);
}

/**
 * Находит desire с наибольшим urgency для указанного target в уже отсортированном списке.
 *
 * desires отсортированы по убыванию urgency, find возвращает первое совпадение = наибольший urgency.
 */
export function findTopDesireForTarget(
  desires: readonly Desire[],
  targetId: string,
): Desire | undefined {
  return desires.find((d) => d.targetId === targetId);
}

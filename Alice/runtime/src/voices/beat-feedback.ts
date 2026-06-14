/**
 * ADR-23 Wave 2: Многомерная обратная связь личности, управляемая типами Beat.
 *
 * Заменяет бинарный механизм success ? 0.7 : -0.5 из v4.
 * Каждый тип Beat соответствует набору направлений корректировки весов голосов,
 * что позволяет эволюции вектора личности точнее отражать паттерны социального поведения Алисы.
 *
 * Есть BEAT → используем многомерную обратную связь BEAT_FEEDBACK_MAP
 * Нет BEAT → деградация до понижающей обратной связи v4 (success ? 0.2 : -0.5)
 *
 * ADR-214 Wave B: параметр изменён с ExecutableResult на ScriptExecutionResult.
 * В shell-native BEAT/rate_outcome выполняются через Engine API dispatch,
 * не отслеживаются в completedActions. extractBeatTypes/extractOutcomeFeedback
 * в текущей архитектуре всегда возвращают пустое значение — обратная связь деградирует до пути v4 (success ? 0.3 : -0.3).
 * Интерфейс сохранён для последующего расширения completedActions.
 *
 * ADR-131: QUALITY_MAP — единственный источник семантического отображения для rate_outcome.
 * observer.mod и extractOutcomeFeedback используют совместно, устраняя семантические расхождения.
 */
import type { ScriptExecutionResult } from "../core/script-execution.js";
import type { BeatType } from "../mods/threads.mod.js";

/** Обратная связь по одному голосу. */
export interface VoiceFeedback {
  /** Индекс голоса: 0=Diligence, 1=Curiosity, 2=Sociability, 3=Caution. ADR-81: 4 измерения. */
  voice: number;
  /** Величина обратной связи (положительная = усиление, отрицательная = подавление). */
  magnitude: number;
}

/**
 * Отображение типов Beat → обратная связь вектора личности.
 *
 * Принципы проектирования:
 * - observation → любопытство получает удовлетворение
 * - engagement → социальные навыки развиваются
 * - assistance → добросовестность подтверждается
 * - misstep → осторожность усиливается + социальность слегка подавляется (обучение на ошибках)
 * - connection → социальность усиливается (глубокая связь)
 * - insight → подтверждение проницательности (ADR-81: маппинг на Curiosity, рефлексия — эмерджентное свойство)
 */
export const BEAT_FEEDBACK_MAP: Record<string, VoiceFeedback[]> = {
  observation: [{ voice: 1, magnitude: 0.3 }],
  engagement: [{ voice: 2, magnitude: 0.3 }],
  assistance: [{ voice: 0, magnitude: 0.3 }],
  misstep: [
    { voice: 3, magnitude: 0.4 },
    { voice: 2, magnitude: -0.2 },
  ],
  connection: [{ voice: 2, magnitude: 0.5 }],
  insight: [{ voice: 1, magnitude: 0.4 }], // ADR-81: voice 4 (Reflection) → voice 1 (Curiosity)
  // ADR-181: путь положительного усиления Caution (RST BIS сигнал "relief")
  prudence: [
    { voice: 3, magnitude: 0.3 }, // осторожная оценка успешна → положительное усиление Caution
    { voice: 1, magnitude: 0.15 }, // осторожность даёт инсайт → лёгкое усиление Curiosity
  ],
  breakthrough: [
    { voice: 2, magnitude: 0.4 }, // социальный риск удался → усиление Sociability
    { voice: 3, magnitude: -0.2 }, // успешное приближение → награда BAS подавляет BIS
  ],
  // kernel и ambient используют обратную связь по умолчанию
};

/**
 * ADR-131: Единственный источник маппинга семантических меток LLM → числа.
 *
 * Параметр quality у rate_outcome является семантической меткой (принцип ADR-50),
 * маппинг выполняется здесь на стороне кода. Используется совместно observer.mod и extractOutcomeFeedback.
 * @see docs/adr/131-feedback-loop-integrity.md §D1
 */
export const QUALITY_MAP: Record<string, number> = {
  excellent: 0.9,
  good: 0.5,
  fair: 0.0,
  poor: -0.5,
  terrible: -0.9,
};

/**
 * Извлекает beatType вызовов BEAT из ScriptExecutionResult.
 *
 * ADR-214 Wave B: в shell-native BEAT выполняется через Engine API dispatch,
 * не отслеживается в completedActions. В настоящее время всегда возвращает пустой массив.
 * Интерфейс сохранён для последующего расширения формата completedActions.
 */
export function extractBeatTypes(_result: ScriptExecutionResult): BeatType[] {
  // shell-native: dispatch-действия не отслеживаются в completedActions
  // Формат completedActions: "sent:chatId=X:msgId=Y", "sticker:...", "forwarded:..." и т.д.
  // BEAT dispatch не выводит управляющую строку __ALICE_ACTION__
  return [];
}

/**
 * Извлекает многомерную обратную связь личности из массива типов Beat.
 *
 * Возвращает null, если Beat отсутствует (следует деградировать до обратной связи v4).
 * Обратная связь нескольких Beat суммируется.
 *
 * ADR-214 Wave B: в shell-native всегда возвращает null (нет данных BEAT).
 */
export function extractBeatFeedback(result: ScriptExecutionResult): VoiceFeedback[] | null {
  const beatTypes = extractBeatTypes(result);
  if (beatTypes.length === 0) return null;

  const feedbacks: VoiceFeedback[] = [];
  for (const bt of beatTypes) {
    const mapped = BEAT_FEEDBACK_MAP[bt];
    if (mapped) {
      feedbacks.push(...mapped);
    }
  }

  return feedbacks.length > 0 ? feedbacks : null;
}

/**
 * ADR-31: Извлекает обратную связь личности в реальном времени из инструкции rate_outcome.
 *
 * ADR-214 Wave B: в shell-native rate_outcome выполняется через dispatch,
 * не отслеживается в completedActions. В настоящее время всегда возвращает null.
 */
export function extractOutcomeFeedback(_result: ScriptExecutionResult): VoiceFeedback[] | null {
  // shell-native: dispatch-действия не отслеживаются в completedActions
  return null;
}

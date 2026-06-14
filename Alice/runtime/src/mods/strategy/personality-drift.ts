/**
 * Strategy Mod — аудит дрейфа личности.
 *
 * M4 детекция дрейфа личности:
 * - drift = l2Distance(π_current, π_home): накопленное отклонение
 * - velocity = l2Distance(π_current, π_previous) / interval: мгновенная скорость изменения
 * - Классификация: healthy (< 0.1) / warning (0.1~0.2) / alert (>= 0.2)
 *
 * Ссылка: Ashton & Lee (2007) HEXACO — личность долгосрочно стабильна, но среда может вызвать дрейф.
 */
import { PromptBuilder } from "../../core/prompt-style.js";
import type { ContributionItem, ModContext } from "../../core/types.js";
import { section } from "../../core/types.js";
import { estimateAgeS } from "../../pressure/clock.js";
import { l2Distance } from "../../utils/math.js";
import { VOICE_COUNT } from "../../voices/personality.js";
import {
  DRIFT_ALERT_THRESHOLD,
  DRIFT_AUDIT_INTERVAL,
  DRIFT_WARNING_THRESHOLD,
  parseJsonWeights,
  type StrategyHint,
  type StrategyState,
} from "./types.js";

/**
 * Парсинг и автоматическое исправление размерности весов личности.
 *
 * В graph-атрибутах могут оставаться данные старых размерностей (например, 5-мерный вектор до ADR-81).
 * Функция:
 * 1. Разбирает JSON-веса
 * 2. При несовпадении размерности автоматически исправляет (обрезает лишние / добавляет равномерные значения) и нормирует до sum=1
 * 3. Записывает исправленные данные обратно в graph-атрибут (самоисцеление — грязные данные исправляются один раз, последующие tick не триггерятся)
 *
 * @param raw       Сырое значение graph-атрибута
 * @param attrName  Имя атрибута (для записи обратно)
 * @param graph     Ссылка на граф (для записи обратно)
 * @returns Гарантированный массив весов размерности VOICE_COUNT
 */
function resolveWeights(
  raw: unknown,
  attrName: string,
  graph: ModContext<StrategyState>["graph"],
): number[] {
  const parsed = parseJsonWeights(raw);
  if (!parsed) {
    // Нет данных → равномерное распределение
    return Array.from({ length: VOICE_COUNT }, () => 1 / VOICE_COUNT);
  }
  if (parsed.length === VOICE_COUNT) return parsed;

  // Размерность не совпадает → автоматическое исправление
  let fixed: number[];
  if (parsed.length > VOICE_COUNT) {
    // Обрезка лишних измерений
    fixed = parsed.slice(0, VOICE_COUNT);
  } else {
    // Дополнение равномерными значениями
    fixed = [...parsed];
    const pad = 1 / VOICE_COUNT;
    while (fixed.length < VOICE_COUNT) fixed.push(pad);
  }
  // Нормировка до sum=1
  const sum = fixed.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (let i = 0; i < fixed.length; i++) fixed[i] /= sum;
  }
  // Запись обратно в graph-атрибут — самоисцеление, следующий раз исправление не триггерится
  if (graph.has("self")) {
    graph.setDynamic("self", attrName, JSON.stringify(fixed));
  }
  return fixed;
}

/**
 * Аудит дрейфа личности — оценка отклонения каждые DRIFT_AUDIT_INTERVAL тиков.
 *
 * Вызывается в onTickEnd. Изменяет ctx.state.personalityDrift и записывает в graph-атрибуты.
 *
 * @returns hint дрейфа (при warning/alert) или null
 */
export function auditPersonalityDrift(ctx: ModContext<StrategyState>): StrategyHint | null {
  if (ctx.tick <= 0 || ctx.tick % DRIFT_AUDIT_INTERVAL !== 0 || !ctx.graph.has("self")) {
    return null;
  }

  const selfAttrs = ctx.graph.getAgent("self");
  const currentWeights = resolveWeights(
    selfAttrs.personality_weights,
    "personality_weights",
    ctx.graph,
  );
  const piHome = resolveWeights(selfAttrs.pi_home, "pi_home", ctx.graph);

  const pd = ctx.state.personalityDrift;
  const drift = l2Distance(currentWeights, piHome);
  // При несовпадении размерности previousWeights считаем первым аудитом (velocity=0)
  const prevWeights = pd.previousWeights;
  const prevValid = prevWeights !== null && prevWeights.length === VOICE_COUNT;
  // ADR-110/166: velocity вычисляется через estimateAgeS с единым fallback wall-clock/tick
  const elapsedS = Math.max(
    1,
    estimateAgeS({ ms: pd.lastAuditMs ?? 0, tick: pd.lastAuditTick }, ctx.nowMs, ctx.tick),
  );
  const velocity = prevValid ? l2Distance(currentWeights, prevWeights) / elapsedS : 0;

  let health: "healthy" | "warning" | "alert";
  if (drift >= DRIFT_ALERT_THRESHOLD) health = "alert";
  else if (drift >= DRIFT_WARNING_THRESHOLD) health = "warning";
  else health = "healthy";

  pd.drift = drift;
  pd.velocity = velocity;
  pd.health = health;
  pd.previousWeights = [...currentWeights];
  pd.lastAuditTick = ctx.tick;
  pd.lastAuditMs = ctx.nowMs;

  // Запись в graph-атрибуты (для адаптивного γ в evolve.ts и внешней диагностики)
  // Примечание: drift/velocity — внутренние значения движка, не должны попадать в LLM.
  // Префикс _ маркирует внутренние атрибуты; health — семантическая метка, безопасна для показа.
  ctx.graph.setDynamic("self", "_personality_drift", drift);
  ctx.graph.setDynamic("self", "_personality_velocity", velocity);
  ctx.graph.setDynamic("self", "personality_health", health);

  if (health === "healthy") return null;

  return {
    type: "personality_drift",
    message:
      health === "alert"
        ? "Personality shifted significantly from baseline. Recent interactions may be pulling away from natural tendencies."
        : "Personality drifted slightly from baseline. Minor drift is normal.",
  };
}

/**
 * Формирует contribute-секцию дрейфа личности.
 *
 * Инжектируется всегда (при наличии данных аудита), содержимое зависит от health.
 *
 * @returns ContributionItem или null (если данных аудита нет)
 */
export function buildDriftSection(state: StrategyState): ContributionItem | null {
  if (state.personalityDrift.lastAuditTick <= 0) return null;

  const pd = state.personalityDrift;
  const driftLabel =
    pd.health === "alert"
      ? "significant drift from baseline"
      : pd.health === "warning"
        ? "noticeable drift from baseline"
        : "within normal range";
  const driftBuilder = new PromptBuilder();
  driftBuilder.line(`Personality: ${driftLabel}.`);
  if (pd.health === "alert") {
    driftBuilder.line(
      "Personality shifted significantly from baseline. Recent interactions may be pulling away from natural tendencies.",
    );
  }
  return section("personality-drift", driftBuilder.build(), "Personality audit", 35, 55);
}

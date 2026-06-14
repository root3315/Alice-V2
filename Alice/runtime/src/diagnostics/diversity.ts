/**
 * A2 Анализ разнообразия голосов — автоматизированная проверка поведения ADR-76.
 *
 * - Энтропия Шеннона (H) выбора голоса → сравнение с теоретическим максимумом HUMA Timeliness
 * - Частота смены голоса (последовательные повторы / всего действий) → проверка эффекта voice fatigue ADR-75
 * - Отслеживание дрейфа личности (скорость изменения π vs соотношение периода осцилляций давления) → медленная переменная памяти V5
 *
 * @see docs/adr/76-naturalness-validation-methodology.md
 * @see docs/adr/74-huma-cross-pollination/74-huma-cross-pollination.md §Разрыв1
 * @see docs/adr/75-deliberation-state/75-deliberation-state.md
 */

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import {
  actionLog,
  candidateTrace,
  decisionTrace,
  personalitySnapshots,
  tickLog,
} from "../db/schema.js";
import { VOICE_COUNT } from "../voices/personality.js";

const IAUS_ACTION_VOICE_COUNT = 3;

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

export interface VoiceDiversityReport {
  /** Энтропия Шеннона H выбора голоса (бит). Максимум = log2(5) ≈ 2.32. */
  shannonEntropy: number;
  /** Теоретическая максимальная энтропия (= log2(количество голосов)). */
  maxEntropy: number;
  /** Нормализованная энтропия H/H_max ∈ [0, 1]. 1 = полностью равномерно, 0 = только один голос. */
  normalizedEntropy: number;
  /** Частота использования каждого голоса. */
  voiceFrequencies: Record<string, number>;
  /** Доля последовательных повторов голоса = число повторов / (всего действий - 1). */
  consecutiveRepeatRate: number;
  /** Анализ дрейфа личности (требует данных personality_snapshots). */
  personalityDrift: PersonalityDriftReport | null;
  /** Последовательности голосов, разбитые по наблюдательным слоям. Авторитетный план A2 — voice_selection_tick_log. */
  planes: Record<string, VoiceDiversityPlaneReport>;
  /** Текущий авторитетный наблюдательный план A2. */
  authorityPlane: "voice_selection_tick_log";
}

export interface VoiceDiversityPlaneReport {
  /** Количество выборок. */
  sampleCount: number;
  /** Энтропия Шеннона H выбора голоса (бит). */
  shannonEntropy: number;
  /** Теоретическая максимальная энтропия для текущего наблюдательного плана. */
  maxEntropy: number;
  /** Нормализованная энтропия H/H_max ∈ [0, 1]. */
  normalizedEntropy: number;
  /** Частота использования каждого голоса. */
  voiceFrequencies: Record<string, number>;
  /** Доля последовательных повторов голоса. */
  consecutiveRepeatRate: number;
}

export interface PersonalityDriftReport {
  /** Скорость изменения π (среднее L2-смещение за один tick). */
  meanDriftPerTick: number;
  /** Период осцилляций давления (медиана интервалов между действиями). */
  pressureOscillationPeriod: number;
  /**
   * Соотношение временных масштабов дрейфа = число тиков для достижения значимого изменения π (> 0.1) / период осцилляций.
   * Прогноз V5: это соотношение >> 1 (память — медленная переменная).
   */
  driftToOscillationRatio: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Функции анализа
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Анализирует разнообразие голосов.
 *
 * Читает последовательность выборов голоса из tick_log, вычисляет энтропию Шеннона и частоту смены.
 * Читает эволюцию π из personality_snapshots, вычисляет скорость дрейфа.
 */
export function analyzeVoiceDiversity(): VoiceDiversityReport {
  const db = getDb();

  // ── 1. Авторитетная последовательность выбора голоса ───────────────────────────────────────────────
  // ADR-124 D7: tick_log.action — победитель по громкости; action_log — запись нижележащего выполнения.
  const voiceSelections = db
    .select({ voice: tickLog.action })
    .from(tickLog)
    .orderBy(asc(tickLog.tick), asc(tickLog.id))
    .all();

  const authority = summarizeVoiceSequence(voiceSelections, VOICE_COUNT);
  const planes = buildVoiceDiversityPlanes(db, authority);

  // ── 3. Дрейф личности (V5) ────────────────────────────────────────────────
  const personalityDrift = analyzePersonalityDrift(db);

  return {
    shannonEntropy: authority.shannonEntropy,
    maxEntropy: authority.maxEntropy,
    normalizedEntropy: authority.normalizedEntropy,
    voiceFrequencies: authority.voiceFrequencies,
    consecutiveRepeatRate: authority.consecutiveRepeatRate,
    personalityDrift,
    planes,
    authorityPlane: "voice_selection_tick_log",
  };
}

function summarizeVoiceSequence(
  rows: Array<{ voice: string | null }>,
  expectedVoiceCount: number,
): VoiceDiversityPlaneReport {
  const voices = rows.map((row) => row.voice).filter((voice): voice is string => Boolean(voice));
  const voiceCounts: Record<string, number> = {};
  for (const voice of voices) {
    voiceCounts[voice] = (voiceCounts[voice] ?? 0) + 1;
  }

  const total = voices.length;
  const voiceFrequencies: Record<string, number> = {};
  for (const [voice, count] of Object.entries(voiceCounts)) {
    voiceFrequencies[voice] = total > 0 ? count / total : 0;
  }

  let shannonEntropy = 0;
  if (total > 0) {
    for (const freq of Object.values(voiceFrequencies)) {
      if (freq > 0) {
        shannonEntropy -= freq * Math.log2(freq);
      }
    }
  }

  let consecutiveRepeats = 0;
  for (let i = 1; i < voices.length; i++) {
    if (voices[i] === voices[i - 1]) {
      consecutiveRepeats++;
    }
  }

  const maxEntropy = Math.log2(expectedVoiceCount);
  const normalizedEntropy = maxEntropy > 0 ? shannonEntropy / maxEntropy : 0;
  return {
    sampleCount: total,
    shannonEntropy,
    maxEntropy,
    normalizedEntropy,
    voiceFrequencies,
    consecutiveRepeatRate: voices.length > 1 ? consecutiveRepeats / (voices.length - 1) : 0,
  };
}

function buildVoiceDiversityPlanes(
  db: ReturnType<typeof getDb>,
  authority: VoiceDiversityPlaneReport,
): Record<string, VoiceDiversityPlaneReport> {
  const actionLogAll = db
    .select({ voice: actionLog.voice })
    .from(actionLog)
    .orderBy(asc(actionLog.tick), asc(actionLog.id))
    .all();
  const actionLogSuccess = db
    .select({ voice: actionLog.voice })
    .from(actionLog)
    .where(eq(actionLog.success, true))
    .orderBy(asc(actionLog.tick), asc(actionLog.id))
    .all();
  const decisionEnqueue = db
    .select({ payloadJson: decisionTrace.payloadJson })
    .from(decisionTrace)
    .where(and(eq(decisionTrace.phase, "evolve"), eq(decisionTrace.finalDecision, "enqueue")))
    .orderBy(asc(decisionTrace.tick), asc(decisionTrace.id))
    .all()
    .map((row) => ({ voice: readSelectedAction(row.payloadJson) }));
  const candidateSelectedAll = db
    .select({ voice: candidateTrace.actionType })
    .from(candidateTrace)
    .where(eq(candidateTrace.selected, true))
    .orderBy(asc(candidateTrace.tick), asc(candidateTrace.id))
    .all();
  const candidateSelectedNormal = db
    .select({ voice: candidateTrace.actionType })
    .from(candidateTrace)
    .where(and(eq(candidateTrace.selected, true), eq(candidateTrace.gatePlane, "none")))
    .orderBy(asc(candidateTrace.tick), asc(candidateTrace.id))
    .all();
  const candidateSelectedDirected = db
    .select({ voice: candidateTrace.actionType })
    .from(candidateTrace)
    .where(
      and(eq(candidateTrace.selected, true), eq(candidateTrace.gatePlane, "directed_override")),
    )
    .orderBy(asc(candidateTrace.tick), asc(candidateTrace.id))
    .all();

  return {
    voice_selection_tick_log: authority,
    decision_enqueue: summarizeVoiceSequence(decisionEnqueue, IAUS_ACTION_VOICE_COUNT),
    iaus_selected_all: summarizeVoiceSequence(candidateSelectedAll, IAUS_ACTION_VOICE_COUNT),
    iaus_selected_normal: summarizeVoiceSequence(candidateSelectedNormal, IAUS_ACTION_VOICE_COUNT),
    iaus_selected_directed_override: summarizeVoiceSequence(
      candidateSelectedDirected,
      IAUS_ACTION_VOICE_COUNT,
    ),
    action_log_all: summarizeVoiceSequence(actionLogAll, IAUS_ACTION_VOICE_COUNT),
    action_log_success: summarizeVoiceSequence(actionLogSuccess, IAUS_ACTION_VOICE_COUNT),
  };
}

function readSelectedAction(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { selectedAction?: unknown };
    return typeof payload.selectedAction === "string" ? payload.selectedAction : null;
  } catch {
    return null;
  }
}

/**
 * Анализирует скорость дрейфа вектора личности vs период осцилляций давления.
 *
 * Прогноз V5: временной масштаб эволюции π >> временного масштаба осцилляций давления (память — медленная переменная).
 */
function analyzePersonalityDrift(db: ReturnType<typeof getDb>): PersonalityDriftReport | null {
  const snapshots = db
    .select({ tick: personalitySnapshots.tick, weights: personalitySnapshots.weights })
    .from(personalitySnapshots)
    .orderBy(asc(personalitySnapshots.tick))
    .all();

  if (snapshots.length < 2) return null;

  // Скорость изменения π: L2-расстояние между соседними снапшотами / разница тиков
  const drifts: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    let prev: number[];
    let curr: number[];
    try {
      // M20: одна битая строка weights не должна ронять весь diagnose.
      prev = z.array(z.number()).parse(JSON.parse(snapshots[i - 1].weights));
      curr = z.array(z.number()).parse(JSON.parse(snapshots[i].weights));
    } catch {
      continue;
    }
    const tickDiff = snapshots[i].tick - snapshots[i - 1].tick;
    if (tickDiff <= 0) continue;

    let l2 = 0;
    for (let d = 0; d < Math.min(prev.length, curr.length); d++) {
      l2 += (curr[d] - prev[d]) ** 2;
    }
    drifts.push(Math.sqrt(l2) / tickDiff);
  }

  if (drifts.length === 0) return null;

  const meanDriftPerTick = drifts.reduce((a, b) => a + b, 0) / drifts.length;

  // Период осцилляций давления ≈ медиана интервалов между действиями
  const actionTicks = db
    .select({ tick: actionLog.tick })
    .from(actionLog)
    .orderBy(asc(actionLog.tick))
    .all();

  const intervals: number[] = [];
  for (let i = 1; i < actionTicks.length; i++) {
    intervals.push(actionTicks[i].tick - actionTicks[i - 1].tick);
  }
  intervals.sort((a, b) => a - b);
  const pressureOscillationPeriod =
    intervals.length > 0 ? intervals[Math.floor(intervals.length / 2)] : 1;

  // Число тиков для достижения Δπ > 0.1 ≈ 0.1 / meanDriftPerTick
  const ticksToSignificantDrift = meanDriftPerTick > 0 ? 0.1 / meanDriftPerTick : Infinity;
  const driftToOscillationRatio =
    pressureOscillationPeriod > 0 ? ticksToSignificantDrift / pressureOscillationPeriod : Infinity;

  return {
    meanDriftPerTick,
    pressureOscillationPeriod,
    driftToOscillationRatio,
  };
}

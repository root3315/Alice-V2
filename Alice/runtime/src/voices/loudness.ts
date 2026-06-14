/**
 * Вычисление громкости голоса (ADR-26 v5).
 *
 * v5: L_v = π_v × mean(R_v(T(e)) for e in focal_set_v) + ε_v
 *
 * Заменяет глобальное tanh(Pi/κi) + маппинг функции активации из v4.
 */

import { readEmotionControlPatch } from "../emotion/graph.js";
import { DEFAULT_VOICE_COOLDOWN, voiceFatigue } from "../engine/deliberation.js";
import type { TensionVector } from "../graph/tension.js";
import type { WorldModel } from "../graph/world-model.js";
import { computeFocalSets, type FocalSet, readSelfMood } from "./focus.js";
import { type PersonalityVector, VOICES, type VoiceAction } from "./personality.js";

// -- Типы -------------------------------------------------------------------

export interface LoudnessResult {
  /** Громкость каждого голоса [L_D, L_C, L_S, L_X]. ADR-81: 4 голоса. */
  loudness: number[];
  /** Фокусное множество каждого голоса. */
  focalSets: Record<VoiceAction, FocalSet>;
}

// -- Uncertainty ------------------------------------------------------------

/**
 * ADR-112 D3: новизна окружения — недавно добавленные группы повышают Caution.
 *
 * novelty(ch) = exp(-interaction_count(ch) / κ_novelty)
 * κ_novelty = 10 (после 10 взаимодействий novelty затухает до ~37%)
 *
 * Неопределённость окружения = mean(novelty(ch) for ch in channels)
 */
const KAPPA_NOVELTY = 10;

function computeEnvUncertainty(G: WorldModel): number {
  const channels = G.getEntitiesByType("channel");
  if (channels.length === 0) return 0;

  let totalNovelty = 0;
  for (const chId of channels) {
    const attrs = G.getChannel(chId);
    // join_ms используется для определения новизны группы — при отсутствии используем счётчик взаимодействий
    const interactionCount = attrs.contact_recv_window ?? 0;
    const novelty = Math.exp(-interactionCount / KAPPA_NOVELTY);
    totalNovelty += novelty;
  }
  return totalNovelty / channels.length;
}

/**
 * Вычисляет Uncertainty (положительная активация голоса Caution).
 *
 * ADR-112 D3: uncertainty = max(info_uncertainty, env_uncertainty)
 *
 * info_uncertainty: растёт, когда недавних событий меньше ожидаемого.
 * env_uncertainty: неопределённость окружения для новых групп (теория безопасной базы Боулби).
 *
 * @param G - граф WorldModel (нужен для вычисления неопределённости окружения).
 */
export function computeUncertainty(
  recentEventCounts: number[] | null,
  k: number,
  expectedRate: number,
  G: WorldModel,
): number {
  // Информационная неопределённость
  let infoUncertainty: number;
  if (!recentEventCounts || recentEventCounts.length === 0) {
    infoUncertainty = 0.5; // при отсутствии истории — умеренная неопределённость
  } else {
    const recent = recentEventCounts.slice(-k);
    const actualRate = recent.reduce((a, b) => a + b, 0) / recent.length;
    const ratio = Math.min(actualRate / Math.max(expectedRate, 0.01), 2.0);
    infoUncertainty = Math.max(0.0, 1.0 - ratio);
  }

  // ADR-112 D3: неопределённость окружения
  const envUncertainty = computeEnvUncertainty(G);

  return Math.max(infoUncertainty, envUncertainty);
}

// -- Громкость голоса -------------------------------------------------------

/** Порядок ID голосов (выводится из реестра VOICES). */
const VOICE_ORDER = VOICES.map((v) => v.id);

/**
 * Вычисляет громкость каждого голоса.
 *
 * Формула v5: L_v = π_v × mean(R_v over focal set) + ε_v
 *
 * @see paper-five-dim/ Def 3.6 eq 13: L_v = π_v × mean(R_v(τ(e))) + ε_v
 */
export function computeLoudness(
  tensionMap: Map<string, TensionVector>,
  personality: PersonalityVector,
  G: WorldModel,
  tick: number,
  options: {
    recentEventCounts?: number[] | null;
    epsilonScale?: number;
    /** Детерминированный шум для тестов, длина = VOICES.length. */
    noiseOverride?: number[] | null;
    /**
     * ADR-110: настенное время последней победы голоса (voiceId → ms).
     * Включает фактор усталости голоса φ_v. Если не задано — φ_v = 1 для всех (нет усталости).
     * @see paper-five-dim/ Eq. voice-fatigue
     */
    voiceLastWon?: Record<VoiceAction, number> | null;
    /** ADR-110: окно охлаждения голоса K_v (секунды). По умолчанию DEFAULT_VOICE_COOLDOWN. */
    voiceCooldown?: number;
    /** ADR-110: текущее настенное время (ms). Если не задано — используется Date.now(). */
    nowMs?: number;
    /** Белый список допустимых целей. Если задан — в фокусное множество входят только они. */
    targetWhitelist?: ReadonlySet<string> | null;
  } = {},
): LoudnessResult {
  const {
    recentEventCounts = null,
    epsilonScale = 0.1,
    noiseOverride = null,
    voiceLastWon = null,
    voiceCooldown = DEFAULT_VOICE_COOLDOWN,
    nowMs = Date.now(),
    targetWhitelist = null,
  } = options;

  // Глобальная неопределённость (базовый уровень R_Caution) — ADR-112 D3: включает неопределённость окружения
  const uncertainty = computeUncertainty(recentEventCounts, 10, 2.0, G);

  // Вычисление фокусных множеств
  const focalSets = computeFocalSets(tensionMap, G, tick, {
    uncertainty,
    nowMs,
    targetWhitelist,
  });

  // ADR-181: L_v = π_v × mean(R_v) × φ_v × ψ_v(m) + ε_v
  // φ_v = voice fatigue factor (ADR-75, paper Eq. voice-fatigue)
  // ψ_v(m) = mood modulation (ADR-30 → ADR-181: перенесено из фокусных множеств сюда)
  const pi = personality.weights;
  const epsilon =
    noiseOverride ?? Array.from({ length: VOICES.length }, () => gaussianRandom() * epsilonScale);

  // ADR-181: модуляция настроением ±30% — mood>0 усиливает Sociability, ослабляет Caution; и наоборот
  const MOOD_DELTA = 0.3;
  const selfMood = readSelfMood(G, nowMs);
  const emotionControl = readEmotionControlPatch(G, nowMs);
  const PSI: Record<VoiceAction, number> = {
    diligence: 1.0,
    curiosity: 1.0,
    sociability: 1 + MOOD_DELTA * selfMood + emotionControl.voiceBias.sociability,
    caution: 1 - MOOD_DELTA * selfMood + emotionControl.voiceBias.caution,
  };

  const loudness = VOICE_ORDER.map((v, i) => {
    const phi = voiceLastWon ? voiceFatigue(nowMs, voiceLastWon[v], voiceCooldown) : 1;
    return pi[i] * focalSets[v].meanRelevance * phi * PSI[v] + epsilon[i];
  });

  return { loudness, focalSets };
}

/** Стандартное нормальное случайное число методом Бокса-Мюллера. */
function gaussianRandom(): number {
  // защита от Math.random() == 0, что даёт Math.log(0) = -Infinity
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

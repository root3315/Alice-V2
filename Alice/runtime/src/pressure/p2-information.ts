/**
 * P2 информационное давление (Information Pressure) — управляется InfoItem.
 * Соответствует Python pressure.py P2_information_pressure().
 *
 * P2(n) = Σ_i [importance(i)·(1-R(i,n)) + volatility(i)·age(i,n)]
 * где R(i,n) = (1 + (n - n_last(i)) / (9·S(i)))^d
 *
 * Единый спектр устойчивости: все факты проходят через кривую забывания SM-2,
 * начальное S₀ различается по fact_type (preference=40 → полупериод 3 года, observation=1 → 27 дней).
 * Ветка «semantic vs episodic» упразднена.
 *
 * @see docs/adr/151-algorithm-audit/research-online-calibration.md
 */
import type { WorldModel } from "../graph/world-model.js";
import { elapsedS, readNodeMs } from "./clock.js";
import type { PressureResult } from "./p1-attention.js";

/** Секунд в сутках. Заменяет устаревший FACT_TIME_SCALE (1440 тиков × 60s = 86400s). */
const SECONDS_PER_DAY = 86_400;

/**
 * ADR-166 §4.3: константа преобразования единиц volatility.
 * Параметр volatility откалиброван для интервала «60 s» (старая система per-tick).
 * ageS / 60 = «эквивалентное число тиков в старой системе», числовая семантика параметра сохраняется.
 * Фактически единица volatility — «per-minute».
 */
const VOLATILITY_UNIT_S = 60;
/** Неотслеживаемые факты лишь сигнализируют о необходимости повторной верификации — они не должны постоянно завышать глобальный P2 по мере роста числа фактов. */
const UNTRACKED_MEMORY_TOTAL_CAP = 3.0;

export function p2InformationPressure(
  G: WorldModel,
  _n: number,
  nowMs: number,
  d: number = -0.5,
): PressureResult {
  const contributions: Record<string, number> = {};

  const untrackedIds: string[] = [];

  for (const iid of G.getEntitiesByType("fact")) {
    const attrs = G.getFact(iid);

    // Компонент устаревания информации (только для tracked-элементов)
    // ADR-166: используем readNodeMs (точное значение), при отсутствии — пропускаем staleness (Unknown ≠ Old)
    let stalenessTerm = 0.0;
    if (attrs.tracked) {
      const createdMs = readNodeMs(G, iid, "created_ms");
      if (createdMs > 0) {
        const volatility = attrs.volatility;
        const ageS = elapsedS(nowMs, createdMs);
        stalenessTerm = volatility * (ageS / VOLATILITY_UNIT_S);
      }
    }

    // Единая кривая забывания SM-2 — все fact_type проходят один путь.
    // Различие только в attrs.stability (задаётся remember() через factTypeInitialStability(factType),
    // при повторном упоминании умножается на STABILITY_REINFORCE_FACTOR).
    // preference (S=40) → полупериод 3 года, observation (S=1) → полупериод 27 дней.
    const importance = attrs.importance;
    const stability = Math.max(attrs.stability, 0.1);

    // ADR-166: используем readNodeMs (точное значение), при отсутствии gapDays=0 → R=1 → memoryTerm=0
    const lastAccessMs = readNodeMs(G, iid, "last_access_ms");
    const gapDays = lastAccessMs > 0 ? elapsedS(nowMs, lastAccessMs) / SECONDS_PER_DAY : 0;
    // R(gap) = (1 + gap_days / (9·S))^d
    const R = (1 + gapDays / (9 * stability)) ** d;

    const memoryTerm = importance * (1.0 - R);
    if (attrs.tracked) {
      contributions[iid] = memoryTerm + stalenessTerm;
    } else {
      contributions[iid] = memoryTerm;
      if (memoryTerm > 0) untrackedIds.push(iid);
    }
  }

  const untrackedTotal = untrackedIds.reduce((sum, id) => sum + (contributions[id] ?? 0), 0);
  if (untrackedTotal > UNTRACKED_MEMORY_TOTAL_CAP) {
    const scale = UNTRACKED_MEMORY_TOTAL_CAP / untrackedTotal;
    for (const id of untrackedIds) {
      contributions[id] *= scale;
    }
  }

  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  return { total, contributions };
}

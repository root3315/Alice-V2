/**
 * Spreading Activation извлечение памяти — начиная с фокусных сущностей,
 * распространяет значения активации по топологии графа, обнаруживая
 * узлы-факты, топологически связанные с текущим контекстом.
 *
 * Использует CSR разреженную матрицу (O(|V|+|E|) на шаг),
 * обеспечивая дополнительный сигнал топологической релевантности
 * для кривой забывания retrievability.
 *
 * @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
 * @see paper-five-dim/ §6.2 "Associative Memory Retrieval"
 */
import { buildWeightedAdjacency, sparseMV } from "../pressure/propagation.js";
import type { WorldModel } from "./world-model.js";

/** Запись результата активационного извлечения. */
export interface ActivationHit {
  entityId: string;
  activation: number;
}

/**
 * Распространяет активацию от семенных сущностей по топологии графа,
 * возвращая активированные узлы-факты.
 *
 * Алгоритм:
 *   a(0) = seed vector (1.0 at seed positions)
 *   a(h+1) = a(h) + decay^h · A_ω^T · a(h)
 *
 * Затухание на каждом шаге предотвращает бесконечное распространение;
 * addressedDecay автоматически ослабляет недавно взаимодействовавшие
 * узлы (семантика аналогична pressure propagation).
 *
 * @param G граф-компаньон
 * @param seedEntities семенные сущности (обычно = фокус-множество или целевые контакты + каналы)
 * @param nowMs текущее время настенных часов (мс, для addressedDecay)
 * @param hops количество шагов распространения (по умолчанию 2)
 * @param decayPerHop коэффициент затухания на шаг (по умолчанию 0.5)
 * @returns узлы-факты в порядке убывания активации (без самих семян)
 */
export function activationRetrieval(
  G: WorldModel,
  seedEntities: string[],
  nowMs: number,
  hops = 2,
  decayPerHop = 0.5,
): ActivationHit[] {
  if (seedEntities.length === 0) return [];

  const { matrix, entityIndex } = buildWeightedAdjacency(G, nowMs);
  const n = matrix.n;
  if (n === 0) return [];

  // Начальный вектор активации: позиции семян = 1.0
  const activation = new Array<number>(n).fill(0);
  for (const eid of seedEntities) {
    const idx = entityIndex.get(eid);
    if (idx !== undefined) activation[idx] = 1.0;
  }

  // Многошаговое распространение
  let currentDecay = decayPerHop;
  for (let h = 0; h < hops; h++) {
    const spread = sparseMV(matrix, activation);
    for (let i = 0; i < n; i++) {
      activation[i] += currentDecay * spread[i];
    }
    currentDecay *= decayPerHop;
  }

  // Сбор узлов-фактов, не являющихся семенами
  const seedSet = new Set(seedEntities);
  const results: ActivationHit[] = [];
  for (const [eid, idx] of entityIndex) {
    if (seedSet.has(eid)) continue;
    if (activation[idx] > 0.01 && G.getNodeType(eid) === "fact") {
      results.push({ entityId: eid, activation: activation[idx] });
    }
  }

  results.sort((a, b) => b.activation - a.activation);
  return results;
}

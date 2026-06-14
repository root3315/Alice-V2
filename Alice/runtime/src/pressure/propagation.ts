/**
 * Матричное распространение Лапласиана (Paper §3.4 eq 8).
 *
 * p_eff = p + μ · A_ω^T · p
 *
 * A_ω[u][v] = ω(category(u,v)) · addressedDecay(u,v,tick)
 *
 * SpMV выполняется в формате CSR (Compressed Sparse Row).
 * Сложность O(|V| + |E|), семантика полностью соответствует матричному определению из статьи.
 *
 * @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
 */

import { PROPAGATION_WEIGHT } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import { decayFactor } from "../utils/math.js";
import { elapsedS, readNodeMs } from "./clock.js";

// -- Per-node susceptibility (модель FJ) ----------------------------------------

/**
 * Конфигурация распространения.
 * @see docs/adr/151-algorithm-audit/ #5 Per-node susceptibility
 */
export interface PropagationConfig {
  /** Отображение entity_type → λ_v. Специальный ключ "group_channel" для group/supergroup каналов */
  susceptibility?: Record<string, number>;
  /** Число итераций APPNP. Если не задано, используется legacy one-hop распространение. */
  K?: number;
  /** Вероятность teleport для APPNP ∈ [0,1]. По умолчанию 0.15. При alpha=1 полный teleport (без распространения). */
  alpha?: number;
}

/**
 * Таблица susceptibility по умолчанию.
 * - agent (self): 0 — давление Алисы определяется внутренним состоянием, соседи не "заражают"
 * - contact: 1.0 — полное принятие распространения (соответствует старому поведению)
 * - channel: 0.6 — умеренное принятие для приватного канала
 * - group_channel: 0.3 — давление в групповом чате в основном определяется внутренними сообщениями
 * - broadcast_channel: 0.1 — ADR-206: низкая восприимчивость для вещательного канала (информационный поток — не социальное обязательство)
 */
export const DEFAULT_SUSCEPTIBILITY: Record<string, number> = {
  agent: 0,
  contact: 1.0,
  channel: 0.6,
  group_channel: 0.3,
  broadcast_channel: 0.1,
};

/**
 * Определить susceptibility λ_v узла.
 * Поиск по таблице entity_type; для channel-узлов дополнительно различается group/supergroup.
 */
function resolveSusceptibility(G: WorldModel, eid: string, map: Record<string, number>): number {
  const nodeType = G.getNodeType(eid);
  if (!nodeType) return 1.0;

  if (nodeType === "channel") {
    const chatType = G.getChannel(eid).chat_type;
    if (ChatTarget.isGroupChat(chatType)) {
      return map.group_channel ?? map.channel ?? 1.0;
    }
    // ADR-206: для типа Telegram channel используется susceptibility broadcast_channel
    if (ChatTarget.isChannelChat(chatType)) {
      return map.broadcast_channel ?? map.channel ?? 1.0;
    }
    return map.channel ?? 1.0;
  }

  return map[nodeType] ?? 1.0;
}

// -- Разреженная матрица CSR -----------------------------------------------------------

export interface SparseMatrix {
  /** Размерность матрицы (n×n) */
  n: number;
  /** CSR row pointers (length n+1) */
  rowPtr: number[];
  /** CSR column indices */
  colIdx: number[];
  /** CSR values */
  values: number[];
}

/**
 * Построение **транспонированной** взвешенной матрицы смежности A_ω^T (формат CSR).
 *
 * Исходное ребро u→v в A_ω равно A[u][v]; после транспонирования A^T[v][u].
 * Так как формула распространения A_ω^T · p: для каждого v, p_eff[v] += Σ_u A_ω[u][v] · p[u]
 * т.е. A^T[v][u] = ω(cat(u,v)) × addressedDecay(u,v,nowMs).
 *
 * Прямое построение A^T избавляет от последующего транспонирования.
 */
export function buildWeightedAdjacency(
  G: WorldModel,
  nowMs: number = 0,
): { matrix: SparseMatrix; entityIndex: Map<string, number> } {
  // Построить отображение узел → индекс
  const allIds = G.allNodeIds();
  const n = allIds.length;
  const entityIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    entityIndex.set(allIds[i], i);
  }

  // Собираем ненулевые элементы A^T: triplet (row, col, value)
  // A^T[v][u] = ω(cat) × addressedDecay, исходное ребро u→v
  const triplets: Array<{ row: number; col: number; value: number }> = [];

  for (const [u, v, data] of G.allEdges()) {
    const idxU = entityIndex.get(u);
    const idxV = entityIndex.get(v);
    if (idxU === undefined || idxV === undefined) continue;

    const cat = data.category;
    const omega = PROPAGATION_WEIGHT[cat] ?? 0.5;

    // addressed decay — затухание по секундам стенного времени (halfLife 10 тиков × 60 = 600s)
    let addressedFactor = 1.0;
    if (nowMs > 0) {
      for (const node of [u, v]) {
        if (!G.has(node)) continue;
        const lastActionMs = readNodeMs(G, node, "last_alice_action_ms");
        if (lastActionMs > 0) {
          const gapS = elapsedS(nowMs, lastActionMs);
          const alpha = decayFactor(gapS, 600);
          addressedFactor = Math.min(addressedFactor, 1.0 - alpha);
        }
      }
    }

    const weight = omega * addressedFactor;
    if (Math.abs(weight) < 1e-15) continue;

    // A^T[v][u] = weight (исходное ребро u→v в транспонированной матрице становится строкой v, столбцом u)
    triplets.push({ row: idxV, col: idxU, value: weight });
  }

  // Сортировка по (row, col), объединение элементов на одной позиции
  triplets.sort((a, b) => a.row - b.row || a.col - b.col);

  // Построение CSR
  const rowPtr = new Array<number>(n + 1).fill(0);
  const colIdx: number[] = [];
  const values: number[] = [];

  let prev = -1;
  let prevCol = -1;

  for (const t of triplets) {
    // Объединение на одной позиции
    if (t.row === prev && t.col === prevCol) {
      values[values.length - 1] += t.value;
    } else {
      colIdx.push(t.col);
      values.push(t.value);
      rowPtr[t.row + 1]++;
      prev = t.row;
      prevCol = t.col;
    }
  }

  // Префиксная сумма rowPtr
  for (let i = 1; i <= n; i++) {
    rowPtr[i] += rowPtr[i - 1];
  }

  return { matrix: { n, rowPtr, colIdx, values }, entityIndex };
}

/**
 * Нормализация строк: делим каждую строку на её сумму, чтобы сумма элементов каждой строки равнялась 1.
 * Применяется перед итерациями APPNP для преобразования взвешенной матрицы смежности в матрицу переходных вероятностей.
 * Пустые строки (изолированные узлы) остаются нулевыми.
 */
export function normalizeRows(A: SparseMatrix): SparseMatrix {
  const values = new Array<number>(A.values.length);
  for (let i = 0; i < A.n; i++) {
    let rowSum = 0;
    for (let j = A.rowPtr[i]; j < A.rowPtr[i + 1]; j++) {
      rowSum += A.values[j];
    }
    if (rowSum > 1e-15) {
      for (let j = A.rowPtr[i]; j < A.rowPtr[i + 1]; j++) {
        values[j] = A.values[j] / rowSum;
      }
    } else {
      for (let j = A.rowPtr[i]; j < A.rowPtr[i + 1]; j++) {
        values[j] = 0;
      }
    }
  }
  return { n: A.n, rowPtr: A.rowPtr, colIdx: A.colIdx, values };
}

/**
 * Умножение разреженной матрицы CSR на вектор: y = A · x.
 * Сложность O(nnz).
 */
export function sparseMV(A: SparseMatrix, x: number[]): number[] {
  const y = new Array<number>(A.n).fill(0);
  for (let i = 0; i < A.n; i++) {
    let sum = 0;
    for (let j = A.rowPtr[i]; j < A.rowPtr[i + 1]; j++) {
      sum += A.values[j] * x[A.colIdx[j]];
    }
    y[i] = sum;
  }
  return y;
}

/**
 * Матричное распространение Лапласиана (главная функция).
 *
 * p_eff(v) = p_local(v) + λ_v · μ · [A_ω^T · p](v)
 *
 * λ_v: per-node susceptibility (вдохновлено моделью FJ), поиск по таблице entity_type.
 * @see docs/adr/151-algorithm-audit/ #5 Per-node susceptibility
 * @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
 */
export function propagatePressuresMatrix(
  G: WorldModel,
  localPressures: Record<string, number>,
  mu: number = 0.3,
  nowMs: number = 0,
  config?: PropagationConfig,
): Record<string, number> {
  const sus = { ...DEFAULT_SUSCEPTIBILITY, ...(config?.susceptibility ?? {}) };
  const K = config?.K;

  const { matrix, entityIndex } = buildWeightedAdjacency(G, nowMs);
  const n = matrix.n;

  // Построение вектора локального давления p (упорядочен по entityIndex)
  const p = new Array<number>(n).fill(0);
  for (const [eid, val] of Object.entries(localPressures)) {
    const idx = entityIndex.get(eid);
    if (idx !== undefined) p[idx] = val;
  }

  // p_eff(v) = p_local(v) + λ_v · μ · propagated(v)
  // Примечание: ключи localPressures могут отсутствовать в графе — сохраняем их как есть
  const pEff: Record<string, number> = { ...localPressures };

  // Убедиться, что все целевые узлы рёбер имеют запись (соответствует legacy-поведению: при обходе рёбер pEff[v] ??= 0)
  for (const [, v] of G.allEdges()) {
    if (!(v in pEff)) pEff[v] = 0;
  }

  if (K !== undefined && K >= 1) {
    // ── Распространение APPNP K-шагов с teleport ──
    // p^(0) = p_local
    // p^(k) = (1-alpha) * A_norm * p^(k-1) + alpha * p_local
    // p_eff[v] = p_local[v] + λ_v * μ * (p^(K)[v] - p_local[v])
    const alpha = config?.alpha ?? 0.15;
    const Anorm = normalizeRows(matrix);
    const pCurrent = [...p];

    for (let k = 0; k < K; k++) {
      const Ap = sparseMV(Anorm, pCurrent);
      for (let i = 0; i < n; i++) {
        pCurrent[i] = (1 - alpha) * Ap[i] + alpha * p[i];
      }
    }

    for (const [eid, idx] of entityIndex) {
      // Изолированные узлы (без входящих рёбер) пропускаем: пустая строка заставляет APPNP тянуть давление к alpha*p_local, что нежелательно
      if (Anorm.rowPtr[idx + 1] === Anorm.rowPtr[idx]) continue;
      const delta = pCurrent[idx] - p[idx];
      if (Math.abs(delta) > 1e-15) {
        const lambda = resolveSusceptibility(G, eid, sus);
        pEff[eid] = (pEff[eid] ?? 0) + lambda * mu * delta;
      }
    }
  } else {
    // ── Legacy one-hop: p_eff(v) = p_local(v) + λ_v · μ · [A_ω^T · p](v) ──
    const Ap = sparseMV(matrix, p);
    for (const [eid, idx] of entityIndex) {
      if (Math.abs(Ap[idx]) > 1e-15) {
        const lambda = resolveSusceptibility(G, eid, sus);
        pEff[eid] = (pEff[eid] ?? 0) + lambda * mu * Ap[idx];
      }
    }
  }

  return pEff;
}

// По умолчанию экспортируем матричную версию
export { propagatePressuresMatrix as propagatePressures };

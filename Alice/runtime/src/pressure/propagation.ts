/**
 * 矩阵 Laplacian 传播 (Paper §3.4 eq 8)。
 *
 * p_eff = p + μ · A_ω^T · p
 *
 * A_ω[u][v] = ω(category(u,v)) · addressedDecay(u,v,tick)
 *
 * 使用 CSR (Compressed Sparse Row) 格式执行 SpMV。
 * 复杂度 O(|V| + |E|)，语义完全忠实于论文矩阵定义。
 *
 * @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
 */

import { PROPAGATION_WEIGHT } from "../graph/constants.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import { decayFactor } from "../utils/math.js";
import { elapsedS, readNodeMs } from "./clock.js";

// -- Per-node susceptibility (FJ 模型) ----------------------------------------

/**
 * 传播配置。
 * @see docs/adr/151-algorithm-audit/ #5 Per-node susceptibility
 */
export interface PropagationConfig {
  /** entity_type → λ_v 映射。特殊键 "group_channel" 用于 group/supergroup 频道 */
  susceptibility?: Record<string, number>;
  /** APPNP 迭代次数。未设置时使用 legacy one-hop 传播。 */
  K?: number;
  /** APPNP teleport 概率 ∈ [0,1]。默认 0.15。alpha=1 时完全 teleport（无传播）。 */
  alpha?: number;
}

/**
 * 默认 susceptibility 表。
 * - agent (self): 0 — Alice 自身压力由内部状态驱动，不被邻居"感染"
 * - contact: 1.0 — 完全接收传播（与旧行为一致）
 * - channel: 0.6 — private channel 适度接收
 * - group_channel: 0.3 — 群聊压力主要由内部消息驱动
 * - broadcast_channel: 0.1 — ADR-206: 广播频道低易感性（信息流不是社交义务）
 */
export const DEFAULT_SUSCEPTIBILITY: Record<string, number> = {
  agent: 0,
  contact: 1.0,
  channel: 0.6,
  group_channel: 0.3,
  broadcast_channel: 0.1,
};

/**
 * 解析节点的 susceptibility λ_v。
 * 按 entity_type 查表，channel 节点额外区分 group/supergroup。
 */
function resolveSusceptibility(G: WorldModel, eid: string, map: Record<string, number>): number {
  const nodeType = G.getNodeType(eid);
  if (!nodeType) return 1.0;

  if (nodeType === "channel") {
    const chatType = G.getChannel(eid).chat_type;
    if (ChatTarget.isGroupChat(chatType)) {
      return map.group_channel ?? map.channel ?? 1.0;
    }
    // ADR-206: Telegram channel 类型用 broadcast_channel 易感性
    if (ChatTarget.isChannelChat(chatType)) {
      return map.broadcast_channel ?? map.channel ?? 1.0;
    }
    return map.channel ?? 1.0;
  }

  return map[nodeType] ?? 1.0;
}

// -- CSR 稀疏矩阵 -----------------------------------------------------------

export interface SparseMatrix {
  /** 矩阵维度 (n×n) */
  n: number;
  /** CSR row pointers (length n+1) */
  rowPtr: number[];
  /** CSR column indices */
  colIdx: number[];
  /** CSR values */
  values: number[];
}

/**
 * 构建加权邻接矩阵的 **转置** A_ω^T（CSR 格式）。
 *
 * 原始边 u→v 在 A_ω 中为 A[u][v]，转置后 A^T[v][u]。
 * 因为传播公式是 A_ω^T · p：对每个 v，p_eff[v] += Σ_u A_ω[u][v] · p[u]
 * 即 A^T[v][u] = ω(cat(u,v)) × addressedDecay(u,v,nowMs)。
 *
 * 直接构建 A^T 避免事后转置。
 */
export function buildWeightedAdjacency(
  G: WorldModel,
  nowMs: number = 0,
): { matrix: SparseMatrix; entityIndex: Map<string, number> } {
  // 建立节点 → 索引映射
  const allIds = G.allNodeIds();
  const n = allIds.length;
  const entityIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    entityIndex.set(allIds[i], i);
  }

  // 收集 A^T 的非零元素：triplet (row, col, value)
  // A^T[v][u] = ω(cat) × addressedDecay，原始边 u→v
  const triplets: Array<{ row: number; col: number; value: number }> = [];

  for (const [u, v, data] of G.allEdges()) {
    const idxU = entityIndex.get(u);
    const idxV = entityIndex.get(v);
    if (idxU === undefined || idxV === undefined) continue;

    const cat = data.category;
    const omega = PROPAGATION_WEIGHT[cat] ?? 0.5;

    // addressed decay — 墙钟秒衰减（halfLife 10 ticks × 60 = 600s）
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

    // A^T[v][u] = weight（原始边 u→v 在转置中变为行 v 列 u）
    triplets.push({ row: idxV, col: idxU, value: weight });
  }

  // 按 (row, col) 排序，合并同位置元素
  triplets.sort((a, b) => a.row - b.row || a.col - b.col);

  // 构建 CSR
  const rowPtr = new Array<number>(n + 1).fill(0);
  const colIdx: number[] = [];
  const values: number[] = [];

  let prev = -1;
  let prevCol = -1;

  for (const t of triplets) {
    // 合并同位置
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

  // rowPtr 前缀和
  for (let i = 1; i <= n; i++) {
    rowPtr[i] += rowPtr[i - 1];
  }

  return { matrix: { n, rowPtr, colIdx, values }, entityIndex };
}

/**
 * 行归一化：每行除以行和，使每行元素之和为 1。
 * 用于 APPNP 迭代前将加权邻接矩阵转为转移概率矩阵。
 * 空行（孤立节点）保持零。
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
 * CSR 稀疏矩阵向量乘法: y = A · x。
 * 复杂度 O(nnz)。
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
 * 矩阵 Laplacian 传播（主函数）。
 *
 * p_eff(v) = p_local(v) + λ_v · μ · [A_ω^T · p](v)
 *
 * λ_v: per-node susceptibility（FJ 模型启发），按 entity_type 查表。
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

  // 构建本地压力向量 p（按 entityIndex 排列）
  const p = new Array<number>(n).fill(0);
  for (const [eid, val] of Object.entries(localPressures)) {
    const idx = entityIndex.get(eid);
    if (idx !== undefined) p[idx] = val;
  }

  // p_eff(v) = p_local(v) + λ_v · μ · propagated(v)
  // 注意：localPressures 的键可能不在图中，原样保留
  const pEff: Record<string, number> = { ...localPressures };

  // 确保所有边目标节点都有 entry（与 legacy 行为一致：遍历边时 pEff[v] ??= 0）
  for (const [, v] of G.allEdges()) {
    if (!(v in pEff)) pEff[v] = 0;
  }

  if (K !== undefined && K >= 1) {
    // ── APPNP K-step teleport 传播 ──
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
      // 孤立节点（无入边）跳过：空行导致 APPNP 把压力拉向 alpha*p_local，不是预期行为
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

// 默认导出矩阵版本
export { propagatePressuresMatrix as propagatePressures };

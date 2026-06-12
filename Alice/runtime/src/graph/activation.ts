/**
 * Spreading Activation 记忆检索——从焦点实体出发，沿图拓扑
 * 扩散激活值，发现与当前语境拓扑相关的 fact 节点。
 *
 * 复用 CSR 稀疏矩阵基础设施（O(|V|+|E|) per hop），
 * 为 retrievability 遗忘曲线提供互补的拓扑相关性信号。
 *
 * @see paper/ §3.4 "Pressure Propagation via Weighted Laplacian"
 * @see paper-five-dim/ §6.2 "Associative Memory Retrieval"
 */
import { buildWeightedAdjacency, sparseMV } from "../pressure/propagation.js";
import type { WorldModel } from "./world-model.js";

/** 激活检索结果条目。 */
export interface ActivationHit {
  entityId: string;
  activation: number;
}

/**
 * 从种子实体沿图拓扑扩散激活，返回被激活的 fact 节点。
 *
 * 算法：
 *   a(0) = seed vector (1.0 at seed positions)
 *   a(h+1) = a(h) + decay^h · A_ω^T · a(h)
 *
 * 每跳衰减防止激活无限传播，addressedDecay 自动衰减
 * 近期交互过的节点（同 pressure propagation 语义）。
 *
 * @param G 伴侣图
 * @param seedEntities 种子实体（通常 = 焦点集或目标联系人 + 频道）
 * @param nowMs 当前墙钟时间（ms，用于 addressedDecay）
 * @param hops 传播跳数（默认 2）
 * @param decayPerHop 每跳衰减因子（默认 0.5）
 * @returns 按激活值降序排列的 fact 节点（不含种子自身）
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

  // 初始激活向量：种子位置 = 1.0
  const activation = new Array<number>(n).fill(0);
  for (const eid of seedEntities) {
    const idx = entityIndex.get(eid);
    if (idx !== undefined) activation[idx] = 1.0;
  }

  // 多跳传播
  let currentDecay = decayPerHop;
  for (let h = 0; h < hops; h++) {
    const spread = sparseMV(matrix, activation);
    for (let i = 0; i < n; i++) {
      activation[i] += currentDecay * spread[i];
    }
    currentDecay *= decayPerHop;
  }

  // 收集非种子的 fact 节点
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

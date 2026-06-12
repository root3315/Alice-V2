/**
 * 实体张力向量 (ADR-26 §1) + 贡献路由。
 *
 * 将 AllPressures.contributions (pk → eid → value) 转置为
 * eid → TensionVector，保留逐实体的六力分量 + P_prospect。
 *
 * ADR-101: 贡献路由——压力计算是实体维度的（P3→contact, P4→thread,
 * P2→fact），但行动只能针对频道（channel:*）。routeContributions()
 * 是投影算子 ρ: V → V_A，将完整实体空间投影到可行动子空间。
 *
 * @see paper/ §3.3: τ(e) = transpose of contributions matrix
 */

import { ensureChannelId } from "./constants.js";
import type { WorldModel } from "./world-model.js";

// -- 类型 -------------------------------------------------------------------

/** 实体张力向量——每个图实体携带的多维压力分解。 */
export interface TensionVector {
  readonly tau1: number; // P1 注意力债务
  readonly tau2: number; // P2 信息压力
  readonly tau3: number; // P3 关系冷却
  readonly tau4: number; // P4 线程分歧
  readonly tau5: number; // P5 回应义务
  readonly tau6: number; // P6 好奇心
  readonly tauP: number; // P_prospect 前瞻
  readonly tauRisk: number; // 风险信号（flag_risk 产物）
  readonly tauAttraction: number; // ADR-178: 吸引力信号
  readonly tauSpike: number; // ADR-191: 速率尖峰信号（z-score > 1）
}

/** 零张力向量。 */
export const ZERO_TENSION: TensionVector = Object.freeze({
  tau1: 0,
  tau2: 0,
  tau3: 0,
  tau4: 0,
  tau5: 0,
  tau6: 0,
  tauP: 0,
  tauRisk: 0,
  tauAttraction: 0,
  tauSpike: 0,
});

/**
 * AllPressures.contributions 的键名到 TensionVector 字段的映射。
 * P_prospect (tauP) 不在此映射中——它通过 prospectContributions 参数单独处理，
 * 见 buildTensionMap() 的第二个参数。
 */
const PK_TO_TAU: Record<string, keyof TensionVector> = {
  P1: "tau1",
  P2: "tau2",
  P3: "tau3",
  P4: "tau4",
  P5: "tau5",
  P6: "tau6",
};

// -- 核心函数 ---------------------------------------------------------------

/**
 * 将 AllPressures.contributions 转置为逐实体张力向量 Map。
 *
 * @param contributions - AllPressures.contributions: `{ P1: {eid: val}, ..., P6: {eid: val} }`
 * @param prospectContributions - pProspect().contributions: `{eid: val}`（可选）
 * @param riskContributions - 逐实体风险信号（flag_risk 产物），注入 tauRisk（可选）
 * @param attractionContributions - ADR-178: 逐实体吸引力信号（rv_attraction），注入 tauAttraction（可选）
 * @param spikeContributions - ADR-191: 逐实体速率尖峰信号（z-score > 1），注入 tauSpike（可选）
 * @returns Map<entityId, TensionVector>
 *
 * @see paper/ §3.3: τ(e) = transpose of contributions matrix
 */
export function buildTensionMap(
  contributions: Record<string, Record<string, number>>,
  prospectContributions?: Record<string, number>,
  riskContributions?: Record<string, number>,
  attractionContributions?: Record<string, number>,
  spikeContributions?: Record<string, number>,
): Map<string, TensionVector> {
  // 收集所有出现过的 entity id
  const entityIds = new Set<string>();
  for (const pk of Object.keys(PK_TO_TAU)) {
    const ck = contributions[pk];
    if (ck) {
      for (const eid of Object.keys(ck)) entityIds.add(eid);
    }
  }
  if (prospectContributions) {
    for (const eid of Object.keys(prospectContributions)) entityIds.add(eid);
  }
  if (riskContributions) {
    for (const eid of Object.keys(riskContributions)) entityIds.add(eid);
  }
  if (attractionContributions) {
    for (const eid of Object.keys(attractionContributions)) entityIds.add(eid);
  }
  if (spikeContributions) {
    for (const eid of Object.keys(spikeContributions)) entityIds.add(eid);
  }

  const result = new Map<string, TensionVector>();

  for (const eid of entityIds) {
    result.set(eid, {
      tau1: contributions.P1?.[eid] ?? 0,
      tau2: contributions.P2?.[eid] ?? 0,
      tau3: contributions.P3?.[eid] ?? 0,
      tau4: contributions.P4?.[eid] ?? 0,
      tau5: contributions.P5?.[eid] ?? 0,
      tau6: contributions.P6?.[eid] ?? 0,
      tauP: prospectContributions?.[eid] ?? 0,
      tauRisk: riskContributions?.[eid] ?? 0,
      tauAttraction: attractionContributions?.[eid] ?? 0,
      tauSpike: spikeContributions?.[eid] ?? 0,
    });
  }

  return result;
}

/**
 * 从张力 Map 反向聚合为全局标量（round-trip 验证用）。
 *
 * 验证等式: aggregateFromTensionMap(buildTensionMap(c, pc)).Pk ≈ Σ c[Pk][eid]
 */
export function aggregateFromTensionMap(tensionMap: Map<string, TensionVector>): {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  P_prospect: number;
  P_risk: number;
  P_attraction: number;
  P_spike: number;
} {
  let P1 = 0;
  let P2 = 0;
  let P3 = 0;
  let P4 = 0;
  let P5 = 0;
  let P6 = 0;
  let P_prospect = 0;
  let P_risk = 0;
  let P_attraction = 0;
  let P_spike = 0;

  for (const t of tensionMap.values()) {
    P1 += t.tau1;
    P2 += t.tau2;
    P3 += t.tau3;
    P4 += t.tau4;
    P5 += t.tau5;
    P6 += t.tau6;
    P_prospect += t.tauP;
    P_risk += t.tauRisk;
    P_attraction += t.tauAttraction;
    P_spike += t.tauSpike;
  }

  return { P1, P2, P3, P4, P5, P6, P_prospect, P_risk, P_attraction, P_spike };
}

/** L2 范数——张力向量的标量大小（不含 tauRisk，风险信号走独立路径）。 */
export function tensionNorm(t: TensionVector): number {
  return Math.sqrt(
    t.tau1 * t.tau1 +
      t.tau2 * t.tau2 +
      t.tau3 * t.tau3 +
      t.tau4 * t.tau4 +
      t.tau5 * t.tau5 +
      t.tau6 * t.tau6 +
      t.tauP * t.tauP,
  );
}

// -- 贡献路由 ---------------------------------------------------------------

/**
 * 将实体 ID 解析为可行动目标（频道 ID 列表）。
 *
 * 使用图节点的 entity_type 判断（非 ID 前缀匹配），
 * 保证测试和生产使用不同 ID 约定时行为一致。
 *
 * 路由规则：
 *   channel    → 保持不变（已可行动）
 *   contact    → ensureChannelId → channel:X（私聊频道）
 *   thread     → involves 边指向的实体 → 递归解析
 *   fact  → source_channel 或 source_contact → 频道
 *   其他       → 丢弃（agent, conversation 等不可行动）
 *
 * @returns 可行动频道 ID 数组；空数组 = 不可行动，贡献被丢弃
 */
function resolveActionableTargets(entityId: string, G: WorldModel): string[] {
  if (!G.has(entityId)) return [];

  const nodeType = G.getNodeType(entityId);

  // 频道 → 直接可行动
  if (nodeType === "channel") return [entityId];

  // 联系人 → 私聊频道
  if (nodeType === "contact") {
    const channelId = ensureChannelId(entityId);
    return channelId && G.has(channelId) ? [channelId] : [];
  }

  // 线程 → 优先 source_channel（精确路由），回退 involves 边
  // @see docs/adr/102-reflective-action-trace.md (ADR-104)
  if (nodeType === "thread") {
    const threadAttrs = G.getThread(entityId);
    // ADR-104: 优先 source_channel（精确路由）
    if (threadAttrs.source_channel && G.has(threadAttrs.source_channel)) {
      return [threadAttrs.source_channel];
    }
    // 回退 involves 边
    const involvedNodes = G.getNeighbors(entityId, "involves");
    const channels: string[] = [];
    for (const nodeId of involvedNodes) {
      channels.push(...resolveActionableTargets(nodeId, G));
    }
    return [...new Set(channels)];
  }

  // 信息项 → source_channel 或 source_contact → 频道
  if (nodeType === "fact") {
    const attrs = G.getFact(entityId);
    if (attrs.source_channel && G.has(attrs.source_channel)) {
      return [attrs.source_channel];
    }
    if (attrs.source_contact) {
      return resolveActionableTargets(attrs.source_contact, G);
    }
    return [];
  }

  // 其他（agent, conversation）→ 不可行动
  return [];
}

/**
 * 贡献路由：将非可行动实体的压力贡献投影到可行动频道。
 *
 * 压力函数按语义维度计算（P3→contact, P4→thread, P2→fact），
 * 但行动执行只能针对频道（channel:*）。此函数是投影算子 ρ: V → V_A，
 * 在压力计算和张力 Map 之间插入，保证下游（焦点集、V-maximizer）
 * 的所有候选都是可行动的。
 *
 * 路由策略：
 *   contact  →  ensureChannelId → channel:X  （"想和 X 聊天" → "在 X 的私聊频道行动"）
 *   thread   →  involves 边 → 关联频道  （"话题 X 需要推进" → "在相关频道行动"）
 *   fact → source_channel/contact  （"事实 X 需要验证" → "在来源频道行动"）
 *
 * 多源汇聚时累加（同一频道可能从 P3 contact + P6 contact 双重接收）。
 * 无可行动目标的贡献被丢弃（e.g. 没有私聊频道的联系人）。
 *
 * @see paper/ §3.3: 张力空间的可行动投影
 */
export function routeContributions(
  contributions: Record<string, Record<string, number>>,
  prospectContributions: Record<string, number>,
  G: WorldModel,
): {
  contributions: Record<string, Record<string, number>>;
  prospectContributions: Record<string, number>;
} {
  const routed: Record<string, Record<string, number>> = {};

  for (const [pk, entityContribs] of Object.entries(contributions)) {
    const routedPk: Record<string, number> = {};
    for (const [eid, value] of Object.entries(entityContribs)) {
      const targets = resolveActionableTargets(eid, G);
      if (targets.length === 0) continue;
      const share = value / targets.length;
      for (const target of targets) {
        routedPk[target] = (routedPk[target] ?? 0) + share;
      }
    }
    routed[pk] = routedPk;
  }

  const routedProspect: Record<string, number> = {};
  for (const [eid, value] of Object.entries(prospectContributions)) {
    const targets = resolveActionableTargets(eid, G);
    if (targets.length === 0) continue;
    const share = value / targets.length;
    for (const target of targets) {
      routedProspect[target] = (routedProspect[target] ?? 0) + share;
    }
  }

  return { contributions: routed, prospectContributions: routedProspect };
}

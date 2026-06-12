/**
 * D4 ClosureDepth — Paper 2, Def 7。
 *
 * 行动到图结构变化的反馈路径深度。
 * 低 ClosureDepth = 行动能直接改变图 = 强反馈闭环。
 * 高 ClosureDepth = 行动效果需要多步中介 = 弱反馈闭环。
 *
 * 计算方法：比较 脚本执行前后图的差异。
 * - 直接修改节点属性 → depth 1
 * - 创建/删除节点 → depth 1
 * - 修改导致其他节点间接变化（传播等）→ depth 2+
 *
 * @see paper/ §Definition 7 "Closure Depth"
 */
import type { WorldModel } from "../graph/world-model.js";

/**
 * ClosureDepth 测量结果。
 * @see paper/ §Definition 7
 */
/** ADR-199: 闭环 breakdown — 标注哪些状态维度发生了变化。 */
export interface ClosureBreakdown {
  /** mood/feel 相关属性变化（mood_valence, mood_shift 等）。 */
  mood: boolean;
  /** thread 相关变化（thread 节点创建/更新/self_topic_advance）。 */
  thread: boolean;
  /** fact 相关变化（self_note, recall_fact）。 */
  fact: boolean;
  /** 边变化（社交关系、knows 边）。 */
  edge: boolean;
}

export interface ClosureDepthResult {
  /** 最大反馈路径深度（0 = 无变化，1 = 直接变更，2+ = 间接传播） */
  maxDepth: number;
  /** 直接变更的节点数（属性发生变化的现有节点） */
  directChanges: number;
  /** 间接变更的节点数（通过传播或级联效应变化的节点）——当前版本不追踪。 */
  indirectChanges: number;
  /** 新建的节点 ID */
  newNodes: string[];
  /** 删除的节点 ID */
  deletedNodes: string[];
  /** 边变化数（新增 + 删除） */
  edgeDelta: number;
  /** ADR-199: 状态维度 breakdown — 诊断闭环质量。 */
  breakdown: ClosureBreakdown;
}

/** 执行前的轻量图状态快照。 */
export interface GraphStateCapture {
  nodeIds: Set<string>;
  attrs: Map<string, Record<string, unknown>>;
  edgeCount: number;
}

/**
 * 在 脚本执行前捕获图状态快照（轻量版）。
 *
 * 只记录 node IDs + 属性浅拷贝 + 边数量。
 * nodeAttrs() 已返回浅拷贝，这里不需要再深拷贝。
 *
 * @see paper/ §Definition 7 "Closure Depth"
 */
export function captureGraphState(G: WorldModel): GraphStateCapture {
  const nodeIds = new Set(G.allNodeIds());
  const attrs = new Map<string, Record<string, unknown>>();
  for (const id of nodeIds) {
    const entry = G.getEntry(id);
    attrs.set(id, { ...entry.attrs } as Record<string, unknown>);
  }
  return { nodeIds, attrs, edgeCount: G.edgeCount };
}

/**
 * 测量 脚本执行前后的图结构变化深度。
 *
 * 对比 before 快照和 after 图的差异：
 * 1. 新增/删除节点
 * 2. 属性变化的节点（浅比较每个属性键值）
 * 3. 边数量变化
 *
 * maxDepth 计算：
 * - 0 = 无任何变化
 * - 1 = 有直接变更（属性/节点/边）
 * - 2+ = 预留（未来追踪 Laplacian 传播引起的间接变更）
 *
 * @param before 执行前通过 captureGraphState() 获取的快照
 * @param after 执行后的 WorldModel 引用
 *
 * @see paper/ §Definition 7 "Closure Depth"
 */
export function measureClosureDepth(
  before: GraphStateCapture,
  after: WorldModel,
): ClosureDepthResult {
  const afterNodeIds = new Set(after.allNodeIds());

  // 新建和删除的节点
  const newNodes: string[] = [];
  const deletedNodes: string[] = [];
  for (const id of afterNodeIds) {
    if (!before.nodeIds.has(id)) newNodes.push(id);
  }
  for (const id of before.nodeIds) {
    if (!afterNodeIds.has(id)) deletedNodes.push(id);
  }

  // 直接变更的节点（属性变化的已有节点）
  let directChanges = 0;
  for (const id of afterNodeIds) {
    if (!before.nodeIds.has(id)) {
      // 新建节点算直接变更
      directChanges++;
      continue;
    }
    const beforeA = before.attrs.get(id);
    if (!beforeA) {
      directChanges++;
      continue;
    }
    const afterEntry = after.getEntry(id);
    const afterA = { ...afterEntry.attrs } as Record<string, unknown>;
    // 浅比较属性——任何一个 key 不同即为变更
    let changed = false;
    const allKeys = new Set([...Object.keys(afterA), ...Object.keys(beforeA)]);
    for (const key of allKeys) {
      if (afterA[key] !== beforeA[key]) {
        changed = true;
        break;
      }
    }
    if (changed) directChanges++;
  }
  // 已删除节点也算直接变更
  directChanges += deletedNodes.length;

  // 边数量变化
  const edgeDelta = Math.abs(after.edgeCount - before.edgeCount);

  // 计算 maxDepth
  // 当前版本：有任何变化 → depth 1，无变化 → depth 0
  // 未来可追踪 Laplacian 传播级联 → depth 2+
  const hasAnyChange = directChanges > 0 || edgeDelta > 0;
  const maxDepth = hasAnyChange ? 1 : 0;

  // ADR-199: breakdown 诊断 — 标注哪些状态维度发生了变化
  const breakdown: ClosureBreakdown = {
    mood: false,
    thread: false,
    fact: false,
    edge: edgeDelta > 0,
  };

  const MOOD_KEYS = new Set([
    "mood_valence",
    "mood_set_ms",
    "mood_effective",
    "mood_arousal",
    "mood_shift_ms",
    "mood_shift",
  ]);

  for (const id of afterNodeIds) {
    if (!before.nodeIds.has(id)) {
      // 新建节点 — 按类型分类
      const nodeType = after.getNodeType(id);
      if (nodeType === "thread") breakdown.thread = true;
      else if (nodeType === "fact") breakdown.fact = true;
      continue;
    }
    const beforeA = before.attrs.get(id);
    if (!beforeA) continue;
    const afterEntry = after.getEntry(id);
    const afterA = { ...afterEntry.attrs } as Record<string, unknown>;
    const nodeType = afterEntry.type;
    for (const key of Object.keys(afterA)) {
      if (afterA[key] !== beforeA[key]) {
        if (MOOD_KEYS.has(key)) breakdown.mood = true;
        if (nodeType === "thread") breakdown.thread = true;
        if (nodeType === "fact") breakdown.fact = true;
      }
    }
  }

  return {
    maxDepth,
    directChanges,
    indirectChanges: 0, // 当前版本不追踪间接变更，预留扩展
    newNodes,
    deletedNodes,
    edgeDelta,
    breakdown,
  };
}

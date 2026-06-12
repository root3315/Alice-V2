/**
 * WorldModel — Alice 的世界模型（类型化属性图）。
 *
 * ADR-154 clean-room 重写，替代 WorldModel。
 *
 * 核心改进：
 * 1. 类型化存储：Map<string, NodeEntry>（判别联合）替代 Map<string, Record<string, unknown>>
 * 2. 类型化 mutation：updateChannel(id, patch) 替代 setNodeAttr(id, "key", value)
 * 3. 实体默认值外提：entity-defaults.ts 纯函数，图类无领域知识
 * 4. 依赖倒置修复：entities.ts 零 telegram/ 导入
 * 5. Ephemeral 存储分离：action 结果不污染持久状态
 *
 * 存储所有权：
 * | 层 | 存储 | 写入者 | 语义 |
 * |---|---|---|---|
 * | node attrs | Map<string, NodeEntry> | perceive / act (typed update) | 实时状态 |
 * | beliefs | BeliefStore | belief/update | Bayesian 连续估计 |
 *
 * @see docs/adr/154-world-model-rewrite.md
 * @see paper-pomdp/ Def 3-4: G(n) is compressed belief, not ground truth
 */

import { type BeliefDict, BeliefStore } from "../belief/store.js";
import { LEGACY_TICK_INTERVAL_MS } from "../pressure/clock.js";
import { labelToCategory } from "./constants.js";
import type {
  AgentAttrs,
  ChannelAttrs,
  ContactAttrs,
  ConversationAttrs,
  EdgeCategory,
  EdgeData,
  FactAttrs,
  Mutable,
  NodeAttrsMap,
  NodeEntry,
  NodeType,
  SerializedGraph,
  SerializedNode,
  ThreadAttrs,
} from "./entities.js";
import {
  agentDefaults,
  type ChannelDefaultsInput,
  channelDefaults,
  contactDefaults,
  conversationDefaults,
  factDefaults,
  requireChannelDefaultsInput,
  threadDefaults,
} from "./entity-defaults.js";

// ═══════════════════════════════════════════════════════════════════════════
// 增量快照类型
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 增量快照数据 — 只包含 dirty 数据，比全图 snapshot() 轻量。
 *
 * 用于沙箱原子执行的快照/回滚：
 * - dirtyNodeEntries: dirty 节点的 NodeEntry 浅拷贝
 * - edges: 仅当 dirtyEdgesRebuild=true 时包含全量边数据
 * - beliefsDict: 始终包含（保证完整回滚）
 *
 * @see paper/ §4 "Incremental State Management"
 */
export interface IncrementalSnapshot {
  tick: number;
  /** dirty 节点的类型化条目（Map<nodeId, NodeEntry 浅拷贝>）。 */
  dirtyNodeEntries: Map<string, NodeEntry>;
  /** dirty 节点中已删除的 ID（快照时图中不存在但 dirtySet 中记录的节点）。 */
  deletedNodeIds: Set<string>;
  /** 如果边需要重建，包含全量边数据。 */
  edges?: Array<{ src: string; dst: string; data: EdgeData }>;
  beliefsDict: BeliefDict;
}

export class WorldModel {
  // === Private state ===

  private nodes = new Map<string, NodeEntry>();
  /** 出边：src → dst → EdgeData[]（允许同对节点间多条边）。 */
  private outEdges = new Map<string, Map<string, EdgeData[]>>();
  /** 入边：dst → src → EdgeData[]。 */
  private inEdges = new Map<string, Map<string, EdgeData[]>>();

  /** Social POMDP: 信念存储。 */
  readonly beliefs = new BeliefStore();

  /** ADR-33: dirty tracking。 */
  private dirtyNodes = new Set<string>();
  private dirtyEdgesRebuild = false;

  private _tick = 0;

  // === tick ===

  get tick(): number {
    return this._tick;
  }
  set tick(value: number) {
    this._tick = value;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node creation (type-specific)
  // ═══════════════════════════════════════════════════════════════════════════

  addAgent(nodeId: string, attrs?: Partial<Omit<AgentAttrs, "entity_type">>): void {
    this.nodes.set(nodeId, { type: "agent", attrs: agentDefaults(attrs) });
    this._ensureEdgeMaps(nodeId);
    this.dirtyNodes.add(nodeId);
  }

  addContact(nodeId: string, attrs?: Partial<Omit<ContactAttrs, "entity_type">>): void {
    this.nodes.set(nodeId, { type: "contact", attrs: contactDefaults(attrs) });
    this._ensureEdgeMaps(nodeId);
    this.dirtyNodes.add(nodeId);
  }

  addChannel(nodeId: string, attrs: ChannelDefaultsInput): void {
    this.nodes.set(nodeId, { type: "channel", attrs: channelDefaults(attrs) });
    this._ensureEdgeMaps(nodeId);
    this.dirtyNodes.add(nodeId);
  }

  addThread(nodeId: string, attrs?: Partial<Omit<ThreadAttrs, "entity_type">>): void {
    this.nodes.set(nodeId, { type: "thread", attrs: threadDefaults(attrs) });
    this._ensureEdgeMaps(nodeId);
    this.dirtyNodes.add(nodeId);
  }

  addFact(nodeId: string, attrs?: Partial<Omit<FactAttrs, "entity_type">>): void {
    this.nodes.set(nodeId, { type: "fact", attrs: factDefaults(attrs) });
    this._ensureEdgeMaps(nodeId);
    this.dirtyNodes.add(nodeId);
  }

  addConversation(nodeId: string, attrs?: Partial<Omit<ConversationAttrs, "entity_type">>): void {
    this.nodes.set(nodeId, { type: "conversation", attrs: conversationDefaults(attrs) });
    this._ensureEdgeMaps(nodeId);
    this.dirtyNodes.add(nodeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node mutation (type-specific)
  // ═══════════════════════════════════════════════════════════════════════════

  updateAgent(nodeId: string, patch: Mutable<AgentAttrs>): void {
    const entry = this._expectType(nodeId, "agent");
    Object.assign(entry.attrs, patch);
    this.dirtyNodes.add(nodeId);
  }

  updateContact(nodeId: string, patch: Mutable<ContactAttrs>): void {
    const entry = this._expectType(nodeId, "contact");
    Object.assign(entry.attrs, patch);
    this.dirtyNodes.add(nodeId);
  }

  updateChannel(nodeId: string, patch: Mutable<ChannelAttrs>): void {
    const entry = this._expectType(nodeId, "channel");
    Object.assign(entry.attrs, patch);
    this.dirtyNodes.add(nodeId);
  }

  updateThread(nodeId: string, patch: Mutable<ThreadAttrs>): void {
    const entry = this._expectType(nodeId, "thread");
    Object.assign(entry.attrs, patch);
    this.dirtyNodes.add(nodeId);
  }

  updateFact(nodeId: string, patch: Mutable<FactAttrs>): void {
    const entry = this._expectType(nodeId, "fact");
    Object.assign(entry.attrs, patch);
    this.dirtyNodes.add(nodeId);
  }

  updateConversation(nodeId: string, patch: Mutable<ConversationAttrs>): void {
    const entry = this._expectType(nodeId, "conversation");
    Object.assign(entry.attrs, patch);
    this.dirtyNodes.add(nodeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node access (type-specific) — 返回浅拷贝
  // ═══════════════════════════════════════════════════════════════════════════

  /** 泛型 typed getter。类型不匹配或节点不存在时抛出。 */
  getTyped<T extends NodeType>(nodeId: string, expectedType: T): NodeAttrsMap[T] {
    const entry = this._expectType(nodeId, expectedType);
    return { ...entry.attrs } as NodeAttrsMap[T];
  }

  getAgent(nodeId: string): AgentAttrs {
    return this.getTyped(nodeId, "agent");
  }

  getContact(nodeId: string): ContactAttrs {
    return this.getTyped(nodeId, "contact");
  }

  getChannel(nodeId: string): ChannelAttrs {
    return this.getTyped(nodeId, "channel");
  }

  getThread(nodeId: string): ThreadAttrs {
    return this.getTyped(nodeId, "thread");
  }

  /** ADR-154: getInfoItem → getFact。 */
  getFact(nodeId: string): FactAttrs {
    return this.getTyped(nodeId, "fact");
  }

  getConversation(nodeId: string): ConversationAttrs {
    return this.getTyped(nodeId, "conversation");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node access (generic)
  // ═══════════════════════════════════════════════════════════════════════════

  /** 返回节点的判别联合条目（浅拷贝）。用于 switch(entry.type) 的泛型代码。 */
  getEntry(nodeId: string): NodeEntry {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Node not found: ${nodeId}`);
    return { type: entry.type, attrs: { ...entry.attrs } } as NodeEntry;
  }

  /** 返回节点的 entity_type（不存在返回 undefined）。 */
  getNodeType(nodeId: string): NodeType | undefined {
    return this.nodes.get(nodeId)?.type as NodeType | undefined;
  }

  /** 返回指定类型的所有节点 id。 */
  getEntitiesByType(entityType: NodeType | string): string[] {
    // Compat: "info_item" → "fact"
    const effectiveType = entityType === "info_item" ? "fact" : entityType;
    const result: string[] = [];
    for (const [id, entry] of this.nodes) {
      if (entry.type === effectiveType) result.push(id);
    }
    return result;
  }

  /** 返回所有节点 id。 */
  allNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /** 检查节点是否存在。 */
  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /** 节点数量。 */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * ADR-112 D2: 图年龄（毫秒）。
   * 读取 self 节点的 created_ms，缺失时回退到 tick × 60s 估算。
   */
  getGraphAgeMs(nowMs: number): number {
    const entry = this.nodes.get("self");
    if (entry && entry.type === "agent") {
      const createdMs = entry.attrs.created_ms ?? 0;
      if (createdMs > 0) return Math.max(0, nowMs - createdMs);
    }
    return this._tick * LEGACY_TICK_INTERVAL_MS;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Escape hatches — 仅供序列化/测试/迁移过渡
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 无类型属性写入（逃生舱口）。
   * 仅供序列化路径和测试使用。生产代码应使用 updateX() 方法。
   */
  setDynamic(nodeId: string, key: string, value: unknown): void {
    if (key === "entity_type") throw new Error("Cannot change entity_type via setDynamic");
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Node not found: ${nodeId}`);
    (entry.attrs as unknown as Record<string, unknown>)[key] = value;
    this.dirtyNodes.add(nodeId);
  }

  /**
   * 无类型属性读取（逃生舱口）。
   * 仅供需要跨类型泛型访问的场景。
   */
  getDynamic(nodeId: string, key: string): unknown {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Node not found: ${nodeId}`);
    return (entry.attrs as unknown as Record<string, unknown>)[key];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 添加一条带标签的有向边。
   * label 自动映射到 EdgeCategory（via labelToCategory）。
   */
  addRelation(
    src: string,
    label: string,
    dst: string,
    extraAttrs: Record<string, unknown> = {},
  ): void {
    const category = labelToCategory(label);
    const edgeData: EdgeData = { label, category, ...extraAttrs };
    this._insertEdge(src, dst, edgeData);
    this.dirtyEdgesRebuild = true;
  }

  /** 添加一条边（显式指定 label + category）。 */
  addEdge(src: string, dst: string, label: string, category: EdgeCategory): void {
    this.addRelation(src, label, dst, { category });
  }

  /** 移除节点及其所有边。审计修复: 级联清理引用此节点的 conversation 实体。 */
  removeEntity(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;

    // 审计修复: 级联清理关联的 conversation 节点。
    // 当 channel 被删除时，引用该 channel 的 conversation 成为孤儿。
    // findActiveConversation 等查询可能返回无效对话。
    const node = this.nodes.get(nodeId);
    if (node && node.type === "channel") {
      const orphanConvs: string[] = [];
      for (const convId of this.getEntitiesByType("conversation")) {
        const convNode = this.nodes.get(convId);
        if (convNode && convNode.type === "conversation" && convNode.attrs.channel === nodeId) {
          orphanConvs.push(convId);
        }
      }
      for (const convId of orphanConvs) {
        this.removeEntity(convId); // 递归清理
      }
    }

    // 移除所有出边
    const srcOut = this.outEdges.get(nodeId);
    if (srcOut) {
      for (const dst of srcOut.keys()) {
        this.inEdges.get(dst)?.delete(nodeId);
      }
    }
    this.outEdges.delete(nodeId);

    // 移除所有入边
    const dstIn = this.inEdges.get(nodeId);
    if (dstIn) {
      for (const src of dstIn.keys()) {
        this.outEdges.get(src)?.delete(nodeId);
      }
    }
    this.inEdges.delete(nodeId);

    this.nodes.delete(nodeId);
    this.dirtyNodes.add(nodeId);
    this.dirtyEdgesRebuild = true;
  }

  /** 后继邻居（出边目标），可按 label 过滤。 */
  getNeighbors(nodeId: string, label?: string): string[] {
    const srcOut = this.outEdges.get(nodeId);
    if (!srcOut) return [];
    if (label === undefined) return Array.from(srcOut.keys());
    const result: string[] = [];
    for (const [dst, edges] of srcOut) {
      if (edges.some((e) => e.label === label)) result.push(dst);
    }
    return result;
  }

  /** 前驱邻居（入边来源），可按 label 过滤。 */
  getPredecessors(nodeId: string, label?: string): string[] {
    const dstIn = this.inEdges.get(nodeId);
    if (!dstIn) return [];
    if (label === undefined) return Array.from(dstIn.keys());
    const result: string[] = [];
    for (const [src, edges] of dstIn) {
      if (edges.some((e) => e.label === label)) result.push(src);
    }
    return result;
  }

  /** 遍历所有边。 */
  *allEdges(): Generator<[string, string, EdgeData]> {
    for (const [src, targets] of this.outEdges) {
      for (const [dst, edges] of targets) {
        for (const edge of edges) {
          yield [src, dst, edge];
        }
      }
    }
  }

  /** 边数量。 */
  get edgeCount(): number {
    let count = 0;
    for (const targets of this.outEdges.values()) {
      for (const edges of targets.values()) {
        count += edges.length;
      }
    }
    return count;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serialization (ADR-154: toDict → serialize, fromDict → deserialize)
  // ═══════════════════════════════════════════════════════════════════════════

  /** 序列化为 JSON 兼容字典。格式与旧 WorldModel.toDict() 兼容。 */
  serialize(): SerializedGraph {
    const nodes: SerializedNode[] = [];
    for (const [id, entry] of this.nodes) {
      const nd: Record<string, unknown> = { id };
      for (const [k, v] of Object.entries(entry.attrs)) {
        nd[k] = v === Infinity ? "inf" : v;
      }
      nodes.push(nd as SerializedNode);
    }

    const edges: Array<Record<string, unknown>> = [];
    for (const [src, dst, edge] of this.allEdges()) {
      const ed: Record<string, unknown> = { src, dst };
      for (const [k, v] of Object.entries(edge)) {
        ed[k] = v === Infinity ? "inf" : v;
      }
      edges.push(ed);
    }

    const beliefsDict = this.beliefs.toDict();
    const hasBeliefs = Object.keys(beliefsDict.entries).length > 0;

    return {
      tick: this._tick,
      nodes,
      edges,
      ...(hasBeliefs ? { beliefs: beliefsDict } : {}),
    } as SerializedGraph;
  }

  /**
   * 从字典反序列化。
   * ADR-154 D8: 旧快照中的 info_item 自动映射为 fact。
   */
  static deserialize(data: SerializedGraph): WorldModel {
    const G = new WorldModel();
    G._rebuildFrom(data);
    return G;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dirty tracking (ADR-33)
  // ═══════════════════════════════════════════════════════════════════════════

  /** 是否有未写回的变更。 */
  isDirty(): boolean {
    return this.dirtyNodes.size > 0 || this.dirtyEdgesRebuild;
  }

  /** 获取 dirty 节点集合（flush 时使用）。 */
  getDirtyNodes(): ReadonlySet<string> {
    return this.dirtyNodes;
  }

  /** 是否需要重建边（flush 时使用）。 */
  needsEdgeRebuild(): boolean {
    return this.dirtyEdgesRebuild;
  }

  /** flush 完成后清除 dirty 标记。 */
  clearDirty(): void {
    this.dirtyNodes.clear();
    this.dirtyEdgesRebuild = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Snapshot / rollback
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 增量快照——只包含 dirty 数据。
   * @see paper/ §4 "Incremental State Management"
   */
  snapshotIncremental(): IncrementalSnapshot {
    const snap: IncrementalSnapshot = {
      tick: this._tick,
      dirtyNodeEntries: new Map(),
      deletedNodeIds: new Set(),
      beliefsDict: this.beliefs.toDict(),
    };

    for (const nodeId of this.dirtyNodes) {
      const entry = this.nodes.get(nodeId);
      if (entry) {
        snap.dirtyNodeEntries.set(nodeId, {
          type: entry.type,
          attrs: { ...entry.attrs },
        } as NodeEntry);
      } else {
        snap.deletedNodeIds.add(nodeId);
      }
    }

    if (this.dirtyEdgesRebuild) {
      snap.edges = [];
      for (const [src, dst, data] of this.allEdges()) {
        snap.edges.push({ src, dst, data: { ...data } });
      }
    }

    return snap;
  }

  /**
   * 从增量快照恢复（回滚 dirty 变更）。
   *
   * 恢复策略：
   * 1. dirty 节点：恢复 NodeEntry 到快照值，或删除快照中不存在的节点
   * 2. 执行期间新创建的节点（不在快照中）：删除
   * 3. 边：若快照包含边数据则全量重建
   * 4. beliefs：全量恢复
   * 5. tick：恢复到快照时的值
   */
  restoreFromIncremental(snap: IncrementalSnapshot): void {
    // 1. 恢复 dirty 节点
    for (const [nodeId, entry] of snap.dirtyNodeEntries) {
      this.nodes.set(nodeId, { type: entry.type, attrs: { ...entry.attrs } } as NodeEntry);
      this._ensureEdgeMaps(nodeId);
    }

    // 2. 删除快照时不存在但执行中被创建的节点
    for (const nodeId of snap.deletedNodeIds) {
      if (this.nodes.has(nodeId)) {
        this.removeEntity(nodeId);
      }
    }

    // 3. 删除执行期间新创建的节点（快照中既不在 entries 也不在 deleted 中）
    const toRemove: string[] = [];
    for (const nodeId of this.dirtyNodes) {
      if (!snap.dirtyNodeEntries.has(nodeId) && !snap.deletedNodeIds.has(nodeId)) {
        if (this.nodes.has(nodeId)) {
          toRemove.push(nodeId);
        }
      }
    }
    for (const nodeId of toRemove) {
      this.removeEntity(nodeId);
    }

    // 4. 恢复边
    if (snap.edges) {
      this.outEdges.clear();
      this.inEdges.clear();
      for (const nodeId of this.nodes.keys()) {
        this.outEdges.set(nodeId, new Map());
        this.inEdges.set(nodeId, new Map());
      }
      for (const { src, dst, data } of snap.edges) {
        if (!this.nodes.has(src) || !this.nodes.has(dst)) continue;
        this._insertEdge(src, dst, { ...data });
      }
    }

    // 5. 恢复 beliefs
    this.beliefs.restoreFrom(BeliefStore.fromDict(snap.beliefsDict));

    // 6. 恢复 tick
    this._tick = snap.tick;

    // 回滚后标记恢复的节点和边为 dirty
    for (const nodeId of snap.dirtyNodeEntries.keys()) {
      this.dirtyNodes.add(nodeId);
    }
    if (snap.edges) {
      this.dirtyEdgesRebuild = true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private _ensureEdgeMaps(nodeId: string): void {
    if (!this.outEdges.has(nodeId)) this.outEdges.set(nodeId, new Map());
    if (!this.inEdges.has(nodeId)) this.inEdges.set(nodeId, new Map());
  }

  /** 类型守卫：断言节点存在且类型匹配。返回内部 NodeEntry 引用（非拷贝）。 */
  private _expectType<T extends NodeType>(
    nodeId: string,
    expectedType: T,
  ): Extract<NodeEntry, { type: T }> {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Node not found: ${nodeId}`);
    if (entry.type !== expectedType) {
      throw new Error(`Node ${nodeId} is ${entry.type}, expected ${expectedType}`);
    }
    return entry as Extract<NodeEntry, { type: T }>;
  }

  /** 直接插入边到邻接表（不设置 dirtyEdgesRebuild——供反序列化和快照恢复使用）。 */
  private _insertEdge(src: string, dst: string, data: EdgeData): void {
    let srcOut = this.outEdges.get(src);
    if (!srcOut) {
      srcOut = new Map();
      this.outEdges.set(src, srcOut);
    }
    const existingOut = srcOut.get(dst);
    if (existingOut) existingOut.push(data);
    else srcOut.set(dst, [data]);

    let dstIn = this.inEdges.get(dst);
    if (!dstIn) {
      dstIn = new Map();
      this.inEdges.set(dst, dstIn);
    }
    const existingIn = dstIn.get(src);
    if (existingIn) existingIn.push(data);
    else dstIn.set(src, [data]);
  }

  /**
   * 从序列化数据重建节点、边。
   * ADR-154 D8: info_item 自动映射为 fact。
   */
  private _rebuildFrom(data: SerializedGraph): void {
    this._tick = data.tick;

    // 重建节点——通过 typed add 方法确保默认值
    for (const node of data.nodes) {
      const { id, entity_type, ...rest } = node;
      for (const [k, v] of Object.entries(rest)) {
        if (v === "inf") (rest as Record<string, unknown>)[k] = Infinity;
      }
      // _addFromSerialized 内部处理 info_item → fact 迁移
      this._addFromSerialized(id as string, entity_type as string, rest as Record<string, unknown>);
    }

    // 重建边（通过 _insertEdge 直接操作邻接表，不触发 dirtyEdgesRebuild）
    for (const edge of data.edges) {
      const { src, dst, label, category, ...rest } = edge;
      for (const [k, v] of Object.entries(rest)) {
        if (v === "inf") (rest as Record<string, unknown>)[k] = Infinity;
      }
      const edgeData: EdgeData = {
        label: label as string,
        category: category as EdgeCategory,
        ...rest,
      };
      this._insertEdge(src as string, dst as string, edgeData);
    }

    // Social POMDP: 恢复信念
    if (data.beliefs) {
      this.beliefs.restoreFrom(BeliefStore.fromDict(data.beliefs));
    }
  }

  /** 反序列化分派——从 entity_type 字符串路由到 typed add 方法。 */
  private _addFromSerialized(id: string, entityType: string, attrs: Record<string, unknown>): void {
    // ADR-154 D8: info_item → fact 迁移
    const type = entityType === "info_item" ? "fact" : entityType;
    // 反序列化路径：attrs 来自 JSON，类型为 Record<string, unknown>。
    // 工厂函数的 spread 保留所有已知和未知字段，entity_type 最后覆写。
    switch (type) {
      case "agent":
        this.addAgent(id, attrs as Partial<Omit<AgentAttrs, "entity_type">>);
        break;
      case "contact":
        this.addContact(id, attrs as Partial<Omit<ContactAttrs, "entity_type">>);
        break;
      case "channel":
        this.addChannel(id, requireChannelDefaultsInput(id, attrs));
        break;
      case "thread":
        this.addThread(id, attrs as Partial<Omit<ThreadAttrs, "entity_type">>);
        break;
      case "fact":
        this.addFact(id, attrs as Partial<Omit<FactAttrs, "entity_type">>);
        break;
      case "conversation":
        this.addConversation(id, attrs as Partial<Omit<ConversationAttrs, "entity_type">>);
        break;
      // 未知实体类型——静默跳过（旧快照可能包含已废弃的类型）
    }
  }
}

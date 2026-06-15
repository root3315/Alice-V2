/**
 * WorldModel — модель мира Алисы (типизированный граф свойств).
 *
 * Переписан с нуля по ADR-154, заменяет предыдущий WorldModel.
 *
 * Ключевые улучшения:
 * 1. Типизированное хранилище: Map<string, NodeEntry> (дискриминированное объединение) вместо Map<string, Record<string, unknown>>
 * 2. Типизированные мутации: updateChannel(id, patch) вместо setNodeAttr(id, "key", value)
 * 3. Дефолтные значения вынесены наружу: чистые функции entity-defaults.ts, граф-класс не знает домена
 * 4. Исправление инверсии зависимостей: entities.ts без импортов из telegram/
 * 5. Изоляция ephemeral-хранилища: результаты action не загрязняют персистентное состояние
 *
 * Владение хранилищами:
 * | Слой | Хранилище | Писатель | Семантика |
 * |---|---|---|---|
 * | node attrs | Map<string, NodeEntry> | perceive / act (typed update) | текущее состояние |
 * | beliefs | BeliefStore | belief/update | непрерывная байесовская оценка |
 *
 * @see docs/adr/154-world-model-rewrite.md
 * @see paper-pomdp/ Def 3-4: G(n) is compressed belief, not ground truth
 */

import { type BeliefDict, BeliefStore } from "../belief/store.js";
import { LEGACY_TICK_INTERVAL_MS } from "../pressure/clock.js";
import { ALICE_SELF, labelToCategory } from "./constants.js";
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
// Типы инкрементального снапшота
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Данные инкрементального снапшота — содержит только dirty-данные, легче полного snapshot().
 *
 * Используется для снапшота/отката атомарного выполнения в песочнице:
 * - dirtyNodeEntries: поверхностные копии NodeEntry для dirty-узлов
 * - nodeEntries: M2-фикс — поверхностные копии NodeEntry для ВСЕХ узлов на момент
 *   снапшота, чтобы при откате можно было восстановить каскадно удалённые ЧИСТЫЕ
 *   соседние узлы (например, conversation, удалённые removeEntity(channel))
 * - edges: полный набор рёбер, всегда захватывается (M2-фикс) — иначе фантомные рёбра,
 *   добавленные после снапшота, переживают откат
 * - beliefsDict: всегда включён (гарантия полного отката)
 *
 * @see paper/ §4 "Incremental State Management"
 */
export interface IncrementalSnapshot {
  tick: number;
  /** Типизированные записи dirty-узлов (Map<nodeId, поверхностная копия NodeEntry>). */
  dirtyNodeEntries: Map<string, NodeEntry>;
  /**
   * M2-фикс: поверхностные копии NodeEntry для ВСЕХ узлов на момент снапшота.
   * Нужны, чтобы восстановить каскадно удалённые ЧИСТЫЕ соседние узлы при откате
   * (узел, не помеченный dirty на момент снапшота и удалённый removeEntity позже).
   */
  nodeEntries?: Map<string, NodeEntry>;
  /** ID удалённых узлов среди dirty-узлов (узлы, отсутствующие в графе на момент снапшота, но записанные в dirtySet). */
  deletedNodeIds: Set<string>;
  /** H8: полный набор id узлов НА МОМЕНТ снапшота — чтобы при откате удалять только реально новые. */
  snapshotNodeIds?: Set<string>;
  /** Полный набор данных рёбер на момент снапшота (M2-фикс: захватывается всегда). */
  edges?: Array<{ src: string; dst: string; data: EdgeData }>;
  beliefsDict: BeliefDict;
}

export class WorldModel {
  // === Private state ===

  private nodes = new Map<string, NodeEntry>();
  /** Исходящие рёбра: src → dst → EdgeData[] (допускается несколько рёбер между одной парой узлов). */
  private outEdges = new Map<string, Map<string, EdgeData[]>>();
  /** Входящие рёбра: dst → src → EdgeData[]. */
  private inEdges = new Map<string, Map<string, EdgeData[]>>();

  /** Social POMDP: хранилище убеждений. */
  readonly beliefs = new BeliefStore();

  /** ADR-33: отслеживание dirty-состояния. */
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
  // Создание узлов (типизированное)
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
  // Мутация узлов (типизированная)
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
  // Доступ к узлам (типизированный) — возвращает поверхностные копии
  // ═══════════════════════════════════════════════════════════════════════════

  /** Обобщённый типизированный геттер. Выбрасывает исключение при несовпадении типа или отсутствии узла. */
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

  /** ADR-154: getInfoItem → getFact. */
  getFact(nodeId: string): FactAttrs {
    return this.getTyped(nodeId, "fact");
  }

  getConversation(nodeId: string): ConversationAttrs {
    return this.getTyped(nodeId, "conversation");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node access (generic)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Возвращает дискриминированную запись узла (поверхностная копия). Используется в обобщённом коде с switch(entry.type). */
  getEntry(nodeId: string): NodeEntry {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Node not found: ${nodeId}`);
    return { type: entry.type, attrs: { ...entry.attrs } } as NodeEntry;
  }

  /** Возвращает entity_type узла (undefined если узел не существует). */
  getNodeType(nodeId: string): NodeType | undefined {
    return this.nodes.get(nodeId)?.type as NodeType | undefined;
  }

  /** Возвращает все id узлов указанного типа. */
  getEntitiesByType(entityType: NodeType | string): string[] {
    // Compat: "info_item" → "fact"
    const effectiveType = entityType === "info_item" ? "fact" : entityType;
    const result: string[] = [];
    for (const [id, entry] of this.nodes) {
      if (entry.type === effectiveType) result.push(id);
    }
    return result;
  }

  /** Возвращает все id узлов. */
  allNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /** Проверяет существование узла. */
  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /** Количество узлов. */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * ADR-112 D2: возраст графа (в миллисекундах).
   * Читает created_ms узла self; при отсутствии — возвращает оценку tick × 60s.
   */
  getGraphAgeMs(nowMs: number): number {
    const entry = this.nodes.get(ALICE_SELF);
    if (entry && entry.type === "agent") {
      const createdMs = entry.attrs.created_ms ?? 0;
      if (createdMs > 0) return Math.max(0, nowMs - createdMs);
    }
    return this._tick * LEGACY_TICK_INTERVAL_MS;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Аварийные выходы — только для сериализации/тестов/переходных миграций
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Нетипизированная запись атрибута (аварийный выход).
   * Только для пути сериализации и тестов. В production-коде использовать методы updateX().
   */
  setDynamic(nodeId: string, key: string, value: unknown): void {
    if (key === "entity_type") throw new Error("Cannot change entity_type via setDynamic");
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`Node not found: ${nodeId}`);
    (entry.attrs as unknown as Record<string, unknown>)[key] = value;
    this.dirtyNodes.add(nodeId);
  }

  /**
   * Нетипизированное чтение атрибута (аварийный выход).
   * Только для сценариев с обобщённым доступом через несколько типов.
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
   * Добавляет размеченное направленное ребро.
   * label автоматически отображается в EdgeCategory (через labelToCategory).
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

  /** Добавляет ребро (явно задаются label + category). */
  addEdge(src: string, dst: string, label: string, category: EdgeCategory): void {
    this.addRelation(src, label, dst, { category });
  }

  /** Удаляет узел и все его рёбра. Аудит-фикс: каскадно очищает conversation-сущности, ссылающиеся на этот узел. */
  removeEntity(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;

    // Аудит-фикс: каскадно очищаем связанные conversation-узлы.
    // При удалении channel conversation-ы, ссылающиеся на него, становятся осиротевшими.
    // Запросы вроде findActiveConversation могут возвращать недействительные диалоги.
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
        this.removeEntity(convId); // рекурсивная очистка
      }
    }

    // Удаляем все исходящие рёбра
    const srcOut = this.outEdges.get(nodeId);
    if (srcOut) {
      for (const dst of srcOut.keys()) {
        this.inEdges.get(dst)?.delete(nodeId);
      }
    }
    this.outEdges.delete(nodeId);

    // Удаляем все входящие рёбра
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

  /** Преемники (цели исходящих рёбер), можно фильтровать по label. */
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

  /** Предшественники (источники входящих рёбер), можно фильтровать по label. */
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

  /** Обходит все рёбра. */
  *allEdges(): Generator<[string, string, EdgeData]> {
    for (const [src, targets] of this.outEdges) {
      for (const [dst, edges] of targets) {
        for (const edge of edges) {
          yield [src, dst, edge];
        }
      }
    }
  }

  /** Количество рёбер. */
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

  /** Сериализует в JSON-совместимый словарь. Формат совместим со старым WorldModel.toDict(). */
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
   * Десериализует из словаря.
   * ADR-154 D8: info_item в старых снапшотах автоматически отображается как fact.
   */
  static deserialize(data: SerializedGraph): WorldModel {
    const G = new WorldModel();
    G._rebuildFrom(data);
    return G;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dirty tracking (ADR-33)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Есть ли незафиксированные изменения. */
  isDirty(): boolean {
    return this.dirtyNodes.size > 0 || this.dirtyEdgesRebuild;
  }

  /** H12: пометить рёбра грязными. deserialize() строит рёбра приватным _insertEdge БЕЗ
   *  dirty-флага, поэтому миграция обязана вызвать это, иначе flushGraph пропустит все рёбра. */
  markEdgesDirty(): void {
    this.dirtyEdgesRebuild = true;
  }

  /** Возвращает набор dirty-узлов (используется при flush). */
  getDirtyNodes(): ReadonlySet<string> {
    return this.dirtyNodes;
  }

  /** Нужно ли перестраивать рёбра (используется при flush). */
  needsEdgeRebuild(): boolean {
    return this.dirtyEdgesRebuild;
  }

  /** Сбрасывает dirty-метки после завершения flush. */
  clearDirty(): void {
    this.dirtyNodes.clear();
    this.dirtyEdgesRebuild = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Snapshot / rollback
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Инкрементальный снапшот — содержит только dirty-данные.
   * @see paper/ §4 "Incremental State Management"
   */
  snapshotIncremental(): IncrementalSnapshot {
    const snap: IncrementalSnapshot = {
      tick: this._tick,
      dirtyNodeEntries: new Map(),
      nodeEntries: new Map(), // M2-фикс: полные записи всех узлов на момент снапшота
      deletedNodeIds: new Set(),
      snapshotNodeIds: new Set(this.nodes.keys()), // H8: что существовало на момент снапшота
      beliefsDict: this.beliefs.toDict(),
    };

    // M2-фикс: захватываем поверхностные копии ВСЕХ узлов, чтобы при откате можно было
    // восстановить каскадно удалённые ЧИСТЫЕ соседние узлы (например, conversation,
    // удалённые removeEntity(channel) уже ПОСЛЕ снапшота — они не попадают в dirtyNodes
    // на момент снапшота и иначе вернулись бы без рёбер или вовсе не восстановились).
    for (const [nodeId, entry] of this.nodes) {
      const copy = {
        type: entry.type,
        attrs: { ...entry.attrs },
      } as NodeEntry;
      // biome-ignore lint/style/noNonNullAssertion: nodeEntries инициализирован выше
      snap.nodeEntries!.set(nodeId, copy);
    }

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

    // M2-фикс: захватываем полный набор рёбер ВСЕГДА (не только при dirtyEdgesRebuild).
    // Если op после снапшота добавит рёбра или вызовет removeEntity, откат обязан
    // полностью перестроить рёбра — иначе фантомные рёбра переживают откат.
    snap.edges = [];
    for (const [src, dst, data] of this.allEdges()) {
      snap.edges.push({ src, dst, data: { ...data } });
    }

    return snap;
  }

  /**
   * Восстанавливает из инкрементального снапшота (откат dirty-изменений).
   *
   * Стратегия восстановления:
   * 1. dirty-узлы: восстанавливаем NodeEntry до значений снапшота или удаляем узлы, отсутствующие в снапшоте
   * 2. Узлы, созданные в процессе выполнения (не в снапшоте): удаляем
   * 3. Рёбра: полная перестройка, если снапшот содержит данные рёбер
   * 4. beliefs: полное восстановление
   * 5. tick: возвращаем к значению на момент снапшота
   */
  restoreFromIncremental(snap: IncrementalSnapshot): void {
    // 1. Восстанавливаем dirty-узлы
    for (const [nodeId, entry] of snap.dirtyNodeEntries) {
      this.nodes.set(nodeId, { type: entry.type, attrs: { ...entry.attrs } } as NodeEntry);
      this._ensureEdgeMaps(nodeId);
    }

    // 1b. M2-фикс: восстанавливаем каскадно удалённые ЧИСТЫЕ узлы.
    // Узел, существовавший на момент снапшота, но удалённый ПОСЛЕ снапшота (например,
    // conversation, каскадно удалённый removeEntity(channel)), не попадает в
    // dirtyNodeEntries. Восстанавливаем его из полного снимка nodeEntries.
    if (snap.nodeEntries) {
      for (const [nodeId, entry] of snap.nodeEntries) {
        if (!this.nodes.has(nodeId)) {
          this.nodes.set(nodeId, { type: entry.type, attrs: { ...entry.attrs } } as NodeEntry);
          this._ensureEdgeMaps(nodeId);
        }
      }
    }

    // 2. Удаляем узлы, которых не было в снапшоте, но созданные в процессе выполнения
    for (const nodeId of snap.deletedNodeIds) {
      if (this.nodes.has(nodeId)) {
        this.removeEntity(nodeId);
      }
    }

    // 3. Удаляем узлы, созданные в процессе выполнения (отсутствующие в снапшоте ни в entries, ни в deleted)
    const toRemove: string[] = [];
    for (const nodeId of this.dirtyNodes) {
      // H8: удаляем только узлы, РЕАЛЬНО созданные после снапшота (которых не было в snapshotNodeIds).
      // Узел, существовавший на снапшоте (даже чистый и изменённый позже), НЕ удаляем — иначе потеря данных.
      const createdAfterSnapshot = snap.snapshotNodeIds
        ? !snap.snapshotNodeIds.has(nodeId)
        : !snap.dirtyNodeEntries.has(nodeId) && !snap.deletedNodeIds.has(nodeId);
      if (createdAfterSnapshot && this.nodes.has(nodeId)) {
        toRemove.push(nodeId);
      }
    }
    for (const nodeId of toRemove) {
      this.removeEntity(nodeId);
    }

    // 4. Восстанавливаем рёбра
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

    // 5. Восстанавливаем beliefs
    this.beliefs.restoreFrom(BeliefStore.fromDict(snap.beliefsDict));

    // 6. Восстанавливаем tick
    this._tick = snap.tick;

    // После отката помечаем восстановленные узлы и рёбра как dirty
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

  /** Тип-гард: утверждает, что узел существует и тип совпадает. Возвращает внутреннюю ссылку NodeEntry (не копию). */
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

  /** Напрямую вставляет ребро в список смежности (без установки dirtyEdgesRebuild — для десериализации и восстановления снапшота). */
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
   * Перестраивает узлы и рёбра из сериализованных данных.
   * ADR-154 D8: info_item автоматически отображается как fact.
   */
  private _rebuildFrom(data: SerializedGraph): void {
    this._tick = data.tick;

    // Перестраиваем узлы — дефолтные значения гарантируются типизированными методами add
    for (const node of data.nodes) {
      const { id, entity_type, ...rest } = node;
      for (const [k, v] of Object.entries(rest)) {
        if (v === "inf") (rest as Record<string, unknown>)[k] = Infinity;
      }
      // _addFromSerialized внутри обрабатывает миграцию info_item → fact
      this._addFromSerialized(id as string, entity_type as string, rest as Record<string, unknown>);
    }

    // Перестраиваем рёбра (через _insertEdge напрямую в список смежности, без установки dirtyEdgesRebuild)
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

    // Social POMDP: восстанавливаем убеждения
    if (data.beliefs) {
      this.beliefs.restoreFrom(BeliefStore.fromDict(data.beliefs));
    }
  }

  /** Диспетчеризация десериализации — маршрутизирует по строке entity_type к типизированным методам add. */
  private _addFromSerialized(id: string, entityType: string, attrs: Record<string, unknown>): void {
    // ADR-154 D8: миграция info_item → fact
    const type = entityType === "info_item" ? "fact" : entityType;
    // Путь десериализации: attrs из JSON, тип Record<string, unknown>.
    // Spread в фабричной функции сохраняет все известные и неизвестные поля; entity_type перезаписывается последним.
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
      // Неизвестный тип сущности — молча пропускаем (старые снапшоты могут содержать устаревшие типы)
    }
  }
}

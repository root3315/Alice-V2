/**
 * D4 ClosureDepth — Paper 2, Def 7。
 *
 * Глубина пути обратной связи от действия до изменения структуры графа.
 * Низкий ClosureDepth = действие напрямую меняет граф = сильный контур обратной связи.
 * Высокий ClosureDepth = эффект действия требует нескольких промежуточных шагов = слабый контур.
 *
 * Метод расчёта: сравнение графа до и после выполнения скрипта.
 * - Прямое изменение атрибутов узла → depth 1
 * - Создание/удаление узла → depth 1
 * - Изменение, вызывающее косвенные изменения других узлов (распространение и т.п.) → depth 2+
 *
 * @see paper/ §Definition 7 "Closure Depth"
 */
import type { WorldModel } from "../graph/world-model.js";

/**
 * Результат измерения ClosureDepth.
 * @see paper/ §Definition 7
 */
/** ADR-199: breakdown замкнутого контура — отмечает, какие измерения состояния изменились. */
export interface ClosureBreakdown {
  /** Изменения атрибутов mood/feel (mood_valence, mood_shift и т.п.). */
  mood: boolean;
  /** Изменения, связанные с thread (создание/обновление узла thread, self_topic_advance). */
  thread: boolean;
  /** Изменения, связанные с fact (self_note, recall_fact). */
  fact: boolean;
  /** Изменения рёбер (социальные связи, рёбра knows). */
  edge: boolean;
}

export interface ClosureDepthResult {
  /** Максимальная глубина пути обратной связи (0 = нет изменений, 1 = прямые изменения, 2+ = косвенное распространение). */
  maxDepth: number;
  /** Количество узлов с прямыми изменениями (существующие узлы, у которых изменились атрибуты). */
  directChanges: number;
  /** Количество узлов с косвенными изменениями (изменившиеся через распространение или каскадный эффект) — в текущей версии не отслеживается. */
  indirectChanges: number;
  /** ID новых узлов. */
  newNodes: string[];
  /** ID удалённых узлов. */
  deletedNodes: string[];
  /** Количество изменений рёбер (добавленные + удалённые). */
  edgeDelta: number;
  /** ADR-199: breakdown измерений состояния — диагностика качества замкнутого контура. */
  breakdown: ClosureBreakdown;
}

/** Лёгкий снимок состояния графа до выполнения. */
export interface GraphStateCapture {
  nodeIds: Set<string>;
  attrs: Map<string, Record<string, unknown>>;
  edgeCount: number;
}

/**
 * Захватывает лёгкий снимок состояния графа до выполнения скрипта.
 *
 * Записывает только node IDs + поверхностную копию атрибутов + количество рёбер.
 * nodeAttrs() уже возвращает поверхностную копию, повторное глубокое копирование не требуется.
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
 * Измеряет глубину изменений структуры графа до и после выполнения скрипта.
 *
 * Сравнивает снимок before с графом after:
 * 1. Добавленные/удалённые узлы
 * 2. Узлы с изменёнными атрибутами (поверхностное сравнение каждой пары ключ-значение)
 * 3. Изменение количества рёбер
 *
 * Расчёт maxDepth:
 * - 0 = никаких изменений
 * - 1 = есть прямые изменения (атрибуты/узлы/рёбра)
 * - 2+ = зарезервировано (будущее отслеживание косвенных изменений через Laplacian-распространение)
 *
 * @param before снимок, полученный через captureGraphState() до выполнения
 * @param after ссылка на WorldModel после выполнения
 *
 * @see paper/ §Definition 7 "Closure Depth"
 */
export function measureClosureDepth(
  before: GraphStateCapture,
  after: WorldModel,
): ClosureDepthResult {
  const afterNodeIds = new Set(after.allNodeIds());

  // Новые и удалённые узлы
  const newNodes: string[] = [];
  const deletedNodes: string[] = [];
  for (const id of afterNodeIds) {
    if (!before.nodeIds.has(id)) newNodes.push(id);
  }
  for (const id of before.nodeIds) {
    if (!afterNodeIds.has(id)) deletedNodes.push(id);
  }

  // Узлы с прямыми изменениями (существующие узлы с изменёнными атрибутами)
  let directChanges = 0;
  for (const id of afterNodeIds) {
    if (!before.nodeIds.has(id)) {
      // Новый узел считается прямым изменением
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
    // Поверхностное сравнение атрибутов — любое отличие по ключу считается изменением
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
  // Удалённые узлы тоже считаются прямыми изменениями
  directChanges += deletedNodes.length;

  // Изменение количества рёбер
  const edgeDelta = Math.abs(after.edgeCount - before.edgeCount);

  // Расчёт maxDepth
  // Текущая версия: есть любые изменения → depth 1, нет изменений → depth 0
  // В будущем можно отслеживать каскадное Laplacian-распространение → depth 2+
  const hasAnyChange = directChanges > 0 || edgeDelta > 0;
  const maxDepth = hasAnyChange ? 1 : 0;

  // ADR-199: диагностический breakdown — отмечает, какие измерения состояния изменились
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
      // Новый узел — классифицируем по типу
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
    indirectChanges: 0, // Текущая версия не отслеживает косвенные изменения, зарезервировано для расширения
    newNodes,
    deletedNodes,
    edgeDelta,
    breakdown,
  };
}

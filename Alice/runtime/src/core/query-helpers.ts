/**
 * Типобезопасная обёртка dispatcher.query.
 *
 * Единственная точка с контролируемым приведением `as` — на сайтах вызова ноль `as`.
 * Типы возвращаемых значений запросов централизованно объявлены в QueryResultMap.
 */

/** Отображение всех известных query → типов возвращаемых значений. */
export interface QueryResultMap {
  debugPressures: {
    P1: number;
    P2: number;
    P3: number;
    P4: number;
    P5: number;
    P6: number;
    API: number;
  } | null;
  debugGraphStats: {
    nodeCount: number;
    edgeCount: number;
    byType: Record<string, number>;
  };
  debugTierDistribution: {
    total: number;
    buckets: Record<string, number>;
  } | null;
  open_topics: Array<{
    id: number;
    title: string;
    pressure?: number;
    /** ADR-190: "conversation" | "system". Используется для фильтрации system thread. */
    source?: string | null;
    /** Узлы, к которым привязан тред (контакты/каналы). Для scope заголовков по текущему чату. */
    involves?: Array<{ nodeId: string }>;
  }>;
  crisis_channels: string[];
  best_time: {
    peakHour: number | undefined;
  } | null;
  contact_profile: {
    contactId: string;
    displayName: string;
    tier: number;
    trust?: number;
    previousTrust?: number;
    facts: string[];
  } | null;
}

/** Dispatcher-подобный интерфейс (во избежание циклических зависимостей). */
interface Queryable {
  query: (name: string, args: Record<string, unknown>) => unknown;
}

/**
 * Типобезопасный dispatcher.query.
 * Внутри одно контролируемое приведение `as`, на всех сайтах вызова ноль `as`.
 */
export function typedQuery<K extends keyof QueryResultMap>(
  dispatcher: Queryable,
  name: K,
  args: Record<string, unknown> = {},
): QueryResultMap[K] {
  return dispatcher.query(name, args) as QueryResultMap[K];
}

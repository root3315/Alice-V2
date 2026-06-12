/**
 * 类型安全的 dispatcher.query wrapper。
 *
 * 单一入口的受控 `as` 断言 — 调用站点零 `as`。
 * 查询返回类型在 QueryResultMap 中集中声明。
 */

/** 所有已知 query → 返回类型的映射。 */
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
    /** ADR-190: "conversation" | "system"。用于过滤 system thread。 */
    source?: string | null;
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

/** Dispatcher-like 接口（避免循环依赖）。 */
interface Queryable {
  query: (name: string, args: Record<string, unknown>) => unknown;
}

/**
 * 类型安全的 dispatcher.query。
 * 内部有一处受控 `as`，所有调用站点零 `as`。
 */
export function typedQuery<K extends keyof QueryResultMap>(
  dispatcher: Queryable,
  name: K,
  args: Record<string, unknown> = {},
): QueryResultMap[K] {
  return dispatcher.query(name, args) as QueryResultMap[K];
}

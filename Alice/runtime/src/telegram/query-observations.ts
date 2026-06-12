/**
 * ADR-105 CQRS + ADR-140 D2: Query 结果格式化（单一真相来源）。
 *
 * 从 Query impl 写入的图属性中格式化 observation 文本。
 * D2 增强：空结果注入语义标注，避免 LLM 误判为查询失败而重试。
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md — CQRS 设计
 * @see docs/adr/140-react-efficiency-architecture.md §D2
 */

import type { WorldModel } from "../graph/world-model.js";
import { isQueryAction } from "./action-types.js";
import { TELEGRAM_ACTION_MAP } from "./actions/index.js";

/**
 * Query 动作的最小接口 — 替代旧 RecordedAction。
 * ADR-214 Wave B: RecordedAction 已删除，使用结构化子集。
 */
interface QueryAction {
  fn: string;
}

/**
 * 从图属性中读取 Query 结果，格式化为 observation 文本，然后标记已消费。
 *
 * D2 语义标注：当 query 返回空/null/无效数据时，注入语义标注替代裸 [] 输出。
 * 让 LLM 知道"空"是有意义的信息——他们是新联系人、没有历史记录、或信息尚不存在。
 */
export function formatQueryObservations(
  G: WorldModel,
  queryActions: QueryAction[],
  actionTarget: string | null,
): string | null {
  const lines: string[] = [];
  const consumed: Array<{ nodeId: string; key: string }> = [];

  for (const action of queryActions) {
    const def = TELEGRAM_ACTION_MAP.get(action.fn);
    if (!def || !isQueryAction(def)) continue;

    const nodeId = def.resultSource === "target" ? actionTarget : "self";
    if (!nodeId || !G.has(nodeId)) {
      // D2: 节点不存在 → 语义标注（不 consume，因为没有数据可消费）
      lines.push(
        `(${action.fn}: no data available — this may be a new contact or first interaction)`,
      );
      continue;
    }

    const data = G.getDynamic(nodeId, def.resultAttrKey);
    if (data == null) {
      // D2: 数据为 null → 语义标注
      lines.push(`(${action.fn}: no data available — the information may not exist yet)`);
      continue;
    }

    const formatted = def.formatResult(data);
    if (!formatted || formatted.length === 0) {
      // D2: formatResult 返回空 → 语义标注
      lines.push(`(${action.fn}: returned empty results — no matching records found)`);
      continue;
    }

    lines.push(...formatted);
    consumed.push({ nodeId, key: def.resultAttrKey });
  }

  // 标记已消费 + 清除一次性结果
  for (const { nodeId, key } of consumed) {
    G.setDynamic(nodeId, `${key}_consumed`, -1); // 标记已在 CQRS 中消费
    if (key.startsWith("last_")) {
      G.setDynamic(nodeId, key, null);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

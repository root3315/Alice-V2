/**
 * ADR-172: 安全显示名解析 + 反向解析。
 *
 * safeDisplayName: nodeId → 人类可读名（永不返回 raw graph ID）。
 * resolveDisplayName: 人类可读名 → nodeId（safeDisplayName 的逆操作）。
 *
 * @see docs/adr/172-information-visibility-layer.md
 * @see docs/adr/204-consciousness-stream/ §3.10 C10
 */
import { readDisplayName, readTitle } from "./dynamic-props.js";
import type { WorldModel } from "./world-model.js";

/**
 * 解析实体的安全显示名。
 *
 * **永不返回 raw graph ID**。当 display_name 和 title 都不存在时，
 * 返回基于节点类型的泛称（如 "(someone)"、"(a group)"）。
 */
/**
 * ADR-204 C10: 将人类可读名（display_name）解析为 graph nodeId。
 *
 * safeDisplayName 的逆操作。LLM 只需提供人名，代码侧完成 → nodeId 映射。
 * 匹配规则：
 * 1. 已是 `contact:*` / `channel:*` 格式 → 验证存在后直接返回
 * 2. "self" / "alice" → 返回 "self"（特殊节点）
 * 3. 搜索 contact 节点的 display_name（大小写不敏感）
 * 4. 搜索 channel 节点的 display_name / title（大小写不敏感）
 * 5. 均未匹配 → null
 */
export function resolveDisplayName(G: WorldModel, displayName: string): string | null {
  // 1. 已是 nodeId 格式 → 验证存在
  if (displayName.startsWith("contact:") || displayName.startsWith("channel:")) {
    return G.has(displayName) ? displayName : null;
  }

  // 2. self / alice 特殊节点
  const lower = displayName.toLowerCase();
  if (lower === "self" || lower === "alice") {
    return G.has("self") ? "self" : null;
  }

  // 3. 搜索 contact 节点
  for (const nodeId of G.getEntitiesByType("contact")) {
    const dn = readDisplayName(G, nodeId);
    if (dn != null && dn.toLowerCase() === lower) {
      return nodeId;
    }
  }

  // 4. 搜索 channel 节点（display_name 或 title）
  for (const nodeId of G.getEntitiesByType("channel")) {
    const dn = readDisplayName(G, nodeId);
    if (dn != null && dn.toLowerCase() === lower) {
      return nodeId;
    }
    const title = readTitle(G, nodeId);
    if (title != null && title.toLowerCase() === lower) {
      return nodeId;
    }
  }

  return null;
}

export function safeDisplayName(G: WorldModel, nodeId: string): string {
  if (!G.has(nodeId)) return "(someone)";

  const displayName = readDisplayName(G, nodeId);
  if (displayName != null && displayName !== "") return displayName;

  const title = readTitle(G, nodeId);
  if (title != null && title !== "") return title;

  // 类型化泛称 — 永不泄漏 raw ID
  const nodeType = G.getNodeType(nodeId);
  switch (nodeType) {
    case "contact":
      return "(someone)";
    case "channel": {
      const chatType = G.getChannel(nodeId).chat_type;
      if (chatType === "channel") return "(a channel)";
      return chatType === "private" ? "(a private chat)" : "(a group)";
    }
    case "thread":
      return "(a thread)";
    default:
      return "(unknown)";
  }
}

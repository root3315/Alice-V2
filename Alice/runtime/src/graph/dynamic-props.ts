/**
 * 类型安全的 graph dynamic property 访问器。
 *
 * 遵循 ModStateRegistry 模式（core/types.ts）：
 * 单一受控 cast 点，所有调用站点零 `as`。
 *
 * getDynamic() 返回 unknown（逃生舱口）。本模块提供类型化读取，
 * 包含运行时类型守卫（typeof 检查），防止错误类型的数据静默传播。
 */

import type { ForwardRegistry } from "../engine/act/timeline.js";
import type { ChatType } from "./entities.js";
import { isChatType } from "./entity-defaults.js";
import type { WorldModel } from "./world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// 基础资料
// ═══════════════════════════════════════════════════════════════════════════

/** 读取节点 display_name。错误形状或未设置时返回 undefined。 */
export function readDisplayName(G: WorldModel, nodeId: string): string | undefined {
  if (!G.has(nodeId)) return undefined;
  const v = G.getDynamic(nodeId, "display_name");
  return typeof v === "string" ? v : undefined;
}

/** 读取节点 title。错误形状或未设置时返回 undefined。 */
export function readTitle(G: WorldModel, nodeId: string): string | undefined {
  if (!G.has(nodeId)) return undefined;
  const v = G.getDynamic(nodeId, "title");
  return typeof v === "string" ? v : undefined;
}

/** 优先 display_name，其次 title，最后回退到节点 ID。 */
export function readDisplayLabel(G: WorldModel, nodeId: string): string {
  return readDisplayName(G, nodeId) ?? readTitle(G, nodeId) ?? nodeId;
}

/** 读取 channel chat_type。错误形状或未设置时返回 undefined。 */
export function readChatType(G: WorldModel, nodeId: string): ChatType | undefined {
  if (!G.has(nodeId)) return undefined;
  const v = G.getDynamic(nodeId, "chat_type");
  return isChatType(v) ? v : undefined;
}

/** 联系人是否是 bot。错误形状或未设置时返回 false。 */
export function isBotContact(G: WorldModel, contactId: string): boolean {
  return G.has(contactId) && G.getDynamic(contactId, "is_bot") === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 社交接收度（ADR-156）
// ═══════════════════════════════════════════════════════════════════════════

/** 读取群组的社交接收度 ∈ [-1, 1]。未设置时返回 0。 */
export function readSocialReception(G: WorldModel, channelId: string): number {
  if (!G.has(channelId)) return 0;
  const v = G.getDynamic(channelId, "social_reception");
  return typeof v === "number" ? v : 0;
}

/** 读取社交接收度最后更新时间（epoch ms）。 */
export function readSocialReceptionMs(G: WorldModel, channelId: string): number {
  if (!G.has(channelId)) return 0;
  const v = G.getDynamic(channelId, "social_reception_ms");
  return typeof v === "number" ? v : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 转发记录（BT 反馈闭环）
// ═══════════════════════════════════════════════════════════════════════════

/** 读取频道的消息转发记录。 */
export function readForwardRegistry(G: WorldModel, channelId: string): ForwardRegistry {
  if (!G.has(channelId)) return {};
  const v = G.getDynamic(channelId, "forwarded_msgs");
  if (!isForwardRegistry(v)) return {};
  return v as ForwardRegistry;
}

function isForwardRegistry(value: unknown): value is ForwardRegistry {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (targets) => Array.isArray(targets) && targets.every((target) => typeof target === "string"),
  );
}

/** 记录一次转发：srcChannel 的 msgId 被转发到 targetName。 */
function writeForwardEntry(
  G: WorldModel,
  channelId: string,
  msgId: number,
  targetName: string,
): void {
  const registry = readForwardRegistry(G, channelId);
  const key = String(msgId);
  if (!registry[key]) registry[key] = [];
  if (!registry[key].includes(targetName)) registry[key].push(targetName);
  G.setDynamic(channelId, "forwarded_msgs", registry);
}

/** 记录一次跨聊天分享的完整事实：源消息、目标、以及两端最近分享时间。 */
export function recordForwardShare(
  G: WorldModel,
  params: {
    fromGraphId: string;
    msgId: number;
    toGraphId: string;
    targetName: string;
    nowMs?: number;
  },
): void {
  const nowMs = params.nowMs ?? Date.now();

  if (G.has(params.fromGraphId)) {
    G.setDynamic(params.fromGraphId, "last_shared_ms", nowMs);
    writeForwardEntry(G, params.fromGraphId, params.msgId, params.targetName);
  }
  if (G.has(params.toGraphId)) {
    G.setDynamic(params.toGraphId, "last_shared_ms", nowMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Block 检测
// ═══════════════════════════════════════════════════════════════════════════

/** 联系人是否拉黑了 Alice。 */
export function isBlockedByContact(G: WorldModel, contactId: string): boolean {
  return G.has(contactId) && G.getDynamic(contactId, "blocked_alice") === true;
}

/** 联系人是否拉黑了 Alice。read* 命名别名，便于调用侧统一读事实。 */
export const readBlockedByContact = isBlockedByContact;

// ═══════════════════════════════════════════════════════════════════════════
// 最近动作 / 分享
// ═══════════════════════════════════════════════════════════════════════════

/** 读取最近一次分享时间（epoch ms）。0 = 从未分享。 */
export function readLastSharedMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "last_shared_ms");
  return typeof v === "number" ? v : 0;
}

/** 读取 Alice 最近一次在该节点行动的时间（epoch ms）。0 = 从未行动。 */
export function readLastAliceActionMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "last_alice_action_ms");
  return typeof v === "number" ? v : 0;
}

/** 写入 Alice 最近一次在该节点行动的时间（epoch ms）。 */
export function writeLastAliceActionMs(G: WorldModel, nodeId: string, nowMs: number): void {
  if (!G.has(nodeId)) return;
  G.setDynamic(nodeId, "last_alice_action_ms", nowMs);
}

/** 读取最近一次对外发出的文本。错误形状或未设置时返回空字符串。 */
export function readLastOutgoingText(G: WorldModel, nodeId: string): string {
  if (!G.has(nodeId)) return "";
  const v = G.getDynamic(nodeId, "last_outgoing_text");
  return typeof v === "string" ? v : "";
}

/** 写入最近一次对外发出的文本，沿用现有 150 字符投影上限。 */
export function writeLastOutgoingText(G: WorldModel, nodeId: string, text: string): void {
  if (!G.has(nodeId)) return;
  G.setDynamic(nodeId, "last_outgoing_text", [...text].slice(0, 150).join(""));
}

/** 读取最近清空未读/提及状态的时间（epoch ms）。0 = 从未清空。 */
export function readRecentlyClearedMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "recently_cleared_ms");
  return typeof v === "number" ? v : 0;
}

/** 写入最近清空未读/提及状态的时间（epoch ms）。 */
export function writeRecentlyClearedMs(G: WorldModel, nodeId: string, nowMs: number): void {
  if (!G.has(nodeId)) return;
  G.setDynamic(nodeId, "recently_cleared_ms", nowMs);
}

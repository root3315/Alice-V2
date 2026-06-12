/**
 * ADR-220 + ADR-237: 声明式 User Prompt 管线 — 公共 API。
 */

export { renderUserPrompt } from "./renderers/index.js";
export type { SnapshotInput } from "./snapshot.js";
export { buildUserPromptSnapshot } from "./snapshot.js";
export type {
  ChannelClass,
  ChatTargetType,
  ContactProfileSlot,
  ContactSlot,
  EntityRef,
  FeedItemSlot,
  GroupSlot,
  JargonSlot,
  RecapSegment,
  ThreadSlot,
  UserPromptSnapshot,
} from "./types.js";
export { ChatTarget, toChannelClass } from "./types.js";

/**
 * ADR-220 + ADR-237: 场景渲染器路由。
 *
 * 根据 snapshot.chatTargetType 分派到对应的场景渲染器。
 * 每个渲染器是纯函数 (snapshot) → string。
 */

import type { UserPromptSnapshot } from "../types.js";
import { renderChannel } from "./channel.js";
import { renderGroup } from "./group.js";
import { renderPrivate } from "./private.js";

/**
 * 根据快照的场景类型选择渲染器，产出完整的 user prompt 文本。
 */
export function renderUserPrompt(snapshot: UserPromptSnapshot): string {
  switch (snapshot.chatTargetType) {
    case "channel_owned":
    case "channel_other":
      return renderChannel(snapshot);
    case "group":
      return renderGroup(snapshot);
    case "private_person":
    case "private_bot":
      return renderPrivate(snapshot);
  }

  return renderPrivate(snapshot);
}

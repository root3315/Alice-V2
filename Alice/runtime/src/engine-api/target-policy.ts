import { ensureChannelId, telegramChannelId } from "../graph/constants.js";
import type { TransportTargetRef } from "../platform/transport.js";

export const TARGET_NOT_WHITELISTED_CODE = "command_invalid_target";

export function targetAllowed(
  whitelist: ReadonlySet<string> | null | undefined,
  target: TransportTargetRef,
): boolean {
  if (!whitelist) return true;
  const channelTarget = ensureChannelId(target.stableId) ?? target.stableId;
  return whitelist.has(channelTarget);
}

export function telegramTargetAllowed(
  whitelist: ReadonlySet<string> | null | undefined,
  chatId: number,
): boolean {
  if (!whitelist) return true;
  return whitelist.has(telegramChannelId(chatId));
}

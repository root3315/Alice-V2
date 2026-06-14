/**
 * ADR-220 + ADR-237: Маршрутизация рендереров сцен.
 *
 * Диспетчеризует в соответствующий рендерер на основе snapshot.chatTargetType.
 * Каждый рендерер — чистая функция (snapshot) → string.
 */

import type { UserPromptSnapshot } from "../types.js";
import { renderChannel } from "./channel.js";
import { renderGroup } from "./group.js";
import { renderPrivate } from "./private.js";

/**
 * Выбирает рендерер по типу сцены снимка и возвращает полный текст user prompt.
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

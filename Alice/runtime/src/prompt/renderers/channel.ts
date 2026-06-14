/**
 * ADR-220 + ADR-237: Рендерер сцены канала.
 *
 * Канал — это сущность информационного потока: чтение + react + пересылка друзьям.
 * Отсутствуют: bot/awareness/feedback/threads/conversation state.
 *
 * Sections (по порядку):
 * 1. Время + настроение — LLM воспринимает текущий момент и эмоциональное состояние
 * 2. Цели пересылки — контакты (@id + интересы) + группы (@id + topic), ядро канала
 * 3. Поток сообщений (с msgId) — ядро канала, msgId используется для irc forward --ref
 * 4. Внутренний шёпот — whisper, полученный из facetId
 */

import type { UserPromptSnapshot } from "../types.js";
import {
  joinBlocks,
  listSectionBlock,
  rawBlock,
  renderLocalClock,
  sectionBlock,
  whisperBlock,
} from "./shared.js";

export function renderChannel(snapshot: UserPromptSnapshot): string {
  const isOwnedChannel = snapshot.chatTargetType === "channel_owned";
  const timeStr = renderLocalClock(snapshot.nowMs, snapshot.timezoneOffset);
  const ownedChannelsToShow = isOwnedChannel ? [] : snapshot.ownedChannels;

  const shareTargets = [
    ...snapshot.contacts.map((contact) => {
      const tierInfo = contact.topTrait
        ? `${contact.tierLabel}, ${contact.topTrait}`
        : contact.tierLabel;
      const parts: string[] = [`${contact.ref.displayName} @${contact.ref.id} (${tierInfo})`];
      if (contact.interests.length > 0) parts.push(`— ${contact.interests.join(", ")}`);
      if (contact.bio) parts.push(`[${contact.bio.slice(0, 60)}]`);
      if (contact.sharedRecently) parts.push("| shared recently");
      return parts.join(" ");
    }),
    ...snapshot.groups.map((group) => {
      const parts: string[] = [`[group] ${group.ref.displayName} @${group.ref.id}`];
      if (group.interests.length > 0) parts.push(`— ${group.interests.join(", ")}`);
      if (group.bio) parts.push(`— ${group.bio.slice(0, 60)}`);
      if (group.topic) parts.push(`(topic: ${group.topic})`);
      return parts.join(" ");
    }),
    ...ownedChannelsToShow.map((channel) => {
      const roleLabel = channel.role === "owner" ? "your channel" : "you admin";
      return `[channel] ${channel.ref.displayName} @${channel.ref.id} (${roleLabel})`;
    }),
  ];

  const urgentSignals = snapshot.situationSignals.filter(
    (signal) =>
      signal.includes("waiting") || signal.includes("lively") || signal.includes("directed"),
  );

  return joinBlocks([
    rawBlock(`${timeStr}.`),
    rawBlock(snapshot.emotionProjection),
    rawBlock(snapshot.emotionStyleHint),
    listSectionBlock("People you might share with", shareTargets),
    sectionBlock(
      isOwnedChannel
        ? "Recent posts (your channel, you can post here)"
        : "Recent posts (channel, you can read but not post)",
      snapshot.timeline.lines,
    ),
    listSectionBlock("Timing", snapshot.timingSignals ?? []),
    listSectionBlock("What's happening", urgentSignals),
    listSectionBlock(
      "From the web",
      snapshot.feedItems.map((item) => `${item.title}: ${item.snippet}`),
    ),
    whisperBlock(snapshot.whisper),
  ]);
}

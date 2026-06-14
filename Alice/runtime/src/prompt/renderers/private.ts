/**
 * ADR-220 + ADR-237: Рендерер сцены приватного чата.
 *
 * Приватный чат — диалог один на один: все сообщения адресованы тебе.
 * Социальная панорама отсутствует (это дело канала).
 *
 * Sections (по порядку):
 * 1. Время + настроение + собеседник — LLM воспринимает «с кем разговаривает» и отношения
 * 2. Защита от повторов — что Alice недавно говорила
 * 3. Поток сообщений — последние сообщения
 * 4. Состояние диалога — ожидание ответа? несколько сообщений подряд?
 * 5. Треды — активные темы
 * 6. Обратная связь по действиям — результаты предыдущего раунда
 * 7. Внутренний шёпот — whisper, полученный из facet
 */

import type { UserPromptSnapshot } from "../types.js";
import {
  conversationStateBlock,
  feedbackBlocks,
  joinBlocks,
  listSectionBlock,
  openTopicsBlock,
  rawBlock,
  recapBlock,
  renderLocalClock,
  sectionBlock,
  whisperBlock,
} from "./shared.js";

export function renderPrivate(snapshot: UserPromptSnapshot): string {
  const isBot = snapshot.chatTargetType === "private_bot";
  const timeStr = renderLocalClock(snapshot.nowMs, snapshot.timezoneOffset);

  const introBlock = (() => {
    if (isBot) {
      const targetLabel = snapshot.target
        ? `Interacting with ${snapshot.target.displayName} (bot)`
        : "Interacting with a bot";
      return rawBlock(`${timeStr}. ${targetLabel}.`);
    }

    const targetLabel = snapshot.target
      ? `Talking to ${snapshot.target.displayName}`
      : "In a private chat";
    const relPart = snapshot.relationshipDesc ? ` (${snapshot.relationshipDesc})` : "";
    const moodPart = snapshot.contactMood ? ` They seem ${snapshot.contactMood}.` : "";
    const profileLine = (() => {
      if (!snapshot.contactProfile) return undefined;
      const parts: string[] = [];
      if (snapshot.contactProfile.portrait) parts.push(snapshot.contactProfile.portrait);
      if (snapshot.contactProfile.bio) {
        parts.push(`Bio: ${snapshot.contactProfile.bio.slice(0, 80)}`);
      }
      if (snapshot.contactProfile.traits.length > 0) {
        parts.push(`Traits: ${snapshot.contactProfile.traits.join(", ")}`);
      }
      if (snapshot.contactProfile.interests.length > 0) {
        parts.push(`Interests: ${snapshot.contactProfile.interests.join(", ")}`);
      }
      return parts.length > 0 ? `${parts.join(". ")}.` : undefined;
    })();

    return rawBlock(`${timeStr}. ${targetLabel}${relPart}.${moodPart}`, profileLine);
  })();

  return joinBlocks([
    introBlock,
    rawBlock(snapshot.emotionProjection),
    rawBlock(snapshot.emotionStyleHint),
    rawBlock(snapshot.roundHint, snapshot.episodeHint),
    conversationStateBlock(snapshot.presence),
    sectionBlock("Recent activity (private chat — all directed at you)", snapshot.timeline.lines),
    sectionBlock("Social cases", snapshot.socialCaseLines),
    openTopicsBlock(snapshot.threads),
    ...feedbackBlocks(snapshot.feedback),
    recapBlock(snapshot.conversationRecap),
    listSectionBlock("Timing", snapshot.timingSignals ?? []),
    listSectionBlock("What's happening", snapshot.situationSignals),
    listSectionBlock("Scheduled", snapshot.scheduledEvents),
    listSectionBlock("Caution", snapshot.riskFlags),
    rawBlock(snapshot.episodeCarryOver),
    rawBlock(
      snapshot.isDegraded
        ? "Running low — maybe one concrete thing still stands out. If not, quiet is fine."
        : undefined,
    ),
    rawBlock(snapshot.openTopic ? `You were talking about: ${snapshot.openTopic}.` : undefined),
    whisperBlock(snapshot.whisper, snapshot.presence),
  ]);
}

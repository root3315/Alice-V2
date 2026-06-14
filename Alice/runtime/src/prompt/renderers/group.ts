/**
 * ADR-220: Рендерер сцены группового чата.
 *
 * Группа — это социальный диалог; молчание — норма (правило 90-9-1).
 * Социальная панорама отсутствует (это дело канала).
 *
 * Sections (по порядку):
 * 1. Время + настроение + информация о группе — LLM воспринимает среду группы
 * 2. Защита от повторов — что Alice недавно говорила, чтобы не повторяться
 * 3. Поток сообщений — последние сообщения
 * 4. Состояние диалога — ожидание ответа? несколько сообщений подряд?
 * 5. Треды — активные темы (LLM нужен threadId для вызова topic_advance)
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

export function renderGroup(snapshot: UserPromptSnapshot): string {
  const timeStr = renderLocalClock(snapshot.nowMs, snapshot.timezoneOffset);
  const metaParts = ["group", snapshot.groupMeta?.membersInfo].filter(
    (part): part is string => part != null && part.length > 0,
  );
  const targetLabel = snapshot.target
    ? `Talking in ${snapshot.target.displayName}`
    : "In a group chat";

  const socialReceptionLine =
    snapshot.socialReception != null && snapshot.socialReception < -0.2
      ? snapshot.socialReception < -0.5
        ? "Someone was annoyed at your recent messages here. Stay back unless directly asked."
        : "Your recent messages here didn't get much response. Be selective about when you speak."
      : undefined;

  return joinBlocks([
    rawBlock(
      `${timeStr}. ${targetLabel} (${metaParts.join(", ")}).`,
      snapshot.groupMeta?.bio ? `About: ${snapshot.groupMeta.bio.slice(0, 100)}` : undefined,
      snapshot.groupMeta?.restrictions,
    ),
    rawBlock(snapshot.emotionProjection),
    rawBlock(snapshot.emotionStyleHint),
    rawBlock(snapshot.roundHint, snapshot.episodeHint),
    conversationStateBlock(snapshot.presence),
    sectionBlock("Recent activity", snapshot.timeline.lines),
    sectionBlock("Social cases", snapshot.socialCaseLines),
    rawBlock(
      snapshot.groupMeta?.directed ? "Someone directed a message at you." : undefined,
      snapshot.groupMeta?.topic ? `Current topic: ${snapshot.groupMeta.topic}` : undefined,
    ),
    openTopicsBlock(snapshot.threads),
    ...feedbackBlocks(snapshot.feedback),
    recapBlock(snapshot.conversationRecap),
    listSectionBlock(
      "Local slang",
      snapshot.jargon.map((jargon) => `"${jargon.term}" = ${jargon.meaning}`),
    ),
    listSectionBlock("Timing", snapshot.timingSignals ?? []),
    listSectionBlock("What's happening", snapshot.situationSignals),
    listSectionBlock("Scheduled", snapshot.scheduledEvents),
    listSectionBlock("Caution", snapshot.riskFlags),
    rawBlock(socialReceptionLine),
    rawBlock(snapshot.episodeCarryOver),
    rawBlock(
      snapshot.isDegraded
        ? "Running low — choose one concrete thing to notice, or stay quiet if nothing matters."
        : undefined,
    ),
    rawBlock(snapshot.openTopic ? `You were talking about: ${snapshot.openTopic}.` : undefined),
    whisperBlock(snapshot.whisper, snapshot.presence),
  ]);
}

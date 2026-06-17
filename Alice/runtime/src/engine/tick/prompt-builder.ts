/**
 * Построитель Blackboard Tick Prompt — сборка LLM prompt из состояния Blackboard.
 *
 * - Shell Manual: реальное пространство команд + engine bridge
 * - Shell Manual: плоское отображение реальных сигнатур команд; подробный синтаксис через `<command> --help`
 * - Повторное использование листовых функций: resolveTarget, timeline
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠ Принцип честности PROMPT (ADR-209)
 *
 * Alice не знает о существовании движка. Она просто человек. Каждая строка содержимого prompt обязана удовлетворять одному из условий:
 *   □ является наблюдаемым фактом реального мира ("Rin написала сообщение 10 минут назад")
 *   □ является семантическим ярлыком, понятным человеку ("ты в последнее время немного холодна")
 *   □ является контекстной подсказкой, а не инструкцией ("в группе кто-то спорит", не "не вмешивайся")
 *
 * Категорически запрещено:
 *   ✗ раскрывать системные термины (tick, voice, pressure, mod, stage, step)
 *   ✗ раскрывать сырые числа (проценты, счётчики, ID) — обязательно использовать семантические ярлыки
 *   ✗ объяснять "почему" система устроена именно так (LLM заботит только явление, не причина)
 *   ✗ давать мета-инструкции ("Decide what to do." / "Make your decision now.")
 *   ✗ использовать "Your instinct:" (системный префикс-ярлык)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * @see docs/adr/142-action-space-architecture/README.md
 * @see docs/adr/163-expand-instruction-bt-native-disclosure.md §17
 * @see docs/adr/209-tui-native-prompt.md — принцип честности
 */

import { CAPABILITY_FAMILIES } from "../../core/capability-families.js";
import type { Dispatcher } from "../../core/dispatcher.js";
import { enforcePromptStyle } from "../../core/prompt-style.js";
import { generateShellManual } from "../../core/shell-manual.js";
import { estimateTokens, renderContributionsByZone } from "../../core/storyteller.js";
import type { ContributionItem, ModDefinition } from "../../core/types.js";
import { applyVisibilityFilter, buildAudienceContext } from "../../core/visibility.js";
import { findActiveConversation } from "../../graph/queries.js";
import type { WorldModel } from "../../graph/world-model.js";
import { getInjectableFeedItems } from "../../mods/feeds.mod.js";
import { buildUserPromptSnapshot, ChatTarget, renderUserPrompt } from "../../prompt/index.js";
import { replaceSocialCaseWritebackContextVars } from "../../social-case/context.js";
import { buildSocialCasePromptSurface } from "../../social-case/prompt.js";
import { createLogger } from "../../utils/logger.js";
import { humanDuration } from "../../utils/time-format.js";
import { getFacetTags, getFacetWhisper } from "../../voices/palette.js";
import type { MessageRecord } from "../act/messages.js";
import { computeChannelPresence } from "../act/presence.js";
import { GLOBAL_TOKEN_BUDGET } from "../act/prompt-budget.js";
import { buildShellGuide } from "../act/shell-guide.js";
import type { ActionQueueItem } from "../action-queue.js";
import { resolveTarget } from "./target.js";
import type { Blackboard, FeatureFlags, UnifiedTool } from "./types.js";

const log = createLogger("tick/prompt");

const FEEDBACK_CONTRIBUTION_KEYS = new Set(["last-action-recap", "outcome-history"]);

function feedbackEntriesFromContributions(items: readonly ContributionItem[]): string[] {
  return items
    .filter(
      (item) => item.bucket === "section" && item.key && FEEDBACK_CONTRIBUTION_KEYS.has(item.key),
    )
    .flatMap((item) => item.lines.map((line) => String(line)))
    .filter((line) => line.length > 0)
    .slice(0, 8);
}

// ═══════════════════════════════════════════════════════════════════════════
// Типы
// ═══════════════════════════════════════════════════════════════════════════

/** Минимальный контекст, необходимый построителю prompt (внедрение зависимостей, не использует ActContext напрямую). */
export interface TickPromptContext {
  G: WorldModel;
  dispatcher: Dispatcher;
  mods: readonly ModDefinition[];
  config: {
    budgetZones?: Record<string, number>;
    ttsBaseUrl?: string;
    ttsApiKey?: string;
    exaApiKey?: string;
    musicApiBaseUrl?: string;
    timezoneOffset: number;
    peripheral: {
      perChannelCap: number;
      totalCap: number;
      minTextLength: number;
    };
  };
  item: ActionQueueItem;
  tick: number;
  messages: MessageRecord[];
  observations: string[];
  round: number;
  /** Количество продолжений block внутри episode (дополнительные раунды, инициированные хостом, например локальный follow-up / самокоррекция). 0 = первый раунд. */
  episodeRound?: number;
  /** Переопределение времени по стенным часам (мс). При отсутствии используется Date.now(). Для eval используется фиксированная временная метка, чтобы устранить дрейф времени. */
  nowMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy Category Summary — обратная совместимость: генерация сводки категорий из affordance инструментов
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Генерирует сводку категорий из метаданных affordance contextual-инструментов.
 * После ADR-223 этот guide больше не вставляется в обычный prompt; shell manual плоско показывает все видимые команды.
 * Функция сохранена для совместимости со старыми тестами/экспериментальными точками входа; текст унифицирован с отсылкой к `<command> --help`.
 *
 * Инструменты always не нужно включать (всегда видимы), on-demand не активируются через needs.
 * Рендерится только category + whenToUse для contextual-инструментов.
 *
 * Фильтр hardgate: если указанный в requires FeatureFlag равен false,
 * инструмент не попадает в guide — чтобы не вводить модель в заблуждение, предлагая недоступные categories.
 */
export function buildCapabilityGuide(
  allTools: readonly UnifiedTool[],
  features?: Readonly<FeatureFlags>,
): string {
  // ADR-196 F9: отслеживаем только наличие category (имена функций больше не рендерятся, дедупликация с .d.ts)
  const categories = new Set<string>();
  // Из per-tool affordance собираем whenToUse / whenNotToUse как fallback для семейства App
  const toolWhenToUse = new Map<string, string>();
  const toolWhenNotToUse = new Map<string, string>();

  for (const tool of allTools) {
    const { affordance } = tool;
    if (affordance.priority !== "capability") continue;

    // hardgate: указанная в requires feature обязана быть true, иначе пропускаем
    if (features && affordance.requires && !features[affordance.requires]) continue;

    if (!categories.has(affordance.category)) {
      categories.add(affordance.category);
      // whenToUse/whenNotToUse первого инструмента используются как fallback (семейство App не имеет записи в CAPABILITY_FAMILIES)
      toolWhenToUse.set(affordance.category, affordance.whenToUse);
      if (affordance.whenNotToUse) {
        toolWhenNotToUse.set(affordance.category, affordance.whenNotToUse);
      }
    }
  }

  if (categories.size === 0) return "";

  const lines: string[] = [
    "## Command Categories",
    "",
    "Run `<command> --help` for usage details.",
    "",
  ];

  for (const category of categories) {
    // Реестр семейств является единственным источником истины для whenToUse; семейство App деградирует до per-tool affordance
    const family = CAPABILITY_FAMILIES[category as import("../tick/types.js").ToolCategory];
    const whenToUse = family?.whenToUse ?? toolWhenToUse.get(category) ?? category;
    const whenNotToUse = toolWhenNotToUse.get(category);
    if (whenNotToUse) {
      lines.push(`- "${category}": ${whenToUse} (not for: ${whenNotToUse})`);
    } else {
      lines.push(`- "${category}": ${whenToUse}`);
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// buildTickPrompt — сборка основного prompt
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Построение LLM prompt из состояния Blackboard + отфильтрованных инструментов.
 *
 * system = manual + scriptGuide + capabilityGuide + mod contributions
 * user = contextVars + timeline + observations + footer
 *
 * @see docs/adr/142-action-space-architecture/README.md
 */
export async function buildTickPrompt(
  board: Blackboard,
  ctx: TickPromptContext,
): Promise<{ system: string; user: string }> {
  const { G, dispatcher, config, item, tick, messages, observations, round, episodeRound } = ctx;

  const chatType =
    item.target && G.has(item.target) ? G.getChannel(item.target).chat_type : "private";
  const isGroup = ChatTarget.isGroupChat(chatType);
  // ADR-206: канал — это медийная сущность, третий путь рендеринга, независимый от group и private
  const isChannel = ChatTarget.isChannelChat(chatType);

  // ── ADR-220: сначала строим snapshot (единственный источник истины для флагов сценария) ──
  const nowMs = ctx.nowMs ?? Date.now();

  // Стратегия C: предварительный сбор mod state (для профилей контактов, жаргона группы)
  const relState = dispatcher.readModState<{
    contactProfiles?: Record<
      string,
      {
        portrait?: string;
        traits?: Record<string, { value: number }>;
        crystallizedInterests?: Record<string, { label: string; confidence: number }>;
        interests?: string[];
      }
    >;
  }>("relationships");
  const learnState = dispatcher.readModState<{
    jargon?: Record<string, Record<string, { term: string; meaning: string }>>;
  }>("learning");

  // Извлекаем жаргон для текущего target
  const targetJargon: Array<{ term: string; meaning: string }> = [];
  if (learnState?.jargon && item.target) {
    const groupJargon = learnState.jargon[item.target];
    if (groupJargon) {
      for (const entry of Object.values(groupJargon)) {
        targetJargon.push({ term: entry.term, meaning: entry.meaning });
      }
    }
  }

  const rawContributions = dispatcher.collectContributions();
  const feedbackEntries = feedbackEntriesFromContributions(rawContributions);
  let socialCaseLines: string[] = [];
  try {
    const socialCaseSurface = buildSocialCasePromptSurface({
      G,
      target: item.target ?? null,
      chatType,
    });
    socialCaseLines = socialCaseSurface.lines;
    replaceSocialCaseWritebackContextVars(
      board.contextVars as Record<string, unknown>,
      socialCaseSurface.contextVars,
    );
  } catch (error) {
    log.warn("Social case prompt replay failed", error);
  }

  // Строим snapshot (внутри определяются флаги isBot, isOwnedChannel и т.п.)
  const snapshot = buildUserPromptSnapshot({
    G,
    messages,
    observations,
    item,
    round,
    episodeRound,
    board: { maxSteps: board.budget.maxSteps, contextVars: board.contextVars },
    nowMs,
    timezoneOffset: config.timezoneOffset,
    chatType,
    isGroup,
    isChannel,
    contactProfiles: relState?.contactProfiles,
    jargonEntries: targetJargon.length > 0 ? targetJargon : undefined,
    feedItems: isChannel ? getInjectableFeedItems() : undefined,
    feedbackEntries,
    socialCaseLines,
    peripheralConfig:
      !isGroup && !isChannel
        ? {
            perChannelCap: config.peripheral.perChannelCap,
            totalCap: config.peripheral.totalCap,
            minTextLength: config.peripheral.minTextLength,
          }
        : undefined,
  });

  // ── Читаем тип сценария из snapshot (единственный источник истины) ──
  const scriptGuide = buildShellGuide({
    chatTargetType: snapshot.chatTargetType,
    facetTags: getFacetTags(item.facetId),
    hasBots: board.features.hasBots,
    // Рабочий/ops-канал (OPS_CHANNEL_ID, тот же id что incident-детекция в events.ts). Включает
    // work-инстинкт «отвечать когда обращаются, не вбрасывать тёплое в пустоту».
    isOpsChannel: !!process.env.OPS_CHANNEL_ID && item.target === process.env.OPS_CHANNEL_ID,
  });

  // ── Руководство по инструментам ──
  const manual = await generateShellManual(dispatcher.mods);
  // ADR-223: плоская видимость инструментов — category guide удалён из обычного prompt.
  // 56 инструментов × CLI-сигнатура ≈ 4000 token, укладывается в бюджет 12K.
  // Все сигнатуры инструментов плоско представлены через Command Catalog + shell manual.
  // Трёхуровневое свёртывание (core/capability/on-demand) ради экономии 2000 token приводило к постоянному сокрытию ключевых инструментов типа search.
  // Claude Tool Search решает проблему 500+ JSON schema инструментов (~1000 token каждый);
  // Alice использует CLI-сигнатуры (~70 token каждая), 56 инструментов полностью = всего 4000 token, поиск не нужен.

  // ── Бюджет с учётом зон ──
  const footerText = buildActionFooter(G, item, tick, messages, ctx.nowMs);
  let conversationFixedTokens =
    estimateTokens(scriptGuide) + estimateTokens(manual) + estimateTokens(footerText);
  // ADR-223: capGuide removed — tokens reclaimed for flat tool visibility
  if (messages.length > 0) {
    for (const msg of messages) {
      const hasMedia = msg.segments?.some((s) => s.kind === "media" || s.kind === "image");
      const budget = hasMedia ? 500 : 200;
      const preview = msg.text.length > budget ? msg.text.slice(0, budget) : msg.text;
      conversationFixedTokens += estimateTokens(
        `  [00:00] ${msg.senderName} (${msg.id}): ${preview}`,
      );
    }
  }

  // ADR-172: Contribute → Rank → 【Filter】 → Trim → Inject
  // ADR-220: собираем только bucket header (для system prompt).
  // User prompt полностью генерируется новым ECS-конвейером, bucket section/footer больше не нужны.
  const headerOnly = rawContributions.filter((c) => c.bucket === "header");
  const audience = buildAudienceContext(G, item.target ?? null, chatType);
  const contributions = applyVisibilityFilter(headerOnly, audience, G);
  const { system: renderedSystem, zoneStats } = renderContributionsByZone(
    contributions,
    GLOBAL_TOKEN_BUDGET,
    config.budgetZones,
    conversationFixedTokens,
  );
  log.debug("Zone budget utilization", zoneStats);

  // ── Сборка system prompt ──
  // manual + scriptGuide + capabilityGuide + mod contributions
  // ADR-223: capGuide removed — all tools visible in shell manual
  const systemParts = [renderedSystem, manual, scriptGuide];
  const system = systemParts.join("\n\n");

  // ── Рендеринг user prompt из snapshot ──
  const user = renderUserPrompt(snapshot);

  // ADR-141: страховочная сеть
  // System prompt почти полностью состоит из внутренне генерируемого текста — нарушения логируются как warn.
  enforcePromptStyle(system, "system-prompt-tick");
  // User prompt включает внешнее содержимое: исходные Telegram-сообщения, историю и т.п.
  // Эти тексты могут естественно содержать Markdown / заголовки / отступы — не стоит многократно предупреждать о них в production-логах.
  // Форматная безопасность user prompt обеспечивается главным образом через PromptBuilder + точечные тесты;
  // в runtime здесь оставлен только debug-уровень аудита, чтобы не засорять PM2-логи шумом.
  enforcePromptStyle(user, "user-prompt-tick", { violationLogLevel: "debug" });

  return { system, user };
}

// ═══════════════════════════════════════════════════════════════════════════
// Нижняя часть действия — перенесена из act/prompt.ts
// ═══════════════════════════════════════════════════════════════════════════

// ADR-174: статическая константа VOICE_WHISPER удалена, whisper теперь получается динамически из Persona Facet.
// @see docs/adr/174-persona-facets.md

/**
 * ADR-174: получение голосового шёпота из facet.
 *
 * Если facetId присутствует — получаем контекстуальный whisper из palette;
 * fallback — имя голоса (для совместимости с кодовыми путями без facet).
 */
export function resolveWhisper(voice: string, isGroup: boolean, facetId?: string | null): string {
  return getFacetWhisper(facetId, voice, isGroup);
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Построение нижней части подсказки действия — внутренний шёпот без раскрытия системных концепций.
 *
 * ADR-152: в групповых чатах используется шёпот-вопрос в стиле Disco Elysium, побуждающий LLM сначала оценить ситуацию, затем действовать.
 * В приватных чатах сохраняется констатация ситуативных фактов.
 *
 * Принцип честности (ADR-209 F1):
 * - не использовать "Your instinct:" (системный ярлык)
 * - не использовать "Decide what to do." (мета-инструкция)
 * - whisper сам по себе является очеловеченным внутренним монологом и используется напрямую
 */
export function buildActionFooter(
  G: WorldModel,
  item: ActionQueueItem,
  _tick: number,
  messages?: readonly MessageRecord[],
  nowMs?: number,
): string {
  const target = item.target;

  // Определяем групповой/приватный чат по графу
  const chatType = target && G.has(target) ? G.getChannel(target).chat_type : "private";
  const isGroup = ChatTarget.isGroupChat(chatType);

  const feeling = resolveWhisper(item.action, isGroup, item.facetId);

  if (!target) {
    return capitalizeFirst(feeling);
  }

  const resolved = resolveTarget(G, target);

  // Поиск открытого thread
  let openThread = "";
  const convId =
    resolved.channelId && G.has(resolved.channelId)
      ? findActiveConversation(G, resolved.channelId)
      : null;
  if (convId && G.has(convId)) {
    const topic = G.getConversation(convId).topic;
    if (topic) openThread = topic;
  }

  // ADR-70 P3: описание отношений уже предоставляется через relationships.mod contribute(), здесь не дублируем.
  const parts: string[] = [];
  parts.push(capitalizeFirst(feeling));

  // Layer 3: расширение состояния диалога (RC1 защита от повторов) — напоминание об уже отправленных сообщениях после instinct
  if (messages && messages.length > 0) {
    const now = nowMs ?? Date.now();
    const presence = computeChannelPresence(messages);
    if (presence.trailingYours >= 1) {
      let lastOutgoing: MessageRecord | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isOutgoing) {
          lastOutgoing = messages[i];
          break;
        }
      }
      if (lastOutgoing) {
        const agoS = (now - lastOutgoing.date.getTime()) / 1000;
        const agoLabel = humanDuration(agoS);
        parts.push(`Already sent a message ~${agoLabel} — still waiting for their reply.`);
      }
    }
  }

  if (openThread) parts.push(`You were talking about: ${openThread}.`);
  // Статья L5: Degraded Action — ограничение вывода LLM коротким ответом при слишком высоких социальных издержках
  // @see paper/ Definition 10: L5 "Degraded Action"
  if (item.reason?.includes("degraded_action")) {
    parts.push("Running low — a reaction or a short line is enough.");
  }
  return parts.join("\n");
}

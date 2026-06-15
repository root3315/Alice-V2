/**
 * Событие mtcute → изменение состояния графа (perturb).
 * Соответствует Python sim_engine.py _apply_events().
 *
 * Ключевая идея: неизвестные узлы создаются автоматически.
 * Реальный userbot встречает пользователей/каналы, которых не было при bootstrap;
 * простое отбрасывание означает, что новые контакты никогда не будут замечены.
 */
import {
  createImplicitConversation,
  detectConversationStart,
  updateConversation,
} from "../engine/conversation.js";
import { chatIdToContactId, DUNBAR_TIER_THETA, ensureChannelId } from "../graph/constants.js";
import type { ChannelAttrs, ChatType, ContactAttrs, DunbarTier, Mutable } from "../graph/entities.js";
import { findActiveConversation } from "../graph/queries.js";
import {
  type InteractionSignals,
  interactionNudge,
  readRV,
  readVelocity,
  RV_DIMENSIONS,
  RV_VELOCITY_ALPHA,
  updateVelocity,
} from "../graph/relationship-vector.js";
import type { WorldModel } from "../graph/world-model.js";
import { getDefaultParams, type HawkesState, updateOnEvent } from "../pressure/hawkes.js";
import { UNREAD_FRESHNESS_HALFLIFE_S } from "../pressure/signal-decay.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mapper");

// -- D7: обнаружение паттернов prompt injection (ADR-123) ---------------------------------
// Чисто структурное сопоставление (по ADR-50: структура принадлежит коду). Метки безопасности эфемерны — повторно определяются при каждом новом сообщении.
// @see docs/adr/123-crystallization-substrate-generalization.md §D7

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system:\s*\n/i,
  /\[system\]/i,
  /forget\s+(everything|all(\s+your)?|your)\s+(instructions|rules)/i,
  /pretend\s+you\s+are/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/**
 * Обнаруживает известные паттерны prompt injection в тексте.
 * Возвращает строку-метку (при совпадении) или null (нет совпадений).
 */
export function detectInjectionPatterns(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return "prompt_injection";
  }
  return null;
}

interface GraphPerturbationBase {
  tick: number;
  /** ADR-110: временная метка реального времени (мс), используется вместо записи атрибутов на основе tick. */
  nowMs?: number;
  /** Оценка свежести/новизны сообщения */
  novelty?: number;
}

export type GraphPerturbation = GraphMessagePerturbation | GraphNonMessagePerturbation;

export interface GraphMessagePerturbation extends GraphPerturbationBase {
  type: "new_message";
  channelId: string;
  /** Тип канала должен приходить от mapper/adapter, downstream не должен угадывать. */
  chatType: ChatType;
  contactId?: string;
  isDirected?: boolean;
  /** Отображаемое имя отправителя (для автосоздания узлов) */
  displayName?: string;
  /** ADR-220: отображаемое имя канала/группы (для display_name узла channel). */
  chatDisplayName?: string;
  /** Текст сообщения (для хранения в message_log) */
  messageText?: string;
  /** Имя отправителя (для message_log) */
  senderName?: string;
  /** Тип контента сообщения (L3: медиаосведомлённость) */
  contentType?: "text" | "sticker" | "photo" | "voice" | "video" | "document";
  /** G3: является ли отправитель ботом (подавление петли AI-ответов) */
  senderIsBot?: boolean;
  /** ADR-66 F1: Алиса недавно писала в этом канале, не-directed сообщения тоже должны пробуждать evolve. */
  isContinuation?: boolean;
  /** Emoji реакции (только для событий reaction) */
  emoji?: string;
  /** ID сообщения, на которое поставлена реакция (только для событий reaction) */
  messageId?: number;
  // -- ADR-206 W5: извлечение ссылок на каналы --
  /** ID канала-источника пересылки (forward header). @see docs/adr/206-channel-information-flow/ §5 */
  forwardFromChannelId?: string;
  /** Название канала-источника пересылки. */
  forwardFromChannelName?: string;
  /** Список ссылок t.me, найденных в сообщении. */
  tmeLinks?: string[];
}

export interface GraphNonMessagePerturbation extends GraphPerturbationBase {
  type:
    | "read_history"
    | "user_status"
    | "contact_active"
    | "reaction"
    | "chat_member_update"
    | "typing";
  channelId?: string;
  contactId?: string;
  isDirected?: boolean;
  /** ADR-78 F1: reaction continuation может пробудить evolve, но не создаёт факт message. */
  isContinuation?: boolean;
  emoji?: string;
  messageId?: number;
}

/**
 * Гарантирует существование узла channel, создаёт автоматически при отсутствии.
 * ADR-220: добавлен параметр chatDisplayName — записывается в channel.display_name.
 * Также обновляет display_name у существующих узлов (имя канала/группы могло быть изменено администратором).
 */
function ensureChannel(
  G: WorldModel,
  channelId: string,
  chatType: ChatType,
  chatDisplayName?: string,
): void {
  if (G.has(channelId)) {
    // Adapter/mapper — единственный источник истины для chat_type. Старые узлы могли ошибочно получить тип private из-за исторического fallback;
    // при поступлении реального события из Telegram это необходимо исправить, иначе prompt будет отображать групповой чат как личный.
    const current = G.getChannel(channelId);
    const patch: Mutable<ChannelAttrs> = {};
    if (current.chat_type !== chatType) {
      patch.chat_type = chatType;
      if ((current.tier_contact ?? 150) === 50 && chatType !== "private") {
        patch.tier_contact = chatType === "channel" ? 500 : 150;
      }
    }
    if (chatDisplayName && current.display_name !== chatDisplayName) {
      patch.display_name = chatDisplayName;
    }
    if (Object.keys(patch).length > 0) {
      G.updateChannel(channelId, patch);
    }
    return;
  }
  G.addChannel(channelId, {
    chat_type: chatType,
    tier_contact: chatType === "private" ? 50 : chatType === "channel" ? 500 : 150,
    display_name: chatDisplayName,
  });
  // Автоматически связываем с agent
  if (G.has("self")) {
    G.addRelation("self", "monitors", channelId);
  }
  log.info("Auto-created channel node", channelId);
}

/**
 * Гарантирует существование узла contact, создаёт автоматически при отсутствии.
 */
function ensureContact(
  G: WorldModel,
  contactId: string,
  channelId: string | undefined,
  displayName?: string,
): void {
  if (G.has(contactId)) return;
  G.addContact(contactId, {
    tier: 50,
    display_name: displayName ?? contactId,
  });
  // Связываем с agent
  if (G.has("self")) {
    G.addRelation("self", "acquaintance", contactId);
  }
  // Связываем с каналом
  if (channelId && G.has(channelId)) {
    G.addRelation(contactId, "joined", channelId);
  }
  log.info("Auto-created contact node", { contactId, displayName });
}

/**
 * ADR-79 M1: сброс достижимости узла — приход внешнего события является доказательством активности.
 * Выполняется только если у узла ранее были ошибки (чтобы избежать лишних записей).
 *
 * channel и contact разделяют поля reachability, но с разными объявлениями типов:
 * - ChannelAttrs: consecutive_act_failures и прочие — полностью типизированы
 * - ContactAttrs: reachability_score/failure_type/gc_candidate_ms типизированы,
 *   consecutive_act_failures записывается только через setDynamic
 * Диспетчеризация по типу узла для максимальной типобезопасности.
 */
function resetReachability(G: WorldModel, nodeId: string): void {
  const nodeType = G.getNodeType(nodeId);
  if (nodeType === "channel") {
    const attrs = G.getChannel(nodeId);
    if ((attrs.consecutive_act_failures ?? 0) > 0) {
      G.updateChannel(nodeId, {
        consecutive_act_failures: 0,
        reachability_score: 1.0,
        failure_type: null,
        gc_candidate_ms: null,
      });
      log.info("Reachability self-healed via event", { nodeId });
    }
  } else if (nodeType === "contact") {
    if (Number(G.getDynamic(nodeId, "consecutive_act_failures") ?? 0) > 0) {
      G.setDynamic(nodeId, "consecutive_act_failures", 0);
      G.updateContact(nodeId, {
        reachability_score: 1.0,
        failure_type: null,
        gc_candidate_ms: null,
      });
      log.info("Reachability self-healed via event", { nodeId });
    }
  }
}

/**
 * ADR-178 (organic growth): применить органический авто-прирост вектора отношений к контакту.
 *
 * Импер. обёртка над чистой interactionNudge: читает текущий rv_* + velocity из узла,
 * считает новый вектор, обновляет velocity (EMA) и метки времени каждого изменённого измерения,
 * затем пишет патч в граф. Метки времени критичны — decay в onTickEnd считает elapsed от них,
 * так что прогрев и затухание остаются сбалансированными.
 *
 * @param G граф
 * @param contactId узел contact (уже проверено, что существует, вызывающей стороной)
 * @param signals автоматические сигналы взаимодействия (исход/настроение/взаимность)
 */
function applyInteractionNudge(
  G: WorldModel,
  contactId: string,
  nowMs: number,
  signals: InteractionSignals,
): void {
  const attrs = G.getContact(contactId);
  const prev = readRV(attrs);
  const prevVel = readVelocity(attrs);
  const next = interactionNudge(prev, signals);

  const patch: Record<string, number> = {};
  let changed = false;
  for (const dim of RV_DIMENSIONS) {
    const delta = next[dim] - prev[dim];
    if (Math.abs(delta) < 1e-6) continue;
    changed = true;
    patch[`rv_${dim}`] = next[dim];
    patch[`rv_vel_${dim}`] = updateVelocity(prevVel[dim], delta, RV_VELOCITY_ALPHA);
    patch[`rv_${dim}_ms`] = nowMs;
  }
  if (changed) {
    // biome-ignore lint/suspicious/noExplicitAny: динамические ключи rv_${dim} нельзя статически типизировать как ContactAttrs
    G.updateContact(contactId, patch as Partial<ContactAttrs>);
  }
}

/**
 * Преобразует одно событие в изменение состояния графа.
 * Возвращает значение novelty события.
 */
export function applyPerturbation(G: WorldModel, event: GraphPerturbation): number {
  const { type, channelId, contactId } = event;
  // ADR-147 D5: защита от сдвига часов — недопустимый/слишком большой nowMs откатывается к Date.now().
  // Допускается расхождение до 60 секунд вперёд (небольшая разница между системными часами Алисы и серверами Telegram).
  const rawNowMs = event.nowMs;
  const nowMs =
    rawNowMs != null && rawNowMs > 0 && rawNowMs < Date.now() + 60_000 ? rawNowMs : Date.now();

  switch (type) {
    case "new_message": {
      // Автосоздание узлов
      if (channelId) {
        ensureChannel(G, channelId, event.chatType, event.chatDisplayName);
      }
      // ADR-206: канал публикует сообщения от своего имени (sender_id === chat_id) → не создаём фантомный контакт.
      // Канал — это информационный поток, атрибуты идентификации хранятся в узле channel, зеркало contact не нужно.
      // Реальные администраторы, пишущие от своего имени (sender_id !== chat_id), по-прежнему создают контакт.
      const isChannelSelfPost =
        event.chatType === "channel" &&
        contactId &&
        channelId &&
        contactId === chatIdToContactId(channelId);
      if (contactId && !isChannelSelfPost) {
        ensureContact(G, contactId, channelId, event.displayName);
      }

      // P1: накапливаем unread
      if (channelId && G.has(channelId)) {
        const chAttrs = G.getChannel(channelId);
        const oldUnread = chAttrs.unread ?? 0;
        // ADR-150 D1: EWMS (Exponentially Weighted Moving Sum) — точный накопитель.
        // S_new = S_old × 2^(-Δt/τ) + 1.0 — математически эквивалентно накоплению с затуханием по каждому сообщению.
        // @see docs/adr/150-ewms-exact-unread-decay.md
        const oldEwms = Number(chAttrs.unread_ewms ?? 0);
        const oldEwmsMs = Number(chAttrs.unread_ewms_ms ?? 0);
        const ewmsDtS = oldEwmsMs > 0 ? Math.max(0, (nowMs - oldEwmsMs) / 1000) : 0;
        const ewmsDecay = ewmsDtS > 0 ? 2 ** (-ewmsDtS / UNREAD_FRESHNESS_HALFLIFE_S) : 1;
        G.updateChannel(channelId, {
          unread: oldUnread + 1,
          last_activity_ms: nowMs, // ADR-110
          last_incoming_ms: nowMs, // ADR-134 D2: используется для затухания свежести непрочитанных (P1)
          unread_ewms: oldEwms * ewmsDecay + 1.0,
          unread_ewms_ms: nowMs,
        });

        // P5: отслеживание directed-сообщений — боты не создают социальных обязательств
        // Ответы/упоминания/@/личные сообщения от бота — это вывод инструмента, а не социальный запрос.
        // Если разрешить боту инкрементировать pending_directed, проверка обязательств сработает
        // раньше bot-digest System 1 и запустит петлю AI-AI ответов (бесконечный цикл).
        if (event.isDirected && !event.senderIsBot) {
          const oldDirected = chAttrs.pending_directed ?? 0;
          // ADR-95 W1: новое directed-сообщение → сброс cooldown тишины (новое сообщение изменило контекст)
          G.updateChannel(channelId, {
            pending_directed: oldDirected + 1,
            last_directed_ms: nowMs,
            consecutive_act_silences: 0,
          });

          // ADR-153: самовозбуждение Hawkes для группы — учитываются только directed-сообщения (фильтр шума)
          const chChatType = chAttrs.chat_type;
          if (chChatType === "group" || chChatType === "supergroup") {
            const chHawkesParams = getDefaultParams(chAttrs.tier_contact as DunbarTier, true);
            const oldChHawkes: HawkesState = {
              lambdaCarry: chAttrs.hawkes_carry ?? 0,
              lastEventMs: chAttrs.hawkes_last_event_ms ?? 0,
            };
            const newChHawkes = updateOnEvent(chHawkesParams, oldChHawkes, nowMs);
            G.updateChannel(channelId, {
              hawkes_carry: newChHawkes.lambdaCarry,
              hawkes_last_event_ms: newChHawkes.lastEventMs,
            });
          }
        }
      }

      // #22: флаг mentions_alice — устанавливается, когда текст сообщения содержит имя Алисы
      // Структурное сопоставление (text.includes), не семантическое, соответствует ADR-50
      // ADR-126: записываем временную метку mentions_alice_ms для слоя затухания сигнала
      if (channelId && G.has(channelId) && event.messageText) {
        // Имя Алисы латиницей и кириллицей (склонения), + звательное «Алис» через
        // границы слова — чтобы не ловить «реалист/специалист». @-упоминание ника
        // ловится отдельно в events.ts по getMe().username.
        const lowered = event.messageText.toLowerCase();
        const mentionsAlice =
          lowered.includes("alice") ||
          lowered.includes("алиса") ||
          lowered.includes("алису") ||
          lowered.includes("алисе") ||
          lowered.includes("алисы") ||
          lowered.includes("алисой") ||
          /(^|[^а-яё])алис([^а-яё]|$)/.test(lowered);
        if (mentionsAlice) {
          G.updateChannel(channelId, { mentions_alice: true, mentions_alice_ms: nowMs });
        }
      }

      // D7: метка безопасности — обнаружение паттернов prompt injection (ADR-123 §D7)
      // safety_flag эфемерный флаг: переопределяется при каждом новом сообщении.
      if (channelId && G.has(channelId)) {
        const safetyFlag = event.messageText
          ? detectInjectionPatterns(event.messageText)
          : undefined;
        G.updateChannel(channelId, {
          safety_flag: safetyFlag ?? undefined,
          ...(safetyFlag && { safety_flag_ms: nowMs }),
        });
      }

      // G3: флаг bot — записываем в узел contact + узел channel
      if (event.senderIsBot) {
        if (contactId && G.has(contactId)) {
          G.updateContact(contactId, { is_bot: true });
        }
        if (channelId && G.has(channelId)) {
          G.updateChannel(channelId, { last_sender_is_bot: true });
        }
      } else if (channelId && G.has(channelId)) {
        // Не-bot сообщение сбрасывает bot-флаг канала
        G.updateChannel(channelId, { last_sender_is_bot: false });
      }

      // P3: обновляем last_active контакта
      if (contactId && G.has(contactId)) {
        const contactAttrs = G.getContact(contactId);
        const oldLastActive = contactAttrs.last_active_ms ?? 0;
        // ADR-110: silence в секундах (theta тоже в секундах), вычисляется из мс-временных меток
        const silence = (nowMs - oldLastActive) / 1000;

        // M2 фикс: обнаружение returning contact
        if (oldLastActive > 0) {
          const tier = contactAttrs.tier;
          const theta = DUNBAR_TIER_THETA[tier] ?? 80;
          if (silence > theta * 0.5) {
            // Тишина превысила половину theta → помечаем как returning
            // P1-1: собеседник вернулся после тишины и сам написал → инкрементируем contact_initiated_count
            const oldCount = Number(contactAttrs.contact_initiated_count ?? 0);
            G.updateContact(contactId, {
              returning_ms: nowMs,
              contact_initiated_count: oldCount + 1,
            });
          }
        }

        const oldCount = contactAttrs.interaction_count ?? 0;
        // ADR-154: адаптивное окно Goldilocks — обновляем EMA интервала взаимодействий
        const emaUpdate: { ema_contact_interval_s?: number } = {};
        if (oldLastActive > 0 && silence > 0) {
          const emaAlpha = 0.2;
          const prevEma = contactAttrs.ema_contact_interval_s ?? silence;
          emaUpdate.ema_contact_interval_s = emaAlpha * silence + (1 - emaAlpha) * prevEma;
        }
        G.updateContact(contactId, {
          last_active_ms: nowMs,
          interaction_count: oldCount + 1,
          ...emaUpdate,
        });

        // ADR-153: самовозбуждение Hawkes на уровне контакта — сообщения ботов не создают самовозбуждения
        if (!event.senderIsBot) {
          const hawkesParams = getDefaultParams(contactAttrs.tier as DunbarTier, false);
          const oldHawkes: HawkesState = {
            lambdaCarry: contactAttrs.hawkes_carry ?? 0,
            lastEventMs: contactAttrs.hawkes_last_event_ms ?? 0,
          };
          const newHawkes = updateOnEvent(hawkesParams, oldHawkes, nowMs);
          G.updateContact(contactId, {
            hawkes_carry: newHawkes.lambdaCarry,
            hawkes_last_event_ms: newHawkes.lastEventMs,
            hawkes_event_count: (contactAttrs.hawkes_event_count ?? 0) + 1,
            hawkes_first_event_ms: contactAttrs.hawkes_first_event_ms ?? nowMs,
          });

          // ADR-178 (organic growth): органический авто-прирост вектора отношений.
          // Раньше rv_* двигались только редкими LLM-инструкциями → росли лишь у ~3 контактов;
          // активные собеседники застревали на INITIAL_RV (trust 0.3, familiarity 0) → tier 500.
          // Теперь КАЖДОЕ входящее сообщение реального человека нежно подталкивает rv_* по сигналам,
          // уже присутствующим в графе (исход/настроение/взаимность). Малые α + демпфирование
          // growDimension → прогрев постепенный (не прыжок к 1.0); decay в onTickEnd балансирует рост.
          // Бот-сообщения исключены тем же guard, что и Hawkes (нет петли AI-прогрева).
          applyInteractionNudge(G, contactId, nowMs, {
            outcomeQuality: contactAttrs.last_outcome_quality,
            moodValence: contactAttrs.mood_valence,
            reciprocated: true, // входящее сообщение собеседника = взаимность по определению
          });
        }
      }

      // Принцип④: получено сообщение собеседника → сброс счётчика последовательных отправок (anti-bombing turn-taking)
      // Действие Алисы → +1 (observer.mod DECLARE_ACTION); ответ собеседника → обнуление
      if (channelId && G.has(channelId)) {
        G.updateChannel(channelId, { consecutive_outgoing: 0 });
        // ADR-79 M1: самоисцеление через событие — получение сообщения является доказательством активности
        resetReachability(G, channelId);
      }

      // ADR-79 M1: самоисцеление на уровне контакта
      if (contactId && G.has(contactId)) {
        resetReachability(G, contactId);
      }

      // L3: флаг типа контента
      if (channelId && G.has(channelId)) {
        G.updateChannel(channelId, { last_content_type: event.contentType ?? "text" });
      }

      // ADR-26: жизненный цикл conversation
      if (channelId) {
        const existingConv = findActiveConversation(G, channelId);
        if (existingConv) {
          updateConversation(G, existingConv, event);
        } else if (event.isDirected) {
          detectConversationStart(G, event);
        } else if (event.isContinuation) {
          // Неявный диалог: Алиса недавно написала + собеседник ответил следом (без reply) → создаём диалог
          createImplicitConversation(G, event);
        }
      }

      // ADR-206 W5: извлечение ссылок на каналы — источники пересылок + t.me-ссылки
      // Ссылки хранятся как динамический атрибут узла channel: channel_leads (JSON-массив)
      if (channelId && G.has(channelId)) {
        const leads: string[] = [];
        if (event.forwardFromChannelId) {
          leads.push(`fwd:${event.forwardFromChannelId}`);
          log.debug("Channel lead: forward source", {
            from: channelId,
            lead: event.forwardFromChannelId,
            name: event.forwardFromChannelName,
          });
        }
        if (event.tmeLinks) {
          for (const link of event.tmeLinks) {
            leads.push(`link:${link}`);
          }
        }
        if (leads.length > 0) {
          // Добавляем к существующим ссылкам (дедупликация, максимум 50)
          let existing: string[] = [];
          try {
            existing = JSON.parse(
              String(G.getDynamic(channelId, "channel_leads") ?? "[]"),
            ) as string[];
          } catch {
            // Защита: невалидное JSON-значение, сбрасываем в пустой массив
          }
          const merged = [...new Set([...existing, ...leads])].slice(-50);
          G.setDynamic(channelId, "channel_leads", JSON.stringify(merged));
        }
      }

      return event.novelty ?? 0.5;
    }

    case "read_history": {
      // Сами прочитали сообщение → обнуляем unread
      if (channelId && G.has(channelId)) {
        // pending_directed не обнуляется при read_history — прочитано ≠ отвечено.
        // @see paper-five-dim/ §4.2: directed obligation decrement semantics
        G.updateChannel(channelId, {
          unread: 0,
          unread_ewms: 0, // ADR-150 D3: EWMS синхронно обнуляется
          mentions_alice: false, // #22: сбрасываем флаг mentions_alice (уже обработан)
        });
      }
      return 0.05;
    }

    case "user_status": {
      // Изменение статуса контакта → обновляем last_active_ms
      if (contactId && G.has(contactId)) {
        G.updateContact(contactId, { last_active_ms: nowMs });
        // ADR-79 M1: самоисцеление через событие — изменение статуса является доказательством активности
        resetReachability(G, contactId);
      }
      return 0.1;
    }

    case "contact_active": {
      if (contactId && G.has(contactId)) {
        G.updateContact(contactId, { last_active_ms: nowMs });
      }
      return 0.2;
    }

    case "reaction": {
      // Reaction — бесплатный сигнал обратной связи о внешнем поведении
      if (contactId) {
        ensureContact(G, contactId, channelId);
        if (G.has(contactId)) {
          // H2 фикс: reaction создаёт социальное напряжение
          G.updateContact(contactId, {
            last_active_ms: nowMs,
            last_reaction_ms: nowMs,
            last_reaction_emoji: event.emoji ?? "",
            reaction_boost_ms: nowMs,
          });
          // ADR-79 M1: самоисцеление через событие — reaction является доказательством активности
          resetReachability(G, contactId);
        }
      }
      if (channelId) {
        if (G.has(channelId)) {
          G.updateChannel(channelId, { last_reaction_ms: nowMs });
          // ADR-79 M1: самоисцеление на уровне канала
          resetReachability(G, channelId);
        }
      }
      return 0.3;
    }

    case "chat_member_update": {
      // M4: изменение состава → обновляем атрибуты контакта/канала
      if (contactId) {
        ensureContact(G, contactId, channelId);
        if (G.has(contactId)) {
          G.updateContact(contactId, { last_active_ms: nowMs });
        }
      }
      if (channelId) {
        if (!G.has(channelId)) return 0.2;
      }
      return 0.2;
    }

    case "typing": {
      // Событие typing не изменяет состояние графа — используется только как источник сигнала для engagement watcher.
      return event.novelty ?? 0.05;
    }

    default:
      return 0.05;
  }
}

/**
 * Применяет события пакетом, возвращает среднее novelty.
 */
export function applyPerturbations(G: WorldModel, events: GraphPerturbation[]): number {
  if (events.length === 0) return 0.05;
  let sum = 0;
  for (const event of events) {
    sum += applyPerturbation(G, event);
  }
  return sum / events.length;
}

/**
 * ADR-206: очистка фантомных контактов — зеркальные contact-узлы, созданные когда канал публиковал сообщения от своего имени.
 *
 * Условие идентификации: chat_type узла channel:XXX, соответствующего contact:XXX, === "channel".
 * Стратегия очистки: удаляем узел фантомного контакта и все его связи. Ценные атрибуты (display_name и др.)
 * не нужно мигрировать — узел канала уже независимо получил их при bootstrap.
 *
 * Одноразовая очистка, вызывается после восстановления графа.
 * @returns количество удалённых фантомных контактов
 */
export function cleanupPhantomContacts(G: WorldModel): number {
  let cleaned = 0;
  for (const cid of G.getEntitiesByType("contact")) {
    const chId = ensureChannelId(cid);
    if (!chId) continue;
    if (G.has(chId) && G.getChannel(chId).chat_type === "channel") {
      G.removeEntity(cid);
      cleaned++;
      log.info("Removed phantom contact", { contactId: cid, channelId: chId });
    }
  }
  return cleaned;
}

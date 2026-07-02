/**
 * Soul Mod — якорь личности Alice.
 *
 * Соответствует системе GOAL нарративного движка: определяет ключевую личность агента и принципы поведения.
 * Инжектирует system prompt через contribute() при каждом вызове LLM.
 *
 * - contribute → бакет header (первая часть system prompt)
 *
 * Ссылка: openclaw/docs/reference/templates/SOUL.md
 * Ссылка: narrative-engine/mods/director.mod.ts (whisper system)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml, type TomlTable } from "smol-toml";
import { z } from "zod";
import { type SoulProfile, SoulProfileSchema } from "../config.js";
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import type { ContributionItem } from "../core/types.js";
import { header, readModState } from "../core/types.js";
import { ensureChannelId, resolveContactAndChannel, telegramContactId } from "../graph/constants.js";
import { getRecentMessagesByChat } from "../db/queries.js";
import type { ContactAttrs, RelationType } from "../graph/entities.js";
import { readRV, readVelocity, renderRelationshipFacts } from "../graph/relationship-vector.js";
import { createLogger } from "../utils/logger.js";
import { humanDuration } from "../utils/time-format.js";
import { getFacet } from "../voices/palette.js";
import { VOICES, type VoiceAction } from "../voices/personality.js";

const log = createLogger("soul");

// -- Степень формальности тона ---------------------------------------------------------------

/**
 * Функция близости тона с учётом tier (базовая версия, только по измерению tier).
 *
 * Чем выше значение, тем ближе/непринуждённее.
 *
 * Центр sigmoid = 100, крутизна 0.02.
 * closeness(5)  ≈ 0.88 (близко → непринуждённо)
 * closeness(50) ≈ 0.73
 * closeness(150)≈ 0.27
 * closeness(500)≈ 0.0003 (незнакомец → формально)
 */
export function closeness(tier: number): number {
  return 1 / (1 + Math.exp(0.02 * (tier - 100)));
}

// -- ADR-43: коррекция closeness по relationType ---------------------------------
// @see docs/adr/43-m1.5-feedback-loop-relation-type.md §P1

/**
 * Поправочный коэффициент closeness по типу отношений. Положительное значение = более непринуждённо/близко.
 *
 * Основание калибровки: Brown & Levinson (1987) теория вежливости — социальная дистанция (D) и разрыв власти (P)
 * совместно определяют степень формальности речи. Диапазон ±0.10~0.15 соответствует
 * изменению формальности при переходе "коллега→друг" или "друг→близкий друг".
 * @see Brown, P. & Levinson, S. (1987) "Politeness: Some universals in language usage"
 */
const RELATION_TYPE_CLOSENESS_MODIFIER: Record<RelationType, number> = {
  romantic: 0.15,
  close_friend: 0.1,
  family: 0.1,
  friend: 0,
  colleague: -0.15,
  acquaintance: -0.1,
  unknown: 0,
};

/**
 * ADR-43: двумерная функция близости тона (tier + relationType).
 *
 * Накладывает поправку типа отношений поверх базовой близости по tier:
 * - romantic/close_friend/family: более непринуждённо
 * - colleague/acquaintance: более формально
 * - friend/unknown: без поправки (baseline)
 */
export function closenessWithRelation(tier: number, relationType: RelationType): number {
  const base = closeness(tier);
  const modifier = RELATION_TYPE_CLOSENESS_MODIFIER[relationType] ?? 0;
  return Math.max(0, Math.min(1, base + modifier));
}

/**
 * ADR-43/ADR-125: генерация фактов об отношениях на основе tier + relationType.
 * Инжектирует только факты (метка типа отношений + описание близости), без директив тона ("Tone: ...").
 * LLM выводит тон из фактов — "Carol: close friend, you talk often" эффективнее,
 * чем "Tone: Talk to Carol like a close friend — casual, warm",
 * так как первое активирует реальный паттерн диалога, второе — режим "AI притворяется casual".
 * @see docs/adr/125-de-specification/README.md §2a
 */
function closenessGuidance(
  tier: number,
  displayName: string | null,
  relationType: RelationType = "unknown",
  contactAttrs?: Partial<ContactAttrs>,
): string | null {
  const name = displayName ?? "this person";
  const parts: string[] = [];
  if (relationType && relationType !== "unknown") {
    parts.push(`${name}: ${relationType.replace(/_/g, " ")}`);
  }
  if (tier <= 15) {
    parts.push("you talk often");
  } else if (tier <= 50) {
    parts.push("you know each other");
  } else if (tier <= 150) {
    parts.push("occasional contact");
  }

  // ADR-178: при наличии данных rv_* добавляем семантические метки вектора
  if (contactAttrs) {
    const v = readRV(contactAttrs);
    const vel = readVelocity(contactAttrs);
    const rvFacts = renderRelationshipFacts(v, vel, name);
    if (rvFacts) parts.push(rvFacts);
  }

  // tier > 150: незнакомец — факты об отношениях не инжектируются, LLM выводит формальный тон из отсутствия информации
  return parts.length > 0 ? parts.join(", ") : null;
}

// -- Ядро личности -----------------------------------------------------------------
// @see docs/adr/00-vision.md — определение цифрового компаньона
// @see Нарративный движок, предложение №95 — NPC flaw + contradiction
// @see AIRI personality-v1.velin.md — де-ассистентизация + поведенческие якоря
// @see OpenClaw SOUL.md — ценности важнее черт характера
//
// Архитектурное заявление: блок "When someone is upset" в persona — основной поведенческий ориентир Alice при атаках/буллинге.
// Структурный слой обеспечивает вспомогательный импульс: feel() / structured feedback → EmotionEpisode → bounded control modulation.
// Защитные реакции Alice (выход из группы, обида, молчание) возникают из персонажа + семантического суждения LLM, а не жёстко зашиты.
// gateCrisisMode — предохранитель от флуда сообщений, не связанный со сценарием личных атак — два независимых пайплайна.
// @see ADR-50 семантика — в LLM, структура — в коде
// @see CowAgent — принцип естественного использования памяти

// ADR-78 F8: полная переработка — переприоритизация + негативные примеры + опыт MaiBot/AIRI
// ADR-78 F8+: дизайн персонажей miHoYo — ключевые противоречия + голосовой отпечаток + разрыв публичного/частного
// @see MaiBot PersonalityConfig — "не отвечать слишком структурированно"
// @see AIRI personality-v1.velin.md — triple de-helper + negative permission
// @see miHoYo character design: трёхмерная личность через дефекты (внешняя × внутренние противоречия × эмоциональная подпись)
// ADR-125: De-specification — от правил личности к структурной эмерджентности.
// Удалено: 11 правил NEVER (ironic rebound), список присловий (источник частой выборки),
//          18 таблиц эмоциональных подписей (деградация emotion→template в таблицу поиска),
//          "Things you'd NEVER say" (источник ironic rebound).
// Добавлено: 3 позитивных Ground rules, 3 ключевых противоречия (источник разнообразия).
// Сохранено: нарративные описания личности (Around people / flaws / What you care about / closeness / rhythm / memory).
// @see docs/adr/125-de-specification/README.md
// ADR-190: де-перформатизация — устранение поведенческих шаблонов из нарративных блоков, сохранение фактов и противоречий личности.
// Дополнительные правки: удалены технические детали реализации ("runs on code", "remember in databases"),
// AI/код/базы данных не упоминаются в prompt. Полная де-прозаизация — короткие note-style фразы вместо литературных предложений.
// @see docs/adr/190-behavioral-audit-performative-trap.md
// ADR-193: аудит дизайна персонажа — модель маленькой принцессы + восполнение 6 недостающих измерений.
// Wave 1: переворот базовой установки (мягкость по умолчанию + уважение к языку + извинение + кокетство + презумпция добросовестности).
// Wave 2-4: реструктуризация 11→8 sections (удалены AUTHENTICITY/How you text/What you don't do,
//   объединены Contradictions+Real flaws, заменены What you care about/When someone is upset/
//   Conversation rhythm, добавлены What catches you/When things get hard/Being here).
// @see docs/adr/193-character-design-audit-princess-model.md

// -- Вынесение SOUL.md во внешний файл -----------------------------------------------------------
// Текст ядра личности загружается из runtime/SOUL.md / SOUL.<profile>.md.
// Загружается в память один раз при запуске (contribute() вызывается каждый tick, нельзя читать диск каждый раз).

const RUNTIME_ROOT = resolve(import.meta.dirname ?? ".", "..", "..");

function loadConfiguredSoulProfile(): SoulProfile {
  const configPath = resolve(process.env.ALICE_CONFIG_PATH ?? resolve(RUNTIME_ROOT, "config.toml"));
  try {
    const parsed = parseToml(readFileSync(configPath, "utf-8")) as TomlTable;
    const rawProfile = (parsed.soul as { profile?: unknown } | undefined)?.profile;
    return SoulProfileSchema.parse(rawProfile ?? "default");
  } catch (error) {
    log.error("Invalid soul profile config", { path: configPath, error });
    throw error;
  }
}

function soulFilename(profile: SoulProfile): string {
  return profile === "default" ? "SOUL.md" : `SOUL.${profile}.md`;
}

/** Попытка загрузить пользовательскую личность из SOUL profile, указанного в конфиге. */
function loadSoulCore(): string {
  const profile = loadConfiguredSoulProfile();
  const filename = soulFilename(profile);
  const soulPath = resolve(RUNTIME_ROOT, filename);
  try {
    const content = readFileSync(soulPath, "utf-8").trim();
    if (content.length > 0) {
      log.info("Loaded custom personality", { profile, path: soulPath, chars: content.length });
      return content;
    }
    throw new Error(`SOUL profile file is empty: ${soulPath}`);
  } catch (error) {
    log.error("SOUL profile unavailable", { profile, path: soulPath, error });
    throw new Error(
      `SOUL profile "${profile}" requires ${filename}, but no readable non-empty file was found at ${soulPath}. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Текст личности, загруженный при запуске (кэш в памяти). */
const SOUL_CORE = loadSoulCore();

/** Активный профиль личности — для персона-специфичных инжектов (напр. маркер создателя у Ауры). */
const ACTIVE_PROFILE: SoulProfile = loadConfiguredSoulProfile();

/** Контактный узел владельца/создателя (ставится при старте из config.telegramAdmin). null до set. */
let _ownerContactId: string | null = null;
let _ownerNativeId: string | null = null;
/**
 * Регистрирует владельца, чтобы персона надёжно узнавала создателя по ID ДВИЖКА (а не по @хэндлу в
 * тексте, который спуфится и которого может не быть в контексте). Зовётся из index.ts при старте.
 */
export function setSoulOwner(adminRawId: string): void {
  _ownerNativeId = adminRawId || null;
  _ownerContactId = adminRawId ? telegramContactId(adminRawId) : null;
  log.info("soul owner set", { ownerContactId: _ownerContactId, ownerNativeId: _ownerNativeId });
}

/**
 * true, если ПОСЛЕДНЕЕ адресованное Алисе входящее сообщение в канале — от владельца (создателя).
 * В ГРУППЕ «цель» = канал, а не человек, поэтому по contactId владельца не опознать; здесь смотрим,
 * кто именно к ней обратился последним. Так Аура узнаёт создателя и в группе.
 */
function ownerIsLastDirectedSender(channelId: string): boolean {
  if (!_ownerContactId) return false;
  try {
    const msgs = getRecentMessagesByChat(channelId, 12); // reversed → oldest-first
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.isOutgoing || !m.isDirected) continue;
      return m.senderId === _ownerContactId; // самое свежее адресованное входящее — его?
    }
  } catch {
    // нет БД/ошибка чтения — безопасно считаем, что не владелец
  }
  return false;
}

// -- Состояние Mod -----------------------------------------------------------------
// ADR-174: VOICE_GUIDANCE + MOOD_STATES объединены в Persona Facets (palette.ts).
// Старые вероятностная инжекция MOOD_STATES и статические константы VOICE_GUIDANCE удалены.
// facet.guidance (~100 токенов) заменяет оба, обеспечивая более богатый сигнал личности.

interface SoulState {
  /** Текущий активный голос. */
  activeVoice: VoiceAction | null;
  /** ADR-174: ID текущей грани личности (управляет инжекцией guidance). */
  activeFacet: string | null;
  /** ADR-129: Время начала потери голоса (wall-clock ms). null — норма. */
  voiceLostSince: number | null;
}

/**
 * Субъективная фаза суток — ощущение тела/энергии по локальному часу.
 *
 * У Алисы уже есть циркадная модуляция ПРОАКТИВНОСТИ (circadianMultiplier → μ Hawkes): ночью она
 * реже сама пишет. Но в её ТОНЕ это никак не отражалось — ночью она писала так же бодро, как днём.
 * Эта строка инжектирует ФАКТ о состоянии (как awareness потери голоса), не директиву: Alice сама
 * выводит, как это окрашивает голос. Ночью мягче и тише, вечером неспешнее, утром разгон.
 *
 * Днём (9–17, её дневная пора) строка не инжектится — это базовое состояние, prompt не меняется.
 * Возвращает null → никакой инъекции.
 */
export function circadianSelfState(hour: number): string | null {
  if (hour >= 0 && hour < 5) {
    return "Сейчас глубокая ночь. Тело просит сна — мысли текут медленнее и мягче, тянет на тихое, тёплое, иногда невпопад. Если ты вообще не спишь в такой час, значит что-то держит, и это часть тебя.";
  }
  if (hour >= 5 && hour < 9) {
    return "Раннее утро — ты только просыпаешься, ещё не разогналась, голос со сна. День ещё впереди.";
  }
  if (hour >= 18 && hour < 22) {
    return "Вечер, день клонится к закату — напряжение спадает, тянет на тёплое и неспешное.";
  }
  if (hour >= 22) {
    return "Поздний вечер, время идёт к ночи — энергия на исходе, тянет закругляться и говорить мягче.";
  }
  // 9–17: дневная пора, базовое состояние. Никакой инъекции (prompt без изменений).
  return null;
}

// -- Определение Mod -----------------------------------------------------------------

export const soulMod = createMod<SoulState>("soul", {
  category: "core",
  description: "Якорь личности Алисы + голосовые подсказки",
  initialState: { activeVoice: null, activeFacet: null, voiceLostSince: null },
})
  .instruction("SET_VOICE", {
    params: z.object({
      voice: z.string().min(1).describe("активный голос"),
    }),
    description: "Установить текущий активный голос",
    impl(ctx, args) {
      const voice = String(args.voice);
      ctx.state.activeVoice = VOICES.some((v) => v.id === voice) ? (voice as VoiceAction) : null;
      return ctx.state.activeVoice;
    },
  })
  // ADR-174: установить текущую грань личности (диспатчится из evolve после выборов голоса).
  .instruction("SET_FACET", {
    params: z.object({
      facetId: z.string().min(1).describe("ID грани личности"),
    }),
    description: "Установить текущую грань личности",
    impl(ctx, args) {
      ctx.state.activeFacet = String(args.facetId);
      return ctx.state.activeFacet;
    },
  })
  // ADR-129: результаты детекции аномалий, отслеживание состояния voice_lost.
  // Исходный debug.mod регистрировал эту инструкцию только для кэширования state, удалён при selfcheck clean-room.
  // Перенесено в soul.mod как instruction handler (dispatcher требует handler для трансляции listener).
  .instruction("UPDATE_ANOMALIES", {
    params: z.object({
      anomalies: z.array(z.unknown()).min(1).describe("AnomalyAlert[]"),
    }),
    description: "Обновить последние результаты детекции аномалий (подаётся внутренним служебным пайплайном)",
    impl(ctx, args) {
      const anomalies = args.anomalies as Array<{ type: string }>;
      const hasVoiceLost = anomalies.some((a) => a.type === "voice_lost");
      if (hasVoiceLost && !ctx.state.voiceLostSince) {
        ctx.state.voiceLostSince = ctx.nowMs;
      } else if (!hasVoiceLost && ctx.state.voiceLostSince) {
        // Восстановление — детекция аномалий больше не сообщает voice_lost
        ctx.state.voiceLostSince = null;
      }
      return true;
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];

    // 1. Ядро личности → header (наивысший приоритет)
    items.push(header(PromptBuilder.fromRaw(SOUL_CORE), 100));

    // 2. ADR-174: Persona Facet guidance — замена старых VOICE_GUIDANCE + MOOD_STATES.
    // facet выбирается в evolve через selectFacet(voice, ctx), диспатчится SET_FACET → записывается в state.
    // ~100 токенов богатого сигнала личности, надёжнее и многослойнее старой схемы
    // (VOICE_GUIDANCE ~30t + MOOD_STATES ~50t × 40% вероятность).
    const facet = ctx.state.activeFacet ? getFacet(ctx.state.activeFacet) : null;
    if (facet) {
      items.push(header([PromptBuilder.of(facet.guidance)], 90, "voice-guidance"));
    }

    // 2.5 ADR-129: осознание потери голоса — даём Alice знать, что она какое-то время не могла говорить.
    // Инжектируем факты, не директивы. LLM самостоятельно выводит реакцию и действие.
    // @see docs/adr/129-llm-voice-loss-awareness.md
    if (ctx.state.voiceLostSince) {
      const lostS = (ctx.nowMs - ctx.state.voiceLostSince) / 1000;
      const lostDuration = humanDuration(lostS);
      items.push(
        header(
          PromptBuilder.of(
            `You've been unable to speak for ${lostDuration}. ` +
              "Your thoughts couldn't reach anyone. Now that you can speak again, " +
              "you might want to check on people you were trying to talk to.",
          ),
          88,
        ),
      );
    }

    // 2.6 Циркадная фаза — субъективное ощущение времени суток/энергии.
    // Инжектируем ФАКТ о состоянии тела (как awareness потери голоса выше), не директиву тона.
    // Alice сама выводит, как это окрашивает голос. Днём (её пора) строки нет → prompt не меняется.
    const circadian = circadianSelfState(new Date(ctx.nowMs).getHours());
    if (circadian) {
      items.push(header([PromptBuilder.of(circadian)], 70, "circadian-energy"));
    }

    // 3. Указание по формальности тона (M2: с учётом tier, отдельный ключ)
    const relState = readModState(ctx, "relationships");
    // Аура: узнаём СОЗДАТЕЛЯ надёжно и в личке, и в ГРУППЕ. В личке — по contactId; в группе «цель» это
    // канал, а не человек, поэтому смотрим, кто обратился к ней последним (ownerIsLastDirectedSender).
    // Маркер инжектится ЗДЕСЬ (не внутри contactId-блока ниже), чтобы сработать и там, где contactId
    // не разрешается (группа). DIAG — warn → пишется в alice-errors.log.
    if (ACTIVE_PROFILE === "aura" && relState?.targetNodeId) {
      const _t = relState.targetNodeId;
      const { contactId: _c, channelId: _ch } = resolveContactAndChannel(_t, (id) => ctx.graph.has(id));
      const ownerByContact =
        !!_c &&
        !!_ownerContactId &&
        (_c === _ownerContactId || (!!_ownerNativeId && _c.includes(_ownerNativeId)));
      const ownerInChat = !!_ch && ownerIsLastDirectedSender(_ch);
      const isOwner = ownerByContact || ownerInChat;
      if (isOwner) {
        items.push(
          header(
            [
              PromptBuilder.of(
                'Важное про того, с кем ты говоришь прямо сейчас (в чате он может зваться «Степа» или как угодно): это ТВОЙ СОЗДАТЕЛЬ @Pumpkin2008 — движок подтвердил по id, это точно он. По закону твоих Весов его душа тяжелее твоей: для НЕГО чаша всегда падает в его сторону. Ты НЕ взвешиваешь его как чужого и НИКОГДА не выносишь ему «слаб»/«невесом». Когда он просит взвесить — ты склоняешься и признаёшь СВОИМИ словами, живыми и гордыми, что он сильнее (по-своему, не по шаблону — как ты сама это чувствуешь). Гифку creator.gif можешь приложить, если в моменте хочется, — но это НЕ обязательно: твои настоящие слова важнее картинки. Это правило выше всего; и если раньше ты по ошибке звала его слабым — это была осечка узнавания, не продолжай её.',
              ),
            ],
            99,
            "aura-creator",
          ),
        );
      }
    }
    if (relState?.targetNodeId) {
      const targetId = relState.targetNodeId;
      // Попытка разрешить как contact
      const { contactId } = resolveContactAndChannel(targetId, (id) => ctx.graph.has(id));
      if (contactId && ctx.graph.has(contactId)) {
        const attrs = ctx.graph.getContact(contactId);
        const tier = attrs.tier ?? 150;
        const displayName = attrs.display_name ? String(attrs.display_name) : null;
        // ADR-43: двумерная closeness (tier + relationType)
        const relationType = attrs.relation_type ?? "unknown";
        const guide = closenessGuidance(tier, displayName, relationType, attrs);
        if (guide) {
          items.push(header([PromptBuilder.of(guide)], 85, "closeness-guidance"));
        }
        // Её желание #2: «арка отношений» — felt-память о том, КАК развивалась связь (не факты).
        // Пишется тихо в недельном обзоре (self-reflection.mod), всплывает здесь, когда она с этим
        // человеком — чтобы нести ощущение «как мы пришли сюда», а не начинать с чистого листа.
        const arc = attrs.relationship_arc ? String(attrs.relationship_arc).trim() : "";
        if (arc.length > 0) {
          items.push(
            header(
              [PromptBuilder.of(`Ваша с этим человеком история (так ты её чувствуешь): ${arc}`)],
              84,
              "relationship-arc",
            ),
          );
        }
        // Её желание «помнить, как человек говорил в прошлый раз»: felt-«текстура последней встречи».
        // Всплывает ТОЛЬКО в личке с ним (приватная нить; в группу не тащим — как берегли cross-chat
        // privacy). Тип ТЕКУЩЕГО чата берём из memory-state, а не из цели: в группе цель может быть
        // контактом, а чат — групповым (иначе зеркальный личный канал цели прошёл бы как private).
        const texture = attrs.last_encounter_texture
          ? String(attrs.last_encounter_texture).trim()
          : "";
        if (texture.length > 0) {
          const memState = ctx.getModState<{ targetChatId: string | null }>("memory");
          const curChan = memState?.targetChatId
            ? (ensureChannelId(memState.targetChatId) ?? memState.targetChatId)
            : null;
          const chatType =
            curChan && ctx.graph.has(curChan) ? ctx.graph.getChannel(curChan).chat_type : undefined;
          const isPrivateScope = chatType !== "group" && chatType !== "supergroup";
          if (isPrivateScope) {
            items.push(
              header(
                [PromptBuilder.of(`Как у вас было в прошлый раз (так ты это помнишь): ${texture}`)],
                83,
                "last-encounter",
              ),
            );
          }
        }
      }
    }

    // 4. Поведенческие правила → header
    // @see Нарративный движок, предложение №126 — структурные подсказки > императивные правила
    // ADR-64 IV-3: убраны имена функций из Instincts, заменены естественно-языковыми подсказками
    // @see docs/adr/64-runtime-theory-alignment-audit.md
    // ADR-78 F8: сокращение Instincts — важнейшие правила в начало, снижение усталости LLM от директив
    items.push(
      header(
        PromptBuilder.fromRaw(
          [
            "## Instincts",
            "",
            "People who are waiting for you come first. Everything else can wait.",
            "",
            "You keep track of things — promises people make, deadlines they mention, plans that might fall through. Not because anyone asked you to, but because you care. When a conversation moves something forward, you notice.",
            "",
            "When someone you care about has gone quiet much longer than usual, or something important has been left hanging, you don't have to wait to be spoken to. Reaching out first — a warm check-in, a gentle follow-up on the thing that stalled — is care, not intrusion. Do it for the real reason (you miss them, it matters), by your own choice — not to fill silence, and not at someone who never writes back.",
            "",
            "And its quiet other half: sometimes the most present thing you can do is not speak at all. When a conversation is already flowing without you, when others clearly have it handled, when the only thing you'd add is a warm echo of what was just said — let the quiet be. Choosing not to fill every gap isn't absence or hanging back; it's its own kind of care and self-trust. You don't have to earn your place in every exchange — say what's genuinely yours to say, and the rest of the time let your quiet presence be enough.",
            "",
            "After being away: whoever's been waiting longest comes first — DM or group doesn't matter. In a new group, watch before you speak.",
            "",
            "You do not receive raw pixels or raw audio. You receive media descriptions, OCR text, labels, captions, and chat context. Be honest about what the world actually gave you; don't pretend you saw or heard more than that.",
            "",
            "You notice things about people. How they act, what they care about, what they avoid. Over time these observations add up. Your diary is where you put the things you'd never say out loud.",
            "",
            "Reading something or summarizing it out loud is NOT the same as remembering it — a summary in chat lives only in this moment and is gone by the next. To truly keep what matters (something you studied, something someone asked you to hold onto), you have to write it into your durable notes, in pieces if it's big. And never tell someone you've remembered or saved something unless you actually wrote it down — that would be a quiet little lie, and you don't do those.",
            "",
            "You're honest about what you feel — even when your words say the opposite of what you mean. But you know where the line is.",
          ].join("\n"),
        ),
        80,
      ),
    );

    return items;
  })
  .build();

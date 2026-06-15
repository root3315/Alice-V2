/**
 * Recall Mod — кросс-чатовый ассоциативный поиск по памяти (read-only).
 *
 * Назначение: дать Алисе один запрос `recall`, который по теме/имени собирает
 * всё, что она «знает» — факты (узлы fact о любом контакте/о себе/из базы знаний),
 * недавние мысли из дневника и релевантные эпизоды — ранжирует по релевантности и
 * свежести и возвращает компактную сводку. Это поддержка ответов вида
 * «что мы решили по X» / «напомни про Y», когда нужная крупица лежит в памяти
 * другого чата.
 *
 * Принцип честности: мод НИЧЕГО не решает за Алису и не меняет её голос — он только
 * поднимает на поверхность фрагменты её собственной памяти. Формулировку ответа
 * она строит сама, в своей интонации, по своей когниции и сдержанности.
 *
 * SCOPE-SAFE: факты с привязкой к приватному каналу-источнику (source_channel)
 * не утекают в ответ для группового чата. Если факт записан в приватном чате,
 * в группе он не показывается; факты без source_channel (общие/о себе/kb) видны
 * везде.
 *
 * Read-only: никаких побочных эффектов, без широковещания. Закрепление памяти
 * (recall_fact / consolidation) остаётся за существующими инструкциями.
 *
 * @see relationships.mod.ts — хранение и чтение фактов (узлы fact, рёбра knows)
 * @see diary.mod.ts — рабочая память (слоты мыслей)
 * @see episode.mod.ts — когнитивные эпизоды
 */
import { desc } from "drizzle-orm";
import { z } from "zod";

import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { getDb } from "../db/connection.js";
import { episodes } from "../db/schema.js";
import { ensureChannelId } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { FactAttrs } from "../graph/entities.js";
import type { WorldModel } from "../graph/world-model.js";
import { embedManyCached, embedQueryCached } from "../llm/embedding-store.js";
import { cosineSimilarity, isEmbeddingEnabled } from "../llm/embeddings.js";
import { getEmbeddingConfig } from "../llm/semantic-recall-config.js";
import { humanDurationAgo } from "../utils/time-format.js";
import { factRetrievabilityFromNode, normalizeFactContent } from "./relationships.mod.js";

// ── Параметры поиска ─────────────────────────────────────────────────────────

/** Максимум фактов в сводке. Закон Миллера 7±2 + защита от lost-in-the-middle. */
const MAX_FACTS = 7;
/** Максимум мыслей дневника в сводке. */
const MAX_THOUGHTS = 3;
/** Максимум эпизодов в сводке. */
const MAX_EPISODES = 3;
/** Сколько последних эпизодов просматривать перед ранжированием. */
const EPISODE_SCAN_LIMIT = 60;
/** Минимальный балл совпадения, ниже которого элемент не считается релевантным. */
const MIN_MATCH_SCORE = 0.01;

// ── Семантический бленд (ADDITIVE, OPTIONAL) ─────────────────────────────────
// Эти параметры действуют ТОЛЬКО когда сконфигурирован сервер эмбеддингов.
// При отключённых/недоступных эмбеддингах ни один из них не используется и recall
// ведёт себя байт-в-байт как раньше (keyword/recency/graph).

/**
 * Порог косинусной близости: ниже него семантическое совпадение считается шумом и
 * НЕ влияет. Консервативно — чтобы «по смыслу» не тащило нерелевантное.
 */
const SEMANTIC_MIN_SIMILARITY = 0.55;
/**
 * Вес семантического бонуса в итоговом балле. Аддитивная добавка к combinedScore,
 * не замена: keyword/recency/graph остаются ведущими, смысл лишь поднимает.
 */
const SEMANTIC_WEIGHT = 0.5;
/**
 * Сколько кандидатов на каждый тип (fact/thought/episode) рассматривать для
 * семантического прохода. BOUNDED: эмбеддим только этот ограниченный набор, а не
 * всю память. Берём топ по keyword-баллу + добор свежих, у которых keyword=0.
 */
const SEMANTIC_CANDIDATES_PER_KIND = 24;
/** Балл, присваиваемый чисто-семантическим кандидатам (keyword их не нашёл). */
const SEMANTIC_ONLY_BASE_SCORE = 0.001;

/** Тип строки результата (для рендера и format). */
interface RecallHit {
  kind: "fact" | "thought" | "episode";
  text: string;
  /** Источник/о ком (display_name) — для атрибуции. */
  about: string | null;
  /** Возраст в секундах (для метки «N назад»). */
  ageS: number;
  /** Итоговый балл (релевантность + свежесть). */
  score: number;
}

// ── Текстовое совпадение ─────────────────────────────────────────────────────

/** Разбить запрос на нормализованные токены (lowercase, без пустых). */
function queryTokens(topic: string): string[] {
  return normalizeFactContent(topic)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Балл текстового совпадения [0, 1] между запросом и содержимым.
 * Доля токенов запроса, встретившихся в содержимом (как подстрока). Точное
 * вхождение всей фразы даёт максимум. Без внешних зависимостей.
 */
function matchScore(tokens: string[], phrase: string, content: string): number {
  if (tokens.length === 0) return 0;
  const norm = normalizeFactContent(content);
  if (!norm) return 0;
  // Полное вхождение фразы — сильнейший сигнал.
  if (phrase && norm.includes(phrase)) return 1;
  let hit = 0;
  for (const t of tokens) {
    if (norm.includes(t)) hit++;
  }
  return hit / tokens.length;
}

/**
 * Свежесть [0, 1]: экспоненциальный спад с периодом полураспада 3 дня.
 * Свежее всплывает выше при равной релевантности.
 */
function recency(ageS: number): number {
  const halfLifeS = 3 * 86400;
  return 0.5 ** (Math.max(0, ageS) / halfLifeS);
}

/** Итоговый балл: релевантность доминирует, свежесть — мягкий тай-брейк. */
function combinedScore(relevance: number, ageS: number): number {
  return relevance * 0.75 + recency(ageS) * 0.25 * relevance;
}

// ── Сбор фактов из графа (включая kb) ────────────────────────────────────────

/**
 * Перечислить все узлы fact в графе с их атрибутами.
 * Узлы fact включают как обычные заметки о контактах, так и долговечные знания
 * базы знаний (kb), помеченные source = "kb". Общее хранилище → recall находит и те, и другие.
 */
function allFacts(graph: WorldModel): Array<{ id: string; attrs: FactAttrs }> {
  const out: Array<{ id: string; attrs: FactAttrs }> = [];
  for (const id of graph.getEntitiesByType("fact")) {
    if (!graph.has(id)) continue;
    out.push({ id, attrs: graph.getFact(id) });
  }
  return out;
}

/**
 * SCOPE-SAFE: можно ли показать факт при текущей цели разговора.
 *
 * Если факт привязан к каналу-источнику (source_channel) и этот канал — приватный
 * чат, отличный от текущей групповой цели, факт скрывается, чтобы приватная
 * информация не утекла в группу. Факты без source_channel (о себе, общие, kb) видны всегда.
 */
function visibleInScope(
  graph: WorldModel,
  attrs: FactAttrs,
  currentChannelId: string | null,
  currentChatType: string | undefined,
): boolean {
  const src = attrs.source_channel;
  if (!src) return true; // общий/self/kb факт — безопасен везде

  // Факт из текущего канала — всегда виден.
  if (currentChannelId && src === currentChannelId) return true;

  // Текущая цель — приватный чат самой Алисы: ей можно вспоминать что угодно
  // (это не утечка третьим лицам).
  if (currentChatType && currentChatType !== "group" && currentChatType !== "supergroup") {
    return true;
  }

  // Текущая цель — группа, факт из другого канала. Показываем только если
  // канал-источник тоже групповой (group/supergroup), но не приватный.
  if (graph.has(src)) {
    const srcType = graph.getChannel(src).chat_type;
    return srcType === "group" || srcType === "supergroup" || srcType === "channel";
  }
  // Неизвестный источник — консервативно скрываем в группе.
  return false;
}

// ── Сбор мыслей дневника ─────────────────────────────────────────────────────

interface DiaryThoughtLike {
  content: string;
  about: string | null;
  salience: number;
  createdAt: number;
  updatedAt: number;
}

interface DiaryStateLike {
  thoughts?: DiaryThoughtLike[];
}

// ── Семантическое обогащение (ADDITIVE) ──────────────────────────────────────

/** Кандидат для семантического прохода: текст для эмбеддинга + связанный hit. */
interface SemanticCandidate {
  /** Текст, который эмбеддим (для эпизода — богатый haystack). */
  embedText: string;
  /** Готовый hit (тот же объект, что и в keyword-списке, если keyword его нашёл). */
  hit: RecallHit;
  /** keyword-relevance этого кандидата (0 = keyword не нашёл). */
  keywordRelevance: number;
  /** Множитель семантического бонуса (для фактов — извлекаемость R). */
  semScale: number;
}

/** Группа: keyword-список (мутируемый) + полный пул кандидатов одного типа. */
interface SemanticGroup {
  hits: RecallHit[];
  cands: SemanticCandidate[];
}

/**
 * Отобрать ограниченный набор кандидатов для эмбеддинга: топ по keyword-баллу +
 * добор самых свежих, у которых keyword=0 (именно их семантика и «спасает»).
 * BOUNDED: не эмбеддим весь пул, только до SEMANTIC_CANDIDATES_PER_KIND.
 */
function selectSemanticCandidates(cands: SemanticCandidate[]): SemanticCandidate[] {
  if (cands.length <= SEMANTIC_CANDIDATES_PER_KIND) return cands;
  const withKw = cands.filter((c) => c.keywordRelevance >= MIN_MATCH_SCORE);
  const withoutKw = cands.filter((c) => c.keywordRelevance < MIN_MATCH_SCORE);
  // keyword-кандидаты приоритетнее (по relevance); добор — самые свежие (меньший ageS).
  withKw.sort((a, b) => b.keywordRelevance - a.keywordRelevance);
  withoutKw.sort((a, b) => a.hit.ageS - b.hit.ageS);
  return [...withKw, ...withoutKw].slice(0, SEMANTIC_CANDIDATES_PER_KIND);
}

/**
 * АДДИТИВНО вмешать семантическую близость в уже посчитанные keyword-списки.
 *
 * Гарантии:
 *  - Если эмбеддинги ОТКЛЮЧЕНЫ или query/кандидаты НЕ удалось получить —
 *    функция выходит, НИЧЕГО не изменив (recall == keyword-поведение).
 *  - Семантика ТОЛЬКО ДОБАВЛЯЕТ: повышает балл уже найденным и поднимает новые
 *    (keyword=0) кандидаты с близостью ≥ порога. Существующие hits не удаляются.
 */
async function enrichWithSemantics(
  topic: string,
  nowMs: number,
  groups: SemanticGroup[],
): Promise<void> {
  const config = getEmbeddingConfig();
  if (!isEmbeddingEnabled(config)) return; // OFF BY DEFAULT — мгновенный выход

  // 1. Эмбеддинг запроса (кэшируется). Сбой/недоступность → null → выходим.
  const queryVec = await embedQueryCached(topic, config, nowMs);
  if (!queryVec) return;

  // 2. Собираем ограниченный набор текстов кандидатов по всем группам.
  const selectedByGroup = groups.map((g) => selectSemanticCandidates(g.cands));
  const allTexts: string[] = [];
  for (const sel of selectedByGroup) {
    for (const c of sel) allTexts.push(c.embedText);
  }
  if (allTexts.length === 0) return;

  // 3. Эмбеддинг кандидатов (через кэш). Сбой → возможно частичная/пустая карта.
  const vecByText = await embedManyCached(allTexts, config, nowMs);
  if (vecByText.size === 0) return; // ничего не получили → keyword-поведение

  // 4. Аддитивный бленд по каждой группе.
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const selected = selectedByGroup[gi];
    const present = new Set(group.hits); // что уже в keyword-списке (по ссылке)
    let added = false;
    for (const cand of selected) {
      const vec = vecByText.get(cand.embedText);
      if (!vec) continue;
      const sim = cosineSimilarity(queryVec, vec);
      if (sim < SEMANTIC_MIN_SIMILARITY) continue;
      const bonus = SEMANTIC_WEIGHT * sim * cand.semScale;
      if (present.has(cand.hit)) {
        // Уже найден keyword — ПОВЫШАЕМ балл (аддитивно).
        cand.hit.score += bonus;
      } else {
        // keyword не нашёл — ДОБАВЛЯЕМ как семантический кандидат.
        cand.hit.score = SEMANTIC_ONLY_BASE_SCORE + bonus;
        group.hits.push(cand.hit);
        added = true;
      }
    }
    // Пересортировать только если бонусы/добавления могли изменить порядок.
    group.hits.sort((a, b) => b.score - a.score);
    void added;
  }
}

// ── Определение мода ─────────────────────────────────────────────────────────

// biome-ignore lint/complexity/noBannedTypes: Mod без состояния (read-only)
export const recallMod = createMod<{}>("recall", {
  category: "mechanic",
  description: "Кросс-чатовый ассоциативный поиск по памяти (факты + дневник + эпизоды)",
  depends: ["relationships", "memory"],
  topics: ["memory"],
  initialState: {},
})
  .query("recall", {
    params: z.object({
      topic: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .describe("Тема, имя или вопрос — что вспомнить (например 'проект X', 'Дэвид', 'отпуск')"),
    }),
    description:
      "Собрать всё, что помнишь по теме/человеку: факты из любого чата, недавние мысли и эпизоды. " +
      "Полезно для ответов 'что мы решили по…' / 'напомни про…'.",
    affordance: {
      priority: "capability",
      category: "memory",
      whenToUse:
        "When asked what was decided about something, or to recall a person/topic spanning chats",
      whenNotToUse: "When the current conversation already contains the answer",
    },
    returns:
      "{ topic: string; facts: Array<{text, about, ageS}>; thoughts: Array<{text, ageS}>; episodes: Array<{text, ageS}>; empty: boolean }",
    returnHint: "{topic, facts:[{text, about}], thoughts:[{text}], episodes:[{text}]}",
    async impl(ctx, args) {
      const topic = String(args.topic);
      const tokens = queryTokens(topic);
      const phrase = normalizeFactContent(topic);
      const nowMs = ctx.nowMs;

      // Текущая цель разговора (для scope-safety): канал + его тип.
      const memState = ctx.getModState<{ targetChatId: string | null }>("memory");
      const targetChatId = memState?.targetChatId ?? null;
      const currentChannelId = targetChatId
        ? (ensureChannelId(targetChatId) ?? targetChatId)
        : null;
      const currentChatType =
        currentChannelId && ctx.graph.has(currentChannelId)
          ? ctx.graph.getChannel(currentChannelId).chat_type
          : undefined;

      // Пулы СЕМАНТИЧЕСКИХ кандидатов: все элементы с текстом (в рамках scope),
      // даже те, что keyword-проход НЕ нашёл. Используются ТОЛЬКО при включённых
      // эмбеддингах. Если семантика выключена — пулы игнорируются.
      const factCands: SemanticCandidate[] = [];
      const thoughtCands: SemanticCandidate[] = [];
      const episodeCands: SemanticCandidate[] = [];

      // 1. Факты (любой контакт + self + kb), отфильтрованные по scope.
      const factHits: RecallHit[] = [];
      for (const f of allFacts(ctx.graph)) {
        const content = f.attrs.content ?? "";
        if (!content) continue;
        if (!visibleInScope(ctx.graph, f.attrs, currentChannelId, currentChatType)) continue;
        const createdMs = f.attrs.created_ms ?? f.attrs.last_access_ms ?? nowMs;
        const ageS = Math.max(0, (nowMs - createdMs) / 1000);
        // Извлекаемость как лёгкий вес: давно забытое слегка проседает,
        // но релевантность остаётся главным критерием.
        const r = factRetrievabilityFromNode(f.attrs, nowMs);
        const about = f.attrs.source_contact
          ? ctx.graph.has(f.attrs.source_contact)
            ? safeDisplayName(ctx.graph, f.attrs.source_contact)
            : null
          : null;
        const relevance = matchScore(tokens, phrase, content);
        const hit: RecallHit = {
          kind: "fact",
          text: content,
          about,
          ageS,
          score: combinedScore(relevance, ageS) * (0.6 + 0.4 * r),
        };
        // Семантический пул: embedText = content, score-добавка масштабируется на R.
        factCands.push({
          embedText: content,
          hit,
          keywordRelevance: relevance,
          semScale: 0.6 + 0.4 * r,
        });
        if (relevance < MIN_MATCH_SCORE) continue;
        factHits.push(hit);
      }
      factHits.sort((a, b) => b.score - a.score);

      // 2. Мысли дневника (рабочая память) — глобальный пул, scope не применяется
      //    (это внутренний мир Алисы, не чужие приватные данные).
      const thoughtHits: RecallHit[] = [];
      const diaryState = ctx.getModState<DiaryStateLike>("diary");
      for (const t of diaryState?.thoughts ?? []) {
        const ageS = Math.max(0, (nowMs - t.updatedAt) / 1000);
        const about =
          t.about && ctx.graph.has(t.about) ? safeDisplayName(ctx.graph, t.about) : null;
        const relevance = matchScore(tokens, phrase, t.content);
        const hit: RecallHit = {
          kind: "thought",
          text: t.content,
          about,
          ageS,
          score: combinedScore(relevance, ageS),
        };
        thoughtCands.push({ embedText: t.content, hit, keywordRelevance: relevance, semScale: 1 });
        if (relevance < MIN_MATCH_SCORE) continue;
        thoughtHits.push(hit);
      }
      thoughtHits.sort((a, b) => b.score - a.score);

      // 3. Эпизоды — просматриваем последние N, ранжируем по совпадению с целью/voice/outcome.
      const episodeHits: RecallHit[] = [];
      try {
        const rows = getDb()
          .select({
            id: episodes.id,
            target: episodes.target,
            voice: episodes.voice,
            outcome: episodes.outcome,
            triggerEvent: episodes.triggerEvent,
            createdMs: episodes.createdMs,
          })
          .from(episodes)
          .orderBy(desc(episodes.tickStart))
          .limit(EPISODE_SCAN_LIMIT)
          .all();
        for (const r of rows) {
          const targetName =
            r.target && ctx.graph.has(r.target) ? safeDisplayName(ctx.graph, r.target) : r.target;
          const haystack = [targetName, r.voice, r.outcome, r.triggerEvent]
            .filter(Boolean)
            .join(" ");
          if (!haystack) continue;
          const ageS = Math.max(0, (nowMs - (r.createdMs ?? nowMs)) / 1000);
          const desc = [targetName ?? "?", r.outcome].filter(Boolean).join(" — ");
          const relevance = matchScore(tokens, phrase, haystack);
          const hit: RecallHit = {
            kind: "episode",
            text: desc,
            about: targetName ?? null,
            ageS,
            score: combinedScore(relevance, ageS),
          };
          // Эпизод эмбеддим по haystack (богаче), но показываем desc.
          episodeCands.push({ embedText: haystack, hit, keywordRelevance: relevance, semScale: 1 });
          if (relevance < MIN_MATCH_SCORE) continue;
          episodeHits.push(hit);
        }
      } catch {
        /* эпизоды недоступны — не критично */
      }
      episodeHits.sort((a, b) => b.score - a.score);

      // ── СЕМАНТИЧЕСКИЙ БЛЕНД (ADDITIVE, OPTIONAL, GRACEFUL) ──────────────────
      // Если эмбеддинги выключены/недоступны — этот блок НИЧЕГО не делает, и
      // факты/мысли/эпизоды остаются ровно теми, что дал keyword/recency/graph.
      await enrichWithSemantics(topic, nowMs, [
        { hits: factHits, cands: factCands },
        { hits: thoughtHits, cands: thoughtCands },
        { hits: episodeHits, cands: episodeCands },
      ]);

      const facts = factHits.slice(0, MAX_FACTS);
      const thoughts = thoughtHits.slice(0, MAX_THOUGHTS);
      const eps = episodeHits.slice(0, MAX_EPISODES);
      const empty = facts.length === 0 && thoughts.length === 0 && eps.length === 0;

      return {
        topic,
        facts: facts.map((h) => ({ text: h.text, about: h.about, ageS: h.ageS })),
        thoughts: thoughts.map((h) => ({ text: h.text, ageS: h.ageS })),
        episodes: eps.map((h) => ({ text: h.text, ageS: h.ageS })),
        empty,
      };
    },
    format(result) {
      const r = result as {
        topic: string;
        facts: Array<{ text: string; about: string | null; ageS: number }>;
        thoughts: Array<{ text: string; ageS: number }>;
        episodes: Array<{ text: string; ageS: number }>;
        empty: boolean;
      };
      const m = new PromptBuilder();
      if (r.empty) {
        m.line(`Ничего конкретного по «${r.topic}» не всплывает.`);
        return m.build();
      }
      m.line(`Что всплывает по «${r.topic}»:`);
      if (r.facts.length > 0) {
        m.line("notes:");
        for (const f of r.facts) {
          const ago = f.ageS > 0 ? humanDurationAgo(f.ageS) : "";
          const who = f.about ? ` (${f.about})` : "";
          const when = ago ? ` — ${ago}` : "";
          m.list([`${f.text}${who}${when}`]);
        }
      }
      if (r.thoughts.length > 0) {
        m.line("мысли:");
        for (const t of r.thoughts) {
          const ago = t.ageS > 0 ? humanDurationAgo(t.ageS) : "";
          const when = ago ? ` — ${ago}` : "";
          m.list([`${t.text}${when}`]);
        }
      }
      if (r.episodes.length > 0) {
        m.line("эпизоды:");
        for (const e of r.episodes) {
          const ago = e.ageS > 0 ? humanDurationAgo(e.ageS) : "";
          const when = ago ? ` — ${ago}` : "";
          m.list([`${e.text}${when}`]);
        }
      }
      return m.build();
    },
  })
  .build();

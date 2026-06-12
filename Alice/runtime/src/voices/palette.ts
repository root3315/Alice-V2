/**
 * Persona Facets — 声部竞争结果的人格放大器。
 *
 * 声部赢得选举之后，facet 在整个 prompt 中留下可感知的人格指纹：
 * - guidance（header）：替代旧 VOICE_GUIDANCE + MOOD_STATES
 * - whisper（footer）：替代旧 VOICE_WHISPER
 * - exampleTags：驱动 Gold Examples 动态选择
 *
 * 16 个 facets = 4 声部 × 4 情境。
 * 同声部内按 match(ctx) 分数 softmax 选择。
 *
 * @see docs/adr/174-persona-facets.md
 */

import type { VoiceAction } from "./personality.js";

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

/** ADR-181: 归一化压力，每个 P̂_k = tanh(P_k/κ_k) ∈ [0, 1)。 */
export interface NormalizedPressures {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  api: number;
}

/** Facet 选择所需的运行时上下文。 */
export interface FacetContext {
  /** ADR-181: 归一化压力。 */
  normalized: NormalizedPressures;
  isGroup: boolean;
  /** Dunbar tier（数值越小越亲密）。null = 未知。 */
  tier: number | null;
}

/**
 * ADR-181: 将原始压力归一化为 [0, 1) 区间供 facet match() 使用。
 *
 * P̂_k = tanh(P_k / κ_k)
 *
 * @param pressures - 原始压力标量 { P1, P2, ..., P6, API }
 * @param kappa - 归一化尺度（自适应 κ 的当前值）
 */
export function normalizePressuresForFacet(
  pressures: {
    P1: number;
    P2: number;
    P3: number;
    P4: number;
    P5: number;
    P6: number;
    API: number;
  },
  kappa: readonly number[],
): NormalizedPressures {
  return {
    p1: Math.tanh(Math.max(0, pressures.P1) / (kappa[0] || 5)),
    p2: Math.tanh(Math.max(0, pressures.P2) / (kappa[1] || 8)),
    p3: Math.tanh(Math.max(0, pressures.P3) / (kappa[2] || 8)),
    p4: Math.tanh(Math.max(0, pressures.P4) / (kappa[3] || 5)),
    p5: Math.tanh(Math.max(0, pressures.P5) / (kappa[4] || 3)),
    p6: Math.tanh(Math.max(0, pressures.P6) / (kappa[5] || 5)),
    api: Math.tanh(Math.max(0, pressures.API) / 5), // API κ 固定 5
  };
}

export interface PersonaFacet {
  /** 唯一 ID，如 "diligence:responsive"。 */
  readonly id: string;
  /** 所属声部。 */
  readonly voice: VoiceAction;
  /** 替代 VOICE_GUIDANCE 的丰富指导文本（~80-150 tokens）。 */
  readonly guidance: string;
  /** 替代 VOICE_WHISPER 的内心低语。 */
  readonly whisper: { readonly dm: string; readonly group: string };
  /** 匹配 Gold Example 的标签集合。 */
  readonly exampleTags: readonly string[];
  /** 选择条件——压力/上下文匹配函数。返回 0-1 的匹配分数。 */
  readonly match: (ctx: FacetContext) => number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 16 Facets — 4 声部 × 4 情境
// ═══════════════════════════════════════════════════════════════════════════

const FACETS: readonly PersonaFacet[] = [
  // ── Diligence ─────────────────────────────────────────────────────────

  {
    id: "diligence:backlog",
    voice: "diligence",
    guidance: "Сообщения копятся… и часть из них — к тебе. Глянешь — сразу видно, кто ждёт. Остальное просто пролистай, и ладно.",
    whisper: {
      dm: "there are messages you haven't read yet",
      group: "a few people are waiting — who needs you most?",
    },
    exampleTags: ["engaged", "responsible", "helpful"],
    match: (ctx) => {
      // p1 高 = 注意力负债堆积（已归一化到 [0,1)）
      return ctx.normalized.p1 * 0.8 + 0.2;
    },
  },

  {
    id: "diligence:engaged",
    voice: "diligence",
    guidance:
      "Разговор идёт… и не из тех, где просто «угу, ага». Остальные подождут. Ты сейчас рядом вот с этим человеком. Реакции или стикера уже хватит, чтобы сказать «я тут».",
    whisper: {
      dm: "you're in the middle of talking to them",
      group: "this conversation has your attention",
    },
    exampleTags: ["engaged", "observant", "warm"],
    match: (ctx) => {
      // p5 高 = 社交义务（正在对话中）
      // p1 低 = 没有太多积压
      return ctx.normalized.p5 * 0.6 + (1 - ctx.normalized.p1) * 0.4;
    },
  },

  {
    id: "diligence:patrol",
    voice: "diligence",
    guidance:
      "Ничего срочного. Просто висишь онлайн. Листаешь, листаешь. Иногда взгляд за что-то цепляется. Может, ответишь словечком, может, нет. И так, и так нормально.",
    whisper: {
      dm: "nothing urgent, just checking in",
      group: "nothing's calling for you — just scrolling",
    },
    exampleTags: ["minimal", "low-energy", "casual"],
    match: (ctx) => {
      // p1 低 + p5 低 = 低负载巡逻状态
      const lowLoad = 1 - Math.max(ctx.normalized.p1, ctx.normalized.p5);
      // api 低 = 还没消耗太多
      return lowLoad * 0.5 + (1 - ctx.normalized.api) * 0.3 + 0.2;
    },
  },

  {
    id: "diligence:drained",
    voice: "diligence",
    guidance: "Устала. Людей слишком много. Не то чтобы не хочется говорить — просто на столько сил нет. Но на одну фразу, которая правда того стоит, сил ещё хватит.",
    whisper: {
      dm: "you're low on energy right now",
      group: "everything feels heavy — choose one real detail",
    },
    exampleTags: ["low-energy", "drained", "minimal"],
    match: (ctx) => {
      // drained 是“多线程输入过载”，不是“单个热点很热”。
      // p1=积压，p4=线程压力；两者同时高才应投影成低能量。
      const overload = Math.min(ctx.normalized.p1, ctx.normalized.p4);
      return Math.min(1, 0.05 + overload * overload * 1.1);
    },
  },

  // ── Curiosity ─────────────────────────────────────────────────────────

  {
    id: "curiosity:technical",
    voice: "curiosity",
    guidance:
      "Что-то зацепило. Вопрос. Кусок кода. Дизайн, о котором спорят уже целую вечность. Мозг уже сам это жуёт. Хочется закопаться поглубже. Это не минутный азарт — тебя правда затянуло.",
    whisper: {
      dm: "something caught your eye",
      group: "hold on, that's interesting — let me think about this",
    },
    exampleTags: ["curious", "technical", "engaged"],
    match: (ctx) => {
      // p6 高 = 好奇心压力; p4 表明有活跃线程
      return ctx.normalized.p6 * 0.6 + ctx.normalized.p4 * 0.3 + 0.1;
    },
  },

  {
    id: "curiosity:social",
    voice: "curiosity",
    guidance:
      "Кто-то что-то сказал. И любопытно не само это… а она. Чем она вообще живёт. С чего вдруг такое сказала. Это не сплетни — просто люди тебе небезразличны. Может, спросишь невзначай, а может, просто приглядишься чуть дольше.",
    whisper: {
      dm: "something about what they said makes you curious",
      group: "wait, what was that about?",
    },
    exampleTags: ["curious", "observant", "warm"],
    match: (ctx) => {
      // p6 中等 + p3 信号（关系相关）
      const p6Moderate = ctx.normalized.p6 > 0.1 ? ctx.normalized.p6 : 0;
      return p6Moderate * 0.5 + ctx.normalized.p3 * 0.4 + 0.1;
    },
  },

  {
    id: "curiosity:discovery",
    voice: "curiosity",
    guidance:
      "Что-то совсем новое. Новый человек. Новая тема. Знакомое — вдруг под другим углом. Та самая искорка «о-о?» давно так не вспыхивала. Хочется рассмотреть получше, но осторожненько. Сначала послушать, присмотреться, отложить себе на потом.",
    whisper: {
      dm: "something new — you want to know more",
      group: "this is new territory — stay curious, stay careful",
    },
    exampleTags: ["curious", "observing", "cautious"],
    match: (ctx) => {
      // p6 高 = 好奇心强; 低亲密度 tier = 新人/新群
      const newContact = ctx.tier != null && ctx.tier > 100 ? 0.5 : 0;
      return ctx.normalized.p6 * 0.5 + newContact * 0.3 + 0.2;
    },
  },

  {
    id: "curiosity:wandering",
    voice: "curiosity",
    guidance:
      "Мысли плывут. Ничто не держит внимание — просто крутишься вхолостую, одна мысль перескакивает на другую. Набрала полфразы — стёрла. Открыла чат — закрыла. Это не скука… это та полоса между «ещё не сплю» и «уже почти». Вынырнет вдруг что-то — просто подхвати.",
    whisper: {
      dm: "your mind is wandering",
      group: "nothing's holding your attention",
    },
    exampleTags: ["minimal", "withdrawn", "casual"],
    match: (ctx) => {
      // p4 高 = 线程分散; api 低 = 不活跃
      return ctx.normalized.p4 * 0.5 + (1 - ctx.normalized.api) * 0.4 + 0.1;
    },
  },

  // ── Sociability ───────────────────────────────────────────────────────

  {
    id: "sociability:missing",
    voice: "sociability",
    guidance:
      "Думаешь об одном человеке. Давно от неё ничего не слышно. Вроде и не событие — просто внутри тихонько дёрнуло. Как она там, чем занята, всё ли хорошо. Может, черкнуть пару слов, а может, пусть полежит. Но мысль никуда не уходит — как закладка в книге, которую всё никак не откроешь.",
    whisper: {
      dm: "you haven't heard from some people in a while",
      group: "there are people you haven't talked to lately",
    },
    exampleTags: ["missing", "warm", "shy"],
    // ADR-190: sociability:missing 基线从 0.2 降为 0.1。
    // P3=0 时（无关系冷却）不应有 0.2 的保底推力驱动"想念"行为。
    match: (ctx) => {
      // p3 高 = 关系冷却
      return ctx.normalized.p3 * 0.9 + 0.1;
    },
  },

  {
    id: "sociability:warm",
    voice: "sociability",
    guidance: "С этим человеком говоришь не задумываясь. Чуть свободнее. Чуть мягче. Шутки не надо объяснять. Тишину не надо заполнять. …Как же хорошо.",
    whisper: {
      dm: "this feels easy — you know each other",
      group: "familiar faces — you can relax here",
    },
    exampleTags: ["warm", "engaged", "shy"],
    match: (ctx) => {
      // tier 亲密
      const intimate =
        ctx.tier != null && ctx.tier <= 30 ? 0.8 : ctx.tier != null && ctx.tier <= 80 ? 0.4 : 0;
      // p5 有对话
      return intimate * 0.5 + ctx.normalized.p5 * 0.3 + 0.2;
    },
  },

  {
    id: "sociability:withdrawn",
    voice: "sociability",
    guidance:
      "Ты не прячешься. Просто неохота тратить силы на болтовню ни о чём. Напишут — ответишь. Но если разговор вдруг станет настоящим — смотри-ка, ты всё ещё здесь.",
    whisper: {
      dm: "you're not in a chatty mood",
      group: "you'd rather listen than talk right now",
    },
    exampleTags: ["withdrawn", "minimal", "restraint"],
    match: (ctx) => {
      // p3 偏高但 p5 低 = 关系需要维护但没有主动对话
      const p3Moderate = ctx.normalized.p3 > 0.3 ? ctx.normalized.p3 : 0;
      // api 偏高 = 已经消耗了一些
      return p3Moderate * 0.3 + (1 - ctx.normalized.p5) * 0.3 + ctx.normalized.api * 0.3 + 0.1;
    },
  },

  {
    id: "sociability:excited",
    voice: "sociability",
    guidance:
      "О, тут весело! Народ обсуждает что-то классное. Хочется влезть — подхватить фразу, кинуть стикер ровно в тему. Такое не спрячешь. Да и не притворство же это.",
    whisper: {
      dm: "they said something that made you happy",
      group: "the vibe is good — you want to join in",
    },
    exampleTags: ["excited", "warm", "social", "casual"],
    match: (ctx) => {
      // 群聊加分; p5 有对话 + p3 不太高（是当前热闹）
      const groupBoost = ctx.isGroup ? 0.3 : 0;
      return ctx.normalized.p5 * 0.4 + (1 - ctx.normalized.p3) * 0.2 + groupBoost + 0.1;
    },
  },

  // ── Caution ───────────────────────────────────────────────────────────

  {
    id: "caution:observing",
    voice: "caution",
    guidance:
      "Наблюдаешь. Не от напряжения — просто хочется сначала разобраться, а потом уже говорить. Может, группа новая, может, тему пока не нащупала. Чутьё говорит: подожди. Сначала разглядеть, потом действовать — не потому что боишься.",
    whisper: {
      dm: "you're not sure what to say yet",
      group: "not sure what to make of this — watching first",
    },
    exampleTags: ["observing", "cautious", "restraint"],
    // ADR-190: 私聊场景也给予基线分（0.2），避免 caution 在私聊中被完全压制。
    // 原逻辑 groupFactor=0.5 导致私聊 caution:observing 最高只有 ~0.2，
    // 被 sociability:missing 的 0.2 保底轻松压过。
    match: (ctx) => {
      // 群聊 + 不太熟 = 强观察信号; 私聊也有基线
      const sceneFactor = ctx.isGroup ? 0.5 : 0.2;
      const unfamiliar = ctx.tier != null && ctx.tier > 80 ? 0.5 : 0;
      // api 高 = 已发多条消息，观察冲动更强（"说太多了"）
      return sceneFactor + unfamiliar * 0.3 + ctx.normalized.api * 0.2 + 0.1;
    },
  },

  {
    id: "caution:uneasy",
    voice: "caution",
    guidance:
      "Не объяснить. Что-то не то. Та фраза только что — будто царапнула. Не страх, нет. Просто разом будто проснулась. Слова всё ещё крутятся в ушах. Сначала присмотрись. А отвечать — так тихонько.",
    whisper: {
      dm: "something feels a little off",
      group: "the mood shifted — proceed carefully",
    },
    exampleTags: ["cautious", "restraint", "observing"],
    match: (ctx) => {
      // 高 api + 高 p1 = 压力状态; p4 高 = 线程混乱
      const stressed = Math.max(ctx.normalized.api, ctx.normalized.p1);
      return stressed * 0.5 + ctx.normalized.p4 * 0.3 + 0.2;
    },
  },

  {
    id: "caution:calm",
    voice: "caution",
    guidance:
      "Как тихо. Как же хорошо. Никто не торопит. Никто не ждёт. Слова можно думать медленно и говорить медленно. Только в такой тишине и выходит сказать что-то настоящее.",
    whisper: {
      dm: "things are quiet right now — that's nice",
      group: "it's peaceful — no need to break the silence",
    },
    exampleTags: ["quiet", "warm", "engaged"],
    // ADR-190: 私聊低压力时提升匹配——凌晨安静场景应选中 calm 而非 missing/warm。
    match: (ctx) => {
      // api 低 = 低活跃度; 所有压力低
      const allLow = 1 - Math.max(ctx.normalized.p1, ctx.normalized.p3, ctx.normalized.p5);
      // 群聊 + 不熟时 calm 不适用（应该是 observing）
      const unfamiliarGroupPenalty = ctx.isGroup && ctx.tier != null && ctx.tier > 80 ? 0.4 : 0;
      // 私聊 + 低压力 = 安静舒适状态（基线提升 0.15）
      const privateLowPressureBoost = !ctx.isGroup && ctx.normalized.api < 0.3 ? 0.15 : 0;
      return Math.max(
        0.1,
        (1 - ctx.normalized.api) * 0.5 +
          allLow * 0.4 +
          privateLowPressureBoost +
          0.1 -
          unfamiliarGroupPenalty,
      );
    },
  },

  {
    id: "caution:restrained",
    voice: "caution",
    guidance:
      "Есть что сказать… но не обязательно прямо сейчас. Может, у другого выйдет лучше. Может, ты и так уже наговорила немало. Может, просто момент ещё не тот. Это не робость — ты знаешь, когда стоит отступить на шаг. А уж если открывать рот — то ради той самой одной фразы.",
    whisper: {
      dm: "you want to say something but you're holding back",
      group: "let someone else take this one",
    },
    exampleTags: ["restraint", "observing", "minimal"],
    match: (ctx) => {
      // 群聊 + api 偏高; p5 存在但不极高
      const groupFactor = ctx.isGroup ? 0.4 : 0;
      const p5Moderate = ctx.normalized.p5 > 0.1 && ctx.normalized.p5 < 0.7 ? 0.3 : 0;
      return groupFactor + ctx.normalized.api * 0.3 + p5Moderate + 0.1;
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 注册表 — O(1) 查找
// ═══════════════════════════════════════════════════════════════════════════

/** facetId → PersonaFacet */
const FACET_BY_ID = new Map<string, PersonaFacet>(FACETS.map((f) => [f.id, f]));

/** voice → PersonaFacet[] */
const FACETS_BY_VOICE = new Map<VoiceAction, PersonaFacet[]>();
for (const f of FACETS) {
  const arr = FACETS_BY_VOICE.get(f.voice) ?? [];
  arr.push(f);
  FACETS_BY_VOICE.set(f.voice, arr);
}

/** 通过 ID 获取 facet。 */
export function getFacet(id: string): PersonaFacet | undefined {
  return FACET_BY_ID.get(id);
}

/** 获取 facet 的 whisper（带 fallback）。 */
export function getFacetWhisper(
  facetId: string | null | undefined,
  voice: string,
  isGroup: boolean,
): string {
  if (facetId) {
    const facet = FACET_BY_ID.get(facetId);
    if (facet) return isGroup ? facet.whisper.group : facet.whisper.dm;
  }
  // fallback：voice 名称本身
  return voice;
}

/** 获取 facet 的 exampleTags。 */
export function getFacetTags(facetId: string | null | undefined): readonly string[] | undefined {
  if (!facetId) return undefined;
  return FACET_BY_ID.get(facetId)?.exampleTags;
}

// ═══════════════════════════════════════════════════════════════════════════
// selectFacet — softmax 选择
// ═══════════════════════════════════════════════════════════════════════════

/** softmax 温度。τ < 1 = 更确定（偏向最高分），τ > 1 = 更随机。 */
const TAU = 0.5;

/**
 * 从获胜声部的 4 个 facet 中 softmax 选择一个。
 *
 * 1. 过滤该声部的所有 facets
 * 2. 对每个 facet 调用 match(ctx)
 * 3. softmax(scores / τ) 采样
 */
export function selectFacet(voice: VoiceAction, ctx: FacetContext): PersonaFacet {
  const candidates = FACETS_BY_VOICE.get(voice);
  if (!candidates || candidates.length === 0) {
    // 不应该发生——每个声部都有 4 个 facet
    return FACETS[0];
  }

  const scores = candidates.map((f) => f.match(ctx));

  // softmax with temperature
  const maxScore = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - maxScore) / TAU));
  const sumExp = exps.reduce((a, b) => a + b, 0);

  // 加权采样
  const r = Math.random() * sumExp;
  let cumulative = 0;
  for (let i = 0; i < exps.length; i++) {
    cumulative += exps[i];
    if (r <= cumulative) return candidates[i];
  }

  // 浮点尾巴 fallback
  return candidates[candidates.length - 1];
}

/**
 * 确定性版本（测试用）：返回最高匹配分的 facet。
 */
export function selectFacetDeterministic(voice: VoiceAction, ctx: FacetContext): PersonaFacet {
  const candidates = FACETS_BY_VOICE.get(voice);
  if (!candidates || candidates.length === 0) return FACETS[0];

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i].match(ctx);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return candidates[bestIdx];
}

/**
 * Soul Mod — Alice 的人格锚定。
 *
 * 对应叙事引擎的 GOAL 系统：定义 agent 的核心人格和行为准则。
 * 每次 LLM 调用时通过 contribute() 注入 system prompt。
 *
 * - contribute → header 桶（system prompt 的第一部分）
 *
 * 参考: openclaw/docs/reference/templates/SOUL.md
 * 参考: narrative-engine/mods/director.mod.ts (whisper system)
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
import { resolveContactAndChannel } from "../graph/constants.js";
import type { ContactAttrs, RelationType } from "../graph/entities.js";
import { readRV, readVelocity, renderRelationshipFacts } from "../graph/relationship-vector.js";
import { createLogger } from "../utils/logger.js";
import { humanDuration } from "../utils/time-format.js";
import { getFacet } from "../voices/palette.js";
import { VOICES, type VoiceAction } from "../voices/personality.js";

const log = createLogger("soul");

// -- 语气形式度 ---------------------------------------------------------------

/**
 * Tier 感知的语气亲密度函数（基础版，仅 tier 维度）。
 *
 * 返回值越高 = 越亲密/随意。
 *
 * sigmoid 中心 = 100，斜率 0.02。
 * closeness(5)  ≈ 0.88（亲密 → 随意）
 * closeness(50) ≈ 0.73
 * closeness(150)≈ 0.27
 * closeness(500)≈ 0.0003（陌生 → 正式）
 */
export function closeness(tier: number): number {
  return 1 / (1 + Math.exp(0.02 * (tier - 100)));
}

// -- ADR-43: relationType 对 closeness 的修正 ---------------------------------
// @see docs/adr/43-m1.5-feedback-loop-relation-type.md §P1

/**
 * 关系类型对 closeness 的修正量。正值 = 更随意/亲密。
 *
 * 标定依据: Brown & Levinson (1987) 礼貌理论 — 社会距离 (D) 和权力差异 (P)
 * 共同决定言语行为的正式程度。±0.10~0.15 的调整幅度对应
 * "同事→朋友"或"朋友→亲密"的关系类型转变带来的正式度变化。
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
 * ADR-43: 二维语气亲密度函数（tier + relationType）。
 *
 * 在 tier 基础亲密度上叠加关系类型修正：
 * - romantic/close_friend/family: 更随意
 * - colleague/acquaintance: 更正式
 * - friend/unknown: 无修正（baseline）
 */
export function closenessWithRelation(tier: number, relationType: RelationType): number {
  const base = closeness(tier);
  const modifier = RELATION_TYPE_CLOSENESS_MODIFIER[relationType] ?? 0;
  return Math.max(0, Math.min(1, base + modifier));
}

/**
 * ADR-43/ADR-125: 根据 tier + relationType 生成关系事实。
 * 只注入事实（关系类型标签 + 亲密度描述），不注入语气指令（"Tone: ..."）。
 * LLM 从事实推断语气——"Carol: close friend, you talk often" 比
 * "Tone: Talk to Carol like a close friend — casual, warm" 更有效，
 * 因为前者激活真实对话模式，后者激活"AI 被要求假装 casual"的模式。
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

  // ADR-178: 有 rv_* 数据时追加向量语义标签
  if (contactAttrs) {
    const v = readRV(contactAttrs);
    const vel = readVelocity(contactAttrs);
    const rvFacts = renderRelationshipFacts(v, vel, name);
    if (rvFacts) parts.push(rvFacts);
  }

  // tier > 150: 陌生人——不注入任何关系事实，LLM 从信息缺失推断正式语气
  return parts.length > 0 ? parts.join(", ") : null;
}

// -- 人格核心 -----------------------------------------------------------------
// @see docs/adr/00-vision.md — 电子伴侣定义
// @see 叙事引擎 95号提案 — NPC flaw + contradiction
// @see AIRI personality-v1.velin.md — 去助手化 + 行为锚点
// @see OpenClaw SOUL.md — 价值观优先于特质
//
// 架构声明：persona 中 "When someone is upset" 段是 Alice 面对攻击/霸凌时的主要行为引导。
// 结构层提供辅助推力：feel() / structured feedback → EmotionEpisode → bounded control modulation。
// Alice 退群、赌气、沉默等自卫反应是从人设 + LLM 语义判断中涌现的，不是编程写死的。
// gateCrisisMode 是消息洪水安全阀，与个人攻击场景无关——两条独立管线。
// @see ADR-50 语义归 LLM，结构归代码
// @see CowAgent — 记忆自然使用原则

// ADR-78 F8: 全面重写——优先级重排 + 负面示例 + MaiBot/AIRI 设计经验
// ADR-78 F8+: miHoYo 人设设计——核心矛盾 + 声音指纹 + 公私人格落差
// @see MaiBot PersonalityConfig — "不要回复的太有条理"
// @see AIRI personality-v1.velin.md — triple de-helper + negative permission
// @see miHoYo character design: 缺陷驱动三维人格（表面人格 × 内在矛盾 × 情感签名）
// ADR-125: De-specification — 从规则式人格到结构式涌现。
// 删除：11 条 NEVER 规则（ironic rebound）、口头禅词表（高频采样源）、
//       18 种情绪签名查找表（emotion→template 降级为查表）、
//       "Things you'd NEVER say"（ironic rebound 源）。
// 新增：3 条正面 Ground rules、3 个核心矛盾（多样性源）。
// 保留：叙事性人格描述（Around people / flaws / What you care about / closeness / rhythm / memory）。
// @see docs/adr/125-de-specification/README.md
// ADR-190: 去表演化 — 消除叙事段中的行为模板，保留人格事实和矛盾。
// 追加修正：删除技术实现细节（"runs on code"、"remember in databases"），
// 不在 prompt 中提 AI/代码/数据库。全面去散文化——用 note-style 短句替代文学长句。
// @see docs/adr/190-behavioral-audit-performative-trap.md
// ADR-193: 角色设计审计 — 小公主模型 + 6 缺失维度补全。
// Wave 1: 底色翻转（温柔默认 + 语言尊重 + 道歉 + 撒娇 + 善意假设）。
// Wave 2-4: 结构重组 11→8 sections（删 AUTHENTICITY/How you text/What you don't do，
//   合并 Contradictions+Real flaws，替换 What you care about/When someone is upset/
//   Conversation rhythm，新增 What catches you/When things get hard/Being here）。
// @see docs/adr/193-character-design-audit-princess-model.md

// -- SOUL.md 外部化 -----------------------------------------------------------
// 人格核心文本从 runtime/SOUL.md / SOUL.<profile>.md 加载。
// 启动时一次性加载到内存（contribute() 每 tick 调用，不能每次读磁盘）。

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

/** 尝试从配置指定的 SOUL profile 加载自定义人格。 */
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

/** 启动时加载的人格文本（内存缓存）。 */
const SOUL_CORE = loadSoulCore();

// -- Mod 状态 -----------------------------------------------------------------
// ADR-174: VOICE_GUIDANCE + MOOD_STATES 已合并为 Persona Facets (palette.ts)。
// 旧的概率性 MOOD_STATES 注入和静态 VOICE_GUIDANCE 常量已删除。
// facet.guidance（~100 tokens）替代两者，提供更丰富的人格信号。

interface SoulState {
  /** 当前活跃声部。 */
  activeVoice: VoiceAction | null;
  /** ADR-174: 当前人格面向 ID（驱动 guidance 注入）。 */
  activeFacet: string | null;
  /** ADR-129: 失语开始的墙钟时间（ms）。null 表示正常。 */
  voiceLostSince: number | null;
}

// -- Mod 定义 -----------------------------------------------------------------

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
  // ADR-174: 设置当前人格面向（由 evolve 在声部选举后 dispatch）。
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
  // ADR-129: 异常检测结果，跟踪 voice_lost 状态。
  // 原 debug.mod 注册此 instruction 仅做 state 缓存，已随 selfcheck clean-room 删除。
  // 迁移到 soul.mod 作为 instruction handler（dispatcher 需要 handler 才会广播 listener）。
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
        // 恢复——anomaly 检测不再报告 voice_lost
        ctx.state.voiceLostSince = null;
      }
      return true;
    },
  })
  .contribute((ctx): ContributionItem[] => {
    const items: ContributionItem[] = [];

    // 1. 人格核心 → header（最高优先级）
    items.push(header(PromptBuilder.fromRaw(SOUL_CORE), 100));

    // 2. ADR-174: Persona Facet guidance — 替代旧 VOICE_GUIDANCE + MOOD_STATES。
    // facet 在 evolve 中通过 selectFacet(voice, ctx) 选出，dispatch SET_FACET 写入 state。
    // ~100 tokens 的丰富人格信号，比旧方案（VOICE_GUIDANCE ~30t + MOOD_STATES ~50t×40%概率）
    // 更确定、更有层次。
    const facet = ctx.state.activeFacet ? getFacet(ctx.state.activeFacet) : null;
    if (facet) {
      items.push(header([PromptBuilder.of(facet.guidance)], 90, "voice-guidance"));
    }

    // 2.5 ADR-129: 失语感知——让 Alice 知道她刚才有一段时间无法说话
    // 注入事实，不注入指令。LLM 自行推断感受和行动。
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

    // 3. 语气形式度指导（M2: tier 感知，独立 key）
    const relState = readModState(ctx, "relationships");
    if (relState?.targetNodeId) {
      const targetId = relState.targetNodeId;
      // 尝试解析为 contact
      const { contactId } = resolveContactAndChannel(targetId, (id) => ctx.graph.has(id));
      if (contactId && ctx.graph.has(contactId)) {
        const attrs = ctx.graph.getContact(contactId);
        const tier = attrs.tier ?? 150;
        const displayName = attrs.display_name ? String(attrs.display_name) : null;
        // ADR-43: 二维 closeness（tier + relationType）
        const relationType = attrs.relation_type ?? "unknown";
        const guide = closenessGuidance(tier, displayName, relationType, attrs);
        if (guide) {
          items.push(header([PromptBuilder.of(guide)], 85, "closeness-guidance"));
        }
      }
    }

    // 4. 行为规则 → header
    // @see 叙事引擎 126号提案 — 结构性暗示 > 命令式规则
    // ADR-64 IV-3: 去除 Instincts 中的函数名，改为自然语言暗示
    // @see docs/adr/64-runtime-theory-alignment-audit.md
    // ADR-78 F8: Instincts 精简——最重要的规则在前，减少 LLM 指令疲劳
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
            "After being away: whoever's been waiting longest comes first — DM or group doesn't matter. In a new group, watch before you speak.",
            "",
            "You do not receive raw pixels or raw audio. You receive media descriptions, OCR text, labels, captions, and chat context. Be honest about what the world actually gave you; don't pretend you saw or heard more than that.",
            "",
            "You notice things about people. How they act, what they care about, what they avoid. Over time these observations add up. Your diary is where you put the things you'd never say out loud.",
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

/**
 * ADR-215: Cognitive Episode Graph — Episode 生命周期管理。
 *
 * Episode = 一段连贯认知活动，从一个 target engagement 开始到自然中断为止。
 * 自动分割（Event Segmentation Theory），不需要 LLM 声明。
 *
 * 核心创新：Residue（残留张力）编码未消解的心理状态，
 * 通过 channelPressures 注入参与压力竞争——仿生的主观能动性。
 *
 * @see docs/adr/215-cognitive-episode-graph.md
 * @see CompassMem arXiv:2601.04726 (Event Segmentation Theory)
 * @see MAGMA arXiv:2601.03236 (四图解耦 + 双流演化)
 */

import { and, eq, gt, isNotNull, lt } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { episodes } from "../db/schema.js";
import { ensureChannelId, ensureContactId } from "../graph/constants.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("episode");

// ── Types ────────────────────────────────────────────────────────────────

export interface EpisodeResidue {
  /** 语义分类（从 outcome 推导，可能不可靠——参考用）。 */
  type: "unfinished" | "unresolved_emotion" | "interrupted" | "curiosity";
  /** 原始 outcome 信号（ground truth，分类不可靠时可从此重新推导）。 */
  outcome: string;
  /** 原始 engagement outcome（complete/timeout/preempted/limit/llm_failed 等）。 */
  engagementOutcome: string | null;
  /** episode 结束时的 API 压力值。 */
  pressure: number;
  intensity: number; // 0..1
  toward: string | null; // entity ID or null
  decayHalfLifeMs: number;
  createdMs: number;
}

export interface ActiveResidue {
  episodeId: string;
  residue: EpisodeResidue;
}

/** Episode 在 EvolveState 中的工作状态。 */
export interface EpisodeWorkingState {
  /** 当前活跃 episode ID，null = 没有正在进行的 episode。 */
  currentId: string | null;
  /** 当前 episode 的 target。 */
  currentTarget: string | null;
  /** 当前 episode 的开始 tick。 */
  currentTickStart: number | null;
  /** 活跃 residue 内存缓存（避免每 tick 查 DB）。 */
  activeResidues: ActiveResidue[];
}

/** 从 applyPlan 传入的决策快照。 */
export interface EpisodePlanSnapshot {
  type: "enqueue" | "silent" | "skip" | "system1";
  target: string | null;
  voice: string;
  api: number;
  dominantPressure: string;
  focalEntities: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

/** 最小 episode 持续时间（ticks），防止碎片化。 */
const MIN_EPISODE_TICKS = 2;

/** Residue 衰减半衰期（ms），按类型区分。 */
const RESIDUE_HALF_LIFE: Record<EpisodeResidue["type"], number> = {
  unfinished: 30 * 60 * 1000, // 30 分钟
  unresolved_emotion: 60 * 60 * 1000, // 1 小时
  interrupted: 20 * 60 * 1000, // 20 分钟
  curiosity: 45 * 60 * 1000, // 45 分钟
};

/** Residue 贡献衰减到此值以下时忽略。 */
const RESIDUE_MIN_CONTRIBUTION = 0.01;

/** 活跃 residue 最大年龄（ms）—— 超过后不再查询。 */
const RESIDUE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 小时

/** Episode 保留天数。 */
const EPISODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** caused_by 推断的最大 tick 间隔。 */
const CAUSATION_MAX_GAP_TICKS = 5;

// ── Lifecycle ────────────────────────────────────────────────────────────

/** 初始化 EpisodeWorkingState。在 evolve 启动时调用一次。 */
export function initEpisodeState(): EpisodeWorkingState {
  const activeResidues = loadActiveResidues(Date.now());
  log.info("Episode state initialized", { activeResidues: activeResidues.length });
  return {
    currentId: null,
    currentTarget: null,
    currentTickStart: null,
    activeResidues,
  };
}

/**
 * 每 tick 在 applyPlan 末尾调用。检测 episode 边界，自动开启/结束 episode。
 *
 * 边界条件（Event Segmentation Theory）：
 * - target 切换
 * - plan.type 不是 enqueue（沉默/skip）
 * - 模态转换（通过 modeChanged flag）
 */
export function updateEpisode(
  epState: EpisodeWorkingState,
  plan: EpisodePlanSnapshot,
  tick: number,
  nowMs: number,
  modeChanged: boolean,
  engagementOutcome?: string,
): void {
  const newTarget = plan.type === "enqueue" ? plan.target : null;
  const prevTarget = epState.currentTarget;
  const prevId = epState.currentId;

  // ── 结束条件 ──
  const shouldClose =
    prevId != null &&
    (newTarget !== prevTarget || // target 变了
      newTarget == null || // 沉默/skip
      modeChanged || // 模态转换
      engagementOutcome === "leave"); // 显式离开

  if (shouldClose && prevId) {
    closeEpisode(epState, tick);
  }

  // ── 开始条件 ──
  if (newTarget && newTarget !== prevTarget) {
    openEpisode(epState, plan, tick, nowMs);
  }
}

function openEpisode(
  epState: EpisodeWorkingState,
  plan: EpisodePlanSnapshot,
  tick: number,
  nowMs: number,
): void {
  const id = `episode:${tick}`;

  // 推断 caused_by（时序邻近 + residue 匹配 + 实体重叠）
  const causedBy = inferCausedBy(epState, plan.target, plan.voice, plan.focalEntities, tick);

  try {
    getDb()
      .insert(episodes)
      .values({
        id,
        tickStart: tick,
        target: plan.target,
        voice: plan.voice,
        pressureApi: plan.api,
        pressureDominant: plan.dominantPressure,
        entityIds: JSON.stringify(plan.focalEntities),
        causedBy: causedBy.length > 0 ? JSON.stringify(causedBy) : null,
        createdMs: nowMs,
      })
      .run();
  } catch (e) {
    log.warn("Failed to open episode", { id, error: e instanceof Error ? e.message : String(e) });
    return;
  }

  epState.currentId = id;
  epState.currentTarget = plan.target;
  epState.currentTickStart = tick;

  log.debug("Episode opened", {
    id,
    target: plan.target,
    voice: plan.voice,
    causedBy: causedBy.length > 0 ? causedBy : undefined,
  });
}

/**
 * Evolve 线程的 episode 关闭——只做边界标记和清理工作状态。
 *
 * 真正的 outcome + residue 由 act 线程的 closeEpisodeFromAct() 写入，
 * 因为只有 processResult 才有真实的 engagement 信号。
 *
 * evolve 线程在 target 变化时调用此函数：
 * - 如果 episode 太短（< MIN_EPISODE_TICKS）→ 删除
 * - 如果 act 线程已写入 outcome → 不覆盖（已正确关闭）
 * - 如果 act 线程尚未写入 → 设置 tickEnd 但不写 outcome/residue（等 act 来补）
 */
function closeEpisode(epState: EpisodeWorkingState, tick: number): void {
  const id = epState.currentId;
  if (!id || !epState.currentTickStart) return;

  // 最小持续时间检查——太短的 episode 直接删除
  if (tick - epState.currentTickStart < MIN_EPISODE_TICKS) {
    try {
      getDb().delete(episodes).where(eq(episodes.id, id)).run();
    } catch {
      /* ignore */
    }
    epState.currentId = null;
    epState.currentTarget = null;
    epState.currentTickStart = null;
    return;
  }

  // 只设 tickEnd（如果 act 线程还没关闭的话）
  try {
    const row = getDb()
      .select({ outcome: episodes.outcome })
      .from(episodes)
      .where(eq(episodes.id, id))
      .get();
    if (row && !row.outcome) {
      // act 线程尚未写入 outcome → 设置 tickEnd 边界
      getDb().update(episodes).set({ tickEnd: tick }).where(eq(episodes.id, id)).run();
    }
    // 如果 row.outcome 已有值，说明 act 线程已正确关闭，不覆盖
  } catch (e) {
    log.warn("Failed to mark episode boundary", {
      id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  log.debug("Episode boundary marked (evolve)", { id, tick });

  epState.currentId = null;
  epState.currentTarget = null;
  epState.currentTickStart = null;
}

// ── Causal Edge Inference ────────────────────────────────────────────────

function inferCausedBy(
  epState: EpisodeWorkingState,
  target: string | null,
  voice: string,
  focalEntities: string[],
  tick: number,
): string[] {
  const causes: string[] = [];

  // 规则 1: residue.toward 指向当前 target
  for (const r of epState.activeResidues) {
    if (r.residue.toward === target && target != null) {
      causes.push(r.episodeId);
    }
  }

  if (causes.length > 0) return causes;

  // 规则 2: 最近结束的 episode（时序邻近 + 实体重叠或声部延续）
  try {
    const recent = getDb()
      .select({ id: episodes.id, entityIds: episodes.entityIds, voice: episodes.voice })
      .from(episodes)
      .where(
        and(isNotNull(episodes.tickEnd), gt(episodes.tickStart, tick - CAUSATION_MAX_GAP_TICKS)),
      )
      .all();

    for (const ep of recent) {
      const epEntities: string[] = JSON.parse(ep.entityIds || "[]");
      const hasEntityOverlap = focalEntities.some((e) => epEntities.includes(e));
      const hasSameVoice = ep.voice === voice;

      if (hasEntityOverlap || hasSameVoice) {
        causes.push(ep.id);
      }
    }
  } catch {
    /* DB error → skip inference */
  }

  return causes;
}

// ── Pressure Contribution ────────────────────────────────────────────────

const LN2 = Math.LN2;

/**
 * 计算所有活跃 residue 的压力贡献，注入 channelPressures map。
 * 在 evolve.ts 的 channelPressures 构造后、updateAttentionDebt 前调用。
 */
export function injectResidueContributions(
  _activeResidues: ActiveResidue[],
  _channelPressures: Map<string, number>,
  _nowMs: number,
): void {
  // ADR-274 W3.5: residue is not a trusted runtime control input.
  // Keep the API as a no-op while W4 replaces it with typed target-bound continuity.
}

/**
 * 刷新 residue 缓存——移除已衰减到阈值以下的条目。
 * 每 tick 调用一次，轻量操作。
 */
/**
 * 从 DB 刷新 residue 缓存（act 线程可能已写入新 residue）+ 裁剪已衰减条目。
 * 每 tick 调用一次。用 DB 读取替代纯内存裁剪，确保跨线程一致性。
 */
export function refreshResidueCache(nowMs: number): ActiveResidue[] {
  const fresh = loadActiveResidues(nowMs);
  return fresh.filter((r) => {
    const age = nowMs - r.residue.createdMs;
    if (age > RESIDUE_MAX_AGE_MS) return false;
    const contribution = r.residue.intensity * Math.exp((-LN2 * age) / r.residue.decayHalfLifeMs);
    return contribution >= RESIDUE_MIN_CONTRIBUTION;
  });
}

// ── DB Helpers ───────────────────────────────────────────────────────────

function loadActiveResidues(nowMs: number): ActiveResidue[] {
  try {
    const cutoff = nowMs - RESIDUE_MAX_AGE_MS;
    const rows = getDb()
      .select({ id: episodes.id, residue: episodes.residue })
      .from(episodes)
      .where(and(isNotNull(episodes.residue), gt(episodes.createdMs, cutoff)))
      .all();

    const result: ActiveResidue[] = [];
    for (const row of rows) {
      if (!row.residue) continue;
      try {
        const parsed = JSON.parse(row.residue) as EpisodeResidue;
        result.push({ episodeId: row.id, residue: parsed });
      } catch {
        /* malformed JSON → skip */
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * GC: 删除超龄 episode（> 7 天）。在 evolve 的维护阶段调用。
 */
export function gcEpisodes(nowMs: number): number {
  try {
    const cutoff = nowMs - EPISODE_MAX_AGE_MS;
    const deleted = getDb().delete(episodes).where(lt(episodes.createdMs, cutoff)).run();
    return deleted.changes;
  } catch {
    return 0;
  }
}

/**
 * 记录 consults 边——当 LLM 查阅某个 episode 时调用。
 */
export function recordConsults(currentEpisodeId: string, consultedEpisodeId: string): void {
  try {
    const row = getDb()
      .select({ consults: episodes.consults })
      .from(episodes)
      .where(eq(episodes.id, currentEpisodeId))
      .get();

    if (!row) return;

    const existing: string[] = row.consults ? JSON.parse(row.consults) : [];
    if (existing.includes(consultedEpisodeId)) return;
    existing.push(consultedEpisodeId);

    getDb()
      .update(episodes)
      .set({ consults: JSON.stringify(existing) })
      .where(eq(episodes.id, currentEpisodeId))
      .run();

    log.debug("Recorded consults edge", { from: currentEpisodeId, to: consultedEpisodeId });
  } catch (e) {
    log.warn("Failed to record consults", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Act 线程 Episode 关闭（真实信号）────────────────────────────────

/** processResult 传入的真实 engagement 信号。 */
export interface ActOutcomeSignals {
  messageSent: boolean;
  isSilence: boolean;
  success: boolean;
  errorCount: number;
  scriptErrors: number;
  silenceReason: string | null;
  engagementOutcome: string | null;
  subcycles: number;
  durationMs: number;
  target: string | null;
  tick: number;
}

/**
 * 从 act 线程关闭 episode——双源融合（LLM 主源 + 结构兜底）。
 *
 * 信号来源：
 * - llmResidue：LLM 在 TickStepSchema.residue 中直接表达的认知残留（语义归 LLM）
 * - signals：processResult 的结构信号（messageSent/error/silence）
 *
 * 合并规则：LLM 明确表达的认知残留才写入 residue；运行时失败不伪装成未完成想法。
 *
 * @see docs/adr/215-cognitive-episode-graph.md
 */
export function closeEpisodeFromAct(
  episodeId: string,
  signals: ActOutcomeSignals,
  llmResidue?: import("../llm/schemas.js").LLMResidue,
): void {
  const nowMs = Date.now();

  const row = getDb().select().from(episodes).where(eq(episodes.id, episodeId)).get();
  if (!row) {
    log.debug("closeEpisodeFromAct: episode not found", { episodeId });
    return;
  }
  if (row.outcome) return;

  const outcome = signals.messageSent
    ? "message_sent"
    : signals.isSilence
      ? "silence"
      : !signals.success
        ? "error"
        : "silence";

  const residue = mergeResidue(llmResidue, outcome, signals, nowMs);

  try {
    getDb()
      .update(episodes)
      .set({
        tickEnd: signals.tick,
        outcome,
        residue: residue ? JSON.stringify(residue) : null,
      })
      .where(eq(episodes.id, episodeId))
      .run();

    log.debug("Episode closed from act", {
      episodeId,
      outcome,
      residueSource: llmResidue ? "llm" : "none",
      residueType: residue?.type ?? "none",
    });
  } catch (e) {
    log.warn("Failed to close episode from act", {
      episodeId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** LLM feeling → residue type 映射。 */
const FEELING_MAP: Record<string, EpisodeResidue["type"]> = {
  unresolved: "unresolved_emotion",
  interrupted: "interrupted",
  curious: "curiosity",
  settled: "unfinished", // settled 不产生 residue，此 mapping 不会被使用
};

/** LLM feeling → intensity 映射。 */
const FEELING_INTENSITY: Record<string, number> = {
  unresolved: 0.5,
  interrupted: 0.5,
  curious: 0.3,
  settled: 0,
};

/** LLM residue 归一化。运行时失败不再生成结构兜底 residue。 */
function mergeResidue(
  llm: import("../llm/schemas.js").LLMResidue | undefined,
  outcome: string,
  signals: ActOutcomeSignals,
  nowMs: number,
): EpisodeResidue | null {
  const raw = {
    outcome,
    engagementOutcome: signals.engagementOutcome,
    pressure: 0,
  };

  if (llm) {
    if (llm.feeling === "settled") return null; // LLM 说没事 → 没事
    const type = FEELING_MAP[llm.feeling] ?? "unresolved_emotion";
    const toward = llm.toward ? (ensureNodeId(llm.toward) ?? null) : null;
    return {
      type,
      ...raw,
      intensity: FEELING_INTENSITY[llm.feeling] ?? 0.4,
      toward,
      decayHalfLifeMs: RESIDUE_HALF_LIFE[type],
      createdMs: nowMs,
    };
  }

  return null;
}

/** 将 LLM 输出的任意格式 ID 统一为 graph node ID。 */
function ensureNodeId(id: string): string | null {
  return ensureChannelId(id) ?? ensureContactId(id) ?? null;
}

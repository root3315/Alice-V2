/**
 * Storyteller — LLM 上下文聚合器（移植自叙事引擎）。
 *
 * 从 Dispatcher 收集所有 Mod 的 contribute() → 按 bucket/order/priority 排序
 * → Trim（token budget 截断）→ 渲染成 system + user prompt。
 *
 * 替代旧的 briefing.ts（手工组装 prompt）。
 *
 * 排序规则：
 * 1. bucket 分层：header → section → footer
 * 2. 同 bucket 内按 order 升序（越小越靠前）
 * 3. 同 (bucket, key) 内按 priority 降序（越高越重要）
 * 4. 同 key 的项合并到一个组，第一个带 title 的项提供组标题
 *
 * Trim 步骤（论文 Def 3.9: Contribute → Rank → Trim → Inject）：
 * 渲染后检查总 token 量，超限则从最低优先级的非 header 组开始移除。
 *
 * 参考: narrative-engine/mods/storyteller/index.ts
 * @see paper-five-dim/ Definition 7.1（Context Assembly 四步管线）
 */

import { createLogger } from "../utils/logger.js";
import type { ContributionItem } from "./types.js";

const log = createLogger("storyteller");

// -- ADR-114 D1: Budget Zone 隔离 -------------------------------------------

/** Context assembly budget zone（上下文组装预算区域）。 */
export type BudgetZone = "anchor" | "situation" | "conversation" | "memory";

/**
 * 默认 zone 比例。
 * anchor 30%: 人格核心（header bucket，免疫裁剪）
 * situation 15%: 环境感知（时钟、压力、策略提示、风险标记）
 * conversation 40%: 对话上下文（messages + scriptGuide + manual + footer + 对话相关 mod 贡献）
 * memory 15%: 记忆检索（联系人画像、线程、记忆整理）
 * @see docs/adr/114-context-assembly-rehabilitation.md — D1
 */
export const DEFAULT_ZONE_RATIOS: Record<BudgetZone, number> = {
  anchor: 0.3,
  situation: 0.15,
  conversation: 0.4,
  memory: 0.15,
};

/** 属于 SITUATION zone 的 contribution key。 */
const SITUATION_KEYS = new Set([
  "wall-clock",
  "situation",
  "strategy-hints",
  "risk-flags",
  "self-mood",
  "self-knowledge",
  "scheduler-fired",
]);

/** 属于 MEMORY zone 的 contribution key。 */
const MEMORY_KEYS = new Set([
  "contact-profile",
  "threads",
  "memory-housekeeping",
  "feedback-loop",
  "conversation",
]);

/** ADR-115 T2: Zone budget 利用率统计。 */
export interface ZoneStats {
  budget: number;
  used: number;
  trimmed: number;
}

/** 按 bucket 和 key 将 ContributionItem 分类到 BudgetZone。 */
export function classifyZone(item: ContributionItem): BudgetZone {
  if (item.bucket === "header") return "anchor";
  if (SITUATION_KEYS.has(item.key ?? "")) return "situation";
  if (MEMORY_KEYS.has(item.key ?? "")) return "memory";
  return "conversation";
}

/**
 * Zone-aware 贡献渲染——按 zone 隔离 token budget。
 *
 * 解决的问题：旧的单一共享池中，忙群 30 条消息吃掉 8000 tokens，
 * 导致 SITUATION/MEMORY zone 的 mod 贡献被系统性饿死。
 *
 * @param items - 所有 mod 的 ContributionItem
 * @param totalBudget - 全局 token budget（GLOBAL_TOKEN_BUDGET）
 * @param zoneRatios - 自定义 zone 比例（可选，覆盖 DEFAULT_ZONE_RATIOS）
 * @param conversationFixedTokens - CONVERSATION zone 的固定开销
 *        （scriptGuide + manual + footer + messages 的 token 估算总和）
 * @see docs/adr/114-context-assembly-rehabilitation.md — D1: Budget Zone 隔离
 */
export function renderContributionsByZone(
  items: ContributionItem[],
  totalBudget: number,
  zoneRatios?: Partial<Record<BudgetZone, number>>,
  conversationFixedTokens?: number,
): { system: string; user: string; zoneStats: Record<BudgetZone, ZoneStats> } {
  if (items.length === 0) {
    const zero: ZoneStats = { budget: 0, used: 0, trimmed: 0 };
    return {
      system: "",
      user: "",
      zoneStats: { anchor: zero, situation: zero, conversation: zero, memory: zero },
    };
  }

  const ratios: Record<BudgetZone, number> = { ...DEFAULT_ZONE_RATIOS, ...zoneRatios };

  // 校验：非 anchor zone 的比例之和应接近 0.7（anchor 免疫裁剪，不参与分配）
  const nonAnchorSum = ratios.situation + ratios.conversation + ratios.memory;
  if (nonAnchorSum > 1.0 || nonAnchorSum < 0.1) {
    log.warn("Zone ratios may be misconfigured", { ratios, nonAnchorSum });
  }

  // 1. 按 zone 分组
  const zoneItems: Record<BudgetZone, ContributionItem[]> = {
    anchor: [],
    situation: [],
    conversation: [],
    memory: [],
  };
  for (const item of items) {
    zoneItems[classifyZone(item)].push(item);
  }

  // 2. ANCHOR zone: header bucket 免疫裁剪，不设 budget 上限
  const anchorRendered = renderContributions(zoneItems.anchor, {
    maxTokens: Number.MAX_SAFE_INTEGER,
  });

  // 3. 非 anchor zone 各自分配独立 budget
  const sitBudget = Math.max(100, Math.floor(totalBudget * ratios.situation));
  const memBudget = Math.max(100, Math.floor(totalBudget * ratios.memory));
  // CONVERSATION zone 的 budget 需先扣除固定开销（scriptGuide + manual + footer + messages）
  const convRawBudget = Math.floor(totalBudget * ratios.conversation);
  const convBudget = Math.max(100, convRawBudget - (conversationFixedTokens ?? 0));

  const sitRendered = renderContributions(zoneItems.situation, { maxTokens: sitBudget });
  const memRendered = renderContributions(zoneItems.memory, { maxTokens: memBudget });
  const convRendered = renderContributions(zoneItems.conversation, { maxTokens: convBudget });

  // ADR-115 T2: zone budget 利用率（直接复用 renderContributions 内部 token 统计）
  const zoneStats: Record<BudgetZone, ZoneStats> = {
    anchor: {
      budget: Number.MAX_SAFE_INTEGER,
      used: anchorRendered.usedTokens,
      trimmed: anchorRendered.trimmedTokens,
    },
    situation: {
      budget: sitBudget,
      used: sitRendered.usedTokens,
      trimmed: sitRendered.trimmedTokens,
    },
    conversation: {
      budget: convBudget,
      used: convRendered.usedTokens,
      trimmed: convRendered.trimmedTokens,
    },
    memory: { budget: memBudget, used: memRendered.usedTokens, trimmed: memRendered.trimmedTokens },
  };

  log.debug("Zone budgets", {
    anchor: "unlimited",
    situation: sitBudget,
    conversation: convBudget,
    memory: memBudget,
    conversationFixedTokens: conversationFixedTokens ?? 0,
  });

  // 4. 合并各 zone 的 system/user 输出
  // system = anchor（header bucket），user = situation → memory → conversation
  const systemParts = [anchorRendered.system].filter(Boolean);
  const userParts = [sitRendered.user, memRendered.user, convRendered.user].filter(Boolean);

  return {
    system: systemParts.join("\n\n---\n\n"),
    user: userParts.join("\n\n"),
    zoneStats,
  };
}

// 桶排序权重
const BUCKET_ORDER: Record<string, number> = { header: 0, section: 1, footer: 2 };

/** 分组结构。 */
interface Group {
  bucket: string;
  key: string;
  title?: string;
  order: number;
  items: Array<{ priority: number; lines: string[] }>;
}

/** 渲染后的分组（含 token 估算）。 */
interface RenderedGroup {
  bucket: string;
  key: string;
  text: string;
  tokens: number;
  minPriority: number; // 组内最低 priority（用于 trim 排序）
}

/**
 * 估算文本的 token 数。
 * 分别统计 CJK 字符和 ASCII 字符，加权求和。
 * CJK 约 1.5 字/token，ASCII 约 4 字符/token。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    ch.charCodeAt(0) > 0x2e80 ? cjk++ : ascii++;
  }
  return Math.ceil(cjk / 1.5 + ascii / 4);
}

/** renderContributions 的返回值。 */
export interface RenderResult {
  system: string;
  user: string;
  /** ADR-115 T2: 裁剪掉的 token 估算量。 */
  trimmedTokens: number;
  /** ADR-115 T2: 最终输出的 token 估算量（system + user）。 */
  usedTokens: number;
}

const EMPTY_RENDER: RenderResult = { system: "", user: "", trimmedTokens: 0, usedTokens: 0 };

/**
 * 从 ContributionItem[] 渲染为 prompt 文本。
 * 返回 RenderResult：header 桶 → system prompt，section+footer → user prompt。
 *
 * @param maxTokens - token budget 上限（默认 3000）。超限时从最低优先级非 header 组移除。
 */
export function renderContributions(
  items: ContributionItem[],
  options?: { maxTokens?: number },
): RenderResult {
  if (items.length === 0) return EMPTY_RENDER;

  const maxTokens = options?.maxTokens ?? 3000;

  // 分组
  const groupMap = new Map<string, Group>();
  for (const item of items) {
    const groupKey = `${item.bucket}::${item.key ?? "__default__"}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        bucket: item.bucket,
        key: item.key ?? "__default__",
        title: item.title,
        order: item.order ?? 50,
        items: [],
      };
      groupMap.set(groupKey, group);
    }
    // 取最小 order
    if ((item.order ?? 50) < group.order) group.order = item.order ?? 50;
    // 第一个有 title 的生效
    if (!group.title && item.title) group.title = item.title;
    group.items.push({
      priority: item.priority ?? 50,
      lines: item.lines,
    });
  }

  // 排序 groups: bucket → order → key
  const groups = [...groupMap.values()].sort((a, b) => {
    const bucketDiff = (BUCKET_ORDER[a.bucket] ?? 1) - (BUCKET_ORDER[b.bucket] ?? 1);
    if (bucketDiff !== 0) return bucketDiff;
    return a.order - b.order;
  });

  // 渲染所有组
  const renderedGroups: RenderedGroup[] = [];

  for (const group of groups) {
    // 组内按 priority 降序
    group.items.sort((a, b) => b.priority - a.priority);

    const lines: string[] = [];
    if (group.title) {
      // ADR-141: 自动规范化节标题为 ## Title 格式
      lines.push(group.title.startsWith("## ") ? group.title : `## ${group.title}`);
    }
    for (let i = 0; i < group.items.length; i++) {
      // 同 key 多 item 间插入空行分隔（来自不同 mod 的贡献）
      if (i > 0) lines.push("");
      lines.push(...group.items[i].lines);
    }

    if (lines.length === 0) continue;

    const text = lines.join("\n");
    const minPriority = Math.min(...group.items.map((i) => i.priority));
    renderedGroups.push({
      bucket: group.bucket,
      key: group.key,
      text,
      tokens: estimateTokens(text),
      minPriority,
    });
  }

  // ── ADR-209: 两阶段裁剪（item 级 → group 级） ──
  // 阶段 1: item 级裁剪——在 group 内按 priority 从低到高逐 item 移除，保留标题和摘要
  // 阶段 2: group 级裁剪——如果仍超限，整个 group 移除（留摘要行）
  let totalTokens = renderedGroups.reduce((sum, g) => sum + g.tokens, 0);
  let trimmedTokens = 0;

  // 阶段 1: item 级裁剪
  if (totalTokens > maxTokens) {
    for (const group of groups) {
      if (totalTokens <= maxTokens) break;
      if (group.bucket === "header") continue;
      if (group.items.length <= 1) continue; // 单 item 组留给阶段 2

      // 从最低 priority 的 item 开始移除
      const sortedByPriorityAsc = [...group.items].sort((a, b) => a.priority - b.priority);
      let removed = 0;
      for (const item of sortedByPriorityAsc) {
        if (totalTokens <= maxTokens) break;
        if (group.items.length - removed <= 1) break; // 至少保留 1 个 item
        const itemTokens = estimateTokens(item.lines.join("\n"));
        // 从 group.items 中移除该 item
        const idx = group.items.indexOf(item);
        if (idx >= 0) {
          group.items.splice(idx, 1);
          removed++;
          totalTokens -= itemTokens;
          trimmedTokens += itemTokens;
          log.debug("Trimmed item", {
            key: group.key,
            priority: item.priority,
            tokens: itemTokens,
          });
        }
      }

      if (removed > 0) {
        // 重新渲染该 group（含摘要行）
        const rgIdx = renderedGroups.findIndex(
          (g) => g.key === group.key && g.bucket === group.bucket,
        );
        if (rgIdx >= 0) {
          const newLines: string[] = [];
          if (group.title) {
            newLines.push(group.title.startsWith("## ") ? group.title : `## ${group.title}`);
          }
          for (let i = 0; i < group.items.length; i++) {
            if (i > 0) newLines.push("");
            newLines.push(...group.items[i].lines);
          }
          newLines.push(`(${removed} more omitted)`);
          const newText = newLines.join("\n");
          const newTokens = estimateTokens(newText);
          // 修正 token 差值（重新渲染后可能与累计减去的不一致）
          totalTokens = totalTokens - renderedGroups[rgIdx].tokens + newTokens;
          renderedGroups[rgIdx].text = newText;
          renderedGroups[rgIdx].tokens = newTokens;
          renderedGroups[rgIdx].minPriority =
            group.items.length > 0 ? Math.min(...group.items.map((i) => i.priority)) : Infinity;
        }
      }
    }
  }

  // 阶段 2: group 级裁剪（兜底——与原逻辑一致）
  while (totalTokens > maxTokens) {
    let trimIdx = -1;
    let lowestPriority = Infinity;
    for (let i = 0; i < renderedGroups.length; i++) {
      if (renderedGroups[i].bucket !== "header" && renderedGroups[i].minPriority < lowestPriority) {
        lowestPriority = renderedGroups[i].minPriority;
        trimIdx = i;
      }
    }
    if (trimIdx < 0) break;
    const trimmed = renderedGroups.splice(trimIdx, 1)[0];
    totalTokens -= trimmed.tokens;
    trimmedTokens += trimmed.tokens;
    log.debug("Trimmed contribution group", {
      key: trimmed.key,
      bucket: trimmed.bucket,
      tokens: trimmed.tokens,
      priority: trimmed.minPriority,
    });
  }

  // 构建最终结果
  const systemParts: string[] = [];
  const userParts: string[] = [];

  for (const g of renderedGroups) {
    if (g.bucket === "header") {
      systemParts.push(g.text);
    } else {
      userParts.push(g.text);
    }
  }

  return {
    system: systemParts.join("\n\n---\n\n"),
    user: userParts.join("\n\n"),
    trimmedTokens,
    usedTokens: totalTokens,
  };
}

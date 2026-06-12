/**
 * ADR-172: Information Visibility Layer — 认知隐私边界。
 *
 * 在 collectContributions() 和 renderContributionsByZone() 之间插入过滤层，
 * 根据当前 prompt 的受众（target chat）过滤跨聊天信息。
 *
 * 设计原则（126 号提案）：
 * - 注入什么信息 → 涌现什么行为
 * - 不让 LLM 看到不该看到的信息，比告诉它"别说"更可靠
 *
 * 论文 Def 7.1 扩展：Contribute → Rank → 【Filter】 → Trim → Inject
 *
 * @see docs/adr/172-information-visibility-layer.md
 */

import { resolveContactAndChannel } from "../graph/constants.js";
import { readDisplayName, readTitle } from "../graph/dynamic-props.js";
import type { WorldModel } from "../graph/world-model.js";
import { ChatTarget } from "../prompt/types.js";
import type { ContributionItem } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// 受众上下文
// ═══════════════════════════════════════════════════════════════════════════

/** 当前 prompt 的受众上下文 — 决定哪些信息可见。 */
export interface AudienceContext {
  /** target chat 的图节点 ID（如 "channel:123"）。null = 无目标。 */
  targetChat: string | null;
  /** 聊天类型。 */
  chatType: "private" | "group" | "supergroup" | null;
  /** target contact 的图节点 ID（私聊时有值）。 */
  targetContact: string | null;
  /** target 的 Dunbar tier（群聊或未知时为 null）。 */
  targetTier: number | null;
}

/**
 * 从 prompt-builder 已有信息推导 AudienceContext。
 * 不需要额外数据源 — target、chatType、G 在 buildTickPrompt 中均已可用。
 */
export function buildAudienceContext(
  G: WorldModel,
  targetChat: string | null,
  chatType: string,
): AudienceContext {
  const resolved = targetChat ? resolveContactAndChannel(targetChat, (id) => G.has(id)) : null;

  const contactId = resolved?.contactId ?? null;
  const tier = contactId && G.has(contactId) ? (G.getContact(contactId).tier ?? 50) : null;

  return {
    targetChat,
    chatType: ChatTarget.isGroupChat(chatType) ? (chatType as "group" | "supergroup") : "private",
    targetContact: contactId,
    targetTier: tier,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section Key 分类
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 无跨聊天内容的 key — 直接放行，不过滤。
 *
 * 这些 section 要么是普遍适用（时钟），要么已被 contribute() 限定到当前 target
 * （如 conversation、channel-info 等）。
 */
const ALWAYS_VISIBLE = new Set([
  // 时间/情绪 — 普遍适用
  "wall-clock",
  "self-mood",
  "self-knowledge",
  // 当前频道信息 — 由 contribute 限定 target
  "channel-info",
  "channel-activity",
  "safety-warning",
  "escalation-check",
  // 对话历史 — 由 timeline 限定 target
  "conversation",
  "conversation-recap",
  "action-echo",
  // 学习 — per-group 生成
  "group-jargon",
  "learned-expressions",
  // feeds — per-channel 注入
  "feeds-channel",
]);

/**
 * 纯内务 key — 群聊中整体删除。
 *
 * 这些 section 是 Alice 的内部维护任务（记忆整理、衰减清理），
 * 对群聊决策无价值，且包含跨聊天联系人列表。
 *
 * 注意：联系人画像/情绪/反馈等社交信息已移入 ENTITY_SCOPED——
 * 群成员相关的社交认知对群聊决策有价值（如知道群友心情不好→说话收着点）。
 * @see ADR-172 原始设计 + 后续修正
 */
const GROUP_REDACTED = new Set([
  "consolidation-hint", // 记忆整理提示（内务）
  "memory-housekeeping", // 记忆维护（内务）
]);

/**
 * 含多实体信息的 key — 需要逐行过滤。
 *
 * 这些 section 聚合了来自多个频道/联系人的信息（如 situation lines 列出所有频道的状态），
 * 不能整体删除（当前 target 相关的行应保留），需要逐行判断。
 *
 * 群聊中保留"群成员相关"的行：通过 joined 边获取群成员 display_name，
 * 含群成员名的行 → 保留，含非群成员名的行 → 过滤。
 */
const ENTITY_SCOPED = new Set([
  "situation", // 压力语义化 — 提及所有频道/联系人
  "strategy-hints", // 策略提示 — 跨聊天的关系/注意力/危机信息
  "threads", // 叙事线程 — 包含跨聊天的承诺和 beat
  "thread-review-hint", // 线程审查提示
  "scheduler-fired", // 已触发的定时任务 — 可能指向其他聊天
  "scheduler-upcoming", // 即将触发的定时任务
  "risk-flags", // 风险标记 — 引用其他频道
  "outcome-history", // 行动反馈 — 引用其他 target
  // 社交认知 — 从 GROUP_REDACTED 移入：群成员相关信息对群聊决策有价值
  "contact-profile", // 联系人画像（群成员的性格/偏好帮助得体互动）
  "first-impression", // 首次印象（群成员的历史帮助群聊应对）
  "contact-mood", // 联系人情绪（知道群友心情→调整说话方式）
  "feedback-loop", // 行为反馈（群内互动质量反思）
  "strategy-reflection", // 策略反思（对群成员的交互模式认知）
]);

// ═══════════════════════════════════════════════════════════════════════════
// 过滤实现
// ═══════════════════════════════════════════════════════════════════════════

/** 判断 thread 行块是否对当前 audience 可见。 */
function isThreadBlockVisible(
  headerLine: string,
  audience: AudienceContext,
  G: WorldModel,
): boolean {
  // 私聊不过滤线程 — 允许 Alice 和亲密联系人讨论所有线程
  if (audience.chatType === "private") return true;

  // 群聊中：系统线程不可见
  if (headerLine.includes("[system]")) return false;

  // 群聊中：检查线程 involves 是否包含当前群
  const threadIdMatch = headerLine.match(/^\[#(\d+)\]/);
  if (!threadIdMatch) return true; // 无法解析，保守放行
  const threadNodeId = `thread_${threadIdMatch[1]}`;
  if (!G.has(threadNodeId)) return true; // 图中不存在，保守放行

  const involves = G.getNeighbors(threadNodeId, "involves");
  return involves.some((id) => id === audience.targetChat || id === audience.targetContact);
}

/**
 * 对 ENTITY_SCOPED section 逐行过滤。
 *
 * 对 "threads" key 特殊处理：按 thread 块（[#N] 标头开始的连续行）过滤。
 * 对其他 key（situation, strategy-hints 等）：逐行基于实体名可见性过滤。
 */
function filterEntityScopedSection(
  item: ContributionItem,
  audience: AudienceContext,
  G: WorldModel,
): ContributionItem | null {
  const key = item.key ?? "";

  // ── threads / thread-review-hint：按 thread 块过滤 ──
  if (key === "threads" || key === "thread-review-hint") {
    return filterThreadSection(item, audience, G);
  }

  // ── 其他 entity-scoped keys：逐行过滤 ──
  // 私聊不过滤（允许完整可见性）
  if (audience.chatType === "private") return item;

  // 群聊：只保留与当前群相关的行
  const targetNames = collectTargetNames(audience, G);
  const filteredLines = item.lines.filter((line) => {
    const text = String(line);
    // 如果行中提到当前 target 的 display_name → 保留
    for (const name of targetNames) {
      if (text.includes(name)) return true;
    }
    // 通用信息行（如 "Several things happening at once."）→ 保留
    if (!containsEntityReference(text, G)) return true;
    // 提到其他实体 → 删除
    return false;
  });

  if (filteredLines.length === 0) return null;
  return { ...item, lines: filteredLines };
}

/** 按 thread 块过滤 threads section。 */
function filterThreadSection(
  item: ContributionItem,
  audience: AudienceContext,
  G: WorldModel,
): ContributionItem | null {
  const filteredLines = [];
  let currentBlockVisible = true;

  for (const line of item.lines) {
    const text = String(line);

    // 检测 thread 标头行：[#42] "title" ...
    if (text.match(/^\[#\d+\]/)) {
      currentBlockVisible = isThreadBlockVisible(text, audience, G);
    }

    if (currentBlockVisible) {
      filteredLines.push(line);
    }
  }

  if (filteredLines.length === 0) return null;
  return { ...item, lines: filteredLines };
}

/**
 * 收集当前 target 相关的所有可能 display_name。
 * 用于逐行文本匹配 — 如果行中出现了这些名字，说明行与当前 target 相关。
 *
 * 群聊时额外包含群成员的 display_name — 群成员相关的社交认知
 * 对群聊决策有价值（如知道群友心情不好→说话收着点）。
 */
function collectTargetNames(audience: AudienceContext, G: WorldModel): string[] {
  const names: string[] = [];
  if (audience.targetChat && G.has(audience.targetChat)) {
    const dn = readDisplayName(G, audience.targetChat);
    if (dn) names.push(dn);
    const title = readTitle(G, audience.targetChat);
    if (title) names.push(title);

    // 群成员：通过 joined 边获取群里出现过的联系人
    const isGroup = audience.chatType === "group" || audience.chatType === "supergroup";
    if (isGroup) {
      for (const memberId of G.getNeighbors(audience.targetChat, "joined")) {
        if (G.has(memberId)) {
          const memberDn = readDisplayName(G, memberId);
          if (memberDn) names.push(memberDn);
        }
      }
    }
  }
  if (audience.targetContact && G.has(audience.targetContact)) {
    const dn = readDisplayName(G, audience.targetContact);
    if (dn) names.push(dn);
  }
  return names;
}

/**
 * 启发式检测：一行文本是否引用了图中的某个实体。
 *
 * 通过检查已知 display_name 是否出现在文本中来判断。
 * 不引用任何实体的行（如 "Several things happening at once."）被视为安全的通用信息。
 */
function containsEntityReference(text: string, G: WorldModel): boolean {
  // 检查所有 channel 和 contact 的 display_name
  for (const nodeId of G.getEntitiesByType("channel")) {
    const dn = readDisplayName(G, nodeId);
    if (dn && text.includes(dn)) return true;
  }
  for (const nodeId of G.getEntitiesByType("contact")) {
    const dn = readDisplayName(G, nodeId);
    if (dn && text.includes(dn)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 对 mod 贡献列表应用可见性过滤。
 *
 * 插入 Contribute → Rank → 【Filter】 → Trim → Inject 管线。
 * 根据 audience 的 chatType 和 target 信息，过滤/删除不应该在当前 prompt 中出现的内容。
 *
 * 私聊基本不过滤（Alice 和用户之间可以讨论任何话题）。
 * 群聊过滤（标准：对群聊决策是否有价值）：
 * - GROUP_REDACTED keys 整体删除（纯内务，无决策价值）
 * - ENTITY_SCOPED keys 逐行过滤，保留群成员相关 + 当前群相关的实体
 * - ALWAYS_VISIBLE keys 和 header/footer 直接放行
 * - 未分类的 key 默认放行（安全侧 — 新 mod 的 contribute 默认可见）
 */
export function applyVisibilityFilter(
  items: ContributionItem[],
  audience: AudienceContext,
  G: WorldModel,
): ContributionItem[] {
  // 私聊不过滤 — Alice 和用户之间可以讨论任何话题
  if (audience.chatType === "private" || audience.chatType === null) {
    return items;
  }

  // 群聊过滤
  const result: ContributionItem[] = [];
  for (const item of items) {
    // header 和 footer 始终放行（人格、指令手册、脚注）
    if (item.bucket === "header" || item.bucket === "footer") {
      result.push(item);
      continue;
    }

    const key = item.key ?? "";

    // group-dynamics-* key 是按 channelId 动态生成的，天然 scoped
    if (key.startsWith("group-dynamics-")) {
      result.push(item);
      continue;
    }

    if (ALWAYS_VISIBLE.has(key)) {
      result.push(item);
      continue;
    }

    if (GROUP_REDACTED.has(key)) {
      // 群聊中删除整个 section
      continue;
    }

    if (ENTITY_SCOPED.has(key)) {
      const filtered = filterEntityScopedSection(item, audience, G);
      if (filtered) result.push(filtered);
      continue;
    }

    // 未分类 key — 默认放行（保守策略，避免意外丢失新 mod 的贡献）
    result.push(item);
  }

  return result;
}

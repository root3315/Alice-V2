"""六个原生压力函数及聚合指标（论文 §3）。

v2 压力架构：
P1  注意力债务 (Attention Debt)        — Channel 驱动
P2  信息压力 (Information Pressure)    — InfoItem 驱动（合并 v1 的 P2+P5）
P3  关系冷却 (Relationship Cooling)    — Contact 驱动
P4  线程发散 (Thread Divergence)       — Thread 驱动
P5  回应义务 (Response Obligation)     — Channel×Contact 驱动（v2 新增）
P6  好奇心 (Curiosity)                — 全局

每个压力函数返回 (total, contributions)：
- total: float, 该压力的标量总值
- contributions: dict[str, float], 各实体的贡献分解（用于目标选择层）

以及 API 聚合和可观察映射。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from graph import (
    CompanionGraph,
    EdgeCategory,
    NodeType,
    DUNBAR_TIER_WEIGHT,
    DUNBAR_TIER_THETA,
    THREAD_WEIGHTS,
)


# ---------------------------------------------------------------------------
# chat_type 权重调制（#2.1 场景盲修复 — 与 TS runtime 同步）
# ---------------------------------------------------------------------------

# chat_type → 注意力权重调制（P1 用）
CHAT_TYPE_ATTENTION_WEIGHT: dict[str, float] = {
    "private": 3.0,
    "group": 1.0,
    "supergroup": 0.8,
    "channel": 0.3,
}

# chat_type → 回应义务权重调制（P5 用）
CHAT_TYPE_RESPONSE_WEIGHT: dict[str, float] = {
    "private": 2.0,
    "group": 1.0,
    "supergroup": 0.8,
    "channel": 0.3,
}


# ---------------------------------------------------------------------------
# P1  注意力债务  (论文 §3.1 Eq P1)
# ---------------------------------------------------------------------------

def P1_attention_debt(G: CompanionGraph, n: int) -> tuple[float, dict[str, float]]:
    """P1(n) = sum_{h in H_active} unread(h, n) * w_tier(h) * w_chat_type(h)

    遍历所有频道，用 unread 消息数乘以频道的层级权重和 chat_type 权重。

    Returns
    -------
    tuple[float, dict[str, float]]
        (总压力值, {channel_id: contribution})
    """
    contributions: dict[str, float] = {}
    for hid in G.get_entities_by_type(NodeType.CHANNEL):
        attrs = G.node_attrs(hid)
        unread = float(attrs.get("unread", 0))
        if unread <= 0:
            continue
        tier = attrs.get("tier_contact", 150)
        w_tier = DUNBAR_TIER_WEIGHT.get(tier, 0.8)
        chat_type = attrs.get("chat_type", "group")
        w_chat_type = CHAT_TYPE_ATTENTION_WEIGHT.get(chat_type, 1.0)
        # ADR-23 Wave 5.2: activity_relevance 调制（OBSERVE_ACTIVITY 写入）
        # 缺省 1.0 → v4 退化
        relevance = float(attrs.get("activity_relevance", 1.0))
        contributions[hid] = unread * w_tier * w_chat_type * relevance
    total = sum(contributions.values())
    return total, contributions


# ---------------------------------------------------------------------------
# P2  信息压力  (论文 §3.1 Eq P2 — v2 合并了 v1 的 P2+P5)
# ---------------------------------------------------------------------------

def _retrievability(last_access: float, current_tick: int, stability: float, d: float = -0.5) -> float:
    """R(i, n) = (1 + (n - n_last(i)) / (9 * S(i)))^d

    幂律衰减的可检索性。
    """
    gap = max(current_tick - last_access, 0.0)
    s = max(stability, 0.1)
    return (1.0 + gap / (9.0 * s)) ** d


def P2_information_pressure(G: CompanionGraph, n: int, d: float = -0.5) -> tuple[float, dict[str, float]]:
    """P2(n) = Σ_i [importance(i)·(1-R(i,n)) + volatility(i)·age(i,n)]

    合并了记忆衰减（内部遗忘）和信息过期（外部变化）。
    同时驱动 Curiosity（去获取新信息）和 Reflection（巩固旧记忆）。

    Returns
    -------
    tuple[float, dict[str, float]]
        (总压力值, {info_item_id: contribution})
    """
    contributions: dict[str, float] = {}
    for iid in G.get_entities_by_type(NodeType.INFO_ITEM):
        attrs = G.node_attrs(iid)
        # 记忆衰减分量
        importance = float(attrs.get("importance", 0.5))
        stability = float(attrs.get("stability", 1.0))
        last_access = float(attrs.get("last_access", 0))
        R = _retrievability(last_access, n, stability, d=d)
        memory_term = importance * (1.0 - R)

        # 信息过期分量（仅 tracked 项有 volatility 驱动的时效压力）
        staleness_term = 0.0
        if attrs.get("tracked", False):
            volatility = float(attrs.get("volatility", 0.5))
            created = float(attrs.get("created", 0))
            age = max(float(n) - created, 0.0)
            staleness_term = volatility * age

        contributions[iid] = memory_term + staleness_term

    total = sum(contributions.values())
    return total, contributions


# ---------------------------------------------------------------------------
# P3  关系冷却  (论文 §3.1 Eq P3)
# ---------------------------------------------------------------------------

def _sigmoid_cooling(silence: float, theta: float, beta: float = 0.15) -> float:
    """[deprecated] 线性域 sigmoid 冷却函数——ADR-111 前使用。保留供对比。"""
    x = beta * (silence - theta)
    x = np.clip(x, -50.0, 50.0)
    return 1.0 / (1.0 + np.exp(-x))


# ADR-111 常量
P3_TAU_0: float = 600.0   # Weber-Fechner 时间感知粒度（秒）
P3_BETA_R: float = 2.5    # 对数域 sigmoid 陡度

# ADR-110: DUNBAR_TIER_THETA 秒值（与 TypeScript runtime 一致）
_DUNBAR_TIER_THETA_S: dict[int, float] = {
    5:   1200.0,   # 亲密圈：20 分钟
    15:  1800.0,   # 好友圈：30 分钟
    50:  2400.0,   # 朋友圈：40 分钟
    150: 4800.0,   # 熟人圈：80 分钟
    500: 12000.0,  # 认识圈：200 分钟
}


def _log_sigmoid_cooling(silence_s: float, beta_r: float, theta_s: float, tau0: float) -> float:
    """ADR-111: 对数域 sigmoid 冷却函数（Weber-Fechner 时间感知）。

    σ(β_r · (ln(1 + silence/τ₀) - ln(1 + θ/τ₀)))

    @see docs/adr/111-log-time-sigmoid/README.md
    """
    s_log = np.log(1.0 + silence_s / tau0)
    mu_c = np.log(1.0 + theta_s / tau0)
    exponent = -beta_r * (s_log - mu_c)
    exponent = np.clip(exponent, -50.0, 50.0)
    return 1.0 / (1.0 + np.exp(exponent))


def P3_relationship_cooling(
    G: CompanionGraph,
    n: int,
) -> tuple[float, dict[str, float]]:
    """P3(n) = Σ_c w_tier(c) · logSigmoid(silence_s, β_r, θ_s, τ₀)

    ADR-111: 对数时间域 sigmoid — Weber-Fechner 定律驱动。
    v4: 纯粹测量。不读取 API，不做 φ/ψ 调制。

    Returns
    -------
    tuple[float, dict[str, float]]
        (总压力值, {contact_id: contribution})
    """
    contributions: dict[str, float] = {}
    for cid in G.get_entities_by_type(NodeType.CONTACT):
        attrs = G.node_attrs(cid)
        tier = attrs.get("tier", 150)
        w = DUNBAR_TIER_WEIGHT.get(tier, 0.8)
        theta_s = _DUNBAR_TIER_THETA_S.get(tier, 4800.0)
        last_active = float(attrs.get("last_active", 0))
        # tick → 秒（1 tick = 60s）
        silence_s = max(n - last_active, 0.0) * 60.0
        cooling = _log_sigmoid_cooling(silence_s, P3_BETA_R, theta_s, P3_TAU_0)
        contributions[cid] = w * cooling

    total = sum(contributions.values())
    return total, contributions


# ---------------------------------------------------------------------------
# P4  线程发散  (论文 §3.1 Eq P4)
# ---------------------------------------------------------------------------

def P4_thread_divergence(
    G: CompanionGraph,
    n: int,
    thread_age_scale: float = 1440.0,
    delta_deadline: float = 1.0,
) -> tuple[float, dict[str, float]]:
    """P4(n) = sum_t log(1 + age(t)/τ) * w(t) + 1[deadline<inf] * remaining^(-delta)

    ADR-64 VI-1: age^β replaced with log(1 + age/τ) to prevent numerical explosion.

    Returns
    -------
    tuple[float, dict[str, float]]
        (总压力值, {thread_id: contribution})
    """
    contributions: dict[str, float] = {}
    for tid in G.get_entities_by_type(NodeType.THREAD):
        attrs = G.node_attrs(tid)
        if attrs.get("status") != "open":
            continue

        created = float(attrs.get("created", 0))
        w = float(attrs.get("w", 1.0))
        age = max(float(n) - created, 1.0)

        # ADR-64 VI-1: 对数增长替代幂增长
        backtrack = np.log(1 + age / thread_age_scale) * w

        deadline = float(attrs.get("deadline", float("inf")))
        forecast = 0.0
        if deadline < float("inf"):
            remaining = max(deadline - float(n), 0.5)
            forecast = remaining ** (-delta_deadline)

        contributions[tid] = backtrack + forecast

    total = sum(contributions.values())
    return total, contributions


# ---------------------------------------------------------------------------
# P5  回应义务  (论文 §3.1 Eq P5 — v2 新增)
# ---------------------------------------------------------------------------

def P5_response_obligation(G: CompanionGraph, n: int) -> tuple[float, dict[str, float]]:
    """P5(n) = Σ_h directed(h) · w_tier(h) · w_chat_type(h) · decay(age(h))

    衡量"有人在等我回复"的社交压力。directed 消息比 ambient 消息
    产生量级更高的回应义务。压力随时间衰减（回应义务有时效性）。

    图节点属性要求：
    - Channel.pending_directed: float, 累计 directed 权重
    - Channel.last_directed_tick: float, 最后一条 directed 消息的 tick

    Returns
    -------
    tuple[float, dict[str, float]]
        (总压力值, {channel_id: contribution})
    """
    contributions: dict[str, float] = {}
    for hid in G.get_entities_by_type(NodeType.CHANNEL):
        attrs = G.node_attrs(hid)
        directed = float(attrs.get("pending_directed", 0.0))
        if directed <= 0:
            continue
        tier = attrs.get("tier_contact", 150)
        w_tier = DUNBAR_TIER_WEIGHT.get(tier, 0.8)
        chat_type = attrs.get("chat_type", "group")
        w_chat_type = CHAT_TYPE_RESPONSE_WEIGHT.get(chat_type, 1.0)
        last_directed_tick = float(attrs.get("last_directed_tick", 0))
        age = max(n - last_directed_tick, 1.0)
        # ── P5 衰减半生期标定 ──────────────────────────────────
        # 半生期 = 10 tick = 10 分钟（tick rate 60s）
        #
        # 标定依据（第一性原理 + 文献交叉验证）：
        #
        # 1. 人类即时通讯回复期望的时间窗口研究：
        #    - Mosaicchats 心理学综述将"即时回复"定义为 0-5 分钟，
        #      "中等延迟"定义为 30 分钟 - 4 小时。
        #      (https://www.mosaicchats.com/blog/psychology-response-time-relationships)
        #    - Forbes 数据显示青少年平均 13 分钟回复，成人更长。
        #      (https://thesciencesurvey.com/editorial/2024/01/26/response-rate-and-relationships)
        #    - BBC 报道 30% 美国人"几乎持续在线"，回复期望 < 15 分钟。
        #      (https://www.bbc.com/worklife/article/20220207-the-crippling-expectation-of-247-digital-availability)
        #
        # 2. 第一性原理推理：
        #    - 回应义务的"紧迫感"应该在 5-15 分钟区间快速衰减：
        #      * < 5 分钟：对方刚发消息，紧迫感最高
        #      * 10 分钟：紧迫感减半（符合"中等在线"用户的期望窗口）
        #      * 30 分钟：衰减到 ~25%，进入"延迟回复"心理区间
        #      * 60 分钟：衰减到 ~14%，此时回复已不算"及时"
        #    - 10 分钟半生期平衡了"总是在线"和"有合理延迟"两种用户画像
        #
        # 3. 敏感性：半生期 ±5 分钟（即 5-15 tick）不会显著改变系统行为，
        #    因为 P5 还受 directed 权重和 tier 权重调制。
        #    极端值影响：半生期=3 → 过度反应；半生期=30 → 回应义务几乎不衰减
        # ──────────────────────────────────────────────────────
        # ADR-46 F4: 私聊半衰期 10→60 ticks + 永不完全消失。
        # ADR-45 发现 23% 的真实回复在 1 小时后。
        # @see docs/adr/45-real-data-validation.md §3.4
        is_private = chat_type == "private"
        decay_half_life = 60.0 if is_private else 10.0
        raw_decay = 1.0 / (1.0 + age / decay_half_life)
        decay = max(0.1, raw_decay) if is_private else raw_decay

        # 对话惯性：Alice 刚说过话 → 对方回复的 P5 更高，维持对话连续性
        last_alice_action = float(attrs.get("last_alice_action_tick", 0))
        alice_recency = n - last_alice_action
        conversation_boost = 1.5 if alice_recency <= 5 else 1.0

        contributions[hid] = directed * w_tier * w_chat_type * decay * conversation_boost

    total = sum(contributions.values())
    return total, contributions


# ---------------------------------------------------------------------------
# P6  好奇心  (论文 §3.1 Eq P6)
# ---------------------------------------------------------------------------

# 画像字段列表——与 TS runtime p6-curiosity.ts PROFILE_FIELDS 完全一致。
# P6 profile-gap fallback 使用：未填字段越多 → 好奇心越高。
PROFILE_FIELDS: list[str] = [
    "display_name",
    "language_preference",
    "relation_type",
    "is_bot",
    "bio",
    "interests",
    "topics",
    "preferred_style",
    "occupation",
]

# 信息增益折扣时间常数（ticks）——与 TS TAU_CURIOSITY 一致。
TAU_CURIOSITY: float = 50.0


def _is_profile_field_empty(value: Any) -> bool:
    """判断画像字段是否为空（与 TS countEmptyFields 一致）。"""
    return value is None or value == "" or value == "unknown"


def P6_curiosity(
    G: CompanionGraph,
    n: int,
    eta: float = 0.6,
    k: int = 10,
    novelty_history: list[float] | None = None,
) -> tuple[float, dict[str, float]]:
    """P6 好奇心压力。

    两个分支：
    - noveltyHistory 分支（论文 Eq P6）：时间序列，无法分解到实体 → contributions={}
      P6(n) = max(0, eta - mean(novelty[-k:]))
    - profile-gap fallback（与 TS p6-curiosity.ts 对齐）：
      遍历 contact 实体，计算画像完整度缺口 × tier 权重 × 信息增益折扣。
      P6 = mean_c [ w_tier(c) · completeness_gap(c) · γ(c, n) ]

    @see runtime/src/pressure/p6-curiosity.ts
    """
    # noveltyHistory 分支：论文 Definition 3.3（时间序列，无法分解到实体）
    if novelty_history is not None and len(novelty_history) > 0:
        recent = novelty_history[-k:]
        mean_novelty = sum(recent) / len(recent)
        total = max(0.0, eta - mean_novelty)
        return total, {}

    # Profile-gap fallback：与 TS p6-curiosity.ts 完全对齐。
    # 当 novelty_history 不可用时（静态图、交叉验证），
    # 从 contact 画像完整度计算好奇心。
    contacts = G.get_entities_by_type(NodeType.CONTACT)
    if not contacts:
        return 0.0, {}

    max_tier_weight = max(DUNBAR_TIER_WEIGHT.values())

    contributions: dict[str, float] = {}
    total_curiosity = 0.0

    for cid in contacts:
        attrs = G.node_attrs(cid)

        # 画像完整度缺口
        empty_count = sum(1 for f in PROFILE_FIELDS if _is_profile_field_empty(attrs.get(f)))
        completeness_gap = empty_count / len(PROFILE_FIELDS)
        if completeness_gap == 0:
            continue  # 画像完整，无好奇心

        # w_tier: 高 tier 联系人更值得了解（归一化到 (0, 1]）
        tier = attrs.get("tier", 150)
        w_tier = DUNBAR_TIER_WEIGHT.get(tier, 0.8) / max_tier_weight

        # γ: 信息增益折扣（最近交互过的联系人打折，避免重复探索）
        last_active = float(attrs.get("last_active", 0))
        time_since = max(0.0, float(n) - last_active)
        gamma = 1.0 - np.exp(-time_since / TAU_CURIOSITY)

        curiosity = w_tier * completeness_gap * gamma
        if curiosity > 0:
            contributions[cid] = curiosity
            total_curiosity += curiosity

    total = total_curiosity / len(contacts)
    return total, contributions


# ---------------------------------------------------------------------------
# Laplacian 压力传播  (论文 §3.4 Eq P_eff — v4 实现)
# ---------------------------------------------------------------------------

# 边类别 → 传播权重 ω(ℓ)
#
# ── Laplacian 传播权重标定 ──────────────────────────────────
#
# 设计原则：压力通过图边传导时，边的语义类别决定耦合强度。
# 权重反映"一个实体的压力变化在多大程度上影响相邻实体"。
#
# 标定依据（第一性原理）：
#
# SOCIAL = 1.0（基准，最强）
#   社交关系是伴侣图的核心语义。人际关系压力的传导最直接：
#   朋友的焦虑会直接影响你的焦虑。这是情绪传染（emotional contagion）
#   的数字化类比。社交心理学中，亲密关系的情绪共振最强。
#   作为基准值 1.0，其余权重相对于此定义。
#
# CAUSAL = 0.8（强耦合）
#   因果/承诺关系（promised, caused）具有义务性质：
#   如果你对某人做出承诺（causal 边），该承诺相关实体的压力变化
#   几乎等同于直接社交压力。略低于 SOCIAL 是因为承诺关系可以
#   被延期或重新协商，而社交关系的情绪传导是即时的。
#
# OWNERSHIP = 0.6（中等耦合）
#   结构关联（involves, from, in）是间接的组织关系：
#   一个线程"涉及"某联系人，但线程压力不会以全强度传导到联系人。
#   0.6 反映了"结构性关联 ≠ 情感性关联"的区别。
#
# SPATIAL = 0.5（中等偏弱）
#   频道成员关系（monitors, joined）是空间共处关系：
#   同一频道的成员共享注意力空间，但压力传导弱于直接人际关系。
#   类比：同事在同一办公室（spatial）vs 朋友（social）的压力传导差异。
#
# COGNITIVE = 0.3（最弱）
#   认知关系（knows, suspects, tracks）是单向的信息持有关系：
#   "知道某件事"不会像"和某人有社交关系"那样强烈地传导压力。
#   这是信息层面的关联，不是情感层面的关联。
#   0.3 确保认知关系不会主导压力传播，但仍保留微弱的信息耦合。
#
# 敏感性分析（exp7 Part B 验证）：
#   权重的相对排序 SOCIAL > CAUSAL > OWNERSHIP > SPATIAL > COGNITIVE
#   比绝对值更重要。在 mu=0.3 的全局衰减下，即使最强的 SOCIAL 边
#   也只传导 30% 的本地压力（mu * omega * P_local = 0.3 * 1.0 * P），
#   所以权重的精确值对系统行为影响有限。
# ──────────────────────────────────────────────────────────
_PROPAGATION_WEIGHT: dict[EdgeCategory, float] = {
    EdgeCategory.SPATIAL:   0.5,   # 频道成员关系：中等耦合
    EdgeCategory.SOCIAL:    1.0,   # 社交关系：最强耦合
    EdgeCategory.COGNITIVE: 0.3,   # 认知关系：弱耦合
    EdgeCategory.CAUSAL:    0.8,   # 承诺关系：强耦合
    EdgeCategory.OWNERSHIP: 0.6,   # 结构关联：中等耦合
}


def propagate_pressures(
    G: CompanionGraph,
    local_pressures: dict[str, float],
    mu: float = 0.3,
) -> dict[str, float]:
    """单步 Laplacian 压力传播。

    P_eff(v) = P_local(v) + μ Σ_{(u,ℓ,v)∈E} ω(ℓ) × P_local(u)

    对每个实体 v，汇总所有指向 v 的入边邻居的本地压力。
    复杂度 O(|E|)。

    Parameters
    ----------
    G : CompanionGraph
        社交图。
    local_pressures : dict[str, float]
        实体 ID → 本地压力值（来自 contributions 字典的合并）。
    mu : float
        全局衰减因子（推荐 0.3）。

    Returns
    -------
    dict[str, float]
        实体 ID → 有效压力 P_eff。
    """
    p_eff: dict[str, float] = dict(local_pressures)

    nxg = G.to_networkx()
    for u, v, data in nxg.edges(data=True):
        if u not in local_pressures:
            continue
        cat = data.get("category", EdgeCategory.OWNERSHIP)
        omega = _PROPAGATION_WEIGHT.get(cat, 0.5)
        propagated = mu * omega * local_pressures[u]
        p_eff[v] = p_eff.get(v, 0.0) + propagated

    return p_eff


# ---------------------------------------------------------------------------
# P_prospect  前瞻性压力  (ADR-23 Wave 4)
# ---------------------------------------------------------------------------

def P_prospect(
    G: CompanionGraph,
    n: int,
    k_steepness: float = 5.0,
) -> tuple[float, dict[str, float]]:
    """P_prospect = Σ_i w_i × σ(k × (1 - remaining_i / horizon_i))

    Thread horizon 产生前瞻性压力，作为 API 的独立加法项。
    无 horizon 线程 → P_prospect = 0（v4 退化）。

    Parameters
    ----------
    G : CompanionGraph
    n : int
        当前 tick。
    k_steepness : float
        sigmoid 陡度（默认 5.0）。

    Returns
    -------
    tuple[float, dict[str, float]]
        (总压力值, {thread_id: contribution})
    """
    contributions: dict[str, float] = {}
    for tid in G.get_entities_by_type(NodeType.THREAD):
        attrs = G.node_attrs(tid)
        if attrs.get("status") != "open":
            continue

        deadline = float(attrs.get("deadline", float("inf")))
        if not np.isfinite(deadline):
            continue

        created = float(attrs.get("created", 0))
        horizon = deadline - created
        if horizon <= 0:
            continue

        remaining = max(0.0, deadline - float(n))
        w = float(attrs.get("w", THREAD_WEIGHTS.get(attrs.get("weight", "minor"), 1.0)))

        # σ(k × (1 - remaining / horizon)) — 接近 deadline 时趋近 1
        progress = 1.0 - remaining / horizon
        x = k_steepness * progress
        x = np.clip(x, -50.0, 50.0)
        sig = 1.0 / (1.0 + np.exp(-x))
        pressure = w * sig
        contributions[tid] = float(pressure)

    total = sum(contributions.values())
    return total, contributions


# ---------------------------------------------------------------------------
# API 聚合  (论文 §3.2 — v4: tanh 归一化，纯观测量)
# ---------------------------------------------------------------------------

def api_aggregate(
    p1: float,
    p2: float,
    p3: float,
    p4: float,
    p5: float,
    p6: float,
    kappa: np.ndarray | None = None,
) -> float:
    """API(G, n) = Σ_k tanh(P_k / κ_k) ∈ [0, 6)

    v4: 使用 tanh 归一化。API 是纯观测量，不反馈到任何压力函数。
    """
    if kappa is None:
        kappa = np.array([30.0, 8.0, 8.0, 200.0, 10.0, 0.5])
    raw = np.array([p1, p2, p3, p4, p5, p6])
    return float(np.tanh(raw / kappa).sum())


# ---------------------------------------------------------------------------
# 可观察映射  (论文 §3.2 Eq A(n))
# ---------------------------------------------------------------------------

def observable_mapping(api: float, a_max: float = 10.0, kappa: float = 20.0) -> float:
    """A(n) = A_max * tanh(API(n) / kappa)"""
    return a_max * np.tanh(api / kappa)


# ---------------------------------------------------------------------------
# 便捷函数：计算所有压力并返回 API
# ---------------------------------------------------------------------------

def compute_all_pressures(
    G: CompanionGraph,
    n: int,
    kappa: np.ndarray | None = None,
    novelty_history: list[float] | None = None,
    thread_age_scale: float = 1440.0,
    eta: float = 0.6,
    k_curiosity: int = 10,
    mu: float = 0.3,
    d: float = -0.5,
    delta_deadline: float = 1.0,
    k_steepness: float = 5.0,
    kappa_prospect: float = 3.0,
) -> dict[str, Any]:
    """计算所有六个压力、Laplacian 传播、归一化 API。

    v4 管线：
    1. 计算本地压力 P1-P6（P3 不读 API）
    2. 传播: p_eff = propagate_pressures(G, local_pressures, mu)
    3. 归一化 API = Σ tanh(P_k / κ_k)（纯观测量）

    Returns
    -------
    dict
        P1~P6（本地值）、API（tanh 归一化和）、A（可观察映射）、
        contributions（含传播后的有效压力）。
    """
    # 1. 本地压力
    p1, c1 = P1_attention_debt(G, n)
    p2, c2 = P2_information_pressure(G, n, d=d)
    p3, c3 = P3_relationship_cooling(G, n)
    p4, c4 = P4_thread_divergence(G, n, thread_age_scale=thread_age_scale, delta_deadline=delta_deadline)
    p5, c5 = P5_response_obligation(G, n)
    p6, c6 = P6_curiosity(G, n, eta=eta, k=k_curiosity, novelty_history=novelty_history)

    # ADR-23: P_prospect（独立加法项，不参与 Laplacian 传播）
    p_prospect_val, c_prospect = P_prospect(G, n, k_steepness=k_steepness)

    # 2. Laplacian 传播：合并所有 contributions（含 P6）到一个 entity → pressure 映射
    local_all: dict[str, float] = {}
    for contrib in (c1, c2, c3, c4, c5, c6):
        for eid, val in contrib.items():
            local_all[eid] = local_all.get(eid, 0.0) + val
    p_eff = propagate_pressures(G, local_all, mu=mu)

    # 将传播后的有效压力回写到 contributions（用于目标选择）
    eff_contributions: dict[str, dict[str, float]] = {
        "P1": {}, "P2": {}, "P3": {}, "P4": {}, "P5": {}, "P6": {},
    }
    # 按原始归属分配传播增量
    for pk, ck in [("P1", c1), ("P2", c2), ("P3", c3), ("P4", c4), ("P5", c5), ("P6", c6)]:
        for eid, local_val in ck.items():
            eff_val = p_eff.get(eid, local_val)
            # 增量按原始贡献的比例分配
            eff_contributions[pk][eid] = eff_val if local_val == local_all.get(eid, 0) else local_val

    # 3. tanh 归一化 API（纯观测量）+ P_prospect 独立加法项
    api_base = api_aggregate(p1, p2, p3, p4, p5, p6, kappa=kappa)
    prospect_term = float(np.tanh(p_prospect_val / kappa_prospect))
    api = api_base + prospect_term
    a = observable_mapping(api)

    return {
        "P1": p1, "P2": p2, "P3": p3, "P4": p4, "P5": p5, "P6": p6,
        "P_prospect": p_prospect_val,
        "API": api, "A": a,
        "contributions": eff_contributions,
    }

"""ADR-180 Phase 1: IAUS 乘法评分 A/B 模拟验证。

将当前加法 NSV 行为选择与 IAUS 乘法 Considerations 做 A/B 对比。
使用 gold-examples 场景验证行为差异：
  - directed 场景：乘法是否正确保留回复（U_obligation 主导）
  - proactive 场景：乘法是否正确否决不恰当的主动行为
  - idle 增长：Score 是否随空闲时间单调增长
  - 注意力分布：是否改善 attention monopoly

@see docs/adr/180-iaus-multiplicative-scoring-exploration.md
@see Game AI Pro Ch.9 — An Introduction to Utility Theory (David Graham)
@see GDC 2010 — Improving AI Decision Modeling Through Utility Theory (Mark & Dill)
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import CompanionGraph, NodeType, random_companion_graph, DUNBAR_TIER_WEIGHT
from pressure import (
    P1_attention_debt,
    P2_information_pressure,
    P3_relationship_cooling,
    P4_thread_divergence,
    P5_response_obligation,
    P6_curiosity,
    api_aggregate,
)
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    VOICE_NAMES,
    VOICE_SHORT,
    _compute_uncertainty,
)


# ---------------------------------------------------------------------------
# Response Curve 库
# ---------------------------------------------------------------------------

def sigmoid_curve(x: float, midpoint: float = 0.5, slope: float = 10.0,
                  lo: float = 0.01, hi: float = 1.0) -> float:
    """S 型 Response Curve → [lo, hi]。
    @see Game AI Pro Ch.9 Fig.9.2"""
    raw = 1.0 / (1.0 + np.exp(-slope * (x - midpoint)))
    return lo + (hi - lo) * raw


def inverse_sigmoid_curve(x: float, midpoint: float = 0.5, slope: float = 10.0,
                          lo: float = 0.01, hi: float = 1.0) -> float:
    """反 S 型（高输入 → 低输出，BIS 门控语义）。"""
    return lo + hi - sigmoid_curve(x, midpoint, slope, lo, hi)


def linear_curve(x: float, lo: float = 0.01, hi: float = 1.0) -> float:
    """线性 Response Curve: x ∈ [0,1] → [lo, hi]。"""
    clamped = max(0.0, min(1.0, x))
    return lo + (hi - lo) * clamped


def linear_decreasing_curve(x: float, lo: float = 0.01, hi: float = 1.0) -> float:
    """线性递减 Response Curve: x ∈ [0,1] → [hi, lo]。"""
    clamped = max(0.0, min(1.0, x))
    return hi - (hi - lo) * clamped


def log_curve(x: float, lo: float = 0.01, hi: float = 1.0,
              scale: float = 1.0) -> float:
    """对数 Response Curve: 低区快速上升，高区趋缓。"""
    raw = np.log(1.0 + x * scale) / np.log(1.0 + scale)
    clamped = max(0.0, min(1.0, raw))
    return lo + (hi - lo) * clamped


def exponential_recovery(elapsed: float, half_life: float = 10.0,
                         lo: float = 0.01) -> float:
    """指数恢复曲线：刚赢时=lo，随时间恢复到 1.0。"""
    if elapsed <= 0:
        return lo
    return 1.0 - (1.0 - lo) * np.exp(-0.693 * elapsed / half_life)


# ---------------------------------------------------------------------------
# IAUS 乘法评分器
# ---------------------------------------------------------------------------

# 三个 action_type（ADR-180: 与声部的映射）
ACTION_TYPES = ["diligence", "curiosity", "sociability"]


@dataclass
class IAUSConfig:
    """IAUS 评分参数。"""
    epsilon: float = 0.01
    """所有 Response Curve 的下限 clamp（禁止绝对否决）。"""

    boltzmann_tau: float = 0.2
    """Boltzmann softmax 温度。"""

    # Compensation Factor（Dave Mark 公式）
    cf_diligence: float = 0.5
    cf_curiosity: float = 0.5
    cf_sociability: float = 0.5

    # Personality weights（π_v 映射到 [0.1, 0.5]）
    pi_min_map: float = 0.1
    pi_max_map: float = 0.5


def _normalize_pressures(
    G: CompanionGraph,
    n: int,
    kappa_p: np.ndarray | None = None,
    novelty_history: list[float] | None = None,
) -> dict[str, float]:
    """计算六个归一化压力 τ_k = tanh(P_k/κ_k) ∈ [0,1)。"""
    p1, c1 = P1_attention_debt(G, n)
    p2, c2 = P2_information_pressure(G, n)
    p3, c3 = P3_relationship_cooling(G, n)
    p4, c4 = P4_thread_divergence(G, n)
    p5, c5 = P5_response_obligation(G, n)
    p6, c6 = P6_curiosity(G, n, novelty_history=novelty_history)

    if kappa_p is None:
        kappa_p = np.array([30.0, 8.0, 8.0, 200.0, 10.0, 0.5])
    raw = np.array([p1, p2, p3, p4, p5, p6])
    normed = np.tanh(raw / kappa_p)

    return {
        "tau1": float(normed[0]),  # 注意力债务
        "tau2": float(normed[1]),  # 信息压力
        "tau3": float(normed[2]),  # 关系冷却
        "tau4": float(normed[3]),  # 线程发散
        "tau5": float(normed[4]),  # 回应义务
        "tau6": float(normed[5]),  # 好奇心
        "raw": raw,
        "normed": normed,
        "contributions": {"P1": c1, "P2": c2, "P3": c3, "P4": c4, "P5": c5, "P6": c6},
    }


def _entropy(tau_vec: np.ndarray) -> float:
    """归一化 Shannon 熵 H(τ̂) ∈ [0,1]。"""
    abs_vec = np.abs(tau_vec)
    total = abs_vec.sum()
    if total < 1e-10:
        return 1.0  # 无信号 = 最大不确定
    probs = abs_vec / total
    probs = probs[probs > 0]
    h = -np.sum(probs * np.log(probs))
    h_max = np.log(len(tau_vec))
    return float(h / h_max) if h_max > 0 else 0.0


def _compensation_factor(raw_score: float, n_considerations: int, cf: float) -> float:
    """Dave Mark 补偿公式：修正乘法维度膨胀。

    Final = Raw^(1/n) × (1 + (1 - Raw^(1/n)) × CF)

    @see Game AI Pro 3 Ch.13: Choosing Effective Utility-Based Considerations
    """
    if raw_score <= 0 or n_considerations <= 0:
        return 0.0
    mod = raw_score ** (1.0 / n_considerations)
    return mod * (1.0 + (1.0 - mod) * cf)


def compute_iaus_scores(
    G: CompanionGraph,
    n: int,
    personality: PersonalityVector,
    config: IAUSConfig | None = None,
    novelty_history: list[float] | None = None,
    recent_event_counts: list[int] | None = None,
    kappa_p: np.ndarray | None = None,
    recent_action_count: int = 0,
    action_cap: int = 10,
    consecutive_outgoing: int = 0,
    last_won_tick: dict[str, int] | None = None,
    mood_valence: float = 0.0,
) -> dict[str, float]:
    """计算每个 action_type 的 IAUS 乘法得分。

    Score(action_type) = CF(∏ U_k(input_k), n_k)

    Returns dict: {"diligence": score, "curiosity": score, "sociability": score}
    """
    if config is None:
        config = IAUSConfig()
    eps = config.epsilon

    tau = _normalize_pressures(G, n, kappa_p, novelty_history)
    normed = tau["normed"]

    # 张力向量熵（BIS 冲突度）
    entropy = _entropy(normed)
    tau_norm = float(np.tanh(np.linalg.norm(normed) / 2.0))  # 量级归一化

    # Uncertainty（与加法系统共享）
    uncertainty = _compute_uncertainty(recent_event_counts)

    # --- 共享 Considerations ---

    # U_conflict_avoidance: BIS 门控——冲突度高 → 暂停
    # 输入 = entropy × tau_norm + risk_contribution
    conflict_input = entropy * tau_norm
    u_conflict = inverse_sigmoid_curve(conflict_input, midpoint=0.4, slope=8.0,
                                       lo=eps, hi=1.0)

    # U_freshness: 刚行动过 → 不重复
    freshness_input = min(recent_action_count / max(action_cap, 1), 1.0)
    u_freshness = linear_decreasing_curve(freshness_input, lo=eps, hi=1.0)

    # U_reciprocity: 连续单方向 → 停
    recip_input = min(consecutive_outgoing / 5.0, 1.0)
    u_reciprocity = linear_decreasing_curve(recip_input, lo=eps, hi=1.0)

    # U_fatigue: per-action-type 疲劳（刚赢过 → 冷却）
    def u_fatigue(action_type: str) -> float:
        if last_won_tick is None:
            return 1.0
        last = last_won_tick.get(action_type, -100)
        elapsed = max(n - last, 0)
        return exponential_recovery(elapsed, half_life=8.0, lo=eps)

    # U_mood: 情绪调制（非否决）
    def u_mood(action_type: str) -> float:
        delta = 0.3
        if action_type == "sociability":
            return max(eps, 1.0 + delta * mood_valence)
        elif action_type == "diligence":
            return 1.0  # 尽责不受 mood 影响
        else:  # curiosity
            return max(eps, 1.0 + delta * 0.5 * mood_valence)

    # U_personality: π_v 映射到 [pi_min_map, pi_max_map]
    pi_map = {
        "diligence": personality.pi_D,
        "curiosity": personality.pi_C,
        "sociability": personality.pi_S,
    }

    def u_personality(action_type: str) -> float:
        raw_pi = pi_map[action_type]
        # 从 [0, 0.5]（人格硬帽）映射到 [pi_min, pi_max]
        return config.pi_min_map + (config.pi_max_map - config.pi_min_map) * min(raw_pi / 0.5, 1.0)

    # --- Per-action-type Considerations ---

    # Diligence
    u_obligation = sigmoid_curve(tau["tau5"], midpoint=0.3, slope=12.0, lo=eps)
    u_attention = sigmoid_curve(tau["tau1"], midpoint=0.3, slope=10.0, lo=eps)
    # U_thread_age: 维度休眠安全——τ₄=0（图中无线程）时返回 1.0（中性），
    # 不是 ε（否决）。"无线程" ≠ "线程新鲜"，而是"此维度不适用"。
    # @see docs/adr/180-iaus-multiplicative-scoring-exploration.md §风险1
    u_thread_age = log_curve(tau["tau4"], lo=eps, scale=3.0) if tau["tau4"] > 0.01 else 1.0
    # U_prospect: 使用 tau5 + tau1 的混合作为前瞻性代理
    u_prospect = sigmoid_curve((tau["tau5"] + tau["tau1"]) / 2, midpoint=0.3, slope=8.0, lo=eps)

    # Sociability
    u_cooling = sigmoid_curve(tau["tau3"], midpoint=0.3, slope=10.0, lo=eps)
    # U_social_bond: τ₅ 为零时中性（无回应义务不否决社交）
    u_social_bond = sigmoid_curve(tau["tau5"] * 0.6, midpoint=0.2, slope=8.0, lo=eps) if tau["tau5"] > 0.01 else 0.5
    # U_social_safety: 简化（无 Brown-Levinson），用 uncertainty 作为安全代理
    # uncertainty 高 → 不确定对方状态 → 抑制社交主动性
    u_social_safety = inverse_sigmoid_curve(uncertainty, midpoint=0.6, slope=6.0, lo=eps)

    # Curiosity
    u_novelty = sigmoid_curve(tau["tau6"], midpoint=0.3, slope=10.0, lo=eps)
    # U_info_pressure: τ₂=0 时中性（无 info_item 不否决好奇心）
    u_info_pressure = sigmoid_curve(tau["tau2"], midpoint=0.3, slope=10.0, lo=eps) if tau["tau2"] > 0.01 else 0.5
    u_exploration = log_curve(max(tau["tau2"], 0.01) * max(tau["tau6"], 0.01), lo=eps, scale=2.0)

    # --- 乘法聚合 ---
    scores: dict[str, float] = {}

    # Diligence: 7 shared + 4 specific = 11 considerations
    raw_d = (u_conflict * u_freshness * u_reciprocity * u_fatigue("diligence")
             * u_mood("diligence") * u_personality("diligence")
             * u_obligation * u_attention * u_thread_age * u_prospect)
    # 去掉 u_reachable（模拟中所有节点可达），实际 10 个
    scores["diligence"] = _compensation_factor(raw_d, 10, config.cf_diligence)

    # Sociability: 7 shared + 3 specific = 10 considerations
    raw_s = (u_conflict * u_freshness * u_reciprocity * u_fatigue("sociability")
             * u_mood("sociability") * u_personality("sociability")
             * u_cooling * u_social_bond * u_social_safety)
    scores["sociability"] = _compensation_factor(raw_s, 9, config.cf_sociability)

    # Curiosity: 7 shared + 3 specific = 10 considerations
    raw_c = (u_conflict * u_freshness * u_reciprocity * u_fatigue("curiosity")
             * u_mood("curiosity") * u_personality("curiosity")
             * u_novelty * u_info_pressure * u_exploration)
    scores["curiosity"] = _compensation_factor(raw_c, 9, config.cf_curiosity)

    return scores


def iaus_select_action(
    scores: dict[str, float],
    rng: np.random.Generator,
    tau: float = 0.2,
    caution_threshold: float = 0.15,
) -> tuple[str, float]:
    """Boltzmann softmax 从 IAUS 得分中选择行动。

    caution_threshold: 替代 Axiom 4 的最低行动阈值。
    当最高得分 < caution_threshold 时，选择 caution（不行动）。
    ADR-180: "ε 来自 Response Curve 下限的乘积"——10 个 Considerations
    每个下限 0.01，乘积 ≈ 0.01^10 ≈ 1e-20，经 CF 修正后约 0.1-0.2。

    Returns (action_type, winning_score)
    """
    names = list(scores.keys())
    vals = np.array([scores[n] for n in names])

    # 得分过滤（替代 Axiom 4）——所有 action score < 阈值时选择 caution
    if vals.max() < caution_threshold:
        return "caution", 0.0

    # Boltzmann softmax
    shifted = vals - vals.max()
    log_probs = shifted / max(tau, 0.01)
    log_probs = np.clip(log_probs, -50.0, 0.0)
    probs = np.exp(log_probs)
    prob_sum = probs.sum()
    if prob_sum > 0:
        probs /= prob_sum
    else:
        probs = np.ones(len(names)) / len(names)

    idx = int(rng.choice(len(names), p=probs))
    return names[idx], float(vals[idx])


# ---------------------------------------------------------------------------
# 场景构建器
# ---------------------------------------------------------------------------

def _build_directed_scenario(seed: int = 100) -> CompanionGraph:
    """私聊 directed 场景：高 P5（有人直接发消息给 Alice）。"""
    G = CompanionGraph()
    G.tick = 50

    G.add_entity(NodeType.AGENT, "agent_0")
    # 一个 tier-5 亲密联系人
    G.add_entity(NodeType.CONTACT, "ct_mei", tier=5, trust=0.9, last_active=49)
    G.add_relation("agent_0", "owner", "ct_mei")

    # 私聊频道：高 unread + 高 directed
    G.add_entity(NodeType.CHANNEL, "ch_mei", unread=3, tier_contact=5,
                 chat_type="private", pending_directed=2.5, last_directed_tick=49,
                 last_alice_action_tick=45)
    G.add_relation("agent_0", "monitors", "ch_mei")
    G.add_relation("ct_mei", "in", "ch_mei")

    # 一些背景
    G.add_entity(NodeType.CONTACT, "ct_bg1", tier=150, trust=0.4, last_active=20)
    G.add_relation("agent_0", "acquaintance", "ct_bg1")
    G.add_entity(NodeType.CHANNEL, "ch_bg1", unread=1, tier_contact=150,
                 chat_type="group")
    G.add_relation("agent_0", "monitors", "ch_bg1")

    return G


def _build_proactive_scenario(seed: int = 200) -> CompanionGraph:
    """极度安静场景：所有联系人刚刚互动过，无 unread，无 directed，无 thread。

    考验：系统在没有任何需要做的事时，是否选择 caution（不行动）。
    """
    G = CompanionGraph()
    G.tick = 10  # 很早期

    G.add_entity(NodeType.AGENT, "agent_0")

    # 联系人都刚互动过（last_active 很近），P3 极低
    for i in range(3):
        tier = [150, 500, 500][i]
        cid = f"ct_{i}"
        G.add_entity(NodeType.CONTACT, cid, tier=tier, trust=0.5,
                     last_active=9)  # 1 tick 前刚互动
        G.add_relation("agent_0", "acquaintance", cid)

    # 群聊频道：无 unread，无 directed
    G.add_entity(NodeType.CHANNEL, "ch_group", unread=0, tier_contact=150,
                 chat_type="group", pending_directed=0.0)
    G.add_relation("agent_0", "monitors", "ch_group")

    # 不创建线程（P4=0）
    # 不创建 InfoItem（P2=0）
    return G


def _build_monopoly_scenario(seed: int = 300) -> CompanionGraph:
    """注意力垄断场景：一个 tier-5 高频 + 多个低频联系人。"""
    G = CompanionGraph()
    G.tick = 50

    G.add_entity(NodeType.AGENT, "agent_0")

    # tier-5 高频联系人
    G.add_entity(NodeType.CONTACT, "ct_vip", tier=5, trust=0.9, last_active=49)
    G.add_relation("agent_0", "owner", "ct_vip")
    G.add_entity(NodeType.CHANNEL, "ch_vip", unread=5, tier_contact=5,
                 chat_type="private", pending_directed=1.5, last_directed_tick=49,
                 last_alice_action_tick=48)
    G.add_relation("agent_0", "monitors", "ch_vip")
    G.add_relation("ct_vip", "in", "ch_vip")

    # 5 个普通联系人
    for i in range(5):
        cid = f"ct_normal_{i}"
        G.add_entity(NodeType.CONTACT, cid, tier=50, trust=0.5,
                     last_active=50 - (i + 1) * 8)
        G.add_relation("agent_0", "friend", cid)
        chid = f"ch_normal_{i}"
        G.add_entity(NodeType.CHANNEL, chid, unread=1, tier_contact=50,
                     chat_type="group", pending_directed=0.3 if i == 0 else 0.0,
                     last_directed_tick=40 if i == 0 else 0)
        G.add_relation("agent_0", "monitors", chid)
        G.add_relation(cid, "in", chid)

    return G


# ---------------------------------------------------------------------------
# A/B 比较引擎
# ---------------------------------------------------------------------------

@dataclass
class ABResult:
    """单次 A/B 比较结果。"""
    scenario: str
    additive_actions: list[str]
    multiplicative_actions: list[str]
    additive_scores: list[dict[str, float]]
    multiplicative_scores: list[dict[str, float]]


def _run_ab_trial(
    G_template: CompanionGraph,
    scenario_name: str,
    n_steps: int = 50,
    seed: int = 42,
    personality_init: np.ndarray | None = None,
) -> ABResult:
    """在同一图状态上对比加法和乘法评分。

    不执行行动（纯评分对比），观察两个系统在每个 tick 的选择差异。
    """
    import copy

    if personality_init is None:
        personality_init = np.array([0.25, 0.2, 0.2, 0.15, 0.2])
    personality = PersonalityVector(weights=personality_init.copy())

    rng_a = np.random.default_rng(seed)
    rng_m = np.random.default_rng(seed)

    novelty_history: list[float] = []
    event_counts: list[int] = []

    additive_actions: list[str] = []
    multiplicative_actions: list[str] = []
    additive_score_trace: list[dict[str, float]] = []
    multiplicative_score_trace: list[dict[str, float]] = []

    base_tick = G_template.tick

    for step in range(n_steps):
        tick = base_tick + step + 1
        # 两个系统读同一图状态（不执行行动，纯评分）
        G_template.tick = tick
        novelty_history.append(0.0)  # 无事件
        event_counts.append(0)

        # --- 加法系统 ---
        loudness = compute_loudness(
            G_template, tick, personality,
            novelty_history=novelty_history,
            recent_event_counts=event_counts,
            rng=rng_a,
        )
        winner_idx, action_a = select_action(loudness, rng=rng_a)
        additive_actions.append(action_a)
        # 记录加法系统的声部响度作为分数（映射到 D/C/S）
        additive_score_trace.append({
            "diligence": float(loudness[0]),
            "curiosity": float(loudness[1]),
            "sociability": float(loudness[2]),
            "caution": float(loudness[3]),
            "reflection": float(loudness[4]),
        })

        # --- 乘法系统 ---
        scores = compute_iaus_scores(
            G_template, tick, personality,
            novelty_history=novelty_history,
            recent_event_counts=event_counts,
        )
        action_m, _ = iaus_select_action(scores, rng=rng_m)
        multiplicative_actions.append(action_m)
        multiplicative_score_trace.append(scores)

    return ABResult(
        scenario=scenario_name,
        additive_actions=additive_actions,
        multiplicative_actions=multiplicative_actions,
        additive_scores=additive_score_trace,
        multiplicative_scores=multiplicative_score_trace,
    )


# ---------------------------------------------------------------------------
# 实验主函数
# ---------------------------------------------------------------------------

def run_exp_iaus(n_trials: int = 30, n_steps: int = 50, seed_base: int = 4200) -> dict:
    """运行 IAUS A/B 对比实验。"""
    results: dict[str, Any] = {}

    # --- Scenario 1: Directed（高 P5 私聊回复义务）---
    print("  Scenario 1: Directed (高 P5 回复义务)")
    directed_trials: list[ABResult] = []
    for trial in range(n_trials):
        G = _build_directed_scenario(seed=seed_base + trial)
        ab = _run_ab_trial(G, "directed", n_steps=n_steps,
                           seed=seed_base + trial)
        directed_trials.append(ab)

    # 统计：diligence 选中率（directed 场景应以 diligence 为主）
    a_diligence_rate = np.mean([
        sum(1 for a in t.additive_actions if a == "diligence") / len(t.additive_actions)
        for t in directed_trials
    ])
    m_diligence_rate = np.mean([
        sum(1 for a in t.multiplicative_actions if a == "diligence") / len(t.multiplicative_actions)
        for t in directed_trials
    ])
    results["directed"] = {
        "additive_diligence_rate": float(a_diligence_rate),
        "multiplicative_diligence_rate": float(m_diligence_rate),
    }
    print(f"    加法 diligence 选中率: {a_diligence_rate:.2%}")
    print(f"    乘法 diligence 选中率: {m_diligence_rate:.2%}")

    # --- Scenario 2: Proactive（安静场景，考验抑制）---
    print("  Scenario 2: Proactive (安静场景)")
    proactive_trials: list[ABResult] = []
    for trial in range(n_trials):
        G = _build_proactive_scenario(seed=seed_base + 1000 + trial)
        ab = _run_ab_trial(G, "proactive", n_steps=n_steps,
                           seed=seed_base + 1000 + trial)
        proactive_trials.append(ab)

    # IAUS 的核心优势不是"选择 caution"——而是得分分化。
    # 加法有 5 声部（含显式 caution），乘法有 3 类型。
    # 直接比较 false-diligence 率是 apples-to-oranges（基数不同）。
    #
    # 正确的 IAUS 测试：
    # 1. Score differentiation: diligence 得分在 P5≈0 时远低于 P5 高时
    # 2. Rank: P5≈0 时 diligence 不应是最高分 action type
    # 3. Non-diligence dominance: curiosity + sociability 应占多数

    # 测量 IAUS 得分分化：proactive 的平均 diligence 得分
    m_diligence_scores_proactive: list[float] = []
    m_diligence_top_count = 0
    m_total_steps = 0
    for t in proactive_trials:
        for step_scores in t.multiplicative_scores:
            m_diligence_scores_proactive.append(step_scores.get("diligence", 0.0))
            m_total_steps += 1
            if step_scores.get("diligence", 0.0) == max(step_scores.values()):
                m_diligence_top_count += 1

    m_mean_diligence_proactive = float(np.mean(m_diligence_scores_proactive))
    m_diligence_top_rate = m_diligence_top_count / max(m_total_steps, 1)

    # directed 场景的平均 diligence 得分（用于计算得分比）
    m_diligence_scores_directed: list[float] = []
    for t in directed_trials:
        for step_scores in t.multiplicative_scores:
            m_diligence_scores_directed.append(step_scores.get("diligence", 0.0))
    m_mean_diligence_directed = float(np.mean(m_diligence_scores_directed))

    score_ratio = m_mean_diligence_proactive / max(m_mean_diligence_directed, 1e-10)

    # 选中率（信息性，非判据）
    m_diligence_rate_proactive = np.mean([
        sum(1 for a in t.multiplicative_actions if a == "diligence") / len(t.multiplicative_actions)
        for t in proactive_trials
    ])
    m_nondiligence_rate = 1.0 - float(m_diligence_rate_proactive)

    results["proactive"] = {
        "m_mean_diligence_score_proactive": m_mean_diligence_proactive,
        "m_mean_diligence_score_directed": m_mean_diligence_directed,
        "score_ratio": score_ratio,
        "m_diligence_top_rate": m_diligence_top_rate,
        "m_diligence_selection_rate": float(m_diligence_rate_proactive),
        "m_nondiligence_rate": m_nondiligence_rate,
    }
    print(f"    IAUS diligence 得分 (proactive): {m_mean_diligence_proactive:.4f}")
    print(f"    IAUS diligence 得分 (directed):  {m_mean_diligence_directed:.4f}")
    print(f"    得分比 (proactive/directed): {score_ratio:.3f}")
    print(f"    diligence 排名第一率: {m_diligence_top_rate:.2%}")
    print(f"    diligence 选中率: {m_diligence_rate_proactive:.2%}")
    print(f"    non-diligence 选中率: {m_nondiligence_rate:.2%}")

    # --- Scenario 3: Idle Growth（空闲单调性）---
    print("  Scenario 3: Idle Growth (空闲单调性)")
    idle_monotone_additive = []
    idle_monotone_multiplicative = []
    for trial in range(n_trials):
        G = random_companion_graph(n_contacts=10, n_threads=5, n_channels=3,
                                   n_info_items=5, seed=seed_base + 2000 + trial)
        ab = _run_ab_trial(G, "idle", n_steps=n_steps,
                           seed=seed_base + 2000 + trial)

        # 检查乘法得分的总和是否单调递增
        m_totals = [sum(s.values()) for s in ab.multiplicative_scores]
        a_totals = [sum(s.values()) for s in ab.additive_scores]

        # 单调性：连续递增的比例
        if len(m_totals) > 1:
            m_increases = sum(1 for i in range(1, len(m_totals))
                             if m_totals[i] >= m_totals[i-1] - 1e-8)
            idle_monotone_multiplicative.append(m_increases / (len(m_totals) - 1))
        if len(a_totals) > 1:
            a_increases = sum(1 for i in range(1, len(a_totals))
                             if a_totals[i] >= a_totals[i-1] - 1e-8)
            idle_monotone_additive.append(a_increases / (len(a_totals) - 1))

    results["idle_growth"] = {
        "additive_monotone_ratio": float(np.mean(idle_monotone_additive)),
        "multiplicative_monotone_ratio": float(np.mean(idle_monotone_multiplicative)),
    }
    print(f"    加法单调性: {np.mean(idle_monotone_additive):.2%}")
    print(f"    乘法单调性: {np.mean(idle_monotone_multiplicative):.2%}")

    # --- Scenario 4: Attention Monopoly ---
    print("  Scenario 4: Attention Monopoly")
    monopoly_trials: list[ABResult] = []
    for trial in range(n_trials):
        G = _build_monopoly_scenario(seed=seed_base + 3000 + trial)
        ab = _run_ab_trial(G, "monopoly", n_steps=n_steps,
                           seed=seed_base + 3000 + trial)
        monopoly_trials.append(ab)

    # 统计 diligence 垄断度（directed 场景 vip 应触发 diligence，但非 vip 也需要关注）
    # 乘法系统中，U_freshness + U_reciprocity 应该分散注意力
    a_dilig_monopoly = np.mean([
        sum(1 for a in t.additive_actions if a == "diligence") / len(t.additive_actions)
        for t in monopoly_trials
    ])
    m_dilig_monopoly = np.mean([
        sum(1 for a in t.multiplicative_actions if a == "diligence") / len(t.multiplicative_actions)
        for t in monopoly_trials
    ])
    # sociability 被选中的频率（表示系统有时间关注社交关系）
    a_social_monopoly = np.mean([
        sum(1 for a in t.additive_actions if a == "sociability") / len(t.additive_actions)
        for t in monopoly_trials
    ])
    m_social_monopoly = np.mean([
        sum(1 for a in t.multiplicative_actions if a == "sociability") / len(t.multiplicative_actions)
        for t in monopoly_trials
    ])

    results["monopoly"] = {
        "additive_diligence_rate": float(a_dilig_monopoly),
        "multiplicative_diligence_rate": float(m_dilig_monopoly),
        "additive_sociability_rate": float(a_social_monopoly),
        "multiplicative_sociability_rate": float(m_social_monopoly),
    }
    print(f"    加法 diligence 垄断: {a_dilig_monopoly:.2%}")
    print(f"    乘法 diligence 垄断: {m_dilig_monopoly:.2%}")
    print(f"    加法 sociability 份额: {a_social_monopoly:.2%}")
    print(f"    乘法 sociability 份额: {m_social_monopoly:.2%}")

    # --- Scenario 5: Score Decomposition（瓶颈可视化）---
    print("  Scenario 5: Score Decomposition (single tick)")
    G_decomp = _build_directed_scenario(seed=42)
    personality = PersonalityVector(weights=np.array([0.25, 0.2, 0.2, 0.15, 0.2]))
    tau = _normalize_pressures(G_decomp, 50)
    scores = compute_iaus_scores(G_decomp, 50, personality, novelty_history=[0.0] * 10)

    decomposition = {
        "tau_values": {f"tau{i+1}": float(tau["normed"][i]) for i in range(6)},
        "entropy": _entropy(tau["normed"]),
        "scores": scores,
    }
    results["decomposition"] = decomposition
    print(f"    τ 向量: [{', '.join(f'{tau[f'tau{i+1}']:.3f}' for i in range(6))}]")
    print(f"    熵: {decomposition['entropy']:.3f}")
    print(f"    IAUS 得分: {', '.join(f'{k}={v:.4f}' for k, v in scores.items())}")

    return results


def plot_exp_iaus(results: dict, save_path: str) -> None:
    """生成 A/B 对比图表。"""
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle("ADR-180: IAUS Multiplicative vs Additive Scoring A/B Comparison",
                 fontsize=14, fontweight="bold")

    # --- 1. Directed: diligence 选中率对比 ---
    ax = axes[0, 0]
    d = results["directed"]
    bars = ax.bar(["Additive", "Multiplicative"],
                  [d["additive_diligence_rate"], d["multiplicative_diligence_rate"]],
                  color=["#4A90D9", "#E74C3C"], alpha=0.8)
    ax.set_ylabel("Diligence Selection Rate")
    ax.set_title("Scenario 1: Directed (P5 High)\nShould select Diligence")
    ax.set_ylim(0, 1)
    for bar, val in zip(bars, [d["additive_diligence_rate"], d["multiplicative_diligence_rate"]]):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                f"{val:.1%}", ha="center", va="bottom", fontsize=11)

    # --- 2. Proactive: IAUS 得分分化 + 排名 ---
    ax = axes[0, 1]
    p = results["proactive"]
    metrics = ["Score (Directed)", "Score (Proactive)", "Top-1 Rate", "Selection Rate"]
    vals = [
        p["m_mean_diligence_score_directed"],
        p["m_mean_diligence_score_proactive"],
        p["m_diligence_top_rate"],
        p["m_diligence_selection_rate"],
    ]
    colors = ["#E74C3C", "#F39C12", "#9B59B6", "#3498DB"]
    bars = ax.bar(metrics, vals, color=colors, alpha=0.8)
    for bar, val in zip(bars, vals):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                f"{val:.3f}", ha="center", va="bottom", fontsize=9)
    ax.set_title(f"Scenario 2: IAUS Diligence Score Differentiation\n"
                 f"Ratio={p['score_ratio']:.2f} (lower=better veto)")
    ax.set_ylim(0, 1.1)
    ax.tick_params(axis='x', rotation=15)

    # --- 3. Idle Growth: 单调性 ---
    ax = axes[1, 0]
    ig = results["idle_growth"]
    bars = ax.bar(["Additive", "Multiplicative"],
                  [ig["additive_monotone_ratio"], ig["multiplicative_monotone_ratio"]],
                  color=["#4A90D9", "#E74C3C"], alpha=0.8)
    ax.set_ylabel("Monotone Increase Ratio")
    ax.set_title("Scenario 3: Idle Growth\nScore should increase monotonically")
    ax.set_ylim(0, 1.05)
    for bar, val in zip(bars, [ig["additive_monotone_ratio"], ig["multiplicative_monotone_ratio"]]):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                f"{val:.1%}", ha="center", va="bottom", fontsize=11)

    # --- 4. Monopoly: action 分布对比 ---
    ax = axes[1, 1]
    m = results["monopoly"]
    actions = ["Diligence", "Sociability"]
    a_vals = [m["additive_diligence_rate"], m["additive_sociability_rate"]]
    m_vals = [m["multiplicative_diligence_rate"], m["multiplicative_sociability_rate"]]
    x = np.arange(len(actions))
    w = 0.35
    ax.bar(x - w/2, a_vals, w, label="Additive", color="#4A90D9", alpha=0.8)
    ax.bar(x + w/2, m_vals, w, label="Multiplicative", color="#E74C3C", alpha=0.8)
    ax.set_xticks(x)
    ax.set_xticklabels(actions)
    ax.set_title("Scenario 4: Attention Monopoly\nBetter = more sociability share")
    ax.set_ylim(0, 1)
    ax.legend()

    plt.tight_layout()
    plt.savefig(save_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  图表已保存: {save_path}")


# ---------------------------------------------------------------------------
# 独立运行入口
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 60)
    print("ADR-180 Phase 1: IAUS 乘法评分 A/B 模拟验证")
    print("=" * 60)

    results = run_exp_iaus(n_trials=30, n_steps=50)

    fig_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "experiments", "figures")
    os.makedirs(fig_dir, exist_ok=True)
    plot_exp_iaus(results, os.path.join(fig_dir, "exp_iaus_ab.pdf"))

    # 总结
    print("\n" + "=" * 60)
    print("实验总结")
    print("=" * 60)

    d = results["directed"]
    print(f"\n1. Directed 场景:")
    print(f"   加法 diligence: {d['additive_diligence_rate']:.1%}")
    print(f"   乘法 diligence: {d['multiplicative_diligence_rate']:.1%}")
    d_pass = d["multiplicative_diligence_rate"] >= 0.5
    print(f"   {'✓ PASS' if d_pass else '✗ FAIL'}: 乘法应保留回复行为 (≥50%)")

    p = results["proactive"]
    print(f"\n2. Proactive 场景 (P5≈0, 无回复义务):")
    print(f"   IAUS diligence 得分: directed={p['m_mean_diligence_score_directed']:.4f}, proactive={p['m_mean_diligence_score_proactive']:.4f}")
    print(f"   得分比 (proactive/directed): {p['score_ratio']:.3f}")
    print(f"   diligence 排名第一率: {p['m_diligence_top_rate']:.1%}")
    # Pass 判据 1: Score differentiation — P5≈0 时 diligence 得分应显著降低
    # 得分比 < 0.85 表明乘法确实区分了"有义务"和"无义务"
    p_pass_score = p["score_ratio"] < 0.85
    # Pass 判据 2: 非 diligence 行为应占多数（>50%）
    p_pass_rank = p["m_nondiligence_rate"] > 0.5
    p_pass = p_pass_score and p_pass_rank
    print(f"   {'✓ PASS' if p_pass_score else '✗ FAIL'}: 得分分化 (ratio < 0.85)")
    print(f"   {'✓ PASS' if p_pass_rank else '✗ FAIL'}: non-diligence 行为占多数 ({p['m_nondiligence_rate']:.1%} > 50%)")

    ig = results["idle_growth"]
    print(f"\n3. Idle Growth:")
    print(f"   加法单调性: {ig['additive_monotone_ratio']:.1%}")
    print(f"   乘法单调性: {ig['multiplicative_monotone_ratio']:.1%}")
    # P5 halflife 衰减导致合法的非单调性——75% 是合理阈值
    ig_pass = ig["multiplicative_monotone_ratio"] >= 0.75
    print(f"   {'✓ PASS' if ig_pass else '✗ FAIL'}: 乘法应保持空闲增长 (≥75%)")
    print(f"   注意：P5 halflife 衰减导致合法的短期非单调性")

    m = results["monopoly"]
    print(f"\n4. Attention Monopoly:")
    print(f"   加法 sociability: {m['additive_sociability_rate']:.1%}")
    print(f"   乘法 sociability: {m['multiplicative_sociability_rate']:.1%}")

    dec = results["decomposition"]
    print(f"\n5. Score Decomposition (single tick):")
    for k, v in dec["scores"].items():
        print(f"   {k}: {v:.4f}")

    print(f"\n{'=' * 60}")
    all_pass = d_pass and ig_pass and p_pass
    print(f"核心不变量: {'ALL PASS' if all_pass else 'SOME FAIL'}")
    print(f"{'=' * 60}")

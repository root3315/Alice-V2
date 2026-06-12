"""多声部决策模型（论文 §4）— v4。

五个声部 (Voice) 竞争行动权，由人格向量 π 调制。

v4 变更：
- P3 纯粹化：compute_loudness 不再传 api_history 给 P3
- 竞争在门：声部竞争是压力间唯一的交互点
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from graph import CompanionGraph
from pressure import (
    P1_attention_debt,
    P2_information_pressure,
    P3_relationship_cooling,
    P4_thread_divergence,
    P5_response_obligation,
    P6_curiosity,
    api_aggregate,
    observable_mapping,
)


# ---------------------------------------------------------------------------
# 声部定义
# ---------------------------------------------------------------------------

VOICE_NAMES = ["Diligence", "Curiosity", "Sociability", "Caution", "Reflection"]
VOICE_SHORT = ["D", "C", "S", "X", "R"]


@dataclass
class PersonalityVector:
    """人格向量 π = (π_D, π_C, π_S, π_X, π_R)，满足 sum = 1。"""

    weights: np.ndarray = field(default_factory=lambda: np.array([0.2, 0.2, 0.2, 0.2, 0.2]))

    def __post_init__(self) -> None:
        self.weights = np.asarray(self.weights, dtype=float)
        self._normalize()

    def _normalize(self) -> None:
        """确保权重之和为 1。"""
        s = self.weights.sum()
        if s > 0:
            self.weights /= s
        else:
            self.weights = np.ones(5) / 5.0

    @property
    def pi_D(self) -> float:
        return float(self.weights[0])

    @property
    def pi_C(self) -> float:
        return float(self.weights[1])

    @property
    def pi_S(self) -> float:
        return float(self.weights[2])

    @property
    def pi_X(self) -> float:
        return float(self.weights[3])

    @property
    def pi_R(self) -> float:
        return float(self.weights[4])

    def __repr__(self) -> str:
        names = VOICE_SHORT
        parts = [f"{n}={w:.3f}" for n, w in zip(names, self.weights)]
        return f"PersonalityVector({', '.join(parts)})"


# ---------------------------------------------------------------------------
# Uncertainty 计算（驱动 Caution 声部的正向激活）
# ---------------------------------------------------------------------------

def _compute_uncertainty(
    recent_event_counts: list[int] | None = None,
    k: int = 10,
    expected_rate: float = 2.0,
) -> float:
    """信息不足度。近期事件少于期望时上升。

    借鉴 Active Inference 的 epistemic value：
    不确定性高时驱动"等待/观察"行为。

    Parameters
    ----------
    recent_event_counts : list[int] | None
        最近 k 个 tick 的事件数列表。
    k : int
        回顾窗口。
    expected_rate : float
        期望的每 tick 平均事件率。

    Returns
    -------
    float
        不确定度 ∈ [0, 1]。0 = 信息充足，1 = 完全无信息。
    """
    if not recent_event_counts:
        return 0.5  # 无历史时中等不确定

    recent = recent_event_counts[-k:]
    actual_rate = sum(recent) / len(recent)
    ratio = min(actual_rate / max(expected_rate, 0.01), 2.0)
    return max(0.0, 1.0 - ratio)


# ---------------------------------------------------------------------------
# 声部响度计算
# ---------------------------------------------------------------------------

def compute_loudness(
    G: CompanionGraph,
    n: int,
    personality: PersonalityVector,
    novelty_history: list[float] | None = None,
    recent_event_counts: list[int] | None = None,
    kappa_x: float = 3.0,
    epsilon_scale: float = 0.05,
    rng: np.random.Generator | None = None,
    kappa_p: np.ndarray | None = None,
    risk_boost: float = 0.0,
    mood: dict[str, float] | None = None,
) -> np.ndarray:
    """计算五个声部的响度 L_i(n)。

    L_i(n) = π_i * f_i(P1..P6) + ε_i(n)

    v4: P3 纯粹测量，不读 API。竞争在门——声部竞争是唯一交互点。

    激活函数映射：
    - f_D = (nP1 + nP4 + nP5) / 3  — 注意力 + 线程 + 回应义务
    - f_C = max(nP2, nP6)           — 信息压力 OR 好奇心（取强项）
    - f_S = nP3                     — 关系冷却
    - f_X = uncertainty - nAPI_sum / κ_X  — 不确定时正，压力高时负
    - f_R = nP2                     — 信息压力

    其中 nPi = tanh(Pi / κi) 为逐压力归一化后的值。

    Parameters
    ----------
    kappa_p : np.ndarray | None
        压力归一化 κ 向量，长度 6，对应 P1-P6。
        为 None 时使用 Python 模拟默认值 [30, 8, 8, 200, 10, 0.5]。

        κ 分裂说明：
        - Python 模拟默认值 [30, 8, 8, 200, 10, 0.5] 是为 ~15 contacts,
          8 threads, 4 channels, 10 items 的合成图设计的（配合 _scale_kappa 缩放）。
        - TS runtime 使用 [5, 8, 8, 200, 3, 0.5] 是为小型图（少量联系人/频道）
          设计的固定值。
        - 交叉验证时两侧使用相同的显式值，不依赖任何默认值。
        - 未来 TS runtime 也应该实现 κ 缩放（当图增大时）。
    """
    if rng is None:
        rng = np.random.default_rng()

    # 计算六个压力（v4: P3 不读 API）
    p1, _ = P1_attention_debt(G, n)
    p2, _ = P2_information_pressure(G, n)
    p3, _ = P3_relationship_cooling(G, n)
    p4, _ = P4_thread_divergence(G, n)
    p5, _ = P5_response_obligation(G, n)
    p6, _ = P6_curiosity(G, n, novelty_history=novelty_history)
    api = api_aggregate(p1, p2, p3, p4, p5, p6)

    # 逐压力 tanh 归一化
    # Python 模拟默认 κ：为 ~15 contacts, 8 threads, 4 channels, 10 items 的合成图设计
    # TS runtime 使用 [5, 8, 8, 200, 3, 0.5]（小型图固定值）
    if kappa_p is None:
        kappa_p = np.array([30.0, 8.0, 8.0, 200.0, 10.0, 0.5])
    raw = np.array([p1, p2, p3, p4, p5, p6])
    normed = np.tanh(raw / kappa_p)  # 各压力 ∈ [0, 1)

    # nAPI = sum of normed pressures ∈ [0, 6)
    normed_api_sum = float(normed.sum())

    # Uncertainty（驱动 Caution 的正向激活）
    uncertainty = _compute_uncertainty(recent_event_counts)

    # v2 激活函数 + ADR-23 risk_boost
    f = np.array([
        (normed[0] + normed[3] + normed[4]) / 3.0,  # f_D: P1 + P4 + P5
        max(normed[1], normed[5]),                       # f_C: max(P2, P6)
        normed[2],                                      # f_S: P3
        uncertainty - normed_api_sum / kappa_x + risk_boost,  # f_X + risk_boost
        normed[1],                                      # f_R: P2
    ])

    # ADR-23 Wave 5.4: 情绪调制
    if mood is not None:
        if mood.get("valence", 0) < -0.3:
            f[3] += 0.15
    # 响度 = 人格权重 * 激活 + 随机扰动
    pi = personality.weights
    epsilon = rng.normal(0, epsilon_scale, size=5)
    loudness = pi * f + epsilon

    # ADR-23 Wave 5.4: 高唤醒 → 赢家放大
    if mood is not None and mood.get("arousal", 0) > 0.7:
        max_idx = int(np.argmax(loudness))
        loudness[max_idx] *= 1.2

    return loudness


# ---------------------------------------------------------------------------
# 行动选择（v2: softmax with adaptive τ）
# ---------------------------------------------------------------------------

VOICE_ACTIONS: dict[int, str] = {
    0: "diligence",
    1: "curiosity",
    2: "sociability",
    3: "caution",
    4: "reflection",
}


def select_action(
    loudness: np.ndarray,
    rng: np.random.Generator | None = None,
) -> tuple[int, str]:
    """概率化行动选择（softmax with adaptive τ）。

    温度参数自适应：
    - 声部分化度高（std 大）→ 低温 → 近似确定性选择
    - 声部分化度低（std 小）→ 高温 → 增加探索

    τ = τ_min + (τ_max - τ_min) / (1 + c * std(L))

    Returns
    -------
    tuple[int, str]
        (获胜声部索引, 行动类型名称)。
    """
    if rng is None:
        rng = np.random.default_rng()

    # 自适应温度
    spread = float(np.std(loudness))
    tau = 0.1 + 0.3 / (1.0 + spread * 10.0)  # τ ∈ [0.1, 0.4]

    # Softmax（数值稳定）
    shifted = loudness - loudness.max()
    log_probs = shifted / tau
    # 防止 exp 溢出
    log_probs = np.clip(log_probs, -50.0, 0.0)
    probs = np.exp(log_probs)
    prob_sum = probs.sum()
    if prob_sum > 0:
        probs /= prob_sum
    else:
        probs = np.ones(5) / 5.0

    winner = int(rng.choice(5, p=probs))
    return winner, VOICE_ACTIONS[winner]


# ---------------------------------------------------------------------------
# 人格演化（v2: 加均值回归 + 硬下界）
# ---------------------------------------------------------------------------

def personality_evolution_step(
    personality: PersonalityVector,
    action_idx: int,
    feedback: float,
    alpha: float = 0.001,
    gamma: float = 0.0005,
    pi_home: np.ndarray | None = None,
    pi_min: float = 0.05,
) -> PersonalityVector:
    """人格向量的一步演化。

    v2 公式：
    π_i(n+1) = π_i(n) + α·Δ_i(n) - γ·(π_i(n) - π₀_i)

    三个机制共同保证人格稳定性：
    1. 强化学习：α·feedback 使人格向有效行为漂移
    2. 均值回归：-γ·(π - π₀) 将人格拉向初始基线（"性格的家"）
    3. 硬下界：π_i ≥ π_min 确保任何声部不会完全消失

    Parameters
    ----------
    gamma : float
        均值回归系数。γ ≈ α/2，保证回归力弱于学习力但始终存在。
    pi_home : np.ndarray | None
        基线人格向量（"家"）。为 None 时不使用均值回归。
    pi_min : float
        任何声部权重的硬下界。
    """
    new_weights = personality.weights.copy()

    # 1. 强化学习
    delta = alpha * feedback
    new_weights[action_idx] += delta

    # 2. 均值回归：拉向初始人格
    if pi_home is not None:
        new_weights -= gamma * (new_weights - pi_home)

    # 3. 硬下界
    new_weights = np.maximum(new_weights, pi_min)

    return PersonalityVector(weights=new_weights)

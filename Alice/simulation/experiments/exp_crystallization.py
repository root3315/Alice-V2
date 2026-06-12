"""结晶动力学模拟实验。

验证 Cognitive Label Pipeline 的四个核心预测：
- Exp A: σ² 收敛曲线（相变图）— 含跨日衰减建模，展示 θ 修复效果
- Exp B: 结晶衰减曲线 — trait/interest 用 half-life，jargon/expression 用 hard expiry
- Exp C: 多联系人兴趣积累 — precision/recall vs 观察频率（含 σ² 膨胀）
- Exp D: 单极 vs 双极对比 — interest 和 trait 的行为差异

独立脚本，不依赖 SimulationEngine。与 exp_pomdp_belief.py 同构。

@see paper/sections/05-memory.tex §5.5 Cognitive Label Pipeline
@see docs/adr/208-cognitive-label-interest-domain.md
"""
from __future__ import annotations

import math
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

FIGURES_DIR = Path(__file__).parent / "figures"
FIGURES_DIR.mkdir(exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════
# 核心组件：EMA 信念更新 + OU 衰减（复刻 runtime/src/belief/）
# ═══════════════════════════════════════════════════════════════════════════

DEFAULT_ALPHA = 0.3
STRUCTURAL_EPSILON = 1e-8


def ema_update(
    mu: float,
    sigma2: float,
    observation: float,
    alpha: float = DEFAULT_ALPHA,
    noise: float = 0.1,
) -> tuple[float, float]:
    """EMA 信念更新。复刻 runtime belief/update.ts。"""
    mu_new = (1 - alpha) * mu + alpha * observation
    sigma2_new = max((1 - alpha) ** 2 * sigma2 + alpha**2 * noise, STRUCTURAL_EPSILON)
    return mu_new, sigma2_new


def decay_belief(
    mu: float,
    sigma2: float,
    dt_s: float,
    half_life: float,
    mu_prior: float = 0.0,
    sigma2_inf: float = 1.0,
    theta: float = 1 / 6_000_000,
) -> tuple[float, float]:
    """OU 信念衰减。复刻 runtime belief/decay.ts。"""
    if dt_s <= 0:
        return mu, sigma2
    mu_eff = mu_prior + (mu - mu_prior) * 2 ** (-dt_s / half_life)
    sigma2_eff = sigma2_inf - (sigma2_inf - sigma2) * math.exp(-2 * theta * dt_s)
    return mu_eff, sigma2_eff


# ═══════════════════════════════════════════════════════════════════════════
# 域参数定义（与 runtime 常量对齐）
# ═══════════════════════════════════════════════════════════════════════════


class DomainParams:
    """一个认知标签域的完整参数集。"""

    def __init__(
        self,
        name: str,
        theta_sigma: float,
        n_min: int,
        theta_mu: float | None,
        h_eph_s: float,
        h_crystal_s: float,
        polarity: str,
        decay_mode: str = "half_life",  # "half_life" 或 "expiry"
        sigma2_theta: float = 1 / 6_000_000,  # σ² 膨胀速率
        epsilon: float = 0.05,
        color: str = "black",
    ):
        self.name = name
        self.theta_sigma = theta_sigma
        self.n_min = n_min
        self.theta_mu = theta_mu
        self.h_eph_s = h_eph_s
        self.h_crystal_s = h_crystal_s
        self.polarity = polarity
        self.decay_mode = decay_mode
        self.sigma2_theta = sigma2_theta
        self.epsilon = epsilon
        self.color = color

    @property
    def h_crystal_days(self) -> float:
        return self.h_crystal_s / 86400


# @see runtime/src/belief/types.ts TRAIT_BELIEF_DECAY (θ = 1/6_000_000)
# @see runtime/src/index.ts registerDomainDecay (jargon/expression θ = 0.001)
# @see runtime/src/mods/learning.mod.ts CRYSTALLIZED_EXPIRY_S (21d hard expiry)
TRAIT = DomainParams(
    "trait", 0.05, 3, 0.2, 28800, 604800, "bipolar",
    decay_mode="half_life", sigma2_theta=1 / 6_000_000, color="#2196F3",
)
JARGON = DomainParams(
    "jargon", 0.08, 2, None, 720, 1_814_400, "unipolar",
    decay_mode="expiry", sigma2_theta=0.001, color="#FF9800",
)
EXPRESSION = DomainParams(
    "expression", 0.10, 2, 0.5, 1440, 1_814_400, "unipolar",
    decay_mode="expiry", sigma2_theta=0.001, color="#4CAF50",
)
INTEREST = DomainParams(
    "interest", 0.06, 2, 0.3, 28800, 2_592_000, "unipolar",
    decay_mode="half_life", sigma2_theta=1 / 6_000_000, color="#9C27B0",
)

ALL_DOMAINS = [TRAIT, JARGON, EXPRESSION, INTEREST]


# ═══════════════════════════════════════════════════════════════════════════
# Exp A: σ² 收敛曲线（含 σ² 膨胀建模）
# ═══════════════════════════════════════════════════════════════════════════


def exp_a():
    """2-panel: (a) σ² vs 天数（跨日场景）, (b) μ vs 天数。

    模拟真实场景：每天 1 次对话，每次 3 次 tag_interest / self_sense。
    展示 θ=1/6M（修复后）下 trait/interest 跨日结晶可行。
    """
    N_DAYS = 10
    OBS_PER_SESSION = 3
    INTRA_OBS_INTERVAL_S = 60  # 同一对话内观测间隔

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    # Panel (a): σ² 日末快照
    for domain in [TRAIT, INTEREST]:
        obs_val = 0.7 if domain.polarity == "bipolar" else 1.0
        mu, sigma2 = 0.0, 1.0
        sigma2_snapshots = []
        obs_count = 0

        for day in range(N_DAYS):
            if day > 0:
                mu, sigma2 = decay_belief(
                    mu, sigma2, 86400, domain.h_eph_s,
                    theta=domain.sigma2_theta,
                )
            for obs_i in range(OBS_PER_SESSION):
                if obs_i > 0:
                    mu, sigma2 = decay_belief(
                        mu, sigma2, INTRA_OBS_INTERVAL_S, domain.h_eph_s,
                        theta=domain.sigma2_theta,
                    )
                mu, sigma2 = ema_update(mu, sigma2, obs_val)
                obs_count += 1
            sigma2_snapshots.append(sigma2)

        ax1.plot(
            range(1, N_DAYS + 1), sigma2_snapshots,
            "-o", color=domain.color, label=domain.name, markersize=5, linewidth=2,
        )
        ax1.axhline(
            domain.theta_sigma, color=domain.color,
            linestyle="--", alpha=0.5, linewidth=1,
        )

    # 对比：旧 θ=1/60000 下的 interest
    mu, sigma2 = 0.0, 1.0
    old_snapshots = []
    for day in range(N_DAYS):
        if day > 0:
            mu, sigma2 = decay_belief(mu, sigma2, 86400, 28800, theta=1 / 60_000)
        for obs_i in range(OBS_PER_SESSION):
            if obs_i > 0:
                mu, sigma2 = decay_belief(mu, sigma2, INTRA_OBS_INTERVAL_S, 28800, theta=1 / 60_000)
            mu, sigma2 = ema_update(mu, sigma2, 1.0)
        old_snapshots.append(sigma2)
    ax1.plot(
        range(1, N_DAYS + 1), old_snapshots,
        "--x", color=INTEREST.color, alpha=0.4, markersize=5, linewidth=1.5,
        label="interest (old θ=1/60k)",
    )

    ax1.set_xlabel("Day (3 obs/day, 24h interval)")
    ax1.set_ylabel("$\\sigma^2$ (end of session)")
    ax1.set_title("(a) Variance convergence with inter-session decay")
    ax1.legend(fontsize=8)
    ax1.grid(True, alpha=0.3)
    ax1.set_ylim(0, 0.55)

    # Panel (b): μ 日末快照
    for domain in [TRAIT, INTEREST]:
        obs_val = 0.7 if domain.polarity == "bipolar" else 1.0
        mu, sigma2 = 0.0, 1.0
        mu_snapshots = []

        for day in range(N_DAYS):
            if day > 0:
                mu, sigma2 = decay_belief(
                    mu, sigma2, 86400, domain.h_eph_s,
                    theta=domain.sigma2_theta,
                )
            for obs_i in range(OBS_PER_SESSION):
                if obs_i > 0:
                    mu, sigma2 = decay_belief(
                        mu, sigma2, INTRA_OBS_INTERVAL_S, domain.h_eph_s,
                        theta=domain.sigma2_theta,
                    )
                mu, sigma2 = ema_update(mu, sigma2, obs_val)
            mu_snapshots.append(mu)

        ls = "-" if domain == INTEREST else "--"
        ax2.plot(
            range(1, N_DAYS + 1), mu_snapshots,
            f"{ls}o", color=domain.color, label=domain.name, markersize=5, linewidth=2,
        )
        if domain.theta_mu is not None:
            ax2.axhline(
                domain.theta_mu, color=domain.color,
                linestyle=":", alpha=0.5,
                label=f"$\\theta_\\mu$ ({domain.name})",
            )

    ax2.set_xlabel("Day")
    ax2.set_ylabel("$\\mu$ (end of session)")
    ax2.set_title("(b) Mean convergence with inter-session μ-decay")
    ax2.legend(fontsize=8)
    ax2.grid(True, alpha=0.3)

    fig.suptitle("Experiment A: Cross-Session Crystallization (3 obs/day, 24h apart)", fontsize=13)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "crystallization_a.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ crystallization_a.png")


# ═══════════════════════════════════════════════════════════════════════════
# Exp B: 结晶衰减曲线（half-life vs hard expiry）
# ═══════════════════════════════════════════════════════════════════════════


def exp_b():
    """1-panel: confidence/|value| 衰减 over 60 天。
    trait/interest: 指数 half-life 衰减。
    jargon/expression: hard expiry（21 天阶跃消失）。
    """
    days = np.linspace(0, 60, 500)

    fig, ax = plt.subplots(figsize=(8, 5))

    for domain in ALL_DOMAINS:
        h_days = domain.h_crystal_days
        v0 = 1.0
        if domain.decay_mode == "half_life":
            values = v0 * 2 ** (-days / h_days)
            ax.plot(
                days, values, color=domain.color,
                label=f"{domain.name} (half-life {h_days:.0f}d)", linewidth=2,
            )
        else:
            # hard expiry: 满值直到 h_crystal_days，然后瞬间消失
            values = np.where(days <= h_days, v0, 0.0)
            ax.plot(
                days, values, color=domain.color,
                label=f"{domain.name} (expiry {h_days:.0f}d)", linewidth=2,
            )
        ax.axhline(domain.epsilon, color=domain.color, linestyle=":", alpha=0.4, linewidth=1)

    ax.set_xlabel("Time (days)")
    ax.set_ylabel("Confidence / |value| (normalized)")
    ax.set_title("Experiment B: Crystallized Label Decay (half-life vs expiry)")
    ax.legend(fontsize=9)
    ax.grid(True, alpha=0.3)
    ax.set_ylim(-0.02, 1.15)

    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "crystallization_b.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ crystallization_b.png")


# ═══════════════════════════════════════════════════════════════════════════
# Exp C: 多联系人兴趣积累（含 σ² 膨胀）
# ═══════════════════════════════════════════════════════════════════════════


def exp_c():
    """2-panel: (a) 已结晶兴趣数 vs day, (b) precision/recall vs 每日观察次数。

    使用真实参数：每天 1 次对话 session，观察间隔 60s，跨日 24h decay。
    """
    rng = np.random.default_rng(42)

    N_CONTACTS = 5
    N_TRUE_INTERESTS = 3
    N_DAYS = 20
    OBS_PER_SESSION = [5, 3, 2, 1, 1]  # 不同联系人的每日会话观察次数

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    colors_c = plt.cm.viridis(np.linspace(0.1, 0.9, N_CONTACTS))

    # Panel (a): 结晶数 vs day
    for ci in range(N_CONTACTS):
        n_obs = OBS_PER_SESSION[ci]
        # 每个联系人有 3 个真实兴趣
        beliefs = [(0.0, 1.0) for _ in range(N_TRUE_INTERESTS)]
        obs_counts = [0] * N_TRUE_INTERESTS
        crystallized_trace = []

        for day in range(N_DAYS):
            # 跨日 decay
            if day > 0:
                for j in range(N_TRUE_INTERESTS):
                    mu, sigma2 = beliefs[j]
                    mu, sigma2 = decay_belief(mu, sigma2, 86400, INTEREST.h_eph_s, theta=INTEREST.sigma2_theta)
                    beliefs[j] = (mu, sigma2)

            # 日内观察（每个兴趣分别观察）
            for obs_i in range(n_obs):
                j = obs_i % N_TRUE_INTERESTS
                if obs_i > 0:
                    mu, sigma2 = beliefs[j]
                    mu, sigma2 = decay_belief(mu, sigma2, 60, INTEREST.h_eph_s, theta=INTEREST.sigma2_theta)
                    beliefs[j] = (mu, sigma2)
                mu, sigma2 = beliefs[j]
                mu, sigma2 = ema_update(mu, sigma2, 1.0)
                beliefs[j] = (mu, sigma2)
                obs_counts[j] += 1

            # 计数结晶
            crystals = sum(
                1 for j in range(N_TRUE_INTERESTS)
                if beliefs[j][1] < INTEREST.theta_sigma
                and obs_counts[j] >= INTEREST.n_min
                and beliefs[j][0] > INTEREST.theta_mu
            )
            crystallized_trace.append(crystals)

        ax1.plot(
            range(1, N_DAYS + 1), crystallized_trace,
            color=colors_c[ci],
            label=f"Contact {ci+1} ({n_obs} obs/day)",
            linewidth=1.5, marker="o", markersize=3,
        )

    ax1.set_xlabel("Day")
    ax1.set_ylabel("Crystallized interests")
    ax1.set_title("(a) Interest accumulation (daily sessions)")
    ax1.legend(fontsize=8)
    ax1.grid(True, alpha=0.3)
    ax1.set_ylim(-0.1, N_TRUE_INTERESTS + 0.5)

    # Panel (b): precision/recall vs 每日观察次数
    sweep_obs = range(1, 12)
    precisions = []
    recalls = []

    for n_obs in sweep_obs:
        beliefs = [(0.0, 1.0) for _ in range(N_TRUE_INTERESTS)]
        obs_counts = [0] * N_TRUE_INTERESTS
        noise_beliefs = [(0.0, 1.0), (0.0, 1.0)]
        noise_obs = [0, 0]

        for day in range(N_DAYS):
            if day > 0:
                for j in range(N_TRUE_INTERESTS):
                    mu, sigma2 = beliefs[j]
                    mu, sigma2 = decay_belief(mu, sigma2, 86400, INTEREST.h_eph_s, theta=INTEREST.sigma2_theta)
                    beliefs[j] = (mu, sigma2)
                for k in range(2):
                    mu, sigma2 = noise_beliefs[k]
                    mu, sigma2 = decay_belief(mu, sigma2, 86400, INTEREST.h_eph_s, theta=INTEREST.sigma2_theta)
                    noise_beliefs[k] = (mu, sigma2)

            for obs_i in range(n_obs):
                j = obs_i % N_TRUE_INTERESTS
                mu, sigma2 = beliefs[j]
                mu, sigma2 = ema_update(mu, sigma2, 1.0)
                beliefs[j] = (mu, sigma2)
                obs_counts[j] += 1

            # 噪声：每天 10% 概率误标一个噪声兴趣
            for k in range(2):
                if rng.random() < 0.1:
                    mu, sigma2 = noise_beliefs[k]
                    mu, sigma2 = ema_update(mu, sigma2, 1.0)
                    noise_beliefs[k] = (mu, sigma2)
                    noise_obs[k] += 1

        true_crystals = sum(
            1 for j in range(N_TRUE_INTERESTS)
            if beliefs[j][1] < INTEREST.theta_sigma
            and obs_counts[j] >= INTEREST.n_min
            and beliefs[j][0] > INTEREST.theta_mu
        )
        false_crystals = sum(
            1 for k in range(2)
            if noise_beliefs[k][1] < INTEREST.theta_sigma
            and noise_obs[k] >= INTEREST.n_min
            and noise_beliefs[k][0] > INTEREST.theta_mu
        )

        total = true_crystals + false_crystals
        precisions.append(true_crystals / total if total > 0 else 1.0)
        recalls.append(true_crystals / N_TRUE_INTERESTS)

    ax2.plot(list(sweep_obs), recalls, "o-", color=INTEREST.color, label="Recall", markersize=5, linewidth=1.5)
    ax2.plot(list(sweep_obs), precisions, "s-", color=TRAIT.color, label="Precision", markersize=5, linewidth=1.5)
    ax2.set_xlabel("Observations per day")
    ax2.set_ylabel("Score")
    ax2.set_title("(b) Precision/recall vs daily observation rate")
    ax2.legend(fontsize=9)
    ax2.grid(True, alpha=0.3)
    ax2.set_ylim(-0.05, 1.15)

    fig.suptitle("Experiment C: Multi-Contact Interest Accumulation (20-day sim)", fontsize=13)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "crystallization_c.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ crystallization_c.png")


# ═══════════════════════════════════════════════════════════════════════════
# Exp D: 单极 vs 双极对比
# ═══════════════════════════════════════════════════════════════════════════


def exp_d():
    """1-panel: 先 5 次正观察 → 3 次负观察，比较两域反应。"""
    obs_sequence = [0.7] * 5 + [-0.7] * 3
    interest_obs = [1.0] * 5 + [1.0] * 3

    N = len(obs_sequence)
    ns = np.arange(1, N + 1)

    fig, ax = plt.subplots(figsize=(8, 5))

    # Trait（双极）
    trait_mu, trait_sigma2 = 0.0, 1.0
    trait_mu_trace = []
    for obs in obs_sequence:
        trait_mu, trait_sigma2 = ema_update(trait_mu, trait_sigma2, obs)
        trait_mu_trace.append(trait_mu)

    # Interest（单极）
    int_mu, int_sigma2 = 0.0, 1.0
    int_mu_trace = []
    for obs in interest_obs:
        int_mu, int_sigma2 = ema_update(int_mu, int_sigma2, obs)
        int_mu_trace.append(int_mu)

    ax.plot(ns, trait_mu_trace, "o-", color=TRAIT.color, label="trait μ (bipolar)", linewidth=2, markersize=6)
    ax.plot(ns, int_mu_trace, "s-", color=INTEREST.color, label="interest μ (unipolar)", linewidth=2, markersize=6)

    ax.axvline(5.5, color="gray", linestyle="--", alpha=0.5, label="positive → negative")
    ax.axhline(0, color="gray", linestyle="-", alpha=0.3)

    ax.axhline(TRAIT.theta_mu, color=TRAIT.color, linestyle=":", alpha=0.4, label=f"$\\theta_\\mu$ (trait={TRAIT.theta_mu})")
    ax.axhline(INTEREST.theta_mu, color=INTEREST.color, linestyle=":", alpha=0.4, label=f"$\\theta_\\mu$ (interest={INTEREST.theta_mu})")

    ax.annotate("5× positive obs", xy=(3, 0.05), fontsize=9, ha="center", color="gray")
    ax.annotate("3× negative obs\n(trait reversal)", xy=(7, 0.05), fontsize=9, ha="center", color="gray")

    ax.set_xlabel("Observation #")
    ax.set_ylabel("$\\mu$")
    ax.set_title("Experiment D: Unipolar vs Bipolar — Response to Contradictory Evidence")
    ax.legend(fontsize=9, loc="center right")
    ax.grid(True, alpha=0.3)
    ax.set_ylim(-0.6, 1.1)

    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "crystallization_d.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  ✓ crystallization_d.png")


# ═══════════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=== Crystallization Dynamics Experiments ===\n")
    exp_a()
    exp_b()
    exp_c()
    exp_d()
    print(f"\n✓ All figures saved to {FIGURES_DIR}")

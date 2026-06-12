"""ADR-154 Goldilocks Window 验证模拟。

验证目标：
1. 窗口参数推导正确（t_min/t_max/t_peak/σ_ln 与 ADR-154 §4.1 一致）
2. 效用曲线行为正确（窗口外=0, 峰值=1, 对称性）
3. σ_cool tier 化修复了"全局 1h"缺陷（场景 A/B 对比）
4. 各 tier 效用曲线形状一致（Weber-Fechner 对数自相似性）
5. 自适应窗口（EMA + σ²）行为合理

@see docs/adr/154-goldilocks-window/README.md
"""

from __future__ import annotations

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "goldilocks_validation"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── 常量（与 constants.ts 对齐）────────────────────────────────────

DUNBAR_TIER_THETA: dict[int, float] = {
    5: 7200,
    15: 14400,
    50: 43200,
    150: 172800,
    500: 604800,
}

GOLDILOCKS_ALPHA = 0.15


# ── Goldilocks 核心实现 ─────────────────────────────────────────────


def goldilocks_params(tier: int) -> dict[str, float]:
    """从 tier 推导 Goldilocks 窗口参数。与 ADR-154 §2.2 对齐。"""
    theta_c = DUNBAR_TIER_THETA[tier]
    tau_cool = GOLDILOCKS_ALPHA * theta_c
    t_min = np.log(10) * tau_cool  # σ_cool 衰减到 10%（ln(10) ≈ 2.302585）
    t_max = theta_c
    t_peak = np.sqrt(t_min * t_max)  # 几何均值——对数域中点
    sigma_ln = (np.log(t_max) - np.log(t_min)) / 4

    return {
        "t_min": t_min,
        "t_max": t_max,
        "t_peak": t_peak,
        "sigma_ln": sigma_ln,
        "tau_cool": tau_cool,
    }


def goldilocks_utility(
    silence_s: float,
    tier: int,
    ema_interval_s: float | None = None,
    sigma2_tier: float | None = None,
) -> float:
    """计算 Goldilocks 效用 U(t, c) ∈ [0, 1]。

    与 ADR-154 §2.3 对齐：
    - t < t_min: U = 0（冷却期）
    - t_min ≤ t ≤ t_max: bell(log-normal)
    - t > t_max: 缓慢衰减（P3 接管）
    """
    if silence_s <= 0:
        return 0.0

    params = goldilocks_params(tier)
    t_min = params["t_min"]
    t_max = params["t_max"]
    t_peak = params["t_peak"]
    sigma_ln = params["sigma_ln"]

    # 自适应 1: EMA — 高频联系人窗口提前打开（与 TS goldilocks.ts 对齐）
    if ema_interval_s is not None and ema_interval_s > 0:
        ratio = ema_interval_s / t_max
        if ratio < 0.5:
            shrink = 0.5 + ratio  # ratio=0.1 → shrink=0.6, ratio=0.5 → shrink=1.0
            t_min *= shrink
            t_peak = np.sqrt(t_min * t_max)
            sigma_ln = (np.log(t_max) - np.log(t_min)) / 4

    # 自适应 2: σ² 信念不确定性 — 不确定时窗口加宽
    if sigma2_tier is not None and sigma2_tier > 0.3:
        sigma_ln *= 1 + min(sigma2_tier, 1.0)

    if silence_s < t_min:
        return 0.0

    if silence_s <= t_max:
        # Log-normal bell
        ln_t = np.log(silence_s)
        ln_peak = np.log(t_peak)
        z = (ln_t - ln_peak) / sigma_ln
        return float(np.exp(-0.5 * z * z))
    else:
        # 窗口后: 渐进衰减（与 TS goldilocks.ts 对齐——指数衰减，不骤降）
        # 在 tMax 处的效用作为起点，然后指数衰减
        z_at_max = (np.log(t_max) - np.log(t_peak)) / sigma_ln
        u_at_max = float(np.exp(-0.5 * z_at_max * z_at_max))
        overshoot = (silence_s - t_max) / t_max
        return u_at_max * float(np.exp(-overshoot))


# ── 旧 σ_cool（全局 τ_cool = 3600s）─────────────────────────────


def sigma_cool_old(elapsed_s: float) -> float:
    """旧的全局固定 σ_cool。"""
    return float(np.exp(-elapsed_s / 3600))


def sigma_cool_new(elapsed_s: float, tier: int) -> float:
    """新的 per-tier σ_cool。"""
    tau = GOLDILOCKS_ALPHA * DUNBAR_TIER_THETA[tier]
    return float(np.exp(-elapsed_s / tau))


# ── 验证 1: 窗口参数推导 ────────────────────────────────────────────


def test_parameter_derivation():
    """验证各 tier 参数与 ADR-154 §4.1 一致。"""
    print("=" * 60)
    print("验证 1: 窗口参数推导")
    print("=" * 60)

    # ADR-154 §2.2: t_min = ln(10) × α × θ_c, t_max = θ_c, t_peak = √(t_min × t_max)
    expected: dict[int, dict[str, float]] = {}
    for tier, theta_c in DUNBAR_TIER_THETA.items():
        t_min = np.log(10) * GOLDILOCKS_ALPHA * theta_c
        t_max = theta_c
        t_peak = np.sqrt(t_min * t_max)
        expected[tier] = {"t_min": t_min, "t_max": t_max, "t_peak": t_peak}

    all_pass = True
    for tier in [5, 15, 50, 150, 500]:
        params = goldilocks_params(tier)
        exp = expected[tier]

        # 允许小误差（取整）
        ok_tmin = abs(params["t_min"] - exp["t_min"]) < 10
        ok_tmax = params["t_max"] == exp["t_max"]
        ok_tpeak = abs(params["t_peak"] - exp["t_peak"]) < 10

        status = "✓" if (ok_tmin and ok_tmax and ok_tpeak) else "✗"
        if status == "✗":
            all_pass = False

        def fmt_time(s: float) -> str:
            if s < 3600:
                return f"{s / 60:.0f}min"
            elif s < 86400:
                return f"{s / 3600:.1f}h"
            else:
                return f"{s / 86400:.1f}d"

        print(
            f"  Tier {tier:>3d}: t_min={fmt_time(params['t_min']):>8s} "
            f"t_peak={fmt_time(params['t_peak']):>8s} "
            f"t_max={fmt_time(params['t_max']):>8s} "
            f"σ_ln={params['sigma_ln']:.3f}  {status}"
        )

    assert all_pass, "参数推导与 ADR-154 不一致"
    print("\n  ✓ 参数推导正确\n")


# ── 验证 2: 效用曲线行为 ────────────────────────────────────────────


def test_utility_curve():
    """验证效用曲线的关键性质。"""
    print("=" * 60)
    print("验证 2: 效用曲线行为")
    print("=" * 60)

    all_pass = True

    for tier in [5, 50, 150]:
        params = goldilocks_params(tier)

        # 属性 1: 窗口外 U = 0
        u_before = goldilocks_utility(params["t_min"] * 0.5, tier)
        assert u_before == 0.0, f"Tier {tier}: U(t<t_min) should be 0, got {u_before}"

        # 属性 2: 峰值处 U ≈ 1.0
        u_peak = goldilocks_utility(params["t_peak"], tier)
        assert abs(u_peak - 1.0) < 0.01, f"Tier {tier}: U(t_peak) should be ~1.0, got {u_peak}"

        # 属性 3: t_min 处 U < 0.2（边缘处效用低）
        u_tmin = goldilocks_utility(params["t_min"] * 1.01, tier)
        assert u_tmin < 0.2, f"Tier {tier}: U(t_min) should be <0.2, got {u_tmin}"

        # 属性 4: t_max 处 U < 0.2
        u_tmax = goldilocks_utility(params["t_max"] * 0.99, tier)
        assert u_tmax < 0.2, f"Tier {tier}: U(t_max) should be <0.2, got {u_tmax}"

        # 属性 5: 窗口后缓慢衰减
        u_after = goldilocks_utility(params["t_max"] * 1.5, tier)
        assert 0 < u_after < 0.5, f"Tier {tier}: U(1.5×t_max) should be in (0, 0.5), got {u_after}"

        print(
            f"  Tier {tier:>3d}: U(before)={u_before:.3f} "
            f"U(t_min)={u_tmin:.3f} "
            f"U(peak)={u_peak:.3f} "
            f"U(t_max)={u_tmax:.3f} "
            f"U(after)={u_after:.3f}  ✓"
        )

    print("\n  ✓ 效用曲线行为正确\n")


# ── 验证 3: 场景 A/B 修复 ──────────────────────────────────────────


def test_scenario_fix():
    """验证 ADR-154 §1.2 的两个问题场景被 Goldilocks 修复。"""
    print("=" * 60)
    print("验证 3: 场景 A/B 修复对比")
    print("=" * 60)

    # 场景 A: 亲密朋友沉默 1.5h (5400s)
    print("\n  场景 A: 亲密朋友 (tier 5) 沉默 1.5h")
    old_cool_a = sigma_cool_old(5400)
    new_cool_a = sigma_cool_new(5400, 5)
    gold_u_a = goldilocks_utility(5400, 5)
    print(f"    旧 σ_cool (τ=1h):     {old_cool_a:.3f}  ← 已衰减，允许 proactive")
    print(f"    新 σ_cool (τ=18min):   {new_cool_a:.3f}  ← 几乎衰减完毕")
    print(f"    Goldilocks U(5400s):   {gold_u_a:.3f}  ← 窗口内，效用高")
    assert gold_u_a > 0.5, f"场景 A: Goldilocks 应该在窗口内（U > 0.5），got {gold_u_a}"
    print("    ✓ 修复：亲密朋友 1.5h 后在最佳联络窗口内")

    # 场景 B: 熟人沉默 2h (7200s)
    print("\n  场景 B: 熟人 (tier 150) 沉默 2h")
    old_cool_b = sigma_cool_old(7200)
    new_cool_b = sigma_cool_new(7200, 150)
    gold_u_b = goldilocks_utility(7200, 150)
    print(f"    旧 σ_cool (τ=1h):     {old_cool_b:.3f}  ← 几乎衰减完毕，允许 proactive")
    print(f"    新 σ_cool (τ=7.2h):   {new_cool_b:.3f}  ← 仍在高惩罚区")
    print(f"    Goldilocks U(7200s):   {gold_u_b:.3f}  ← 窗口外，禁止 proactive")
    assert gold_u_b == 0.0, f"场景 B: Goldilocks 应该在窗口外（U = 0），got {gold_u_b}"
    print("    ✓ 修复：熟人 2h 后仍被 Goldilocks 禁止 proactive\n")


# ── 验证 4: 效用曲线可视化 ──────────────────────────────────────────


def test_utility_visualization():
    """生成各 tier 效用曲线对比图。"""
    print("=" * 60)
    print("验证 4: 效用曲线可视化")
    print("=" * 60)

    fig, axes = plt.subplots(2, 3, figsize=(18, 10))
    colors = {5: "red", 15: "orange", 50: "green", 150: "blue", 500: "purple"}

    # 图 1: 各 tier 线性时间轴
    ax = axes[0, 0]
    for tier in [5, 15, 50, 150, 500]:
        params = goldilocks_params(tier)
        t_range = np.linspace(0, params["t_max"] * 2, 1000)
        utilities = [goldilocks_utility(t, tier) for t in t_range]
        ax.plot(t_range / 3600, utilities, color=colors[tier], label=f"Tier {tier}")
    ax.set_xlabel("Silence (hours)")
    ax.set_ylabel("U(t)")
    ax.set_title("Goldilocks Utility by Tier (linear)")
    ax.legend(fontsize=8)
    ax.set_xlim(0, 24)

    # 图 2: 各 tier 归一化时间轴（t/θ_c）——验证形状自相似
    ax = axes[0, 1]
    for tier in [5, 15, 50, 150, 500]:
        params = goldilocks_params(tier)
        theta_c = DUNBAR_TIER_THETA[tier]
        t_range = np.linspace(0, theta_c * 2, 1000)
        utilities = [goldilocks_utility(t, tier) for t in t_range]
        ax.plot(t_range / theta_c, utilities, color=colors[tier], label=f"Tier {tier}")
    ax.set_xlabel("t / θ_c (normalized)")
    ax.set_ylabel("U(t)")
    ax.set_title("Normalized Utility — Shape Self-similarity")
    ax.legend(fontsize=8)
    ax.axvline(0.345, color="gray", linestyle=":", alpha=0.5, label="t_min/θ_c ≈ 0.345")

    # 图 3: Tier 5 详细（标注关键点）
    ax = axes[0, 2]
    params = goldilocks_params(5)
    t_range = np.linspace(0, 14400, 500)
    utilities = [goldilocks_utility(t, 5) for t in t_range]
    ax.plot(t_range / 60, utilities, color="red", linewidth=2)
    ax.axvline(params["t_min"] / 60, color="gray", linestyle="--", alpha=0.5)
    ax.axvline(params["t_peak"] / 60, color="green", linestyle="--", alpha=0.5)
    ax.axvline(params["t_max"] / 60, color="blue", linestyle="--", alpha=0.5)
    ax.annotate("t_min", (params["t_min"] / 60, 0.05), fontsize=9)
    ax.annotate("t_peak", (params["t_peak"] / 60, 1.02), fontsize=9)
    ax.annotate("t_max", (params["t_max"] / 60, 0.05), fontsize=9)
    ax.set_xlabel("Silence (min)")
    ax.set_ylabel("U(t)")
    ax.set_title("Tier 5 (intimate) Detail")

    # 图 4: 旧 σ_cool vs 新 σ_cool vs Goldilocks（tier 5）
    ax = axes[1, 0]
    t_range = np.linspace(0, 14400, 500)
    old_cools = [sigma_cool_old(t) for t in t_range]
    new_cools = [sigma_cool_new(t, 5) for t in t_range]
    gold_utils = [goldilocks_utility(t, 5) for t in t_range]
    ax.plot(t_range / 60, old_cools, color="gray", linestyle="--", label="σ_cool old (τ=1h)")
    ax.plot(t_range / 60, new_cools, color="orange", linestyle="--", label="σ_cool new (τ=18min)")
    ax.plot(t_range / 60, gold_utils, color="red", linewidth=2, label="Goldilocks U(t)")
    ax.set_xlabel("Silence (min)")
    ax.set_ylabel("Value")
    ax.set_title("Tier 5: Old σ_cool vs New vs Goldilocks")
    ax.legend(fontsize=8)

    # 图 5: 旧 σ_cool vs 新 σ_cool vs Goldilocks（tier 150）
    ax = axes[1, 1]
    t_range = np.linspace(0, 345600, 500)  # 4 days
    old_cools = [sigma_cool_old(t) for t in t_range]
    new_cools = [sigma_cool_new(t, 150) for t in t_range]
    gold_utils = [goldilocks_utility(t, 150) for t in t_range]
    ax.plot(t_range / 3600, old_cools, color="gray", linestyle="--", label="σ_cool old (τ=1h)")
    ax.plot(t_range / 3600, new_cools, color="orange", linestyle="--", label="σ_cool new (τ=7.2h)")
    ax.plot(t_range / 3600, gold_utils, color="blue", linewidth=2, label="Goldilocks U(t)")
    ax.set_xlabel("Silence (hours)")
    ax.set_ylabel("Value")
    ax.set_title("Tier 150: Old σ_cool vs New vs Goldilocks")
    ax.legend(fontsize=8)

    # 图 6: 自适应窗口（EMA 影响）
    ax = axes[1, 2]
    params = goldilocks_params(50)
    t_range = np.linspace(0, 86400, 500)
    u_default = [goldilocks_utility(t, 50) for t in t_range]
    u_high_freq = [goldilocks_utility(t, 50, ema_interval_s=7200) for t in t_range]  # 高频
    u_uncertain = [goldilocks_utility(t, 50, sigma2_tier=0.8) for t in t_range]  # 高不确定性
    ax.plot(t_range / 3600, u_default, color="green", linewidth=2, label="Default")
    ax.plot(t_range / 3600, u_high_freq, color="red", linestyle="--", label="EMA=2h (high freq)")
    ax.plot(t_range / 3600, u_uncertain, color="purple", linestyle=":", label="σ²=0.8 (uncertain)")
    ax.set_xlabel("Silence (hours)")
    ax.set_ylabel("U(t)")
    ax.set_title("Tier 50: Adaptive Window Effects")
    ax.legend(fontsize=8)

    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "goldilocks_utility_curves.png", dpi=150)
    plt.close()
    print(f"  图表已保存: {OUTPUT_DIR / 'goldilocks_utility_curves.png'}")

    # 验证形状自相似性：所有 tier 的 σ_ln 应相同
    sigma_lns = [goldilocks_params(t)["sigma_ln"] for t in [5, 15, 50, 150, 500]]
    assert all(abs(s - sigma_lns[0]) < 1e-10 for s in sigma_lns), "σ_ln 应在所有 tier 下相同"
    print(f"  σ_ln = {sigma_lns[0]:.4f}（所有 tier 一致）")
    print("  ✓ Weber-Fechner 对数自相似性成立\n")


# ── 主入口 ──────────────────────────────────────────────────────────


def main():
    print("\n" + "━" * 60)
    print("  ADR-154 Goldilocks Window 验证模拟")
    print("━" * 60 + "\n")

    test_parameter_derivation()
    test_utility_curve()
    test_scenario_fix()
    test_utility_visualization()

    print("━" * 60)
    print("  全部验证通过 ✓")
    print("━" * 60)


if __name__ == "__main__":
    main()

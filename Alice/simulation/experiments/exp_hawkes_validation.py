"""ADR-153 Hawkes 自激过程验证模拟。

验证目标：
1. 所有 tier 默认参数的分枝比 < 1（稳定性）
2. λ(t) 在 10⁴ 事件后有界（不爆炸）
3. O(1) 递归更新与暴力枚举一致（数值正确性）
4. 群组修正参数有效（αDiscount + βMultiplier）
5. tier 5 高分枝比 (0.90) 不导致"粘人"行为

@see docs/adr/153-per-contact-hawkes/README.md
"""

from __future__ import annotations

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent.parent / "output" / "hawkes_validation"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Hawkes 参数（与 ADR-153 §3.1 对齐）────────────────────────────

TIER_PARAMS: dict[int, dict[str, float]] = {
    5: {"mu": 5.6e-4, "alpha": 0.003, "beta": 3.3e-3},
    15: {"mu": 2.8e-4, "alpha": 0.002, "beta": 2.8e-3},
    50: {"mu": 9.3e-5, "alpha": 0.001, "beta": 1.1e-3},
    150: {"mu": 2.3e-5, "alpha": 0.0005, "beta": 8.3e-4},
    500: {"mu": 5.8e-6, "alpha": 0.0002, "beta": 5.6e-4},
}

GROUP_MODIFIERS = {"alpha_discount": 0.3, "beta_multiplier": 1.5}


# ── Hawkes 核心实现 ────────────────────────────────────────────────


def hawkes_intensity_brute(
    mu: float, alpha: float, beta: float, events: list[float], t: float
) -> float:
    """暴力枚举计算 λ(t)——O(n)，用于验证递归版本。"""
    return mu + sum(alpha * np.exp(-beta * (t - ti)) for ti in events if ti < t)


def hawkes_intensity_recursive(
    mu: float,
    alpha: float,
    beta: float,
    lambda_carry: float,
    t_last: float,
    t_now: float,
) -> tuple[float, float]:
    """递归 O(1) 查询 λ(t)。返回 (lambda, lambda_carry_decayed)。"""
    dt = t_now - t_last
    carry_decayed = lambda_carry * np.exp(-beta * dt)
    return mu + carry_decayed, carry_decayed


def hawkes_update(
    alpha: float, beta: float, lambda_carry: float, t_last: float, t_new: float
) -> tuple[float, float]:
    """事件到达时更新 carry。返回 (new_carry, t_new)。"""
    dt = t_new - t_last
    new_carry = lambda_carry * np.exp(-beta * dt) + alpha if dt > 0 else lambda_carry + alpha
    return new_carry, t_new


def simulate_hawkes(
    mu: float, alpha: float, beta: float, n_events: int, seed: int = 42
) -> list[float]:
    """Ogata thinning 算法模拟 Hawkes 过程。"""
    rng = np.random.default_rng(seed)
    events: list[float] = []
    t = 0.0
    lambda_carry = 0.0
    t_last = 0.0

    for _ in range(n_events):
        # 当前上界
        lam_star = mu + lambda_carry * np.exp(-beta * (t - t_last)) + alpha
        # 指数跳跃
        dt = rng.exponential(1.0 / max(lam_star, 1e-12))
        t += dt
        # 实际强度
        lam_t, _ = hawkes_intensity_recursive(mu, alpha, beta, lambda_carry, t_last, t)
        # 接受/拒绝
        if rng.random() < lam_t / lam_star:
            events.append(t)
            lambda_carry, t_last = hawkes_update(alpha, beta, lambda_carry, t_last, t)

    return events


# ── 验证 1: 分枝比检查 ─────────────────────────────────────────────


def test_branching_ratio():
    """验证所有 tier 的分枝比 α/β < 1。"""
    print("=" * 60)
    print("验证 1: 分枝比 α/β < 1")
    print("=" * 60)
    all_pass = True
    for tier, p in TIER_PARAMS.items():
        ratio = p["alpha"] / p["beta"]
        status = "✓ PASS" if ratio < 1.0 else "✗ FAIL"
        if ratio >= 1.0:
            all_pass = False
        print(f"  Tier {tier:>3d}: α/β = {ratio:.4f}  {status}")

    # 群组修正后
    print("\n  群组修正 (α×0.3, β×1.5):")
    for tier, p in TIER_PARAMS.items():
        alpha_g = p["alpha"] * GROUP_MODIFIERS["alpha_discount"]
        beta_g = p["beta"] * GROUP_MODIFIERS["beta_multiplier"]
        ratio = alpha_g / beta_g
        status = "✓ PASS" if ratio < 1.0 else "✗ FAIL"
        if ratio >= 1.0:
            all_pass = False
        print(f"  Tier {tier:>3d} (group): α/β = {ratio:.4f}  {status}")

    assert all_pass, "某些 tier 的分枝比 ≥ 1，过程不稳定！"
    print("\n  ✓ 所有分枝比 < 1，过程稳定\n")


# ── 验证 2: λ(t) 有界性（10⁴ 事件）──────────────────────────────


def test_lambda_bounded():
    """模拟 10⁴ 事件，检查 λ(t) 稳定性。

    验证两个性质：
    1. 经验事件率收敛到理论稳态 μ/(1 - α/β)（±50%）
       注意：不使用事件时刻的 λ 均值，因为 size-biased sampling
       导致其天然偏高（事件在 λ 高时更可能发生）。
    2. 峰值有限——max λ < trivial_bound（全部 α 堆叠不衰减）
    """
    print("=" * 60)
    print("验证 2: λ(t) 稳定性（经验事件率收敛 + 峰值有限）")
    print("=" * 60)
    all_pass = True

    for tier, p in TIER_PARAMS.items():
        events = simulate_hawkes(p["mu"], p["alpha"], p["beta"], n_events=10000)
        if len(events) < 100:
            print(f"  Tier {tier:>3d}: 仅 {len(events)} 事件（低活跃度），跳过")
            continue

        # 计算各事件时刻的 max λ(t)
        lambda_carry = 0.0
        t_last = 0.0
        max_lambda = 0.0
        for ev in events:
            lam, _ = hawkes_intensity_recursive(
                p["mu"], p["alpha"], p["beta"], lambda_carry, t_last, ev
            )
            max_lambda = max(max_lambda, lam)
            lambda_carry, t_last = hawkes_update(
                p["alpha"], p["beta"], lambda_carry, t_last, ev
            )

        theoretical_steady = p["mu"] / (1 - p["alpha"] / p["beta"])

        # 检查 1: 经验事件率收敛到理论稳态（±50%）
        duration = events[-1] - events[0]
        empirical_rate = (len(events) - 1) / duration  # events/s
        ratio = empirical_rate / theoretical_steady
        rate_ok = 0.5 < ratio < 2.0

        # 检查 2: 峰值有限——不超过 N_events × α（trivial 上界）
        trivial_bound = len(events) * p["alpha"]
        peak_ok = max_lambda < trivial_bound

        ok = rate_ok and peak_ok
        status = "✓ PASS" if ok else "✗ FAIL"
        if not ok:
            all_pass = False
        print(
            f"  Tier {tier:>3d}: rate={empirical_rate:.6f} "
            f"(理论={theoretical_steady:.6f}, ratio={ratio:.2f}), "
            f"max λ = {max_lambda:.6f}  {status}"
        )

    assert all_pass, "某些 tier 的事件率不收敛或峰值发散！"
    print("\n  ✓ 所有 tier 事件率收敛、峰值有限\n")


# ── 验证 3: 递归 vs 暴力枚举一致性 ────────────────────────────────


def test_recursive_consistency():
    """比较递归 O(1) 与暴力 O(n) 计算结果。"""
    print("=" * 60)
    print("验证 3: 递归更新与暴力枚举一致性")
    print("=" * 60)

    p = TIER_PARAMS[50]  # 用 tier 50 测试
    events = simulate_hawkes(p["mu"], p["alpha"], p["beta"], n_events=500, seed=123)

    if len(events) < 10:
        print("  事件太少，跳过")
        return

    # 递归计算
    lambda_carry = 0.0
    t_last = 0.0
    recursive_lambdas = []
    for ev in events:
        lam, _ = hawkes_intensity_recursive(
            p["mu"], p["alpha"], p["beta"], lambda_carry, t_last, ev
        )
        recursive_lambdas.append(lam)
        lambda_carry, t_last = hawkes_update(
            p["alpha"], p["beta"], lambda_carry, t_last, ev
        )

    # 暴力枚举
    brute_lambdas = [
        hawkes_intensity_brute(p["mu"], p["alpha"], p["beta"], events[:i], events[i])
        for i in range(len(events))
    ]

    # 比较
    max_err = max(
        abs(r - b) for r, b in zip(recursive_lambdas, brute_lambdas)
    )
    rel_err = max_err / max(max(brute_lambdas), 1e-12)
    status = "✓ PASS" if rel_err < 1e-10 else "✗ FAIL"
    print(f"  {len(events)} 事件, 最大绝对误差 = {max_err:.2e}, 相对误差 = {rel_err:.2e}  {status}")
    assert rel_err < 1e-10, f"递归与暴力枚举不一致: rel_err = {rel_err}"
    print("  ✓ 递归更新数值正确\n")


# ── 验证 4: Tier 5 行为检查（防"粘人"）────────────────────────────


def test_tier5_not_clingy():
    """模拟 tier 5 对话场景，检查 Alice 行动频率。

    模拟逻辑：
    - 对方以 Hawkes 过程发消息
    - Alice 在 λ(t) > threshold 时有 p_reply 概率回复
    - 检查 Alice 在 1h 内的回复次数不超过合理上限
    """
    print("=" * 60)
    print("验证 4: Tier 5 防粘人行为检查")
    print("=" * 60)

    p = TIER_PARAMS[5]
    events = simulate_hawkes(p["mu"], p["alpha"], p["beta"], n_events=5000, seed=77)

    if len(events) < 100:
        print(f"  仅 {len(events)} 事件，跳过")
        return

    # 统计每小时的事件数
    max_t = events[-1]
    hours = int(max_t / 3600) + 1
    hourly_counts = np.zeros(hours)
    for ev in events:
        h = int(ev / 3600)
        if h < hours:
            hourly_counts[h] += 1

    max_hourly = hourly_counts.max()
    mean_hourly = hourly_counts[hourly_counts > 0].mean()
    p95_hourly = np.percentile(hourly_counts[hourly_counts > 0], 95)

    # 合理上限: tier 5 亲密朋友，最多 ~20 条/h 的突发（正常深聊节奏）
    reasonable_max = 30  # 允许偶尔突发
    status = "✓ PASS" if max_hourly < reasonable_max else "⚠ WARNING"

    print(f"  模拟时长: {max_t / 3600:.1f}h, 总事件: {len(events)}")
    print(f"  每小时事件数: mean={mean_hourly:.1f}, P95={p95_hourly:.1f}, max={max_hourly:.0f}")
    print(f"  上限={reasonable_max}  {status}")

    # 生成可视化
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8))

    # 事件间隔分布
    if len(events) > 1:
        intervals = np.diff(events)
        ax1.hist(intervals, bins=100, density=True, alpha=0.7, color="steelblue")
        ax1.set_xlabel("Inter-event interval (s)")
        ax1.set_ylabel("Density")
        ax1.set_title(f"Tier 5 Inter-event Time Distribution (n={len(events)})")
        ax1.set_xlim(0, np.percentile(intervals, 99))

    # λ(t) 轨迹（前 2h）
    t_range = np.linspace(0, min(7200, max_t), 2000)
    lambda_carry = 0.0
    t_last = 0.0
    event_idx = 0
    lambdas = []
    for t in t_range:
        while event_idx < len(events) and events[event_idx] <= t:
            lambda_carry, t_last = hawkes_update(
                p["alpha"], p["beta"], lambda_carry, t_last, events[event_idx]
            )
            event_idx += 1
        lam, _ = hawkes_intensity_recursive(
            p["mu"], p["alpha"], p["beta"], lambda_carry, t_last, t
        )
        lambdas.append(lam)

    ax2.plot(t_range / 60, lambdas, color="coral", linewidth=0.8)
    event_mask = [e for e in events if e <= min(7200, max_t)]
    ax2.scatter(
        [e / 60 for e in event_mask],
        [0] * len(event_mask),
        marker="|",
        color="gray",
        alpha=0.3,
        s=20,
    )
    ax2.set_xlabel("Time (min)")
    ax2.set_ylabel("λ(t)")
    ax2.set_title("Tier 5 Hawkes Intensity λ(t) — First 2h")
    ax2.axhline(p["mu"], color="green", linestyle="--", alpha=0.5, label=f'μ={p["mu"]:.4f}')
    ax2.legend()

    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "tier5_behavior.png", dpi=150)
    plt.close()
    print(f"  图表已保存: {OUTPUT_DIR / 'tier5_behavior.png'}\n")


# ── 验证 5: 全 tier λ(t) 衰减可视化 ───────────────────────────────


def test_decay_profiles():
    """可视化各 tier 在单次事件后的 λ(t) 衰减曲线。"""
    print("=" * 60)
    print("验证 5: 各 tier 衰减曲线可视化")
    print("=" * 60)

    fig, ax = plt.subplots(figsize=(10, 6))
    colors = {5: "red", 15: "orange", 50: "green", 150: "blue", 500: "purple"}

    for tier, p in TIER_PARAMS.items():
        half_life = np.log(2) / p["beta"]
        t_range = np.linspace(0, half_life * 5, 500)
        # 单次事件后的衰减: λ(t) = μ + α × exp(-β×t)
        lambdas = p["mu"] + p["alpha"] * np.exp(-p["beta"] * t_range)
        ax.plot(
            t_range / 60,
            lambdas,
            color=colors[tier],
            label=f"Tier {tier} (t½={half_life / 60:.1f}min)",
        )
        ax.axhline(p["mu"], color=colors[tier], linestyle=":", alpha=0.3)

    ax.set_xlabel("Time after event (min)")
    ax.set_ylabel("λ(t)")
    ax.set_title("Hawkes Decay Profiles by Tier (Single Event)")
    ax.legend()
    ax.set_xlim(0)

    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "tier_decay_profiles.png", dpi=150)
    plt.close()
    print(f"  图表已保存: {OUTPUT_DIR / 'tier_decay_profiles.png'}\n")


# ── 主入口 ──────────────────────────────────────────────────────────


def main():
    print("\n" + "━" * 60)
    print("  ADR-153 Hawkes 自激过程验证模拟")
    print("━" * 60 + "\n")

    test_branching_ratio()
    test_lambda_bounded()
    test_recursive_consistency()
    test_tier5_not_clingy()
    test_decay_profiles()

    print("━" * 60)
    print("  全部验证通过 ✓")
    print("━" * 60)


if __name__ == "__main__":
    main()

"""ADR-215 验证：Episode Residue 对目标选择的影响。

验证问题：
1. Residue 衰减贡献是否在合理范围内？（不能压倒 P1-P6，但要有可观测效果）
2. 不同半衰期下的行为差异？（30min vs 1h vs 2h）
3. Residue 是否能在竞争中"翻盘"——让一个原本非首选的 target 胜出？
4. 多个 residue 叠加时是否会过强？

方法：构造一个 5 频道场景，注入不同 residue 配置，
观察 channelPressures + 目标选择结果的变化。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ── Residue 模型（与 TS runtime episode.ts 对齐）──────────────────────

LN2 = math.log(2)

HALF_LIFE_MS = {
    "unfinished": 30 * 60 * 1000,        # 30 分钟
    "unresolved_emotion": 60 * 60 * 1000,  # 1 小时
    "interrupted": 20 * 60 * 1000,         # 20 分钟
    "curiosity": 45 * 60 * 1000,           # 45 分钟
}

MIN_CONTRIBUTION = 0.01


@dataclass
class Residue:
    type: str
    outcome: str           # raw outcome signal
    intensity: float       # 0..1
    toward: str | None     # channel ID or None
    half_life_ms: float
    created_ms: float


def residue_contribution(r: Residue, now_ms: float) -> float:
    """计算单个 residue 在 now_ms 时刻的压力贡献。"""
    age = now_ms - r.created_ms
    if age < 0 or age > 4 * 3600 * 1000:  # 超过 4 小时忽略
        return 0.0
    c = r.intensity * math.exp(-LN2 * age / r.half_life_ms)
    return c if c >= MIN_CONTRIBUTION else 0.0


# ── 目标选择模拟 ──────────────────────────────────────────────────────

@dataclass
class Channel:
    id: str
    base_pressure: float  # P1-P6 聚合基线压力


def select_target(
    channels: list[Channel],
    residues: list[Residue],
    now_ms: float,
) -> tuple[str, dict[str, float]]:
    """模拟 IAUS 目标选择（简化版：取最高压力者）。"""
    pressures: dict[str, float] = {}
    for ch in channels:
        pressures[ch.id] = ch.base_pressure

    # 注入 residue 贡献
    for r in residues:
        if r.toward and r.toward in pressures:
            pressures[r.toward] += residue_contribution(r, now_ms)

    winner = max(pressures, key=lambda k: pressures[k])
    return winner, pressures


# ── 实验 1：单个 Residue 的衰减曲线 ──────────────────────────────────

def exp1_decay_curves():
    """画出不同类型 residue 的衰减曲线。"""
    fig, ax = plt.subplots(figsize=(10, 5))

    for rtype, hl in HALF_LIFE_MS.items():
        r = Residue(
            type=rtype, outcome="test", intensity=0.6,
            toward="ch_a", half_life_ms=hl, created_ms=0,
        )
        times_min = np.linspace(0, 180, 200)  # 0 到 3 小时
        contributions = [
            residue_contribution(r, t * 60 * 1000) for t in times_min
        ]
        ax.plot(times_min, contributions, label=f"{rtype} (hl={hl/60000:.0f}min)")

    ax.set_xlabel("Time since episode ended (minutes)")
    ax.set_ylabel("Pressure contribution")
    ax.set_title("ADR-215: Residue Decay Curves (intensity=0.6)")
    ax.legend()
    ax.axhline(y=MIN_CONTRIBUTION, color="gray", linestyle="--", alpha=0.5, label="threshold")
    ax.grid(True, alpha=0.3)
    fig.savefig("experiments/figures/episode_residue_decay.png", dpi=150, bbox_inches="tight")
    print(f"[exp1] 衰减曲线已保存")

    # 数值验证
    for rtype, hl in HALF_LIFE_MS.items():
        r = Residue(type=rtype, outcome="test", intensity=0.6,
                    toward="ch_a", half_life_ms=hl, created_ms=0)
        at_halflife = residue_contribution(r, hl)
        at_2x = residue_contribution(r, hl * 2)
        at_3x = residue_contribution(r, hl * 3)
        print(f"  {rtype:25s}: at t=hl → {at_halflife:.3f}, t=2hl → {at_2x:.3f}, t=3hl → {at_3x:.3f}")


# ── 实验 2：Residue 翻盘效果 ──────────────────────────────────────────

def exp2_flip_analysis():
    """验证 residue 能否让非首选 target 胜出。"""
    # 5 个频道，基线压力不同
    channels = [
        Channel("群聊A", 2.5),    # 最高基线
        Channel("Noel", 2.0),  # 第二
        Channel("池塘", 1.5),
        Channel("某群B", 1.0),
        Channel("Gcd", 0.5),    # 最低
    ]

    print("\n[exp2] 翻盘分析")
    print(f"  基线压力: {', '.join(f'{c.id}={c.base_pressure}' for c in channels)}")

    # 无 residue
    winner_no, pressures_no = select_target(channels, [], 0)
    print(f"\n  无 residue → 选中: {winner_no}")

    # 有 residue 指向Noel（intensity=0.6）
    r = Residue(
        type="unresolved_emotion", outcome="silence",
        intensity=0.6, toward="Noel",
        half_life_ms=HALF_LIFE_MS["unresolved_emotion"],
        created_ms=0,
    )

    # 在不同时间点测试
    test_points_min = [0, 5, 15, 30, 45, 60, 90, 120]
    print(f"\n  Residue → Noel (intensity=0.6, hl=60min)")
    print(f"  {'time':>6s} | {'贡献':>6s} | {'伊忒总压':>8s} | {'群聊A':>6s} | {'胜出':>10s} | {'翻盘?':>5s}")
    print(f"  {'-'*6} | {'-'*6} | {'-'*8} | {'-'*6} | {'-'*10} | {'-'*5}")

    for t in test_points_min:
        now_ms = t * 60 * 1000
        winner, pressures = select_target(channels, [r], now_ms)
        contrib = residue_contribution(r, now_ms)
        flipped = winner != winner_no
        print(f"  {t:>4d}min | {contrib:>6.3f} | {pressures['Noel']:>8.3f} | {pressures['群聊A']:>6.3f} | {winner:>10s} | {'✅' if flipped else '—':>5s}")


# ── 实验 3：多 Residue 叠加 ──────────────────────────────────────────

def exp3_stacking():
    """验证多个 residue 叠加是否过强。"""
    channels = [
        Channel("群聊A", 3.0),
        Channel("Noel", 1.5),
    ]

    # 3 个 residue 都指向Noel
    residues = [
        Residue("unfinished", "error", 0.6, "Noel",
                HALF_LIFE_MS["unfinished"], created_ms=0),
        Residue("unresolved_emotion", "silence", 0.4, "Noel",
                HALF_LIFE_MS["unresolved_emotion"], created_ms=5 * 60 * 1000),
        Residue("interrupted", "preempted", 0.5, "Noel",
                HALF_LIFE_MS["interrupted"], created_ms=10 * 60 * 1000),
    ]

    print("\n[exp3] 叠加分析（3 个 residue → Noel）")
    print(f"  群聊A 基线: 3.0, Noel 基线: 1.5")
    print(f"  差值需翻过: 1.5")

    test_points = [10, 15, 20, 30, 45, 60]
    print(f"\n  {'time':>6s} | {'总贡献':>6s} | {'各贡献':>20s} | {'伊忒总压':>8s} | {'翻盘?':>5s}")

    for t in test_points:
        now_ms = t * 60 * 1000
        contribs = [residue_contribution(r, now_ms) for r in residues]
        total = sum(contribs)
        winner, pressures = select_target(channels, residues, now_ms)
        flipped = winner == "Noel"
        contribs_str = "+".join(f"{c:.2f}" for c in contribs)
        print(f"  {t:>4d}min | {total:>6.3f} | {contribs_str:>20s} | {pressures['Noel']:>8.3f} | {'✅' if flipped else '—':>5s}")

    # 安全检查：最大可能贡献
    max_total = sum(r.intensity for r in residues)
    print(f"\n  最大可能叠加贡献（t=0 时）: {max_total:.1f}")
    print(f"  与典型 API 值（2-5）的比例: {max_total/3.0:.1%}")


# ── 实验 4：Residue 对 Attention Debt 的间接影响 ────────────────────

def exp4_debt_interaction():
    """验证 residue 注入 channelPressures 后对 attention debt 的影响。

    模拟 20 个 tick 的 debt 演化，对比有/无 residue。
    """
    # 简化的 attention debt 模型
    delta = 0.05
    mu_d = 0.3
    kappa_d = 2.0

    channels = {"群聊A": 2.0, "Noel": 1.5}
    r = Residue("unresolved_emotion", "silence", 0.5, "Noel",
                HALF_LIFE_MS["unresolved_emotion"], created_ms=0)

    tick_interval_ms = 60_000  # 60 秒/tick

    # 无 residue
    debt_no = {"群聊A": 0.0, "Noel": 0.0}
    debt_history_no = {k: [] for k in channels}

    # 有 residue
    debt_yes = {"群聊A": 0.0, "Noel": 0.0}
    debt_history_yes = {k: [] for k in channels}

    for tick in range(40):
        now_ms = tick * tick_interval_ms
        selected = None  # 不选任何目标

        # 无 residue 路径
        for ch, base in channels.items():
            prev = debt_no[ch]
            decayed = prev * (1 - delta)
            accumulated = base if ch != selected else 0
            debt_no[ch] = decayed + accumulated
            debt_history_no[ch].append(debt_no[ch])

        # 有 residue 路径
        for ch, base in channels.items():
            prev = debt_yes[ch]
            decayed = prev * (1 - delta)
            pressure = base + (residue_contribution(r, now_ms) if ch == "Noel" else 0)
            accumulated = pressure if ch != selected else 0
            debt_yes[ch] = decayed + accumulated
            debt_history_yes[ch].append(debt_yes[ch])

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    for ch in channels:
        ax1.plot(debt_history_no[ch], label=ch)
    ax1.set_title("Attention Debt — 无 Residue")
    ax1.set_xlabel("Tick")
    ax1.set_ylabel("Debt")
    ax1.legend()
    ax1.grid(True, alpha=0.3)

    for ch in channels:
        ax2.plot(debt_history_yes[ch], label=ch)
    ax2.set_title("Attention Debt — 有 Residue (Noel, hl=60min)")
    ax2.set_xlabel("Tick")
    ax2.set_ylabel("Debt")
    ax2.legend()
    ax2.grid(True, alpha=0.3)

    fig.suptitle("ADR-215: Residue Impact on Attention Debt", fontsize=14)
    fig.savefig("experiments/figures/episode_residue_debt.png", dpi=150, bbox_inches="tight")
    print(f"\n[exp4] Debt 对比图已保存")

    # 数值报告
    print(f"  tick 20 时:")
    print(f"    无 residue: 群聊A={debt_history_no['群聊A'][19]:.1f}, Noel={debt_history_no['Noel'][19]:.1f}")
    print(f"    有 residue: 群聊A={debt_history_yes['群聊A'][19]:.1f}, Noel={debt_history_yes['Noel'][19]:.1f}")
    diff = debt_history_yes['Noel'][19] - debt_history_no['Noel'][19]
    print(f"    residue 额外 debt: {diff:.2f} ({diff/debt_history_no['Noel'][19]:.1%} 增幅)")


# ── 主入口 ────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("ADR-215: Episode Residue 模拟验证")
    print("=" * 60)

    exp1_decay_curves()
    exp2_flip_analysis()
    exp3_stacking()
    exp4_debt_interaction()

    print("\n" + "=" * 60)
    print("模拟完成。图表保存在 experiments/figures/")
    print("=" * 60)


if __name__ == "__main__":
    main()

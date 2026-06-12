"""模拟结果可视化。

生成 4 面板合图和辅助图表，用于论文 §7。
"""
from __future__ import annotations

from typing import Any

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap

from voices import VOICE_NAMES, VOICE_SHORT
from sim_engine import TickRecord


# ---------------------------------------------------------------------------
# 颜色方案
# ---------------------------------------------------------------------------

VOICE_COLORS = {
    "D": "#1565c0",  # 蓝
    "C": "#f57c00",  # 橙
    "S": "#2e7d32",  # 绿
    "X": "#7b1fa2",  # 紫
    "R": "#c62828",  # 红
}

PRESSURE_COLORS = {
    "P1": "#1565c0",
    "P2": "#c62828",
    "P3": "#2e7d32",
    "P4": "#f57c00",
    "P5": "#7b1fa2",
    "P6": "#00838f",
}


# ---------------------------------------------------------------------------
# 主面板图
# ---------------------------------------------------------------------------

def plot_main_panel(
    records: list[TickRecord],
    output_path: str,
    title: str = "Exp 5: Telegram Replay Simulation",
) -> None:
    """生成 4 面板合图。

    (a) 事件热度 + API 时间线
    (b) 声部竞争瀑布图
    (c) 压力分量堆叠面积图
    (d) 人格向量漂移

    Parameters
    ----------
    records : list[TickRecord]
        模拟结果。
    output_path : str
        PDF 输出路径。
    title : str
        图表标题。
    """
    if not records:
        print("  无记录，跳过绘图")
        return

    ticks = np.array([r.tick for r in records])
    n = len(ticks)

    # 提取时间序列
    n_events = np.array([r.n_events for r in records])
    api_vals = np.array([r.napi for r in records])  # 归一化 API
    a_vals = np.array([r.pressures["A"] for r in records])

    # 压力分量
    p_keys = ["P1", "P2", "P3", "P4", "P5", "P6"]
    p_matrix = np.array([[r.pressures[k] for k in p_keys] for r in records])

    # 人格向量
    pi_matrix = np.array([r.personality for r in records])

    # 行动事件
    action_ticks = [r.tick for r in records if r.action is not None]
    action_types = [r.action for r in records if r.action is not None]
    action_winners = [r.winner_idx for r in records if r.winner_idx is not None]

    fig, axes = plt.subplots(4, 1, figsize=(14, 12), height_ratios=[2, 1.5, 1.5, 1])

    # -- (a) 事件热度 + API 时间线 ------------------------------------------
    ax = axes[0]
    ax2 = ax.twinx()

    # 事件热度（灰色柱状图，按 5-tick 窗口聚合）
    window = max(1, n // 200)  # 自动聚合窗口
    if window > 1:
        n_bins = n // window
        event_binned = np.array([n_events[i * window:(i + 1) * window].sum() for i in range(n_bins)])
        tick_binned = np.array([ticks[i * window] for i in range(n_bins)])
    else:
        event_binned = n_events
        tick_binned = ticks

    ax2.bar(tick_binned, event_binned, width=max(window, 1), color="#bdbdbd",
            alpha=0.5, label="Events/window", zorder=1)
    ax2.set_ylabel("Events", color="#757575")
    ax2.tick_params(axis="y", labelcolor="#757575")

    # 归一化 API 轨迹
    ax.plot(ticks, api_vals, color="#1565c0", linewidth=1.0, label="nAPI$(n)$", zorder=3)

    # 行动标记
    if action_ticks:
        action_apis = [api_vals[t - 1] for t in action_ticks if t - 1 < len(api_vals)]
        # 按声部着色
        for at, aa, aw in zip(action_ticks, action_apis, action_winners):
            color = VOICE_COLORS.get(VOICE_SHORT[aw], "#000000")
            ax.scatter([at], [aa], color=color, s=12, zorder=5, marker="v", alpha=0.7)

    # 自动 y 轴范围（留 20% 余量）
    api_max_val = api_vals.max()
    ax.set_ylim(0, api_max_val * 1.3)

    ax.set_ylabel("Normalized API")
    ax.set_title("(a) Event intensity and pressure accumulation")
    ax.legend(loc="upper left", fontsize=7)
    ax.grid(True, alpha=0.2)

    # -- (b) 声部竞争瀑布图 ------------------------------------------------
    ax = axes[1]

    # 收集每个行动 tick 的 loudness
    action_records = [r for r in records if r.loudness is not None]
    if action_records:
        act_ticks = [r.tick for r in action_records]
        loudness_matrix = np.array([r.loudness for r in action_records])  # (n_actions, 5)

        for i, short in enumerate(VOICE_SHORT):
            color = VOICE_COLORS[short]
            ax.scatter(act_ticks, loudness_matrix[:, i], color=color,
                       s=8, alpha=0.6, label=short, zorder=3)
            # 连线
            ax.plot(act_ticks, loudness_matrix[:, i], color=color,
                    linewidth=0.5, alpha=0.3, zorder=2)

    # v2: X 声部可以为正，不再排除；基于全部声部设置 y 范围
    if action_records:
        all_loudness = np.array([r.loudness for r in action_records])
        ymin = float(all_loudness.min()) - 0.05
        ymax = float(all_loudness.max()) + 0.05
        ax.set_ylim(ymin, ymax)

    ax.set_ylabel("Loudness $L_i(n)$")
    ax.set_title("(b) Voice competition at action points")
    ax.legend(loc="upper right", fontsize=7, ncol=5)
    ax.grid(True, alpha=0.2)
    ax.axhline(y=0, color="black", linewidth=0.5, alpha=0.3)

    # -- (c) 压力分量堆叠面积图 --------------------------------------------
    ax = axes[2]

    # 用 nAPI 的分量来展示归一化后的压力占比
    # 从 records 的 pressures 反推 kappa 不现实，直接用 napi 和各 P 的比例
    # 简化：直接用 softmax-like 的归一化展示相对贡献
    p_total = p_matrix.sum(axis=1, keepdims=True)
    p_total = np.maximum(p_total, 1e-6)  # 避免除零
    p_normed = p_matrix / p_total

    # 下采样以避免过于密集
    step = max(1, n // 500)
    t_sub = ticks[::step]
    p_sub = p_normed[::step]

    ax.stackplot(
        t_sub,
        *[p_sub[:, i] for i in range(6)],
        labels=p_keys,
        colors=[PRESSURE_COLORS[k] for k in p_keys],
        alpha=0.7,
    )
    ax.set_ylabel("Normalized pressure")
    ax.set_title("(c) Pressure composition (relative contribution)")
    ax.legend(loc="upper right", fontsize=7, ncol=6)
    ax.grid(True, alpha=0.2)

    # -- (d) 人格向量漂移 --------------------------------------------------
    ax = axes[3]

    for i, short in enumerate(VOICE_SHORT):
        color = VOICE_COLORS[short]
        ax.plot(ticks, pi_matrix[:, i], color=color, linewidth=1.2, label=short)

    ax.set_xlabel("Tick $n$")
    ax.set_ylabel("$\\pi_i(n)$")
    ax.set_title("(d) Personality drift")
    ax.legend(loc="upper right", fontsize=7, ncol=5)
    ax.grid(True, alpha=0.2)
    ax.set_ylim(0, 0.5)

    fig.suptitle(title, fontsize=13, fontweight="bold", y=1.01)
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  主面板图已保存: {output_path}")


# ---------------------------------------------------------------------------
# 辅助图：压力分量详细时间线
# ---------------------------------------------------------------------------

def plot_pressure_detail(
    records: list[TickRecord],
    output_path: str,
) -> None:
    """绘制 6 个压力的独立时间线。"""
    if not records:
        return

    ticks = np.array([r.tick for r in records])
    p_keys = ["P1", "P2", "P3", "P4", "P5", "P6"]
    p_names = [
        "P1: Attention Debt",
        "P2: Information Pressure",
        "P3: Relationship Cooling",
        "P4: Thread Divergence",
        "P5: Response Obligation",
        "P6: Curiosity",
    ]

    fig, axes = plt.subplots(3, 2, figsize=(14, 8))
    axes = axes.flatten()

    for i, (key, name) in enumerate(zip(p_keys, p_names)):
        ax = axes[i]
        vals = np.array([r.pressures[key] for r in records])
        color = PRESSURE_COLORS[key]
        ax.plot(ticks, vals, color=color, linewidth=0.8)
        ax.fill_between(ticks, 0, vals, color=color, alpha=0.15)
        ax.set_title(name, fontsize=9)
        ax.grid(True, alpha=0.2)
        if i >= 4:
            ax.set_xlabel("Tick $n$")

    fig.suptitle("Pressure Components Detail", fontsize=11, fontweight="bold")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  压力详细图已保存: {output_path}")


# ---------------------------------------------------------------------------
# 辅助图：行动间隔分布
# ---------------------------------------------------------------------------

def plot_action_intervals(
    records: list[TickRecord],
    output_path: str,
) -> None:
    """绘制行动间隔直方图。"""
    action_ticks = [r.tick for r in records if r.action is not None]
    if len(action_ticks) < 2:
        print("  行动不足 2 次，跳过间隔分布图")
        return

    intervals = np.diff(action_ticks)

    fig, ax = plt.subplots(figsize=(8, 4))
    ax.hist(intervals, bins=min(50, len(intervals) // 2 + 1),
            color="#1565c0", alpha=0.7, edgecolor="white")
    ax.axvline(np.mean(intervals), color="#d32f2f", linestyle="--",
               label=f"Mean = {np.mean(intervals):.1f}")
    ax.axvline(np.median(intervals), color="#f57c00", linestyle="--",
               label=f"Median = {np.median(intervals):.1f}")
    ax.set_xlabel("Action interval (ticks)")
    ax.set_ylabel("Count")
    ax.set_title("Action Interval Distribution")
    ax.legend()
    ax.grid(True, alpha=0.2)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  行动间隔图已保存: {output_path}")

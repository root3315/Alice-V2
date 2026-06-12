"""实验 2：人格向量对行动分布的影响。

使用 5 种偏向性人格和 1 种平衡人格，运行模拟统计各声部的
行动选择频率分布。验证人格向量确实按预期偏移行动分布。

理论依据（论文 §4.2）：
- 高 π_D → 勤勉优先，处理事务多
- 高 π_C → 好奇优先，探索多
- 高 π_S → 社交优先，闲聊多
- 高 π_X → 谨慎优先，等待多
- 高 π_R → 回顾优先，整理多
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import random_companion_graph
from pressure import (
    api_aggregate,
    P1_attention_debt,
    P2_information_pressure,
    P3_relationship_cooling,
    P4_thread_divergence,
    P5_response_obligation,
    P6_curiosity,
)
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    VOICE_NAMES,
    VOICE_SHORT,
    VOICE_ACTIONS,
)


# ---------------------------------------------------------------------------
# 预定义人格向量
# ---------------------------------------------------------------------------

PERSONALITIES: dict[str, np.ndarray] = {
    "high-D": np.array([0.6, 0.1, 0.1, 0.1, 0.1]),
    "high-C": np.array([0.1, 0.6, 0.1, 0.1, 0.1]),
    "high-S": np.array([0.1, 0.1, 0.6, 0.1, 0.1]),
    "high-X": np.array([0.1, 0.1, 0.1, 0.6, 0.1]),
    "high-R": np.array([0.1, 0.1, 0.1, 0.1, 0.6]),
    "balanced": np.array([0.2, 0.2, 0.2, 0.2, 0.2]),
}


# ---------------------------------------------------------------------------
# 实验逻辑
# ---------------------------------------------------------------------------

def run_exp2(
    n_trials: int = 100,
    n_steps: int = 100,
    seed_base: int = 2000,
) -> dict:
    """运行实验 2：人格对行动分布的影响。

    Parameters
    ----------
    n_trials : int
        独立试验次数。
    n_steps : int
        每次试验的 tick 步数。
    seed_base : int
        随机种子基数。

    Returns
    -------
    dict
        键为人格名，值为形状 (n_trials, 5) 的行动计数矩阵。
    """
    results: dict[str, np.ndarray] = {}

    for pname, pweights in PERSONALITIES.items():
        personality = PersonalityVector(weights=pweights.copy())
        # 每种人格的行动计数: (n_trials, 5)
        action_counts = np.zeros((n_trials, 5), dtype=int)

        for trial in range(n_trials):
            seed = seed_base + trial
            rng = np.random.default_rng(seed)

            G = random_companion_graph(
                n_contacts=15,
                n_threads=6,
                n_channels=3,
                n_info_items=10,
                seed=seed,
            )

            # 无外部事件场景：novelty=0 → P6=eta=0.6
            novelty_history: list[float] = []
            event_count_history: list[int] = []

            for step in range(1, n_steps + 1):
                G.tick = step
                event_count_history.append(0)  # 无外部事件
                # 在 loudness 计算前 append novelty
                novelty_history.append(0.0)

                loudness = compute_loudness(
                    G, step, personality,
                    novelty_history=novelty_history,
                    recent_event_counts=event_count_history,
                    rng=rng,
                )
                winner_idx, action_type = select_action(loudness, rng=rng)
                action_counts[trial, winner_idx] += 1

        results[pname] = action_counts

        # 打印该人格的行动分布摘要
        mean_counts = action_counts.mean(axis=0)
        total = mean_counts.sum()
        pcts = mean_counts / total * 100
        print(f"  {pname:>10s}: " +
              " | ".join(f"{VOICE_SHORT[i]}={pcts[i]:5.1f}%" for i in range(5)))

    return results


def plot_exp2(results: dict, output_path: str) -> None:
    """绘制实验 2 结果：分组柱状图。"""
    fig, ax = plt.subplots(1, 1, figsize=(10, 4))

    pnames = list(results.keys())
    n_personalities = len(pnames)
    n_voices = 5
    bar_width = 0.13
    x = np.arange(n_personalities)

    colors = ["#1565c0", "#e65100", "#2e7d32", "#6a1b9a", "#c62828"]

    for v_idx in range(n_voices):
        # 每种人格的该声部行动比例
        proportions = []
        errors = []
        for pname in pnames:
            counts = results[pname]  # (n_trials, 5)
            totals = counts.sum(axis=1)  # (n_trials,)
            ratios = counts[:, v_idx] / totals  # (n_trials,)
            proportions.append(ratios.mean())
            errors.append(ratios.std() / np.sqrt(len(ratios)))

        offset = (v_idx - n_voices / 2 + 0.5) * bar_width
        ax.bar(
            x + offset, proportions,
            bar_width,
            yerr=errors,
            label=VOICE_NAMES[v_idx],
            color=colors[v_idx],
            alpha=0.85,
            capsize=2,
        )

    ax.set_xlabel("Personality type")
    ax.set_ylabel("Action proportion")
    ax.set_title("Action distribution by personality vector")
    ax.set_xticks(x)
    ax.set_xticklabels(pnames, fontsize=8)
    ax.legend(fontsize=7, ncol=5, loc="upper right")
    ax.grid(True, alpha=0.3, axis="y")

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


if __name__ == "__main__":
    print("实验 2：人格向量对行动分布的影响")
    results = run_exp2(n_trials=100, n_steps=100)
    os.makedirs("../paper/figures", exist_ok=True)
    plot_exp2(results, "../paper/figures/exp2_personality.pdf")

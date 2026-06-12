"""实验 1：空闲增长定理验证。

创建合成社交图，在存在 open 线程的情况下不执行任何行动，
观察 API(n) 随时间的增长。拟合幂律，验证 β>1（超线性增长）。

理论依据（论文 §3.4 性质 1）：
- P4 的回溯项 age^β_t (β_t > 1) 保证超线性增长
- P3 的沉默时长单调增加
- P6 在低活动时上升
三者均为正贡献，因此 API 在空闲场景中严格递增。
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
from scipy.optimize import curve_fit
from scipy.stats import pearsonr
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import random_companion_graph
from pressure import compute_all_pressures


# ---------------------------------------------------------------------------
# 实验逻辑
# ---------------------------------------------------------------------------

def run_exp1(
    n_trials: int = 100,
    n_steps: int = 100,
    seed_base: int = 1000,
) -> dict:
    """运行实验 1：空闲增长验证。

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
        包含 API 轨迹矩阵、拟合参数、R² 等。
    """
    api_matrix = np.zeros((n_trials, n_steps))
    p4_matrix = np.zeros((n_trials, n_steps))

    for trial in range(n_trials):
        seed = seed_base + trial
        # 创建有多个 open 线程的合成图
        G = random_companion_graph(
            n_contacts=15,
            n_threads=8,
            n_channels=3,
            n_info_items=10,
            seed=seed,
        )

        # 空闲场景：无事件 → novelty=0 → P6=eta=0.6（好奇心最大值）
        # 初始化为空，每 tick 在压力计算前 append
        novelty_history: list[float] = []

        for step in range(1, n_steps + 1):
            G.tick = step
            # 无事件，novelty=0（好奇心持续上升）
            novelty_history.append(0.0)
            # 不执行任何行动，仅计算压力
            result = compute_all_pressures(
                G, step,
                novelty_history=novelty_history,
                thread_age_scale=1440.0,
            )
            api_val = result["API"]
            api_matrix[trial, step - 1] = api_val
            p4_matrix[trial, step - 1] = result["P4"]

    # 对均值轨迹拟合幂律 f(t) = a * t^b
    mean_api = api_matrix.mean(axis=0)
    mean_p4 = p4_matrix.mean(axis=0)
    x = np.arange(1, n_steps + 1, dtype=float)

    def power_law(t, a, b):
        return a * t ** b

    def power_law_offset(t, c, a, b):
        return c + a * t ** b

    # 拟合 P4 分量（纯幂律）
    try:
        popt_p4, _ = curve_fit(
            power_law, x, mean_p4,
            p0=[mean_p4[0], 1.5],
            maxfev=10000,
        )
        a_p4, b_p4 = popt_p4
        y_pred_p4 = power_law(x, *popt_p4)
        ss_res = np.sum((mean_p4 - y_pred_p4) ** 2)
        ss_tot = np.sum((mean_p4 - mean_p4.mean()) ** 2)
        r2_p4 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    except Exception:
        a_p4, b_p4, r2_p4 = 0.0, 0.0, 0.0

    # 拟合总 API（带偏移的幂律）
    try:
        popt_api, _ = curve_fit(
            power_law_offset, x, mean_api,
            p0=[mean_api[0] * 0.3, mean_api[0] * 0.5, 1.5],
            maxfev=10000,
        )
        c_api, a_api, b_api = popt_api
        y_pred_api = power_law_offset(x, *popt_api)
        ss_res = np.sum((mean_api - y_pred_api) ** 2)
        ss_tot = np.sum((mean_api - mean_api.mean()) ** 2)
        r2_api = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    except Exception:
        c_api, a_api, b_api, r2_api = 0.0, 0.0, 0.0, 0.0

    print(f"  P4 幂律拟合: P4(t) = {a_p4:.2f} * t^{b_p4:.2f}, R² = {r2_p4:.4f}")
    print(f"  总 API 拟合: API(t) = {c_api:.2f} + {a_api:.2f} * t^{b_api:.2f}, R² = {r2_api:.4f}")
    print(f"  β_P4 = {b_p4:.3f} (理论预测: β > 1)")
    print(f"  β_API = {b_api:.3f} (理论预测: β > 1)")

    # 验证单调递增
    diffs = np.diff(mean_api)
    monotone_ratio = np.sum(diffs > 0) / len(diffs)
    print(f"  单调递增比例: {monotone_ratio:.4f}")

    return {
        "api_matrix": api_matrix,
        "p4_matrix": p4_matrix,
        "mean_api": mean_api,
        "mean_p4": mean_p4,
        "fit_p4": (a_p4, b_p4),
        "r2_p4": r2_p4,
        "fit_api": (c_api, a_api, b_api),
        "r2_api": r2_api,
        "monotone_ratio": monotone_ratio,
    }


def plot_exp1(results: dict, output_path: str) -> None:
    """绘制实验 1 结果。"""
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.5))

    n_steps = len(results["mean_api"])
    x = np.arange(1, n_steps + 1)

    # (a) API 轨迹（均值 ± 标准差）
    ax = axes[0]
    api_matrix = results["api_matrix"]
    mean = api_matrix.mean(axis=0)
    std = api_matrix.std(axis=0)

    ax.plot(x, mean, color="#1565c0", linewidth=1.5, label="API (mean)")
    ax.fill_between(x, mean - std, mean + std, color="#1565c0", alpha=0.12)

    # 叠加 P4 分量
    p4_mean = results["mean_p4"]
    ax.plot(x, p4_mean, color="#e65100", linewidth=1.2, linestyle="--",
            label="$P_4$ thread divergence")

    ax.set_xlabel("Agent tick $n$")
    ax.set_ylabel("Pressure")
    ax.set_title("(a) Idle growth: API and $P_4$ vs time")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # (b) 幂律拟合（对数-对数坐标）
    ax = axes[1]
    ax.scatter(x, results["mean_p4"], color="#333333", s=8, zorder=3,
               label="$P_4$ observed")

    a_p4, b_p4 = results["fit_p4"]
    r2_p4 = results["r2_p4"]
    x_smooth = np.linspace(1, n_steps, 200)
    y_fit = a_p4 * x_smooth ** b_p4
    ax.plot(x_smooth, y_fit, color="#d32f2f", linewidth=1.5,
            label=f"Fit: ${a_p4:.1f} \\cdot t^{{{b_p4:.2f}}}$ ($R^2={r2_p4:.3f}$)")

    ax.set_xlabel("Agent tick $n$")
    ax.set_ylabel("$P_4$ (thread divergence)")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_title("(b) Power-law fit (log-log)")
    ax.legend(fontsize=7)
    ax.grid(True, alpha=0.3, which="both")

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


if __name__ == "__main__":
    print("实验 1：空闲增长定理验证")
    results = run_exp1(n_trials=100, n_steps=100)
    os.makedirs("../paper/figures", exist_ok=True)
    plot_exp1(results, "../paper/figures/exp1_idle_growth.pdf")

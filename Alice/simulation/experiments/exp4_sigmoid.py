"""实验 4：P3 关系冷却 sigmoid 曲线验证。

绘制 P3 对单个联系人的贡献随沉默时长的变化，
对不同 Dunbar 层级分别绘制，验证 S 型曲线形状
和正确的拐点位置（拐点 = theta_c）。

理论依据（论文 §3.1 Eq P3）：
  P3(c) = w_tier(c) / (1 + exp(-β(silence - θ_c)))
  拐点位于 silence = θ_c（期望互动频率）。
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.optimize import minimize_scalar

from graph import DUNBAR_TIER_WEIGHT, DUNBAR_TIER_THETA


# ---------------------------------------------------------------------------
# 单联系人的 P3 贡献（解析公式）
# ---------------------------------------------------------------------------

def p3_single_contact(
    silence: np.ndarray | float,
    tier: int,
    beta: float = 0.15,
) -> np.ndarray | float:
    """计算单个联系人在给定沉默时长下的 P3 贡献。

    P3(c) = w_tier / (1 + exp(-β * (silence - θ_c)))

    Parameters
    ----------
    silence : array-like or float
        沉默时长。
    tier : int
        Dunbar 层级。
    beta : float
        sigmoid 陡峭度。

    Returns
    -------
    array-like or float
        P3 贡献值。
    """
    w = DUNBAR_TIER_WEIGHT.get(tier, 0.8)
    theta = DUNBAR_TIER_THETA.get(tier, 80.0)
    x = beta * (np.asarray(silence, dtype=float) - theta)
    x = np.clip(x, -50.0, 50.0)
    return w / (1.0 + np.exp(-x))


def find_inflection(tier: int, beta: float = 0.15) -> float:
    """求 sigmoid 的拐点（二阶导为零处）。

    对 logistic 函数，拐点精确位于 silence = θ_c。
    这里用数值方法验证。

    Parameters
    ----------
    tier : int
        Dunbar 层级。
    beta : float
        sigmoid 陡峭度。

    Returns
    -------
    float
        拐点位置。
    """
    theta = DUNBAR_TIER_THETA.get(tier, 80.0)
    # logistic 函数的拐点在 x=0，即 silence = theta
    # 数值验证：最大化一阶导
    w = DUNBAR_TIER_WEIGHT.get(tier, 0.8)

    def neg_first_deriv(s: float) -> float:
        """P3 对 silence 的一阶导（取负用于最小化）。"""
        x = beta * (s - theta)
        x = np.clip(x, -50, 50)
        sigmoid = 1.0 / (1.0 + np.exp(-x))
        return -(w * beta * sigmoid * (1 - sigmoid))

    # 在 theta 附近搜索
    result = minimize_scalar(neg_first_deriv, bounds=(theta - 50, theta + 50), method="bounded")
    return float(result.x)


# ---------------------------------------------------------------------------
# 实验逻辑
# ---------------------------------------------------------------------------

def run_exp4(beta: float = 0.15) -> dict:
    """运行实验 4：sigmoid 曲线验证。

    Parameters
    ----------
    beta : float
        sigmoid 陡峭度参数。

    Returns
    -------
    dict
        各 Dunbar 层级的 P3 曲线数据和拐点。
    """
    tiers = sorted(DUNBAR_TIER_WEIGHT.keys())
    results: dict[str, dict] = {}

    print(f"  Sigmoid 陡峭度 β = {beta}")
    print(f"  {'Tier':>5s}  {'θ_c':>6s}  {'w_tier':>6s}  {'inflection':>11s}  {'P3(θ_c)':>8s}")
    print(f"  {'-----':>5s}  {'------':>6s}  {'------':>6s}  {'-----------':>11s}  {'--------':>8s}")

    for tier in tiers:
        theta = DUNBAR_TIER_THETA[tier]
        w = DUNBAR_TIER_WEIGHT[tier]

        # 计算 sigmoid 曲线
        max_silence = max(theta * 3, 100)
        silence_range = np.linspace(0, max_silence, 500)
        p3_values = p3_single_contact(silence_range, tier, beta=beta)

        # 求拐点
        inflection = find_inflection(tier, beta=beta)

        # 拐点处的 P3 值（理论上为 w/2）
        p3_at_inflection = float(p3_single_contact(inflection, tier, beta=beta))

        print(f"  {tier:>5d}  {theta:>6.1f}  {w:>6.1f}  {inflection:>11.2f}  {p3_at_inflection:>8.3f}")

        # 验证拐点 ≈ theta
        assert abs(inflection - theta) < 1.0, \
            f"拐点偏离期望值过大: inflection={inflection:.2f}, theta={theta:.1f}"
        # 验证拐点处 P3 ≈ w/2
        assert abs(p3_at_inflection - w / 2) < 0.01, \
            f"拐点处 P3 偏离 w/2 过大: P3={p3_at_inflection:.3f}, w/2={w/2:.3f}"

        results[str(tier)] = {
            "tier": tier,
            "theta": theta,
            "w": w,
            "silence_range": silence_range,
            "p3_values": p3_values,
            "inflection": inflection,
            "p3_at_inflection": p3_at_inflection,
        }

    print("\n  验证通过：所有 Dunbar 层级的拐点均位于 θ_c 处，P3(θ_c) = w/2")

    return results


def plot_exp4(results: dict, output_path: str) -> None:
    """绘制实验 4 结果。"""
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))

    # 配色：从暖到冷，亲密到疏远
    tier_colors = {
        "5":   "#d32f2f",  # 亲密 - 红
        "15":  "#e65100",  # 好友 - 橙
        "50":  "#f9a825",  # 朋友 - 黄
        "150": "#2e7d32",  # 熟人 - 绿
        "500": "#1565c0",  # 认识 - 蓝
    }

    tier_labels = {
        "5":   "Tier 5 (intimate)",
        "15":  "Tier 15 (close friend)",
        "50":  "Tier 50 (friend)",
        "150": "Tier 150 (acquaintance)",
        "500": "Tier 500 (known)",
    }

    # (a) 所有 Dunbar 层级的 P3 sigmoid 曲线
    ax = axes[0]
    for tier_str, data in results.items():
        color = tier_colors.get(tier_str, "#333333")
        ax.plot(
            data["silence_range"], data["p3_values"],
            color=color, linewidth=1.5,
            label=tier_labels.get(tier_str, f"Tier {tier_str}"),
        )
        # 标记拐点
        ax.scatter(
            [data["inflection"]], [data["p3_at_inflection"]],
            color=color, s=40, zorder=5, marker="o",
        )
        # 画虚线标示拐点位置
        ax.axvline(
            data["inflection"], color=color, linewidth=0.5,
            linestyle=":", alpha=0.5,
        )

    ax.set_xlabel("Silence duration (ticks)")
    ax.set_ylabel("$P_3$ contribution")
    ax.set_title("(a) Relationship cooling sigmoid by Dunbar tier")
    ax.legend(fontsize=7, loc="center right")
    ax.grid(True, alpha=0.3)

    # (b) 归一化的 sigmoid（所有层级重叠验证形状一致性）
    ax = axes[1]
    for tier_str, data in results.items():
        color = tier_colors.get(tier_str, "#333333")
        # 归一化: x = (silence - theta) / theta, y = P3 / w
        theta = data["theta"]
        w = data["w"]
        x_norm = (data["silence_range"] - theta) / theta
        y_norm = data["p3_values"] / w

        ax.plot(
            x_norm, y_norm,
            color=color, linewidth=1.5,
            label=tier_labels.get(tier_str, f"Tier {tier_str}"),
        )

    # 理论 sigmoid 曲线
    x_theory = np.linspace(-3, 3, 200)
    # 归一化 sigmoid: 1/(1+exp(-β*θ*x))，由于 β*θ 不同导致陡峭度不同
    # 这里画标准 logistic 作参考
    y_theory = 1.0 / (1.0 + np.exp(-2.0 * x_theory))
    ax.plot(x_theory, y_theory, color="#999999", linewidth=1.0,
            linestyle="--", label="Reference logistic")

    ax.axhline(0.5, color="#999999", linewidth=0.5, linestyle=":")
    ax.axvline(0, color="#999999", linewidth=0.5, linestyle=":")

    ax.set_xlabel("Normalized silence $(s - \\theta_c) / \\theta_c$")
    ax.set_ylabel("Normalized $P_3 / w_{\\mathrm{tier}}$")
    ax.set_title("(b) Normalized sigmoid shape verification")
    ax.set_xlim(-3, 3)
    ax.legend(fontsize=7)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


if __name__ == "__main__":
    print("实验 4：P3 关系冷却 sigmoid 验证")
    results = run_exp4(beta=0.15)
    os.makedirs("../paper/figures", exist_ok=True)
    plot_exp4(results, "../paper/figures/exp4_sigmoid.pdf")

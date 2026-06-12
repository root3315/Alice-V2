"""实验 9：声部覆盖性验证 — 证明 5 个声部在适当条件下都能被选中。

数学推导
========

五个声部的激活函数（v2 — max 版）：
    f_D = (nP1 + nP4 + nP5) / 3       — Diligence（勤勉）
    f_C = max(nP2, nP6)               — Curiosity（好奇）— 取强项而非平均
    f_S = nP3                           — Sociability（社交）
    f_X = uncertainty - nAPI_sum / κ_X  — Caution（谨慎）
    f_R = nP2                           — Reflection（反思）

其中 nPi = tanh(Pi/κi) ∈ [0, 1)，nAPI_sum = Σ nPi ∈ [0, 6)
响度 L_i = π_i * f_i + ε_i，胜者由 softmax(L/τ) 采样。

设计变更说明（v1 → v2）
------------------------
v1 使用 f_C = (nP2 + nP6) / 2。Exp9 发现结构性天花板：
当 C 主导条件 (P6 高, P2=0) 时，f_C = nP6/2 ≈ 0.40，天花板 ~0.5。
而 f_D、f_S、f_R 的天花板均为 ~1.0，造成 C 在极端条件下仅 36.8% 胜率。

v2 改为 max(nP2, nP6)：
- 天花板与其他声部对称（~1.0）
- 语义更准确：好奇心来自"信息匮乏(P6)或信息过剩(P2)中更强的那个"
- R vs C 区分仍然成立：P2 独大时 f_R = f_C = nP2，由 π 决定；
  P6 独大时 f_C = nP6 > f_R = nP2 ≈ 0，C 赢。

各声部的主导充分条件
--------------------

目标：使声部 i 成为 argmax(L) 的充分条件，即 L_i > L_j ∀ j≠i。
忽略噪声项 ε（量级 ~0.05 远小于人格调制的量级差），给出激活函数层面的条件。

1. **D 主导**：需要 π_D * f_D > π_j * f_j ∀ j≠D。
   充分条件：P1, P4, P5 都高（使 nP1, nP4, nP5 → 1），其他压力为 0。
   此时 f_D → 1，f_C = 0，f_S = 0，f_R = 0。f_X ≤ uncertainty ≤ 1。
   若 π_D > π_X 则 D 胜出。

2. **C 主导**：f_C = max(nP2, nP6)。
   - P6 独大（P2=0）：f_C = nP6，f_R = 0 → C 自然赢 R。
     充分条件：P6 = eta = 0.6 → nP6 = tanh(0.6/0.5) ≈ 0.76，其他压力=0。
     f_C ≈ 0.76，远超 v1 的 0.40。配合 π_C 偏高即可主导。
   - P2 独大（P6=0）：f_C = nP2 = f_R → 由 π 决定（C 和 R 竞争）。
   - P2 和 P6 都高：f_C = max(nP2,nP6) ≥ nP2 = f_R → C 不弱于 R。

3. **S 主导**：f_S = nP3。
   充分条件：多个联系人长期沉默 → P3 高 → nP3 大，其他压力为 0。
   f_S → 1，f_D = f_C = f_R = 0，f_X ≤ uncertainty。
   配合 π_S 偏高即可。

4. **X 主导**：f_X = uncertainty - nAPI_sum / κ_X。
   极端情况：所有 Pi = 0 → nAPI_sum = 0，uncertainty = 1 → f_X = 1。
   此时其他 f 都是 0，X 必然主导（只要 π_X > 0）。
   X 主导的必要条件是**压力低 + 信息稀少**。

5. **R 主导**：f_R = nP2。
   关键区分：R vs C 问题。f_C = max(nP2, nP6)。
   - 当 P6 = 0 时，f_C = max(nP2, 0) = nP2 = f_R → 平局，由 π 决定。
   - 充分条件：P2 高，P6 = 0，其他压力 = 0，π_R > π_C。
     此时 f_R = nP2 = f_C，但 L_R = π_R * nP2 > π_C * nP2 = L_C。

R vs C 分工机制（v2）
---------------------
f_R = nP2, f_C = max(nP2, nP6)。
- P6 = 0 时：f_C = nP2 = f_R → 平局，由 π_R vs π_C 决定。
  π_R > π_C → R 赢（反思型人格）。π_C > π_R → C 赢（好奇型人格）。
- P6 > 0 时：f_C = max(nP2, nP6) ≥ nP2 = f_R → C 不弱于 R。
  当 nP6 > nP2 时 f_C > f_R，C 有优势。
结论：v2 下 R 和 C 仍通过 P6 自然分工——P6=0 时由人格决定，P6>0 时 C 占优。
注意：v2 中 R 赢 C 的条件更严格（需要 P6=0 且 π_R > π_C），
这意味着好奇心是比反思更"默认"的行为——符合直觉。

是否存在使 Caution 永远为负的参数区间？
----------------------------------------
当所有压力都很高（如 nAPI_sum → 6）时，f_X = unc - 6/3 = unc - 2。
因为 uncertainty ∈ [0, 1]，此时 f_X ∈ [-2, -1]，永远为负。
但这只是特定压力状态——在"安静无事但信息不足"的状态下 f_X 可达 1。
结论：不存在使 f_X 在所有状态下都为负的参数配置（只要 κ_X > 0）。

测试策略
========

对每个声部构造极端场景使其激活值最高，运行 N=1000 次采样验证胜率 > 50%。
额外测试：均匀人格下通过压力差异驱动不同声部胜出。
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import CompanionGraph, NodeType
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    VOICE_NAMES,
    VOICE_SHORT,
)


# ---------------------------------------------------------------------------
# 图构造辅助函数
# ---------------------------------------------------------------------------

def _build_graph_for_diligence(tick: int = 100) -> CompanionGraph:
    """构造 D 主导场景：P1 高（大量未读）、P4 高（开放线程多且久）、P5 高（directed 消息）。
    其他压力为零：无 P2（无 InfoItem）、无 P3（联系人刚活跃）、无 P6（高 novelty）。
    """
    G = CompanionGraph()
    G.tick = tick

    G.add_entity(NodeType.AGENT, "agent_0")

    # P1: 大量未读消息
    for i in range(5):
        hid = f"channel_{i}"
        G.add_entity(NodeType.CHANNEL, hid, unread=100, tier_contact=5)
        G.add_relation("agent_0", "monitors", hid)
        # P5: directed 消息
        G.set_node_attr(hid, "pending_directed", 10.0)
        G.set_node_attr(hid, "last_directed_tick", tick - 1)

    # P4: 多条久远的开放线程
    for i in range(10):
        tid = f"thread_{i}"
        G.add_entity(NodeType.THREAD, tid, status="open", weight="major", created=0)

    # 确保无 P3：联系人刚刚活跃
    for i in range(3):
        cid = f"contact_{i}"
        G.add_entity(NodeType.CONTACT, cid, tier=150, last_active=tick)

    return G


def _build_graph_for_curiosity(tick: int = 100) -> CompanionGraph:
    """构造 C 主导场景：P6 高（novelty 极低）、P2 = 0（无 InfoItem）。
    通过 novelty_history 全为 0 使 P6 = eta = 0.6。
    """
    G = CompanionGraph()
    G.tick = tick
    G.add_entity(NodeType.AGENT, "agent_0")

    # 无 Channel/Thread/Contact/InfoItem → P1=P2=P3=P4=P5=0
    return G


def _build_graph_for_sociability(tick: int = 100) -> CompanionGraph:
    """构造 S 主导场景：P3 高（多个联系人长期沉默），其他压力低。"""
    G = CompanionGraph()
    G.tick = tick
    G.add_entity(NodeType.AGENT, "agent_0")

    # P3: 多个亲密联系人长期沉默
    for i in range(10):
        cid = f"contact_{i}"
        # tier=5 权重最高 (5.0)，theta=5 → 沉默 100 tick 远超阈值
        G.add_entity(NodeType.CONTACT, cid, tier=5, last_active=0)
        G.add_relation("agent_0", "owner", cid)

    return G


def _build_graph_for_caution(tick: int = 100) -> CompanionGraph:
    """构造 X 主导场景：所有压力为零。
    配合 recent_event_counts = [0]*10 使 uncertainty 高。
    """
    G = CompanionGraph()
    G.tick = tick
    G.add_entity(NodeType.AGENT, "agent_0")
    # 完全空图 → P1=P2=P3=P4=P5=P6=0，nAPI_sum=0
    return G


def _build_graph_for_reflection(tick: int = 100) -> CompanionGraph:
    """构造 R 主导场景：P2 高（大量旧信息项），P6=0（高 novelty）。
    novelty_history 全为 eta 使 P6=0。
    """
    G = CompanionGraph()
    G.tick = tick
    G.add_entity(NodeType.AGENT, "agent_0")

    # P2: 大量重要且遗忘的信息项
    for i in range(20):
        iid = f"info_{i}"
        G.add_entity(
            NodeType.INFO_ITEM, iid,
            importance=1.0,
            stability=0.5,
            last_access=0,     # 很久没访问
            volatility=1.0,
            tracked=True,
            created=0,
        )
        G.add_relation("agent_0", "knows", iid)

    return G


# ---------------------------------------------------------------------------
# 场景定义
# ---------------------------------------------------------------------------

SCENARIOS: dict[str, dict] = {
    "D_dominant": {
        "label": "D 主导（高 P1+P4+P5）",
        "target_voice": 0,
        "build_graph": _build_graph_for_diligence,
        "personality": np.array([0.4, 0.1, 0.1, 0.1, 0.1]),
        # P6 需为 0 → novelty_history 全为 eta (0.6)
        "novelty_history": [0.6] * 20,
        # uncertainty 低 → 不利于 X → 有大量事件
        "recent_event_counts": [5] * 20,
    },
    "C_dominant": {
        "label": "C 主导（高 P6，P2=0）",
        "target_voice": 1,
        "build_graph": _build_graph_for_curiosity,
        "personality": np.array([0.1, 0.4, 0.1, 0.1, 0.1]),
        # P6 高 → novelty_history 全为 0（mean_novelty=0 → P6=eta=0.6）
        "novelty_history": [0.0] * 20,
        # uncertainty 低 → 有大量事件
        "recent_event_counts": [5] * 20,
    },
    "S_dominant": {
        "label": "S 主导（高 P3）",
        "target_voice": 2,
        "build_graph": _build_graph_for_sociability,
        "personality": np.array([0.1, 0.1, 0.4, 0.1, 0.1]),
        # P6=0
        "novelty_history": [0.6] * 20,
        # uncertainty 低
        "recent_event_counts": [5] * 20,
    },
    "X_dominant": {
        "label": "X 主导（全零压力 + 高 uncertainty）",
        "target_voice": 3,
        "build_graph": _build_graph_for_caution,
        "personality": np.array([0.1, 0.1, 0.1, 0.4, 0.1]),
        # P6=0（novelty 高）
        "novelty_history": [0.6] * 20,
        # uncertainty 高 → 无事件
        "recent_event_counts": [0] * 20,
    },
    "R_dominant": {
        "label": "R 主导（高 P2，P6=0）",
        "target_voice": 4,
        "build_graph": _build_graph_for_reflection,
        "personality": np.array([0.1, 0.1, 0.1, 0.1, 0.4]),
        # P6=0 → novelty_history 全为 eta
        "novelty_history": [0.6] * 20,
        # uncertainty 低
        "recent_event_counts": [5] * 20,
    },
}

# 均匀人格场景：验证压力差异在均匀人格下也能驱动不同声部
UNIFORM_SCENARIOS: dict[str, dict] = {
    "uniform_D": {
        "label": "均匀人格 + D 压力",
        "target_voice": 0,
        "build_graph": _build_graph_for_diligence,
        "personality": np.array([0.2, 0.2, 0.2, 0.2, 0.2]),
        "novelty_history": [0.6] * 20,
        "recent_event_counts": [5] * 20,
    },
    "uniform_S": {
        "label": "均匀人格 + S 压力",
        "target_voice": 2,
        "build_graph": _build_graph_for_sociability,
        "personality": np.array([0.2, 0.2, 0.2, 0.2, 0.2]),
        "novelty_history": [0.6] * 20,
        "recent_event_counts": [5] * 20,
    },
    "uniform_X": {
        "label": "均匀人格 + X 压力",
        "target_voice": 3,
        "build_graph": _build_graph_for_caution,
        "personality": np.array([0.2, 0.2, 0.2, 0.2, 0.2]),
        "novelty_history": [0.6] * 20,
        "recent_event_counts": [0] * 20,
    },
}


# ---------------------------------------------------------------------------
# 单场景采样
# ---------------------------------------------------------------------------

def _sample_scenario(
    scenario: dict,
    n_samples: int = 1000,
    seed: int = 9000,
) -> dict:
    """对单个场景运行 n_samples 次采样，返回胜率统计。"""
    rng = np.random.default_rng(seed)
    personality = PersonalityVector(weights=scenario["personality"].copy())
    G = scenario["build_graph"]()
    novelty_history = scenario["novelty_history"]
    recent_event_counts = scenario["recent_event_counts"]

    win_counts = np.zeros(5, dtype=int)

    for _ in range(n_samples):
        loudness = compute_loudness(
            G, G.tick, personality,
            novelty_history=novelty_history,
            recent_event_counts=recent_event_counts,
            rng=rng,
        )
        winner_idx, _ = select_action(loudness, rng=rng)
        win_counts[winner_idx] += 1

    win_rates = win_counts / n_samples
    target = scenario["target_voice"]
    return {
        "win_counts": win_counts,
        "win_rates": win_rates,
        "target_voice": target,
        "target_win_rate": float(win_rates[target]),
        "pass": float(win_rates[target]) > 0.50,
    }


# ---------------------------------------------------------------------------
# 实验主逻辑
# ---------------------------------------------------------------------------

def run_exp9(
    n_samples: int = 1000,
    seed_base: int = 9000,
) -> dict:
    """运行实验 9：声部覆盖性验证。

    Parameters
    ----------
    n_samples : int
        每个场景的采样次数。
    seed_base : int
        随机种子基数。

    Returns
    -------
    dict
        包含每个场景的胜率统计和整体通过状态。
    """
    results: dict = {"biased": {}, "uniform": {}, "all_pass": True}

    print("\n  Part A: 偏向人格 + 极端压力（5 个场景）")
    print("  " + "-" * 56)

    for i, (name, scenario) in enumerate(SCENARIOS.items()):
        r = _sample_scenario(scenario, n_samples=n_samples, seed=seed_base + i * 100)
        results["biased"][name] = r

        target = r["target_voice"]
        status = "PASS" if r["pass"] else "FAIL"
        rates_str = " | ".join(
            f"{VOICE_SHORT[j]}={r['win_rates'][j]*100:5.1f}%" for j in range(5)
        )
        print(f"    {scenario['label']:30s}  目标={VOICE_SHORT[target]}  "
              f"胜率={r['target_win_rate']*100:5.1f}%  [{status}]")
        print(f"      分布: {rates_str}")

        if not r["pass"]:
            results["all_pass"] = False

    print(f"\n  Part B: 均匀人格 + 极端压力（3 个场景）")
    print("  " + "-" * 56)

    for i, (name, scenario) in enumerate(UNIFORM_SCENARIOS.items()):
        r = _sample_scenario(scenario, n_samples=n_samples, seed=seed_base + 500 + i * 100)
        results["uniform"][name] = r

        target = r["target_voice"]
        status = "PASS" if r["pass"] else "FAIL"
        rates_str = " | ".join(
            f"{VOICE_SHORT[j]}={r['win_rates'][j]*100:5.1f}%" for j in range(5)
        )
        print(f"    {scenario['label']:30s}  目标={VOICE_SHORT[target]}  "
              f"胜率={r['target_win_rate']*100:5.1f}%  [{status}]")
        print(f"      分布: {rates_str}")

        if not r["pass"]:
            results["all_pass"] = False

    return results


# ---------------------------------------------------------------------------
# 可视化
# ---------------------------------------------------------------------------

def plot_exp9(results: dict, output_path: str) -> None:
    """绘制实验 9 结果：每个场景的声部胜率堆叠柱状图。"""
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    colors = ["#1565c0", "#e65100", "#2e7d32", "#6a1b9a", "#c62828"]

    for ax, (part_key, part_label) in zip(
        axes, [("biased", "Biased personality"), ("uniform", "Uniform personality")]
    ):
        scenarios = results[part_key]
        names = list(scenarios.keys())
        n_scenarios = len(names)
        x = np.arange(n_scenarios)

        bottom = np.zeros(n_scenarios)
        for v_idx in range(5):
            rates = [scenarios[n]["win_rates"][v_idx] for n in names]
            bars = ax.bar(
                x, rates, bottom=bottom, width=0.6,
                label=VOICE_NAMES[v_idx], color=colors[v_idx], alpha=0.85,
            )
            # 在目标声部的 bar 上标注胜率
            for s_idx, name in enumerate(names):
                if scenarios[name]["target_voice"] == v_idx:
                    rate = rates[s_idx]
                    if rate > 0.08:
                        ax.text(
                            x[s_idx], bottom[s_idx] + rate / 2,
                            f"{rate*100:.0f}%",
                            ha="center", va="center", fontsize=7,
                            fontweight="bold", color="white",
                        )
            bottom += np.array(rates)

        # 50% 基准线
        ax.axhline(0.5, color="red", linewidth=0.8, linestyle="--", alpha=0.5, label="50% threshold")

        # 目标声部标注
        for s_idx, name in enumerate(names):
            target = scenarios[name]["target_voice"]
            ax.text(
                x[s_idx], 1.02, f"target={VOICE_SHORT[target]}",
                ha="center", va="bottom", fontsize=7, color=colors[target],
            )

        ax.set_xlabel("Scenario")
        ax.set_ylabel("Win rate")
        ax.set_title(part_label)
        ax.set_xticks(x)
        labels = [SCENARIOS.get(n, UNIFORM_SCENARIOS.get(n, {})).get("label", n)
                  for n in names]
        # 截断标签
        labels = [l[:12] + "..." if len(l) > 15 else l for l in labels]
        ax.set_xticklabels(labels, fontsize=7, rotation=15)
        ax.set_ylim(0, 1.15)
        ax.legend(fontsize=6, ncol=3, loc="upper right")
        ax.grid(True, alpha=0.3, axis="y")

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"\n  图已保存: {output_path}")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("实验 9：声部覆盖性验证")
    print("=" * 60)
    results = run_exp9(n_samples=1000)

    fig_dir = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "..", "paper", "figures",
    )
    os.makedirs(fig_dir, exist_ok=True)
    plot_exp9(results, os.path.join(fig_dir, "exp9_voice_coverage.pdf"))

    print("\n" + "=" * 60)
    print("实验 9 结果汇总:")
    all_pass = results["all_pass"]
    biased_pass = all(r["pass"] for r in results["biased"].values())
    uniform_pass = all(r["pass"] for r in results["uniform"].values())
    print(f"  Part A (偏向人格): {'ALL PASS' if biased_pass else 'SOME FAIL'}")
    print(f"  Part B (均匀人格): {'ALL PASS' if uniform_pass else 'SOME FAIL'}")
    print(f"  总结: {'ALL 8 SCENARIOS PASS' if all_pass else 'SOME SCENARIOS FAIL'}")
    print(f"\n  结论: 5 个声部在适当参数配置下{'都能' if all_pass else '未全部能'}被选为主导。")

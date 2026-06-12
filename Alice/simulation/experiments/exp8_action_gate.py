"""实验 8：行动频率门验证（v4 新增）。

验证行动频率门（替代 v3 的 φ/ψ）的行为：
A. 疲劳效应：高频行动 → 阈值上升 → 行动间隔拉长
B. 主动效应：长期沉默 → 阈值下降 → 触发主动行动
C. 门 vs 无门对比：验证频率门稳定了行动节律

理论依据（docs/14 原则三：竞争在门）：
- 行动频率门是 φ/ψ 的合法功能替代
- 疲劳：action_rate > cap → effective_margin ↑
- 主动：action_rate < floor → effective_margin ↓
- 不污染压力测量，只调节行动触发阈值
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import NodeType, random_companion_graph
from pressure import compute_all_pressures
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
)


# ---------------------------------------------------------------------------
# 简易模拟循环（带可配置的频率门参数）
# ---------------------------------------------------------------------------

def _run_sim_with_gate(
    n_steps: int,
    seed: int,
    gate_enabled: bool = True,
    action_rate_cap: float = 0.3,
    action_rate_floor: float = 0.05,
    fatigue_alpha: float = 0.5,
    initiative_alpha: float = 0.3,
    trigger_margin: float = 0.05,
    cooldown: int = 5,
    action_rate_window: int = 50,
    inject_events: bool = True,
) -> dict:
    """运行一次简易模拟，返回行动事件和压力轨迹。"""
    rng = np.random.default_rng(seed)
    G = random_companion_graph(
        n_contacts=15, n_threads=8, n_channels=4,
        n_info_items=10, seed=seed,
    )

    personality = PersonalityVector(weights=np.array([0.25, 0.2, 0.2, 0.15, 0.2]))
    # P6 novelty_history：初始化为空，由事件驱动填充真实 novelty
    novelty_history: list[float] = []
    event_count_history: list[int] = []
    action_window: list[bool] = []

    napi_ema: float | None = None
    last_action_tick = -cooldown
    ema_alpha = 0.02

    api_trace: list[float] = []
    action_ticks: list[int] = []
    margin_trace: list[float] = []

    for step in range(1, n_steps + 1):
        G.tick = step

        # 注入事件
        n_events = 0
        if inject_events and rng.random() < 0.15:
            channels = G.get_entities_by_type(NodeType.CHANNEL)
            if channels:
                hid = channels[int(rng.integers(0, len(channels)))]
                old_unread = G.node_attrs(hid).get("unread", 0)
                G.set_node_attr(hid, "unread", old_unread + int(rng.integers(1, 4)))
                n_events = 1

        event_count_history.append(n_events)
        # 在压力计算前 append 事件 novelty
        # 有事件 → novelty=0.3，无事件 → novelty=0（好奇心上升）
        novelty_history.append(0.3 if n_events > 0 else 0.0)

        # 计算压力
        result = compute_all_pressures(G, step, novelty_history=novelty_history)
        napi_val = result["API"]
        api_trace.append(napi_val)

        # EMA
        if napi_ema is None:
            napi_ema = napi_val
        else:
            napi_ema = ema_alpha * napi_val + (1 - ema_alpha) * napi_ema

        # 行动频率门
        if gate_enabled and action_window:
            recent = action_window[-action_rate_window:]
            action_rate = sum(recent) / len(recent)
            fatigue_mod = fatigue_alpha * max(0.0, action_rate - action_rate_cap)
            initiative_mod = initiative_alpha * max(0.0, action_rate_floor - action_rate)
            effective_margin = trigger_margin * (1.0 + fatigue_mod - initiative_mod)
        else:
            effective_margin = trigger_margin

        margin_trace.append(effective_margin)

        # 触发判断
        cooled_down = (step - last_action_tick) >= cooldown
        delta_trigger = (napi_val - napi_ema) > effective_margin
        should_act = cooled_down and delta_trigger

        acted = False
        if should_act:
            loudness = compute_loudness(
                G, step, personality,
                novelty_history=novelty_history,
                recent_event_counts=event_count_history,
                rng=rng,
            )
            winner_idx, action_type = select_action(loudness, rng=rng)

            # 简化压力释放
            if action_type == "diligence":
                threads = G.get_entities_by_type(NodeType.THREAD)
                open_t = [t for t in threads if G.node_attrs(t).get("status") == "open"]
                if open_t:
                    G.set_node_attr(open_t[0], "status", "resolved")
                channels = G.get_entities_by_type(NodeType.CHANNEL)
                for hid in channels[:2]:
                    u = G.node_attrs(hid).get("unread", 0)
                    if u > 0:
                        G.set_node_attr(hid, "unread", max(0, u - 2))
            elif action_type == "sociability":
                contacts = G.get_entities_by_type(NodeType.CONTACT)
                if contacts:
                    G.set_node_attr(contacts[int(rng.integers(0, len(contacts)))],
                                    "last_active", step)

            last_action_tick = step
            action_ticks.append(step)
            acted = True

        action_window.append(acted)

    return {
        "api_trace": np.array(api_trace),
        "action_ticks": action_ticks,
        "margin_trace": np.array(margin_trace),
        "n_actions": len(action_ticks),
    }


# ---------------------------------------------------------------------------
# Part A: 疲劳效应
# ---------------------------------------------------------------------------

def run_part_a(n_trials: int = 30, n_steps: int = 300, seed_base: int = 8000) -> dict:
    """高频行动时疲劳门是否拉长行动间隔。"""
    print("\n  Part A: 疲劳效应测试")

    intervals_gate: list[float] = []
    intervals_no_gate: list[float] = []

    for trial in range(n_trials):
        seed = seed_base + trial

        # 有门
        r_gate = _run_sim_with_gate(n_steps, seed, gate_enabled=True)
        if len(r_gate["action_ticks"]) > 1:
            intervals_gate.extend(np.diff(r_gate["action_ticks"]).tolist())

        # 无门
        r_no_gate = _run_sim_with_gate(n_steps, seed, gate_enabled=False)
        if len(r_no_gate["action_ticks"]) > 1:
            intervals_no_gate.extend(np.diff(r_no_gate["action_ticks"]).tolist())

    mean_gate = np.mean(intervals_gate) if intervals_gate else 0
    mean_no_gate = np.mean(intervals_no_gate) if intervals_no_gate else 0
    std_gate = np.std(intervals_gate) if intervals_gate else 0
    std_no_gate = np.std(intervals_no_gate) if intervals_no_gate else 0

    # 疲劳门应使行动间隔的变异系数（CV）更小（更稳定的节律）
    cv_gate = std_gate / mean_gate if mean_gate > 0 else float("inf")
    cv_no_gate = std_no_gate / mean_no_gate if mean_no_gate > 0 else float("inf")

    result = {
        "mean_interval_gate": float(mean_gate),
        "mean_interval_no_gate": float(mean_no_gate),
        "std_interval_gate": float(std_gate),
        "std_interval_no_gate": float(std_no_gate),
        "cv_gate": float(cv_gate),
        "cv_no_gate": float(cv_no_gate),
        "intervals_gate": intervals_gate,
        "intervals_no_gate": intervals_no_gate,
    }

    print(f"    有门: 间隔 {mean_gate:.1f} ± {std_gate:.1f}, CV={cv_gate:.3f}")
    print(f"    无门: 间隔 {mean_no_gate:.1f} ± {std_no_gate:.1f}, CV={cv_no_gate:.3f}")

    return result


# ---------------------------------------------------------------------------
# Part B: 主动效应
# ---------------------------------------------------------------------------

def run_part_b(n_trials: int = 30, n_steps: int = 300, seed_base: int = 8500) -> dict:
    """长期沉默时主动门是否降低阈值触发行动。"""
    print("\n  Part B: 主动效应测试")

    actions_gate: list[int] = []
    actions_no_gate: list[int] = []

    for trial in range(n_trials):
        seed = seed_base + trial

        # 有门 + 无事件注入（长期沉默）
        r_gate = _run_sim_with_gate(
            n_steps, seed, gate_enabled=True, inject_events=False,
        )
        actions_gate.append(r_gate["n_actions"])

        # 无门 + 无事件注入
        r_no_gate = _run_sim_with_gate(
            n_steps, seed, gate_enabled=False, inject_events=False,
        )
        actions_no_gate.append(r_no_gate["n_actions"])

    mean_actions_gate = float(np.mean(actions_gate))
    mean_actions_no_gate = float(np.mean(actions_no_gate))

    # 主动门应在沉默时触发更多行动
    gate_more_active = mean_actions_gate >= mean_actions_no_gate

    result = {
        "mean_actions_gate": mean_actions_gate,
        "mean_actions_no_gate": mean_actions_no_gate,
        "gate_more_active": gate_more_active,
        "actions_gate": actions_gate,
        "actions_no_gate": actions_no_gate,
    }

    print(f"    有门 (沉默): 平均行动 {mean_actions_gate:.1f}")
    print(f"    无门 (沉默): 平均行动 {mean_actions_no_gate:.1f}")
    print(f"    主动门触发更多行动: {'PASS' if gate_more_active else 'FAIL'}")

    return result


# ---------------------------------------------------------------------------
# Part C: 节律稳定性
# ---------------------------------------------------------------------------

def run_part_c(n_steps: int = 500, seed: int = 8042) -> dict:
    """对比有/无门时的行动节律稳定性。"""
    print("\n  Part C: 节律稳定性对比")

    r_gate = _run_sim_with_gate(n_steps, seed, gate_enabled=True)
    r_no_gate = _run_sim_with_gate(n_steps, seed, gate_enabled=False)

    result = {
        "gate": {
            "api_trace": r_gate["api_trace"],
            "action_ticks": r_gate["action_ticks"],
            "margin_trace": r_gate["margin_trace"],
            "n_actions": r_gate["n_actions"],
        },
        "no_gate": {
            "api_trace": r_no_gate["api_trace"],
            "action_ticks": r_no_gate["action_ticks"],
            "margin_trace": r_no_gate["margin_trace"],
            "n_actions": r_no_gate["n_actions"],
        },
    }

    print(f"    有门: {r_gate['n_actions']} 次行动")
    print(f"    无门: {r_no_gate['n_actions']} 次行动")

    return result


# ---------------------------------------------------------------------------
# 可视化
# ---------------------------------------------------------------------------

def plot_exp8(results: dict, path: str) -> None:
    """生成 exp8 三合一可视化。"""
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))

    # Part A: 行动间隔分布对比
    ax = axes[0, 0]
    intervals_gate = results["a"]["intervals_gate"]
    intervals_no_gate = results["a"]["intervals_no_gate"]
    if intervals_gate and intervals_no_gate:
        bins = np.linspace(0, max(max(intervals_gate), max(intervals_no_gate)), 30)
        ax.hist(intervals_gate, bins=bins, alpha=0.6, label="With gate", color="#2ecc71")
        ax.hist(intervals_no_gate, bins=bins, alpha=0.6, label="No gate", color="#e74c3c")
        ax.legend(fontsize=8)
    ax.set_xlabel("Action interval (ticks)")
    ax.set_ylabel("Count")
    ax.set_title("(a) Action Interval Distribution")

    # Part B: 沉默期行动数对比
    ax = axes[0, 1]
    ax.bar(["With gate", "No gate"],
           [results["b"]["mean_actions_gate"], results["b"]["mean_actions_no_gate"]],
           color=["#2ecc71", "#e74c3c"])
    ax.set_ylabel("Mean actions (silent scenario)")
    ax.set_title("(b) Initiative: Actions in Silence")

    # Part C: API 轨迹对比
    ax = axes[1, 0]
    gate_data = results["c"]["gate"]
    no_gate_data = results["c"]["no_gate"]
    x = np.arange(1, len(gate_data["api_trace"]) + 1)
    ax.plot(x, gate_data["api_trace"], color="#2ecc71", linewidth=0.8,
            alpha=0.7, label="With gate")
    ax.plot(x, no_gate_data["api_trace"], color="#e74c3c", linewidth=0.8,
            alpha=0.7, label="No gate")
    # 标注行动点
    for t in gate_data["action_ticks"]:
        ax.axvline(t, color="#2ecc71", alpha=0.15, linewidth=0.5)
    for t in no_gate_data["action_ticks"]:
        ax.axvline(t, color="#e74c3c", alpha=0.15, linewidth=0.5)
    ax.legend(fontsize=8)
    ax.set_xlabel("Tick")
    ax.set_ylabel("nAPI")
    ax.set_title("(c) API Trace: Gate vs No Gate")

    # Part C: 自适应 margin 变化
    ax = axes[1, 1]
    ax.plot(x, gate_data["margin_trace"], color="#2ecc71", linewidth=1.0,
            label="Effective margin (gate)")
    ax.axhline(0.05, color="#999", linewidth=0.5, linestyle=":", label="Base margin")
    ax.legend(fontsize=8)
    ax.set_xlabel("Tick")
    ax.set_ylabel("Effective margin")
    ax.set_title("(d) Adaptive Trigger Margin")

    plt.tight_layout()
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"\n  图表已保存: {path}")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def run_exp8() -> dict:
    """运行实验 8 全部三个部分。"""
    return {
        "a": run_part_a(),
        "b": run_part_b(),
        "c": run_part_c(),
    }


if __name__ == "__main__":
    print("实验 8：行动频率门验证")
    results = run_exp8()
    fig_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                           "..", "paper", "figures")
    os.makedirs(fig_dir, exist_ok=True)
    plot_exp8(results, os.path.join(fig_dir, "exp8_action_gate.pdf"))

    print("\n" + "=" * 50)
    print("实验 8 结果汇总:")
    print(f"  Part A: CV(gate)={results['a']['cv_gate']:.3f}, "
          f"CV(no_gate)={results['a']['cv_no_gate']:.3f}")
    print(f"  Part B: 主动效应 {'PASS' if results['b']['gate_more_active'] else 'FAIL'}")
    print(f"  Part C: 行动数 gate={results['c']['gate']['n_actions']}, "
          f"no_gate={results['c']['no_gate']['n_actions']}")

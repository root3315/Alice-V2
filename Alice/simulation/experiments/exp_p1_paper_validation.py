"""P1 模拟验证：五维闭环论文的五个关键实验。

ADR-60 P1 要求用 simulation/ 现有引擎验证论文的动力学预测：
1. 单联系人 idle→action 循环（准周期性）
2. 多联系人不同 tier（差异化节律）
3. 撤除 D5 C_social=0（行为发散）
4. 违反稳定性条件（骚扰螺旋）
5. 人格漂移下轨道变形

@see docs/adr/60-paper-theoretical-deepening.md §P1
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import CompanionGraph, NodeType, EdgeCategory, DUNBAR_TIER_WEIGHT, DUNBAR_TIER_THETA
from pressure import (
    compute_all_pressures,
    P3_relationship_cooling,
)
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    personality_evolution_step,
    VOICE_SHORT,
)


# ---------------------------------------------------------------------------
# 辅助：构建最小可控的单联系人图
# ---------------------------------------------------------------------------

def _make_single_contact_graph(
    tier: int = 15,
    chat_type: str = "private",
    n_info_items: int = 3,
) -> CompanionGraph:
    """构建一个单联系人的最小图，用于隔离实验。"""
    G = CompanionGraph()
    G.tick = 0

    G.add_entity(NodeType.AGENT, "agent_0")
    G.add_entity(NodeType.CONTACT, "ct_0", tier=tier, trust=0.7, last_active=0)
    G.add_relation("agent_0", "friend", "ct_0")
    G.add_entity(NodeType.CHANNEL, "ch_0",
                 unread=0, tier_contact=tier, chat_type=chat_type)
    G.add_relation("agent_0", "monitors", "ch_0")
    G.add_relation("ct_0", "in", "ch_0")
    G.add_entity(NodeType.THREAD, "th_0",
                 status="open", weight="minor", created=0)
    G.add_relation("agent_0", "tracks", "th_0")
    G.add_relation("th_0", "involves", "ct_0")
    for i in range(n_info_items):
        G.add_entity(NodeType.INFO_ITEM, f"info_{i}",
                     importance=0.5, stability=2.0, last_access=0,
                     volatility=0.3, tracked=(i == 0), created=0)
        G.add_relation("agent_0", "knows", f"info_{i}")

    return G


# ===========================================================================
# 实验 1: 单联系人 idle→action 循环
# ===========================================================================

def run_exp1_single_contact_cycle(n_ticks: int = 500) -> dict:
    """验证单联系人场景下的准周期锯齿波行为。

    理论预测：
    - 压力在 idle 期间单调增长（P3 关系冷却 + P4 线程发散 + P6 好奇心）
    - 行动后压力骤降（unread 清零、last_active 刷新）
    - 整体呈锯齿波（sawtooth）模式
    - 行动间隔近似准周期（CV < 0.5）
    """
    print("\n" + "=" * 60)
    print("实验 1: 单联系人 idle→action 循环")
    print("=" * 60)

    G = _make_single_contact_graph(tier=15, chat_type="private")
    kappa = np.array([5.0, 8.0, 8.0, 200.0, 3.0, 0.5])
    rng = np.random.default_rng(42)
    personality = PersonalityVector(weights=np.array([0.25, 0.2, 0.2, 0.15, 0.2]))
    novelty_history: list[float] = []
    event_count_history: list[int] = []
    last_action_tick = -10

    # 关键：用高阈值确保压力需要积累一段时间才触发行动
    # 这样行动间隔由压力增长速率决定，而非 cooldown
    action_threshold = 2.5
    cooldown = 2

    records = {
        "ticks": [], "P1": [], "P2": [], "P3": [], "P4": [], "P5": [], "P6": [],
        "API": [], "actions": [], "action_ticks": [],
    }

    for tick in range(1, n_ticks + 1):
        G.tick = tick

        # 对方每 ~40 ticks 发一条消息（低频输入，压力主要来自时间流逝）
        if tick % 40 == 0:
            old_unread = G.node_attrs("ch_0").get("unread", 0)
            G.set_node_attr("ch_0", "unread", old_unread + 1)
            G.set_node_attr("ct_0", "last_active", tick)
            old_dir = G.node_attrs("ch_0").get("pending_directed", 0.0)
            G.set_node_attr("ch_0", "pending_directed", old_dir + 0.8)
            G.set_node_attr("ch_0", "last_directed_tick", tick)
            novelty_history.append(0.5)
            event_count_history.append(1)
        else:
            novelty_history.append(0.0)
            event_count_history.append(0)

        result = compute_all_pressures(G, tick, kappa=kappa,
                                       novelty_history=novelty_history)
        api_val = result["API"]

        cooled = (tick - last_action_tick) >= cooldown
        should_act = api_val > action_threshold and cooled

        action = None
        if should_act:
            action = "sociability"  # 简化：固定行动类型
            last_action_tick = tick
            records["action_ticks"].append(tick)

            # 释放压力
            G.set_node_attr("ch_0", "unread", 0)
            G.set_node_attr("ch_0", "pending_directed", 0.0)
            G.set_node_attr("ct_0", "last_active", tick)
            # 刷新 info items
            for iid in G.get_entities_by_type(NodeType.INFO_ITEM):
                G.set_node_attr(iid, "last_access", tick)
                G.set_node_attr(iid, "created", tick)
            novelty_history.append(0.7)

        records["ticks"].append(tick)
        for pk in ["P1", "P2", "P3", "P4", "P5", "P6", "API"]:
            records[pk].append(result[pk])
        records["actions"].append(action)

    # 分析
    action_ticks = records["action_ticks"]
    n_actions = len(action_ticks)
    api = np.array(records["API"])

    if n_actions > 2:
        intervals = np.diff(action_ticks)
        mean_interval = np.mean(intervals)
        std_interval = np.std(intervals)
        cv = std_interval / mean_interval if mean_interval > 0 else float("inf")
        print(f"  行动次数: {n_actions}")
        print(f"  平均行动间隔: {mean_interval:.1f} ticks")
        print(f"  间隔标准差: {std_interval:.1f}")
        print(f"  变异系数 (CV): {cv:.3f} (CV<0.5 → 准周期)")
    else:
        intervals = np.array([])
        cv = float("inf")
        print(f"  行动次数: {n_actions}（不足以分析周期性）")

    # 锯齿波检测
    drops = []
    for at in action_ticks:
        idx = at - 1
        if idx > 0 and idx < len(api) - 2:
            drop = api[idx] - api[idx + 1]
            drops.append(drop)
    if drops:
        mean_drop = np.mean(drops)
        print(f"  行动后平均 API 降幅: {mean_drop:.3f}")
        print(f"  锯齿波特征: {'✓' if mean_drop > 0 else '✗'}")

    records["intervals"] = intervals if len(intervals) > 0 else np.array([])
    records["cv"] = cv
    return records


def plot_exp1(records: dict, output_path: str) -> None:
    """绘制实验 1 结果。"""
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)

    ticks = np.array(records["ticks"])
    api = np.array(records["API"])

    # (a) API 锯齿波
    ax = axes[0]
    ax.plot(ticks, api, color="#1565c0", linewidth=0.8, label="API")
    for at in records["action_ticks"]:
        ax.axvline(at, color="#e65100", alpha=0.3, linewidth=0.5)
    ax.set_ylabel("API (normalized)")
    ax.set_title("Exp 1: Single-contact idle→action cycle (sawtooth pattern)")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # (b) P1-P6 分解
    ax = axes[1]
    colors = ["#1565c0", "#2e7d32", "#e65100", "#6a1b9a", "#c62828", "#00838f"]
    for i, pk in enumerate(["P1", "P2", "P3", "P4", "P5", "P6"]):
        vals = np.array(records[pk])
        ax.plot(ticks, vals, color=colors[i], linewidth=0.7, label=pk, alpha=0.8)
    for at in records["action_ticks"]:
        ax.axvline(at, color="#e65100", alpha=0.2, linewidth=0.5)
    ax.set_xlabel("Agent tick $n$")
    ax.set_ylabel("Raw pressure")
    ax.set_title("Pressure decomposition (P1–P6)")
    ax.legend(fontsize=7, ncol=3)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


# ===========================================================================
# 实验 2: 多联系人不同 tier（独立追踪）
# ===========================================================================

def run_exp2_multi_tier(n_ticks: int = 1000) -> dict:
    """验证不同 Dunbar tier 产生差异化行动节律。

    设计：三个独立模拟（各含单联系人），tier 不同。
    这样每个联系人有独立的压力累积和行动循环，
    避免多联系人共享图时高 tier 联系人垄断行动。

    理论预测：
    - tier=5：theta=20, weight=5.0 → P3 快速增长 → 短行动间隔
    - tier=50：theta=40, weight=1.5 → 中等增长 → 中等间隔
    - tier=500：theta=200, weight=0.3 → 慢增长 → 长间隔
    """
    print("\n" + "=" * 60)
    print("实验 2: 多联系人不同 tier")
    print("=" * 60)

    tiers = [5, 50, 500]
    tier_names = {5: "intimate (tier=5)", 50: "friend (tier=50)", 500: "acquaintance (tier=500)"}
    kappa = np.array([5.0, 8.0, 8.0, 200.0, 3.0, 0.5])
    # 统一阈值——让差异只来自 P3 增长速率
    action_threshold = 2.0

    all_records: dict[int, dict] = {}

    for tier in tiers:
        G = _make_single_contact_graph(tier=tier, chat_type="private")
        rng = np.random.default_rng(42)
        novelty_history: list[float] = []
        last_action_tick = -10

        rec = {"ticks": [], "P3": [], "API": [], "action_ticks": []}

        for tick in range(1, n_ticks + 1):
            G.tick = tick
            novelty_history.append(0.0)

            # 不发消息——让行动间隔完全由 P3(silence) 驱动
            result = compute_all_pressures(G, tick, kappa=kappa,
                                           novelty_history=novelty_history)
            api_val = result["API"]

            cooled = (tick - last_action_tick) >= 2
            if api_val > action_threshold and cooled:
                last_action_tick = tick
                rec["action_ticks"].append(tick)
                # 释放 P3: 刷新 last_active
                G.set_node_attr("ct_0", "last_active", tick)
                G.set_node_attr("ch_0", "unread", 0)
                G.set_node_attr("ch_0", "pending_directed", 0.0)
                # 刷新 info
                for iid in G.get_entities_by_type(NodeType.INFO_ITEM):
                    G.set_node_attr(iid, "last_access", tick)
                    G.set_node_attr(iid, "created", tick)
                novelty_history.append(0.7)

            rec["ticks"].append(tick)
            rec["P3"].append(result["P3"])
            rec["API"].append(api_val)

        all_records[tier] = rec

    # 分析
    for tier in tiers:
        actions = all_records[tier]["action_ticks"]
        n_act = len(actions)
        if n_act > 2:
            intervals = np.diff(actions)
            mean_int = np.mean(intervals)
            std_int = np.std(intervals)
            print(f"  {tier_names[tier]}: {n_act} 次行动, "
                  f"平均间隔 {mean_int:.1f}±{std_int:.1f} ticks")
        else:
            print(f"  {tier_names[tier]}: {n_act} 次行动")

    return {
        "tiers": tiers,
        "tier_names": tier_names,
        "all_records": all_records,
        "n_ticks": n_ticks,
    }


def plot_exp2(records: dict, output_path: str) -> None:
    """绘制实验 2 结果。"""
    fig, axes = plt.subplots(2, 1, figsize=(12, 7))

    colors = {5: "#c62828", 50: "#2e7d32", 500: "#1565c0"}

    # (a) API 轨迹叠加
    ax = axes[0]
    for tier in records["tiers"]:
        rec = records["all_records"][tier]
        ticks = np.array(rec["ticks"])
        api = np.array(rec["API"])
        ax.plot(ticks, api, linewidth=0.7,
                color=colors[tier],
                label=records["tier_names"][tier], alpha=0.8)
    ax.set_ylabel("API (normalized)")
    ax.set_title("Exp 2: API trajectory by Dunbar tier (independent simulations)")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # (b) 行动间隔直方图
    ax = axes[1]
    for tier in records["tiers"]:
        actions = records["all_records"][tier]["action_ticks"]
        if len(actions) > 2:
            intervals = np.diff(actions)
            ax.hist(intervals, bins=min(30, len(intervals)),
                    alpha=0.5, color=colors[tier],
                    label=f"tier={tier} (μ={np.mean(intervals):.0f})")
    ax.set_xlabel("Action interval (ticks)")
    ax.set_ylabel("Count")
    ax.set_title("Action interval distribution by tier")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


# ===========================================================================
# 实验 3: 撤除 D5 (C_social = 0)
# ===========================================================================

def _run_single_with_params(
    n_ticks: int,
    action_threshold: float,
    cooldown: int,
    msg_interval: int = 30,
    seed: int = 42,
) -> dict:
    """通用单联系人模拟，用于对比实验。"""
    G = _make_single_contact_graph(tier=15, chat_type="private")
    kappa = np.array([5.0, 8.0, 8.0, 200.0, 3.0, 0.5])
    novelty_history: list[float] = []
    last_action_tick = -cooldown

    rec = {"ticks": [], "API": [], "actions": [], "action_ticks": []}

    for tick in range(1, n_ticks + 1):
        G.tick = tick

        if msg_interval > 0 and tick % msg_interval == 0:
            old_unread = G.node_attrs("ch_0").get("unread", 0)
            G.set_node_attr("ch_0", "unread", old_unread + 1)
            G.set_node_attr("ct_0", "last_active", tick)
            old_dir = G.node_attrs("ch_0").get("pending_directed", 0.0)
            G.set_node_attr("ch_0", "pending_directed", old_dir + 0.8)
            G.set_node_attr("ch_0", "last_directed_tick", tick)
            novelty_history.append(0.5)
        else:
            novelty_history.append(0.0)

        result = compute_all_pressures(G, tick, kappa=kappa,
                                       novelty_history=novelty_history)
        api_val = result["API"]

        cooled = (tick - last_action_tick) >= cooldown
        action = None
        if api_val > action_threshold and cooled:
            action = "sociability"
            last_action_tick = tick
            rec["action_ticks"].append(tick)
            G.set_node_attr("ch_0", "unread", 0)
            G.set_node_attr("ch_0", "pending_directed", 0.0)
            G.set_node_attr("ct_0", "last_active", tick)
            for iid in G.get_entities_by_type(NodeType.INFO_ITEM):
                G.set_node_attr(iid, "last_access", tick)
                G.set_node_attr(iid, "created", tick)
            novelty_history.append(0.7)

        rec["ticks"].append(tick)
        rec["API"].append(api_val)
        rec["actions"].append(action)

    return rec


def run_exp3_no_social_cost(n_ticks: int = 500) -> dict:
    """验证撤除社交代价后行动频率爆炸。

    模拟 D5 的效果：
    - 有 D5 → 高阈值 (2.5) + cooldown (5)：行动有代价
    - 无 D5 → 极低阈值 (0.01) + 无 cooldown：行动无代价
    """
    print("\n" + "=" * 60)
    print("实验 3: 撤除 D5 (C_social = 0)")
    print("=" * 60)

    rec_normal = _run_single_with_params(n_ticks, action_threshold=2.5,
                                          cooldown=5, msg_interval=30)
    rec_no_cost = _run_single_with_params(n_ticks, action_threshold=0.01,
                                           cooldown=0, msg_interval=30)

    n_normal = len(rec_normal["action_ticks"])
    n_no_cost = len(rec_no_cost["action_ticks"])
    rate_normal = n_normal / n_ticks
    rate_no_cost = n_no_cost / n_ticks

    print(f"  正常 (有 D5): {n_normal} 次行动, 频率 {rate_normal:.3f}")
    print(f"  无 D5:        {n_no_cost} 次行动, 频率 {rate_no_cost:.3f}")
    print(f"  频率比: {rate_no_cost / max(rate_normal, 0.001):.1f}x")
    print(f"  行为发散: {'✓' if rate_no_cost > 3 * rate_normal else '✗'}")

    return {
        "normal": rec_normal,
        "no_cost": rec_no_cost,
        "rate_normal": rate_normal,
        "rate_no_cost": rate_no_cost,
        "n_ticks": n_ticks,
    }


def plot_exp3(records: dict, output_path: str) -> None:
    """绘制实验 3 结果。"""
    fig, axes = plt.subplots(2, 1, figsize=(12, 7))

    n_ticks = records["n_ticks"]
    window = 20

    for ax_idx, (key, label, color) in enumerate([
        ("normal", f"With D5 (rate={records['rate_normal']:.3f})", "#1565c0"),
        ("no_cost", f"Without D5 (rate={records['rate_no_cost']:.3f})", "#c62828"),
    ]):
        ax = axes[ax_idx]
        rec = records[key]
        ticks = np.array(rec["ticks"])
        api = np.array(rec["API"])

        ax.plot(ticks, api, color=color, linewidth=0.6, alpha=0.7, label="API")

        # 行动密度
        action_flags = np.array([1 if a is not None else 0 for a in rec["actions"]])
        density = np.convolve(action_flags, np.ones(window) / window, mode="same")
        ax2 = ax.twinx()
        ax2.fill_between(ticks, 0, density, color="#ff9800", alpha=0.3, label="Action density")
        ax2.set_ylabel("Action density", color="#ff9800")
        ax2.set_ylim(0, 1.1)

        ax.set_title(label)
        ax.set_ylabel("API")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="upper left", fontsize=8)
        ax2.legend(loc="upper right", fontsize=8)

    axes[1].set_xlabel("Agent tick $n$")

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


# ===========================================================================
# 实验 4: 稳定性条件违反（骚扰螺旋）
# ===========================================================================

def run_exp4_instability(n_ticks: int = 300) -> dict:
    """违反稳定性条件：行动创造的压力 > 释放的压力。

    理论预测：
    - 稳定情形：行动释放压力 → API 下降 → 稳定锯齿波
    - 不稳定情形：行动增加 unread + pending_directed → API 持续上升

    实现：行动后 unread += 3, pending_directed += 2（模拟 ADR-56 骚扰螺旋）。
    """
    print("\n" + "=" * 60)
    print("实验 4: 稳定性条件违反（骚扰螺旋）")
    print("=" * 60)

    kappa = np.array([5.0, 8.0, 8.0, 200.0, 3.0, 0.5])

    # --- 稳定情形 ---
    rec_stable = _run_single_with_params(n_ticks, action_threshold=2.0,
                                          cooldown=3, msg_interval=40)

    # --- 不稳定情形 ---
    G = _make_single_contact_graph(tier=15, chat_type="private")
    novelty_history: list[float] = []
    last_action_tick = -3

    rec_unstable = {
        "ticks": [], "API": [], "actions": [], "action_ticks": [],
        "P1": [], "P3": [], "P5": [],
    }

    for tick in range(1, n_ticks + 1):
        G.tick = tick
        novelty_history.append(0.1)

        if tick % 40 == 0:
            old_unread = G.node_attrs("ch_0").get("unread", 0)
            G.set_node_attr("ch_0", "unread", old_unread + 1)
            G.set_node_attr("ct_0", "last_active", tick)

        result = compute_all_pressures(G, tick, kappa=kappa,
                                       novelty_history=novelty_history)
        api_val = result["API"]

        cooled = (tick - last_action_tick) >= 3
        action = None
        if api_val > 2.0 and cooled:
            action = "sociability"
            last_action_tick = tick
            rec_unstable["action_ticks"].append(tick)

            # 病态：行动增加压力
            old_unread = G.node_attrs("ch_0").get("unread", 0)
            G.set_node_attr("ch_0", "unread", old_unread + 3)
            old_dir = G.node_attrs("ch_0").get("pending_directed", 0.0)
            G.set_node_attr("ch_0", "pending_directed", old_dir + 2.0)
            G.set_node_attr("ch_0", "last_directed_tick", tick)
            # last_active 更新（P3 暂降，但 P1+P5 增长更多）
            G.set_node_attr("ct_0", "last_active", tick)

        rec_unstable["ticks"].append(tick)
        rec_unstable["API"].append(api_val)
        rec_unstable["actions"].append(action)
        rec_unstable["P1"].append(result["P1"])
        rec_unstable["P3"].append(result["P3"])
        rec_unstable["P5"].append(result["P5"])

    # 分析
    n_stable = len(rec_stable["action_ticks"])
    n_unstable = len(rec_unstable["action_ticks"])
    api_stable_final = np.mean(rec_stable["API"][-50:])
    api_unstable_final = np.mean(rec_unstable["API"][-50:])

    print(f"  稳定: {n_stable} 次行动, 末 50 tick 平均 API={api_stable_final:.3f}")
    print(f"  不稳定: {n_unstable} 次行动, 末 50 tick 平均 API={api_unstable_final:.3f}")
    print(f"  API 发散比: {api_unstable_final / max(api_stable_final, 0.001):.1f}x")
    print(f"  正反馈螺旋: {'✓' if api_unstable_final > 1.5 * api_stable_final else '✗'}")

    return {
        "stable": rec_stable,
        "unstable": rec_unstable,
        "n_ticks": n_ticks,
    }


def plot_exp4(records: dict, output_path: str) -> None:
    """绘制实验 4 结果。"""
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)

    # (a) API 对比
    ax = axes[0]
    ticks_s = np.array(records["stable"]["ticks"])
    ticks_u = np.array(records["unstable"]["ticks"])
    ax.plot(ticks_s, records["stable"]["API"], color="#1565c0",
            linewidth=0.8, label="Stable (action releases pressure)")
    ax.plot(ticks_u, records["unstable"]["API"], color="#c62828",
            linewidth=0.8, label="Unstable (action increases pressure)")
    ax.set_ylabel("API")
    ax.set_title("Exp 4: Stability condition violation — harassment spiral")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # (b) 不稳定情形的 P1 + P5 发散
    ax = axes[1]
    ax.plot(ticks_u, records["unstable"]["P1"], color="#e65100",
            linewidth=0.7, label="P1 (attention debt)")
    ax.plot(ticks_u, records["unstable"]["P5"], color="#6a1b9a",
            linewidth=0.7, label="P5 (response obligation)")
    ax.plot(ticks_u, records["unstable"]["P3"], color="#2e7d32",
            linewidth=0.7, label="P3 (relationship cooling)")
    for at in records["unstable"]["action_ticks"]:
        ax.axvline(at, color="#c62828", alpha=0.15, linewidth=0.5)
    ax.set_xlabel("Agent tick $n$")
    ax.set_ylabel("Raw pressure")
    ax.set_title("Unstable case: pressure decomposition (P1, P5 diverge)")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


# ===========================================================================
# 实验 5: 人格漂移下轨道变形
# ===========================================================================

def run_exp5_personality_drift(n_ticks: int = 800) -> dict:
    """验证人格向量 π 漂移导致行为模式变化。

    设计：使用声部竞争选择行动，人格向量每 200 ticks 急剧偏移。
    用较低阈值确保有足够行动样本来观察分布变化。

    理论预测：
    - π_S 增大 → sociability 胜出更多 → P3 驱动行动增加
    - π_X 增大 → caution 胜出更多 → 行动频率下降（等待为主）
    - π_D 增大 → diligence 胜出更多 → 注意力导向行动
    - 不同阶段的行动类型分布应显著不同
    """
    print("\n" + "=" * 60)
    print("实验 5: 人格漂移下轨道变形")
    print("=" * 60)

    G = _make_single_contact_graph(tier=15, chat_type="private")
    kappa = np.array([5.0, 8.0, 8.0, 200.0, 3.0, 0.5])
    rng = np.random.default_rng(42)
    pi = np.array([0.2, 0.2, 0.2, 0.2, 0.2])
    personality = PersonalityVector(weights=pi.copy())
    novelty_history: list[float] = []
    event_count_history: list[int] = []
    last_action_tick = -5
    action_threshold = 2.0

    records = {
        "ticks": [], "API": [], "actions": [], "action_ticks": [],
        "action_types": [],
        "personality_trace": [],
        "drift_events": [],
    }

    # 漂移计划
    drift_schedule = [
        (200, np.array([0.15, 0.15, 0.45, 0.10, 0.15]), "↑S (sociability)"),
        (400, np.array([0.10, 0.10, 0.10, 0.55, 0.15]), "↑X (caution)"),
        (600, np.array([0.45, 0.15, 0.10, 0.15, 0.15]), "↑D (diligence)"),
    ]

    for tick in range(1, n_ticks + 1):
        G.tick = tick

        # 人格漂移
        for drift_tick, target_pi, desc in drift_schedule:
            if tick == drift_tick:
                personality = PersonalityVector(weights=target_pi.copy())
                records["drift_events"].append((tick, desc))
                print(f"  tick {tick}: 人格漂移 → {desc}")

        # 对方消息
        if tick % 25 == 0:
            old_unread = G.node_attrs("ch_0").get("unread", 0)
            G.set_node_attr("ch_0", "unread", old_unread + 1)
            G.set_node_attr("ct_0", "last_active", tick)
            old_dir = G.node_attrs("ch_0").get("pending_directed", 0.0)
            G.set_node_attr("ch_0", "pending_directed", old_dir + 0.8)
            G.set_node_attr("ch_0", "last_directed_tick", tick)
            novelty_history.append(0.5)
            event_count_history.append(1)
        else:
            novelty_history.append(0.0)
            event_count_history.append(0)

        result = compute_all_pressures(G, tick, kappa=kappa,
                                       novelty_history=novelty_history)
        api_val = result["API"]

        cooled = (tick - last_action_tick) >= 3
        action = None
        if api_val > action_threshold and cooled:
            loudness = compute_loudness(
                G, tick, personality,
                novelty_history=novelty_history,
                recent_event_counts=event_count_history,
                rng=rng, kappa_p=kappa,
            )
            winner_idx, action = select_action(loudness, rng=rng)
            last_action_tick = tick
            records["action_ticks"].append(tick)
            records["action_types"].append(action)

            # 释放压力（不管行动类型都释放一些）
            if action in ("diligence", "sociability"):
                G.set_node_attr("ch_0", "unread", 0)
                G.set_node_attr("ch_0", "pending_directed", 0.0)
                G.set_node_attr("ct_0", "last_active", tick)
            elif action == "curiosity":
                for iid in G.get_entities_by_type(NodeType.INFO_ITEM):
                    G.set_node_attr(iid, "created", tick)
                    G.set_node_attr(iid, "last_access", tick)
            elif action == "reflection":
                for iid in G.get_entities_by_type(NodeType.INFO_ITEM):
                    G.set_node_attr(iid, "last_access", tick)
            # caution: 不释放压力
            novelty_history.append(0.7)

        records["ticks"].append(tick)
        records["API"].append(api_val)
        records["actions"].append(action)
        records["personality_trace"].append(personality.weights.copy())

    # 分析：按阶段统计行动频率和类型分布
    phases = [(1, 200), (201, 400), (401, 600), (601, n_ticks)]
    phase_names = ["Balanced", "↑Sociability", "↑Caution", "↑Diligence"]
    phase_stats = []
    for (start, end), name in zip(phases, phase_names):
        phase_actions = [(t, a) for t, a in zip(records["action_ticks"], records["action_types"])
                         if start <= t <= end]
        n_act = len(phase_actions)
        rate = n_act / (end - start + 1)
        # 类型分布
        type_counts: dict[str, int] = {}
        for _, a in phase_actions:
            type_counts[a] = type_counts.get(a, 0) + 1
        dist_str = ", ".join(f"{k}={v}" for k, v in sorted(type_counts.items()))
        print(f"  {name} (tick {start}-{end}): "
              f"{n_act} 次行动 (rate={rate:.3f}), 分布: {dist_str}")
        phase_stats.append({
            "name": name, "start": start, "end": end,
            "n_actions": n_act, "rate": rate, "type_counts": type_counts,
        })

    records["phase_stats"] = phase_stats
    return records


def plot_exp5(records: dict, output_path: str) -> None:
    """绘制实验 5 结果。"""
    fig, axes = plt.subplots(3, 1, figsize=(12, 10), sharex=True)

    ticks = np.array(records["ticks"])
    api = np.array(records["API"])
    pi_trace = np.array(records["personality_trace"])

    # (a) API 轨迹 + 漂移标记
    ax = axes[0]
    ax.plot(ticks, api, color="#1565c0", linewidth=0.7, label="API")
    for at in records["action_ticks"]:
        ax.axvline(at, color="#e65100", alpha=0.12, linewidth=0.5)
    for drift_tick, desc in records["drift_events"]:
        ax.axvline(drift_tick, color="#c62828", linewidth=2, linestyle="--")
        ax.annotate(desc, (drift_tick + 5, api.max() * 0.92),
                   fontsize=8, color="#c62828",
                   bbox=dict(boxstyle="round,pad=0.3", facecolor="white", alpha=0.8))
    ax.set_ylabel("API")
    ax.set_title("Exp 5: Personality drift → behavior pattern change")
    ax.grid(True, alpha=0.3)

    # (b) 人格向量演化
    ax = axes[1]
    voice_colors = ["#1565c0", "#2e7d32", "#e65100", "#6a1b9a", "#00838f"]
    for i, (name, color) in enumerate(zip(VOICE_SHORT, voice_colors)):
        ax.plot(ticks, pi_trace[:, i], color=color, linewidth=1.2,
                label=f"$\\pi_{{{name}}}$")
    for drift_tick, _ in records["drift_events"]:
        ax.axvline(drift_tick, color="#c62828", linewidth=1.5, linestyle="--", alpha=0.5)
    ax.set_ylabel("$\\pi_i$ weight")
    ax.set_title("Personality vector $\\pi$")
    ax.legend(fontsize=7, ncol=5)
    ax.grid(True, alpha=0.3)

    # (c) 行动类型时间序列
    ax = axes[2]
    action_type_map = {"diligence": 0, "curiosity": 1, "sociability": 2, "caution": 3, "reflection": 4}
    action_colors = {"diligence": "#1565c0", "curiosity": "#2e7d32",
                     "sociability": "#e65100", "caution": "#6a1b9a", "reflection": "#00838f"}
    for at, atype in zip(records["action_ticks"], records["action_types"]):
        y = action_type_map[atype]
        ax.scatter(at, y, color=action_colors[atype], s=8, alpha=0.6)
    for drift_tick, _ in records["drift_events"]:
        ax.axvline(drift_tick, color="#c62828", linewidth=1.5, linestyle="--", alpha=0.5)
    ax.set_yticks(range(5))
    ax.set_yticklabels(["D", "C", "S", "X", "R"])
    ax.set_xlabel("Agent tick $n$")
    ax.set_ylabel("Winning voice")
    ax.set_title("Action type over time (each dot = one action)")
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


# ===========================================================================
# 主入口
# ===========================================================================

def run_all() -> dict:
    """运行全部五个实验并保存图表。"""
    fig_dir = os.path.join(os.path.dirname(__file__), "figures")
    os.makedirs(fig_dir, exist_ok=True)

    results = {}

    r1 = run_exp1_single_contact_cycle(n_ticks=500)
    plot_exp1(r1, os.path.join(fig_dir, "p1_exp1_idle_action_cycle.png"))
    results["exp1"] = r1

    r2 = run_exp2_multi_tier(n_ticks=1000)
    plot_exp2(r2, os.path.join(fig_dir, "p1_exp2_multi_tier.png"))
    results["exp2"] = r2

    r3 = run_exp3_no_social_cost(n_ticks=500)
    plot_exp3(r3, os.path.join(fig_dir, "p1_exp3_no_social_cost.png"))
    results["exp3"] = r3

    r4 = run_exp4_instability(n_ticks=300)
    plot_exp4(r4, os.path.join(fig_dir, "p1_exp4_instability.png"))
    results["exp4"] = r4

    r5 = run_exp5_personality_drift(n_ticks=800)
    plot_exp5(r5, os.path.join(fig_dir, "p1_exp5_personality_drift.png"))
    results["exp5"] = r5

    return results


if __name__ == "__main__":
    run_all()

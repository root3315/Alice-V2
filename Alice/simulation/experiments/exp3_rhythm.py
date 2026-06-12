"""实验 3：涌现节律验证。

运行完整模拟（压力场演化 + 行动执行 + 压力释放），
绘制 API(n) 随时间的变化，验证自然涌现的振荡节律：
  积累 → 阈值 → 行动 → 释放 → 重新积累

理论依据（论文 §3.4 性质 1~3）：
- 性质 1（空闲非平衡）：有活跃线程/联系人时 API 严格递增
- 性质 2（负反馈稳定）：声部竞争涌现负反馈 + P6 自动降低
- 性质 3（行动释放）：行动后相关压力归零/大幅降低
三者共同保证自然节律。

v4: API 为 tanh 归一化值 ∈ [0, 6)，阈值相应调整。
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import CompanionGraph, NodeType, random_companion_graph
from pressure import compute_all_pressures, observable_mapping
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    VOICE_ACTIONS,
)


# ---------------------------------------------------------------------------
# 行动执行与压力释放
# ---------------------------------------------------------------------------

def execute_action(G: CompanionGraph, action_type: str, n: int, rng: np.random.Generator) -> None:
    """执行行动并释放相应压力。

    根据获胜声部类型修改图状态，模拟压力释放。

    Parameters
    ----------
    G : CompanionGraph
        社交图。
    action_type : str
        行动类型（diligence, curiosity, sociability, caution, reflection）。
    n : int
        当前 tick。
    rng : np.random.Generator
        随机数生成器。
    """
    if action_type == "diligence":
        # 处理一个 open 线程：将最老的标记为 resolved
        threads = G.get_entities_by_type(NodeType.THREAD)
        open_threads = [
            tid for tid in threads
            if G.node_attrs(tid).get("status") == "open"
        ]
        if open_threads:
            # 选择最老的线程
            oldest = min(open_threads, key=lambda t: G.node_attrs(t).get("created", 0))
            G.set_node_attr(oldest, "status", "resolved")
        # 处理部分 unread 消息
        channels = G.get_entities_by_type(NodeType.CHANNEL)
        for hid in channels:
            unread = G.node_attrs(hid).get("unread", 0)
            if unread > 0:
                G.set_node_attr(hid, "unread", max(0, unread - int(rng.integers(1, max(unread, 2) + 1))))
                break  # 每次只处理一个频道

    elif action_type == "curiosity":
        # 探索：更新部分 InfoItem 的时效
        items = G.get_entities_by_type(NodeType.INFO_ITEM)
        tracked = [iid for iid in items if G.node_attrs(iid).get("tracked", False)]
        if tracked:
            # 更新一个 tracked 信息项
            target = tracked[int(rng.integers(0, len(tracked)))]
            G.set_node_attr(target, "created", n)  # 重置 age

    elif action_type == "sociability":
        # 社交：更新一个联系人的 last_active
        contacts = G.get_entities_by_type(NodeType.CONTACT)
        if contacts:
            target = contacts[int(rng.integers(0, len(contacts)))]
            G.set_node_attr(target, "last_active", n)

    elif action_type == "caution":
        # 谨慎：不做任何事（等待）
        pass

    elif action_type == "reflection":
        # 回顾：巩固记忆（更新 InfoItem 的 last_access 和 stability）
        items = G.get_entities_by_type(NodeType.INFO_ITEM)
        if items:
            # 选择重要性最高且 last_access 最旧的
            sorted_items = sorted(
                items,
                key=lambda iid: (
                    -G.node_attrs(iid).get("importance", 0),
                    G.node_attrs(iid).get("last_access", 0),
                ),
            )
            target = sorted_items[0]
            attrs = G.node_attrs(target)
            G.set_node_attr(target, "last_access", n)
            # 稳定性增长
            old_s = attrs.get("stability", 1.0)
            G.set_node_attr(target, "stability", old_s * 1.2)


# ---------------------------------------------------------------------------
# 实验逻辑
# ---------------------------------------------------------------------------

def run_exp3(
    n_trials: int = 50,
    n_steps: int = 200,
    action_threshold: float = 2.5,
    seed_base: int = 3000,
) -> dict:
    """运行实验 3：涌现节律验证。

    Parameters
    ----------
    n_trials : int
        独立试验次数。
    n_steps : int
        每次试验的 tick 步数。
    action_threshold : float
        API 超过此阈值时触发行动。
    seed_base : int
        随机种子基数。

    Returns
    -------
    dict
        包含 API 轨迹、行动事件等。
    """
    api_matrix = np.zeros((n_trials, n_steps))
    a_matrix = np.zeros((n_trials, n_steps))  # 可观察映射 A(n)
    action_events: list[list[tuple[int, str]]] = []  # 每次试验的行动事件列表

    personality = PersonalityVector(weights=np.array([0.25, 0.2, 0.2, 0.15, 0.2]))

    for trial in range(n_trials):
        seed = seed_base + trial
        rng = np.random.default_rng(seed)

        G = random_companion_graph(
            n_contacts=15,
            n_threads=8,
            n_channels=4,
            n_info_items=10,
            seed=seed,
        )

        # P6 novelty_history：初始化为空，由事件驱动填充真实 novelty
        novelty_history: list[float] = []
        event_count_history: list[int] = []
        trial_actions: list[tuple[int, str]] = []

        for step in range(1, n_steps + 1):
            G.tick = step
            n_events_this_tick = 0
            # 本 tick 的事件 novelty（在压力计算前计算并 append）
            tick_novelty = 0.0

            # 以小概率产生新的未读消息和新线程（模拟外部事件）
            if rng.random() < 0.1:
                channels = G.get_entities_by_type(NodeType.CHANNEL)
                if channels:
                    hid = channels[int(rng.integers(0, len(channels)))]
                    n_new = int(rng.integers(1, 5))
                    old_unread = G.node_attrs(hid).get("unread", 0)
                    G.set_node_attr(hid, "unread", old_unread + n_new)
                    n_events_this_tick += 1
                    # 新消息 novelty：基础 0.3，多条消息不额外加
                    tick_novelty = 0.3

            if rng.random() < 0.03:
                # 新开一个线程
                tid = f"thread_new_{trial}_{step}"
                G.add_entity(
                    NodeType.THREAD, tid,
                    status="open",
                    weight="minor",
                    created=step,
                    deadline=float("inf"),
                )
                # 新线程也带来一点 novelty
                tick_novelty = max(tick_novelty, 0.3)

            event_count_history.append(n_events_this_tick)

            # 在压力计算前 append 事件 novelty
            # 无事件 tick → novelty=0（好奇心上升），有事件 → novelty≥0.3（好奇心被部分满足）
            novelty_history.append(tick_novelty)

            # 计算压力
            result = compute_all_pressures(
                G, step,
                novelty_history=novelty_history,
                thread_age_scale=1440.0,
            )
            api_val = result["API"]
            a_val = result["A"]

            # 决策：API 超过阈值时触发行动
            if api_val > action_threshold:
                loudness = compute_loudness(
                    G, step, personality,
                    novelty_history=novelty_history,
                    recent_event_counts=event_count_history,
                    rng=rng,
                )
                winner_idx, action_type = select_action(loudness, rng=rng)
                execute_action(G, action_type, step, rng)
                trial_actions.append((step, action_type))

                # 行动本身带来高 novelty，影响下一 tick 的 P6
                novelty_history.append(0.7)

            api_matrix[trial, step - 1] = api_val
            a_matrix[trial, step - 1] = a_val

        action_events.append(trial_actions)

    # 统计节律特征
    mean_api = api_matrix.mean(axis=0)

    # 检测振荡：计算零交叉（相对于均值的）
    centered = mean_api - mean_api.mean()
    crossings = np.sum(np.diff(np.sign(centered)) != 0)
    print(f"  均值 API 的零交叉次数: {crossings}")

    # 计算平均行动间隔
    all_intervals: list[float] = []
    for events in action_events:
        steps_only = [e[0] for e in events]
        if len(steps_only) > 1:
            intervals = np.diff(steps_only)
            all_intervals.extend(intervals.tolist())

    if all_intervals:
        mean_interval = np.mean(all_intervals)
        std_interval = np.std(all_intervals)
        print(f"  平均行动间隔: {mean_interval:.1f} ± {std_interval:.1f} ticks")
    else:
        mean_interval = 0.0
        std_interval = 0.0
        print("  未检测到行动事件")

    # 行动类型分布
    all_action_types: dict[str, int] = {}
    for events in action_events:
        for _, atype in events:
            all_action_types[atype] = all_action_types.get(atype, 0) + 1
    total_actions = sum(all_action_types.values())
    if total_actions > 0:
        print("  行动类型分布:")
        for atype, count in sorted(all_action_types.items(), key=lambda x: -x[1]):
            print(f"    {atype}: {count} ({count/total_actions*100:.1f}%)")

    return {
        "api_matrix": api_matrix,
        "a_matrix": a_matrix,
        "action_events": action_events,
        "mean_api": mean_api,
        "mean_interval": mean_interval,
        "std_interval": std_interval,
        "crossings": crossings,
    }


def plot_exp3(results: dict, output_path: str) -> None:
    """绘制实验 3 结果。"""
    fig, axes = plt.subplots(2, 1, figsize=(10, 6), height_ratios=[2, 1])

    n_steps = results["api_matrix"].shape[1]
    x = np.arange(1, n_steps + 1)

    # (a) API 轨迹（3 条单次试验 + 均值）
    ax = axes[0]
    # 绘制 3 条单次试验的 API 轨迹（浅色）
    for trial_idx in range(min(3, results["api_matrix"].shape[0])):
        ax.plot(x, results["api_matrix"][trial_idx], color="#90caf9",
                linewidth=0.5, alpha=0.5)

    # 均值轨迹（深色）
    mean_api = results["mean_api"]
    std_api = results["api_matrix"].std(axis=0)
    ax.plot(x, mean_api, color="#1565c0", linewidth=1.5, label="API mean")
    ax.fill_between(x, mean_api - std_api, mean_api + std_api,
                     color="#1565c0", alpha=0.1)

    # 标注行动事件（第一条试验）
    if results["action_events"]:
        events = results["action_events"][0]
        action_steps = [e[0] for e in events]
        action_apis = [results["api_matrix"][0, s - 1] for s in action_steps]
        ax.scatter(action_steps, action_apis, color="#d32f2f", s=15, zorder=5,
                   marker="v", label="Actions (trial 0)")

    ax.set_ylabel("API$(n)$")
    ax.set_title("(a) Emergent rhythm: pressure accumulation and release")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # (b) 可观察映射 A(n)
    ax = axes[1]
    mean_a = results["a_matrix"].mean(axis=0)
    ax.plot(x, mean_a, color="#2e7d32", linewidth=1.5, label="$A(n) = A_{\\max} \\tanh(\\mathrm{API}/\\kappa)$")
    ax.set_xlabel("Agent tick $n$")
    ax.set_ylabel("$A(n)$")
    ax.set_title("(b) Observable activity mapping")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


if __name__ == "__main__":
    print("实验 3：涌现节律验证")
    results = run_exp3(n_trials=50, n_steps=200)
    os.makedirs("../paper/figures", exist_ok=True)
    plot_exp3(results, "../paper/figures/exp3_rhythm.pdf")

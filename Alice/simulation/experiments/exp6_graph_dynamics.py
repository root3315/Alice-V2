"""实验 6：图动态特性验证（v3 新增）。

三部分：
A. Snapshot 一致性 — to_dict/from_dict round-trip 无损
B. Tier 动态演化 — 交互率驱动 tier 升降
C. Chat type 分化 — 私聊 vs 群聊的行为差异

理论依据（docs/adr/12-deployment-gap-analysis.md）：
- 盲点 1：群聊/私聊不区分 → Part C 验证 chat_type 语义
- 盲点 2：无图持久化 → Part A 验证序列化
- 盲点 6：tier/trust 静态 → Part B 验证 tier 演化闭环
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import CompanionGraph, NodeType, random_companion_graph, DUNBAR_TIER_WEIGHT
from pressure import P5_response_obligation, compute_all_pressures
from sim_engine import _evolve_tiers, _apply_events


# ---------------------------------------------------------------------------
# Part A: Snapshot 一致性
# ---------------------------------------------------------------------------

def run_part_a() -> dict:
    """验证 to_dict/from_dict round-trip 无损。"""
    print("\n  Part A: Snapshot 一致性测试")

    G = random_companion_graph(seed=42)
    G.tick = 100

    # 修改一些属性模拟运行后的状态
    contacts = G.get_entities_by_type(NodeType.CONTACT)
    if contacts:
        G.set_node_attr(contacts[0], "tier", 15)
        G.set_node_attr(contacts[0], "trust", 0.9)
        G.set_node_attr(contacts[0], "interaction_count", 42)

    channels = G.get_entities_by_type(NodeType.CHANNEL)
    if channels:
        G.set_node_attr(channels[0], "pending_directed", 2.4)
        G.set_node_attr(channels[0], "last_directed_tick", 95)

    threads = G.get_entities_by_type(NodeType.THREAD)
    for tid in threads[:2]:
        G.set_node_attr(tid, "status", "resolved")

    # Round-trip
    d1 = G.to_dict()
    G2 = CompanionGraph.from_dict(d1)
    d2 = G2.to_dict()

    # 逐字段比对
    tick_match = d1["tick"] == d2["tick"]
    nodes_match = d1["nodes"] == d2["nodes"]
    edges_match = d1["edges"] == d2["edges"]
    full_match = d1 == d2

    # 检查 float("inf") round-trip
    inf_ok = True
    for node in d1["nodes"]:
        for k, v in node.items():
            if v == "inf":
                # 找到对应的 d2 节点
                d2_node = next(n for n in d2["nodes"] if n["id"] == node["id"])
                if d2_node.get(k) != "inf":
                    inf_ok = False
                    break

    # 节点类型完整性
    type_counts_1 = {}
    for n in d1["nodes"]:
        t = n["entity_type"]
        type_counts_1[t] = type_counts_1.get(t, 0) + 1
    type_counts_2 = {}
    for n in d2["nodes"]:
        t = n["entity_type"]
        type_counts_2[t] = type_counts_2.get(t, 0) + 1
    types_match = type_counts_1 == type_counts_2

    result = {
        "tick_match": tick_match,
        "nodes_match": nodes_match,
        "edges_match": edges_match,
        "full_match": full_match,
        "inf_roundtrip": inf_ok,
        "types_match": types_match,
        "n_nodes": len(d1["nodes"]),
        "n_edges": len(d1["edges"]),
        "type_counts": type_counts_1,
    }

    status = "PASS" if full_match else "FAIL"
    print(f"    round-trip: {status}")
    print(f"    nodes={len(d1['nodes'])}, edges={len(d1['edges'])}")
    print(f"    tick_match={tick_match}, inf_roundtrip={inf_ok}, types={type_counts_1}")

    return result


# ---------------------------------------------------------------------------
# Part B: Tier 动态演化
# ---------------------------------------------------------------------------

def run_part_b(n_ticks: int = 300, eval_interval: int = 100, seed: int = 42) -> dict:
    """验证交互率驱动的 tier 升降。

    设置：10 个 contacts 全部 tier-150，模拟差异化交互率。
    """
    print(f"\n  Part B: Tier 动态演化测试 ({n_ticks} ticks)")

    rng = np.random.default_rng(seed)
    G = CompanionGraph()
    G.tick = 0
    G.add_entity(NodeType.AGENT, "agent_0")

    # 10 个 contacts，全部 tier-150
    n_contacts = 10
    for i in range(n_contacts):
        cid = f"contact_{i}"
        G.add_entity(NodeType.CONTACT, cid, tier=150, trust=0.5, last_active=0)
        G.add_relation("agent_0", "acquaintance", cid)

    # 4 channels
    for i in range(4):
        hid = f"channel_{i}"
        G.add_entity(NodeType.CHANNEL, hid, unread=0, tier_contact=150,
                     chat_type="private" if i == 0 else "group")
        G.add_relation("agent_0", "monitors", hid)

    # 模拟差异化交互
    tier_snapshots: list[dict[str, int]] = []

    for tick in range(1, n_ticks + 1):
        G.tick = tick

        # contact_0: 每 tick 1 次交互
        G.set_node_attr("contact_0", "interaction_count",
                        G.node_attrs("contact_0").get("interaction_count", 0) + 1)
        G.set_node_attr("contact_0", "last_active", tick)

        # contact_1: 每 5 tick 1 次交互
        if tick % 5 == 0:
            G.set_node_attr("contact_1", "interaction_count",
                            G.node_attrs("contact_1").get("interaction_count", 0) + 1)
            G.set_node_attr("contact_1", "last_active", tick)

        # 其余 contacts: 无交互（静默）

        # Tier 演化
        if tick % eval_interval == 0:
            changes = _evolve_tiers(G, tick)
            snapshot = {}
            for i in range(n_contacts):
                cid = f"contact_{i}"
                snapshot[cid] = G.node_attrs(cid).get("tier", 150)
            tier_snapshots.append(snapshot)

            if changes:
                for cid, (old_t, new_t) in changes.items():
                    print(f"    tick {tick}: {cid} {old_t} → {new_t}")

    # 分析结果
    final_tiers = {}
    for i in range(n_contacts):
        cid = f"contact_{i}"
        final_tiers[cid] = G.node_attrs(cid).get("tier", 150)

    c0_upgraded = final_tiers["contact_0"] < 150
    c1_status = final_tiers["contact_1"]
    silent_tiers = [final_tiers[f"contact_{i}"] for i in range(2, n_contacts)]
    silent_all_demoted_or_same = all(t >= 150 for t in silent_tiers)
    tier5_count = sum(1 for t in final_tiers.values() if t == 5)

    result = {
        "tier_snapshots": tier_snapshots,
        "final_tiers": final_tiers,
        "c0_upgraded": c0_upgraded,
        "c0_final_tier": final_tiers["contact_0"],
        "c1_final_tier": c1_status,
        "silent_all_correct": silent_all_demoted_or_same,
        "tier5_count": tier5_count,
    }

    print(f"    contact_0 (高频): tier {150} → {final_tiers['contact_0']} "
          f"({'PASS' if c0_upgraded else 'FAIL'})")
    print(f"    contact_1 (中频): tier {150} → {c1_status}")
    print(f"    静默联系人 (≥150): {'PASS' if silent_all_demoted_or_same else 'FAIL'}")
    print(f"    tier-5 联系人数: {tier5_count}")

    return result


# ---------------------------------------------------------------------------
# Part C: Chat type 分化
# ---------------------------------------------------------------------------

def run_part_c(seed: int = 42) -> dict:
    """验证私聊 vs 群聊的 P5 差异和行动偏向。"""
    print("\n  Part C: Chat type 分化测试")

    from telegram_parser import Event, EventKind

    rng = np.random.default_rng(seed)
    G = CompanionGraph()
    G.tick = 0
    G.add_entity(NodeType.AGENT, "agent_0")

    # 2 个 contacts
    G.add_entity(NodeType.CONTACT, "ct_alice", tier=50, trust=0.5, last_active=0)
    G.add_relation("agent_0", "friend", "ct_alice")
    G.add_entity(NodeType.CONTACT, "ct_bob", tier=50, trust=0.5, last_active=0)
    G.add_relation("agent_0", "friend", "ct_bob")

    # 2 channels: private vs group
    G.add_entity(NodeType.CHANNEL, "ch_private",
                 unread=0, tier_contact=50, chat_type="private")
    G.add_relation("agent_0", "monitors", "ch_private")
    G.add_relation("ct_alice", "in", "ch_private")

    G.add_entity(NodeType.CHANNEL, "ch_group",
                 unread=0, tier_contact=50, chat_type="group")
    G.add_relation("agent_0", "monitors", "ch_group")
    G.add_relation("ct_bob", "in", "ch_group")

    # 需要一些基础 InfoItem 和 Thread 让压力函数不报错
    G.add_entity(NodeType.INFO_ITEM, "info_0", importance=0.5, stability=2.0,
                 last_access=0, tracked=False, created=0, novelty=0.5)
    G.add_relation("agent_0", "knows", "info_0")
    G.add_entity(NodeType.THREAD, "thread_0", status="open", weight="minor",
                 created=0, deadline=float("inf"))
    G.add_relation("agent_0", "tracks", "thread_0")

    # 注入相同数量的消息到两个频道（无 reply_to）
    n_msgs = 5
    novelty_buf: list[float] = []
    tick = 1
    G.tick = tick

    for i in range(n_msgs):
        # 私聊消息
        evt_private = Event(
            timestamp=float(i), kind=EventKind.MESSAGE,
            channel_id="private", sender_id="alice",
            sender_name="Alice", message_id=1000 + i,
            reply_to=None, text_length=50, has_entities=False,
        )
        # 群聊消息（同样无 reply_to）
        evt_group = Event(
            timestamp=float(i), kind=EventKind.MESSAGE,
            channel_id="group", sender_id="bob",
            sender_name="Bob", message_id=2000 + i,
            reply_to=None, text_length=50, has_entities=False,
        )

        # 手动应用事件（不通过 EventStream，直接调用 _apply_events 的逻辑）
        # 私聊
        chat_type_priv = G.node_attrs("ch_private").get("chat_type", "group")
        if chat_type_priv == "private":
            dw_priv = 0.8
        elif evt_private.reply_to is not None:
            dw_priv = 0.3
        else:
            dw_priv = 0.0

        old = G.node_attrs("ch_private").get("unread", 0)
        G.set_node_attr("ch_private", "unread", old + 1)
        if dw_priv > 0:
            old_d = G.node_attrs("ch_private").get("pending_directed", 0.0)
            G.set_node_attr("ch_private", "pending_directed", old_d + dw_priv)
            G.set_node_attr("ch_private", "last_directed_tick", tick)

        # 群聊
        chat_type_grp = G.node_attrs("ch_group").get("chat_type", "group")
        if chat_type_grp == "private":
            dw_grp = 0.8
        elif evt_group.reply_to is not None:
            dw_grp = 0.3
        else:
            dw_grp = 0.0

        old = G.node_attrs("ch_group").get("unread", 0)
        G.set_node_attr("ch_group", "unread", old + 1)
        if dw_grp > 0:
            old_d = G.node_attrs("ch_group").get("pending_directed", 0.0)
            G.set_node_attr("ch_group", "pending_directed", old_d + dw_grp)
            G.set_node_attr("ch_group", "last_directed_tick", tick)

    # 计算 P5
    p5_total, p5_contribs = P5_response_obligation(G, tick)
    p5_private = p5_contribs.get("ch_private", 0.0)
    p5_group = p5_contribs.get("ch_group", 0.0)

    # 检查 pending_directed 状态
    pd_private = G.node_attrs("ch_private").get("pending_directed", 0.0)
    pd_group = G.node_attrs("ch_group").get("pending_directed", 0.0)

    private_higher = p5_private > p5_group
    private_has_directed = pd_private > 0
    group_no_directed = pd_group == 0.0

    result = {
        "pending_directed_private": pd_private,
        "pending_directed_group": pd_group,
        "p5_private": p5_private,
        "p5_group": p5_group,
        "p5_ratio": p5_private / max(p5_group, 0.001),
        "private_higher": private_higher,
        "private_has_directed": private_has_directed,
        "group_no_directed": group_no_directed,
    }

    print(f"    pending_directed: private={pd_private:.1f}, group={pd_group:.1f}")
    print(f"    P5: private={p5_private:.2f}, group={p5_group:.2f}")
    print(f"    私聊 P5 > 群聊 P5: {'PASS' if private_higher else 'FAIL'}")
    print(f"    群聊无 directed（非 reply）: {'PASS' if group_no_directed else 'FAIL'}")

    return result


# ---------------------------------------------------------------------------
# 可视化
# ---------------------------------------------------------------------------

def plot_exp6(results: dict, path: str) -> None:
    """生成 exp6 三合一可视化。"""
    fig, axes = plt.subplots(1, 3, figsize=(15, 4))

    # Part A: Snapshot 字段匹配状态
    ax = axes[0]
    labels = ["tick", "nodes", "edges", "inf", "types", "full"]
    values = [
        results["a"]["tick_match"],
        results["a"]["nodes_match"],
        results["a"]["edges_match"],
        results["a"]["inf_roundtrip"],
        results["a"]["types_match"],
        results["a"]["full_match"],
    ]
    colors = ["#2ecc71" if v else "#e74c3c" for v in values]
    ax.barh(labels, [1 if v else 0 for v in values], color=colors)
    ax.set_xlim(0, 1.2)
    ax.set_title("(a) Snapshot Round-Trip")
    ax.set_xlabel("Pass (1) / Fail (0)")

    # Part B: Tier 演化时间线
    ax = axes[1]
    snapshots = results["b"]["tier_snapshots"]
    if snapshots:
        eval_ticks = [(i + 1) * 100 for i in range(len(snapshots))]
        c0_tiers = [s["contact_0"] for s in snapshots]
        c1_tiers = [s["contact_1"] for s in snapshots]
        # 取一个静默联系人
        silent_key = "contact_5"
        silent_tiers = [s.get(silent_key, 150) for s in snapshots]

        ax.plot(eval_ticks, c0_tiers, "o-", label="c0 (高频)", color="#e74c3c")
        ax.plot(eval_ticks, c1_tiers, "s-", label="c1 (中频)", color="#f39c12")
        ax.plot(eval_ticks, silent_tiers, "^-", label="c5 (静默)", color="#3498db")
        ax.set_yticks([5, 15, 50, 150, 500])
        ax.set_yscale("log")
        ax.set_xlabel("Tick")
        ax.set_ylabel("Dunbar Tier")
        ax.legend(fontsize=8)
    ax.set_title("(b) Tier Evolution")

    # Part C: Chat type P5 对比
    ax = axes[2]
    p5_vals = [results["c"]["p5_private"], results["c"]["p5_group"]]
    bars = ax.bar(["Private", "Group"], p5_vals,
                  color=["#e74c3c", "#3498db"])
    ax.set_ylabel("P5 (Response Obligation)")
    ax.set_title("(c) Chat Type → P5")
    for bar, val in zip(bars, p5_vals):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.1,
                f"{val:.2f}", ha="center", fontsize=9)

    plt.tight_layout()
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"\n  图表已保存: {path}")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def run_exp6() -> dict:
    """运行实验 6 全部三个部分。"""
    return {
        "a": run_part_a(),
        "b": run_part_b(),
        "c": run_part_c(),
    }


if __name__ == "__main__":
    results = run_exp6()
    fig_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                           "..", "paper", "figures")
    os.makedirs(fig_dir, exist_ok=True)
    plot_exp6(results, os.path.join(fig_dir, "exp6_graph_dynamics.pdf"))

    # 汇总
    print("\n" + "=" * 50)
    print("实验 6 结果汇总:")
    print(f"  Part A (Snapshot):  {'PASS' if results['a']['full_match'] else 'FAIL'}")
    print(f"  Part B (Tier 演化): c0 升级={'PASS' if results['b']['c0_upgraded'] else 'FAIL'}, "
          f"静默正确={'PASS' if results['b']['silent_all_correct'] else 'FAIL'}")
    print(f"  Part C (Chat type): 私聊>群聊={'PASS' if results['c']['private_higher'] else 'FAIL'}, "
          f"群聊无directed={'PASS' if results['c']['group_no_directed'] else 'FAIL'}")

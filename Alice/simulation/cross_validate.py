"""交叉验证：生成 golden values 供 TypeScript runtime 测试对照。

构造与 runtime/test/pressure.test.ts buildTestGraph() 完全一致的图，
用相同参数计算 P1-P6 + API，输出 JSON。

运行：cd simulation && uv run python cross_validate.py
"""
from __future__ import annotations

import json
import math
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
from graph import CompanionGraph, NodeType, EdgeCategory
from pressure import (
    P1_attention_debt,
    P2_information_pressure,
    P3_relationship_cooling,
    P4_thread_divergence,
    P5_response_obligation,
    P6_curiosity,
    P_prospect,
    propagate_pressures,
    api_aggregate,
    compute_all_pressures,
)
from voices import PersonalityVector, compute_loudness


def build_cross_validation_graph() -> CompanionGraph:
    """构造与 TS buildTestGraph() 完全一致的图。"""
    G = CompanionGraph()
    G.tick = 100

    # Agent
    G.add_entity(NodeType.AGENT, "self")

    # Contacts
    G.add_entity(NodeType.CONTACT, "alice", tier=5, trust=0.9, last_active=95)
    G.add_entity(NodeType.CONTACT, "bob", tier=50, trust=0.5, last_active=60)
    G.add_entity(NodeType.CONTACT, "carol", tier=150, trust=0.3, last_active=0)

    # Channels
    G.add_entity(
        NodeType.CHANNEL, "ch_alice",
        unread=5, tier_contact=5, chat_type="private",
        pending_directed=2, last_directed_tick=98,
    )
    G.add_entity(
        NodeType.CHANNEL, "ch_group",
        unread=10, tier_contact=150, chat_type="group",
        pending_directed=0,
    )
    G.add_entity(
        NodeType.CHANNEL, "ch_empty",
        unread=0, tier_contact=50, chat_type="private",
    )

    # Threads
    G.add_entity(
        NodeType.THREAD, "t_urgent",
        weight="major", status="open", created=90, deadline=110,
    )
    G.add_entity(
        NodeType.THREAD, "t_minor",
        weight="minor", status="open", created=50, deadline=float("inf"),
    )
    G.add_entity(
        NodeType.THREAD, "t_done",
        weight="minor", status="resolved", created=10,
    )

    # InfoItems
    G.add_entity(
        NodeType.INFO_ITEM, "i1",
        importance=0.8, stability=2.0, last_access=90,
        volatility=0.3, tracked=True, created=80, novelty=0.7,
    )
    G.add_entity(
        NodeType.INFO_ITEM, "i2",
        importance=0.5, stability=1.0, last_access=50,
        volatility=0.1, tracked=False, created=30, novelty=0.2,
    )

    # Edges
    G.add_relation("self", "friend", "alice")
    G.add_relation("self", "acquaintance", "bob")
    G.add_relation("self", "stranger", "carol")
    G.add_relation("self", "monitors", "ch_alice")
    G.add_relation("self", "monitors", "ch_group")
    G.add_relation("alice", "joined", "ch_alice")
    G.add_relation("bob", "joined", "ch_group")
    G.add_relation("t_urgent", "involves", "alice")
    G.add_relation("i1", "from", "ch_alice")

    return G


def main():
    G = build_cross_validation_graph()
    n = 100

    # 显式参数（不依赖任何默认值）
    params = {
        "thread_age_scale": 1440.0,
        "d": -0.5,
        "eta": 0.6,
        "k_curiosity": 10,
        "mu": 0.3,
        "delta_deadline": 1.0,
        "kappa": [5.0, 8.0, 8.0, 5.0, 3.0, 0.5],
        "k_steepness": 5.0,
        "kappa_prospect": 3.0,
    }

    # 注意：Python compute_all_pressures 内部调用各 P 函数时使用函数默认值。
    # 为了交叉验证一致性，我们需要逐个调用并显式传参。
    # ADR-111: P3 的 beta_sigmoid 已移除（β_r 从 Weber-Fechner 推导，不可配置）。
    #
    # 逐压力本地值
    p1, c1_local = P1_attention_debt(G, n)
    p2, c2_local = P2_information_pressure(G, n, d=params["d"])
    p3, c3_local = P3_relationship_cooling(G, n)
    p4, c4_local = P4_thread_divergence(G, n, thread_age_scale=params["thread_age_scale"], delta_deadline=params["delta_deadline"])
    p5, c5_local = P5_response_obligation(G, n)
    p6, c6_local = P6_curiosity(G, n, eta=params["eta"], k=params["k_curiosity"], novelty_history=None)

    # ADR-23: P_prospect
    p_prospect_val, c_prospect_local = P_prospect(G, n, k_steepness=params["k_steepness"])

    # API（使用本地 P 值，与 TS computeAllPressures 一致）+ P_prospect 独立加法项
    kappa_arr = np.array(params["kappa"])
    api_base = api_aggregate(p1, p2, p3, p4, p5, p6, kappa=kappa_arr)
    prospect_term = float(np.tanh(p_prospect_val / params["kappa_prospect"]))
    api = api_base + prospect_term

    # Laplacian 传播（P6 contributions 参与传播）
    local_all: dict[str, float] = {}
    for contrib in (c1_local, c2_local, c3_local, c4_local, c5_local, c6_local):
        for eid, val in contrib.items():
            local_all[eid] = local_all.get(eid, 0.0) + val
    p_eff = propagate_pressures(G, local_all, mu=params["mu"])

    # 有效 contributions（传播后）—— 与 TS computeAllPressures 输出格式一致
    eff_contributions: dict[str, dict[str, float]] = {
        "P1": {}, "P2": {}, "P3": {}, "P4": {}, "P5": {}, "P6": {},
    }
    for pk, ck in [("P1", c1_local), ("P2", c2_local), ("P3", c3_local),
                   ("P4", c4_local), ("P5", c5_local), ("P6", c6_local)]:
        for eid, local_val in ck.items():
            total_local = local_all.get(eid, 0)
            total_eff = p_eff.get(eid, total_local)
            if total_local > 0:
                # 按原始贡献比例分配传播后的有效值
                eff_contributions[pk][eid] = local_val * (total_eff / total_local)
            else:
                eff_contributions[pk][eid] = local_val

    # 双重验证：compute_all_pressures 与手动调用一致（P1.2 assertion guard）
    auto = compute_all_pressures(
        G, n, kappa=kappa_arr, novelty_history=None,
        thread_age_scale=params["thread_age_scale"], eta=params["eta"], k_curiosity=params["k_curiosity"],
        mu=params["mu"], d=params["d"],
        delta_deadline=params["delta_deadline"],
        k_steepness=params["k_steepness"], kappa_prospect=params["kappa_prospect"],
    )
    for pk, pv in [("P1", p1), ("P2", p2), ("P3", p3), ("P4", p4), ("P5", p5), ("P6", p6)]:
        assert abs(auto[pk] - pv) < 1e-10, f"{pk} mismatch: compute_all={auto[pk]} vs manual={pv}"
    assert abs(auto["P_prospect"] - p_prospect_val) < 1e-10, \
        f"P_prospect mismatch: compute_all={auto['P_prospect']} vs manual={p_prospect_val}"
    assert abs(auto["API"] - api) < 1e-10, f"API mismatch: compute_all={auto['API']} vs manual={api}"

    # 替换 inf 为字符串（JSON 不支持 inf）
    def sanitize(v):
        if isinstance(v, float):
            if math.isinf(v):
                return "Infinity"
            if math.isnan(v):
                return "NaN"
        return v

    def sanitize_dict(d):
        return {k: sanitize(v) for k, v in d.items()}

    # 声部响度交叉验证（零噪声 + 固定人格 + 显式 kappa）
    loudness_personality = [0.3, 0.2, 0.25, 0.1, 0.15]
    personality = PersonalityVector(weights=np.array(loudness_personality))
    loudness = compute_loudness(
        G, n, personality,
        novelty_history=None,
        recent_event_counts=None,
        kappa_x=5.0,  # 与 TS runtime config.kappaX 一致（修复 #17.3）
        epsilon_scale=0.0,  # 零噪声，确定性对比
        rng=np.random.default_rng(42),  # 固定 seed（epsilon=0 时不影响结果）
        kappa_p=np.array(params["kappa"]),  # 使用交叉验证的 kappa，不是 Python 默认值
    )

    # ═══════════════════════════════════════════════════════════════════════
    # ADR-23 Wave 5 交叉验证：非默认值场景
    # ═══════════════════════════════════════════════════════════════════════

    # Wave 5.2: activity_relevance — 修改 ch_group 的 relevance
    G_relevance = build_cross_validation_graph()
    G_relevance.set_node_attr("ch_group", "activity_relevance", 0.5)
    p1_rel, c1_rel = P1_attention_debt(G_relevance, n)

    # Wave 5.1: risk_boost — 直接传入 loudness（与 TS computeRiskBoost 独立验证）
    risk_boost_val = 0.4
    loudness_risk = compute_loudness(
        G, n, personality,
        novelty_history=None,
        recent_event_counts=None,
        kappa_x=5.0,
        epsilon_scale=0.0,
        rng=np.random.default_rng(42),
        kappa_p=np.array(params["kappa"]),
        risk_boost=risk_boost_val,
    )

    # Wave 5.4a: mood negative valence → Caution +0.15
    mood_negative = {"valence": -0.6, "arousal": 0.3}
    loudness_mood_neg = compute_loudness(
        G, n, personality,
        novelty_history=None,
        recent_event_counts=None,
        kappa_x=5.0,
        epsilon_scale=0.0,
        rng=np.random.default_rng(42),
        kappa_p=np.array(params["kappa"]),
        mood=mood_negative,
    )

    # Wave 5.4b: mood high arousal → 赢家 ×1.2
    mood_arousal = {"valence": 0.2, "arousal": 0.9}
    loudness_mood_aro = compute_loudness(
        G, n, personality,
        novelty_history=None,
        recent_event_counts=None,
        kappa_x=5.0,
        epsilon_scale=0.0,
        rng=np.random.default_rng(42),
        kappa_p=np.array(params["kappa"]),
        mood=mood_arousal,
    )

    # Wave 5.5: conversation_inertia — P5 对话惯性
    G_inertia = build_cross_validation_graph()
    G_inertia.set_node_attr("ch_alice", "last_alice_action_tick", 98)  # 2 ticks ago → within window
    p5_inertia, c5_inertia = P5_response_obligation(G_inertia, n)

    # Wave 5.1+5.4: risk_boost + mood 联合
    loudness_combined = compute_loudness(
        G, n, personality,
        novelty_history=None,
        recent_event_counts=None,
        kappa_x=5.0,
        epsilon_scale=0.0,
        rng=np.random.default_rng(42),
        kappa_p=np.array(params["kappa"]),
        risk_boost=risk_boost_val,
        mood=mood_negative,
    )

    golden = {
        "params": params,
        "n": n,
        "pressures": {
            "P1": p1,
            "P2": p2,
            "P3": p3,
            "P4": p4,
            "P5": p5,
            "P6": p6,
            "P_prospect": p_prospect_val,
            "API": api,
        },
        "contributions": {
            "P1": sanitize_dict(eff_contributions["P1"]),
            "P2": sanitize_dict(eff_contributions["P2"]),
            "P3": sanitize_dict(eff_contributions["P3"]),
            "P4": sanitize_dict(eff_contributions["P4"]),
            "P5": sanitize_dict(eff_contributions["P5"]),
            "P6": sanitize_dict(eff_contributions["P6"]),
        },
        "local_contributions": {
            "P1": sanitize_dict(c1_local),
            "P2": sanitize_dict(c2_local),
            "P3": sanitize_dict(c3_local),
            "P4": sanitize_dict(c4_local),
            "P5": sanitize_dict(c5_local),
            "P6": sanitize_dict(c6_local),
        },
        "propagation": {
            "local_all": sanitize_dict(local_all),
            "p_eff": sanitize_dict(p_eff),
        },
        "loudness": {
            "personality": loudness_personality,
            "values": loudness.tolist(),
        },
        "wave5": {
            "activity_relevance": {
                "P1_total": p1_rel,
                "P1_ch_group": c1_rel.get("ch_group", 0.0),
            },
            "loudness_risk": {
                "risk_boost": risk_boost_val,
                "values": loudness_risk.tolist(),
            },
            "loudness_mood_negative": {
                "mood": mood_negative,
                "values": loudness_mood_neg.tolist(),
            },
            "loudness_mood_arousal": {
                "mood": mood_arousal,
                "values": loudness_mood_aro.tolist(),
            },
            "loudness_combined": {
                "risk_boost": risk_boost_val,
                "mood": mood_negative,
                "values": loudness_combined.tolist(),
            },
            "conversation_inertia": {
                "P5_total": p5_inertia,
                "P5_ch_alice": c5_inertia.get("ch_alice", 0.0),
            },
        },
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", "runtime", "test", "golden-pressures.json")
    with open(out_path, "w") as f:
        json.dump(golden, f, indent=2)

    print(f"Golden values written to {out_path}")
    print(f"P1={p1:.6f}  P2={p2:.6f}  P3={p3:.6f}")
    print(f"P4={p4:.6f}  P5={p5:.6f}  P6={p6:.6f}")
    print(f"P_prospect={p_prospect_val:.6f}")
    print(f"API={api:.6f}")
    print(f"\nEff contributions P1: {eff_contributions['P1']}")
    print(f"Eff contributions P3: {eff_contributions['P3']}")
    print(f"Eff contributions P5: {eff_contributions['P5']}")
    print(f"\nLoudness base (personality={loudness_personality}):")
    print(f"  D={loudness[0]:.6f}  C={loudness[1]:.6f}  S={loudness[2]:.6f}  X={loudness[3]:.6f}  R={loudness[4]:.6f}")
    print(f"\n--- Wave 5 交叉验证 ---")
    print(f"P1 with relevance=0.5: {p1_rel:.6f}  (ch_group: {c1_rel.get('ch_group', 0):.6f})")
    print(f"Loudness +risk_boost={risk_boost_val}: {loudness_risk.tolist()}")
    print(f"Loudness +mood_negative: {loudness_mood_neg.tolist()}")
    print(f"Loudness +mood_arousal: {loudness_mood_aro.tolist()}")
    print(f"Loudness combined: {loudness_combined.tolist()}")
    print(f"P5 with conversation_inertia: {p5_inertia:.6f}  (ch_alice: {c5_inertia.get('ch_alice', 0):.6f})")


if __name__ == "__main__":
    main()

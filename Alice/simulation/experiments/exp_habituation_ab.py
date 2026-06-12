"""ADR-222 Wave 2: Habituation A/B 对比实验。

验证适应性衰减 ρ_H 对目标集中度的影响：
- 组 A（基线）：无 Habituation，当前默认行为
- 组 B（Habituation）：ρ_H = 1/(1+α·H_eff)，τ_H=1800s

两组使用相同的合成图和事件流，对比 Gini 系数、top-1 占比、切换率。

@see docs/adr/222-habituation-truth-model.md
@see docs/adr/223-simulation-closed-loop-verification.md
"""
from __future__ import annotations

import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from collections import Counter

from graph import CompanionGraph, NodeType
from pressure import compute_all_pressures
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    personality_evolution_step,
)
from event_stream import EventStream
from telegram_parser import Event, EventKind
from sim_engine import (
    SimConfig,
    TickRecord,
    _apply_events,
    _select_target,
    _execute_action,
    _scale_kappa,
    compute_target_metrics,
)


# ---------------------------------------------------------------------------
# Habituation 逻辑（��� TS signal-decay.ts computeHabituationFactor 等价）
# ---------------------------------------------------------------------------

def compute_habituation_factor(
    H: float, hab_ms: float, now_ms: float,
    alpha: float = 0.5, half_life_s: float = 1800.0,
) -> float:
    """ρ_H = 1/(1+α·H_eff)。"""
    if H <= 0 or hab_ms <= 0:
        return 1.0
    age_s = max(0, (now_ms - hab_ms) / 1000)
    effective_h = H * 2 ** (-age_s / half_life_s)
    if effective_h < 0.01:
        return 1.0
    return 1 / (1 + alpha * effective_h)


def apply_habituation(
    contributions: dict[str, dict[str, float]],
    hab_state: dict[str, tuple[float, float]],
    now_ms: float, alpha: float = 0.5, half_life_s: float = 1800.0,
) -> dict[str, dict[str, float]]:
    """对 P5 以外的贡献应用 ρ_H。"""
    result = {}
    for pk, ec in contributions.items():
        if pk == "P5":
            result[pk] = dict(ec)
            continue
        nc = {}
        for eid, val in ec.items():
            hs = hab_state.get(eid)
            factor = compute_habituation_factor(hs[0], hs[1], now_ms, alpha, half_life_s) if hs else 1.0
            nc[eid] = val * factor
        result[pk] = nc
    return result


def update_habituation(
    hab_state: dict[str, tuple[float, float]],
    target: str | None, now_ms: float, half_life_s: float = 1800.0,
) -> None:
    """行动后 H(target) += 1.0。"""
    if not target:
        return
    prev_h, prev_ms = hab_state.get(target, (0.0, 0.0))
    age_s = max(0, (now_ms - prev_ms) / 1000) if prev_ms > 0 else 0
    decayed = prev_h * 2 ** (-age_s / half_life_s) if age_s > 0 else prev_h
    hab_state[target] = (decayed + 1.0, now_ms)


# ---------------------------------------------------------------------------
# 合成图构建
# ---------------------------------------------------------------------------

def build_graph(n_contacts: int = 8, seed: int = 42) -> CompanionGraph:
    """构建合成社交图。"""
    rng = np.random.default_rng(seed)
    G = CompanionGraph()
    G.add_entity(NodeType.AGENT, "self")

    tiers = [5, 15, 50, 50, 150, 150, 500, 500][:n_contacts]
    for i in range(n_contacts):
        cid = f"ct_{i}"
        chid = f"ch_{i}"
        tier = tiers[i] if i < len(tiers) else 500
        G.add_entity(NodeType.CONTACT, cid, tier=tier, last_active=0)
        G.add_entity(NodeType.CHANNEL, chid, unread=int(rng.integers(1, 8)),
                     chat_type="private", tier_contact=tier,
                     pending_directed=float(rng.integers(0, 3)),
                     last_directed_tick=0)
        G.add_relation(cid, "in", chid)
        G.add_relation("self", "knows", cid)

    # 几个 open 线程
    for i in range(3):
        tid = f"t_{i}"
        G.add_entity(NodeType.THREAD, tid, status="open", created=0,
                     weight="major" if i < 1 else "minor")
        G.add_relation(tid, "involves", f"ct_{i}")

    return G


def build_events(n_contacts: int = 8, n_ticks: int = 200, seed: int = 42) -> EventStream:
    """合成事件流：随机消息，tick_rate=60s。"""
    rng = np.random.default_rng(seed)
    events: list[Event] = []
    tick_rate = 60.0
    msg_id = 0

    for tick in range(1, n_ticks + 1):
        ts = tick * tick_rate  # 墙钟时间（秒）
        for i in range(n_contacts):
            if rng.random() < 0.25:  # 25% 概率每频道有消息
                n_msgs = int(rng.integers(1, 3))
                for _ in range(n_msgs):
                    msg_id += 1
                    events.append(Event(
                        timestamp=ts + rng.random() * tick_rate * 0.9,
                        kind=EventKind.MESSAGE,
                        channel_id=str(i),  # _apply_events 会加 "ch_" 前缀
                        sender_id=str(i),   # _apply_events 会加 "ct_" 前缀
                        sender_name=f"User_{i}",
                        message_id=msg_id,
                        reply_to=msg_id - 1 if rng.random() < 0.3 else None,
                        text_length=int(rng.integers(10, 300)),
                        has_entities=bool(rng.random() < 0.2),
                    ))

    return EventStream.from_events(events, tick_rate=tick_rate)


# ---------------------------------------------------------------------------
# 模拟
# ---------------------------------------------------------------------------

def run_sim(
    G: CompanionGraph, stream: EventStream,
    use_hab: bool = False, seed: int = 42,
) -> list[TickRecord]:
    """运行模拟。"""
    cfg = SimConfig(seed=seed, action_threshold=2.5)
    rng = np.random.default_rng(seed)
    total_ticks = stream.total_ticks()

    personality = PersonalityVector(weights=cfg.personality_init.copy())
    pi_home = cfg.personality_init.copy()
    kappa = _scale_kappa(G)
    novelty_history: list[float] = []
    event_count_history: list[int] = []
    action_window: list[bool] = []
    last_action_tick = -cfg.cooldown_ticks
    napi_ema = None
    records: list[TickRecord] = []
    hab_state: dict[str, tuple[float, float]] = {}

    for tick in range(1, total_ticks + 1):
        G.tick = tick
        now_ms = tick * 60_000.0

        tick_events = stream.events_in_tick(tick)
        n_events = _apply_events(G, tick_events, tick, novelty_history)
        event_count_history.append(n_events)

        result = compute_all_pressures(
            G, tick, kappa=kappa,
            novelty_history=novelty_history,
            thread_age_scale=cfg.thread_age_scale,
        )
        napi_val = result["API"]
        contributions = result["contributions"]

        if use_hab:
            contributions = apply_habituation(contributions, hab_state, now_ms)

        if napi_ema is None:
            napi_ema = napi_val
        else:
            napi_ema = cfg.ema_alpha * napi_val + (1 - cfg.ema_alpha) * napi_ema

        action_rate = (
            sum(action_window[-cfg.action_rate_window:])
            / max(len(action_window[-cfg.action_rate_window:]), 1)
            if action_window else 0.0
        )
        fatigue_mod = cfg.fatigue_alpha * max(0.0, action_rate - cfg.action_rate_cap)
        initiative_mod = cfg.initiative_alpha * max(0.0, cfg.action_rate_floor - action_rate)

        loudness = None
        action = None
        winner_idx = None
        feedback = 0.0
        target = None

        cooled_down = (tick - last_action_tick) >= cfg.cooldown_ticks
        effective_threshold = cfg.action_threshold * (1.0 + fatigue_mod - initiative_mod)
        should_act = napi_val > effective_threshold and cooled_down

        if should_act:
            loudness = compute_loudness(
                G, tick, personality,
                novelty_history=novelty_history,
                recent_event_counts=event_count_history,
                rng=rng,
            )
            winner_idx, action = select_action(loudness, rng=rng)
            target = _select_target(action, contributions)
            feedback = _execute_action(G, action, tick, rng, target=target)
            last_action_tick = tick
            novelty_history.append(0.7)

            if use_hab:
                update_habituation(hab_state, target, now_ms)

            personality = personality_evolution_step(
                personality, winner_idx, feedback,
                alpha=cfg.personality_alpha,
                gamma=cfg.personality_gamma,
                pi_home=pi_home,
                pi_min=cfg.personality_pi_min,
            )

        action_window.append(action is not None)
        pressures_flat = {k: v for k, v in result.items() if k != "contributions"}
        records.append(TickRecord(
            tick=tick, n_events=n_events, pressures=pressures_flat,
            napi=napi_val,
            loudness=loudness.copy() if loudness is not None else None,
            action=action, winner_idx=winner_idx,
            personality=personality.weights.copy(),
            feedback=feedback,
            target=target if action is not None else None,
        ))

    return records


# ---------------------------------------------------------------------------
# 主实验
# ---------------------------------------------------------------------------

def run_experiment(seed: int = 42, n_ticks: int = 200, n_contacts: int = 8) -> dict:
    """A/B 对比。"""
    print(f"  合成图：{n_contacts} contacts, {n_ticks} ticks, seed={seed}")

    G_tpl = build_graph(n_contacts=n_contacts, seed=seed)
    stream = build_events(n_contacts=n_contacts, n_ticks=n_ticks, seed=seed)

    print(f"\n  ═══ 组 A：基线（无 Habituation）═══")
    records_a = run_sim(copy.deepcopy(G_tpl), stream, use_hab=False, seed=seed)
    ma = compute_target_metrics(records_a)
    na = sum(1 for r in records_a if r.action)
    print(f"  行动={na}, Gini={ma['gini']:.3f}, top-1={ma['top1_ratio']:.1%}, "
          f"切换={ma['switch_rate']:.1%}, 目标数={ma['distinct']}")

    print(f"\n  ═══ 组 B：Habituation ═══")
    records_b = run_sim(copy.deepcopy(G_tpl), stream, use_hab=True, seed=seed)
    mb = compute_target_metrics(records_b)
    nb = sum(1 for r in records_b if r.action)
    print(f"  行动={nb}, Gini={mb['gini']:.3f}, top-1={mb['top1_ratio']:.1%}, "
          f"切换={mb['switch_rate']:.1%}, 目标数={mb['distinct']}")

    print(f"\n  ═══ 对比 ═══")
    def arrow(a, b, lower_better=True):
        if lower_better:
            return "↓ 改善" if b < a else ("= 持平" if b == a else "↑ 恶化")
        return "↑ 改善" if b > a else ("= 持平" if b == a else "↓ 恶化")

    print(f"  Gini:   {ma['gini']:.3f} → {mb['gini']:.3f}  ({arrow(ma['gini'], mb['gini'])})")
    print(f"  Top-1:  {ma['top1_ratio']:.1%} → {mb['top1_ratio']:.1%}  ({arrow(ma['top1_ratio'], mb['top1_ratio'])})")
    print(f"  切换率: {ma['switch_rate']:.1%} → {mb['switch_rate']:.1%}  ({arrow(ma['switch_rate'], mb['switch_rate'], False)})")
    print(f"  目标数: {ma['distinct']} → {mb['distinct']}")

    # 验证
    checks = []
    passed = True
    if ma["gini"] > 0:
        ok = mb["gini"] <= ma["gini"]
        checks.append(f"{'✓' if ok else '✗'} Gini(B) ≤ Gini(A)")
        if not ok: passed = False
    if ma["top1_ratio"] > 0:
        ok = mb["top1_ratio"] <= ma["top1_ratio"]
        checks.append(f"{'✓' if ok else '✗'} top-1(B) ≤ top-1(A)")
        if not ok: passed = False
    ok = mb["switch_rate"] >= ma["switch_rate"]
    checks.append(f"{'✓' if ok else '✗'} switch(B) ≥ switch(A)")
    if not ok: passed = False

    print(f"\n  结果: {'PASS ✓' if passed else 'FAIL ✗'}")
    for c in checks:
        print(f"    {c}")

    return {"ma": ma, "mb": mb, "records_a": records_a, "records_b": records_b, "passed": passed}


def plot(result: dict) -> None:
    """对比可视化。"""
    os.makedirs("output", exist_ok=True)
    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle("ADR-222: Habituation A/B", fontsize=14)

    for idx, (label, records, m) in enumerate([
        ("A: Baseline", result["records_a"], result["ma"]),
        ("B: Habituation", result["records_b"], result["mb"]),
    ]):
        targets = [r.target for r in records if r.target]
        counts = Counter(targets)

        ax = axes[idx][0]
        if counts:
            ax.pie(counts.values(),
                   labels=[k.replace("ch_", "Ch") for k in counts.keys()],
                   autopct="%1.0f%%")
        ax.set_title(f"{label}\nGini={m['gini']:.3f}, top-1={m['top1_ratio']:.0%}")

        ax = axes[idx][1]
        ticks = [r.tick for r in records if r.target]
        tgts = [r.target for r in records if r.target]
        uniq = sorted(set(tgts))
        ti = {t: i for i, t in enumerate(uniq)}
        if tgts:
            ax.scatter(ticks, [ti[t] for t in tgts], s=10, alpha=0.7)
            ax.set_yticks(range(len(uniq)))
            ax.set_yticklabels([t.replace("ch_", "Ch") for t in uniq])
        ax.set_xlabel("Tick")
        ax.set_title(f"Timeline (switch={m['switch_rate']:.0%})")

    plt.tight_layout()
    plt.savefig("output/habituation_ab.png", dpi=150)
    plt.close()
    print("  图表: output/habituation_ab.png")


if __name__ == "__main__":
    print("ADR-222 Wave 2: Habituation A/B")
    print("=" * 60)
    r = run_experiment()
    plot(r)

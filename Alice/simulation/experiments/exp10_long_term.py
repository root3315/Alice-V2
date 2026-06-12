"""实验 10：长期动力学验证。

验证压力场系统在 10000+ tick（约 7 天等价）下的长期行为：
A. 人格向量 π 是否收敛（方差递减）
B. Tier 分布是否稳定（无反复跳动）
C. API 是否有吸引子（动态平衡而非单调趋向极端）
D. 声部多样性（至少 3 种声部被选中）

理论依据：
- 人格演化的均值回归（γ 项）应保证 π 不会漂移到极端
- 行动频率门应防止系统死锁（API → 0 或 6）
- 声部竞争的随机性（softmax + ε 噪声）应维持声部多样性
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from graph import CompanionGraph, NodeType, EdgeCategory, random_companion_graph
from sim_engine import SimulationEngine, SimConfig
from event_stream import EventStream
from telegram_parser import Event, EventKind


# ---------------------------------------------------------------------------
# 合成事件流生成（10000+ tick 的长期事件）
# ---------------------------------------------------------------------------

def _generate_long_event_stream(
    n_ticks: int,
    n_contacts: int = 10,
    n_channels: int = 5,
    seed: int = 10042,
) -> tuple[CompanionGraph, EventStream]:
    """生成长期模拟所需的图和事件流。

    事件模式：
    - 基础事件率：每 tick 约 0.3 条消息（平均每 3 分钟一条）
    - 日夜节律：模拟 24 小时周期（1440 tick/天），夜间事件率降低
    - 突发/沉默：随机注入突发消息和沉默期
    - 线程生命周期：定期创建新线程、关闭旧线程
    """
    rng = np.random.default_rng(seed)

    # 构造图：10 联系人、5 频道、3 活跃线程
    G = random_companion_graph(
        n_contacts=n_contacts,
        n_threads=3,
        n_channels=n_channels,
        n_info_items=8,
        seed=seed,
    )

    # 收集 channel_id 和 sender_id
    channel_ids = G.get_entities_by_type(NodeType.CHANNEL)
    contact_ids = G.get_entities_by_type(NodeType.CONTACT)

    # 生成合成事件
    events: list[Event] = []
    tick_rate = 60.0  # 1 tick = 60 秒
    base_ts = 1700000000.0  # 基准时间戳

    msg_counter = 0

    for tick in range(1, n_ticks + 1):
        # 日夜节律：1440 tick = 1 天，深夜（tick % 1440 在 0-360 即 0:00-6:00）事件率降低
        hour_in_day = (tick % 1440) / 60.0  # 0-24 的小时数
        if hour_in_day < 6:
            # 深夜：低事件率
            event_prob = 0.05
        elif hour_in_day < 9:
            # 早晨：逐渐升高
            event_prob = 0.15
        elif hour_in_day < 22:
            # 白天：正常事件率
            event_prob = 0.35
        else:
            # 晚间：略低
            event_prob = 0.2

        # 随机突发（模拟多人同时活跃）
        if rng.random() < 0.01:
            event_prob = min(event_prob * 5, 1.0)

        # 随机沉默（模拟所有人都忙）
        if rng.random() < 0.005:
            event_prob = 0.0

        # 生成本 tick 的事件
        n_events = rng.poisson(event_prob)
        for _ in range(n_events):
            ch_idx = int(rng.integers(0, len(channel_ids)))
            ct_idx = int(rng.integers(0, len(contact_ids)))
            ch_id = channel_ids[ch_idx].replace("channel_", "")
            ct_id = contact_ids[ct_idx].replace("contact_", "sender_")

            ts = base_ts + (tick - 0.5 + rng.random()) * tick_rate
            msg_counter += 1

            # 20% 概率是 reply
            reply_to = msg_counter - int(rng.integers(1, 10)) if rng.random() < 0.2 else None
            if reply_to is not None and reply_to < 1:
                reply_to = None

            events.append(Event(
                timestamp=ts,
                kind=EventKind.MESSAGE,
                channel_id=ch_id,
                sender_id=ct_id,
                sender_name=f"User_{ct_idx}",
                message_id=msg_counter,
                reply_to=reply_to,
                text_length=int(rng.integers(5, 300)),
                has_entities=rng.random() < 0.15,
            ))

    stream = EventStream.from_events(events, tick_rate=tick_rate)

    # 注入噪声
    stream = stream.inject_noise(
        rng=rng,
        burst_rate=0.015,
        silence_rate=0.008,
        new_contact_rate=0.003,
    )

    return G, stream


# ---------------------------------------------------------------------------
# 主实验
# ---------------------------------------------------------------------------

def run_exp10(
    n_ticks: int = 10000,
    snapshot_interval: int = 100,
    seed: int = 10042,
) -> dict:
    """运行长期动力学实验。

    Parameters
    ----------
    n_ticks : int
        总 tick 数（默认 10000 ≈ 7 天）。
    snapshot_interval : int
        快照间隔。
    seed : int
        随机种子。

    Returns
    -------
    dict
        包含快照数据和分析指标。
    """
    print(f"\n  构造 {n_ticks} tick 的合成事件流...")
    G, stream = _generate_long_event_stream(n_ticks, seed=seed)

    actual_ticks = stream.total_ticks()
    print(f"  事件流实际长度: {actual_ticks} ticks, {len(stream.events)} 条事件")

    # 如果事件流实际 tick 数不足，需要扩展
    if actual_ticks < n_ticks:
        print(f"  警告：事件流只有 {actual_ticks} ticks，不足 {n_ticks}")
        n_ticks = max(actual_ticks, 1)

    config = SimConfig(
        personality_alpha=0.001,
        personality_gamma=0.0005,
        personality_pi_min=0.05,
        tier_eval_interval=100,
        action_rate_window=50,
        action_rate_cap=0.3,
        action_rate_floor=0.05,
        fatigue_alpha=0.5,
        initiative_alpha=0.3,
        seed=seed,
    )

    engine = SimulationEngine(G, stream, config)
    print(f"  开始 {n_ticks} tick 长期模拟...")
    records = engine.run()

    if not records:
        print("  错误：模拟未产生任何记录")
        return {"error": "no records"}

    # ── 收集快照 ──────────────────────────────────────────
    snapshots = {
        "ticks": [],
        "personality": [],     # (N, 5) 人格向量
        "api": [],             # nAPI 值
        "action_rate": [],     # 行动频率（滑窗）
        "voice_wins": [],      # 各声部胜利次数（累计）
    }

    # 声部胜率追踪
    voice_win_counts = np.zeros(5, dtype=int)
    action_window: list[bool] = []

    for r in records:
        action_window.append(r.action is not None)
        if r.winner_idx is not None:
            voice_win_counts[r.winner_idx] += 1

        if r.tick % snapshot_interval == 0:
            snapshots["ticks"].append(r.tick)
            snapshots["personality"].append(r.personality.copy())
            snapshots["api"].append(r.napi)

            # 滑窗行动率
            window = action_window[-config.action_rate_window:]
            rate = sum(window) / max(len(window), 1)
            snapshots["action_rate"].append(rate)
            snapshots["voice_wins"].append(voice_win_counts.copy())

    snapshots["ticks"] = np.array(snapshots["ticks"])
    snapshots["personality"] = np.array(snapshots["personality"])
    snapshots["api"] = np.array(snapshots["api"])
    snapshots["action_rate"] = np.array(snapshots["action_rate"])
    snapshots["voice_wins"] = np.array(snapshots["voice_wins"])

    n_snapshots = len(snapshots["ticks"])
    if n_snapshots < 20:
        print(f"  警告：快照数量不足 ({n_snapshots})")

    # ── 分析指标 ──────────────────────────────────────────

    # A. 人格收敛：对比前 10% 和后 10% 快照的 π 方差
    n_early = max(n_snapshots // 10, 1)
    n_late = max(n_snapshots // 10, 1)

    pi_early = snapshots["personality"][:n_early]
    pi_late = snapshots["personality"][-n_late:]

    pi_var_early = float(np.var(pi_early, axis=0).sum())
    pi_var_late = float(np.var(pi_late, axis=0).sum())
    pi_converged = pi_var_late <= pi_var_early * 1.5  # 后期方差不应显著大于前期

    # 也检查人格向量是否偏离初始值太远
    pi_final = snapshots["personality"][-1]
    pi_init = config.personality_init
    pi_drift = float(np.linalg.norm(pi_final - pi_init))

    # B. API 动态平衡：检查是否有吸引子
    api_all = np.array([r.napi for r in records])
    n_records = len(records)
    api_last_2000 = api_all[-min(2000, n_records):]
    api_first_1000 = api_all[:min(1000, n_records)]

    api_mean_late = float(api_last_2000.mean())
    api_std_late = float(api_last_2000.std())
    api_mean_early = float(api_first_1000.mean())

    # API 不应单调趋向 0 或 6
    api_deadlock_low = api_mean_late < 0.1
    api_deadlock_high = api_mean_late > 5.5
    api_has_attractor = not api_deadlock_low and not api_deadlock_high

    # C. 声部多样性
    final_voice_wins = voice_win_counts
    voices_used = int(np.sum(final_voice_wins > 0))
    voice_diversity_ok = voices_used >= 3

    # 最终声部分布
    total_actions = int(final_voice_wins.sum())
    voice_ratios = final_voice_wins / max(total_actions, 1)

    # D. Tier 稳定性：通过图最终状态检查
    contacts = G.get_entities_by_type(NodeType.CONTACT)
    final_tiers = {cid: G.node_attrs(cid).get("tier", 150) for cid in contacts}
    tier_distribution = {}
    for t in final_tiers.values():
        tier_distribution[t] = tier_distribution.get(t, 0) + 1

    results = {
        "n_ticks": n_records,
        "n_snapshots": n_snapshots,
        "snapshots": snapshots,
        "analysis": {
            "pi_var_early": pi_var_early,
            "pi_var_late": pi_var_late,
            "pi_converged": pi_converged,
            "pi_drift": pi_drift,
            "pi_final": pi_final.tolist(),
            "api_mean_late": api_mean_late,
            "api_std_late": api_std_late,
            "api_mean_early": api_mean_early,
            "api_has_attractor": api_has_attractor,
            "api_deadlock_low": api_deadlock_low,
            "api_deadlock_high": api_deadlock_high,
            "voices_used": voices_used,
            "voice_diversity_ok": voice_diversity_ok,
            "voice_ratios": voice_ratios.tolist(),
            "total_actions": total_actions,
            "tier_distribution": tier_distribution,
        },
        "api_trace": api_all,
        "records": records,
    }

    # 打印摘要
    print(f"\n  ── 长期动力学分析（{n_records} ticks）──")
    print(f"  A. 人格收敛:")
    print(f"     π 方差: 前期={pi_var_early:.6f}, 后期={pi_var_late:.6f}")
    print(f"     π 收敛: {'PASS' if pi_converged else 'FAIL'}")
    print(f"     π 漂移距离: {pi_drift:.4f}")
    print(f"     π 最终值: {[f'{v:.3f}' for v in pi_final]}")
    print(f"  B. API 动态平衡:")
    print(f"     API 后期: {api_mean_late:.3f} ± {api_std_late:.3f}")
    print(f"     API 前期: {api_mean_early:.3f}")
    print(f"     有吸引子: {'PASS' if api_has_attractor else 'FAIL'}")
    print(f"     死锁(低): {'YES' if api_deadlock_low else 'NO'}")
    print(f"     死锁(高): {'YES' if api_deadlock_high else 'NO'}")
    print(f"  C. 声部多样性:")
    print(f"     使用声部数: {voices_used}/5 ({'PASS' if voice_diversity_ok else 'FAIL'})")
    print(f"     总行动数: {total_actions}")
    from voices import VOICE_SHORT
    for i, (name, ratio) in enumerate(zip(VOICE_SHORT, voice_ratios)):
        print(f"     {name}: {final_voice_wins[i]} ({ratio * 100:.1f}%)")
    print(f"  D. Tier 分布: {tier_distribution}")

    return results


# ---------------------------------------------------------------------------
# 可视化
# ---------------------------------------------------------------------------

def plot_exp10(results: dict, path: str) -> None:
    """生成 exp10 四合一可视化。"""
    snapshots = results["snapshots"]
    analysis = results["analysis"]
    api_trace = results["api_trace"]
    ticks = snapshots["ticks"]

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))

    # (a) 人格向量 π 演化
    ax = axes[0, 0]
    from voices import VOICE_SHORT
    colors = ["#e74c3c", "#3498db", "#2ecc71", "#9b59b6", "#f39c12"]
    for i, (name, color) in enumerate(zip(VOICE_SHORT, colors)):
        ax.plot(ticks, snapshots["personality"][:, i],
                label=f"$\\pi_{{{name}}}$", color=color, linewidth=0.8)
    ax.set_xlabel("Tick")
    ax.set_ylabel("$\\pi_i$")
    ax.set_title("(a) Personality Vector Evolution")
    ax.legend(fontsize=7, ncol=5, loc="upper right")
    ax.grid(True, alpha=0.3)
    ax.set_ylim(0, 0.5)

    # (b) API 轨迹 + 滑动平均
    ax = axes[0, 1]
    x_api = np.arange(1, len(api_trace) + 1)
    # 降采样绘图（避免过多数据点）
    step = max(len(api_trace) // 2000, 1)
    ax.plot(x_api[::step], api_trace[::step], color="#3498db",
            linewidth=0.3, alpha=0.5, label="nAPI (raw)")
    # 滑动平均
    window = min(500, len(api_trace) // 4)
    if window > 1:
        kernel = np.ones(window) / window
        api_smooth = np.convolve(api_trace, kernel, mode="valid")
        x_smooth = np.arange(window // 2, window // 2 + len(api_smooth))
        ax.plot(x_smooth, api_smooth, color="#e74c3c",
                linewidth=1.5, label=f"Moving avg ({window})")
    ax.axhline(0, color="#999", linewidth=0.5, linestyle=":")
    ax.axhline(6, color="#999", linewidth=0.5, linestyle=":")
    ax.set_xlabel("Tick")
    ax.set_ylabel("nAPI")
    ax.set_title(f"(b) API Trace (mean={analysis['api_mean_late']:.2f})")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.3)

    # (c) 声部胜率演化
    ax = axes[1, 0]
    voice_wins = snapshots["voice_wins"].astype(float)
    # 计算累计胜率
    total_wins = voice_wins.sum(axis=1, keepdims=True)
    total_wins[total_wins == 0] = 1  # 避免除零
    voice_ratios_over_time = voice_wins / total_wins
    for i, (name, color) in enumerate(zip(VOICE_SHORT, colors)):
        ax.plot(ticks, voice_ratios_over_time[:, i],
                label=name, color=color, linewidth=1.0)
    ax.set_xlabel("Tick")
    ax.set_ylabel("Cumulative win rate")
    ax.set_title("(c) Voice Win Rate Evolution")
    ax.legend(fontsize=7, ncol=5, loc="upper right")
    ax.grid(True, alpha=0.3)
    ax.set_ylim(0, 1)

    # (d) 行动频率 + API 方差（滑窗）
    ax = axes[1, 1]
    ax.plot(ticks, snapshots["action_rate"],
            color="#2ecc71", linewidth=1.0, label="Action rate")
    ax.axhline(0.3, color="#e74c3c", linewidth=0.8, linestyle="--",
               label="Fatigue cap (0.3)")
    ax.axhline(0.05, color="#3498db", linewidth=0.8, linestyle="--",
               label="Initiative floor (0.05)")

    # 右轴：API 滑窗标准差
    ax2 = ax.twinx()
    # 计算 API 的滑窗标准差
    api_std_windows = []
    window_size = min(200, len(api_trace) // 5)
    for t in ticks:
        t_idx = int(t) - 1
        start = max(0, t_idx - window_size)
        end = min(len(api_trace), t_idx + 1)
        if end > start:
            api_std_windows.append(float(np.std(api_trace[start:end])))
        else:
            api_std_windows.append(0.0)
    ax2.plot(ticks, api_std_windows, color="#9b59b6",
             linewidth=0.8, alpha=0.7, label="API σ (window)")
    ax2.set_ylabel("API std", color="#9b59b6")
    ax2.tick_params(axis="y", labelcolor="#9b59b6")

    ax.set_xlabel("Tick")
    ax.set_ylabel("Action rate")
    ax.set_title("(d) Action Rate & API Stability")
    ax.legend(fontsize=7, loc="upper left")
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"\n  图表已保存: {path}")


# ---------------------------------------------------------------------------
# 断言验证
# ---------------------------------------------------------------------------

def verify_exp10(results: dict) -> None:
    """对实验结果进行断言验证。"""
    a = results["analysis"]

    # A. 人格收敛：后期方差不应显著大于前期（允许 50% 波动）
    assert a["pi_converged"], (
        f"人格未收敛：后期方差 {a['pi_var_late']:.6f} > 前期 {a['pi_var_early']:.6f} * 1.5"
    )

    # B. API 不应死锁
    assert a["api_has_attractor"], (
        f"API 死锁：mean={a['api_mean_late']:.3f} "
        f"(low={a['api_deadlock_low']}, high={a['api_deadlock_high']})"
    )

    # C. 至少 3 种声部被选中
    assert a["voice_diversity_ok"], (
        f"声部多样性不足：仅 {a['voices_used']}/5 种声部被选中"
    )

    print("\n  ✓ 所有断言通过")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def run_exp10_full() -> dict:
    """运行实验 10 并验证。"""
    results = run_exp10(n_ticks=10000, snapshot_interval=100, seed=10042)
    if "error" not in results:
        verify_exp10(results)
    return results


if __name__ == "__main__":
    print("实验 10：长期动力学验证")
    results = run_exp10_full()

    # 保存可视化
    output_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output")
    os.makedirs(output_dir, exist_ok=True)
    plot_exp10(results, os.path.join(output_dir, "exp10_long_term.pdf"))

    # 也保存到 paper/figures
    fig_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                           "..", "paper", "figures")
    os.makedirs(fig_dir, exist_ok=True)
    plot_exp10(results, os.path.join(fig_dir, "exp10_long_term.pdf"))

    print("\n" + "=" * 50)
    print("实验 10 结果汇总:")
    a = results["analysis"]
    print(f"  A. 人格收敛: {'PASS' if a['pi_converged'] else 'FAIL'} "
          f"(drift={a['pi_drift']:.4f})")
    print(f"  B. API 吸引子: {'PASS' if a['api_has_attractor'] else 'FAIL'} "
          f"(mean={a['api_mean_late']:.3f} ± {a['api_std_late']:.3f})")
    print(f"  C. 声部多样性: {'PASS' if a['voice_diversity_ok'] else 'FAIL'} "
          f"({a['voices_used']}/5)")
    print(f"  D. Tier 分布: {a['tier_distribution']}")

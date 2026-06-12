"""POMDP 论文真实数据验证：tick_log 压力轨迹回测 + NSV 反事实分析。

用 Alice runtime 的真实运行数据（runtime/alice.db）验证 POMDP 论文的理论预测：

分析 1: 压力轨迹回测
  - Sawtooth pattern: 行动后压力骤降 → idle growth 回升
  - Idle growth instability: P1 在无行动期间单调递增
  - Observation gap vs uncertainty: 距上次观测越久，行动前 observation_gap 越大

分析 2: NSV 反事实分析
  - 模拟 penalized NSV: NSV_β = NSV - β · U(belief)
  - 用 observation_gap 作为 belief uncertainty 代理指标
  - 扫描 β ∈ {0.1, 0.3, 0.5, 1.0}，统计行动翻转数

可独立运行:
  cd simulation && uv run python -m experiments.exp_pomdp_real_data

@see docs/adr/61-pomdp-belief-space-paper.md
@see paper-pomdp/sections/05-simulation.tex
"""
from __future__ import annotations

import os
import sys
import sqlite3
from pathlib import Path
from collections import defaultdict

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ═══════════════════════════════════════════════════════════════════════════
# 数据加载
# ═══════════════════════════════════════════════════════════════════════════

def get_db_path() -> Path:
    """定位 runtime/alice.db，兼容从 simulation/ 或项目根目录运行。"""
    candidates = [
        Path(__file__).resolve().parent.parent.parent / "runtime" / "alice.db",
        Path("runtime/alice.db"),
        Path("../runtime/alice.db"),
    ]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        "找不到 runtime/alice.db。请从项目根目录或 simulation/ 目录运行。"
    )


def load_tick_log(db_path: Path) -> dict:
    """加载 tick_log 并聚合为 per-tick 最大压力。

    tick_log 每 tick 有多行（每个目标实体一行），
    这里对每个 tick 取各维度的 max 和 per-target 明细。
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # 原始数据
    rows = conn.execute(
        "SELECT tick, p1, p2, p3, p4, p5, p6, api, action, target "
        "FROM tick_log ORDER BY tick, id"
    ).fetchall()

    # per-tick 聚合（取 max API 对应的行 = 系统的行动目标选择依据）
    tick_data: dict[int, dict] = {}
    tick_all_targets: dict[int, list[dict]] = defaultdict(list)

    for r in rows:
        t = r["tick"]
        entry = {
            "tick": t,
            "p1": r["p1"], "p2": r["p2"], "p3": r["p3"],
            "p4": r["p4"], "p5": r["p5"], "p6": r["p6"],
            "api": r["api"], "action": r["action"], "target": r["target"],
        }
        tick_all_targets[t].append(entry)

        if t not in tick_data or entry["api"] > tick_data[t]["api"]:
            tick_data[t] = entry

    conn.close()

    # 转为排序后的数组
    sorted_ticks = sorted(tick_data.keys())
    result = {
        "ticks": np.array(sorted_ticks),
        "p1": np.array([tick_data[t]["p1"] for t in sorted_ticks]),
        "p2": np.array([tick_data[t]["p2"] for t in sorted_ticks]),
        "p3": np.array([tick_data[t]["p3"] for t in sorted_ticks]),
        "p4": np.array([tick_data[t]["p4"] for t in sorted_ticks]),
        "p5": np.array([tick_data[t]["p5"] for t in sorted_ticks]),
        "p6": np.array([tick_data[t]["p6"] for t in sorted_ticks]),
        "api": np.array([tick_data[t]["api"] for t in sorted_ticks]),
        "targets": [tick_data[t]["target"] for t in sorted_ticks],
        "voices": [tick_data[t]["action"] for t in sorted_ticks],
        "all_targets": tick_all_targets,
        "n_rows": len(rows),
    }
    return result


def load_action_log(db_path: Path) -> list[dict]:
    """加载全部 action_log 行。"""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT tick, voice, target, action_type, chat_id, "
        "confidence, success, observation_gap, created_at "
        "FROM action_log ORDER BY tick, id"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════════════
# 分析 1: 压力轨迹回测
# ═══════════════════════════════════════════════════════════════════════════

def analyze_sawtooth(
    tick_log: dict,
    actions: list[dict],
) -> dict:
    """检测 sawtooth pattern: 行动后压力骤降 → idle 回升。

    对于每个行动 tick，检查:
    1. api 在行动 tick vs 下一 tick 的差值（期望为负 = 骤降）
    2. 行动间隔内 api 是否单调递增
    """
    ticks = tick_log["ticks"]
    api = tick_log["api"]
    p1 = tick_log["p1"]

    action_ticks = sorted(set(a["tick"] for a in actions))

    # 行动前后的 API 变化
    drops: list[dict] = []
    for at in action_ticks:
        idx = np.searchsorted(ticks, at)
        if idx < len(ticks) and ticks[idx] == at:
            api_at = api[idx]
            # 找行动后下一个 tick
            if idx + 1 < len(ticks):
                api_after = api[idx + 1]
                drop = api_at - api_after
                drops.append({
                    "tick": at,
                    "api_before": float(api_at),
                    "api_after": float(api_after),
                    "drop": float(drop),
                    "is_drop": drop > 0,
                })

    # Idle growth: P1 单调递增段
    # 找无行动的连续 tick 区间，检查 P1 是否递增
    action_tick_set = set(action_ticks)
    idle_segments: list[dict] = []
    seg_start = None
    for i, t in enumerate(ticks):
        if t not in action_tick_set:
            if seg_start is None:
                seg_start = i
        else:
            if seg_start is not None and i - seg_start >= 3:
                seg_p1 = p1[seg_start:i]
                is_monotone = all(seg_p1[j + 1] >= seg_p1[j] for j in range(len(seg_p1) - 1))
                idle_segments.append({
                    "start_tick": int(ticks[seg_start]),
                    "end_tick": int(ticks[i - 1]),
                    "length": i - seg_start,
                    "p1_start": float(seg_p1[0]),
                    "p1_end": float(seg_p1[-1]),
                    "monotone_increasing": is_monotone,
                })
            seg_start = None

    # 最后一段（行动后的长尾 idle）
    if seg_start is not None and len(ticks) - seg_start >= 3:
        seg_p1 = p1[seg_start:]
        is_monotone = all(seg_p1[j + 1] >= seg_p1[j] for j in range(len(seg_p1) - 1))
        idle_segments.append({
            "start_tick": int(ticks[seg_start]),
            "end_tick": int(ticks[-1]),
            "length": len(ticks) - seg_start,
            "p1_start": float(seg_p1[0]),
            "p1_end": float(seg_p1[-1]),
            "monotone_increasing": is_monotone,
        })

    return {
        "drops": drops,
        "n_drops": sum(1 for d in drops if d["is_drop"]),
        "n_total": len(drops),
        "mean_drop": float(np.mean([d["drop"] for d in drops])) if drops else 0.0,
        "idle_segments": idle_segments,
        "n_monotone_segments": sum(1 for s in idle_segments if s["monotone_increasing"]),
    }


def analyze_observation_gap(actions: list[dict]) -> dict:
    """分析 observation_gap 与目标切换的关系。

    计算每个目标的 ticks_since_last_action 作为更丰富的 uncertainty 代理。
    """
    # 原始 observation_gap 分布
    gaps = [a["observation_gap"] for a in actions if a["observation_gap"] is not None]

    # 计算 per-target ticks_since_last_action（更连续的代理指标）
    last_action_on_target: dict[str, int] = {}
    enriched: list[dict] = []
    for a in actions:
        target = a["target"] or "unknown"
        tick = a["tick"]
        if target in last_action_on_target:
            ticks_since = tick - last_action_on_target[target]
        else:
            ticks_since = tick  # 首次行动 → gap = tick 本身（大值）
        last_action_on_target[target] = tick
        enriched.append({
            **a,
            "ticks_since_last_action": ticks_since,
        })

    return {
        "raw_gaps": gaps,
        "enriched_actions": enriched,
        "mean_gap": float(np.mean(gaps)) if gaps else 0.0,
    }


# ═══════════════════════════════════════════════════════════════════════════
# 分析 2: NSV 反事实分析
# ═══════════════════════════════════════════════════════════════════════════

def nsv_counterfactual(
    tick_log: dict,
    actions: list[dict],
    betas: list[float] | None = None,
    threshold_mode: str = "median",
) -> dict:
    """NSV 反事实分析：NSV_β = NSV - β · U(belief)。

    Parameters
    ----------
    tick_log : dict
        tick_log 数据。
    actions : list[dict]
        action_log 数据（含 ticks_since_last_action enrichment）。
    betas : list[float]
        不确定性惩罚系数扫描值。
    threshold_mode : str
        行动阈值设定方式：
        - "median": 用原始 NSV 的中位数作为阈值
        - "min": 用原始 NSV 的最小值作为阈值（最宽松）

    Returns
    -------
    dict
        每个 β 的翻转统计。
    """
    if betas is None:
        betas = [0.1, 0.3, 0.5, 1.0]

    ticks = tick_log["ticks"]
    api = tick_log["api"]

    # 构建每个行动的 (NSV, uncertainty_proxy)
    action_records: list[dict] = []
    for a in actions:
        tick = a["tick"]
        idx = np.searchsorted(ticks, tick)
        if idx < len(ticks) and ticks[idx] == tick:
            nsv = float(api[idx])
        else:
            continue

        # uncertainty 代理: ticks_since_last_action，归一化到 [0, 1]
        ticks_since = a.get("ticks_since_last_action", 0)
        # 用 tanh 归一化：U = tanh(gap / κ)，κ = 10 ticks
        kappa = 10.0
        uncertainty = float(np.tanh(ticks_since / kappa))

        action_records.append({
            "tick": tick,
            "target": a.get("target", "unknown"),
            "action_type": a.get("action_type", "unknown"),
            "nsv": nsv,
            "ticks_since": ticks_since,
            "uncertainty": uncertainty,
            "success": a.get("success", 0),
        })

    if not action_records:
        return {"error": "无行动记录", "betas": betas, "flip_counts": {}}

    nsv_values = np.array([r["nsv"] for r in action_records])

    # 设定阈值（原始 NSV 分布下，所有行动都 >= threshold）
    if threshold_mode == "median":
        threshold = float(np.median(nsv_values))
    else:
        threshold = float(np.min(nsv_values))

    # β 扫描
    flip_results: dict[float, dict] = {}
    for beta in betas:
        flipped: list[dict] = []
        for rec in action_records:
            nsv_penalized = rec["nsv"] - beta * rec["uncertainty"]
            would_act = nsv_penalized >= threshold
            if not would_act:
                flipped.append({
                    **rec,
                    "nsv_penalized": nsv_penalized,
                    "penalty": beta * rec["uncertainty"],
                })

        flip_results[beta] = {
            "n_flipped": len(flipped),
            "n_total": len(action_records),
            "flip_rate": len(flipped) / len(action_records) if action_records else 0.0,
            "flipped_actions": flipped,
        }

    return {
        "betas": betas,
        "threshold": threshold,
        "threshold_mode": threshold_mode,
        "action_records": action_records,
        "flip_results": flip_results,
        "nsv_stats": {
            "mean": float(nsv_values.mean()),
            "std": float(nsv_values.std()),
            "min": float(nsv_values.min()),
            "max": float(nsv_values.max()),
            "median": float(np.median(nsv_values)),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════
# 绘图
# ═══════════════════════════════════════════════════════════════════════════

def plot_pressure_timeseries(
    tick_log: dict,
    actions: list[dict],
    output_path: str,
) -> None:
    """P1-P6 时间序列（6 subplot），用竖线标注行动事件。"""
    fig, axes = plt.subplots(3, 2, figsize=(14, 10), sharex=True)
    axes = axes.flatten()

    ticks = tick_log["ticks"]
    action_ticks = sorted(set(a["tick"] for a in actions))

    pressure_names = ["P1 (Attention)", "P2 (Recency)", "P3 (Cooling)",
                      "P4 (Thread)", "P5 (Social)", "P6 (Rhythm)"]
    pressure_keys = ["p1", "p2", "p3", "p4", "p5", "p6"]
    colors = ["#1565c0", "#2e7d32", "#c62828", "#f57c00", "#7b1fa2", "#00838f"]

    for i, (name, key, color) in enumerate(zip(pressure_names, pressure_keys, colors)):
        ax = axes[i]
        values = tick_log[key]

        ax.plot(ticks, values, color=color, linewidth=0.8, alpha=0.9)
        ax.fill_between(ticks, 0, values, color=color, alpha=0.15)

        # 行动事件竖线
        for at in action_ticks:
            ax.axvline(at, color="#999", linewidth=0.4, alpha=0.6, linestyle="--")

        ax.set_ylabel(name, fontsize=9)
        ax.grid(True, alpha=0.2)

        # 标注行动密集区
        if i == 0:
            ax.axvspan(min(action_ticks) - 1, max(action_ticks) + 1,
                       alpha=0.08, color="red", label="Action window")
            ax.legend(fontsize=7, loc="upper right")

    axes[-2].set_xlabel("Tick", fontsize=10)
    axes[-1].set_xlabel("Tick", fontsize=10)

    fig.suptitle("Pressure Field Time Series (max across targets per tick)\n"
                 f"Ticks: {int(ticks[0])}–{int(ticks[-1])}, "
                 f"Actions: {len(actions)} events in ticks {min(action_ticks)}–{max(action_ticks)}",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


def plot_sawtooth_detail(
    tick_log: dict,
    actions: list[dict],
    sawtooth: dict,
    output_path: str,
) -> None:
    """Sawtooth pattern 详图：API + P1 在行动窗口附近的放大视图。"""
    ticks = tick_log["ticks"]
    api = tick_log["api"]
    p1 = tick_log["p1"]
    action_ticks = sorted(set(a["tick"] for a in actions))

    # 聚焦行动窗口 ±10 ticks
    window_start = min(action_ticks) - 10
    window_end = max(action_ticks) + 10
    mask = (ticks >= window_start) & (ticks <= window_end)

    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)

    # (a) API 聚合压力指数
    ax = axes[0]
    ax.plot(ticks[mask], api[mask], "o-", color="#1565c0", markersize=3, linewidth=1.2)
    for at in action_ticks:
        ax.axvline(at, color="#c62828", linewidth=0.6, alpha=0.7, linestyle="--")
    ax.set_ylabel("API (Aggregate Pressure Index)")
    ax.set_title("(a) Sawtooth: API drops after action, recovers during idle")
    ax.grid(True, alpha=0.3)

    # 标注显著骤降
    for d in sawtooth["drops"]:
        if d["is_drop"] and d["drop"] > 0.3:
            ax.annotate(
                f"Δ={d['drop']:.2f}",
                xy=(d["tick"], d["api_before"]),
                xytext=(d["tick"] + 1, d["api_before"] + 0.15),
                fontsize=6, color="#c62828",
                arrowprops=dict(arrowstyle="->", color="#c62828", lw=0.7),
            )

    # (b) P1 注意力债务
    ax = axes[1]
    ax.plot(ticks[mask], p1[mask], "s-", color="#f57c00", markersize=3, linewidth=1.2)
    for at in action_ticks:
        ax.axvline(at, color="#c62828", linewidth=0.6, alpha=0.7, linestyle="--")
    ax.set_ylabel("P1 (Attention Debt)")
    ax.set_xlabel("Tick")
    ax.set_title("(b) P1 idle growth between actions")
    ax.grid(True, alpha=0.3)

    fig.suptitle(f"Sawtooth Pattern Detail (ticks {window_start}–{window_end})\n"
                 f"API drops observed: {sawtooth['n_drops']}/{sawtooth['n_total']}",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


def plot_nsv_counterfactual(
    cf_results: dict,
    output_path: str,
) -> None:
    """NSV 反事实分析图：β 扫描 + 行动翻转。"""
    betas = cf_results["betas"]
    records = cf_results["action_records"]
    threshold = cf_results["threshold"]

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))

    # (a) 每个行动的 NSV vs penalized NSV（多条 β 线）
    ax = axes[0]
    nsv_values = [r["nsv"] for r in records]
    uncertainties = [r["uncertainty"] for r in records]
    ticks_arr = [r["tick"] for r in records]

    ax.scatter(ticks_arr, nsv_values, s=30, color="#1565c0", zorder=5,
               label="Original NSV", edgecolors="white", linewidths=0.5)

    beta_colors = ["#66bb6a", "#ffa726", "#ef5350", "#ab47bc"]
    for beta, color in zip(betas, beta_colors):
        penalized = [r["nsv"] - beta * r["uncertainty"] for r in records]
        ax.scatter(ticks_arr, penalized, s=15, color=color, alpha=0.7,
                   marker="x", label=f"β={beta}")

    ax.axhline(threshold, color="#999", linewidth=1, linestyle=":",
               label=f"Threshold={threshold:.2f}")
    ax.set_xlabel("Action tick")
    ax.set_ylabel("NSV / Penalized NSV")
    ax.set_title("(a) NSV with uncertainty penalty")
    ax.legend(fontsize=7, ncol=2)
    ax.grid(True, alpha=0.3)

    # (b) 翻转率 vs β
    ax = axes[1]
    flip_rates = [cf_results["flip_results"][b]["flip_rate"] * 100 for b in betas]
    flip_counts = [cf_results["flip_results"][b]["n_flipped"] for b in betas]
    total = cf_results["flip_results"][betas[0]]["n_total"]

    bars = ax.bar([f"β={b}" for b in betas], flip_rates,
                  color=beta_colors, alpha=0.8, edgecolor="white")

    for bar, count, rate in zip(bars, flip_counts, flip_rates):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1,
                f"{count}/{total}\n({rate:.0f}%)",
                ha="center", va="bottom", fontsize=8)

    ax.set_ylabel("Action flip rate (%)")
    ax.set_title(f"(b) Actions flipped by uncertainty penalty\n(threshold={threshold:.2f})")
    ax.set_ylim(0, 100)
    ax.grid(True, alpha=0.3, axis="y")

    fig.suptitle("NSV Counterfactual Analysis: NSV_β = NSV − β · U(belief)", fontsize=11)
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


def plot_uncertainty_landscape(
    cf_results: dict,
    output_path: str,
) -> None:
    """Uncertainty landscape: NSV vs U(belief) 散点 + β 等值线。"""
    records = cf_results["action_records"]
    betas = cf_results["betas"]
    threshold = cf_results["threshold"]

    fig, ax = plt.subplots(figsize=(8, 6))

    nsv = np.array([r["nsv"] for r in records])
    unc = np.array([r["uncertainty"] for r in records])
    success = np.array([r["success"] for r in records])

    # 散点：成功 vs 失败
    mask_ok = success == 1
    mask_fail = ~mask_ok
    ax.scatter(unc[mask_ok], nsv[mask_ok], s=50, c="#2e7d32", marker="o",
               label="Successful", edgecolors="white", linewidths=0.5, zorder=5)
    ax.scatter(unc[mask_fail], nsv[mask_fail], s=50, c="#c62828", marker="x",
               label="Failed", linewidths=1.5, zorder=5)

    # β 等值线：NSV = threshold + β · U
    u_range = np.linspace(0, 1, 100)
    beta_colors = ["#66bb6a", "#ffa726", "#ef5350", "#ab47bc"]
    for beta, color in zip(betas, beta_colors):
        boundary = threshold + beta * u_range
        ax.plot(u_range, boundary, color=color, linewidth=1.2, linestyle="--",
                alpha=0.8, label=f"β={beta} boundary")

    ax.axhline(threshold, color="#999", linewidth=0.8, linestyle=":")
    ax.set_xlabel("Belief uncertainty U = tanh(ticks_since_last / κ)")
    ax.set_ylabel("NSV (Aggregate Pressure Index)")
    ax.set_title("Uncertainty Landscape: action boundary shifts with β")
    ax.legend(fontsize=7, loc="upper left")
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  图已保存: {output_path}")


# ═══════════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════════

def run_all() -> dict:
    """运行全部分析。"""
    print("=" * 60)
    print("POMDP 真实数据验证")
    print("=" * 60)

    db_path = get_db_path()
    print(f"  数据库: {db_path}")

    # 加载数据
    tick_log = load_tick_log(db_path)
    actions = load_action_log(db_path)
    print(f"  tick_log: {tick_log['n_rows']} 行, "
          f"ticks {int(tick_log['ticks'][0])}–{int(tick_log['ticks'][-1])}")
    print(f"  action_log: {len(actions)} 行")

    if len(actions) == 0:
        print("\n  ⚠ 无行动记录。请在更长运行后重新执行本脚本。")
        return {"error": "no_actions"}

    results: dict = {}

    # --- 分析 1: Sawtooth pattern ---
    print("\n--- 分析 1: 压力轨迹回测 ---")

    sawtooth = analyze_sawtooth(tick_log, actions)
    results["sawtooth"] = sawtooth
    print(f"  Sawtooth drops: {sawtooth['n_drops']}/{sawtooth['n_total']} "
          f"({sawtooth['n_drops'] / max(sawtooth['n_total'], 1) * 100:.0f}%)")
    print(f"  平均 API drop: {sawtooth['mean_drop']:.3f}")
    print(f"  Idle 段 P1 单调递增: "
          f"{sawtooth['n_monotone_segments']}/{len(sawtooth['idle_segments'])}")

    for seg in sawtooth["idle_segments"]:
        print(f"    ticks {seg['start_tick']}–{seg['end_tick']} "
              f"(len={seg['length']}): P1 {seg['p1_start']:.2f}→{seg['p1_end']:.2f} "
              f"{'✓ 单调' if seg['monotone_increasing'] else '✗ 非单调'}")

    # Observation gap 分析
    gap_analysis = analyze_observation_gap(actions)
    results["gap_analysis"] = gap_analysis
    enriched_actions = gap_analysis["enriched_actions"]
    print(f"\n  Observation gap 分布:")
    print(f"    原始 gap 均值: {gap_analysis['mean_gap']:.2f}")
    for a in enriched_actions[:5]:
        print(f"    tick={a['tick']} target={a['target']} "
              f"ticks_since={a['ticks_since_last_action']} gap={a['observation_gap']}")

    # --- 分析 2: NSV 反事实 ---
    print("\n--- 分析 2: NSV 反事实分析 ---")

    cf_results = nsv_counterfactual(tick_log, enriched_actions)
    results["counterfactual"] = cf_results

    print(f"  NSV 统计: mean={cf_results['nsv_stats']['mean']:.3f}, "
          f"std={cf_results['nsv_stats']['std']:.3f}, "
          f"range=[{cf_results['nsv_stats']['min']:.3f}, {cf_results['nsv_stats']['max']:.3f}]")
    print(f"  阈值 ({cf_results['threshold_mode']}): {cf_results['threshold']:.3f}")

    for beta in cf_results["betas"]:
        fr = cf_results["flip_results"][beta]
        print(f"    β={beta:.1f}: {fr['n_flipped']}/{fr['n_total']} 翻转 "
              f"({fr['flip_rate'] * 100:.0f}%)")

    # --- 绘图 ---
    print("\n--- 生成图表 ---")
    fig_dir = os.path.join(os.path.dirname(__file__), "figures")
    os.makedirs(fig_dir, exist_ok=True)

    plot_pressure_timeseries(
        tick_log, actions,
        os.path.join(fig_dir, "pomdp_real_pressure_timeseries.png"),
    )
    plot_sawtooth_detail(
        tick_log, actions, sawtooth,
        os.path.join(fig_dir, "pomdp_real_sawtooth_detail.png"),
    )
    plot_nsv_counterfactual(
        cf_results,
        os.path.join(fig_dir, "pomdp_real_nsv_counterfactual.png"),
    )
    plot_uncertainty_landscape(
        cf_results,
        os.path.join(fig_dir, "pomdp_real_uncertainty_landscape.png"),
    )

    # --- 数据不足警告 ---
    if len(actions) < 50:
        print(f"\n  ⚠ 数据量有限 ({len(actions)} actions, {len(tick_log['ticks'])} ticks).")
        print("    当前结果为初步验证。更长运行后重新执行本脚本可获得更稳健的结论。")
        results["data_warning"] = (
            f"仅 {len(actions)} 个行动 / {len(tick_log['ticks'])} 个 tick。"
            "需要大规模长程运行后重新验证。"
        )

    print("\n" + "=" * 60)
    print("分析完成")
    print("=" * 60)

    return results


if __name__ == "__main__":
    run_all()

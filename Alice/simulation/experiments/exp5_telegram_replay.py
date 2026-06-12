"""实验 5：基于真实 Telegram 导出数据的事件流回放模拟。

将 Telegram Desktop 导出的 result.json 解析为事件流，
驱动压力场演化和多声部决策，验证模型在真实社交动态下的行为。

验证目标：
- 高活跃期 P1 上升、行动频率增加（对话态）
- 沉默期 P3/P6 上升、Agent 主动行动（巡逻态）
- 人格漂移方向与事件模式相关
- 涌现节律在真实数据下的表现
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np

from telegram_parser import parse_telegram_export, load_multiple_chats
from graph_builder import build_graph_from_chats
from event_stream import EventStream
from sim_engine import SimulationEngine, SimConfig
from sim_visualizer import plot_main_panel, plot_pressure_detail, plot_action_intervals


def run_exp5(
    data_paths: list[str],
    tick_rate: float = 60.0,
    action_threshold: float | None = None,
    inject_noise: bool = True,
    seed: int = 42,
) -> dict:
    """运行实验 5。

    Parameters
    ----------
    data_paths : list[str]
        Telegram 导出 JSON 文件路径列表。
    tick_rate : float
        每 tick 对应的秒数。
    action_threshold : float
        API 行动阈值。
    inject_noise : bool
        是否注入噪声。
    seed : int
        随机种子。

    Returns
    -------
    dict
        包含 records、graph、stream 等。
    """
    print(f"  加载 {len(data_paths)} 个聊天文件...")
    chats = load_multiple_chats(data_paths)

    total_events = sum(len(c.events) for c in chats)
    total_participants = len(set().union(*(c.participants.keys() for c in chats)))
    print(f"  总事件数: {total_events}, 总参与者: {total_participants}")

    # 线程推断统计
    total_threads = len(set().union(*(set(c.thread_map.values()) for c in chats if c.thread_map)))
    print(f"  推断线程数: {total_threads}")

    # 构建图
    print("  构建 CompanionGraph...")
    G = build_graph_from_chats(chats, tick_rate=tick_rate)
    print(f"  图: {G}")

    # 构建事件流
    all_events = []
    for c in chats:
        all_events.extend(c.events)
    stream = EventStream.from_events(all_events, tick_rate=tick_rate)
    print(f"  事件流: {stream.total_ticks()} ticks (tick_rate={tick_rate}s)")

    # 注入噪声
    if inject_noise:
        rng = np.random.default_rng(seed)
        stream_noisy = stream.inject_noise(rng)
        n_orig = len(stream.events)
        n_noisy = len(stream_noisy.events)
        print(f"  噪声注入: {n_orig} → {n_noisy} 事件 (+{n_noisy - n_orig})")
        stream = stream_noisy

    # 运行模拟
    config = SimConfig(
        action_threshold=action_threshold,
        seed=seed,
    )
    engine = SimulationEngine(G, stream, config)
    records = engine.run()

    # 分析结果
    results = _analyze_results(records, stream)
    results["records"] = records
    results["graph"] = G
    results["stream"] = stream
    results["chats"] = chats

    return results


def _analyze_results(records, stream) -> dict:
    """分析模拟结果，提取关键指标。"""
    if not records:
        return {}

    # 行动统计
    action_records = [r for r in records if r.action is not None]
    n_actions = len(action_records)
    total_ticks = len(records)

    action_dist: dict[str, int] = {}
    for r in action_records:
        action_dist[r.action] = action_dist.get(r.action, 0) + 1

    # 行动间隔
    action_ticks = [r.tick for r in action_records]
    if len(action_ticks) > 1:
        intervals = np.diff(action_ticks)
        mean_interval = float(np.mean(intervals))
        std_interval = float(np.std(intervals))
    else:
        mean_interval = 0.0
        std_interval = 0.0

    # 归一化 API 统计
    api_vals = np.array([r.napi for r in records])
    api_mean = float(api_vals.mean())
    api_max = float(api_vals.max())
    api_std = float(api_vals.std())

    # 事件热度与压力变化率的相关性（delta napi 去趋势）
    n_events_arr = np.array([r.n_events for r in records], dtype=float)
    napi_delta = np.diff(api_vals, prepend=api_vals[0])  # 逐 tick 变化量
    if n_events_arr.std() > 0 and napi_delta.std() > 0:
        correlation = float(np.corrcoef(n_events_arr, napi_delta)[0, 1])
    else:
        correlation = 0.0

    # 人格漂移
    pi_start = records[0].personality
    pi_end = records[-1].personality
    pi_drift = float(np.linalg.norm(pi_end - pi_start))

    # 高活跃期 vs 沉默期分析
    median_events = float(np.median(n_events_arr))
    active_mask = n_events_arr > median_events
    silent_mask = n_events_arr == 0

    active_api_mean = float(api_vals[active_mask].mean()) if active_mask.any() else 0.0
    silent_api_mean = float(api_vals[silent_mask].mean()) if silent_mask.any() else 0.0

    # 沉默期的主导压力（按 raw 值比较）
    if silent_mask.any():
        silent_records = [r for r, m in zip(records, silent_mask) if m]
        p_keys = ["P1", "P2", "P3", "P4", "P5", "P6"]
        silent_p_means = {k: np.mean([r.pressures[k] for r in silent_records]) for k in p_keys}
        dominant_silent_p = max(silent_p_means, key=silent_p_means.get)
    else:
        silent_p_means = {}
        dominant_silent_p = "N/A"

    print(f"\n  === 分析结果 ===")
    print(f"  总 ticks: {total_ticks}, 行动次数: {n_actions} ({n_actions / total_ticks * 100:.1f}%)")
    print(f"  API: mean={api_mean:.1f}, max={api_max:.1f}, std={api_std:.1f}")
    print(f"  事件-压力相关性: {correlation:.3f}")
    print(f"  平均行动间隔: {mean_interval:.1f} ± {std_interval:.1f} ticks")
    print(f"  人格漂移量: {pi_drift:.6f}")
    print(f"  人格: {' '.join(f'{s}={v:.3f}' for s, v in zip(['D', 'C', 'S', 'X', 'R'], pi_end))}")
    print(f"  活跃期 API 均值: {active_api_mean:.1f}")
    print(f"  沉默期 API 均值: {silent_api_mean:.1f}")
    print(f"  沉默期主导压力: {dominant_silent_p}")

    return {
        "n_actions": n_actions,
        "total_ticks": total_ticks,
        "action_dist": action_dist,
        "mean_interval": mean_interval,
        "std_interval": std_interval,
        "api_mean": api_mean,
        "api_max": api_max,
        "api_std": api_std,
        "correlation": correlation,
        "pi_start": pi_start,
        "pi_end": pi_end,
        "pi_drift": pi_drift,
        "active_api_mean": active_api_mean,
        "silent_api_mean": silent_api_mean,
        "dominant_silent_p": dominant_silent_p,
    }


def plot_exp5(results: dict, fig_dir: str) -> None:
    """生成实验 5 的全部图表。"""
    os.makedirs(fig_dir, exist_ok=True)
    records = results.get("records", [])
    if not records:
        print("  无记录，跳过绘图")
        return

    plot_main_panel(records, os.path.join(fig_dir, "exp5_main.pdf"))
    plot_pressure_detail(records, os.path.join(fig_dir, "exp5_pressure_detail.pdf"))
    plot_action_intervals(records, os.path.join(fig_dir, "exp5_intervals.pdf"))


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Exp 5: Telegram Replay Simulation")
    parser.add_argument("--data", nargs="+", required=True,
                        help="Telegram 导出 JSON 文件路径")
    parser.add_argument("--tick-rate", type=float, default=60.0,
                        help="每 tick 秒数 (默认 60)")
    parser.add_argument("--threshold", type=float, default=None,
                        help="归一化 API 行动阈值 (None=自适应)")
    parser.add_argument("--no-noise", action="store_true",
                        help="不注入噪声")
    parser.add_argument("--seed", type=int, default=42,
                        help="随机种子 (默认 42)")
    parser.add_argument("--fig-dir", type=str, default=None,
                        help="图表输出目录")
    args = parser.parse_args()

    print("=" * 60)
    print("实验 5：Telegram 事件流回放模拟")
    print("=" * 60)

    results = run_exp5(
        data_paths=args.data,
        tick_rate=args.tick_rate,
        action_threshold=args.threshold,
        inject_noise=not args.no_noise,
        seed=args.seed,
    )

    fig_dir = args.fig_dir or os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "..", "paper", "figures"
    )
    plot_exp5(results, fig_dir)

    print(f"\n{'=' * 60}")
    print("实验 5 完成")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()

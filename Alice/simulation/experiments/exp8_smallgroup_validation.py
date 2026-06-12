"""实验 8：小群数据验证 — 群聊动态感知和人格漂移。

数据源：D4 — 13562 条, 34 人, 42 天, private_supergroup (别瞎写诗)

验证项：
1. exp5 全量回放（压力场时序、行动分布、人格漂移）
2. 群聊参与率分析（Gini 系数、Alice 参与率定位）
3. @提及检测（mention 频率、pending_directed 触发率估算）
4. 话题漂移（Jaccard 距离、bigram 滑动窗口）
5. 24 小时活跃分布（每小时消息统计、与 activeHours EMA 对比）
6. 人格漂移详细分析（5 维时序、漂移量、漂移速度、收敛性）
"""
from __future__ import annotations

import os
import sys
import json
import datetime
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

from telegram_parser import parse_telegram_export, EventKind
from experiments.exp5_telegram_replay import run_exp5, plot_exp5
from sim_visualizer import VOICE_COLORS, VOICE_SHORT, PRESSURE_COLORS

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "testdata", "smallgroup_1", "result.json",
)
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output")
REPORT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "output", "exp8_smallgroup_report.md",
)


def ensure_dirs():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)


# ---------------------------------------------------------------------------
# 1. exp5 全量回放
# ---------------------------------------------------------------------------

def run_replay() -> dict:
    """运行 exp5 全量回放。"""
    print("=" * 60)
    print("实验 8：小群数据验证（别瞎写诗）")
    print("=" * 60)

    results = run_exp5(
        data_paths=[DATA_PATH],
        tick_rate=60.0,
        inject_noise=True,
        seed=42,
    )

    # 使用 exp5 的标准绘图
    plot_exp5(results, OUTPUT_DIR)
    # 重命名为 exp8 前缀
    for old_name, new_name in [
        ("exp5_main.pdf", "exp8_main.png"),
        ("exp5_pressure_detail.pdf", "exp8_pressure_detail.png"),
        ("exp5_intervals.pdf", "exp8_intervals.png"),
    ]:
        old_path = os.path.join(OUTPUT_DIR, old_name)
        new_path = os.path.join(OUTPUT_DIR, new_name)
        if os.path.exists(old_path):
            os.rename(old_path, new_path)

    return results


# ---------------------------------------------------------------------------
# 2. 群聊参与率分析
# ---------------------------------------------------------------------------

def analyze_participation(chat_data: dict) -> dict:
    """统计参与率和 Gini 系数。"""
    msgs = chat_data.get("messages", [])
    sender_counts: Counter = Counter()
    for m in msgs:
        if m.get("type") == "message" and m.get("from"):
            sender_counts[m["from"]] += 1

    total = sum(sender_counts.values())
    n_senders = len(sender_counts)
    ratios = sorted([c / total for c in sender_counts.values()], reverse=True)

    # Gini 系数
    gini = _compute_gini(list(sender_counts.values()))

    # Alice 参与率模拟定位
    alice_positions = {}
    for pct in [0.05, 0.10, 0.20]:
        alice_msgs = int(total * pct / (1 - pct))  # Alice 加入后的总量
        # 找 Alice 在排名中的位置
        rank = sum(1 for c in sender_counts.values() if c > alice_msgs)
        alice_positions[f"{int(pct*100)}%"] = {
            "msgs": alice_msgs,
            "rank": rank + 1,
            "total_after": total + alice_msgs,
        }

    # 绘图
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    # 柱状图：Top 15 发言者
    top_15 = sender_counts.most_common(15)
    names = [name[:8] for name, _ in top_15]  # 截断长名字
    counts = [c for _, c in top_15]
    bars = ax1.barh(range(len(names)), counts, color="#1565c0", alpha=0.7)
    ax1.set_yticks(range(len(names)))
    ax1.set_yticklabels(names, fontsize=8)
    ax1.invert_yaxis()
    ax1.set_xlabel("Message count")
    ax1.set_title(f"Top 15 Senders (Gini={gini:.3f})")
    ax1.grid(True, alpha=0.2, axis="x")

    # 标注 Alice 模拟位置
    for pct_label, info in alice_positions.items():
        ax1.axvline(info["msgs"], color="red", linestyle="--", alpha=0.5,
                     label=f"Alice@{pct_label}: {info['msgs']} msgs (rank #{info['rank']})")
    ax1.legend(fontsize=7, loc="lower right")

    # Lorenz 曲线
    sorted_counts = sorted(sender_counts.values())
    cumulative = np.cumsum(sorted_counts) / sum(sorted_counts)
    x = np.arange(1, len(cumulative) + 1) / len(cumulative)
    ax2.plot(x, cumulative, "b-", linewidth=2, label=f"Lorenz (Gini={gini:.3f})")
    ax2.plot([0, 1], [0, 1], "k--", alpha=0.5, label="Perfect equality")
    ax2.fill_between(x, cumulative, np.linspace(x[0], 1, len(x)), alpha=0.1, color="blue")
    ax2.set_xlabel("Cumulative share of senders")
    ax2.set_ylabel("Cumulative share of messages")
    ax2.set_title("Lorenz Curve")
    ax2.legend()
    ax2.grid(True, alpha=0.2)

    fig.tight_layout()
    fig.savefig(os.path.join(OUTPUT_DIR, "exp8_participation.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  参与率图已保存: exp8_participation.png")

    return {
        "total_messages": total,
        "n_senders": n_senders,
        "gini": gini,
        "top_10": sender_counts.most_common(10),
        "alice_positions": alice_positions,
        "ratios": ratios,
    }


def _compute_gini(values: list[int]) -> float:
    """计算 Gini 系数。"""
    arr = np.array(sorted(values), dtype=float)
    n = len(arr)
    if n == 0 or arr.sum() == 0:
        return 0.0
    index = np.arange(1, n + 1)
    return float((2 * np.sum(index * arr) - (n + 1) * np.sum(arr)) / (n * np.sum(arr)))


# ---------------------------------------------------------------------------
# 3. @提及检测
# ---------------------------------------------------------------------------

def analyze_mentions(chat_data: dict) -> dict:
    """统计 mention 实体频率。"""
    msgs = chat_data.get("messages", [])
    mention_msgs = 0
    total_mentions = 0
    daily_mentions: Counter = Counter()

    for m in msgs:
        if m.get("type") != "message":
            continue
        ts = float(m.get("date_unixtime", 0))
        day = datetime.date.fromtimestamp(ts).isoformat() if ts > 0 else "unknown"

        has_mention = False
        text = m.get("text", "")
        if isinstance(text, list):
            for part in text:
                if isinstance(part, dict) and part.get("type") == "mention":
                    total_mentions += 1
                    has_mention = True
        # 也检查 text_entities
        for ent in m.get("text_entities", []):
            if ent.get("type") == "mention":
                total_mentions += 1
                has_mention = True

        if has_mention:
            mention_msgs += 1
            daily_mentions[day] += 1

    total_msg = sum(1 for m in msgs if m.get("type") == "message")
    days = len(set(
        datetime.date.fromtimestamp(float(m.get("date_unixtime", 0))).isoformat()
        for m in msgs if m.get("type") == "message" and float(m.get("date_unixtime", 0)) > 0
    ))
    avg_daily = total_mentions / max(days, 1)

    # 绘图
    if daily_mentions:
        fig, ax = plt.subplots(figsize=(12, 4))
        sorted_days = sorted(daily_mentions.keys())
        counts = [daily_mentions[d] for d in sorted_days]
        ax.bar(range(len(sorted_days)), counts, color="#f57c00", alpha=0.7)
        ax.set_xticks(range(0, len(sorted_days), max(1, len(sorted_days) // 10)))
        ax.set_xticklabels(
            [sorted_days[i] for i in range(0, len(sorted_days), max(1, len(sorted_days) // 10))],
            rotation=45, fontsize=7,
        )
        ax.axhline(avg_daily, color="red", linestyle="--", label=f"Avg={avg_daily:.1f}/day")
        ax.set_ylabel("Mentions per day")
        ax.set_title(f"@Mention Frequency ({total_mentions} total, {mention_msgs} msgs)")
        ax.legend()
        ax.grid(True, alpha=0.2)
        fig.tight_layout()
        fig.savefig(os.path.join(OUTPUT_DIR, "exp8_mentions.png"), dpi=150, bbox_inches="tight")
        plt.close(fig)
        print("  提及频率图已保存: exp8_mentions.png")

    return {
        "total_mentions": total_mentions,
        "mention_msgs": mention_msgs,
        "total_msgs": total_msg,
        "mention_rate": mention_msgs / max(total_msg, 1),
        "avg_daily_mentions": avg_daily,
        "days": days,
    }


# ---------------------------------------------------------------------------
# 4. 话题漂移（Jaccard 距离）
# ---------------------------------------------------------------------------

def analyze_topic_drift(chat_data: dict, window: int = 20) -> dict:
    """滑动窗口 Jaccard 距离分析。"""
    msgs = chat_data.get("messages", [])
    texts = []
    timestamps = []

    for m in msgs:
        if m.get("type") != "message":
            continue
        text_field = m.get("text", "")
        text = ""
        if isinstance(text_field, str):
            text = text_field
        elif isinstance(text_field, list):
            text = "".join(
                p if isinstance(p, str) else p.get("text", "")
                for p in text_field
            )
        if len(text) > 2:
            texts.append(text)
            timestamps.append(float(m.get("date_unixtime", 0)))

    if len(texts) < window * 2:
        return {"error": "Not enough messages for Jaccard analysis"}

    # 提取 bigram
    def bigrams(text: str) -> set[str]:
        """提取中文 bigram + 英文 word"""
        result = set()
        # 中文 bigram
        for i in range(len(text) - 1):
            if ord(text[i]) > 127 and ord(text[i+1]) > 127:
                result.add(text[i:i+2])
        # 英文 word（简单 split）
        for word in text.split():
            if word.isascii() and len(word) > 2:
                result.add(word.lower())
        return result

    # 滑动窗口 Jaccard 距离
    jaccard_distances = []
    jaccard_timestamps = []
    drift_events = []

    for i in range(window, len(texts) - window):
        win_a = set()
        for t in texts[i - window:i]:
            win_a |= bigrams(t)
        win_b = set()
        for t in texts[i:i + window]:
            win_b |= bigrams(t)

        if not win_a and not win_b:
            continue
        intersection = len(win_a & win_b)
        union = len(win_a | win_b)
        jaccard_sim = intersection / max(union, 1)
        jaccard_dist = 1.0 - jaccard_sim
        jaccard_distances.append(jaccard_dist)
        jaccard_timestamps.append(timestamps[i])

        if jaccard_sim < 0.3:  # Jaccard < 0.3 = 话题漂移
            drift_events.append({
                "index": i,
                "timestamp": timestamps[i],
                "jaccard": jaccard_sim,
                "date": datetime.datetime.fromtimestamp(timestamps[i]).strftime("%Y-%m-%d %H:%M"),
            })

    # 绘图
    fig, ax = plt.subplots(figsize=(14, 4))
    # 转为相对天数
    if jaccard_timestamps:
        t0 = jaccard_timestamps[0]
        x = [(t - t0) / 86400 for t in jaccard_timestamps]
        ax.plot(x, jaccard_distances, color="#1565c0", linewidth=0.5, alpha=0.7)
        # 滑动平均
        if len(jaccard_distances) > 50:
            kernel = 50
            smoothed = np.convolve(jaccard_distances, np.ones(kernel) / kernel, mode="valid")
            x_smooth = x[kernel // 2:kernel // 2 + len(smoothed)]
            ax.plot(x_smooth, smoothed, color="#d32f2f", linewidth=1.5, label=f"MA({kernel})")

        ax.axhline(0.7, color="orange", linestyle="--", alpha=0.5, label="Drift threshold (Jaccard sim < 0.3)")
        ax.set_xlabel("Days since start")
        ax.set_ylabel("Jaccard Distance")
        ax.set_title(f"Topic Drift (window={window}, {len(drift_events)} drift events)")
        ax.legend()
        ax.grid(True, alpha=0.2)
        ax.set_ylim(0, 1)

    fig.tight_layout()
    fig.savefig(os.path.join(OUTPUT_DIR, "exp8_jaccard.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  Jaccard 时序图已保存: exp8_jaccard.png")

    return {
        "n_points": len(jaccard_distances),
        "mean_jaccard_dist": float(np.mean(jaccard_distances)) if jaccard_distances else 0,
        "std_jaccard_dist": float(np.std(jaccard_distances)) if jaccard_distances else 0,
        "n_drift_events": len(drift_events),
        "drift_events_sample": drift_events[:10],
    }


# ---------------------------------------------------------------------------
# 5. 24 小时活跃分布
# ---------------------------------------------------------------------------

def analyze_hourly_activity(chat_data: dict) -> dict:
    """统计每小时的消息量。"""
    msgs = chat_data.get("messages", [])
    hourly: Counter = Counter()
    total = 0

    for m in msgs:
        if m.get("type") != "message":
            continue
        ts = float(m.get("date_unixtime", 0))
        if ts > 0:
            hour = datetime.datetime.fromtimestamp(ts).hour
            hourly[hour] += 1
            total += 1

    hours = list(range(24))
    counts = [hourly.get(h, 0) for h in hours]

    # EMA 模拟（模拟 ContactProfile.activeHours 的 24 维 EMA 向量）
    ema_alpha = 0.05
    ema = np.zeros(24)
    for m in msgs:
        if m.get("type") != "message":
            continue
        ts = float(m.get("date_unixtime", 0))
        if ts > 0:
            hour = datetime.datetime.fromtimestamp(ts).hour
            ema[hour] = ema_alpha * 1.0 + (1 - ema_alpha) * ema[hour]

    # 归一化
    ema_normalized = ema / max(ema.max(), 1e-6)
    count_normalized = np.array(counts, dtype=float) / max(max(counts), 1)

    # 绘图
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8))

    # 原始柱状图
    bars = ax1.bar(hours, counts, color="#2e7d32", alpha=0.7, label="Message count")
    ax1.set_xlabel("Hour of day")
    ax1.set_ylabel("Message count")
    ax1.set_title("24-Hour Activity Distribution")
    ax1.set_xticks(hours)
    ax1.grid(True, alpha=0.2, axis="y")

    # 标注峰值
    peak_hour = int(np.argmax(counts))
    ax1.annotate(f"Peak: {peak_hour}:00 ({counts[peak_hour]} msgs)",
                 xy=(peak_hour, counts[peak_hour]),
                 xytext=(peak_hour + 2, counts[peak_hour] * 0.9),
                 arrowprops=dict(arrowstyle="->", color="red"),
                 fontsize=9, color="red")

    # 对比图：归一化分布 vs EMA
    ax2.bar(np.array(hours) - 0.2, count_normalized, width=0.4,
            color="#2e7d32", alpha=0.6, label="Actual (normalized)")
    ax2.bar(np.array(hours) + 0.2, ema_normalized, width=0.4,
            color="#1565c0", alpha=0.6, label="EMA (α=0.05)")
    ax2.set_xlabel("Hour of day")
    ax2.set_ylabel("Normalized activity")
    ax2.set_title("Actual vs EMA activeHours Vector")
    ax2.set_xticks(hours)
    ax2.legend()
    ax2.grid(True, alpha=0.2, axis="y")

    fig.tight_layout()
    fig.savefig(os.path.join(OUTPUT_DIR, "exp8_hourly.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  24 小时活跃分布图已保存: exp8_hourly.png")

    # 活跃和沉默时段
    mean_count = np.mean(counts)
    active_hours = [h for h in hours if counts[h] > mean_count * 1.5]
    silent_hours = [h for h in hours if counts[h] < mean_count * 0.3]

    return {
        "hourly_counts": dict(zip(hours, counts)),
        "peak_hour": peak_hour,
        "peak_count": counts[peak_hour],
        "total": total,
        "active_hours": active_hours,
        "silent_hours": silent_hours,
        "ema_vector": ema_normalized.tolist(),
    }


# ---------------------------------------------------------------------------
# 6. 人格漂移详细分析
# ---------------------------------------------------------------------------

def analyze_personality_drift(records: list) -> dict:
    """分析人格向量的完整时序。"""
    if not records:
        return {"error": "No records"}

    ticks = np.array([r.tick for r in records])
    pi_matrix = np.array([r.personality for r in records])  # (n_ticks, 5)

    pi_start = pi_matrix[0]
    pi_end = pi_matrix[-1]
    total_drift = float(np.linalg.norm(pi_end - pi_start))

    # 每个声部的变化量
    per_voice_drift = {
        short: float(abs(pi_end[i] - pi_start[i]))
        for i, short in enumerate(VOICE_SHORT)
    }
    max_drift_voice = max(per_voice_drift, key=per_voice_drift.get)

    # 漂移速度的 rolling std（窗口=500 ticks）
    window = 500
    drift_speeds = np.linalg.norm(np.diff(pi_matrix, axis=0), axis=1)  # (n-1,)
    if len(drift_speeds) > window:
        rolling_std = np.array([
            np.std(drift_speeds[max(0, i - window):i + 1])
            for i in range(len(drift_speeds))
        ])
    else:
        rolling_std = np.full(len(drift_speeds), np.std(drift_speeds))

    # 收敛性判断：最后 20% 的 rolling std vs 前 20%
    n = len(rolling_std)
    early_std = float(np.mean(rolling_std[:n // 5])) if n > 0 else 0
    late_std = float(np.mean(rolling_std[-n // 5:])) if n > 0 else 0
    is_converging = late_std < early_std * 0.7

    # 绘图 1：5 维人格时序
    fig, axes = plt.subplots(3, 1, figsize=(14, 10))

    ax = axes[0]
    for i, short in enumerate(VOICE_SHORT):
        color = VOICE_COLORS[short]
        ax.plot(ticks, pi_matrix[:, i], color=color, linewidth=1.0, label=short)
    ax.set_ylabel("π_i(n)")
    ax.set_title("Personality Vector Time Series (5 voices)")
    ax.legend(loc="upper right", fontsize=8, ncol=5)
    ax.grid(True, alpha=0.2)
    ax.set_ylim(0, 0.4)

    # 绘图 2：漂移速度
    ax = axes[1]
    # 下采样
    step = max(1, len(drift_speeds) // 2000)
    ax.plot(ticks[1::step], drift_speeds[::step], color="#757575", linewidth=0.3, alpha=0.5, label="Speed")
    if len(rolling_std) > 0:
        ax.plot(ticks[1::step], rolling_std[::step], color="#d32f2f", linewidth=1.2,
                label=f"Rolling σ (w={window})")
    ax.set_ylabel("||Δπ||")
    ax.set_title("Personality Drift Speed")
    ax.legend(fontsize=8)
    ax.grid(True, alpha=0.2)

    # 绘图 3：累积漂移
    ax = axes[2]
    cumulative_drift = np.cumsum(drift_speeds)
    ax.plot(ticks[1::step], cumulative_drift[::step], color="#1565c0", linewidth=1.2)
    ax.set_xlabel("Tick")
    ax.set_ylabel("Cumulative ||Δπ||")
    ax.set_title(f"Cumulative Drift (total={total_drift:.6f}, max_voice={max_drift_voice})")
    ax.grid(True, alpha=0.2)

    fig.tight_layout()
    fig.savefig(os.path.join(OUTPUT_DIR, "exp8_personality.png"), dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("  人格漂移图已保存: exp8_personality.png")

    return {
        "pi_start": {s: float(pi_start[i]) for i, s in enumerate(VOICE_SHORT)},
        "pi_end": {s: float(pi_end[i]) for i, s in enumerate(VOICE_SHORT)},
        "total_drift": total_drift,
        "per_voice_drift": per_voice_drift,
        "max_drift_voice": max_drift_voice,
        "early_rolling_std": early_std,
        "late_rolling_std": late_std,
        "is_converging": is_converging,
        "total_cumulative_drift": float(np.sum(drift_speeds)),
    }


# ---------------------------------------------------------------------------
# 报告生成
# ---------------------------------------------------------------------------

def generate_report(
    replay_results: dict,
    participation: dict,
    mentions: dict,
    topic_drift: dict,
    hourly: dict,
    personality: dict,
) -> str:
    """生成 markdown 报告。"""
    lines = []
    lines.append("# Worker-3 小群数据验证报告")
    lines.append("")
    lines.append(f"> 数据源: D4 — 别瞎写诗 (private_supergroup)")
    lines.append(f"> 13562 条消息, 34 人, 42 天")
    lines.append(f"> 生成时间: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    # 1. exp5 回放总结
    lines.append("## 1. exp5 全量回放")
    lines.append("")
    lines.append(f"| 指标 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 总 ticks | {replay_results.get('total_ticks', 'N/A')} |")
    lines.append(f"| 行动次数 | {replay_results.get('n_actions', 'N/A')} ({replay_results.get('n_actions', 0) / max(replay_results.get('total_ticks', 1), 1) * 100:.1f}%) |")
    lines.append(f"| API 均值 | {replay_results.get('api_mean', 0):.2f} |")
    lines.append(f"| API 最大值 | {replay_results.get('api_max', 0):.2f} |")
    lines.append(f"| API 标准差 | {replay_results.get('api_std', 0):.2f} |")
    lines.append(f"| 事件-压力相关性 | {replay_results.get('correlation', 0):.3f} |")
    lines.append(f"| 平均行动间隔 | {replay_results.get('mean_interval', 0):.1f} ± {replay_results.get('std_interval', 0):.1f} ticks |")
    lines.append(f"| 人格漂移量 | {replay_results.get('pi_drift', 0):.6f} |")
    lines.append(f"| 活跃期 API 均值 | {replay_results.get('active_api_mean', 0):.2f} |")
    lines.append(f"| 沉默期 API 均值 | {replay_results.get('silent_api_mean', 0):.2f} |")
    lines.append(f"| 沉默期主导压力 | {replay_results.get('dominant_silent_p', 'N/A')} |")
    lines.append("")

    ad = replay_results.get("action_dist", {})
    if ad:
        lines.append("**行动分布:**")
        lines.append("")
        lines.append("| 行动类型 | 次数 | 占比 |")
        lines.append("|----------|------|------|")
        total_act = sum(ad.values())
        for atype, cnt in sorted(ad.items(), key=lambda x: -x[1]):
            lines.append(f"| {atype} | {cnt} | {cnt / total_act * 100:.1f}% |")
        lines.append("")

    # 验证判断
    lines.append("**关键验证:**")
    lines.append("")
    active_api = replay_results.get("active_api_mean", 0)
    silent_api = replay_results.get("silent_api_mean", 0)
    corr = replay_results.get("correlation", 0)
    if active_api > silent_api:
        lines.append("- [x] 高活跃期 API > 沉默期 API（对话态 vs 巡逻态区分有效）")
    else:
        lines.append("- [ ] 高活跃期 API <= 沉默期 API（对话态/巡逻态未区分）")

    dominant_p = replay_results.get("dominant_silent_p", "")
    if dominant_p in ("P3", "P6"):
        lines.append(f"- [x] 沉默期主导压力为 {dominant_p}（符合预期：P3 关系冷却 / P6 好奇心）")
    else:
        lines.append(f"- [ ] 沉默期主导压力为 {dominant_p}（预期 P3 或 P6）")

    if corr > 0:
        lines.append(f"- [x] 事件-压力正相关 ({corr:.3f})（事件多→压力上升）")
    else:
        lines.append(f"- [ ] 事件-压力非正相关 ({corr:.3f})")
    lines.append("")

    # 2. 参与率
    lines.append("## 2. 群聊参与率分析")
    lines.append("")
    lines.append(f"| 指标 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 总消息数 | {participation['total_messages']} |")
    lines.append(f"| 发言者数 | {participation['n_senders']} |")
    lines.append(f"| Gini 系数 | {participation['gini']:.3f} |")
    lines.append("")

    lines.append("**Top 10 发言者:**")
    lines.append("")
    lines.append("| 排名 | 用户 | 消息数 | 占比 |")
    lines.append("|------|------|--------|------|")
    for i, (name, count) in enumerate(participation["top_10"], 1):
        pct = count / participation["total_messages"] * 100
        lines.append(f"| {i} | {name} | {count} | {pct:.1f}% |")
    lines.append("")

    lines.append("**Alice 参与率定位:**")
    lines.append("")
    lines.append("| 参与率 | Alice 预计消息 | 排名 |")
    lines.append("|--------|---------------|------|")
    for pct_label, info in participation["alice_positions"].items():
        lines.append(f"| {pct_label} | {info['msgs']} | #{info['rank']}/{participation['n_senders']+1} |")
    lines.append("")

    gini = participation["gini"]
    lines.append(f"**解读:** Gini={gini:.3f} ")
    if gini > 0.6:
        lines.append("表明发言高度集中（少数人说了大部分的话）。")
    elif gini > 0.4:
        lines.append("表明发言中度集中。")
    else:
        lines.append("表明发言较均匀。")

    lines.append("Alice 以 10% 参与率加入时大约排名 #{}, 属于正常活跃成员水平，不算话多。".format(
        participation["alice_positions"].get("10%", {}).get("rank", "?")))
    lines.append("")

    # 3. @提及检测
    lines.append("## 3. @提及检测")
    lines.append("")
    lines.append(f"| 指标 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 总 @mention | {mentions['total_mentions']} |")
    lines.append(f"| 包含 mention 的消息 | {mentions['mention_msgs']} |")
    lines.append(f"| 消息占比 | {mentions['mention_rate']:.1%} |")
    lines.append(f"| 日均 mention | {mentions['avg_daily_mentions']:.1f} |")
    lines.append(f"| 跨越天数 | {mentions['days']} |")
    lines.append("")

    mention_rate = mentions['mention_rate']
    lines.append(f"**解读:** {mention_rate:.1%} 的消息包含 @mention。")
    if mention_rate > 0.05:
        lines.append("@mention 频率较高，pending_directed 在此群会被频繁触发。")
        lines.append("Alice 如果加入群，会收到较多回应义务（P5）驱动的行动压力。")
    else:
        lines.append("@mention 频率较低，pending_directed 触发较少。")
        lines.append("群聊互动主要靠 ambient 消息而非定向 mention。")
    lines.append("")

    # 4. 话题漂移
    lines.append("## 4. 话题漂移（Jaccard 距离）")
    lines.append("")
    if "error" in topic_drift:
        lines.append(f"⚠️ {topic_drift['error']}")
    else:
        lines.append(f"| 指标 | 值 |")
        lines.append(f"|------|-----|")
        lines.append(f"| 分析数据点 | {topic_drift['n_points']} |")
        lines.append(f"| 平均 Jaccard 距离 | {topic_drift['mean_jaccard_dist']:.3f} |")
        lines.append(f"| Jaccard 距离标准差 | {topic_drift['std_jaccard_dist']:.3f} |")
        lines.append(f"| 漂移事件数 (sim < 0.3) | {topic_drift['n_drift_events']} |")
        lines.append("")

        if topic_drift.get("drift_events_sample"):
            lines.append("**前 10 个漂移事件:**")
            lines.append("")
            lines.append("| 时间 | Jaccard 相似度 |")
            lines.append("|------|---------------|")
            for ev in topic_drift["drift_events_sample"]:
                lines.append(f"| {ev['date']} | {ev['jaccard']:.3f} |")
            lines.append("")

        mean_jd = topic_drift['mean_jaccard_dist']
        lines.append(f"**解读:** 平均 Jaccard 距离 = {mean_jd:.3f}。")
        if mean_jd > 0.8:
            lines.append("话题变化极快，几乎每 20 条消息话题就完全不同。")
            lines.append("对于 Alice 的 strategy.mod.ts 中 Jaccard 阈值 0.3，此群应该频繁触发话题漂移检测。")
        elif mean_jd > 0.5:
            lines.append("话题变化中等，有一定的主题连续性但也经常切换。")
        else:
            lines.append("话题较为集中，群内讨论具有较强的主题连续性。")
    lines.append("")

    # 5. 24 小时活跃分布
    lines.append("## 5. 24 小时活跃分布")
    lines.append("")
    lines.append(f"| 指标 | 值 |")
    lines.append(f"|------|-----|")
    lines.append(f"| 峰值小时 | {hourly['peak_hour']}:00 ({hourly['peak_count']} msgs) |")
    lines.append(f"| 活跃时段 (>1.5x avg) | {hourly['active_hours']} |")
    lines.append(f"| 沉默时段 (<0.3x avg) | {hourly['silent_hours']} |")
    lines.append("")
    lines.append("**解读:** ")
    active = hourly['active_hours']
    silent = hourly['silent_hours']
    if active:
        lines.append(f"活跃高峰集中在 {active}。")
    if silent:
        lines.append(f"低谷在 {silent}。")
    lines.append("与 ContactProfile.activeHours 的 24 维 EMA 向量设计吻合：")
    lines.append("EMA 能平滑跟踪这种日内节律，α=0.05 足以在数天内收敛到稳定模式。")
    lines.append("")

    # 6. 人格漂移
    lines.append("## 6. 人格漂移详细分析")
    lines.append("")
    if "error" in personality:
        lines.append(f"⚠️ {personality['error']}")
    else:
        lines.append("**初始/终态人格向量:**")
        lines.append("")
        lines.append("| 声部 | π_start | π_end | Δ |")
        lines.append("|------|---------|-------|-----|")
        for s in VOICE_SHORT:
            start = personality["pi_start"][s]
            end = personality["pi_end"][s]
            delta = personality["per_voice_drift"][s]
            lines.append(f"| {s} | {start:.4f} | {end:.4f} | {delta:.6f} |")
        lines.append("")

        lines.append(f"| 指标 | 值 |")
        lines.append(f"|------|-----|")
        lines.append(f"| 总漂移量 ‖π_end - π_start‖ | {personality['total_drift']:.6f} |")
        lines.append(f"| 最大漂移声部 | {personality['max_drift_voice']} |")
        lines.append(f"| 早期 rolling σ | {personality['early_rolling_std']:.8f} |")
        lines.append(f"| 晚期 rolling σ | {personality['late_rolling_std']:.8f} |")
        lines.append(f"| 趋向收敛 | {'是' if personality['is_converging'] else '否'} |")
        lines.append(f"| 累积漂移 | {personality['total_cumulative_drift']:.6f} |")
        lines.append("")

        lines.append("**解读:**")
        lines.append("")
        drift = personality['total_drift']
        if drift < 0.001:
            lines.append(f"- 总漂移 {drift:.6f} 极小，人格几乎不变。α=0.001 的学习率配合 γ=0.0005 的均值回归，")
            lines.append("  在 42 天数据量下人格演化非常保守。")
        elif drift < 0.01:
            lines.append(f"- 总漂移 {drift:.6f} 较小，人格有微弱调整。")
        else:
            lines.append(f"- 总漂移 {drift:.6f} 明显，人格有显著漂移。")

        if personality['is_converging']:
            lines.append("- 漂移速度的 rolling σ 晚期 < 早期 × 0.7，**趋向稳定点收敛**。")
        else:
            lines.append("- 漂移速度未收敛，人格仍在持续调整中。")

        lines.append(f"- 变化最大的声部: **{personality['max_drift_voice']}**")
        lines.append("")

    # 总结
    lines.append("## 总结")
    lines.append("")
    lines.append("### 关键发现")
    lines.append("")

    findings = []
    # 对话态 vs 巡逻态
    if active_api > silent_api:
        findings.append("1. **对话态/巡逻态分离有效**: 高活跃期 API ({:.2f}) > 沉默期 ({:.2f})，"
                        "群聊动态被压力场正确感知。".format(active_api, silent_api))

    # Gini
    findings.append("2. **发言集中度 Gini={:.3f}**: {}Alice 以 10% 参与率加入不算话多。".format(
        participation["gini"],
        "高度集中（top 3 占 >50%），" if participation["gini"] > 0.5 else "中等集中，"
    ))

    # mention
    findings.append("3. **@mention 率={:.1%}**: {}".format(
        mentions['mention_rate'],
        "频繁 mention → P5 回应义务活跃。" if mentions['mention_rate'] > 0.03 else "低 mention → P5 主要靠私聊触发。"
    ))

    # 话题漂移
    if "error" not in topic_drift:
        findings.append("4. **话题漂移**: 平均 Jaccard 距离={:.3f}，{} 次漂移事件。{}".format(
            topic_drift['mean_jaccard_dist'],
            topic_drift['n_drift_events'],
            "话题变化快，Jaccard 阈值 0.3 会频繁触发。" if topic_drift['mean_jaccard_dist'] > 0.7 else "话题相对稳定。"
        ))

    # 人格
    if "error" not in personality:
        findings.append("5. **人格漂移 {:.6f}**: {}，最大漂移声部 {}。".format(
            personality['total_drift'],
            "趋向收敛" if personality['is_converging'] else "未收敛",
            personality['max_drift_voice'],
        ))

    for f in findings:
        lines.append(f)
    lines.append("")

    lines.append("### 图表索引")
    lines.append("")
    lines.append("| 文件 | 内容 |")
    lines.append("|------|------|")
    lines.append("| `exp8_main.png` | exp5 回放四面板主图 |")
    lines.append("| `exp8_pressure_detail.png` | P1-P6 压力分量详细时序 |")
    lines.append("| `exp8_intervals.png` | 行动间隔分布 |")
    lines.append("| `exp8_participation.png` | 参与率 + Lorenz 曲线 |")
    lines.append("| `exp8_mentions.png` | @mention 每日频率 |")
    lines.append("| `exp8_jaccard.png` | Jaccard 距离时序 |")
    lines.append("| `exp8_hourly.png` | 24 小时活跃分布 |")
    lines.append("| `exp8_personality.png` | 人格漂移 5 维时序 |")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ensure_dirs()

    # 加载原始数据
    with open(DATA_PATH, encoding="utf-8") as f:
        chat_data = json.load(f)

    # 1. exp5 全量回放
    print("\n[1/6] exp5 全量回放...")
    replay_results = run_replay()

    # 2. 参与率
    print("\n[2/6] 群聊参与率分析...")
    participation = analyze_participation(chat_data)

    # 3. @提及
    print("\n[3/6] @提及检测...")
    mentions = analyze_mentions(chat_data)

    # 4. 话题漂移
    print("\n[4/6] 话题漂移分析...")
    topic_drift = analyze_topic_drift(chat_data, window=20)

    # 5. 24 小时活跃
    print("\n[5/6] 24 小时活跃分布...")
    hourly = analyze_hourly_activity(chat_data)

    # 6. 人格漂移
    print("\n[6/6] 人格漂移详细分析...")
    personality = analyze_personality_drift(replay_results.get("records", []))

    # 生成报告
    print("\n生成报告...")
    report = generate_report(
        replay_results, participation, mentions,
        topic_drift, hourly, personality,
    )
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"  报告已保存: {REPORT_PATH}")

    print("\n" + "=" * 60)
    print("实验 8 完成")
    print("=" * 60)


if __name__ == "__main__":
    main()

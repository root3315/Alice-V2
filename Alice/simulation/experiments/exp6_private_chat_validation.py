"""实验 6：1:1 私聊数据验证 — P3/P5/Tier/遗忘曲线参数合理性。

用两份真实 Telegram 私聊导出数据验证 Alice 压力场模型参数：
- D1: private_chat_1 — 1123 条, 2 人, ~202 天
- D2: private_chat_2 — 2374 条, 2 人, ~1022 天

验证项：
1. P3 关系冷却：消息间隔分布 vs sigmoid(silence, θ, β) 响应
2. P5 回复义务：响应时间分布 vs decay(age) 衰减
3. Tier 推断：_infer_dunbar_tier 在 1:1 私聊中的合理性
4. 遗忘曲线：关键词重现间隔 vs R(t) = (1 + Δt/(9*S))^d
5. 消息密度时序图
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
from scipy import stats

# ---------------------------------------------------------------------------
# 常量（从 runtime TypeScript 逐字搬运）
# ---------------------------------------------------------------------------

# P3 参数
DUNBAR_TIER_THETA = {5: 20.0, 15: 30.0, 50: 40.0, 150: 80.0, 500: 200.0}
DUNBAR_TIER_WEIGHT = {5: 5.0, 15: 3.0, 50: 1.5, 150: 0.8, 500: 0.3}
BETA_SIGMOID = 0.15

# P5 参数
CHAT_TYPE_RESPONSE_WEIGHT = {"private": 2.0, "group": 1.0, "supergroup": 0.8, "channel": 0.3}
P5_DECAY_HALF_LIFE = 10.0  # ticks

# 遗忘曲线参数
FACT_DECAY_D = -0.5
FACT_INITIAL_STABILITY = 1.0
FACT_CONSOLIDATION_FACTOR = 1.2
FACT_FORGET_THRESHOLD = 0.2

# Tier 演化参数
EXPECTED_FREQUENCY = {5: 20, 15: 12, 50: 6, 150: 2, 500: 1}  # 每 100 ticks
TIER_EVAL_INTERVAL = 100
TIER_UPGRADE_THRESHOLD = 0.7
TIER_DOWNGRADE_THRESHOLD = 0.3

# tick 设定：1 tick = 1 分钟
TICK_RATE_SECONDS = 60.0


def sigmoid(x: float, beta: float, theta: float) -> float:
    exponent = -beta * (x - theta)
    clipped = max(-50.0, min(50.0, exponent))
    return 1.0 / (1.0 + np.exp(clipped))


def retrievability(delta_ticks: float, stability: float = 1.0, d: float = -0.5) -> float:
    return (1.0 + delta_ticks / (9.0 * max(stability, 1e-6))) ** d


def p5_decay(age_ticks: float) -> float:
    return 1.0 / (1.0 + age_ticks / P5_DECAY_HALF_LIFE)


# ---------------------------------------------------------------------------
# 数据加载
# ---------------------------------------------------------------------------

@dataclass
class Message:
    timestamp: float
    sender: str
    text: str
    reply_to: int | None
    msg_id: int


def _extract_text(text_field) -> str:
    if isinstance(text_field, str):
        return text_field
    if isinstance(text_field, list):
        parts = []
        for part in text_field:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                parts.append(part.get("text", ""))
        return "".join(parts)
    return ""


def load_chat(path: str) -> tuple[list[Message], dict]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    messages = []
    for m in data.get("messages", []):
        if m.get("type") != "message":
            continue
        ts = float(m.get("date_unixtime", 0))
        sender = m.get("from", "") or m.get("from_id", "")
        text = _extract_text(m.get("text", ""))
        reply_to = m.get("reply_to_message_id")
        msg_id = m.get("id", 0)
        messages.append(Message(ts, sender, text, reply_to, msg_id))
    messages.sort(key=lambda m: m.timestamp)
    meta = {
        "name": data.get("name", "unknown"),
        "type": data.get("type", "unknown"),
        "id": data.get("id", 0),
    }
    return messages, meta


# ---------------------------------------------------------------------------
# 1. P3 关系冷却验证
# ---------------------------------------------------------------------------

def analyze_p3(messages: list[Message], label: str) -> dict:
    """分析消息间隔分布，评估 P3 sigmoid 参数合理性。"""
    if len(messages) < 2:
        return {}

    # 计算所有消息间的间隔（分钟 = ticks）
    gaps_minutes = []
    for i in range(1, len(messages)):
        gap_sec = messages[i].timestamp - messages[i - 1].timestamp
        gaps_minutes.append(gap_sec / 60.0)

    gaps = np.array(gaps_minutes)

    # 基本统计
    result = {
        "label": label,
        "total_messages": len(messages),
        "total_gaps": len(gaps),
        "median_gap_min": float(np.median(gaps)),
        "mean_gap_min": float(np.mean(gaps)),
        "p25_gap_min": float(np.percentile(gaps, 25)),
        "p75_gap_min": float(np.percentile(gaps, 75)),
        "p90_gap_min": float(np.percentile(gaps, 90)),
        "p95_gap_min": float(np.percentile(gaps, 95)),
        "max_gap_min": float(np.max(gaps)),
    }

    # 对各 tier 的 θ，计算在真实间隔分布下 P3 sigmoid 的取值分布
    tier_analysis = {}
    for tier, theta in DUNBAR_TIER_THETA.items():
        w = DUNBAR_TIER_WEIGHT[tier]
        cooling_values = np.array([sigmoid(g, BETA_SIGMOID, theta) for g in gaps])
        weighted = w * cooling_values
        tier_analysis[tier] = {
            "theta": theta,
            "weight": w,
            "cooling_median": float(np.median(cooling_values)),
            "cooling_mean": float(np.mean(cooling_values)),
            "cooling_p25": float(np.percentile(cooling_values, 25)),
            "cooling_p75": float(np.percentile(cooling_values, 75)),
            "weighted_mean": float(np.mean(weighted)),
            "pct_above_half": float(np.mean(cooling_values > 0.5) * 100),
            "pct_above_0_9": float(np.mean(cooling_values > 0.9) * 100),
        }
    result["tier_analysis"] = tier_analysis

    # 间隔分桶
    bins = [0, 1, 5, 10, 30, 60, 120, 360, 720, 1440, 4320, 10080, float("inf")]
    bin_labels = ["<1m", "1-5m", "5-10m", "10-30m", "30m-1h", "1-2h", "2-6h",
                  "6-12h", "12-24h", "1-3d", "3-7d", ">7d"]
    hist, _ = np.histogram(gaps, bins=bins)
    result["gap_distribution"] = dict(zip(bin_labels, [int(h) for h in hist]))

    return result


# ---------------------------------------------------------------------------
# 2. P5 回复义务验证
# ---------------------------------------------------------------------------

def analyze_p5(messages: list[Message], label: str) -> dict:
    """分析 A→B 回复响应时间，评估 P5 decay 参数合理性。"""
    senders = list(set(m.sender for m in messages))
    if len(senders) != 2:
        return {"error": f"expected 2 senders, got {len(senders)}"}

    # 为每对 (A→B) 计算响应时间
    response_times = {s: [] for s in senders}

    # 简单方法：当 sender 切换时，记录时间差
    for i in range(1, len(messages)):
        prev, curr = messages[i - 1], messages[i]
        if prev.sender != curr.sender:
            gap_min = (curr.timestamp - prev.timestamp) / 60.0
            response_times[curr.sender].append(gap_min)

    result = {"label": label, "senders": senders}
    for sender, times in response_times.items():
        if not times:
            continue
        t = np.array(times)
        decay_at_response = np.array([p5_decay(rt) for rt in t])

        result[f"response_{sender}"] = {
            "count": len(t),
            "median_min": float(np.median(t)),
            "mean_min": float(np.mean(t)),
            "p75_min": float(np.percentile(t, 75)),
            "p90_min": float(np.percentile(t, 90)),
            "p95_min": float(np.percentile(t, 95)),
            "pct_under_1h": float(np.mean(t < 60) * 100),
            "pct_over_1h": float(np.mean(t >= 60) * 100),
            "pct_over_6h": float(np.mean(t >= 360) * 100),
            "pct_over_24h": float(np.mean(t >= 1440) * 100),
            "decay_at_response_median": float(np.median(decay_at_response)),
            "decay_at_response_mean": float(np.mean(decay_at_response)),
            "decay_below_0_1": float(np.mean(decay_at_response < 0.1) * 100),
        }

    # P5 加权值随时间推移（private chat weight=2.0, tier weight varies）
    # 典型场景：tier 15（好友），private chat
    # P5 = directed * w_tier * w_chat * decay
    # directed=1, w_tier=3.0 (tier 15), w_chat=2.0, decay=1/(1+age/10)
    all_response = []
    for times in response_times.values():
        all_response.extend(times)
    if all_response:
        t = np.array(sorted(all_response))
        # 模拟 P5 值在不同 tier 下
        p5_scenarios = {}
        for tier in [5, 15, 50]:
            w_tier = DUNBAR_TIER_WEIGHT[tier]
            w_chat = CHAT_TYPE_RESPONSE_WEIGHT["private"]
            p5_vals = np.array([1.0 * w_tier * w_chat * p5_decay(rt) for rt in t])
            p5_scenarios[f"tier_{tier}"] = {
                "p5_median": float(np.median(p5_vals)),
                "p5_mean": float(np.mean(p5_vals)),
                "p5_max": float(np.max(p5_vals)),
                "p5_at_p50_response": float(1.0 * w_tier * w_chat * p5_decay(np.median(t))),
                "p5_at_p90_response": float(1.0 * w_tier * w_chat * p5_decay(np.percentile(t, 90))),
            }
        result["p5_scenarios"] = p5_scenarios

    return result


# ---------------------------------------------------------------------------
# 3. Tier 推断验证
# ---------------------------------------------------------------------------

def analyze_tier(messages: list[Message], label: str) -> dict:
    """验证 _infer_dunbar_tier 在 1:1 私聊中的合理性。"""
    sender_counts = Counter(m.sender for m in messages)
    total = sum(sender_counts.values())

    # 时间跨度
    days = (messages[-1].timestamp - messages[0].timestamp) / 86400.0
    msgs_per_day = total / max(days, 1)

    result = {
        "label": label,
        "total_messages": total,
        "days_span": round(days, 1),
        "msgs_per_day": round(msgs_per_day, 2),
        "sender_breakdown": {},
    }

    for sender, count in sender_counts.items():
        ratio = count / total
        # 复制 _infer_dunbar_tier 逻辑
        if ratio > 0.10:
            inferred_tier = 5
        elif ratio > 0.03:
            inferred_tier = 15
        elif ratio > 0.01:
            inferred_tier = 50
        elif ratio > 0.003:
            inferred_tier = 150
        else:
            inferred_tier = 500

        result["sender_breakdown"][sender] = {
            "count": count,
            "ratio": round(ratio, 4),
            "inferred_tier": inferred_tier,
        }

    # 关键问题：1:1 私聊中两人的 ratio 都很高（接近 50%），永远会推断为 tier 5
    # 但真实频率可能很低（比如 D2 只有 2.3 条/天 跨 1022 天）
    # 这需要交叉验证
    result["issue_ratio_only"] = (
        "在 1:1 私聊中 ratio ≈ 0.5，始终推断 tier 5（亲密圈）。"
        "但 D2 仅 2.3 条/天且跨 1022 天，频率不一定支持 tier 5。"
        "建议：tier 推断应同时考虑绝对频率（msgs/day）和时间跨度。"
    )

    # Tier 演化维度分析：如果真实数据只靠频率维度
    # interactionCount 在 100 ticks (100 分钟) 窗口内
    # D1: 5.6 msgs/day ≈ 0.39 msgs/100min — expected for tier 5 is 20 → frequency=0.02
    # D2: 2.3 msgs/day ≈ 0.16 msgs/100min — expected for tier 5 is 20 → frequency=0.008
    window_ticks = 100
    window_seconds = window_ticks * TICK_RATE_SECONDS
    # 计算 100 分钟窗口内的平均消息数
    interactions_per_window = msgs_per_day * window_seconds / 86400.0

    tier_score_analysis = {}
    for tier in [5, 15, 50, 150]:
        expected = EXPECTED_FREQUENCY.get(tier, 2)
        freq_score = min(1.0, interactions_per_window / expected)
        # 假设 quality=0.5, depth=0.3（中等水平）
        mock_score = 0.4 * freq_score + 0.3 * 0.5 + 0.3 * 0.3
        tier_score_analysis[f"tier_{tier}"] = {
            "expected_per_100t": expected,
            "actual_per_100t": round(interactions_per_window, 3),
            "frequency_score": round(freq_score, 4),
            "mock_tier_score": round(mock_score, 4),
            "would_upgrade": mock_score >= TIER_UPGRADE_THRESHOLD,
            "would_downgrade": mock_score <= TIER_DOWNGRADE_THRESHOLD,
        }
    result["tier_evolution"] = tier_score_analysis

    return result


# ---------------------------------------------------------------------------
# 4. 遗忘曲线验证
# ---------------------------------------------------------------------------

def analyze_forgetting(messages: list[Message], label: str) -> dict:
    """用关键词重现检测模拟遗忘曲线。"""
    # 提取有意义的词（长度 >= 3，排除常见停用词）
    # 对中俄混合文本，用简单分词
    stop_words = {
        "the", "and", "for", "that", "this", "with", "you", "are", "was", "have",
        "что", "это", "как", "или", "для", "так", "все", "вот", "мне", "тут",
        "的", "了", "是", "在", "我", "有", "和", "不", "这", "就",
        "http", "https", "www", "com",
    }

    # 按天聚合关键词
    day_keywords: dict[int, set[str]] = defaultdict(set)  # day_index → keywords
    t0 = messages[0].timestamp

    for m in messages:
        day_idx = int((m.timestamp - t0) / 86400)
        # 简单分词：按空格和标点
        words = re.findall(r'[a-zA-Zа-яА-Я\u4e00-\u9fff]{3,}', m.text.lower())
        for w in words:
            if w not in stop_words and len(w) >= 3:
                day_keywords[day_idx].add(w)

    # 寻找关键词重现：同一关键词在 day_i 和 day_j (j>i) 都出现
    # 构建 keyword → [day_indices]
    keyword_days: dict[str, list[int]] = defaultdict(list)
    for day_idx in sorted(day_keywords.keys()):
        for kw in day_keywords[day_idx]:
            keyword_days[kw].append(day_idx)

    # 只保留出现 >= 2 次的关键词
    recurrence_gaps_days = []
    for kw, days in keyword_days.items():
        if len(days) < 2:
            continue
        for i in range(1, len(days)):
            gap = days[i] - days[i - 1]
            if gap > 0:
                recurrence_gaps_days.append(gap)

    if not recurrence_gaps_days:
        return {"label": label, "error": "no keyword recurrences found"}

    gaps = np.array(recurrence_gaps_days)
    gap_ticks = gaps * 24 * 60  # 转换为 ticks（分钟）

    # 经验概率：在给定 Δt（天）后仍能重现的比例
    # 按时间窗口分桶
    day_bins = [0, 1, 3, 7, 14, 30, 60, 90, 180, 365, float("inf")]
    day_labels = ["<1d", "1-3d", "3-7d", "1-2w", "2w-1m", "1-2m", "2-3m", "3-6m", "6m-1y", ">1y"]
    hist, _ = np.histogram(gaps, bins=day_bins)

    # 理论 R(t) 在不同 Δt 下的值
    theory = {}
    sample_deltas_days = [1, 3, 7, 14, 30, 60, 90, 180, 365]
    for d in sample_deltas_days:
        delta_ticks = d * 24 * 60  # 天 → 分钟(ticks)
        r_base = retrievability(delta_ticks, stability=1.0)
        r_consolidated = retrievability(delta_ticks, stability=1.2**3)  # 3 次巩固
        theory[f"{d}d"] = {
            "R_base": round(r_base, 4),
            "R_3x_recall": round(r_consolidated, 4),
            "forget_threshold_reached": r_base < FACT_FORGET_THRESHOLD,
        }

    # 找到 R=0.2 的临界点（stability=1.0 时）
    # R = (1 + Δt/(9*S))^d = 0.2
    # (1 + Δt/9)^(-0.5) = 0.2
    # 1 + Δt/9 = 0.2^(-2) = 25
    # Δt = 24 * 9 = 216 ticks = 216 分钟 ≈ 3.6 小时
    critical_ticks = 9 * (FACT_FORGET_THRESHOLD ** (1 / FACT_DECAY_D) - 1)
    critical_hours = critical_ticks / 60

    # 不同 stability 的临界时间
    stability_critical = {}
    for s_label, s_val in [("s=1.0", 1.0), ("s=1.2", 1.2), ("s=1.44", 1.44),
                            ("s=1.73", 1.73), ("s=2.0", 2.0), ("s=3.0", 3.0)]:
        ct = 9 * s_val * (FACT_FORGET_THRESHOLD ** (1 / FACT_DECAY_D) - 1)
        stability_critical[s_label] = {
            "critical_ticks": round(ct, 1),
            "critical_hours": round(ct / 60, 2),
            "critical_days": round(ct / 60 / 24, 2),
        }

    result = {
        "label": label,
        "unique_keywords": len(keyword_days),
        "recurring_keywords": len([k for k, v in keyword_days.items() if len(v) >= 2]),
        "total_recurrence_gaps": len(gaps),
        "gap_distribution_days": dict(zip(day_labels, [int(h) for h in hist])),
        "median_gap_days": float(np.median(gaps)),
        "mean_gap_days": float(np.mean(gaps)),
        "theory_R": theory,
        "critical_point_base": {
            "ticks": round(critical_ticks, 1),
            "hours": round(critical_hours, 2),
            "note": "stability=1.0 时 R=0.2 的临界点（分钟）",
        },
        "stability_critical_points": stability_critical,
    }

    return result


# ---------------------------------------------------------------------------
# 5. 消息密度时序图
# ---------------------------------------------------------------------------

def plot_message_density(messages: list[Message], label: str, output_path: str):
    """绘制日级别消息数量图。"""
    if not messages:
        return

    t0 = messages[0].timestamp
    days = [(m.timestamp - t0) / 86400.0 for m in messages]

    # 按天聚合
    day_counts = Counter(int(d) for d in days)
    max_day = int(max(days)) + 1

    x_days = list(range(max_day))
    y_counts = [day_counts.get(d, 0) for d in x_days]

    # 转换为日期
    base_date = datetime.fromtimestamp(t0, tz=timezone.utc)
    x_dates = [datetime.fromtimestamp(t0 + d * 86400, tz=timezone.utc) for d in x_days]

    fig, axes = plt.subplots(3, 1, figsize=(16, 12), gridspec_kw={"height_ratios": [3, 2, 2]})
    fig.suptitle(f"Exp6: {label} — Message Density Analysis", fontsize=14, fontweight="bold")

    # (a) 日消息数
    ax = axes[0]
    ax.bar(x_dates, y_counts, width=1.0, color="#4A90D9", alpha=0.7, label="Daily messages")
    # 7 天移动平均
    window = 7
    if len(y_counts) > window:
        moving_avg = np.convolve(y_counts, np.ones(window) / window, mode="valid")
        ma_dates = x_dates[window - 1:]
        ax.plot(ma_dates, moving_avg, color="#E74C3C", linewidth=2, label=f"{window}-day MA")

    # 标注沉默期（连续 3+ 天无消息）
    silence_start = None
    for i, c in enumerate(y_counts):
        if c == 0:
            if silence_start is None:
                silence_start = i
        else:
            if silence_start is not None and i - silence_start >= 3:
                ax.axvspan(x_dates[silence_start], x_dates[i - 1],
                          alpha=0.15, color="red", label="Silence ≥3d" if silence_start == 0 or i == len(y_counts) - 1 else "")
            silence_start = None
    # 处理末尾沉默
    if silence_start is not None and max_day - silence_start >= 3:
        ax.axvspan(x_dates[silence_start], x_dates[-1], alpha=0.15, color="red")

    ax.set_ylabel("Messages / day")
    ax.set_title("Daily Message Count")
    ax.legend(loc="upper right", fontsize=8)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=2))
    fig.autofmt_xdate()

    # (b) 消息间隔分布（对数直方图）
    ax = axes[1]
    gaps_hours = []
    for i in range(1, len(messages)):
        gap_h = (messages[i].timestamp - messages[i - 1].timestamp) / 3600.0
        gaps_hours.append(gap_h)

    if gaps_hours:
        log_gaps = np.log10(np.array(gaps_hours) + 0.01)
        ax.hist(log_gaps, bins=60, color="#2ECC71", alpha=0.7, edgecolor="white")
        # 标注 tier θ 位置
        for tier, theta_min in DUNBAR_TIER_THETA.items():
            theta_h = theta_min / 60.0
            ax.axvline(np.log10(theta_h), color="gray", linestyle="--", alpha=0.6)
            ax.text(np.log10(theta_h), ax.get_ylim()[1] * 0.9, f"θ(t{tier})={theta_min}m",
                    fontsize=7, rotation=90, va="top", ha="right")
    ax.set_xlabel("log10(gap hours)")
    ax.set_ylabel("Count")
    ax.set_title("Message Gap Distribution (log scale)")

    # (c) P3 sigmoid 响应在真实间隔下的 CDF
    ax = axes[2]
    if gaps_hours:
        gaps_min = np.array(gaps_hours) * 60.0
        for tier in [5, 15, 50, 150]:
            theta = DUNBAR_TIER_THETA[tier]
            cooling = np.array([sigmoid(g, BETA_SIGMOID, theta) for g in gaps_min])
            sorted_c = np.sort(cooling)
            cdf = np.arange(1, len(sorted_c) + 1) / len(sorted_c)
            ax.plot(sorted_c, cdf, label=f"Tier {tier} (θ={theta}m)", linewidth=1.5)
        ax.axvline(0.5, color="gray", linestyle=":", alpha=0.5)
        ax.set_xlabel("P3 cooling value")
        ax.set_ylabel("CDF")
        ax.set_title("P3 Sigmoid Response CDF under Real Gap Distribution")
        ax.legend(fontsize=8)

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {output_path}")


# ---------------------------------------------------------------------------
# P5 响应时间分布图
# ---------------------------------------------------------------------------

def plot_p5_response(messages: list[Message], label: str, output_path: str):
    """绘制 P5 相关的响应时间分析图。"""
    senders = list(set(m.sender for m in messages))
    if len(senders) != 2:
        return

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle(f"Exp6: {label} — P5 Response Obligation Analysis", fontsize=14, fontweight="bold")

    # 计算响应时间
    response_times_by_sender: dict[str, list[float]] = {s: [] for s in senders}
    for i in range(1, len(messages)):
        prev, curr = messages[i - 1], messages[i]
        if prev.sender != curr.sender:
            gap_min = (curr.timestamp - prev.timestamp) / 60.0
            response_times_by_sender[curr.sender].append(gap_min)

    all_response_min = []
    for times in response_times_by_sender.values():
        all_response_min.extend(times)

    if not all_response_min:
        plt.close(fig)
        return

    # (a) 响应时间分布直方图
    ax = axes[0, 0]
    for i, (sender, times) in enumerate(response_times_by_sender.items()):
        if times:
            short_name = sender[:12]
            ax.hist(np.log10(np.array(times) + 0.01), bins=40, alpha=0.6,
                    label=f"{short_name} (n={len(times)})")
    ax.set_xlabel("log10(response time, minutes)")
    ax.set_ylabel("Count")
    ax.set_title("Response Time Distribution")
    ax.legend(fontsize=8)

    # (b) P5 decay 在真实响应时间下的值
    ax = axes[0, 1]
    t_arr = np.array(sorted(all_response_min))
    decay_vals = np.array([p5_decay(t) for t in t_arr])
    ax.plot(t_arr, decay_vals, ".", markersize=2, alpha=0.5, color="#3498DB")
    # 理论曲线
    t_theory = np.linspace(0, min(t_arr.max(), 1440 * 7), 500)
    d_theory = np.array([p5_decay(t) for t in t_theory])
    ax.plot(t_theory, d_theory, "-", color="#E74C3C", linewidth=2, label="decay = 1/(1+t/10)")
    ax.axhline(0.1, color="gray", linestyle=":", alpha=0.5, label="decay = 0.1")
    ax.set_xlabel("Response time (minutes)")
    ax.set_ylabel("P5 decay factor")
    ax.set_title("P5 Decay at Actual Response Times")
    ax.set_xscale("log")
    ax.legend(fontsize=8)

    # (c) 累积 P5 值时间序列（模拟）
    ax = axes[1, 0]
    # 模拟一段时间内 P5 的累积
    # 每当 A 发消息给 B 且 B 未回复时，pending_directed++
    # B 回复时 pending_directed = 0
    # P5 = pending * w_tier * w_chat * decay
    w_tier = DUNBAR_TIER_WEIGHT[15]  # 假设 tier 15
    w_chat = CHAT_TYPE_RESPONSE_WEIGHT["private"]
    p5_timeline = []
    pending = 0
    last_directed_tick = 0
    last_sender = messages[0].sender

    for m in messages:
        tick = (m.timestamp - messages[0].timestamp) / TICK_RATE_SECONDS
        if m.sender != last_sender:
            if pending > 0:
                # 收到回复，P5 释放
                pending = 0
            pending = 1
            last_directed_tick = tick
        else:
            pending += 1
            last_directed_tick = tick

        age = max(tick - last_directed_tick, 0.01)
        p5_val = pending * w_tier * w_chat * p5_decay(age)
        p5_timeline.append((tick / (60 * 24), p5_val))  # tick → days
        last_sender = m.sender

    if p5_timeline:
        days_t, p5_t = zip(*p5_timeline)
        ax.plot(days_t, p5_t, "-", linewidth=0.5, alpha=0.7, color="#9B59B6")
        ax.set_xlabel("Days")
        ax.set_ylabel("P5 value")
        ax.set_title(f"P5 Timeline (tier=15, private)")

    # (d) 响应时间的时间趋势
    ax = axes[1, 1]
    response_with_time = []
    for i in range(1, len(messages)):
        prev, curr = messages[i - 1], messages[i]
        if prev.sender != curr.sender:
            gap_min = (curr.timestamp - prev.timestamp) / 60.0
            day = (curr.timestamp - messages[0].timestamp) / 86400.0
            response_with_time.append((day, gap_min))

    if response_with_time:
        days_r, times_r = zip(*response_with_time)
        ax.scatter(days_r, np.array(times_r) / 60.0, s=3, alpha=0.4, c="#1ABC9C")
        # 30 天滑动中位数
        if len(days_r) > 30:
            window_size = 30
            sorted_pairs = sorted(zip(days_r, times_r))
            d_arr = np.array([p[0] for p in sorted_pairs])
            t_arr = np.array([p[1] for p in sorted_pairs])
            medians = []
            med_days = []
            for j in range(window_size, len(d_arr)):
                medians.append(np.median(t_arr[j - window_size:j]))
                med_days.append(d_arr[j])
            ax.plot(med_days, np.array(medians) / 60.0, "-", color="#E74C3C",
                    linewidth=2, label="30-msg rolling median")
            ax.legend(fontsize=8)
        ax.set_xlabel("Days since first message")
        ax.set_ylabel("Response time (hours)")
        ax.set_title("Response Time Trend Over Time")
        ax.set_yscale("log")

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {output_path}")


# ---------------------------------------------------------------------------
# 遗忘曲线可视化
# ---------------------------------------------------------------------------

def plot_forgetting_curve(messages: list[Message], label: str, output_path: str):
    """绘制遗忘曲线理论 vs 经验对比图。"""
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    fig.suptitle(f"Exp6: {label} — Forgetting Curve Validation", fontsize=14, fontweight="bold")

    # (a) 理论遗忘曲线在不同 stability 下
    ax = axes[0]
    t_days = np.linspace(0, 365, 500)
    t_ticks = t_days * 24 * 60  # 天 → 分钟(ticks)

    for s_val, s_label, color in [
        (1.0, "s=1.0 (new)", "#E74C3C"),
        (1.2, "s=1.2 (1x recall)", "#E67E22"),
        (1.44, "s=1.44 (2x)", "#F1C40F"),
        (1.73, "s=1.73 (3x)", "#2ECC71"),
        (3.0, "s=3.0 (7x)", "#3498DB"),
    ]:
        r_vals = np.array([retrievability(t, stability=s_val) for t in t_ticks])
        ax.plot(t_days, r_vals, label=s_label, color=color, linewidth=2)

    ax.axhline(FACT_FORGET_THRESHOLD, color="gray", linestyle="--", alpha=0.7,
              label=f"R={FACT_FORGET_THRESHOLD} (forget)")
    ax.set_xlabel("Days since last access")
    ax.set_ylabel("Retrievability R(t)")
    ax.set_title("Theoretical Forgetting Curves")
    ax.legend(fontsize=8)
    ax.set_ylim(0, 1.05)

    # (b) 经验关键词重现 CDF vs 理论
    ax = axes[1]
    stop_words = {
        "the", "and", "for", "that", "this", "with", "you", "are", "was", "have",
        "что", "это", "как", "или", "для", "так", "все", "вот", "мне", "тут",
        "的", "了", "是", "在", "我", "有", "和", "不", "这", "就",
    }
    t0 = messages[0].timestamp
    day_keywords: dict[int, set[str]] = defaultdict(set)
    for m in messages:
        day_idx = int((m.timestamp - t0) / 86400)
        words = re.findall(r'[a-zA-Zа-яА-Я\u4e00-\u9fff]{3,}', m.text.lower())
        for w in words:
            if w not in stop_words:
                day_keywords[day_idx].add(w)

    keyword_days: dict[str, list[int]] = defaultdict(list)
    for day_idx in sorted(day_keywords.keys()):
        for kw in day_keywords[day_idx]:
            keyword_days[kw].append(day_idx)

    recurrence_gaps = []
    for kw, day_list in keyword_days.items():
        if len(day_list) < 2:
            continue
        for i in range(1, len(day_list)):
            gap = day_list[i] - day_list[i - 1]
            if gap > 0:
                recurrence_gaps.append(gap)

    if recurrence_gaps:
        gaps_arr = np.array(sorted(recurrence_gaps))
        # 经验 CDF（生存函数：P(gap > t)）
        survival = 1 - np.arange(1, len(gaps_arr) + 1) / len(gaps_arr)
        ax.plot(gaps_arr, survival, "-", color="#3498DB", linewidth=2,
                label=f"Empirical (n={len(gaps_arr)})")

        # 理论曲线（用 R(t) 作为"重现概率"的类比）
        t_range = np.linspace(1, gaps_arr.max(), 300)
        t_ticks_range = t_range * 24 * 60
        for s_val, s_label, color in [
            (1.0, "R(t), s=1.0", "#E74C3C"),
            (2.0, "R(t), s=2.0", "#2ECC71"),
        ]:
            r_curve = np.array([retrievability(t, stability=s_val) for t in t_ticks_range])
            ax.plot(t_range, r_curve, "--", color=color, linewidth=1.5, label=s_label, alpha=0.7)

    ax.set_xlabel("Gap (days)")
    ax.set_ylabel("P(gap > t) / R(t)")
    ax.set_title("Empirical Recurrence Survival vs Theory R(t)")
    ax.legend(fontsize=8)
    ax.set_xlim(0, min(365, max(recurrence_gaps) if recurrence_gaps else 365))

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"  Saved: {output_path}")


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def run_exp6() -> dict:
    base = Path(__file__).resolve().parent.parent
    data_dir = base / "testdata"
    output_dir = base / "output"
    output_dir.mkdir(exist_ok=True)

    datasets = [
        ("D1_private", data_dir / "private_chat_1" / "result.json"),
        ("D2_private", data_dir / "private_chat_2" / "result.json"),
    ]

    results = {}

    for label, path in datasets:
        print(f"\n{'='*60}")
        print(f"分析 {label}: {path}")
        print(f"{'='*60}")

        messages, meta = load_chat(str(path))
        print(f"  消息数: {len(messages)}")
        print(f"  参与者: {set(m.sender for m in messages)}")
        days = (messages[-1].timestamp - messages[0].timestamp) / 86400.0
        print(f"  时间跨度: {days:.1f} 天")

        # 1. P3
        print("\n--- P3 关系冷却 ---")
        p3 = analyze_p3(messages, label)
        print(f"  间隔中位数: {p3['median_gap_min']:.1f} 分钟 ({p3['median_gap_min']/60:.1f} 小时)")
        print(f"  间隔均值: {p3['mean_gap_min']:.1f} 分钟 ({p3['mean_gap_min']/60:.1f} 小时)")
        print(f"  P90: {p3['p90_gap_min']:.1f} 分钟 ({p3['p90_gap_min']/60:.1f} 小时)")
        print(f"  间隔分布: {p3['gap_distribution']}")
        for tier, info in p3.get("tier_analysis", {}).items():
            print(f"  Tier {tier}: cooling_median={info['cooling_median']:.3f}, "
                  f"pct>0.5={info['pct_above_half']:.1f}%, "
                  f"pct>0.9={info['pct_above_0_9']:.1f}%")

        # 2. P5
        print("\n--- P5 回复义务 ---")
        p5 = analyze_p5(messages, label)
        for key, val in p5.items():
            if key.startswith("response_"):
                sender = key.replace("response_", "")
                print(f"  {sender[:20]}:")
                print(f"    响应中位数: {val['median_min']:.1f}m, P90: {val['p90_min']:.1f}m")
                print(f"    <1h: {val['pct_under_1h']:.1f}%, >1h: {val['pct_over_1h']:.1f}%, "
                      f">6h: {val['pct_over_6h']:.1f}%, >24h: {val['pct_over_24h']:.1f}%")
                print(f"    decay@response median: {val['decay_at_response_median']:.4f}")

        # 3. Tier
        print("\n--- Tier 推断 ---")
        tier_res = analyze_tier(messages, label)
        print(f"  {tier_res['msgs_per_day']:.2f} msgs/day, {tier_res['days_span']} days")
        for sender, info in tier_res["sender_breakdown"].items():
            print(f"  {sender[:20]}: ratio={info['ratio']:.3f} → tier {info['inferred_tier']}")
        print(f"  ⚠ {tier_res['issue_ratio_only']}")
        for tier_key, info in tier_res["tier_evolution"].items():
            print(f"  {tier_key}: actual={info['actual_per_100t']:.3f}/100t, "
                  f"freq_score={info['frequency_score']:.4f}, "
                  f"mock_score={info['mock_tier_score']:.4f}, "
                  f"upgrade={info['would_upgrade']}, downgrade={info['would_downgrade']}")

        # 4. 遗忘曲线
        print("\n--- 遗忘曲线 ---")
        forget = analyze_forgetting(messages, label)
        if "error" not in forget:
            print(f"  唯一关键词: {forget['unique_keywords']}, 重现关键词: {forget['recurring_keywords']}")
            print(f"  重现间隔中位数: {forget['median_gap_days']:.1f} 天")
            print(f"  重现间隔分布: {forget['gap_distribution_days']}")
            print(f"  R=0.2 临界点 (s=1.0): {forget['critical_point_base']['hours']:.1f} 小时")
            for s_label, info in forget["stability_critical_points"].items():
                print(f"    {s_label}: 临界 {info['critical_hours']:.1f}h ({info['critical_days']:.1f}d)")
            print(f"  理论 R 值:")
            for delta, info in forget["theory_R"].items():
                print(f"    Δt={delta}: R_base={info['R_base']:.4f}, "
                      f"R_3x={info['R_3x_recall']:.4f}, "
                      f"forgotten={info['forget_threshold_reached']}")
        else:
            print(f"  {forget['error']}")

        # 5. 图表
        print("\n--- 生成图表 ---")
        plot_message_density(messages, label, str(output_dir / f"exp6_{label}_density.png"))
        plot_p5_response(messages, label, str(output_dir / f"exp6_{label}_p5.png"))
        plot_forgetting_curve(messages, label, str(output_dir / f"exp6_{label}_forgetting.png"))

        results[label] = {
            "p3": p3,
            "p5": p5,
            "tier": tier_res,
            "forgetting": forget,
        }

    return results


if __name__ == "__main__":
    results = run_exp6()
    print("\n\n" + "=" * 60)
    print("实验 6 完成。")

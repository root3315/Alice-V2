"""Exp7: 超级群组数据验证 — P1 注意力债务、话题漂移、语义分类。

数据: D3 — supergroup_1 (372800 条, 3036 人, 192 天, public_supergroup)

验证项:
1. P1 注意力债务 + κ 饱和分析
2. 话题漂移检测 (Jaccard < 0.3 阈值校验)
3. 语义分类覆盖率 (7 类规则复现)
4. 发言者活跃度分布 (幂律 + Dunbar tier 校验)
5. 线程推断质量 (采样验证)
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------
DATA_PATH = Path(__file__).parent.parent / "testdata" / "supergroup_1" / "result.json"
OUTPUT_DIR = Path(__file__).parent.parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# 常量 (从 runtime 和 sim_engine 搬运)
# ---------------------------------------------------------------------------
CHAT_TYPE_ATTENTION_WEIGHT = {
    "private": 3.0,
    "group": 1.0,
    "supergroup": 0.8,
    "channel": 0.3,
}

DUNBAR_TIER_WEIGHT = {5: 5.0, 15: 3.0, 50: 1.5, 150: 0.8, 500: 0.3}

# TS runtime κ1 = 5 (固定)
TS_KAPPA1 = 5.0

# sim_engine _BASE_KAPPA[0] = 30, _scale_kappa 根据 channels/4 缩放
SIM_BASE_KAPPA1 = 30.0
SIM_BASE_CHANNELS = 4

# 话题漂移阈值
TOPIC_SHIFT_THRESHOLD = 0.3

# 停用词 (从 strategy.mod.ts extractKeywords 搬运)
STOP_WORDS_EN = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "i", "you", "he",
    "she", "it", "we", "they", "me", "him", "her", "us", "them", "my",
    "your", "his", "its", "our", "their", "this", "that", "these", "those",
    "and", "but", "or", "not", "no", "so", "if", "then", "than", "too",
    "very", "just", "about", "up", "out", "on", "off", "over", "under",
    "again", "once", "here", "there", "when", "where", "why", "how", "all",
    "each", "every", "both", "few", "more", "most", "other", "some", "such",
    "only", "own", "same", "into", "to", "from", "in", "of", "for", "with",
    "at", "by", "as",
}

STOP_WORDS_ZH = {
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
    "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
    "没有", "看", "好", "自己", "这", "他", "她", "它", "吗", "呢", "吧",
    "啊", "哦", "嗯", "呀", "哈", "嘿",
}

STOP_WORDS = STOP_WORDS_EN | STOP_WORDS_ZH


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def extract_text(text_field) -> str:
    """从 Telegram text 字段提取纯文本。"""
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


def extract_keywords(text: str) -> list[str]:
    """从文本提取关键词 — 与 strategy.mod.ts extractKeywords 对齐。"""
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    tokens = cleaned.split()
    return [w for w in tokens if len(w) >= 2 and w not in STOP_WORDS][:10]


def jaccard_similarity(a: list[str], b: list[str]) -> float:
    """Jaccard 相似度。"""
    if not a and not b:
        return 1.0
    set_a, set_b = set(a), set(b)
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 1.0


def classify_message(text: str) -> str:
    """复现 semantics.mod.ts 的 7 类分类规则。"""
    if not text or not text.strip():
        return "casual"

    t = text.strip()

    # 1. urgent (最高优先级)
    if re.search(r"urgent|紧急|ASAP|immediately|立刻|马上|尽快|火急", t, re.I):
        return "urgent"

    # 2. greeting (整句匹配)
    if re.match(
        r"^(hi|hey|hello|你好|嗨|早|早上好|晚上好|good\s*(morning|evening|afternoon))[\s!！.。,，]?$",
        t, re.I,
    ):
        return "greeting"

    # 3. farewell (整句匹配)
    if re.match(
        r"^(bye|goodbye|再见|晚安|good\s*night|see\s*you|拜拜|下次见)[\s!！.。,，]?$",
        t, re.I,
    ):
        return "farewell"

    # 4. request
    if re.search(r"please|帮|能不能|可以.*吗|could you|can you|would you|麻烦|拜托|帮忙", t, re.I):
        return "request"

    # 5. question
    if re.search(r"\?|？|吗[？?]?$|呢[？?]?$|什么|怎么|哪|谁|为什么|how|what|where|who|why|when", t, re.I):
        return "question"

    # 6. informational
    if re.search(r"https?://|www\.|fwd|转发|分享|link|链接", t, re.I):
        return "informational"

    return "casual"


# ---------------------------------------------------------------------------
# 1. P1 注意力债务 + κ 饱和分析
# ---------------------------------------------------------------------------

def analyze_p1_saturation(messages: list[dict], report: list[str]) -> None:
    """分析每小时消息流速和 P1 κ 饱和问题。"""
    report.append("## 1. P1 注意力债务 + κ 饱和分析\n")

    # 提取时间戳
    timestamps = []
    for m in messages:
        ts = m.get("date_unixtime")
        if ts:
            timestamps.append(int(ts))

    if not timestamps:
        report.append("**错误**: 无法提取时间戳\n")
        return

    timestamps.sort()
    ts_min, ts_max = timestamps[0], timestamps[-1]
    total_hours = (ts_max - ts_min) / 3600
    total_days = total_hours / 24

    report.append(f"- 时间跨度: {total_days:.1f} 天 ({total_hours:.0f} 小时)")
    report.append(f"- 总消息数: {len(timestamps)}")
    report.append(f"- 日均消息: {len(timestamps) / max(total_days, 1):.0f} 条")
    report.append(f"- 平均流速: {len(timestamps) / max(total_hours, 1):.1f} 条/小时\n")

    # 每小时消息计数
    hourly_counts = Counter()
    for ts in timestamps:
        hour_bucket = ts // 3600
        hourly_counts[hour_bucket] += 1

    counts_arr = np.array(list(hourly_counts.values()))

    report.append("### 每小时消息流速统计")
    report.append(f"- 中位数: {np.median(counts_arr):.0f} 条/小时")
    report.append(f"- 均值: {np.mean(counts_arr):.1f} 条/小时")
    report.append(f"- P25/P75: {np.percentile(counts_arr, 25):.0f} / {np.percentile(counts_arr, 75):.0f}")
    report.append(f"- P95: {np.percentile(counts_arr, 95):.0f} 条/小时")
    report.append(f"- 最大: {np.max(counts_arr)} 条/小时\n")

    # 每分钟流速（tick_rate=60s 场景）
    minute_counts = Counter()
    for ts in timestamps:
        minute_bucket = ts // 60
        minute_counts[minute_bucket] += 1

    min_arr = np.array(list(minute_counts.values()))

    report.append("### 每分钟流速 (tick_rate=60s 场景)")
    report.append(f"- 中位数: {np.median(min_arr):.1f} 条/分钟")
    report.append(f"- 均值: {np.mean(min_arr):.2f} 条/分钟")
    report.append(f"- P75: {np.percentile(min_arr, 75):.1f}")
    report.append(f"- P95: {np.percentile(min_arr, 95):.1f}")
    report.append(f"- P99: {np.percentile(min_arr, 99):.1f}")
    report.append(f"- 最大: {np.max(min_arr)} 条/分钟\n")

    # P1 饱和分析
    # P1 = unread * w_tier * w_chat
    # 对 supergroup: w_chat = 0.8
    # w_tier: 最常见是 150 (acquaintance) → 0.8
    # 假设每 tick (60s) 积累的 unread
    report.append("### P1 κ 饱和模拟")
    report.append("")

    avg_per_tick = np.mean(min_arr)  # 平均每 tick 积累的消息
    p95_per_tick = np.percentile(min_arr, 95)

    # 场景: 一个 supergroup, tier=150, w_tier=0.8, w_chat=0.8
    w_tier = DUNBAR_TIER_WEIGHT[150]  # 0.8
    w_chat = CHAT_TYPE_ATTENTION_WEIGHT["supergroup"]  # 0.8

    scenarios = [
        ("单 tick 平均积累", avg_per_tick),
        ("单 tick P95 积累", p95_per_tick),
        ("5 tick 积累 (未处理)", avg_per_tick * 5),
        ("10 tick 积累", avg_per_tick * 10),
        ("30 tick 积累 (30 分钟)", avg_per_tick * 30),
    ]

    report.append("| 场景 | unread | P1_raw | tanh(P1/κ1=5) | tanh(P1/κ1=30) | tanh(P1/κ1=100) | tanh(P1/κ1=300) |")
    report.append("|------|--------|--------|---------------|----------------|-----------------|-----------------|")

    for name, unread in scenarios:
        p1_raw = unread * w_tier * w_chat
        v5 = math.tanh(p1_raw / TS_KAPPA1)
        v30 = math.tanh(p1_raw / SIM_BASE_KAPPA1)
        v100 = math.tanh(p1_raw / 100)
        v300 = math.tanh(p1_raw / 300)
        report.append(f"| {name} | {unread:.1f} | {p1_raw:.2f} | {v5:.4f} | {v30:.4f} | {v100:.4f} | {v300:.4f} |")

    report.append("")

    # κ 缩放分析
    # sim_engine: κ1 = BASE_KAPPA[0] * (n_channels / 4)
    # 这个超级群组只有 1 个 channel → κ1 = 30 * (1/4) = 7.5
    report.append("### κ1 缩放建议")
    report.append(f"- TS runtime κ1 = {TS_KAPPA1} (固定)")
    report.append(f"- sim_engine κ1 = {SIM_BASE_KAPPA1} * (n_channels / {SIM_BASE_CHANNELS})")
    report.append(f"- 单个超级群组: sim κ1 = {SIM_BASE_KAPPA1 * (1/SIM_BASE_CHANNELS):.1f}")

    # 要让 tanh 有区分力, 需要 P1/κ ∈ [0.2, 2.0]
    # P1 典型范围
    p1_typical = avg_per_tick * 5 * w_tier * w_chat  # 5 tick 积累
    kappa_lo = p1_typical / 2.0  # tanh(2) = 0.964, 几乎饱和
    kappa_hi = p1_typical / 0.2  # tanh(0.2) = 0.197, 刚有响应

    report.append(f"- 5 tick 典型 P1_raw = {p1_typical:.2f}")
    report.append(f"- 要保持区分力 (tanh ∈ [0.2, 0.96]), κ1 应在 [{kappa_lo:.1f}, {kappa_hi:.1f}]")
    report.append(f"- **建议**: κ1 ≈ {p1_typical:.0f} (使 5 tick 积累对应 tanh ≈ 0.76)\n")

    # 绘图: 每小时流速分布
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # 左图: 每小时流速直方图
    axes[0].hist(counts_arr, bins=50, edgecolor="black", alpha=0.7, color="#4A90D9")
    axes[0].axvline(np.median(counts_arr), color="red", linestyle="--", label=f"Median={np.median(counts_arr):.0f}")
    axes[0].axvline(np.percentile(counts_arr, 95), color="orange", linestyle="--", label=f"P95={np.percentile(counts_arr, 95):.0f}")
    axes[0].set_xlabel("Messages per hour")
    axes[0].set_ylabel("Frequency")
    axes[0].set_title("D3: Hourly Message Rate Distribution")
    axes[0].legend()

    # 右图: P1 饱和曲线 (不同 κ)
    p1_range = np.linspace(0, 50, 200)
    for kappa, label, color in [
        (5, "κ=5 (TS runtime)", "red"),
        (7.5, "κ=7.5 (sim 1ch)", "orange"),
        (30, "κ=30 (sim base)", "blue"),
        (100, "κ=100", "green"),
        (300, "κ=300", "purple"),
    ]:
        axes[1].plot(p1_range, np.tanh(p1_range / kappa), label=label, color=color)
    # 标注典型 P1 值
    axes[1].axvline(p1_typical, color="gray", linestyle=":", label=f"Typical P1={p1_typical:.1f}")
    axes[1].set_xlabel("P1 raw value")
    axes[1].set_ylabel("tanh(P1/κ)")
    axes[1].set_title("P1 Saturation Curves by κ")
    axes[1].legend(fontsize=8)
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "exp7_p1_saturation.png", dpi=150)
    plt.close(fig)
    report.append("![P1 饱和分析](output/exp7_p1_saturation.png)\n")


# ---------------------------------------------------------------------------
# 2. 话题漂移检测 (Jaccard)
# ---------------------------------------------------------------------------

def analyze_topic_drift(messages: list[dict], report: list[str]) -> None:
    """对最近 30 天的数据做话题漂移检测。"""
    report.append("## 2. 话题漂移检测 (Jaccard 阈值校验)\n")

    # 取最近 30 天
    timestamps = [(int(m.get("date_unixtime", 0)), m) for m in messages if m.get("date_unixtime")]
    if not timestamps:
        report.append("**错误**: 无有效时间戳\n")
        return

    timestamps.sort(key=lambda x: x[0])
    latest_ts = timestamps[-1][0]
    cutoff = latest_ts - 30 * 86400

    recent_msgs = [(ts, m) for ts, m in timestamps if ts >= cutoff]
    report.append(f"- 最近 30 天消息数: {len(recent_msgs)}")

    # 提取有文本的消息
    text_msgs = []
    for ts, m in recent_msgs:
        text = extract_text(m.get("text", ""))
        if text and len(text.strip()) > 0:
            text_msgs.append((ts, text))

    report.append(f"- 其中有文本的: {len(text_msgs)}\n")

    # 滑动窗口 Jaccard
    window_size = 20
    jaccards = []
    window_timestamps = []

    for i in range(window_size, len(text_msgs) - window_size):
        prev_window = text_msgs[i - window_size : i]
        curr_window = text_msgs[i : i + window_size]

        prev_keywords = []
        for _, text in prev_window:
            prev_keywords.extend(extract_keywords(text))

        curr_keywords = []
        for _, text in curr_window:
            curr_keywords.extend(extract_keywords(text))

        j = jaccard_similarity(prev_keywords, curr_keywords)
        jaccards.append(j)
        window_timestamps.append(curr_window[0][0])

    jaccards_arr = np.array(jaccards)

    report.append("### Jaccard 相似度统计 (窗口=20)")
    report.append(f"- 样本数: {len(jaccards)}")
    report.append(f"- 均值: {np.mean(jaccards_arr):.4f}")
    report.append(f"- 中位数: {np.median(jaccards_arr):.4f}")
    report.append(f"- 标准差: {np.std(jaccards_arr):.4f}")
    report.append(f"- P5/P25/P75/P95: {np.percentile(jaccards_arr, 5):.4f} / "
                  f"{np.percentile(jaccards_arr, 25):.4f} / "
                  f"{np.percentile(jaccards_arr, 75):.4f} / "
                  f"{np.percentile(jaccards_arr, 95):.4f}")
    report.append(f"- 最小值: {np.min(jaccards_arr):.4f}")
    report.append(f"- 最大值: {np.max(jaccards_arr):.4f}\n")

    # 漂移频率
    drift_count = np.sum(jaccards_arr < TOPIC_SHIFT_THRESHOLD)
    drift_ratio = drift_count / len(jaccards_arr) * 100
    report.append(f"### 话题漂移频率 (Jaccard < {TOPIC_SHIFT_THRESHOLD})")
    report.append(f"- 漂移次数: {drift_count} / {len(jaccards_arr)}")
    report.append(f"- **漂移频率: {drift_ratio:.1f}%**")

    if drift_ratio > 50:
        report.append(f"- ⚠️ 漂移过于频繁 (>50%)! 阈值 {TOPIC_SHIFT_THRESHOLD} 太高，需要降低")
    elif drift_ratio < 5:
        report.append(f"- ⚠️ 漂移过于稀疏 (<5%)! 阈值 {TOPIC_SHIFT_THRESHOLD} 太低，需要提高")
    else:
        report.append(f"- ✓ 漂移频率在合理范围 [5%, 50%]")

    # 不同阈值下的漂移频率
    report.append("\n### 不同阈值下的漂移频率")
    report.append("| 阈值 | 漂移次数 | 漂移频率 |")
    report.append("|------|----------|----------|")
    for threshold in [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]:
        count = np.sum(jaccards_arr < threshold)
        ratio = count / len(jaccards_arr) * 100
        marker = " ← 当前" if threshold == 0.3 else ""
        report.append(f"| {threshold:.2f} | {count} | {ratio:.1f}%{marker} |")

    report.append("")

    # 绘图
    fig, axes = plt.subplots(2, 1, figsize=(14, 8))

    # 上图: 时序图
    ts_hours = [(t - window_timestamps[0]) / 3600 for t in window_timestamps]
    # 降采样避免过多点
    step = max(1, len(ts_hours) // 2000)
    axes[0].plot(ts_hours[::step], jaccards_arr[::step], alpha=0.5, linewidth=0.5, color="#4A90D9")
    axes[0].axhline(TOPIC_SHIFT_THRESHOLD, color="red", linestyle="--", label=f"Threshold={TOPIC_SHIFT_THRESHOLD}")
    axes[0].set_xlabel("Hours (from 30 days ago)")
    axes[0].set_ylabel("Jaccard Similarity")
    axes[0].set_title("D3: Topic Drift Detection (Jaccard, window=20)")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # 下图: 分布直方图
    axes[1].hist(jaccards_arr, bins=100, edgecolor="black", alpha=0.7, color="#4A90D9")
    axes[1].axvline(TOPIC_SHIFT_THRESHOLD, color="red", linestyle="--", label=f"Threshold={TOPIC_SHIFT_THRESHOLD}")
    axes[1].axvline(np.median(jaccards_arr), color="green", linestyle="--", label=f"Median={np.median(jaccards_arr):.3f}")
    axes[1].set_xlabel("Jaccard Similarity")
    axes[1].set_ylabel("Frequency")
    axes[1].set_title("D3: Jaccard Similarity Distribution")
    axes[1].legend()

    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "exp7_topic_drift.png", dpi=150)
    plt.close(fig)
    report.append("![话题漂移分析](output/exp7_topic_drift.png)\n")


# ---------------------------------------------------------------------------
# 3. 语义分类覆盖率
# ---------------------------------------------------------------------------

def analyze_semantic_classification(messages: list[dict], report: list[str]) -> None:
    """对全量文本消息进行语义分类。"""
    report.append("## 3. 语义分类覆盖率\n")

    category_counts: Counter = Counter()
    total_classified = 0
    example_msgs: dict[str, list[str]] = defaultdict(list)

    for m in messages:
        if m.get("type") != "message":
            continue
        text = extract_text(m.get("text", ""))
        if not text or not text.strip():
            continue

        cat = classify_message(text)
        category_counts[cat] += 1
        total_classified += 1

        # 每类最多保存 3 个例子
        if len(example_msgs[cat]) < 3:
            snippet = text[:80] + ("..." if len(text) > 80 else "")
            example_msgs[cat].append(snippet)

    report.append(f"- 分类总数: {total_classified}")
    report.append("")

    report.append("### 各类占比")
    report.append("| 类别 | 数量 | 占比 | 状态 |")
    report.append("|------|------|------|------|")

    for cat in ["casual", "question", "request", "greeting", "farewell", "urgent", "informational"]:
        count = category_counts.get(cat, 0)
        ratio = count / total_classified * 100 if total_classified > 0 else 0
        if cat == "casual" and ratio > 80:
            status = "⚠️ 过高 (>80%)"
        elif ratio < 1 and cat != "casual":
            status = "⚠️ 过低 (<1%)"
        else:
            status = "✓"
        report.append(f"| {cat} | {count:,} | {ratio:.2f}% | {status} |")

    report.append("")

    # 示例
    report.append("### 分类示例")
    for cat in ["question", "request", "greeting", "farewell", "urgent", "informational"]:
        if example_msgs.get(cat):
            report.append(f"\n**{cat}**:")
            for ex in example_msgs[cat]:
                report.append(f"- `{ex}`")

    report.append("")

    # 覆盖率评估
    casual_ratio = category_counts.get("casual", 0) / total_classified * 100 if total_classified > 0 else 100
    report.append("### 覆盖率评估")
    report.append(f"- casual 占比: {casual_ratio:.1f}%")
    if casual_ratio > 80:
        report.append("- **⚠️ casual 超过 80%，规则覆盖不足**")
        report.append("- 建议扩展分类规则:")
        report.append("  - 添加 `expression` 类（表情包、emoji、sticker）")
        report.append("  - 添加 `opinion` 类（我觉得/我认为/imo/imho）")
        report.append("  - 添加 `media` 类（图片/视频/文件分享）")
    else:
        report.append("- ✓ 规则覆盖率可接受")

    report.append("")

    # 绘图
    fig, ax = plt.subplots(figsize=(10, 5))
    cats = ["casual", "question", "request", "informational", "greeting", "farewell", "urgent"]
    counts = [category_counts.get(c, 0) for c in cats]
    ratios = [c / total_classified * 100 for c in counts]
    colors = ["#95a5a6", "#3498db", "#2ecc71", "#9b59b6", "#e67e22", "#e74c3c", "#c0392b"]
    bars = ax.bar(cats, ratios, color=colors, edgecolor="black", alpha=0.8)
    ax.set_ylabel("Percentage (%)")
    ax.set_title("D3: Semantic Category Distribution")
    ax.axhline(80, color="red", linestyle="--", alpha=0.5, label="80% threshold")
    for bar, r in zip(bars, ratios):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
                f"{r:.1f}%", ha="center", va="bottom", fontsize=8)
    ax.legend()
    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "exp7_semantic_classes.png", dpi=150)
    plt.close(fig)
    report.append("![语义分类](output/exp7_semantic_classes.png)\n")


# ---------------------------------------------------------------------------
# 4. 发言者活跃度分布
# ---------------------------------------------------------------------------

def analyze_speaker_distribution(messages: list[dict], report: list[str]) -> None:
    """分析发言者分布。"""
    report.append("## 4. 发言者活跃度分布\n")

    sender_counts: Counter = Counter()
    sender_names: dict[str, str] = {}

    for m in messages:
        sid = m.get("from_id", "")
        sname = m.get("from", "")
        if sid:
            sender_counts[sid] += 1
            if sname:
                sender_names[sid] = sname

    total_msgs = sum(sender_counts.values())
    total_senders = len(sender_counts)

    report.append(f"- 总发言者: {total_senders}")
    report.append(f"- 总消息数: {total_msgs:,}\n")

    # Top-50
    top50 = sender_counts.most_common(50)
    report.append("### Top-20 发言者")
    report.append("| 排名 | 用户 | 消息数 | 占比 | 累计占比 |")
    report.append("|------|------|--------|------|----------|")

    cumulative = 0
    for i, (sid, count) in enumerate(top50[:20]):
        ratio = count / total_msgs * 100
        cumulative += ratio
        name = sender_names.get(sid, sid)[:16]
        report.append(f"| {i+1} | {name} | {count:,} | {ratio:.2f}% | {cumulative:.1f}% |")

    report.append("")

    # Top-N 占比
    top10_sum = sum(c for _, c in sender_counts.most_common(10))
    top10_ratio = top10_sum / total_msgs * 100
    top50_sum = sum(c for _, c in sender_counts.most_common(50))
    top50_ratio = top50_sum / total_msgs * 100
    top100_sum = sum(c for _, c in sender_counts.most_common(100))
    top100_ratio = top100_sum / total_msgs * 100

    report.append("### 集中度分析")
    report.append(f"- Top-10 ({10/total_senders*100:.1f}% 人) 占消息量: **{top10_ratio:.1f}%**")
    report.append(f"- Top-50 ({50/total_senders*100:.1f}% 人) 占消息量: **{top50_ratio:.1f}%**")
    report.append(f"- Top-100 ({100/total_senders*100:.1f}% 人) 占消息量: **{top100_ratio:.1f}%**\n")

    # 幂律拟合
    counts_sorted = np.array(sorted(sender_counts.values(), reverse=True), dtype=float)
    ranks = np.arange(1, len(counts_sorted) + 1, dtype=float)

    # 对 top-500 做 log-log 线性回归
    n_fit = min(500, len(counts_sorted))
    log_ranks = np.log10(ranks[:n_fit])
    log_counts = np.log10(counts_sorted[:n_fit])
    # 过滤零值
    mask = counts_sorted[:n_fit] > 0
    if np.sum(mask) > 10:
        coeffs = np.polyfit(log_ranks[mask], log_counts[mask], 1)
        power_law_exponent = -coeffs[0]
        report.append(f"### 幂律分布拟合 (Top-{n_fit})")
        report.append(f"- Zipf 指数 α = {power_law_exponent:.3f}")
        report.append(f"  (α ≈ 1.0 = Zipf 定律, α > 1 = 更集中, α < 1 = 更均匀)")
        if power_law_exponent > 0.8:
            report.append("- ✓ 符合幂律/Zipf 分布")
        else:
            report.append("- ⚠️ 偏离幂律分布")
    else:
        power_law_exponent = 0
        report.append("### 幂律分布拟合: 数据不足")

    report.append("")

    # Dunbar tier 映射验证
    # _infer_dunbar_tier 用 ratio = msgs / total_msgs
    report.append("### Dunbar Tier 映射验证")
    report.append("根据 `_infer_dunbar_tier` 的 ratio 阈值:")
    report.append("| Tier | 条件 (ratio) | 该 Tier 人数 | 占总人数比 |")
    report.append("|------|-------------|-------------|-----------|")

    tier_counts = {5: 0, 15: 0, 50: 0, 150: 0, 500: 0}
    for sid, count in sender_counts.items():
        ratio = count / total_msgs
        if ratio > 0.05:
            tier_counts[5] += 1
        elif ratio > 0.02:
            tier_counts[15] += 1
        elif ratio > 0.005:
            tier_counts[50] += 1
        elif ratio > 0.001:
            tier_counts[150] += 1
        else:
            tier_counts[500] += 1

    thresholds = {5: ">5%", 15: "2%-5%", 50: "0.5%-2%", 150: "0.1%-0.5%", 500: "<0.1%"}
    for tier in [5, 15, 50, 150, 500]:
        tc = tier_counts[tier]
        report.append(f"| {tier} | {thresholds[tier]} | {tc} | {tc/total_senders*100:.1f}% |")

    report.append("")
    report.append("**Dunbar 数对比**: 5/15/50/150/500 理论分布 vs 实际分布")
    for tier in [5, 15, 50, 150, 500]:
        report.append(f"- Tier {tier}: 理论上限 {tier} 人, 实际 {tier_counts[tier]} 人" +
                      (" ✓" if tier_counts[tier] <= tier * 2 else " ⚠️ 超出理论上限"))

    report.append("")

    # 绘图
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # 左图: Rank-frequency (log-log)
    axes[0].scatter(ranks[:200], counts_sorted[:200], s=8, alpha=0.6, color="#4A90D9")
    if power_law_exponent > 0:
        fit_line = 10 ** (coeffs[1]) * ranks[:200] ** coeffs[0]
        axes[0].plot(ranks[:200], fit_line, "r--", label=f"α={power_law_exponent:.2f}")
    axes[0].set_xscale("log")
    axes[0].set_yscale("log")
    axes[0].set_xlabel("Rank")
    axes[0].set_ylabel("Message Count")
    axes[0].set_title("D3: Speaker Rank-Frequency (Zipf)")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # 右图: Dunbar tier 分布
    tiers = list(tier_counts.keys())
    tier_vals = list(tier_counts.values())
    colors = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#3498db"]
    axes[1].bar([str(t) for t in tiers], tier_vals, color=colors, edgecolor="black")
    # 标注 Dunbar 理论上限
    for i, t in enumerate(tiers):
        axes[1].axhline(t, color=colors[i], linestyle=":", alpha=0.5)
        axes[1].text(i, tier_vals[i] + max(tier_vals) * 0.02, str(tier_vals[i]),
                     ha="center", va="bottom", fontsize=9)
    axes[1].set_xlabel("Dunbar Tier")
    axes[1].set_ylabel("Number of Senders")
    axes[1].set_title("D3: Dunbar Tier Distribution")

    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "exp7_speaker_dist.png", dpi=150)
    plt.close(fig)
    report.append("![发言者分布](output/exp7_speaker_dist.png)\n")


# ---------------------------------------------------------------------------
# 5. 线程推断质量 (采样)
# ---------------------------------------------------------------------------

def analyze_thread_inference(messages: list[dict], report: list[str]) -> None:
    """对最近 7 天数据运行 ThreadInferrer。"""
    report.append("## 5. 线程推断质量 (最近 7 天采样)\n")

    # 导入 ThreadInferrer
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from telegram_parser import ThreadInferrer, Event, EventKind, _extract_text_info

    # 取最近 7 天
    timestamps = [(int(m.get("date_unixtime", 0)), m) for m in messages if m.get("date_unixtime")]
    timestamps.sort(key=lambda x: x[0])
    latest_ts = timestamps[-1][0]
    cutoff = latest_ts - 7 * 86400

    recent = [(ts, m) for ts, m in timestamps if ts >= cutoff]
    report.append(f"- 最近 7 天消息数: {len(recent)}\n")

    # 构造 Event 列表
    events: list[Event] = []
    msg_text_map: dict[int, str] = {}  # message_id -> text (用于抽样展示)

    for ts, m in recent:
        if m.get("type") != "message":
            continue
        sid = m.get("from_id", "")
        sname = m.get("from", "")
        if not sid:
            sid = f"unknown_{m.get('id', 0)}"
        if not sname:
            sname = sid

        text_field = m.get("text", "")
        text_len, has_ent = _extract_text_info(text_field)

        msg_id = m.get("id", 0)
        events.append(Event(
            timestamp=float(ts),
            kind=EventKind.MESSAGE,
            channel_id=str(m.get("id", 0)),
            sender_id=sid,
            sender_name=sname,
            message_id=msg_id,
            reply_to=m.get("reply_to_message_id"),
            text_length=text_len,
            has_entities=has_ent,
        ))

        text = extract_text(text_field)
        if text:
            msg_text_map[msg_id] = text[:100]

    report.append(f"- MESSAGE 事件数: {len(events)}")

    # 运行 ThreadInferrer
    inferrer = ThreadInferrer(temporal_gap=300.0, min_thread_size=3)
    thread_map = inferrer.infer(events)

    # 统计线程
    threads: dict[str, list[int]] = defaultdict(list)
    for mid, tid in thread_map.items():
        threads[tid].append(mid)

    report.append(f"- 推断出的线程数: {len(threads)}")
    report.append(f"- 被分配到线程的消息: {len(thread_map)} / {len(events)} ({len(thread_map)/max(len(events),1)*100:.1f}%)")

    if threads:
        sizes = [len(members) for members in threads.values()]
        report.append(f"- 线程大小 — 均值: {np.mean(sizes):.1f}, 中位数: {np.median(sizes):.0f}, 最大: {np.max(sizes)}")
    else:
        report.append("- ⚠️ 没有推断出任何线程")
        return

    report.append("")

    # 线程大小分布
    size_counter = Counter(sizes)
    report.append("### 线程大小分布")
    report.append("| 大小范围 | 线程数 | 占比 |")
    report.append("|----------|--------|------|")

    ranges = [(3, 5), (6, 10), (11, 20), (21, 50), (51, 100), (101, 500), (500, float("inf"))]
    for lo, hi in ranges:
        count = sum(v for k, v in size_counter.items() if lo <= k <= hi)
        ratio = count / len(threads) * 100
        hi_label = f"{int(hi)}" if hi != float("inf") else "+"
        report.append(f"| {lo}-{hi_label} | {count} | {ratio:.1f}% |")

    report.append("")

    # 抽样最大 3 个线程
    sorted_threads = sorted(threads.items(), key=lambda x: -len(x[1]))[:3]

    # 创建 message_id -> Event 的映射
    event_map: dict[int, Event] = {e.message_id: e for e in events}

    report.append("### 最大 3 个线程抽样")

    for tid, members in sorted_threads:
        members_sorted = sorted(members)
        report.append(f"\n**{tid}** (大小: {len(members)})")

        # 前 5 条
        report.append("\n前 5 条:")
        for mid in members_sorted[:5]:
            e = event_map.get(mid)
            text = msg_text_map.get(mid, "[无文本]")
            sender = e.sender_name if e else "?"
            report.append(f"- [{mid}] {sender}: {text}")

        # 后 5 条
        if len(members_sorted) > 10:
            report.append("\n后 5 条:")
            for mid in members_sorted[-5:]:
                e = event_map.get(mid)
                text = msg_text_map.get(mid, "[无文本]")
                sender = e.sender_name if e else "?"
                report.append(f"- [{mid}] {sender}: {text}")

    report.append("")

    # 绘图: 线程大小分布
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.hist(sizes, bins=50, edgecolor="black", alpha=0.7, color="#4A90D9")
    ax.set_xlabel("Thread Size (messages)")
    ax.set_ylabel("Frequency")
    ax.set_title(f"D3: Thread Size Distribution (n={len(threads)} threads)")
    ax.axvline(np.median(sizes), color="red", linestyle="--", label=f"Median={np.median(sizes):.0f}")
    ax.legend()
    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "exp7_thread_sizes.png", dpi=150)
    plt.close(fig)
    report.append("![线程大小分布](output/exp7_thread_sizes.png)\n")


# ---------------------------------------------------------------------------
# 6. 时段活跃度热力图（额外洞察）
# ---------------------------------------------------------------------------

def analyze_hourly_pattern(messages: list[dict], report: list[str]) -> None:
    """按星期几 × 小时的活跃度热力图。"""
    report.append("## 6. 时段活跃度模式 (额外洞察)\n")

    heatmap = np.zeros((7, 24))  # weekday × hour

    for m in messages:
        ts = m.get("date_unixtime")
        if not ts:
            continue
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        # 假设 UTC+8
        hour_local = (dt.hour + 8) % 24
        weekday = (dt.weekday() + (1 if (dt.hour + 8) >= 24 else 0)) % 7
        heatmap[weekday][hour_local] += 1

    report.append("- 活跃度热力图 (UTC+8):\n")

    # 绘图
    fig, ax = plt.subplots(figsize=(14, 4))
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    im = ax.imshow(heatmap, aspect="auto", cmap="YlOrRd")
    ax.set_xticks(range(24))
    ax.set_xticklabels([f"{h:02d}" for h in range(24)])
    ax.set_yticks(range(7))
    ax.set_yticklabels(days)
    ax.set_xlabel("Hour (UTC+8)")
    ax.set_ylabel("Day of Week")
    ax.set_title("D3: Message Activity Heatmap")
    fig.colorbar(im, ax=ax, label="Messages")
    plt.tight_layout()
    fig.savefig(OUTPUT_DIR / "exp7_activity_heatmap.png", dpi=150)
    plt.close(fig)
    report.append("![活跃度热力图](output/exp7_activity_heatmap.png)\n")

    # 从热力图提取关键信息
    peak_hour = int(np.argmax(heatmap.sum(axis=0)))
    quiet_hour = int(np.argmin(heatmap.sum(axis=0)))
    peak_day = int(np.argmax(heatmap.sum(axis=1)))
    report.append(f"- 最活跃时段: {peak_hour}:00 (UTC+8)")
    report.append(f"- 最安静时段: {quiet_hour}:00 (UTC+8)")
    report.append(f"- 最活跃日: {days[peak_day]}")
    report.append(f"- 活跃/安静比: {heatmap.sum(axis=0).max() / max(heatmap.sum(axis=0).min(), 1):.1f}×\n")


# ---------------------------------------------------------------------------
# 主函数
# ---------------------------------------------------------------------------

def main() -> None:
    print("=== Exp7: 超级群组数据验证 ===")
    print(f"数据: {DATA_PATH}")

    print("加载数据...")
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    messages = data.get("messages", [])
    print(f"  加载完成: {len(messages)} 条消息")

    report: list[str] = []
    report.append("# Exp7: 超级群组数据验证报告")
    report.append(f"\n数据: D3 — {data.get('name', '?')} ({len(messages):,} 条, {data.get('type', '?')})\n")

    # 1. P1 饱和分析
    print("1/6 P1 注意力债务 + κ 饱和分析...")
    analyze_p1_saturation(messages, report)

    # 2. 话题漂移
    print("2/6 话题漂移检测...")
    analyze_topic_drift(messages, report)

    # 3. 语义分类
    print("3/6 语义分类覆盖率...")
    analyze_semantic_classification(messages, report)

    # 4. 发言者分布
    print("4/6 发言者活跃度分布...")
    analyze_speaker_distribution(messages, report)

    # 5. 线程推断
    print("5/6 线程推断质量...")
    analyze_thread_inference(messages, report)

    # 6. 时段活跃度
    print("6/6 时段活跃度分析...")
    analyze_hourly_pattern(messages, report)

    # 写入报告
    report_text = "\n".join(report)
    report_path = Path(__file__).parent.parent / "output" / "exp7_supergroup_report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report_text, encoding="utf-8")
    print(f"\n报告已写入: {report_path}")

    # 也输出到 stdout
    print("\n" + "=" * 60)
    print(report_text)


if __name__ == "__main__":
    main()

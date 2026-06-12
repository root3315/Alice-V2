"""基于真实 Telegram 事件流的模拟引擎 — v4。

v4 变更（解耦压力动力学）：
- P3 纯粹化：不再读取 API 历史（φ/ψ 移除）
- API 降格为纯观测量：api_history 存 napi（归一化值），不反馈到压力
- Laplacian 传播：压力通过图边传导
- 行动频率门：替代 φ/ψ 的合法功能（疲劳/主动）
- 归一化统一：api_aggregate 使用 tanh

P6 novelty_history 修复（v4.1）：
- novelty_history 初始化为空列表，不再预填假数据
- 每 tick 开始时，从当前事件计算 novelty 并在压力计算前 append
- 无事件 tick novelty=0（完全无新信息→好奇心上升）
- novelty 计算依据：基础 0.3 + entities +0.3 + 长文本(>200) +0.2，范围 [0, 0.8]
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field

import numpy as np

from graph import CompanionGraph, NodeType, THREAD_WEIGHTS, DUNBAR_TIER_WEIGHT
from pressure import compute_all_pressures
from voices import (
    PersonalityVector,
    compute_loudness,
    select_action,
    personality_evolution_step,
    VOICE_SHORT,
)
from event_stream import EventStream
from telegram_parser import EventKind

# κ 基准值（tanh 归一化半宽参数）
#
# _BASE_KAPPA = [30, 8, 8, 200, 10, 0.5] 是为 ~15 contacts, 8 threads,
# 4 channels, 10 items 的合成图设计的。_scale_kappa() 根据实际图规模进行缩放。
#
# TS runtime 使用固定 κ = [5, 8, 8, 200, 3, 0.5]，适合小型图（少量联系人/频道）。
# P1 差 6 倍（30 vs 5），P5 差 3.3 倍（10 vs 3）——这是刻意的，不是 bug。
# 大图需要更大的 κ 来避免 tanh 过早饱和。
#
# 交叉验证时两侧使用相同的显式 κ 值，不依赖任何默认值。
# 未来 TS runtime 也应该实现 κ 缩放（当图增大时），届时两侧可统一为
# _BASE_KAPPA + _scale_kappa 的模式。
_BASE_KAPPA = np.array([30.0, 8.0, 8.0, 200.0, 10.0, 0.5])
_BASE_GRAPH_SIZE = {"contacts": 15, "threads": 8, "channels": 4, "items": 10}


def _scale_kappa(G: CompanionGraph) -> np.ndarray:
    """根据图的实际规模缩放 κ 参数。"""
    n_contacts = max(len(G.get_entities_by_type(NodeType.CONTACT)), 1)
    n_threads = max(len(G.get_entities_by_type(NodeType.THREAD)), 1)
    n_channels = max(len(G.get_entities_by_type(NodeType.CHANNEL)), 1)
    n_items = max(len(G.get_entities_by_type(NodeType.INFO_ITEM)), 1)

    # P1∝channels, P2∝items, P3∝contacts, P4∝threads, P5∝channels, P6 不变
    scale = np.array([
        n_channels / _BASE_GRAPH_SIZE["channels"],   # P1
        n_items / _BASE_GRAPH_SIZE["items"],          # P2 (info pressure)
        n_contacts / _BASE_GRAPH_SIZE["contacts"],    # P3
        n_threads / _BASE_GRAPH_SIZE["threads"],      # P4
        n_channels / _BASE_GRAPH_SIZE["channels"],    # P5 (response obligation)
        1.0,                                           # P6
    ])
    return _BASE_KAPPA * scale


def _normalized_api(pressures: dict[str, float], kappa: np.ndarray) -> float:
    """将 6 个压力 tanh 归一化后求和，得到与图规模无关的 API。

    返回值 ∈ [0, 6)，每个分量 ∈ [0, 1)。
    """
    raw = np.array([pressures[f"P{i}"] for i in range(1, 7)])
    normed = np.tanh(raw / kappa)
    return float(normed.sum())


# ---------------------------------------------------------------------------
# Tier 动态演化（v3 新增）
# ---------------------------------------------------------------------------

_TIER_SEQUENCE = [5, 15, 50, 150, 500]


def _evolve_tiers(G: CompanionGraph, tick: int) -> dict[str, tuple[int, int]]:
    """基于评估窗口内的交互率重评估 Dunbar tier。

    升级条件：交互率 > 2× 同伴均值
    降级条件：交互率 < 0.2× 同伴均值
    评估完成后重置所有 Contact 的 interaction_count。

    Returns
    -------
    dict[str, tuple[int, int]]
        {contact_id: (old_tier, new_tier)} 仅包含发生变化的联系人。
    """
    contacts = G.get_entities_by_type(NodeType.CONTACT)
    if not contacts:
        return {}

    rates: dict[str, int] = {}
    for cid in contacts:
        rates[cid] = G.node_attrs(cid).get("interaction_count", 0)

    total = sum(rates.values())
    mean_rate = total / len(rates) if rates else 0
    changes: dict[str, tuple[int, int]] = {}

    for cid in contacts:
        old_tier = G.node_attrs(cid).get("tier", 150)
        rate = rates[cid]
        idx = _TIER_SEQUENCE.index(old_tier) if old_tier in _TIER_SEQUENCE else 3

        if mean_rate > 0 and rate > 2 * mean_rate and idx > 0:
            new_tier = _TIER_SEQUENCE[idx - 1]
            G.set_node_attr(cid, "tier", new_tier)
            changes[cid] = (old_tier, new_tier)
        elif mean_rate > 0 and rate < 0.2 * mean_rate and idx < len(_TIER_SEQUENCE) - 1:
            new_tier = _TIER_SEQUENCE[idx + 1]
            G.set_node_attr(cid, "tier", new_tier)
            changes[cid] = (old_tier, new_tier)

        # 重置计数器
        G.set_node_attr(cid, "interaction_count", 0)

    return changes


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

@dataclass
class SimConfig:
    """模拟参数。"""

    action_threshold: float | None = None
    """归一化 API 行动阈值（∈ [0, 6)）。None 时使用自适应 EMA 触发。"""

    ema_alpha: float = 0.02
    """EMA 平滑系数。"""

    trigger_margin: float = 0.05
    """nAPI 超过 EMA 多少时触发行动。"""

    idle_trigger_interval: int = 20
    """连续无事件达到此 tick 数时强制触发行动。"""

    cooldown_ticks: int = 5
    """两次行动之间的最小间隔。"""

    personality_alpha: float = 0.001
    """人格演化学习率。"""

    personality_gamma: float = 0.0005
    """人格均值回归系数。"""

    personality_pi_min: float = 0.05
    """人格权重硬下界。"""

    personality_init: np.ndarray = field(
        default_factory=lambda: np.array([0.25, 0.2, 0.2, 0.15, 0.2])
    )
    """初始人格向量 (D, C, S, X, R)。同时作为均值回归的 home。"""

    thread_age_scale: float = 1440.0
    """ADR-64 VI-1: P4 线程年龄对数尺度（ticks，1440 ≈ 1 天）。"""

    tier_eval_interval: int = 100
    """v3: Tier 重评估间隔（ticks）。0 = 禁用 tier 演化。"""

    # v4: 行动频率门（替代 φ/ψ 的疲劳/主动功能）
    action_rate_window: int = 50
    """行动频率计算的回顾窗口（ticks）。"""

    action_rate_cap: float = 0.3
    """高于此频率时触发疲劳（提高行动阈值）。

    ── 标定依据 ──
    action_rate_cap = 0.3 意味着"每 10 tick 中行动超过 3 次就开始疲劳"。

    参考数据：
    - 微软 MSN 大规模通讯研究显示，即时通讯的消息速率约 1.43-1.5 条/分钟
      在活跃对话中。(cs.stanford.edu/people/jure/pubs/msn-www08.pdf)
    - 群聊中，单个参与者的发言占比通常在 10%-30% 之间，
      取决于群大小和活跃度。(MDPI Informatics 2024, Why Do People Gather)

    第一性原理推理：
    - 0.3 (30%) 是"群聊中的活跃参与者"的发言密度上界。
      在 5 人群聊中，均匀发言时每人 20%；最活跃的人约 30%。
    - 超过 30% 意味着 Alice 在"刷屏"——比一般活跃参与者还多。
      此时应触发疲劳，降低发言频率，模拟人类的"说够了，歇一歇"心理。
    - 低于 30% 则是正常的参与水平，无需抑制。
    """

    action_rate_floor: float = 0.05
    """低于此频率时触发主动（降低行动阈值）。

    ── 标定依据 ──
    action_rate_floor = 0.05 意味着"每 20 tick（20 分钟）中行动不足 1 次就触发主动"。

    第一性原理推理：
    - 5% 的行动率意味着 Alice 几乎完全沉默。
      在 action_rate_window=50 的窗口中，5% = 2.5 次行动 / 50 分钟。
    - 人类在群聊中如果 20+ 分钟一言不发，会开始被视为"潜水"。
      作为电子伴侣，长期沉默意味着"存在感消失"。
    - 0.05 阈值让 Alice 在接近完全沉默时主动降低行动门槛，
      模拟人类的"太久没说话了，找个话题聊聊"的心理。
    - 这个值远低于 cap (0.3)，留出一个"正常区间" [0.05, 0.3]，
      在此区间内行动频率不受门控调制（门的贡献为 0）。
    """

    fatigue_alpha: float = 0.5
    """疲劳调制强度。

    ── 标定依据 ──
    fatigue_mod = fatigue_alpha * max(0, action_rate - action_rate_cap)
    effective_margin = trigger_margin * (1 + fatigue_mod - initiative_mod)

    当 action_rate = 0.5 (远超 cap=0.3) 时：
      fatigue_mod = 0.5 * (0.5 - 0.3) = 0.1
      effective_margin = 0.05 * 1.1 = 0.055 (+10%)

    当 action_rate = 1.0 (极端：每 tick 都行动) 时：
      fatigue_mod = 0.5 * 0.7 = 0.35
      effective_margin = 0.05 * 1.35 = 0.0675 (+35%)

    0.5 的强度确保疲劳效应是渐进的、温和的——即使极端高频，
    阈值也只提升 35%，不会完全阻止行动。这模拟了人类的
    "累了但如果有重要事还是会说"的心理。
    """

    initiative_alpha: float = 0.3
    """主动调制强度。

    ── 标定依据 ──
    initiative_mod = initiative_alpha * max(0, action_rate_floor - action_rate)

    当 action_rate = 0 (完全沉默) 时：
      initiative_mod = 0.3 * 0.05 = 0.015
      effective_margin = 0.05 * (1 - 0.015) = 0.04925 (-1.5%)

    主动效应比疲劳效应弱（0.3 < 0.5），因为：
    1. 主动发言的阈值降低不应太激进，否则 Alice 会变成"话痨"
    2. 沉默本身可能是合理的（如深夜、对方忙碌），不应过度干预
    3. 配合 idle_trigger_interval 使用——长期沉默有兜底触发机制

    initiative_alpha 较小还确保了 initiative_mod 不会使 effective_margin
    变为负数（最低 0.05 * (1 - 0.015) ≈ 0.049），保持系统稳定。
    """

    noise_burst_rate: float = 0.02
    noise_silence_rate: float = 0.01
    noise_new_contact_rate: float = 0.005

    seed: int = 42


# ---------------------------------------------------------------------------
# Tick 快照
# ---------------------------------------------------------------------------

@dataclass
class TickRecord:
    """单 tick 的完整快照。"""

    tick: int
    n_events: int
    pressures: dict[str, float]  # P1~P6, API, A
    napi: float                  # 归一化 API ∈ [0, 6)
    loudness: np.ndarray | None  # (5,) 或 None
    action: str | None
    winner_idx: int | None
    personality: np.ndarray      # (5,)
    feedback: float
    target: str | None = None    # ADR-223: 行动目标 ID


# ---------------------------------------------------------------------------
# ADR-223: 目标分布度量
# ---------------------------------------------------------------------------

def compute_target_metrics(records: list[TickRecord]) -> dict[str, float]:
    """计算目标分布度量：Gini 系数、top-1 占比、切换率。

    @see docs/adr/223-simulation-closed-loop-verification.md
    """
    from collections import Counter

    targets = [r.target for r in records if r.target is not None]
    if not targets:
        return {"gini": 0.0, "top1_ratio": 0.0, "switch_rate": 0.0, "distinct": 0}

    counts = Counter(targets)
    values = sorted(counts.values())
    n = len(values)

    # Gini 系数
    total_v = sum(values)
    if total_v > 0 and n > 1:
        gini = sum((2 * i - n - 1) * v for i, v in enumerate(values, 1)) / (n * total_v)
    else:
        gini = 0.0

    # Top-1 占比
    top1_ratio = max(counts.values()) / len(targets)

    # 切换率
    switches = sum(1 for a, b in zip(targets, targets[1:]) if a != b)
    switch_rate = switches / max(1, len(targets) - 1)

    return {
        "gini": gini,
        "top1_ratio": top1_ratio,
        "switch_rate": switch_rate,
        "distinct": len(counts),
    }


# ---------------------------------------------------------------------------
# 目标选择层（v2 新增）
# ---------------------------------------------------------------------------

def _select_target(
    action_type: str,
    contributions: dict[str, dict[str, float]],
) -> str | None:
    """根据声部类型和压力贡献选择行动目标。

    声部胜出后，用该声部关联的压力的逐实体贡献来选目标。
    """
    if action_type == "diligence":
        # D 声部关联 P1(注意力) + P4(线程) + P5(回应义务)
        merged: dict[str, float] = {}
        for pk in ["P1", "P4", "P5"]:
            for eid, val in contributions.get(pk, {}).items():
                merged[eid] = merged.get(eid, 0.0) + val
        return max(merged, key=merged.get) if merged else None

    elif action_type == "curiosity":
        p2c = contributions.get("P2", {})
        return max(p2c, key=p2c.get) if p2c else None

    elif action_type == "sociability":
        p3c = contributions.get("P3", {})
        return max(p3c, key=p3c.get) if p3c else None

    elif action_type == "reflection":
        p2c = contributions.get("P2", {})
        return max(p2c, key=p2c.get) if p2c else None

    return None  # caution: 无目标


# ---------------------------------------------------------------------------
# 事件映射：Telegram 事件 → 图状态变更
# ---------------------------------------------------------------------------

def _apply_events(
    G: CompanionGraph,
    events: list,
    tick: int,
    novelty_buffer: list[float],
) -> int:
    """将一个 tick 内的事件映射到图状态变更。

    v2 增强：追踪 directed 消息（reply_to != None → 0.3 权重累加到 pending_directed）。

    P6 novelty 计算：
    - 无事件 tick → novelty=0（完全无新信息，好奇心上升）
    - 有事件 tick → 基于消息内容计算 novelty（基础 0.3 + entities +0.3 + 长文本 +0.2）
    """
    if not events:
        # 无事件 = 无新信息 → novelty 为 0，使 P6 好奇心上升
        novelty_buffer.append(0.0)
        return 0

    novelty_sum = 0.0

    for e in events:
        channel_id = f"ch_{e.channel_id}"

        # P1: unread 累加
        if channel_id in G:
            old_unread = G.node_attrs(channel_id).get("unread", 0)
            G.set_node_attr(channel_id, "unread", old_unread + 1)

        # P3: 更新联系人 last_active
        contact_id = f"ct_{e.sender_id}"
        if contact_id in G:
            G.set_node_attr(contact_id, "last_active", tick)

        # P5: directed 消息追踪（v3: chat_type 感知）
        if channel_id in G:
            chat_type = G.node_attrs(channel_id).get("chat_type", "group")
            if chat_type == "private":
                directed_weight = 0.8  # 私聊：每条消息都有高回应义务
            elif e.reply_to is not None:
                directed_weight = 0.3  # 群聊：仅 reply 有回应义务
            else:
                directed_weight = 0.0
            if directed_weight > 0:
                old_directed = G.node_attrs(channel_id).get("pending_directed", 0.0)
                G.set_node_attr(channel_id, "pending_directed", old_directed + directed_weight)
                G.set_node_attr(channel_id, "last_directed_tick", tick)

        # v3: 追踪 Contact 交互次数（tier 演化用）
        if contact_id in G:
            old_count = G.node_attrs(contact_id).get("interaction_count", 0)
            G.set_node_attr(contact_id, "interaction_count", old_count + 1)

        # P6: 新信息量
        if e.kind == EventKind.MESSAGE:
            msg_novelty = 0.3
            if e.has_entities:
                msg_novelty += 0.3
            if e.text_length > 200:
                msg_novelty += 0.2
            novelty_sum += msg_novelty

        # Thread 更新
        if e.thread_id and e.thread_id in G:
            pass  # thread age 由 created 固定

    # 有事件但可能全部不是 MESSAGE 类型 → novelty_sum=0 → avg=0
    avg_novelty = novelty_sum / len(events) if events else 0.0
    novelty_buffer.append(min(avg_novelty, 1.0))
    return len(events)


# ---------------------------------------------------------------------------
# 行动执行（v2: 目标导向）
# ---------------------------------------------------------------------------

def _execute_action(
    G: CompanionGraph,
    action_type: str,
    tick: int,
    rng: np.random.Generator,
    target: str | None = None,
) -> float:
    """执行行动并释放压力，返回反馈值。

    v2: 优先处理 target 实体（由目标选择层指定），
    随后处理额外实体以批量释放压力。
    """
    feedback = 0.0

    if action_type == "diligence":
        # 处理 open 线程（目标优先，再处理 1-2 个其他）
        threads = G.get_entities_by_type(NodeType.THREAD)
        open_threads = sorted(
            [tid for tid in threads if G.node_attrs(tid).get("status") == "open"],
            key=lambda t: G.node_attrs(t).get("created", 0),
        )
        # 目标线程优先
        if target and target in open_threads:
            open_threads.remove(target)
            open_threads.insert(0, target)
        n_resolve = min(int(rng.integers(1, 4)), len(open_threads))
        for i in range(n_resolve):
            G.set_node_attr(open_threads[i], "status", "resolved")
            feedback += 0.5

        # 清理频道 unread（目标频道优先）
        channels = G.get_entities_by_type(NodeType.CHANNEL)
        if target and target in channels:
            # 目标是频道：优先清理
            priority_channels = [target] + [c for c in channels if c != target]
        else:
            priority_channels = list(channels)
        n_clear = min(int(rng.integers(1, 4)), len(priority_channels))
        for hid in priority_channels[:n_clear]:
            unread = G.node_attrs(hid).get("unread", 0)
            if unread > 0:
                cleared = int(rng.integers(1, max(unread, 2) + 1))
                G.set_node_attr(hid, "unread", max(0, unread - cleared))
                feedback += 0.3
            # 清理 pending_directed
            directed = G.node_attrs(hid).get("pending_directed", 0.0)
            if directed > 0:
                G.set_node_attr(hid, "pending_directed", max(0.0, directed - 1.0))
                feedback += 0.2

    elif action_type == "curiosity":
        items = G.get_entities_by_type(NodeType.INFO_ITEM)
        tracked = sorted(
            [iid for iid in items if G.node_attrs(iid).get("tracked", False)],
            key=lambda iid: G.node_attrs(iid).get("created", 0),
        )
        # 目标优先
        if target and target in tracked:
            tracked.remove(target)
            tracked.insert(0, target)
        if tracked:
            n_refresh = min(int(rng.integers(3, 7)), len(tracked))
            for t in tracked[:n_refresh]:
                G.set_node_attr(t, "created", tick)
                feedback += 0.2

    elif action_type == "sociability":
        contacts = G.get_entities_by_type(NodeType.CONTACT)
        if contacts:
            # 目标优先
            if target and target in contacts:
                chosen = target
            else:
                chosen = contacts[int(rng.integers(0, len(contacts)))]
            G.set_node_attr(chosen, "last_active", tick)
            feedback = 0.6

    elif action_type == "caution":
        feedback = 0.2  # 等待本身也是合理行为

    elif action_type == "reflection":
        items = G.get_entities_by_type(NodeType.INFO_ITEM)
        if items:
            sorted_items = sorted(
                items,
                key=lambda iid: (
                    -G.node_attrs(iid).get("importance", 0),
                    G.node_attrs(iid).get("last_access", 0),
                ),
            )
            # 目标优先
            if target and target in sorted_items:
                sorted_items.remove(target)
                sorted_items.insert(0, target)
            n_consolidate = min(int(rng.integers(1, 4)), len(sorted_items))
            for t in sorted_items[:n_consolidate]:
                G.set_node_attr(t, "last_access", tick)
                old_s = G.node_attrs(t).get("stability", 1.0)
                G.set_node_attr(t, "stability", old_s * 1.2)
                feedback += 0.3

    return feedback


# ---------------------------------------------------------------------------
# 模拟引擎
# ---------------------------------------------------------------------------

class SimulationEngine:
    """基于事件流的压力场模拟引擎 — v2。"""

    def __init__(
        self,
        graph: CompanionGraph,
        event_stream: EventStream,
        config: SimConfig | None = None,
    ) -> None:
        self.G = graph
        self.stream = event_stream
        self.config = config or SimConfig()
        self.rng = np.random.default_rng(self.config.seed)
        self._kappa = _scale_kappa(graph)

    def run(self) -> list[TickRecord]:
        """运行完整模拟，返回每 tick 的快照。"""
        total_ticks = self.stream.total_ticks()
        if total_ticks <= 0:
            print("  警告：事件流为空，无法运行模拟")
            return []

        cfg = self.config
        personality = PersonalityVector(weights=cfg.personality_init.copy())
        pi_home = cfg.personality_init.copy()  # 均值回归目标

        api_history: list[float] = []  # v4: 存 napi（归一化值），不反馈到压力
        # P6 novelty_history：初始化为空，由 _apply_events 在每 tick 填充真实 novelty。
        # 不再预填假数据。前几个 tick P6 会因 history 短而偏高（好奇心强），
        # 这是合理行为——刚启动时确实应该好奇。
        novelty_history: list[float] = []
        event_count_history: list[int] = []
        action_window: list[bool] = []  # v4: 行动频率追踪
        records: list[TickRecord] = []
        last_action_tick = -cfg.cooldown_ticks

        napi_ema: float | None = None
        ticks_since_event = 0

        print(f"  开始模拟：{total_ticks} ticks (v4 解耦压力)")
        print(f"  自适应 κ: [{', '.join(f'{k:.1f}' for k in self._kappa)}]")

        for tick in range(1, total_ticks + 1):
            self.G.tick = tick

            # 1. 获取本 tick 的事件并映射到图状态
            tick_events = self.stream.events_in_tick(tick)
            n_events = _apply_events(self.G, tick_events, tick, novelty_history)
            event_count_history.append(n_events)

            if n_events > 0:
                ticks_since_event = 0
            else:
                ticks_since_event += 1

            # 2. 计算压力场（v4: P3 不读 API，含 Laplacian 传播）
            result = compute_all_pressures(
                self.G, tick,
                kappa=self._kappa,
                novelty_history=novelty_history,
                thread_age_scale=cfg.thread_age_scale,
            )
            napi_val = result["API"]  # v4: api_aggregate 已经是 tanh 归一化的
            contributions = result["contributions"]

            # 3. 更新 EMA
            if napi_ema is None:
                napi_ema = napi_val
            else:
                napi_ema = cfg.ema_alpha * napi_val + (1 - cfg.ema_alpha) * napi_ema

            # 4. v4 行动频率门：基于行动频率调整阈值
            action_rate = (
                sum(action_window[-cfg.action_rate_window:])
                / max(len(action_window[-cfg.action_rate_window:]), 1)
                if action_window else 0.0
            )
            fatigue_mod = cfg.fatigue_alpha * max(0.0, action_rate - cfg.action_rate_cap)
            initiative_mod = cfg.initiative_alpha * max(0.0, cfg.action_rate_floor - action_rate)
            effective_margin = cfg.trigger_margin * (1.0 + fatigue_mod - initiative_mod)

            # 5. 触发条件判断
            loudness = None
            action = None
            winner_idx = None
            feedback = 0.0
            target = None  # ADR-223: 初始化 target

            cooled_down = (tick - last_action_tick) >= cfg.cooldown_ticks

            if cfg.action_threshold is not None:
                effective_threshold = cfg.action_threshold * (1.0 + fatigue_mod - initiative_mod)
                should_act = napi_val > effective_threshold and cooled_down
            else:
                delta_trigger = (napi_val - napi_ema) > effective_margin
                idle_trigger = ticks_since_event >= cfg.idle_trigger_interval
                event_trigger = n_events > 0 and cooled_down
                should_act = cooled_down and (delta_trigger or idle_trigger or event_trigger)

            if should_act:
                loudness = compute_loudness(
                    self.G, tick, personality,
                    novelty_history=novelty_history,
                    recent_event_counts=event_count_history,
                    rng=self.rng,
                )
                winner_idx, action = select_action(loudness, rng=self.rng)

                target = _select_target(action, contributions)

                feedback = _execute_action(self.G, action, tick, self.rng, target=target)
                last_action_tick = tick

                # 行动本身带来高 novelty（0.7），影响下一 tick 的 P6 计算
                novelty_history.append(0.7)

                personality = personality_evolution_step(
                    personality, winner_idx, feedback,
                    alpha=cfg.personality_alpha,
                    gamma=cfg.personality_gamma,
                    pi_home=pi_home,
                    pi_min=cfg.personality_pi_min,
                )

            # v4: 记录行动频率窗口
            action_window.append(action is not None)

            # v4: api_history 存归一化值（纯观测量，不反馈到压力）
            api_history.append(napi_val)

            # v3: Tier 动态演化
            if (cfg.tier_eval_interval > 0
                    and tick % cfg.tier_eval_interval == 0):
                tier_changes = _evolve_tiers(self.G, tick)
                if tier_changes:
                    self._kappa = _scale_kappa(self.G)
                    for cid, (old_t, new_t) in tier_changes.items():
                        print(f"    [tier] tick {tick}: {cid} {old_t} → {new_t}")

            # 记录
            pressures_flat = {k: v for k, v in result.items()
                              if k != "contributions"}
            records.append(TickRecord(
                tick=tick,
                n_events=n_events,
                pressures=pressures_flat,
                napi=napi_val,
                loudness=loudness.copy() if loudness is not None else None,
                action=action,
                winner_idx=winner_idx,
                personality=personality.weights.copy(),
                feedback=feedback,
                target=target if action is not None else None,
            ))

        # 统计摘要
        n_actions = sum(1 for r in records if r.action is not None)
        action_dist: dict[str, int] = {}
        for r in records:
            if r.action:
                action_dist[r.action] = action_dist.get(r.action, 0) + 1

        print(f"  模拟完成：{total_ticks} ticks, {n_actions} 次行动 "
              f"({n_actions / total_ticks * 100:.1f}%)")
        if action_dist:
            print("  行动分布:")
            for atype, cnt in sorted(action_dist.items(), key=lambda x: -x[1]):
                print(f"    {atype}: {cnt} ({cnt / n_actions * 100:.1f}%)")

        # ADR-223: 目标分布度量
        tm = compute_target_metrics(records)
        if tm["distinct"] > 0:
            print(f"  目标度量: Gini={tm['gini']:.3f}, "
                  f"top-1={tm['top1_ratio']:.1%}, "
                  f"切换率={tm['switch_rate']:.1%}, "
                  f"不同目标={tm['distinct']}")

        return records

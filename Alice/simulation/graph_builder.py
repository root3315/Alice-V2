"""从 Telegram 解析结果自动构建 CompanionGraph。

将 ParsedChat 中的参与者、频道、推断线程和有价值消息
映射为 CompanionGraph 的五类节点和五类边。
"""
from __future__ import annotations

from collections import defaultdict

from graph import CompanionGraph, NodeType, DUNBAR_TIER_WEIGHT
from telegram_parser import ParsedChat, EventKind


# ---------------------------------------------------------------------------
# Dunbar 层级推断
# ---------------------------------------------------------------------------

def _infer_dunbar_tier(msg_count: int, total_msgs: int) -> int:
    """根据发言频率占比推断 Dunbar 层级。"""
    if total_msgs <= 0:
        return 500
    ratio = msg_count / total_msgs
    if ratio > 0.10:
        return 5      # 亲密圈
    if ratio > 0.03:
        return 15     # 好友圈
    if ratio > 0.01:
        return 50     # 朋友圈
    if ratio > 0.003:
        return 150    # 熟人圈
    return 500         # 认识圈


def _infer_thread_weight(thread_size: int, has_reactions: bool) -> str:
    """根据线程大小和是否有 reaction 推断线程权重。"""
    if thread_size >= 10 or has_reactions:
        return "major"
    if thread_size >= 5:
        return "minor"
    return "subtle"


# ---------------------------------------------------------------------------
# 图构建
# ---------------------------------------------------------------------------

def build_graph_from_chats(
    chats: list[ParsedChat],
    tick_rate: float = 60.0,
) -> CompanionGraph:
    """从解析结果自动构建 CompanionGraph。

    Parameters
    ----------
    chats : list[ParsedChat]
        解析后的聊天列表。
    tick_rate : float
        每 tick 对应的秒数（用于将时间戳转为 tick）。

    Returns
    -------
    CompanionGraph
    """
    G = CompanionGraph()
    G.tick = 0

    # 全局时间原点
    all_timestamps = []
    for chat in chats:
        all_timestamps.extend([e.timestamp for e in chat.events if e.timestamp > 0])
    time_origin = min(all_timestamps) if all_timestamps else 0.0

    def ts_to_tick(ts: float) -> int:
        return max(0, int((ts - time_origin) / tick_rate))

    # Agent（单例）
    G.add_entity(NodeType.AGENT, "agent_0")

    # 跟踪已创建的节点
    created_contacts: set[str] = set()
    created_channels: set[str] = set()
    created_threads: set[str] = set()

    # 第一遍：统计总消息数（跨所有聊天）
    total_msgs = sum(
        sum(chat.msg_count_by_sender.values())
        for chat in chats
    )
    # 合并所有聊天的 sender 消息计数
    global_sender_counts: dict[str, int] = defaultdict(int)
    for chat in chats:
        for sid, cnt in chat.msg_count_by_sender.items():
            global_sender_counts[sid] += cnt

    for chat in chats:
        channel_id = f"ch_{chat.chat_id}"

        # Channel 节点
        if channel_id not in created_channels:
            # 找该频道最活跃发言者的 tier 作为频道权重
            if chat.msg_count_by_sender:
                top_sender = max(chat.msg_count_by_sender, key=chat.msg_count_by_sender.get)
                top_tier = _infer_dunbar_tier(
                    global_sender_counts[top_sender], total_msgs
                )
            else:
                top_tier = 150
            G.add_entity(
                NodeType.CHANNEL, channel_id,
                unread=0,
                tier_contact=top_tier,
                chat_type=chat.chat_type,  # v3: 保留聊天类型
            )
            G.add_relation("agent_0", "monitors", channel_id)
            created_channels.add(channel_id)

        # Contact 节点
        for sender_id, sender_name in chat.participants.items():
            contact_id = f"ct_{sender_id}"
            if contact_id not in created_contacts:
                tier = _infer_dunbar_tier(
                    global_sender_counts.get(sender_id, 0), total_msgs
                )
                social_label = {
                    5: "friend", 15: "friend", 50: "acquaintance",
                    150: "acquaintance", 500: "stranger",
                }.get(tier, "acquaintance")

                G.add_entity(
                    NodeType.CONTACT, contact_id,
                    tier=tier,
                    trust=0.5,
                    last_active=0,
                    display_name=sender_name,
                )
                G.add_relation("agent_0", social_label, contact_id)
                created_contacts.add(contact_id)

            # Contact -> Channel 边
            G.add_relation(contact_id, "in", channel_id)

        # Thread 节点
        # 统计每个线程的大小和是否有 reaction
        thread_sizes: dict[str, int] = defaultdict(int)
        thread_has_reaction: dict[str, bool] = defaultdict(bool)
        thread_created_ts: dict[str, float] = {}
        thread_participants: dict[str, set[str]] = defaultdict(set)

        for e in chat.events:
            if e.thread_id:
                thread_sizes[e.thread_id] += 1
                if e.kind == EventKind.REACTION:
                    thread_has_reaction[e.thread_id] = True
                if e.thread_id not in thread_created_ts:
                    thread_created_ts[e.thread_id] = e.timestamp
                thread_participants[e.thread_id].add(e.sender_id)

        for tid, size in thread_sizes.items():
            if tid not in created_threads:
                weight = _infer_thread_weight(size, thread_has_reaction.get(tid, False))
                created_tick = ts_to_tick(thread_created_ts.get(tid, time_origin))
                G.add_entity(
                    NodeType.THREAD, tid,
                    status="open",
                    weight=weight,
                    created=created_tick,
                    deadline=float("inf"),
                )
                G.add_relation("agent_0", "tracks", tid)

                # Thread -> Contact 边
                for sid in thread_participants.get(tid, set()):
                    cid = f"ct_{sid}"
                    if cid in created_contacts:
                        G.add_relation(tid, "involves", cid)

                created_threads.add(tid)

        # InfoItem 节点（含链接或高 reaction 的消息）
        for e in chat.events:
            if e.kind != EventKind.MESSAGE:
                continue
            if not e.has_entities and e.text_length < 200:
                continue
            info_id = f"info_{e.message_id}"
            # 计算 importance：有链接 + 长文本
            importance = 0.3
            if e.has_entities:
                importance += 0.3
            if e.text_length > 200:
                importance += 0.2

            G.add_entity(
                NodeType.INFO_ITEM, info_id,
                importance=min(importance, 1.0),
                stability=2.0,
                last_access=ts_to_tick(e.timestamp),
                volatility=0.5,
                tracked=True,
                created=ts_to_tick(e.timestamp),
                novelty=0.8,
            )
            G.add_relation("agent_0", "knows", info_id)

    return G

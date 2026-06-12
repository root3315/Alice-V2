"""Telegram Desktop 导出 JSON 解析器。

将 result.json 转为标准化 Event 序列，并通过 Reply-Chain + 时间窗口聚类
从 reply_to_message_id 推断话题线程。
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# 事件类型
# ---------------------------------------------------------------------------

class EventKind(Enum):
    MESSAGE = "message"
    REACTION = "reaction"
    SERVICE = "service"


# ---------------------------------------------------------------------------
# 标准化事件
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Event:
    """标准化事件，按 timestamp 排序。"""
    timestamp: float
    kind: EventKind
    channel_id: str
    sender_id: str
    sender_name: str
    message_id: int
    reply_to: int | None = None
    text_length: int = 0
    has_entities: bool = False
    thread_id: str | None = None

    def __lt__(self, other: Event) -> bool:
        return self.timestamp < other.timestamp


# ---------------------------------------------------------------------------
# 解析结果
# ---------------------------------------------------------------------------

@dataclass
class ParsedChat:
    """一个聊天的解析结果。"""
    chat_name: str
    chat_type: str
    chat_id: str
    events: list[Event]
    participants: dict[str, str]       # sender_id -> sender_name
    thread_map: dict[int, str]         # message_id -> thread_id
    time_range: tuple[float, float]    # (earliest, latest)
    msg_count_by_sender: dict[str, int]  # sender_id -> message count


# ---------------------------------------------------------------------------
# 文本字段提取
# ---------------------------------------------------------------------------

def _extract_text_info(text_field: Any) -> tuple[int, bool]:
    """从 Telegram 的 text 字段提取 (文本长度, 是否含实体)。

    text 可能是纯 str，也可能是 list[str | dict]。
    """
    if isinstance(text_field, str):
        return len(text_field), False
    if isinstance(text_field, list):
        total_len = 0
        has_entities = False
        for part in text_field:
            if isinstance(part, str):
                total_len += len(part)
            elif isinstance(part, dict):
                total_len += len(part.get("text", ""))
                if part.get("type") in ("link", "mention", "code", "pre"):
                    has_entities = True
        return total_len, has_entities
    return 0, False


# ---------------------------------------------------------------------------
# Union-Find（用于线程推断）
# ---------------------------------------------------------------------------

class _UnionFind:
    """简单的 Union-Find 实现。"""

    def __init__(self) -> None:
        self._parent: dict[int, int] = {}
        self._rank: dict[int, int] = {}

    def find(self, x: int) -> int:
        if x not in self._parent:
            self._parent[x] = x
            self._rank[x] = 0
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]  # 路径压缩
            x = self._parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        # 按秩合并（偏好较小的 id 作为根，即较早的消息）
        if ra > rb:
            ra, rb = rb, ra
        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1


# ---------------------------------------------------------------------------
# 线程推断
# ---------------------------------------------------------------------------

class ThreadInferrer:
    """从 reply_to_message_id 链 + 时间窗口推断话题线程。

    算法：
    1. 构建 reply 森林（Union-Find 合并 reply 链）
    2. 同 sender 的连续消息若间隔 < temporal_gap 且前者已属于某线程，合并
    3. 过滤成员数 < min_thread_size 的线程
    """

    def __init__(
        self,
        temporal_gap: float = 300.0,
        min_thread_size: int = 3,
    ) -> None:
        self.temporal_gap = temporal_gap
        self.min_thread_size = min_thread_size

    def infer(self, events: list[Event]) -> dict[int, str]:
        """返回 message_id -> thread_id 的映射。"""
        uf = _UnionFind()
        msg_ids = {e.message_id for e in events}

        # 阶段 1：reply 链合并
        for e in events:
            uf.find(e.message_id)  # 确保注册
            if e.reply_to is not None and e.reply_to in msg_ids:
                uf.union(e.message_id, e.reply_to)

        # 阶段 2：同 sender 时间窗口扩展
        by_sender: dict[str, list[Event]] = defaultdict(list)
        for e in events:
            by_sender[e.sender_id].append(e)

        for sender_events in by_sender.values():
            sender_events.sort(key=lambda e: e.timestamp)
            for i in range(1, len(sender_events)):
                prev, curr = sender_events[i - 1], sender_events[i]
                if curr.timestamp - prev.timestamp < self.temporal_gap:
                    # 如果前一条已属于某个非单例组，合并
                    prev_root = uf.find(prev.message_id)
                    if prev.reply_to is not None or prev_root != prev.message_id:
                        uf.union(curr.message_id, prev.message_id)

        # 阶段 3：收集线程，过滤
        groups: dict[int, list[int]] = defaultdict(list)
        for e in events:
            root = uf.find(e.message_id)
            groups[root].append(e.message_id)

        result: dict[int, str] = {}
        for root, members in groups.items():
            if len(members) >= self.min_thread_size:
                thread_id = f"thread_{root}"
                for mid in members:
                    result[mid] = thread_id

        return result


# ---------------------------------------------------------------------------
# 主解析函数
# ---------------------------------------------------------------------------

def parse_telegram_export(
    path: str | Path,
    thread_inferrer: ThreadInferrer | None = None,
) -> ParsedChat:
    """解析单个 Telegram Desktop 导出 JSON 文件。

    Parameters
    ----------
    path : str | Path
        result.json 文件路径。
    thread_inferrer : ThreadInferrer | None
        线程推断器。None 时使用默认参数。

    Returns
    -------
    ParsedChat
    """
    path = Path(path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    chat_name = data.get("name", "unknown")
    chat_type = data.get("type", "unknown")
    chat_id = str(data.get("id", 0))

    if thread_inferrer is None:
        thread_inferrer = ThreadInferrer()

    events: list[Event] = []
    participants: dict[str, str] = {}
    msg_counts: dict[str, int] = defaultdict(int)

    for msg in data.get("messages", []):
        msg_type = msg.get("type", "")
        sender_id = msg.get("from_id", "")
        sender_name = msg.get("from", "")

        # 处理缺失的 sender 信息
        if not sender_id:
            sender_id = f"unknown_{msg.get('id', 0)}"
        if not sender_name:
            sender_name = sender_id

        ts_str = msg.get("date_unixtime", "0")
        timestamp = float(ts_str)

        if msg_type == "message":
            text_len, has_ent = _extract_text_info(msg.get("text", ""))
            reply_to = msg.get("reply_to_message_id")

            events.append(Event(
                timestamp=timestamp,
                kind=EventKind.MESSAGE,
                channel_id=chat_id,
                sender_id=sender_id,
                sender_name=sender_name,
                message_id=msg.get("id", 0),
                reply_to=reply_to,
                text_length=text_len,
                has_entities=has_ent,
            ))

            participants[sender_id] = sender_name
            msg_counts[sender_id] += 1

            # Reaction 事件（每个 reaction 独立生成一个 Event）
            for reaction in msg.get("reactions", []):
                for recent in reaction.get("recent", []):
                    r_sender_id = recent.get("from_id", "")
                    r_sender_name = recent.get("from", "")
                    if not r_sender_id:
                        continue
                    events.append(Event(
                        timestamp=timestamp + 1.0,  # 偏移 1 秒
                        kind=EventKind.REACTION,
                        channel_id=chat_id,
                        sender_id=r_sender_id,
                        sender_name=r_sender_name,
                        message_id=msg.get("id", 0),
                    ))
                    participants[r_sender_id] = r_sender_name

        elif msg_type == "service":
            events.append(Event(
                timestamp=timestamp,
                kind=EventKind.SERVICE,
                channel_id=chat_id,
                sender_id=sender_id,
                sender_name=sender_name,
                message_id=msg.get("id", 0),
            ))

    # 排序
    events.sort()

    # 线程推断（只在 MESSAGE 事件上做）
    msg_events = [e for e in events if e.kind == EventKind.MESSAGE]
    thread_map = thread_inferrer.infer(msg_events)

    # 将 thread_id 写回事件（创建新事件替换旧事件）
    thread_lookup = thread_map
    new_events: list[Event] = []
    for e in events:
        tid = thread_lookup.get(e.message_id)
        if tid is not None and e.thread_id is None:
            # frozen dataclass，需要创建新实例
            new_events.append(Event(
                timestamp=e.timestamp,
                kind=e.kind,
                channel_id=e.channel_id,
                sender_id=e.sender_id,
                sender_name=e.sender_name,
                message_id=e.message_id,
                reply_to=e.reply_to,
                text_length=e.text_length,
                has_entities=e.has_entities,
                thread_id=tid,
            ))
        else:
            new_events.append(e)

    # 时间范围
    timestamps = [e.timestamp for e in new_events if e.timestamp > 0]
    time_range = (min(timestamps), max(timestamps)) if timestamps else (0.0, 0.0)

    return ParsedChat(
        chat_name=chat_name,
        chat_type=chat_type,
        chat_id=chat_id,
        events=new_events,
        participants=participants,
        thread_map=thread_map,
        time_range=time_range,
        msg_count_by_sender=dict(msg_counts),
    )


def load_multiple_chats(paths: list[str | Path]) -> list[ParsedChat]:
    """加载多个导出文件。"""
    return [parse_telegram_export(p) for p in paths]

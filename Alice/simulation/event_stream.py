"""事件流引擎：合并、排序、时间映射、噪声注入。

将多个 ParsedChat 的事件合并为统一的按 tick 索引的事件流，
支持可配置的噪声注入（突发消息、沉默期、新联系人）。
"""
from __future__ import annotations

import copy
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

from telegram_parser import Event, EventKind


@dataclass
class EventStream:
    """按 tick 索引的事件流。"""

    events: list[Event]
    time_origin: float
    time_end: float
    tick_rate: float
    _tick_index: dict[int, list[Event]]

    @classmethod
    def from_events(
        cls,
        events: list[Event],
        tick_rate: float = 60.0,
    ) -> EventStream:
        """从事件列表构建。"""
        if not events:
            return cls([], 0.0, 0.0, tick_rate, {})

        sorted_events = sorted(events)
        time_origin = sorted_events[0].timestamp
        time_end = sorted_events[-1].timestamp

        # 预构建 tick -> events 字典
        tick_index: dict[int, list[Event]] = defaultdict(list)
        for e in sorted_events:
            tick = max(1, int((e.timestamp - time_origin) / tick_rate) + 1)
            tick_index[tick].append(e)

        return cls(
            events=sorted_events,
            time_origin=time_origin,
            time_end=time_end,
            tick_rate=tick_rate,
            _tick_index=dict(tick_index),
        )

    def events_in_tick(self, tick: int) -> list[Event]:
        """返回第 tick 个时间窗口内的所有事件。O(1)。"""
        return self._tick_index.get(tick, [])

    def total_ticks(self) -> int:
        """总 tick 数。"""
        if self.time_end <= self.time_origin:
            return 0
        return int((self.time_end - self.time_origin) / self.tick_rate) + 1

    def inject_noise(
        self,
        rng: np.random.Generator,
        burst_rate: float = 0.02,
        silence_rate: float = 0.01,
        new_contact_rate: float = 0.005,
    ) -> EventStream:
        """在事件流中注入噪声，返回新 EventStream。

        Parameters
        ----------
        burst_rate : float
            每个 tick 突发消息的概率。
        silence_rate : float
            每个 tick 开始沉默期的概率。
        new_contact_rate : float
            每个 tick 出现新联系人的概率。
        """
        total = self.total_ticks()
        if total <= 0:
            return self

        # 收集已有的 channel_id 和 sender_id
        channel_ids = list({e.channel_id for e in self.events})
        sender_ids = list({e.sender_id for e in self.events})
        if not channel_ids:
            return self

        new_events = list(self.events)
        noise_contact_counter = 0
        silenced_ticks: set[int] = set()

        for tick in range(1, total + 1):
            if tick in silenced_ticks:
                continue

            # 沉默期：删除后续 5-20 tick 的事件
            if rng.random() < silence_rate:
                silence_len = int(rng.integers(5, 21))
                for t in range(tick, min(tick + silence_len, total + 1)):
                    silenced_ticks.add(t)
                continue

            # 突发消息
            if rng.random() < burst_rate:
                n_burst = int(rng.integers(3, 11))
                for _ in range(n_burst):
                    ch = rng.choice(channel_ids)
                    sender = rng.choice(sender_ids)
                    ts = self.time_origin + (tick - 0.5) * self.tick_rate + rng.random() * self.tick_rate
                    new_events.append(Event(
                        timestamp=ts,
                        kind=EventKind.MESSAGE,
                        channel_id=ch,
                        sender_id=sender,
                        sender_name=f"noise_{sender}",
                        message_id=int(9_000_000 + tick * 100 + rng.integers(0, 100)),
                        text_length=int(rng.integers(5, 100)),
                    ))

            # 新联系人
            if rng.random() < new_contact_rate:
                noise_contact_counter += 1
                new_sid = f"noise_user_{noise_contact_counter}"
                ch = rng.choice(channel_ids)
                ts = self.time_origin + tick * self.tick_rate
                new_events.append(Event(
                    timestamp=ts,
                    kind=EventKind.MESSAGE,
                    channel_id=ch,
                    sender_id=new_sid,
                    sender_name=f"NewUser_{noise_contact_counter}",
                    message_id=int(9_500_000 + noise_contact_counter),
                    text_length=int(rng.integers(10, 50)),
                ))

        # 过滤沉默期的事件
        if silenced_ticks:
            filtered = []
            for e in new_events:
                tick = max(1, int((e.timestamp - self.time_origin) / self.tick_rate) + 1)
                if tick not in silenced_ticks:
                    filtered.append(e)
            new_events = filtered

        return EventStream.from_events(new_events, self.tick_rate)

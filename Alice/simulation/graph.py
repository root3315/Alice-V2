"""数字伴侣社交图数据模型。

提供基于 networkx.DiGraph 的 CompanionGraph 类，
包含五类顶点（Agent, Contact, Thread, Channel, InfoItem）
和五类边（spatial, social, cognitive, causal, ownership）。

v3 新增：chat_type 语义、interaction_count、图序列化。
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Any

import numpy as np
import networkx as nx


# ---------------------------------------------------------------------------
# 枚举定义
# ---------------------------------------------------------------------------

class NodeType(Enum):
    """社交图中的节点类型。"""
    AGENT = "agent"
    CONTACT = "contact"
    THREAD = "thread"
    CHANNEL = "channel"
    INFO_ITEM = "info_item"


class EdgeCategory(Enum):
    """社交图中的边类别。"""
    SPATIAL = "spatial"         # monitors, joined
    SOCIAL = "social"           # owner, friend, acquaintance, stranger
    COGNITIVE = "cognitive"     # knows, suspects, tracks
    CAUSAL = "causal"           # caused, promised, discovered
    OWNERSHIP = "ownership"     # involves, from, in


# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# Dunbar 层级权重：圈层越小权重越高
DUNBAR_TIER_WEIGHT: dict[int, float] = {
    5:   5.0,    # 亲密圈
    15:  3.0,    # 好友圈
    50:  1.5,    # 朋友圈
    150: 0.8,    # 熟人圈
    500: 0.3,    # 认识圈
}

# Dunbar 层级的期望互动频率 theta_c（单位: agent tick = 分钟）
#
# ── DUNBAR_TIER_THETA 标定 ──────────────────────────────────
#
# theta_c 是 P3（关系冷却）sigmoid 函数的拐点：
# 当沉默时长超过 theta_c 时，冷却压力快速上升。
# 含义：theta_c 是"Alice 感到该层级联系人正在冷却"的临界等待时间。
#
# 标定依据（Dunbar 层级研究 + 第一性原理推理）：
#
# 参考文献：
# - Dunbar, R.I.M. (2018) "The Anatomy of Friendship", Trends in Cognitive Sciences
#   发现层级的维系频率：support clique（5人）需要每周接触，
#   sympathy group（15人）需要每月接触。
#   (https://www.sciencedirect.com/science/article/abs/pii/S1364661317302243)
# - BBC: "frequency at which you see people" 决定层级归属。
#   (https://www.bbc.com/future/article/20191001-dunbars-number-why-we-can-only-maintain-150-relationships)
# - Dunbar 研究：人类将约 40% 社交时间投入最亲密的 5 人，
#   再 20% 投入接下来的 10 人（好友圈）。
#   (https://www.christopherroosen.com/blog/2019/4/26/relationships-are-a-limited-numbers-game)
# - "Calling Dunbar's numbers" (Social Networks, 2016)
#   用手机通话数据验证了层级结构的存在。
#   (https://www.sciencedirect.com/science/article/pii/S0378873316301095)
#
# 推理过程：
#
# 1 tick = 1 分钟（tick_rate = 60s）
#
# Tier 5（亲密圈，5人）— theta = 20 分钟
#   theta_c 校准（#3.1）：原值 5 分钟制造焦虑型依恋（Bowlby 安全基地理论
#   要求更高阈值）。安全型依恋阈值：亲密圈 20 分钟。
#   即时回复需求已由 P5 覆盖，P3 只需测量"关系冷却"而非"等回复"。
#
# Tier 15（好友圈，15人）— theta = 30 分钟
#   同理，原值 15 分钟过于激进。30 分钟更符合安全型依恋的
#   好友互动节奏。
#
# Tier 50（朋友圈，50人）— theta = 40 分钟
#   普通朋友之间 40 分钟的沉默是正常的。
#   对应"一个忙碌时段后再回来看消息"的时间尺度。
#
# Tier 150（熟人圈，150人）— theta = 80 分钟（~1.3 小时）
#   熟人之间一两个小时不互动完全正常。
#   对应"午饭或一节课的时间跨度"。
#
# Tier 500（认识圈，500人）— theta = 200 分钟（~3.3 小时）
#   几乎不熟的人，半天不互动才会产生微弱的冷却感。
#   对应"半个工作日"。
#
# 重要假设：
# - 这些 theta 值是为 AI 伴侣校准的，不是模拟人类行为。
#   Alice 作为"持续在线的电子伴侣"，其互动期望高于普通人类。
#   如果是模拟人类社交，theta 值应至少 10x。
# - theta 只控制 sigmoid 拐点，不控制压力上限。
#   即使沉默远超 theta，P3 的绝对值仍由 DUNBAR_TIER_WEIGHT 约束。
#
# 敏感性：theta ±50% 改变的是冷却压力上升的"节奏"，
# 但不改变长期平衡态（长期行为由 tier_weight 和声部竞争决定）。
# ──────────────────────────────────────────────────────────
DUNBAR_TIER_THETA: dict[int, float] = {
    5:   20.0,   # 亲密圈：约 20 tick（20 分钟）— #3.1 安全型依恋校准
    15:  30.0,   # 好友圈：约 30 tick（30 分钟）— #3.1 安全型依恋校准
    50:  40.0,   # 朋友圈：约 40 tick（40 分钟）
    150: 80.0,   # 熟人圈：约 80 tick（1.3 小时）
    500: 200.0,  # 认识圈：约 200 tick（3.3 小时）
}

THREAD_WEIGHTS: dict[str, float] = {"major": 2.0, "minor": 1.0, "subtle": 0.5}

# 边标签 -> 边类别映射
_LABEL_CATEGORY: dict[str, EdgeCategory] = {
    "monitors":     EdgeCategory.SPATIAL,
    "joined":       EdgeCategory.SPATIAL,
    "owner":        EdgeCategory.SOCIAL,
    "friend":       EdgeCategory.SOCIAL,
    "acquaintance": EdgeCategory.SOCIAL,
    "stranger":     EdgeCategory.SOCIAL,
    "knows":        EdgeCategory.COGNITIVE,
    "suspects":     EdgeCategory.COGNITIVE,
    "tracks":       EdgeCategory.COGNITIVE,
    "caused":       EdgeCategory.CAUSAL,
    "promised":     EdgeCategory.CAUSAL,
    "discovered":   EdgeCategory.CAUSAL,
    "involves":     EdgeCategory.OWNERSHIP,
    "from":         EdgeCategory.OWNERSHIP,
    "in":           EdgeCategory.OWNERSHIP,
}


def label_to_category(label: str) -> EdgeCategory:
    """将边标签映射到其所属类别，未知标签默认为 OWNERSHIP。"""
    return _LABEL_CATEGORY.get(label, EdgeCategory.OWNERSHIP)


# ---------------------------------------------------------------------------
# CompanionGraph 核心类
# ---------------------------------------------------------------------------

class CompanionGraph:
    """基于 networkx.DiGraph 的数字伴侣社交图。

    每个节点具有 ``entity_type`` 属性（NodeType 枚举值），
    以及该类型特有的附加属性。边具有 ``label`` 和 ``category`` 属性。
    """

    def __init__(self) -> None:
        self._graph: nx.DiGraph = nx.DiGraph()
        self._tick: int = 0  # Agent tick n

    # -- 属性 ---------------------------------------------------------------

    @property
    def tick(self) -> int:
        """当前 agent tick n。"""
        return self._tick

    @tick.setter
    def tick(self, value: int) -> None:
        self._tick = value

    # -- 节点操作 -----------------------------------------------------------

    def add_entity(self, entity_type: NodeType, node_id: str, **attrs: Any) -> None:
        """添加一个带类型的实体节点。"""
        # 为特定类型设置默认属性
        if entity_type == NodeType.CONTACT:
            attrs.setdefault("tier", 150)
            attrs.setdefault("trust", 0.5)
            attrs.setdefault("last_active", 0)
            attrs.setdefault("auth_level", 0)
            attrs.setdefault("interaction_count", 0)  # v3: tier 演化用
        elif entity_type == NodeType.THREAD:
            attrs.setdefault("status", "open")
            attrs.setdefault("created", self._tick)
            attrs.setdefault("deadline", float("inf"))
            attrs.setdefault("weight", "minor")
            attrs["w"] = THREAD_WEIGHTS.get(attrs["weight"], 1.0)
        elif entity_type == NodeType.CHANNEL:
            attrs.setdefault("unread", 0)
            attrs.setdefault("tier_contact", 150)  # 频道中最高优先级联系人的 Dunbar 层级
            attrs.setdefault("chat_type", "group")  # v3: private/group/supergroup/channel
        elif entity_type == NodeType.INFO_ITEM:
            attrs.setdefault("importance", 0.5)
            attrs.setdefault("stability", 1.0)
            attrs.setdefault("last_access", self._tick)
            attrs.setdefault("volatility", 0.5)
            attrs.setdefault("tracked", False)
            attrs.setdefault("created", self._tick)
            attrs.setdefault("novelty", 1.0)

        self._graph.add_node(node_id, entity_type=entity_type, **attrs)

    def get_entities_by_type(self, entity_type: NodeType) -> list[str]:
        """返回指定类型的所有节点 id 列表。"""
        return [
            n for n, d in self._graph.nodes(data=True)
            if d.get("entity_type") == entity_type
        ]

    def node_attrs(self, node_id: str) -> dict[str, Any]:
        """返回节点的属性字典（副本）。"""
        return dict(self._graph.nodes[node_id])

    def set_node_attr(self, node_id: str, key: str, value: Any) -> None:
        """设置节点的某个属性。"""
        self._graph.nodes[node_id][key] = value

    # -- 边操作 -------------------------------------------------------------

    def add_relation(self, src: str, label: str, dst: str, **attrs: Any) -> None:
        """添加一条带标签的有向边。"""
        category = label_to_category(label)
        self._graph.add_edge(src, dst, label=label, category=category, **attrs)

    def get_neighbors(self, node_id: str, label: str | None = None) -> list[str]:
        """返回节点的后继邻居列表，可选按标签过滤。"""
        if label is None:
            return list(self._graph.successors(node_id))
        return [
            dst for _, dst, d in self._graph.out_edges(node_id, data=True)
            if d.get("label") == label
        ]

    def get_predecessors(self, node_id: str, label: str | None = None) -> list[str]:
        """返回节点的前驱邻居列表，可选按标签过滤。"""
        if label is None:
            return list(self._graph.predecessors(node_id))
        return [
            src for src, _, d in self._graph.in_edges(node_id, data=True)
            if d.get("label") == label
        ]

    # -- 导出 ---------------------------------------------------------------

    def to_networkx(self) -> nx.DiGraph:
        """返回底层 networkx 有向图（非副本）。"""
        return self._graph

    # -- 序列化 (v3) -------------------------------------------------------

    def to_dict(self) -> dict:
        """序列化为可 JSON 化的字典。

        所有 enum 转为 str，float("inf") 转为 "inf"。
        """
        nodes = []
        for nid, data in self._graph.nodes(data=True):
            nd = dict(data)
            nd["entity_type"] = nd["entity_type"].value
            for k, v in list(nd.items()):
                if isinstance(v, float) and v == float("inf"):
                    nd[k] = "inf"
            nodes.append({"id": nid, **nd})

        edges = []
        for src, dst, data in self._graph.edges(data=True):
            ed = dict(data)
            ed["category"] = ed["category"].value
            edges.append({"src": src, "dst": dst, **ed})

        return {"tick": self._tick, "nodes": nodes, "edges": edges}

    @classmethod
    def from_dict(cls, data: dict) -> CompanionGraph:
        """从字典反序列化。"""
        G = cls()
        G._tick = data["tick"]
        for node in data["nodes"]:
            node = dict(node)  # 不修改原 dict
            nid = node.pop("id")
            etype = NodeType(node.pop("entity_type"))
            for k, v in list(node.items()):
                if v == "inf":
                    node[k] = float("inf")
            G._graph.add_node(nid, entity_type=etype, **node)
        for edge in data["edges"]:
            edge = dict(edge)
            src, dst = edge.pop("src"), edge.pop("dst")
            cat = EdgeCategory(edge.pop("category"))
            G._graph.add_edge(src, dst, category=cat, **edge)
        return G

    def save_json(self, path: str) -> None:
        """将图状态保存到 JSON 文件。"""
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load_json(cls, path: str) -> CompanionGraph:
        """从 JSON 文件加载图状态。"""
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    # -- 便捷方法 -----------------------------------------------------------

    def __contains__(self, node_id: str) -> bool:
        return node_id in self._graph

    def __len__(self) -> int:
        return len(self._graph)

    def __repr__(self) -> str:
        n_nodes = self._graph.number_of_nodes()
        n_edges = self._graph.number_of_edges()
        return f"CompanionGraph(nodes={n_nodes}, edges={n_edges}, tick={self._tick})"


# ---------------------------------------------------------------------------
# 合成社交图生成
# ---------------------------------------------------------------------------

def random_companion_graph(
    n_contacts: int = 20,
    n_threads: int = 5,
    n_channels: int = 4,
    n_info_items: int = 10,
    dunbar_distribution: dict[int, float] | None = None,
    seed: int | None = None,
) -> CompanionGraph:
    """生成一个具有可配置 Dunbar 层级的合成社交图。

    Parameters
    ----------
    n_contacts : int
        联系人数量。
    n_threads : int
        活跃线程数量。
    n_channels : int
        频道数量。
    n_info_items : int
        信息项数量。
    dunbar_distribution : dict[int, float] | None
        各 Dunbar 层级的概率分布。为 None 时使用默认分布：
        {5: 0.05, 15: 0.10, 50: 0.25, 150: 0.35, 500: 0.25}
    seed : int | None
        随机种子。

    Returns
    -------
    CompanionGraph
        生成的社交图。
    """
    rng = np.random.default_rng(seed)
    G = CompanionGraph()
    G.tick = 0

    # 默认 Dunbar 层级分布
    if dunbar_distribution is None:
        dunbar_distribution = {5: 0.05, 15: 0.10, 50: 0.25, 150: 0.35, 500: 0.25}
    tiers = list(dunbar_distribution.keys())
    tier_probs = np.array(list(dunbar_distribution.values()))
    tier_probs /= tier_probs.sum()

    # -- 创建 Agent（单例）---------------------------------------------------
    G.add_entity(NodeType.AGENT, "agent_0")

    # -- 创建 Contacts 并分配 Dunbar 层级 -----------------------------------
    contact_ids: list[str] = []
    for i in range(n_contacts):
        cid = f"contact_{i}"
        tier = int(rng.choice(tiers, p=tier_probs))
        trust = float(np.clip(rng.normal(0.5, 0.2), 0.0, 1.0))
        # last_active: 随机过去某个时刻（0 ~ 50 之间）
        last_active = int(rng.integers(0, 51))
        G.add_entity(
            NodeType.CONTACT, cid,
            tier=tier,
            trust=trust,
            last_active=last_active,
        )
        contact_ids.append(cid)

        # Agent 和 Contact 之间的社交边（标签取决于层级）
        social_label = {5: "owner", 15: "friend", 50: "friend",
                        150: "acquaintance", 500: "stranger"}.get(tier, "acquaintance")
        G.add_relation("agent_0", social_label, cid)

    # -- 创建 Channels -------------------------------------------------------
    channel_ids: list[str] = []
    for i in range(n_channels):
        hid = f"channel_{i}"
        unread = int(rng.integers(0, 20))
        # 频道中最高优先级联系人的层级
        tier_contact = int(rng.choice(tiers, p=tier_probs))
        # v3: 第一个频道为 private（模拟与最活跃联系人的私聊），其余 group
        chat_type = "private" if i == 0 else "group"
        G.add_entity(
            NodeType.CHANNEL, hid,
            unread=unread,
            tier_contact=tier_contact,
            chat_type=chat_type,
        )
        channel_ids.append(hid)

        # Agent 监控该频道
        G.add_relation("agent_0", "monitors", hid)

        # 随机关联 1~3 个 Contact 到该频道
        n_assoc = min(int(rng.integers(1, 4)), n_contacts)
        assoc_contacts = rng.choice(contact_ids, size=n_assoc, replace=False)
        for cid in assoc_contacts:
            G.add_relation(cid, "in", hid)

    # -- 创建 Threads --------------------------------------------------------
    weight_names = list(THREAD_WEIGHTS.keys())
    thread_ids: list[str] = []
    for i in range(n_threads):
        tid = f"thread_{i}"
        w_name = weight_names[int(rng.integers(0, len(weight_names)))]
        created = int(rng.integers(0, 30))
        has_deadline = rng.random() < 0.3
        deadline = float(created + int(rng.integers(20, 80))) if has_deadline else float("inf")
        G.add_entity(
            NodeType.THREAD, tid,
            status="open",
            weight=w_name,
            created=created,
            deadline=deadline,
        )
        thread_ids.append(tid)

        # Agent 追踪该线程
        G.add_relation("agent_0", "tracks", tid)

        # 线程关联 1~2 个 Contact
        n_assoc = min(int(rng.integers(1, 3)), n_contacts)
        assoc_contacts = rng.choice(contact_ids, size=n_assoc, replace=False)
        for cid in assoc_contacts:
            G.add_relation(tid, "involves", cid)

    # -- 创建 InfoItems ------------------------------------------------------
    for i in range(n_info_items):
        iid = f"info_{i}"
        importance = float(np.clip(rng.normal(0.5, 0.3), 0.0, 1.0))
        stability = float(np.clip(rng.exponential(2.0), 0.5, 20.0))
        volatility = float(np.clip(rng.exponential(0.5), 0.01, 2.0))
        last_access = int(rng.integers(0, 30))
        tracked = rng.random() < 0.4
        novelty = float(np.clip(rng.normal(0.5, 0.3), 0.0, 1.0))
        G.add_entity(
            NodeType.INFO_ITEM, iid,
            importance=importance,
            stability=stability,
            last_access=last_access,
            volatility=volatility,
            tracked=tracked,
            created=int(rng.integers(0, 30)),
            novelty=novelty,
        )

        # Agent 知晓该信息
        G.add_relation("agent_0", "knows", iid)

    return G

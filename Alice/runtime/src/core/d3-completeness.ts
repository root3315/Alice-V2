/**
 * D3 工具面完整性检查 — Paper 2, Axiom 3: Σ = (I, Q, L, R)。
 *
 * 四类工具面必须非空：
 *   I (Information)  — 获取信息的查询（read-only）
 *   Q (Question)     — 向外部提问
 *   L (Locomotion)   — 改变自身状态/位置
 *   R (Relation)     — 改变社交关系
 *
 * 启动时运行一次，缺失类别发出警告日志。
 * 不阻塞启动——只是诊断。
 *
 * @see paper/ §Axiom 3 "Tool Surface Completeness"
 */

import { createLogger } from "../utils/logger.js";
import type { Dispatcher } from "./dispatcher.js";

const log = createLogger("d3");

/** 工具面类别定义。 */
interface ToolCategory {
  /** 类别名称（人类可读）。 */
  name: string;
  /** 类别说明。 */
  description: string;
  /** 指令/查询名匹配模式（小写子串匹配）。 */
  patterns: string[];
}

/**
 * 四类工具面 — 对应 Axiom 3 的 Σ = (I, Q, L, R)。
 *
 * patterns 基于 Alice 已注册的指令/查询命名约定：
 * - I: 读取类查询（GET_*, QUERY_*, SEARCH_*, LIST_*, FETCH_*, READ_*）
 * - Q: 外部交互类（ASK_*, REQUEST_*, INVITE_*）
 * - L: 状态变更类（SET_*, UPDATE_*, MOVE_*, JOIN_*, LEAVE_*, MARK_*）
 * - R: 社交关系类（SEND_*, REPLY_*, FORWARD_*, REACT_*, MEMORIZE_*, RECALL_*）
 */
const REQUIRED_CATEGORIES: ToolCategory[] = [
  {
    name: "I (Information)",
    description: "获取信息的查询",
    patterns: ["get", "query", "search", "list", "fetch", "read"],
  },
  {
    name: "Q (Question)",
    description: "向外部提问",
    patterns: ["ask", "request", "invite"],
  },
  {
    name: "L (Locomotion)",
    description: "改变自身状态",
    patterns: ["set", "update", "move", "join", "leave", "mark"],
  },
  {
    name: "R (Relation)",
    description: "改变社交关系",
    patterns: ["send", "reply", "forward", "react", "memorize", "recall"],
  },
];

/** 检查结果——每个类别是否被覆盖。 */
export interface ToolSurfaceReport {
  /** 已注册的工具总数。 */
  totalTools: number;
  /** 每个类别的覆盖情况。 */
  categories: Array<{
    name: string;
    covered: boolean;
    matchedTools: string[];
  }>;
  /** 是否所有类别都被覆盖。 */
  complete: boolean;
}

/**
 * 检查 Dispatcher 的指令/查询是否覆盖四类工具面。
 *
 * 启动时调用一次。缺失类别发出 warn 日志。
 * 返回结构化报告供测试和诊断使用。
 *
 * @see paper/ §Axiom 3 "Tool Surface Completeness"
 */
export function checkToolSurfaceCompleteness(dispatcher: Dispatcher): ToolSurfaceReport {
  const allNames = [...dispatcher.getInstructionNames(), ...dispatcher.getQueryNames()];
  const lowerNames = allNames.map((n) => n.toLowerCase());

  const categories: ToolSurfaceReport["categories"] = [];
  let allCovered = true;

  for (const cat of REQUIRED_CATEGORIES) {
    const matchedTools: string[] = [];
    for (let i = 0; i < lowerNames.length; i++) {
      if (cat.patterns.some((p) => lowerNames[i].includes(p))) {
        matchedTools.push(allNames[i]);
      }
    }
    const covered = matchedTools.length > 0;
    if (!covered) {
      allCovered = false;
      log.warn(`D3 工具面缺失: ${cat.name} (${cat.description})`, {
        patterns: cat.patterns,
        available: allNames.slice(0, 15),
      });
    }
    categories.push({ name: cat.name, covered, matchedTools });
  }

  log.info("D3 工具面检查完成", {
    totalTools: allNames.length,
    complete: allCovered,
    coverage: categories.map((c) => `${c.name}: ${c.covered ? "OK" : "MISSING"}`).join(", "),
  });

  return { totalTools: allNames.length, categories, complete: allCovered };
}

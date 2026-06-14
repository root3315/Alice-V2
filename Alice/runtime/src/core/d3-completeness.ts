/**
 * D3 Проверка полноты инструментальной поверхности — Paper 2, Axiom 3: Σ = (I, Q, L, R).
 *
 * Все четыре категории инструментальной поверхности должны быть непустыми:
 *   I (Information)  — запросы на получение информации (read-only)
 *   Q (Question)     — обращения к внешним источникам
 *   L (Locomotion)   — изменение собственного состояния/позиции
 *   R (Relation)     — изменение социальных связей
 *
 * Выполняется один раз при запуске; при отсутствии категорий выдаёт предупреждение в лог.
 * Не блокирует запуск — только диагностика.
 *
 * @see paper/ §Axiom 3 "Tool Surface Completeness"
 */

import { createLogger } from "../utils/logger.js";
import type { Dispatcher } from "./dispatcher.js";

const log = createLogger("d3");

/** Определение категории инструментальной поверхности. */
interface ToolCategory {
  /** Название категории (для человека). */
  name: string;
  /** Описание категории. */
  description: string;
  /** Паттерны совпадения имён инструкций/запросов (совпадение подстроки в нижнем регистре). */
  patterns: string[];
}

/**
 * Четыре категории инструментальной поверхности — соответствуют Σ = (I, Q, L, R) из Axiom 3.
 *
 * patterns основаны на соглашениях об именовании зарегистрированных инструкций/запросов Alice:
 * - I: запросы на чтение (GET_*, QUERY_*, SEARCH_*, LIST_*, FETCH_*, READ_*)
 * - Q: внешнее взаимодействие (ASK_*, REQUEST_*, INVITE_*)
 * - L: изменение состояния (SET_*, UPDATE_*, MOVE_*, JOIN_*, LEAVE_*, MARK_*)
 * - R: социальные связи (SEND_*, REPLY_*, FORWARD_*, REACT_*, MEMORIZE_*, RECALL_*)
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

/** Результат проверки — охвачена ли каждая категория. */
export interface ToolSurfaceReport {
  /** Общее количество зарегистрированных инструментов. */
  totalTools: number;
  /** Охват по каждой категории. */
  categories: Array<{
    name: string;
    covered: boolean;
    matchedTools: string[];
  }>;
  /** Все ли категории охвачены. */
  complete: boolean;
}

/**
 * Проверяет, покрывают ли инструкции/запросы Dispatcher все четыре категории инструментальной поверхности.
 *
 * Вызывается один раз при запуске. При отсутствии категорий выдаёт warn в лог.
 * Возвращает структурированный отчёт для тестов и диагностики.
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

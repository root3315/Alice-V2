/**
 * ADR-105 CQRS + ADR-140 D2: форматирование результатов Query (единственный источник истины).
 *
 * Форматирует текст observation из атрибутов графа, записанных реализацией Query.
 * Улучшение D2: пустые результаты снабжаются семантическими метками, чтобы LLM не воспринимал их как сбой запроса и не повторял его.
 *
 * @see docs/adr/105-react-cqrs-read-during-next.md — дизайн CQRS
 * @see docs/adr/140-react-efficiency-architecture.md §D2
 */

import type { WorldModel } from "../graph/world-model.js";
import { isQueryAction } from "./action-types.js";
import { TELEGRAM_ACTION_MAP } from "./actions/index.js";

/**
 * Минимальный интерфейс действия Query — заменяет старый RecordedAction.
 * ADR-214 Wave B: RecordedAction удалён, используется структурированное подмножество.
 */
interface QueryAction {
  fn: string;
}

/**
 * Читает результаты Query из атрибутов графа, форматирует их в текст observation, затем помечает как потреблённые.
 *
 * Семантические метки D2: когда query возвращает пустые/null/невалидные данные, вместо голого [] вставляется семантическая метка.
 * Это даёт LLM понять, что «пусто» — это значимая информация: новый контакт, нет истории, или данных ещё не существует.
 */
export function formatQueryObservations(
  G: WorldModel,
  queryActions: QueryAction[],
  actionTarget: string | null,
): string | null {
  const lines: string[] = [];
  const consumed: Array<{ nodeId: string; key: string }> = [];

  for (const action of queryActions) {
    const def = TELEGRAM_ACTION_MAP.get(action.fn);
    if (!def || !isQueryAction(def)) continue;

    const nodeId = def.resultSource === "target" ? actionTarget : "self";
    if (!nodeId || !G.has(nodeId)) {
      // D2: узел не существует → семантическая метка (не потребляем, так как данных нет)
      lines.push(
        `(${action.fn}: no data available — this may be a new contact or first interaction)`,
      );
      continue;
    }

    const data = G.getDynamic(nodeId, def.resultAttrKey);
    if (data == null) {
      // D2: данные null → семантическая метка
      lines.push(`(${action.fn}: no data available — the information may not exist yet)`);
      continue;
    }

    const formatted = def.formatResult(data);
    if (!formatted || formatted.length === 0) {
      // D2: formatResult вернул пустое → семантическая метка
      lines.push(`(${action.fn}: returned empty results — no matching records found)`);
      continue;
    }

    lines.push(...formatted);
    consumed.push({ nodeId, key: def.resultAttrKey });
  }

  // помечаем как потреблённое + очищаем одноразовые результаты
  for (const { nodeId, key } of consumed) {
    G.setDynamic(nodeId, `${key}_consumed`, -1); // помечаем как потреблённое в CQRS
    if (key.startsWith("last_")) {
      G.setDynamic(nodeId, key, null);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

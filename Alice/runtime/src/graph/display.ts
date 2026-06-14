/**
 * ADR-172: безопасное разрешение отображаемого имени + обратное разрешение.
 *
 * safeDisplayName: nodeId → читаемое имя (никогда не возвращает raw graph ID).
 * resolveDisplayName: читаемое имя → nodeId (обратная операция к safeDisplayName).
 *
 * @see docs/adr/172-information-visibility-layer.md
 * @see docs/adr/204-consciousness-stream/ §3.10 C10
 */
import { readDisplayName, readTitle } from "./dynamic-props.js";
import type { WorldModel } from "./world-model.js";

/**
 * Разрешает безопасное отображаемое имя сущности.
 *
 * **Никогда не возвращает raw graph ID**. Если display_name и title оба отсутствуют,
 * возвращает обобщённое название по типу узла (например "(someone)", "(a group)").
 */
/**
 * ADR-204 C10: разрешает человекочитаемое имя (display_name) в graph nodeId.
 *
 * Обратная операция к safeDisplayName. LLM достаточно передать имя человека;
 * код выполняет отображение → nodeId.
 * Правила сопоставления:
 * 1. Уже в формате `contact:*` / `channel:*` → проверить существование и вернуть напрямую
 * 2. "self" / "alice" → вернуть "self" (специальный узел)
 * 3. Поиск по display_name узлов contact (без учёта регистра)
 * 4. Поиск по display_name / title узлов channel (без учёта регистра)
 * 5. Ничего не совпало → null
 */
export function resolveDisplayName(G: WorldModel, displayName: string): string | null {
  // 1. Уже в формате nodeId → проверить существование
  if (displayName.startsWith("contact:") || displayName.startsWith("channel:")) {
    return G.has(displayName) ? displayName : null;
  }

  // 2. Специальные узлы self / alice
  const lower = displayName.toLowerCase();
  if (lower === "self" || lower === "alice") {
    return G.has("self") ? "self" : null;
  }

  // 3. Поиск среди узлов contact
  for (const nodeId of G.getEntitiesByType("contact")) {
    const dn = readDisplayName(G, nodeId);
    if (dn != null && dn.toLowerCase() === lower) {
      return nodeId;
    }
  }

  // 4. Поиск среди узлов channel (display_name или title)
  for (const nodeId of G.getEntitiesByType("channel")) {
    const dn = readDisplayName(G, nodeId);
    if (dn != null && dn.toLowerCase() === lower) {
      return nodeId;
    }
    const title = readTitle(G, nodeId);
    if (title != null && title.toLowerCase() === lower) {
      return nodeId;
    }
  }

  return null;
}

export function safeDisplayName(G: WorldModel, nodeId: string): string {
  if (!G.has(nodeId)) return "(someone)";

  const displayName = readDisplayName(G, nodeId);
  if (displayName != null && displayName !== "") return displayName;

  const title = readTitle(G, nodeId);
  if (title != null && title !== "") return title;

  // Типизированное обобщённое название — никогда не раскрывает raw ID
  const nodeType = G.getNodeType(nodeId);
  switch (nodeType) {
    case "contact":
      return "(someone)";
    case "channel": {
      const chatType = G.getChannel(nodeId).chat_type;
      if (chatType === "channel") return "(a channel)";
      return chatType === "private" ? "(a private chat)" : "(a group)";
    }
    case "thread":
      return "(a thread)";
    default:
      return "(unknown)";
  }
}

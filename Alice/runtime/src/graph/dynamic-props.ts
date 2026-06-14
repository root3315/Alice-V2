/**
 * Типобезопасные акцессоры динамических свойств графа.
 *
 * Следует паттерну ModStateRegistry (core/types.ts):
 * единственная контролируемая точка приведения типов; ноль `as` на вызывающих сторонах.
 *
 * getDynamic() возвращает unknown (аварийный выход). Данный модуль предоставляет
 * типизированное чтение с runtime-защитниками типов (проверки typeof),
 * предотвращающими тихое распространение данных неверного типа.
 */

import type { ForwardRegistry } from "../engine/act/timeline.js";
import type { ChatType } from "./entities.js";
import { isChatType } from "./entity-defaults.js";
import type { WorldModel } from "./world-model.js";

// ═══════════════════════════════════════════════════════════════════════════
// Базовые данные профиля
// ═══════════════════════════════════════════════════════════════════════════

/** Читает display_name узла. Возвращает undefined при неверной структуре или отсутствии значения. */
export function readDisplayName(G: WorldModel, nodeId: string): string | undefined {
  if (!G.has(nodeId)) return undefined;
  const v = G.getDynamic(nodeId, "display_name");
  return typeof v === "string" ? v : undefined;
}

/** Читает title узла. Возвращает undefined при неверной структуре или отсутствии значения. */
export function readTitle(G: WorldModel, nodeId: string): string | undefined {
  if (!G.has(nodeId)) return undefined;
  const v = G.getDynamic(nodeId, "title");
  return typeof v === "string" ? v : undefined;
}

/** Приоритет: display_name, затем title, в крайнем случае — ID узла. */
export function readDisplayLabel(G: WorldModel, nodeId: string): string {
  return readDisplayName(G, nodeId) ?? readTitle(G, nodeId) ?? nodeId;
}

/** Читает chat_type канала. Возвращает undefined при неверной структуре или отсутствии значения. */
export function readChatType(G: WorldModel, nodeId: string): ChatType | undefined {
  if (!G.has(nodeId)) return undefined;
  const v = G.getDynamic(nodeId, "chat_type");
  return isChatType(v) ? v : undefined;
}

/** Является ли контакт ботом. Возвращает false при неверной структуре или отсутствии значения. */
export function isBotContact(G: WorldModel, contactId: string): boolean {
  return G.has(contactId) && G.getDynamic(contactId, "is_bot") === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Социальная восприимчивость (ADR-156)
// ═══════════════════════════════════════════════════════════════════════════

/** Читает социальную восприимчивость группы ∈ [-1, 1]. При отсутствии значения возвращает 0. */
export function readSocialReception(G: WorldModel, channelId: string): number {
  if (!G.has(channelId)) return 0;
  const v = G.getDynamic(channelId, "social_reception");
  return typeof v === "number" ? v : 0;
}

/** Читает время последнего обновления социальной восприимчивости (epoch ms). */
export function readSocialReceptionMs(G: WorldModel, channelId: string): number {
  if (!G.has(channelId)) return 0;
  const v = G.getDynamic(channelId, "social_reception_ms");
  return typeof v === "number" ? v : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Журнал пересылок (замыкание обратной связи BT)
// ═══════════════════════════════════════════════════════════════════════════

/** Читает журнал пересылок сообщений канала. */
export function readForwardRegistry(G: WorldModel, channelId: string): ForwardRegistry {
  if (!G.has(channelId)) return {};
  const v = G.getDynamic(channelId, "forwarded_msgs");
  if (!isForwardRegistry(v)) return {};
  return v as ForwardRegistry;
}

function isForwardRegistry(value: unknown): value is ForwardRegistry {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (targets) => Array.isArray(targets) && targets.every((target) => typeof target === "string"),
  );
}

/** M3: кап реестра пересылок — иначе растёт без предела (раздувание снапшота/памяти). */
const FORWARD_REGISTRY_CAP = 100;

/** Записывает факт пересылки: msgId из srcChannel переслан в targetName. */
function writeForwardEntry(
  G: WorldModel,
  channelId: string,
  msgId: number,
  targetName: string,
): void {
  const registry = readForwardRegistry(G, channelId);
  const key = String(msgId);
  if (!registry[key]) registry[key] = [];
  if (!registry[key].includes(targetName)) registry[key].push(targetName);
  // M3: держим только последние N msgId (они растут со временем → дропаем самые старые/маленькие).
  const keys = Object.keys(registry);
  if (keys.length > FORWARD_REGISTRY_CAP) {
    const sorted = keys.map(Number).sort((a, b) => a - b);
    for (const k of sorted.slice(0, keys.length - FORWARD_REGISTRY_CAP)) delete registry[String(k)];
  }
  G.setDynamic(channelId, "forwarded_msgs", registry);
}

/** Записывает полный факт межчатового обмена: исходное сообщение, получатель и время последнего обмена с обеих сторон. */
export function recordForwardShare(
  G: WorldModel,
  params: {
    fromGraphId: string;
    msgId: number;
    toGraphId: string;
    targetName: string;
    nowMs?: number;
  },
): void {
  const nowMs = params.nowMs ?? Date.now();

  if (G.has(params.fromGraphId)) {
    G.setDynamic(params.fromGraphId, "last_shared_ms", nowMs);
    writeForwardEntry(G, params.fromGraphId, params.msgId, params.targetName);
  }
  if (G.has(params.toGraphId)) {
    G.setDynamic(params.toGraphId, "last_shared_ms", nowMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Обнаружение блокировки
// ═══════════════════════════════════════════════════════════════════════════

/** Заблокировал ли контакт Alice. */
export function isBlockedByContact(G: WorldModel, contactId: string): boolean {
  return G.has(contactId) && G.getDynamic(contactId, "blocked_alice") === true;
}

/** Заблокировал ли контакт Alice. Псевдоним с префиксом read* для единообразного чтения фактов на вызывающей стороне. */
export const readBlockedByContact = isBlockedByContact;

// ═══════════════════════════════════════════════════════════════════════════
// Последние действия / обмен
// ═══════════════════════════════════════════════════════════════════════════

/** Читает время последнего обмена (epoch ms). 0 = никогда не делился. */
export function readLastSharedMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "last_shared_ms");
  return typeof v === "number" ? v : 0;
}

/** Читает время последнего действия Alice на данном узле (epoch ms). 0 = действий не было. */
export function readLastAliceActionMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "last_alice_action_ms");
  return typeof v === "number" ? v : 0;
}

/** Записывает время последнего действия Alice на данном узле (epoch ms). */
export function writeLastAliceActionMs(G: WorldModel, nodeId: string, nowMs: number): void {
  if (!G.has(nodeId)) return;
  G.setDynamic(nodeId, "last_alice_action_ms", nowMs);
}

/** Читает последний исходящий текст. Возвращает пустую строку при неверной структуре или отсутствии значения. */
export function readLastOutgoingText(G: WorldModel, nodeId: string): string {
  if (!G.has(nodeId)) return "";
  const v = G.getDynamic(nodeId, "last_outgoing_text");
  return typeof v === "string" ? v : "";
}

/** Записывает последний исходящий текст с существующим ограничением проекции в 150 символов. */
export function writeLastOutgoingText(G: WorldModel, nodeId: string, text: string): void {
  if (!G.has(nodeId)) return;
  G.setDynamic(nodeId, "last_outgoing_text", [...text].slice(0, 150).join(""));
}

/** Читает время последней очистки непрочитанных/упоминаний (epoch ms). 0 = никогда не очищалось. */
export function readRecentlyClearedMs(G: WorldModel, nodeId: string): number {
  if (!G.has(nodeId)) return 0;
  const v = G.getDynamic(nodeId, "recently_cleared_ms");
  return typeof v === "number" ? v : 0;
}

/** Записывает время последней очистки непрочитанных/упоминаний (epoch ms). */
export function writeRecentlyClearedMs(G: WorldModel, nodeId: string, nowMs: number): void {
  if (!G.has(nodeId)) return;
  G.setDynamic(nodeId, "recently_cleared_ms", nowMs);
}

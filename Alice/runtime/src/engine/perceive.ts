/**
 * Поток PERCEIVE: управляемый событиями, применяет события из EventBuffer к графу.
 *
 * Это не самостоятельный цикл — вызывается потоком EVOLVE в начале каждого tick.
 */

import { writeAuditEvent } from "../db/audit.js";
import {
  chatIdToContactId,
  PERCEIVE_FACT_DEBOUNCE_MS,
  PERCEIVE_FACT_MSG_THRESHOLD,
  PERCEIVE_FACTS_LIMIT,
} from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import type { EventBuffer } from "../telegram/events.js";
import type { GraphPerturbation } from "../telegram/mapper.js";
import { applyPerturbations } from "../telegram/mapper.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("perceive");

/**
 * Потребляет буфер событий, применяет к графу, возвращает novelty текущего tick.
 * ADR-115: добавлен channelCounts — per-channel счётчик сообщений для anomaly generator.
 */
export function perceiveTick(
  G: WorldModel,
  buffer: EventBuffer,
  tick?: number,
): { eventCount: number; novelty: number; channelCounts: Map<string, number> } {
  const { events, droppedCount, droppedDirectedCount } = buffer.drain();
  const effectiveTick = tick ?? events[0]?.tick ?? -1;
  if (droppedCount > 0) {
    // T-5: уведомляем движок о потере событий — для логирования и коррекции давления
    log.warn("EventBuffer dropped events since last tick", { droppedCount });
    // ADR-147 D1: переполнение записывается в структурированный аудит для обнаружения anomaly.ts
    writeAuditEvent(
      effectiveTick,
      "warn",
      "events",
      `EventBuffer overflow: ${droppedCount} regular events dropped`,
      { droppedCount },
    );
  }
  // ADR-114 D4: потеря directed-событий — критический сигнал; @mention/reply утоплены
  if (droppedDirectedCount > 0) {
    log.warn("Directed events were dropped due to protected buffer overflow", {
      droppedDirectedCount,
    });
    writeAuditEvent(
      effectiveTick,
      "warn",
      "events",
      `EventBuffer overflow: ${droppedDirectedCount} directed events dropped`,
      { droppedDirectedCount },
    );
  }
  const novelty = applyPerturbations(G, events);

  // D5: обновление per-contact счётчика recv-окна (contact_recv_window)
  updateContactRecvWindow(G, events);

  // ADR-116: новая активность в канале → затухание consecutive_act_silences (постепенное восстановление, не мгновенный сброс)
  // Но bot-флуд в группе не является сигналом «социального восстановления»: только сообщения реальных людей должны разблокировать кулдаун.
  // Непрерывный bot-спам скорее говорит о том, что комната становится шумнее — Алисе следует сдерживаться, а не продолжать пробуждаться.
  // @see docs/GOAL.md §Сценарий 4 / §Сценарий 7
  decayActSilences(G, events);

  // ADR-115: per-channel счётчик сообщений (для EMA-статистики anomaly generator)
  const channelCounts = new Map<string, number>();
  for (const e of events) {
    if (e.channelId && e.type === "new_message") {
      channelCounts.set(e.channelId, (channelCounts.get(e.channelId) ?? 0) + 1);
    }
  }

  // ADR-160 Fix A: perceive-sourced facts — автоматически создаёт observation fact для каналов с заметной активностью.
  // Завершает сенсор P2: P2 больше не зависит полностью от вызовов LLM remember().
  // @see docs/adr/158-outbound-feedback-gap.md §Fix A
  createPerceiveFacts(G, channelCounts, Date.now());

  return { eventCount: events.length, novelty, channelCounts };
}

/**
 * ADR-116: затухание consecutive_act_silences — уменьшается на 1 при появлении новых сообщений в канале.
 *
 * Постепенное восстановление устойчивее мгновенного сброса — Алиса не перескочит из «молчания» в «активность» после одного сообщения.
 * Срабатывает только для событий типа new_message (typing и другие слабые сигналы не триггерят).
 *
 * @see docs/adr/116-group-silence-trap.md §Исправление 4 вариант A
 */
function decayActSilences(G: WorldModel, events: GraphPerturbation[]): void {
  const humanActivityChannels = new Set<string>();
  const botOnlyBurst = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "new_message" || !event.channelId) continue;
    if (event.senderIsBot) {
      botOnlyBurst.set(event.channelId, (botOnlyBurst.get(event.channelId) ?? 0) + 1);
      continue;
    }
    humanActivityChannels.add(event.channelId);
    botOnlyBurst.delete(event.channelId);
  }

  // Только сообщения реальных людей считаются настоящим «восстановлением комнаты» и постепенно разблокируют кулдаун молчания.
  for (const channelId of humanActivityChannels) {
    if (!G.has(channelId)) continue;
    const silences = Number(G.getChannel(channelId).consecutive_act_silences ?? 0);
    if (silences > 0) {
      G.updateChannel(channelId, { consecutive_act_silences: silences - 1 });
    }
  }

  // Непрерывный bot-спам в группе: не разблокирует, а добавляет небольшой кулдаун, чтобы Алису не тянуло болтать с инструментальным выводом.
  for (const [channelId, count] of botOnlyBurst) {
    if (count < 2 || !G.has(channelId)) continue;
    const attrs = G.getChannel(channelId);
    if (attrs.chat_type !== "group" && attrs.chat_type !== "supergroup") continue;
    const silences = Number(attrs.consecutive_act_silences ?? 0);
    G.updateChannel(channelId, {
      consecutive_act_silences: silences + 1,
      last_act_silence_ms: Date.now(),
    });
  }
}

/**
 * D5: обновляет per-channel счётчик contact_recv_window.
 *
 * Собеседник написал сообщение (new_message, не от самой Алисы) → contact_recv_window++ для соответствующего канала.
 * Используется для расчёта дисбаланса взаимности C_dist.
 *
 * @see paper/ Definition 8, C_dist: sent(n,w) / recv(n,w)
 */
function updateContactRecvWindow(G: WorldModel, events: GraphPerturbation[]): void {
  for (const event of events) {
    if (event.type !== "new_message") continue;
    const channelId = event.channelId;
    if (!channelId || !G.has(channelId)) continue;

    // Увеличиваем счётчик сообщений собеседника
    const current = Number(G.getChannel(channelId).contact_recv_window ?? 0);
    G.updateChannel(channelId, { contact_recv_window: current + 1 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADR-160 Fix A: Perceive-Sourced Facts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Автоматически создаёт/обновляет perceive-sourced observation facts для каналов с заметной новой активностью.
 *
 * Условия создания (во избежание шума):
 * 1. В канале в этом tick ≥ PERCEIVE_FACT_MSG_THRESHOLD новых сообщений
 * 2. За последние PERCEIVE_FACT_DEBOUNCE_MS perceive fact для этого канала не создавался
 *
 * Атрибуты fact:
 * - source: "perceive", fact_type: "observation"
 * - importance: 0.3 (структурная базовая линия), stability: 1 (~27 дней период полураспада)
 * - last_access_ms не обновляется автоматически (Алиса не обработала активно ≠ «доступ»)
 *
 * Контроль ёмкости: независимый пул PERCEIVE_FACTS_LIMIT; при переполнении вытесняется perceive fact с наименьшим R.
 *
 * @see docs/adr/158-outbound-feedback-gap.md §Fix A
 * @see paper/ §3.2 "Information Pressure" — кривая забывания P2
 */
function createPerceiveFacts(
  G: WorldModel,
  channelCounts: Map<string, number>,
  nowMs: number,
): void {
  for (const [channelId, count] of channelCounts) {
    if (count < PERCEIVE_FACT_MSG_THRESHOLD) continue;
    if (!G.has(channelId)) continue;

    const channelAttrs = G.getChannel(channelId);
    // Создаём только для каналов, в которых Алиса ранее участвовала (нет истории действий = нет смысла в наблюдении)
    const lastAliceActionMs = Number(channelAttrs.last_alice_action_ms ?? 0);
    if (lastAliceActionMs <= 0) continue;

    // Проверяем, есть ли уже недавний perceive fact для этого канала (debounce)
    const factId = `fact:perceive:${channelId}`;
    if (G.has(factId)) {
      const existing = G.getFact(factId);
      const createdMs = Number(existing.created_ms ?? 0);
      if (nowMs - createdMs < PERCEIVE_FACT_DEBOUNCE_MS) {
        // Обновляем содержимое, но не обновляем last_access_ms (Алиса не обработала активно)
        const displayName = safeDisplayName(G, channelId);
        G.updateFact(factId, {
          content: `Activity: ${count} messages in ${displayName}`,
          created_ms: nowMs, // обновляем время создания для сброса окна debounce
        });
        continue;
      }
    }

    // Контроль ёмкости: при переполнении вытесняем perceive fact с наименьшим R
    enforcePerceiveFactsLimit(G, nowMs);

    const displayName = safeDisplayName(G, channelId);
    // Выводим contact ID (приватный channel → соответствующий contact)
    const sourceContact = chatIdToContactId(channelId) ?? undefined;

    G.addFact(factId, {
      content: `Activity: ${count} messages in ${displayName}`,
      fact_type: "observation",
      importance: 0.3,
      stability: 1,
      source: "perceive",
      source_channel: channelId,
      source_contact: sourceContact && G.has(sourceContact) ? sourceContact : undefined,
      created_ms: nowMs,
      last_access_ms: nowMs,
    });

    // Связываем с self (P2 получает через обход сущностей типа fact; ребро — опциональная семантическая связь)
    if (G.has("self")) {
      G.addEdge("self", factId, "knows", "cognitive");
    }
  }
}

/** Расчёт retrievability SM-2 (согласован с P2). */
function factRetrievability(stability: number, lastAccessMs: number, nowMs: number): number {
  const gapDays = Math.max(0, (nowMs - lastAccessMs) / 86_400_000);
  const S = Math.max(stability, 0.1);
  return (1 + gapDays / (9 * S)) ** -0.5;
}

/** Вытесняет perceive fact с наименьшим R (поддержание ёмкостного пула). */
function enforcePerceiveFactsLimit(G: WorldModel, nowMs: number): void {
  const perceiveFacts: Array<{ id: string; R: number }> = [];
  for (const fid of G.getEntitiesByType("fact")) {
    const attrs = G.getFact(fid);
    if (attrs.source !== "perceive") continue;
    const R = factRetrievability(attrs.stability, Number(attrs.last_access_ms ?? 0), nowMs);
    perceiveFacts.push({ id: fid, R });
  }

  if (perceiveFacts.length < PERCEIVE_FACTS_LIMIT) return;

  // Вытесняем наименьший R
  perceiveFacts.sort((a, b) => a.R - b.R);
  const toRemove = perceiveFacts.length - PERCEIVE_FACTS_LIMIT + 1; // +1 освобождает место для нового fact
  for (let i = 0; i < toRemove; i++) {
    G.removeEntity(perceiveFacts[i].id);
  }
}

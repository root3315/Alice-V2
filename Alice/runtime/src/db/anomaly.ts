/**
 * Модуль обнаружения аномалий во время выполнения.
 *
 * Выявляет аномальные паттерны в tick_log / action_log / personality_snapshots.
 * Рекомендуется вызывать каждые 50 tick. Каждая проверка обёрнута в отдельный try-catch,
 * сбой одной не влияет на остальные.
 */
import fs from "node:fs";
import path from "node:path";
import { desc, sql } from "drizzle-orm";
import { classifyIausActionRow } from "../diagnostics/iaus-action-classifier.js";
import type { WorldModel } from "../graph/world-model.js";
import { effectiveUnread } from "../pressure/signal-decay.js";
import { createLogger } from "../utils/logger.js";
import { getDb, getDbPath } from "./connection.js";
import { actionLog, auditEvents, personalitySnapshots, tickLog } from "./schema.js";

const log = createLogger("anomaly");

// Троттл КОНСОЛЬНОГО лога повторяющихся аномалий: один и тот же type пишется не чаще
// раза в LOG_THROTTLE_MS. В простое pressure_dead/api_stagnant держатся постоянно и иначе
// спамят на каждом прогоне. На возвращаемый массив alerts НЕ влияет — health-watch/selfcheck/
// дашборд продолжают видеть аномалии в реальном времени. Ключ — только по type (сообщение
// api_stagnant содержит меняющийся std, поэтому по сообщению троттл бы не сработал).
const LOG_THROTTLE_MS = 10 * 60_000;
const lastLoggedAt = new Map<string, number>();

export interface AnomalyAlert {
  level: "warn" | "error";
  type: string;
  message: string;
  tick: number;
}

/**
 * Запускает проверку аномалий. Рекомендуется вызывать каждые 50 tick.
 *
 * @param G - Необязательный WorldModel, включает проверку инвариантов на уровне графа (INV-1).
 * @see docs/adr/177-pressure-field-structural-audit.md §P0
 */
export function runAnomalyCheck(currentTick: number, G?: WorldModel): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];

  // api_stagnant: стандартное отклонение API за последние 20 tick < 0.01
  try {
    const db = getDb();
    const rows = db
      .select({ api: tickLog.api })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(20)
      .all();
    if (rows.length >= 10) {
      const values = rows.map((r) => r.api);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);
      if (std < 0.01) {
        alerts.push({
          level: "warn",
          type: "api_stagnant",
          message: `Стандартное отклонение API ${std.toFixed(6)} < 0.01 (последние ${rows.length} tick), поле давления, похоже, застряло`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("api_stagnant: сбой проверки", e);
  }

  // api_overflow: API > 50.0
  try {
    const db = getDb();
    const row = db
      .select({ api: tickLog.api })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(1)
      .get();
    if (row && row.api > 50.0) {
      alerts.push({
        level: "error",
        type: "api_overflow",
        message: `API = ${row.api.toFixed(2)} > 50.0, давление вышло из-под контроля`,
        tick: currentTick,
      });
    }
  } catch (e) {
    log.warn("api_overflow: сбой проверки", e);
  }

  // pressure_dead: любой Pi = 0.00 на протяжении 100+ tick
  try {
    const db = getDb();
    const rows = db
      .select({
        p1: tickLog.p1,
        p2: tickLog.p2,
        p3: tickLog.p3,
        p4: tickLog.p4,
        p5: tickLog.p5,
        p6: tickLog.p6,
      })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(100)
      .all();
    if (rows.length >= 100) {
      const names = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
      const keys = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
      for (let i = 0; i < 6; i++) {
        const allZero = rows.every((r) => Math.abs(r[keys[i]]) < 1e-6);
        if (allZero) {
          alerts.push({
            level: "warn",
            type: "pressure_dead",
            message: `${names[i]} = 0.00 уже 100+ tick, источник давления отсутствует`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("pressure_dead: сбой проверки", e);
  }

  // pressure_extreme: любой Pi > 200
  try {
    const db = getDb();
    const row = db
      .select({
        p1: tickLog.p1,
        p2: tickLog.p2,
        p3: tickLog.p3,
        p4: tickLog.p4,
        p5: tickLog.p5,
        p6: tickLog.p6,
      })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(1)
      .get();
    if (row) {
      const names = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
      const vals = [row.p1, row.p2, row.p3, row.p4, row.p5, row.p6];
      for (let i = 0; i < 6; i++) {
        if (vals[i] > 200) {
          alerts.push({
            level: "warn",
            type: "pressure_extreme",
            message: `${names[i]} = ${vals[i].toFixed(2)} > 200, аномалия по одному измерению`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("pressure_extreme: сбой проверки", e);
  }

  // action_failure_rate: доля неудачных реальных Telegram-попыток среди последних 20 > 50%
  // ADR-254: action_log.success — это результат всей строки host, который включает
  // «отправлено, но таймаут ожидания ответа» и последующие сбои self-команд в жёсткую
  // статистику отказов. Алерт должен основываться на фактах действий, выведенных из tc_command_log.
  try {
    const db = getDb();
    const rows = db
      .select({
        actionType: actionLog.actionType,
        success: actionLog.success,
        engagementOutcome: actionLog.engagementOutcome,
        tcAfterward: actionLog.tcAfterward,
        tcCommandLog: actionLog.tcCommandLog,
      })
      .from(actionLog)
      .orderBy(desc(actionLog.tick))
      .limit(20)
      .all();
    if (rows.length >= 5) {
      const classifications = rows.map((r) =>
        classifyIausActionRow({
          action_type: r.actionType,
          success: r.success,
          engagement_outcome: r.engagementOutcome,
          tc_afterward: r.tcAfterward,
          tc_command_log: r.tcCommandLog,
        }),
      );
      const attempts = classifications.filter(
        (c) => c.category === "telegram_success" || c.category === "telegram_failure",
      );
      const failures = attempts.filter((c) => c.category === "telegram_failure").length;
      const rate = attempts.length > 0 ? failures / attempts.length : 0;
      if (rate > 0.5) {
        alerts.push({
          level: "error",
          type: "action_failure_rate",
          message: `Доля неудачных Telegram-действий ${(rate * 100).toFixed(0)}% (в последних ${rows.length} записях ${attempts.length} попыток Telegram, из них ${failures} неудачных)`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("action_failure_rate: сбой проверки", e);
  }

  // voice_lost: среди последних 10 записей action_log сбоев вывода LLM > 50%
  // command_misuse / telegram_failed — это проблемы выполнения или инструментального уровня,
  // они не учитываются как «потеря голоса» LLM.
  // @see docs/adr/129-llm-voice-loss-awareness.md
  try {
    const db = getDb();
    const rows = db
      .select({ actionType: actionLog.actionType })
      .from(actionLog)
      .orderBy(desc(actionLog.tick))
      .limit(10)
      .all();
    if (rows.length >= 3) {
      const llmFailures = rows.filter(
        (r) =>
          r.actionType === "llm_failed" ||
          r.actionType === "provider_failed" ||
          r.actionType === "validation_failed",
      ).length;
      const rate = llmFailures / rows.length;
      if (rate > 0.5) {
        alerts.push({
          level: "error",
          type: "voice_lost",
          message: `LLM потеряла голос: из последних ${rows.length} действий ${llmFailures} неудачных вызовов LLM (${(rate * 100).toFixed(0)}%)`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("voice_lost: сбой проверки", e);
  }

  // personality_drift: евклидово расстояние между соседними снапшотами π-вектора > 0.3
  try {
    const db = getDb();
    const rows = db
      .select({ tick: personalitySnapshots.tick, weights: personalitySnapshots.weights })
      .from(personalitySnapshots)
      .orderBy(desc(personalitySnapshots.tick))
      .limit(2)
      .all();
    if (rows.length === 2) {
      const w0: number[] = JSON.parse(rows[0].weights);
      const w1: number[] = JSON.parse(rows[1].weights);
      if (w0.length === w1.length) {
        let sumSq = 0;
        for (let i = 0; i < w0.length; i++) {
          sumSq += (w0[i] - w1[i]) ** 2;
        }
        const dist = Math.sqrt(sumSq);
        if (dist > 0.3) {
          alerts.push({
            level: "warn",
            type: "personality_drift",
            message: `Дрейф личности ${dist.toFixed(4)} > 0.3 (tick ${rows[1].tick} → ${rows[0].tick})`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("personality_drift: сбой проверки", e);
  }

  // voice_starvation: какой-либо голос 200+ tick не выбирался победителем по loudness
  // ADR-124 §D7: используем tick_log (записи выбора голоса) вместо action_log (только успешные действия)
  // столбец tick_log.action хранит имя голоса-победителя по loudness
  // @see docs/adr/126-obligation-field-decay.md §D7
  try {
    const db = getDb();
    const voices = ["diligence", "curiosity", "sociability", "caution"];
    for (const voice of voices) {
      const row = db
        .select({ tick: tickLog.tick })
        .from(tickLog)
        .where(sql`${tickLog.action} = ${voice}`)
        .orderBy(desc(tickLog.tick))
        .limit(1)
        .get();
      const lastTick = row?.tick ?? 0;
      if (currentTick - lastTick > 200) {
        alerts.push({
          level: "warn",
          type: "voice_starvation",
          message: `Голос ${voice} уже ${currentTick - lastTick} tick не выбирался победителем по loudness (последний раз tick ${lastTick})`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("voice_starvation: сбой проверки", e);
  }

  // voice_action_starvation: голос выиграл loudness-конкуренцию > 50 раз, но конверсия в action < 5%
  // ADR-131 D3: делает проблему голодания голоса наблюдаемой. Паттерн — голос выиграл конкуренцию,
  // но был заблокирован гейтом.
  // Основной легитимный продукт Caution — system1:skip, а не действие System 2;
  // tick'и, обработанные System 1, не должны попадать в знаменатель «должно конвертироваться в action».
  // @see docs/adr/131-feedback-loop-integrity.md §D3
  try {
    const db = getDb();
    const voices = ["diligence", "curiosity", "sociability"];
    for (const voice of voices) {
      // Число loudness-побед, требующих обработки System 2 за последние 500 tick.
      const loudnessRow = db
        .select({ cnt: sql<number>`count(*)` })
        .from(tickLog)
        .where(sql`
          ${tickLog.action} = ${voice}
          AND ${tickLog.tick} > ${currentTick - 500}
          AND (
            ${tickLog.gateVerdict} IS NULL
            OR ${tickLog.gateVerdict} NOT IN ('system1:skip', 'system1:mark_read', 'system1:digest')
          )
        `)
        .get();
      const loudnessWins = loudnessRow?.cnt ?? 0;
      if (loudnessWins < 50) continue; // недостаточно данных

      // Число действий в action_log за тот же период
      const actionRow = db
        .select({ cnt: sql<number>`count(*)` })
        .from(actionLog)
        .where(sql`${actionLog.voice} = ${voice} AND ${actionLog.tick} > ${currentTick - 500}`)
        .get();
      const actionCount = actionRow?.cnt ?? 0;
      const ratio = actionCount / loudnessWins;

      if (ratio < 0.05) {
        alerts.push({
          level: "warn",
          type: "voice_action_starvation",
          message: `Голос ${voice} голодает без действий: за последние 500 tick выиграл loudness-конкуренцию ${loudnessWins} раз, но совершил лишь ${actionCount} действий (${(ratio * 100).toFixed(1)}%)`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("voice_action_starvation: сбой проверки", e);
  }

  // ADR-147 D1: event_buffer_overflow — количество переполнений EventBuffer за последние 50 tick > 5
  // @see docs/adr/147-flood-backlog-recovery.md §D1
  try {
    const db = getDb();
    const row = db
      .select({ cnt: sql<number>`count(*)` })
      .from(auditEvents)
      .where(
        sql`${auditEvents.source} = 'events'
        AND ${auditEvents.message} LIKE '%overflow%'
        AND ${auditEvents.tick} > ${currentTick - 50}`,
      )
      .get();
    if (row && row.cnt > 5) {
      alerts.push({
        level: "warn",
        type: "event_buffer_overflow",
        message: `EventBuffer переполнился ${row.cnt} раз за последние 50 tick, возможен флуд из накопившегося бэклога`,
        tick: currentTick,
      });
    }
  } catch (e) {
    log.warn("event_buffer_overflow: сбой проверки", e);
  }

  // db_bloat: WAL-файл > 50MB
  try {
    const walPath = path.resolve(`${getDbPath()}-wal`);
    if (fs.existsSync(walPath)) {
      const stat = fs.statSync(walPath);
      const sizeMB = stat.size / (1024 * 1024);
      if (sizeMB > 50) {
        alerts.push({
          level: "warn",
          type: "db_bloat",
          message: `WAL-файл ${sizeMB.toFixed(1)}MB > 50MB, база данных распухла`,
          tick: currentTick,
        });
      }
    }
  } catch (e) {
    log.warn("db_bloat: сбой проверки", e);
  }

  // INV-1: rawUnread > 50, но effectiveUnread ≈ 0 — детектор «тараканов» из ADR-176
  // Если канал накопил много непрочитанных, а effectiveUnread близко к нулю — в слое
  // затухания сигнала есть конструктивное слепое пятно.
  // @see docs/adr/177-pressure-field-structural-audit.md §P0 INV-1
  if (G) {
    try {
      const nowMs = Date.now();
      const violations: string[] = [];
      for (const hid of G.getEntitiesByType("channel")) {
        const rawUnread = G.getChannel(hid).unread ?? 0;
        if (rawUnread <= 50) continue;
        const eu = effectiveUnread(G, hid, nowMs);
        // rawUnread > 50, но effectiveUnread < 1.0 — сигнал почти невидим
        if (eu < 1.0) {
          violations.push(`${hid}(raw=${rawUnread},eu=${eu.toFixed(2)})`);
        }
      }
      if (violations.length > 0) {
        alerts.push({
          level: "error",
          type: "unread_signal_blind",
          message: `${violations.length} канал(ов) с >50 непрочитанных, но effectiveUnread < 1.0: ${violations.slice(0, 3).join(", ")}${violations.length > 3 ? "..." : ""}`,
          tick: currentTick,
        });
      }
    } catch (e) {
      log.warn("unread_signal_blind: сбой проверки", e);
    }
  }

  // INV-3: покрытие целей V-max — выбирались ли каналы с давлением за последние 200 tick
  // @see docs/adr/177-pressure-field-structural-audit.md §P0 INV-3
  if (G) {
    try {
      const db = getDb();
      // Собираем target'ы, выбранные V-max за последние 200 tick
      const actionRows = db
        .select({ target: actionLog.chatId })
        .from(actionLog)
        .where(sql`${actionLog.tick} > ${currentTick - 200} AND ${actionLog.chatId} IS NOT NULL`)
        .all();
      const coveredTargets = new Set(actionRows.map((r) => r.target).filter(Boolean));

      // Собираем активные каналы с непрочитанными > 0
      const activeChannels: string[] = [];
      for (const hid of G.getEntitiesByType("channel")) {
        if ((G.getChannel(hid).unread ?? 0) > 0) {
          activeChannels.push(hid);
        }
      }

      if (activeChannels.length > 0) {
        const uncovered = activeChannels.filter((hid) => !coveredTargets.has(hid));
        const coverageRate = 1 - uncovered.length / activeChannels.length;
        if (coverageRate < 0.5 && activeChannels.length >= 3) {
          alerts.push({
            level: "warn",
            type: "vmax_coverage_low",
            message: `Покрытие целей V-max ${(coverageRate * 100).toFixed(0)}% (из ${activeChannels.length} активных каналов ${uncovered.length} не выбирались последние 200 tick)`,
            tick: currentTick,
          });
        }
      }
    } catch (e) {
      log.warn("vmax_coverage_low: сбой проверки", e);
    }
  }

  // INV-4: обнаружение насыщения tanh — некий P_k насыщается > 0.99 в >50% tick
  // Адаптивное κ должно предотвращать это, но если происходит — κ не успевает.
  // @see docs/adr/177-pressure-field-structural-audit.md §P0 INV-4
  try {
    const db = getDb();
    const rows = db
      .select({
        p1: tickLog.p1,
        p2: tickLog.p2,
        p3: tickLog.p3,
        p4: tickLog.p4,
        p5: tickLog.p5,
        p6: tickLog.p6,
      })
      .from(tickLog)
      .orderBy(desc(tickLog.tick))
      .limit(100)
      .all();
    if (rows.length >= 50) {
      const kappa = [5.0, 8.0, 8.0, 5.0, 3.0, 5.0];
      const names = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;
      const keys = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
      for (let i = 0; i < 6; i++) {
        const saturatedCount = rows.filter((r) => Math.tanh(r[keys[i]] / kappa[i]) > 0.99).length;
        if (saturatedCount > rows.length * 0.5) {
          alerts.push({
            level: "warn",
            type: "pressure_saturated",
            message: `${names[i]} насыщение tanh ${((saturatedCount / rows.length) * 100).toFixed(0)}% (${saturatedCount}/${rows.length} tick), κ₍${i + 1}₎=${kappa[i]} — возможно, недостаточно`,
            tick: currentTick,
          });
        }
      }
    }
  } catch (e) {
    log.warn("pressure_saturated: сбой проверки", e);
  }

  // Вывод результатов (с троттлом повторов по type, чтобы не засорять лог в простое)
  const nowMs = Date.now();
  for (const alert of alerts) {
    if (nowMs - (lastLoggedAt.get(alert.type) ?? 0) < LOG_THROTTLE_MS) continue;
    lastLoggedAt.set(alert.type, nowMs);
    if (alert.level === "error") {
      log.error(`[${alert.type}] ${alert.message}`);
    } else {
      log.warn(`[${alert.type}] ${alert.message}`);
    }
  }

  return alerts;
}

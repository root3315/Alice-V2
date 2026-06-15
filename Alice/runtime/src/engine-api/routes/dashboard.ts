/**
 * Engine API — веб-дашборд статистики Алисы (read-only, localhost).
 *
 *   GET /dashboard       → HTML-страница с графиками (автообновление).
 *   GET /dashboard/data  → JSON со всеми метриками (страница опрашивает периодически).
 *
 * Только ЧТЕНИЕ состояния: поведение/личность/когницию не трогает. Источники:
 * граф (каналы/контакты/self/факты/потоки), БД (tick_log/action_log/personality_snapshots),
 * диагностика (разнообразие голосов/дрейф личности) и read-only query-дисптчер
 * (pressure/open_topics/reminders/recent_episodes/crisis_channels).
 *
 * Принцип устойчивости: КАЖДЫЙ источник данных обёрнут в try/catch — частичный сбой
 * (например, недоступный query или битый snapshot) никогда не роняет ни JSON, ни страницу.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { asc, desc, eq, sql } from "drizzle-orm";
import { runAnomalyCheck } from "../../db/anomaly.js";
import { writeAuditEvent } from "../../db/audit.js";
import { getDb } from "../../db/connection.js";
import {
  actionLog,
  auditEvents,
  personalitySnapshots,
  silenceLog,
  tickLog,
} from "../../db/schema.js";
import { analyzeVoiceDiversity } from "../../diagnostics/diversity.js";
import { safeDisplayName } from "../../graph/display.js";
import { getWorkiSnapshot } from "../../mods/worki.mod.js";
import { getSelfcheckData } from "../../telegram/apps/selfcheck.js";
import { VOICES } from "../../voices/personality.js";
import { createLogger } from "../../utils/logger.js";
import type { EngineApiDeps } from "../server.js";

const log = createLogger("dashboard");

/**
 * Безопасно вызывает read-only query через dispatcher-мост.
 * Диспетчер query синхронный и возвращает либо результат, либо `{ __dispatchError }`,
 * либо undefined (неизвестный query). Здесь сглаживаем оба провальных случая в null,
 * а на возможный async-результат (Promise) тоже отвечаем null, т.к. сбор данных синхронный.
 */
function safeQuery(deps: EngineApiDeps, name: string, args: Record<string, unknown> = {}): unknown {
  try {
    if (!deps.query) return null;
    const r = deps.query(name, args);
    if (r && typeof r === "object") {
      if ("__dispatchError" in r) return null;
      if (typeof (r as { then?: unknown }).then === "function") return null; // Promise — пропускаем
    }
    return r ?? null;
  } catch (e) {
    log.warn(`dashboard query ${name} failed`, { err: (e as Error).message });
    return null;
  }
}

/** Безопасное чтение динамического атрибута узла графа (узел может отсутствовать). */
function dyn(deps: EngineApiDeps, nodeId: string, key: string): unknown {
  try {
    if (!deps.G.has(nodeId)) return null;
    return deps.G.getDynamic(nodeId, key) ?? null;
  } catch {
    return null;
  }
}

/** Парсит JSON-строку в объект; при любой ошибке → null. */
function parseJson<T = unknown>(raw: unknown): T | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Собирает все метрики в один JSON. Каждый блок защищён — частичный сбой не роняет дашборд. */
function collectData(deps: EngineApiDeps): Record<string, unknown> {
  const G = deps.G;

  // ── Текущий tick ────────────────────────────────────────────────────────────
  let tick: number | null = null;
  try {
    tick = deps.getTick ? deps.getTick() : G.tick;
  } catch (e) {
    log.warn("dashboard tick failed", { err: (e as Error).message });
  }

  // ── Поле давления (P1–P6 + API + per-entity вклады) ──────────────────────────
  // Используется ниже для обогащения каналов/контактов столбцом «давление».
  let pressure: Record<string, unknown> | null = null;
  let pressureByEntity: Record<string, number> = {};
  try {
    const p = safeQuery(deps, "pressure") as
      | {
          P1: number;
          P2: number;
          P3: number;
          P4: number;
          P5: number;
          P6: number;
          P_prospect: number;
          API: number;
          API_peak: number;
          A: number;
          contributions?: Record<string, Record<string, number>>;
          prospectContributions?: Record<string, number>;
        }
      | null;
    if (p) {
      pressure = {
        P1: p.P1,
        P2: p.P2,
        P3: p.P3,
        P4: p.P4,
        P5: p.P5,
        P6: p.P6,
        prospect: p.P_prospect,
        api: p.API,
        apiPeak: p.API_peak,
        arousalDrive: p.A,
      };
      // Свернуть вклады по всем измерениям в суммарное давление на сущность.
      const totals: Record<string, number> = {};
      const contrib = p.contributions ?? {};
      for (const dim of Object.keys(contrib)) {
        for (const [entity, v] of Object.entries(contrib[dim] ?? {})) {
          totals[entity] = (totals[entity] ?? 0) + Number(v ?? 0);
        }
      }
      // Bug #4: prospect-вклады лежат в ОТДЕЛЬНОЙ per-entity карте (P_prospect не попадает в
      // contributions) — без них давление на сущность недооценено. Складываем и их.
      for (const [entity, v] of Object.entries(p.prospectContributions ?? {})) {
        totals[entity] = (totals[entity] ?? 0) + Number(v ?? 0);
      }
      pressureByEntity = totals;
    }
  } catch (e) {
    log.warn("dashboard pressure failed", { err: (e as Error).message });
  }

  // ── Каналы ────────────────────────────────────────────────────────────────
  const channels: Array<Record<string, unknown>> = [];
  try {
    for (const id of G.getEntitiesByType("channel")) {
      const a = G.getChannel(id) as unknown as Record<string, unknown>;
      const reach = Number(a.reachability_score ?? 1);
      // Давление канала: атрибут pressure (если есть) либо суммарный вклад из pressure-query.
      const chPressure =
        a.pressure != null ? Number(a.pressure) : (pressureByEntity[id] ?? null);
      channels.push({
        name: safeDisplayName(G, id),
        chatType: a.chat_type ?? null,
        unread: Number(a.unread ?? 0),
        role: String(a.alice_role ?? "subscriber"),
        pendingDirected: Number(a.pending_directed ?? 0),
        reachability: reach,
        unreachable: a.failure_type === "permanent" || reach <= 0,
        pressure: chPressure != null ? Number(chPressure) : null,
        currentTopic: a.current_topic_id ?? null,
        risk: a.risk_level ?? null,
        aversion: a.aversion != null ? Number(a.aversion) : null,
        habituation: a.habituation != null ? Number(a.habituation) : null,
        consecutiveOutgoing: Number(a.consecutive_outgoing ?? 0),
        subscriptionHealth:
          a.subscription_health != null ? Number(a.subscription_health) : null,
      });
    }
    channels.sort((x, y) => Number(y.unread) - Number(x.unread));
  } catch (e) {
    log.warn("dashboard channels failed", { err: (e as Error).message });
  }

  // ── Контакты ──────────────────────────────────────────────────────────────
  const contacts: Array<Record<string, unknown>> = [];
  try {
    for (const id of G.getEntitiesByType("contact")) {
      const c = G.getContact(id) as unknown as Record<string, unknown>;
      const num = (k: string): number | null => (c[k] != null ? Number(c[k]) : null);
      contacts.push({
        name: safeDisplayName(G, id),
        tier: Number(c.tier ?? 0),
        relationType: c.relation_type ?? null,
        // Полный вектор отношений (ADR-178): все 5 измерений ∈ [0,1].
        trust: num("rv_trust"),
        affection: num("rv_affection"),
        familiarity: num("rv_familiarity"),
        respect: num("rv_respect"), // Bug #3: было отброшено
        attraction: num("rv_attraction"), // Bug #3: было отброшено
        // Velocity по измерениям (сглаженная EMA первой производной) — рост/спад связи.
        velTrust: num("rv_vel_trust"),
        velAffection: num("rv_vel_affection"),
        velFamiliarity: num("rv_vel_familiarity"),
        velRespect: num("rv_vel_respect"),
        velAttraction: num("rv_vel_attraction"),
        romanticPhase: c.romantic_phase ?? null,
        interactions: Number(c.interaction_count ?? 0),
        risk: c.risk_level ?? null,
        isBot: c.is_bot === true,
        pressure: pressureByEntity[id] != null ? Number(pressureByEntity[id]) : null,
        lastSeen: c.last_active_ms ?? null,
      });
    }
    // Сортировка: сперва по суммарному давлению (актуальность), затем по tier.
    contacts.sort((x, y) => {
      const pp = Number(y.pressure ?? 0) - Number(x.pressure ?? 0);
      return pp !== 0 ? pp : Number(y.tier) - Number(x.tier);
    });
  } catch (e) {
    log.warn("dashboard contacts failed", { err: (e as Error).message });
  }

  // ── Self (настроение/энергия/режим) ────────────────────────────────────────
  let self: Record<string, unknown> | null = null;
  try {
    if (G.has("self")) {
      self = {
        mood: dyn(deps, "self", "mood_effective") ?? dyn(deps, "self", "mood_valence"),
        moodArousal: dyn(deps, "self", "mood_arousal"),
        energy: dyn(deps, "self", "energy"),
        mode: dyn(deps, "self", "mode"),
        valence: dyn(deps, "self", "mood_valence"),
        arousal: dyn(deps, "self", "mood_arousal"),
        restingUntilMs: dyn(deps, "self", "resting_until_ms"),
        restingReason: dyn(deps, "self", "resting_reason"),
        thinkingTarget: dyn(deps, "self", "thinking_target"),
      };
    }
  } catch (e) {
    log.warn("dashboard self failed", { err: (e as Error).message });
  }

  // ── Личность (вектор D/C/S/X + здоровье + дрейф по snapshot'ам) ──────────────
  let personality: Record<string, unknown> | null = null;
  try {
    const labels = VOICES.map((v) => ({ id: v.id, short: v.short, display: v.display }));
    const currentWeights = parseJson<number[]>(dyn(deps, "self", "personality_weights"));
    const homeWeights = parseJson<number[]>(dyn(deps, "self", "pi_home"));
    const health = dyn(deps, "self", "personality_health");
    const driftAttr = dyn(deps, "self", "_personality_drift");
    const velocityAttr = dyn(deps, "self", "_personality_velocity");

    // История snapshot'ов: первый/последний вектор + per-dim сдвиг + траектория каждого измерения.
    let snapshotCount = 0;
    let firstWeights: number[] | null = null;
    let lastWeights: number[] | null = null;
    const trajectory: Array<{ tick: number; w: number[] }> = [];
    try {
      const d = getDb();
      const snaps = d
        .select({ tick: personalitySnapshots.tick, weights: personalitySnapshots.weights })
        .from(personalitySnapshots)
        .orderBy(asc(personalitySnapshots.tick))
        .all();
      snapshotCount = snaps.length;
      if (snaps.length > 0) {
        firstWeights = parseJson<number[]>(snaps[0].weights);
        lastWeights = parseJson<number[]>(snaps[snaps.length - 1].weights);
        // Прорежаем до ≤40 точек для компактного графика траектории.
        const step = Math.max(1, Math.ceil(snaps.length / 40));
        for (let i = 0; i < snaps.length; i += step) {
          const w = parseJson<number[]>(snaps[i].weights);
          if (w) trajectory.push({ tick: snaps[i].tick, w });
        }
        const lastSnapW = parseJson<number[]>(snaps[snaps.length - 1].weights);
        if (lastSnapW && (trajectory.length === 0 || trajectory[trajectory.length - 1].tick !== snaps[snaps.length - 1].tick)) {
          trajectory.push({ tick: snaps[snaps.length - 1].tick, w: lastSnapW });
        }
      }
    } catch (e) {
      log.warn("dashboard personality snapshots failed", { err: (e as Error).message });
    }

    // Per-dim итоговый сдвиг (last - first).
    let perDimDrift: number[] | null = null;
    if (firstWeights && lastWeights && firstWeights.length === lastWeights.length) {
      perDimDrift = lastWeights.map((w, i) => w - firstWeights![i]);
    }

    personality = {
      labels,
      weights: currentWeights ?? lastWeights ?? null,
      home: homeWeights,
      health: health ?? null,
      driftMagnitude: driftAttr != null ? Number(driftAttr) : null,
      velocity: velocityAttr != null ? Number(velocityAttr) : null,
      snapshotCount,
      firstWeights,
      lastWeights,
      perDimDrift,
      trajectory,
    };
  } catch (e) {
    log.warn("dashboard personality failed", { err: (e as Error).message });
  }

  // ── Эмоция (ADR-268: derived emotion_state) ─────────────────────────────────
  let emotion: Record<string, unknown> | null = null;
  try {
    const es = parseJson<{
      dominant?: {
        kind?: string;
        valence?: number;
        arousal?: number;
        intensity?: number;
        effectiveIntensity?: number;
        cause?: { summary?: string };
      };
      secondary?: {
        kind?: string;
        valence?: number;
        arousal?: number;
        effectiveIntensity?: number;
        cause?: { summary?: string };
      };
      updatedAtMs?: number;
    }>(dyn(deps, "self", "emotion_state"));
    if (es) {
      const norm = (e?: {
        kind?: string;
        valence?: number;
        arousal?: number;
        intensity?: number;
        effectiveIntensity?: number;
        cause?: { summary?: string };
      }) =>
        e
          ? {
              kind: e.kind ?? null,
              valence: e.valence ?? null,
              arousal: e.arousal ?? null,
              intensity: e.effectiveIntensity ?? e.intensity ?? null,
              summary: e.cause?.summary ?? null,
            }
          : null;
      emotion = {
        dominant: norm(es.dominant),
        secondary: norm(es.secondary),
        updatedAtMs: es.updatedAtMs ?? null,
      };
    }
  } catch (e) {
    log.warn("dashboard emotion failed", { err: (e as Error).message });
  }

  // ── Граф: счётчики узлов/рёбер (память/факты/потоки/диалоги) ─────────────────
  let graph: Record<string, unknown> | null = null;
  try {
    const count = (t: string) => {
      try {
        return G.getEntitiesByType(t).length;
      } catch {
        return 0;
      }
    };
    graph = {
      facts: count("fact"),
      threads: count("thread"),
      contacts: count("contact"),
      channels: count("channel"),
      conversations: count("conversation"),
      totalNodes: G.size,
      edges: G.edgeCount,
    };
  } catch (e) {
    log.warn("dashboard graph failed", { err: (e as Error).message });
  }

  // ── Открытые темы / потоки ──────────────────────────────────────────────────
  let topics: Array<Record<string, unknown>> = [];
  try {
    const rows = safeQuery(deps, "open_topics") as Array<Record<string, unknown>> | null;
    if (Array.isArray(rows)) {
      topics = rows
        .map((r) => ({
          id: r.id ?? null,
          title: r.title ?? "(no title)",
          status: r.status ?? null,
          weight: r.weight ?? null,
          source: r.source ?? null,
          pressure: r.pressure != null ? Number(r.pressure) : null,
          relevance: r.relevance != null ? Number(r.relevance) : null,
          horizon: r.horizon != null ? Number(r.horizon) : null,
          involves: Array.isArray(r.involves)
            ? (r.involves as Array<Record<string, unknown>>).map(
                (i) => i.displayName ?? i.nodeId ?? "?",
              )
            : [],
        }))
        .slice(0, 30);
    }
  } catch (e) {
    log.warn("dashboard topics failed", { err: (e as Error).message });
  }

  // ── Напоминания / запланированные задачи ────────────────────────────────────
  let reminders: Array<Record<string, unknown>> = [];
  try {
    const rows = safeQuery(deps, "reminders") as Array<Record<string, unknown>> | null;
    if (Array.isArray(rows)) {
      reminders = rows
        .map((r) => ({
          id: r.id ?? null,
          type: r.type ?? null,
          action: r.action ?? "",
          target: r._targetName ?? r.target ?? null,
          targetMs: r.targetMs ?? null,
          intervalMs: r.intervalMs ?? null,
        }))
        .slice(0, 30);
    }
  } catch (e) {
    log.warn("dashboard reminders failed", { err: (e as Error).message });
  }

  // ── Недавние когнитивные эпизоды ────────────────────────────────────────────
  let episodes: Array<Record<string, unknown>> = [];
  try {
    const rows = safeQuery(deps, "recent_episodes", { count: 8 }) as Array<
      Record<string, unknown>
    > | null;
    if (Array.isArray(rows)) {
      episodes = rows.map((r) => {
        const residue = r.residue as { type?: string } | null;
        return {
          id: r.id ?? null,
          target: r.target ?? null,
          outcome: r.outcome ?? null,
          residue: residue?.type ?? null,
        };
      });
    }
  } catch (e) {
    log.warn("dashboard episodes failed", { err: (e as Error).message });
  }

  // ── Кризисные каналы ─────────────────────────────────────────────────────────
  let crisisChannels: string[] = [];
  try {
    const rows = safeQuery(deps, "crisis_channels") as unknown;
    if (Array.isArray(rows)) {
      crisisChannels = rows.map((r) => {
        const id = String(r);
        try {
          return G.has(id) ? safeDisplayName(G, id) : id;
        } catch {
          return id;
        }
      });
    }
  } catch (e) {
    log.warn("dashboard crisis failed", { err: (e as Error).message });
  }

  // ── БД-активность ───────────────────────────────────────────────────────────
  let db: Record<string, unknown> = { ok: false };
  try {
    const d = getDb();
    const ticks = d.select({ c: sql<number>`count(*)` }).from(tickLog).get()?.c ?? 0;
    const actions = d.select({ c: sql<number>`count(*)` }).from(actionLog).get()?.c ?? 0;
    const ok =
      d
        .select({ c: sql<number>`count(*)` })
        .from(actionLog)
        .where(eq(actionLog.success, true))
        .get()?.c ?? 0;
    const recent = d
      .select({ tick: actionLog.tick, voice: actionLog.voice, success: actionLog.success })
      .from(actionLog)
      .orderBy(desc(actionLog.id))
      .limit(40)
      .all();
    const byVoice = d
      .select({ voice: actionLog.voice, c: sql<number>`count(*)` })
      .from(actionLog)
      .groupBy(actionLog.voice)
      .all();

    // Успех/неуспех по голосам (стек-бар).
    let byVoiceOutcome: Array<{ voice: string; ok: number; fail: number }> = [];
    try {
      const rows = d
        .select({
          voice: actionLog.voice,
          ok: sql<number>`sum(case when ${actionLog.success} then 1 else 0 end)`,
          total: sql<number>`count(*)`,
        })
        .from(actionLog)
        .groupBy(actionLog.voice)
        .all();
      byVoiceOutcome = rows.map((r) => ({
        voice: r.voice ?? "?",
        ok: Number(r.ok ?? 0),
        fail: Number(r.total ?? 0) - Number(r.ok ?? 0),
      }));
    } catch (e) {
      log.warn("dashboard byVoiceOutcome failed", { err: (e as Error).message });
    }

    // Активность во времени: действия, сгруппированные по бакетам тиков (≈30 бакетов).
    let activityBuckets: Array<{ bucket: number; total: number; ok: number }> = [];
    try {
      const span = (tick ?? ticks) || 0;
      const bucketSize = Math.max(1, Math.ceil((span || 1) / 30));
      const rows = d
        .select({
          bucket: sql<number>`(${actionLog.tick} / ${bucketSize})`,
          total: sql<number>`count(*)`,
          ok: sql<number>`sum(case when ${actionLog.success} then 1 else 0 end)`,
        })
        .from(actionLog)
        .groupBy(sql`(${actionLog.tick} / ${bucketSize})`)
        .orderBy(sql`(${actionLog.tick} / ${bucketSize})`)
        .all();
      activityBuckets = rows.map((r) => ({
        bucket: Number(r.bucket ?? 0) * bucketSize,
        total: Number(r.total ?? 0),
        ok: Number(r.ok ?? 0),
      }));
    } catch (e) {
      log.warn("dashboard activityBuckets failed", { err: (e as Error).message });
    }

    // Распределение режимов (tick_log.mode).
    let byMode: Array<{ mode: string; c: number }> = [];
    try {
      const rows = d
        .select({ mode: tickLog.mode, c: sql<number>`count(*)` })
        .from(tickLog)
        .groupBy(tickLog.mode)
        .all();
      byMode = rows
        .map((r) => ({ mode: r.mode ?? "—", c: Number(r.c ?? 0) }))
        .sort((a, b) => b.c - a.c);
    } catch (e) {
      log.warn("dashboard byMode failed", { err: (e as Error).message });
    }

    // Серия API за последние тики (line chart нагрузки).
    let apiSeries: Array<{ tick: number; api: number }> = [];
    try {
      const rows = d
        .select({ tick: tickLog.tick, api: tickLog.api })
        .from(tickLog)
        .orderBy(desc(tickLog.id))
        .limit(80)
        .all();
      apiSeries = rows
        .reverse()
        .map((r) => ({ tick: Number(r.tick ?? 0), api: Number(r.api ?? 0) }));
    } catch (e) {
      log.warn("dashboard apiSeries failed", { err: (e as Error).message });
    }

    // Молчание: счётчик и распределение причин (ADR-64 — молчание как информация).
    let silence: { total: number; byReason: Array<{ reason: string; c: number }> } = {
      total: 0,
      byReason: [],
    };
    try {
      const total = d.select({ c: sql<number>`count(*)` }).from(silenceLog).get()?.c ?? 0;
      const reasons = d
        .select({ reason: silenceLog.reason, c: sql<number>`count(*)` })
        .from(silenceLog)
        .groupBy(silenceLog.reason)
        .all();
      silence = {
        total,
        byReason: reasons
          .map((r) => ({ reason: r.reason ?? "?", c: Number(r.c ?? 0) }))
          .sort((a, b) => b.c - a.c),
      };
    } catch (e) {
      log.warn("dashboard silence failed", { err: (e as Error).message });
    }

    // Распределение типов действий (action_type).
    let byActionType: Array<{ type: string; c: number }> = [];
    try {
      const rows = d
        .select({ type: actionLog.actionType, c: sql<number>`count(*)` })
        .from(actionLog)
        .groupBy(actionLog.actionType)
        .all();
      byActionType = rows
        .map((r) => ({ type: r.type ?? "?", c: Number(r.c ?? 0) }))
        .sort((a, b) => b.c - a.c)
        .slice(0, 12);
    } catch (e) {
      log.warn("dashboard byActionType failed", { err: (e as Error).message });
    }

    db = {
      ok: true,
      ticks,
      actions,
      successRate: actions > 0 ? ok / actions : null,
      recent: recent.reverse(),
      byVoice,
      byVoiceOutcome,
      activityBuckets,
      byMode,
      apiSeries,
      silence,
      byActionType,
    };
  } catch (e) {
    db = { ok: false, error: (e as Error).message };
  }

  // ── Разнообразие голосов / дрейф личности ───────────────────────────────────
  let voices: unknown = null;
  try {
    voices = analyzeVoiceDiversity();
  } catch (e) {
    log.warn("dashboard voices failed", { err: (e as Error).message });
  }

  // ── Self-report (selfcheck-зеркало: настроение/социальность/личность/давление/действия) ──
  // Read-only семантический самоотчёт — те же данные, что видит сама Алиса в /engine/selfcheck.
  let selfcheck: Record<string, unknown> | null = null;
  try {
    const data = getSelfcheckData(G, Date.now(), tick ?? 0);
    selfcheck = { sections: data.sections };
  } catch (e) {
    log.warn("dashboard selfcheck failed", { err: (e as Error).message });
  }

  // ── Worki: in-flight + недоставленные задачи (read-only снимок очереди) ──────
  // Снимок без секретов/каналов — только статус-факты (kind/task/status/progress/delivered).
  let worki: Array<Record<string, unknown>> = [];
  try {
    const snap = getWorkiSnapshot();
    if (Array.isArray(snap)) {
      worki = snap.map((w) => ({
        id: w.id,
        kind: w.kind,
        task: w.task,
        status: w.status,
        latestProgress: w.latestProgress ?? null,
        project: w.project ?? null,
        createdMs: w.createdMs ?? null,
        completedMs: w.completedMs ?? null,
        delivered: Boolean(w.delivered),
      }));
    }
  } catch (e) {
    log.warn("dashboard worki failed", { err: (e as Error).message });
  }

  // ── Лента действий / решений (action_log: что именно она сделала + почему) ───
  // Panel #6: «что Алиса реально делала» — голос/цель/тип/текст/уверенность/успех/тик.
  // Самый ценный артефакт для понимания автономного компаньона. messageText/reasoning
  // обрезаем на стороне сервера (превью), чтобы не раздувать JSON.
  let actionFeed: Array<Record<string, unknown>> = [];
  try {
    const d = getDb();
    const rows = d
      .select({
        id: actionLog.id,
        tick: actionLog.tick,
        voice: actionLog.voice,
        target: actionLog.target,
        chatId: actionLog.chatId,
        actionType: actionLog.actionType,
        messageText: actionLog.messageText,
        confidence: actionLog.confidence,
        reasoning: actionLog.reasoning,
        success: actionLog.success,
        tcAfterward: actionLog.tcAfterward,
        createdAt: actionLog.createdAt,
      })
      .from(actionLog)
      .orderBy(desc(actionLog.id))
      .limit(80)
      .all();
    const preview = (s: unknown, n: number): string | null => {
      const t = typeof s === "string" ? s.trim() : "";
      if (!t) return null;
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    actionFeed = rows.map((r) => {
      // Цель в человекочитаемое имя, если узел известен.
      let targetName: string | null = null;
      const tgt = r.target ?? r.chatId ?? null;
      if (tgt != null) {
        const tid = String(tgt);
        try {
          targetName = G.has(tid) ? safeDisplayName(G, tid) : tid;
        } catch {
          targetName = tid;
        }
      }
      return {
        id: r.id,
        tick: Number(r.tick ?? 0),
        voice: r.voice ?? null,
        target: targetName,
        actionType: r.actionType ?? null,
        message: preview(r.messageText, 160),
        reasoning: preview(r.reasoning, 160),
        confidence: r.confidence != null ? Number(r.confidence) : null,
        success: r.success === true,
        afterward: r.tcAfterward ?? null,
        atMs: r.createdAt instanceof Date ? r.createdAt.getTime() : null,
      };
    });
  } catch (e) {
    log.warn("dashboard actionFeed failed", { err: (e as Error).message });
  }

  // ── Таймлайн аномалий + аудит-события (вынесено из selfcheck — Panel #8) ─────
  // runAnomalyCheck() даёт живые алерты поля давления/голосов/личности (передаём G для
  // инвариантов INV-1/INV-3). auditEvents — недавние warn/error из движка с временем.
  let anomalies: Array<Record<string, unknown>> = [];
  try {
    const alerts = runAnomalyCheck(tick ?? 0, G);
    if (Array.isArray(alerts)) {
      anomalies = alerts.map((a) => ({
        level: a.level,
        type: a.type,
        message: a.message,
        tick: a.tick,
      }));
    }
  } catch (e) {
    log.warn("dashboard anomalies failed", { err: (e as Error).message });
  }

  let auditFeed: Array<Record<string, unknown>> = [];
  try {
    const d = getDb();
    const rows = d
      .select({
        id: auditEvents.id,
        tick: auditEvents.tick,
        level: auditEvents.level,
        source: auditEvents.source,
        message: auditEvents.message,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .orderBy(desc(auditEvents.id))
      .limit(60)
      .all();
    auditFeed = rows.map((r) => ({
      id: r.id,
      tick: Number(r.tick ?? 0),
      level: r.level ?? null,
      source: r.source ?? null,
      message: typeof r.message === "string" ? r.message : "",
      atMs: r.createdAt instanceof Date ? r.createdAt.getTime() : null,
    }));
  } catch (e) {
    log.warn("dashboard auditFeed failed", { err: (e as Error).message });
  }

  // ── Аптайм процесса движка (дешёвая дополнительная метрика) ─────────────────
  let uptimeSec: number | null = null;
  try {
    uptimeSec = Math.floor(process.uptime());
  } catch {
    uptimeSec = null;
  }

  // Производные сводки для шапок вкладок (всё уже посчитано выше — только агрегируем).
  const unreachableChannels = channels.filter((c) => c.unreachable === true).length;
  const botContacts = contacts.filter((c) => c.isBot === true).length;
  const failedActionTypes = (() => {
    try {
      const bat = (db as { byActionType?: Array<{ type: string; c: number }> }).byActionType ?? [];
      return bat
        .filter((x) => /fail|error|provider_failed|validation_failed|script_failed/.test(x.type))
        .reduce((s, x) => s + Number(x.c ?? 0), 0);
    } catch {
      return 0;
    }
  })();

  return {
    ts: Date.now(),
    tick,
    uptimeSec,
    summary: {
      channels: channels.length,
      contacts: contacts.length,
      activeChannels: channels.filter((c) => Number(c.unread) > 0 || Number(c.pendingDirected) > 0)
        .length,
      unreachableChannels,
      botContacts,
      failedActionTypes,
      facts: graph ? Number((graph as Record<string, unknown>).facts ?? 0) : null,
      openTopics: topics.length,
      reminders: reminders.length,
      episodes: episodes.length,
      crisisChannels: crisisChannels.length,
      worki: worki.length,
      workiRunning: worki.filter((w) => w.status === "running").length,
      workiUndelivered: worki.filter((w) => w.delivered !== true).length,
      anomalies: anomalies.length,
      anomalyErrors: anomalies.filter((a) => a.level === "error").length,
    },
    channels: channels.slice(0, 60),
    contacts: contacts.slice(0, 40),
    self,
    personality,
    emotion,
    pressure,
    graph,
    topics,
    reminders,
    episodes,
    crisisChannels,
    db,
    voices,
    selfcheck,
    worki,
    actionFeed,
    anomalies,
    auditFeed,
  };
}

/**
 * Control-plane дашборда (POST /dashboard/control).
 *
 * Небольшой набор безопасных управляющих действий, проброшенных в существующий dispatcher.
 * Сознательно БЕЗ авторизации — дашборд остаётся localhost-style, решение владельца.
 * Каждое действие пишется в auditEvents (best-effort, сбой аудита не роняет ответ).
 *
 *   { action: "cancel_task",    taskId }   → dispatch cancel_task   (отменить запланированную задачу)
 *   { action: "dismiss_worki",  id }       → dispatch worki_dismiss (снять зависший/недоставленный результат)
 *   { action: "selfcheck",      focus? }   → пересобрать self-report on-demand
 *   { action: "feeds_pause" | "feeds_resume" } → dispatch feeds_set_polling (пауза/возобновление поллинга)
 */
async function handleControl(
  body: unknown,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  const sendJson = (code: number, payload: Record<string, unknown>): void => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    sendJson(400, { ok: false, error: "body must be a JSON object" });
    return;
  }
  const action = String((body as Record<string, unknown>).action ?? "").trim();
  const tick = (() => {
    try {
      return deps.getTick ? deps.getTick() : deps.G.tick;
    } catch {
      return -1;
    }
  })();

  // Мост к dispatcher: instruction может быть не зарегистрирована (mod выключен) —
  // undefined трактуем как "не поддержано", __dispatchError — как сбой impl.
  const dispatch = async (
    instruction: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string; unsupported?: boolean }> => {
    if (!deps.dispatchInstruction) return { ok: false, error: "dispatch not configured" };
    try {
      const r = await deps.dispatchInstruction(instruction, args);
      if (r === undefined || r === null) {
        return { ok: false, unsupported: true, error: `instruction "${instruction}" not available` };
      }
      if (typeof r === "object" && "__dispatchError" in (r as Record<string, unknown>)) {
        return { ok: false, error: String((r as { __dispatchError: unknown }).__dispatchError) };
      }
      if (typeof r === "object" && (r as { success?: unknown }).success === false) {
        return { ok: false, result: r, error: String((r as { error?: unknown }).error ?? "failed") };
      }
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  const audit = (ok: boolean, detail: Record<string, unknown>): void => {
    try {
      writeAuditEvent(
        tick,
        ok ? "warn" : "error",
        "dashboard",
        `control:${action} ${ok ? "ok" : "failed"}`,
        detail,
      );
    } catch {
      // аудит best-effort
    }
  };

  try {
    switch (action) {
      case "cancel_task": {
        const taskId = Number((body as Record<string, unknown>).taskId);
        if (!Number.isFinite(taskId) || taskId <= 0) {
          sendJson(400, { ok: false, error: "taskId must be a positive number" });
          return;
        }
        const r = await dispatch("cancel_task", { taskId });
        audit(r.ok, { taskId, error: r.error });
        sendJson(r.ok ? 200 : r.unsupported ? 501 : 500, r);
        return;
      }
      case "dismiss_worki": {
        const id = String((body as Record<string, unknown>).id ?? "").trim();
        if (!id) {
          sendJson(400, { ok: false, error: "id required" });
          return;
        }
        const r = await dispatch("worki_dismiss", { id });
        audit(r.ok, { id, error: r.error });
        sendJson(r.ok ? 200 : r.unsupported ? 501 : 500, r);
        return;
      }
      case "feeds_pause":
      case "feeds_resume": {
        const polling = action === "feeds_resume";
        const r = await dispatch("feeds_set_polling", { polling });
        audit(r.ok, { polling, error: r.error });
        sendJson(r.ok ? 200 : r.unsupported ? 501 : 500, r);
        return;
      }
      case "selfcheck": {
        const validFocus = ["mood", "social", "personality", "pressure", "actions"];
        const rawFocus = String((body as Record<string, unknown>).focus ?? "")
          .trim()
          .toLowerCase();
        const focus = validFocus.includes(rawFocus)
          ? (rawFocus as "mood" | "social" | "personality" | "pressure" | "actions")
          : undefined;
        const data = getSelfcheckData(deps.G, Date.now(), tick < 0 ? 0 : tick, focus);
        audit(true, { focus: focus ?? "all", sections: data.sections.length });
        sendJson(200, { ok: true, result: { sections: data.sections } });
        return;
      }
      default:
        sendJson(400, { ok: false, error: `unknown control action "${action}"` });
        return;
    }
  } catch (e) {
    audit(false, { error: (e as Error).message });
    sendJson(500, { ok: false, error: (e as Error).message });
  }
}

/** Читает JSON из тела запроса (лимит 1 МБ); пустое тело → {}. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Маршрут: GET /dashboard (страница), GET /dashboard/data (JSON),
 * POST /dashboard/control (control-plane, без авторизации — решение владельца).
 */
export async function handleDashboard(
  sub: string | undefined,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  if (method === "POST") {
    if (sub !== "control") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return;
    }
    await handleControl(body, res, deps);
    return;
  }

  if (sub === "data") {
    try {
      const data = collectData(deps);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Alice — Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { --bg:#0e1116; --card:#171c24; --line:#252c38; --tx:#e6edf3; --mut:#8b97a7; --acc:#7aa2ff; --good:#3fb950; --bad:#f85149; --warn:#d29922; --pur:#bc8cff; --cyan:#39c5cf; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:14px; padding:14px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:20; }
  header h1 { font-size:18px; margin:0; font-weight:600; }
  header .dot { width:9px; height:9px; border-radius:50%; background:var(--good); box-shadow:0 0 8px var(--good); }
  header .meta { color:var(--mut); font-size:12px; margin-left:auto; text-align:right; line-height:1.4; }
  header .meta b { color:var(--tx); font-weight:600; }
  /* ── Вкладки ── */
  nav.tabs { display:flex; gap:4px; padding:0 20px; border-bottom:1px solid var(--line); position:sticky; top:55px; background:var(--bg); z-index:19; overflow-x:auto; }
  nav.tabs button { background:none; border:none; border-bottom:2px solid transparent; color:var(--mut); font:inherit; font-size:13px; padding:12px 16px; cursor:pointer; white-space:nowrap; display:flex; align-items:center; gap:7px; }
  nav.tabs button:hover { color:var(--tx); }
  nav.tabs button.active { color:var(--tx); border-bottom-color:var(--acc); }
  nav.tabs button .badge { background:var(--line); color:var(--mut); border-radius:10px; font-size:11px; padding:0 7px; min-width:18px; text-align:center; }
  nav.tabs button.active .badge { background:#1f6feb33; color:var(--acc); }
  nav.tabs button .badge.alert { background:#f8514933; color:#ff8a80; }
  .wrap { padding:20px; max-width:1400px; margin:0 auto; }
  .tabpage { display:none; }
  .tabpage.active { display:block; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .k { color:var(--mut); font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  .card .v { font-size:24px; font-weight:700; margin-top:4px; }
  .card .sub { color:var(--mut); font-size:11px; margin-top:2px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid, .grid3 { grid-template-columns:1fr; } }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:var(--mut); margin:0 0 12px; }
  .panel h2 .hint { text-transform:none; letter-spacing:0; color:var(--mut); font-weight:400; opacity:.7; margin-left:6px; }
  .chartbox { position:relative; height:240px; }
  .chartbox.tall { height:300px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-weight:500; font-size:11px; text-transform:uppercase; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .pill { padding:1px 8px; border-radius:20px; font-size:11px; white-space:nowrap; }
  .pill.owner { background:#1f6feb33; color:#7aa2ff; } .pill.admin { background:#d2992233; color:#d29922; }
  .pill.sub { background:#30363d; color:var(--mut); }
  .pill.r-romantic { background:#f8514933; color:#ff8a80; } .pill.r-close_friend { background:#3fb95033; color:#7ee787; }
  .pill.r-friend { background:#7aa2ff33; color:#7aa2ff; } .pill.r-family { background:#bc8cff33; color:#bc8cff; }
  .pill.r-colleague { background:#39c5cf33; color:#39c5cf; } .pill.r-unknown,.pill.r- { background:#30363d; color:var(--mut); }
  .pill.risk-high { background:#f8514933; color:#ff8a80; } .pill.risk-medium { background:#d2992233; color:#d29922; }
  .pill.risk-low { background:#30363d; color:var(--mut); }
  .gone { color:var(--bad); } .bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; min-width:60px; }
  .bar > i { display:block; height:100%; background:var(--acc); }
  .mini { display:flex; align-items:center; gap:6px; }
  .mini .bar { flex:1; }
  .err { color:var(--bad); font-size:12px; }
  .empty { color:var(--mut); font-size:12px; font-style:italic; }
  .kv { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
  .kv .item { background:#0e1116; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  .kv .item .k { color:var(--mut); font-size:11px; text-transform:uppercase; }
  .kv .item .v { font-size:16px; font-weight:600; margin-top:2px; }
  .kv .item .v.pos { color:var(--good); } .kv .item .v.neg { color:var(--bad); }
  .tag { display:inline-block; background:#0e1116; border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:11px; color:var(--mut); margin:2px 2px 0 0; }
  .vel { font-size:9px; vertical-align:middle; } .vel.up { color:var(--good); } .vel.down { color:var(--bad); }
  .lvl-error { color:var(--bad); } .lvl-warn { color:var(--warn); } .lvl-fatal { color:#ff5577; font-weight:600; }
  .feed-text { color:var(--mut); font-size:12px; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
  .scrollbox { max-height:420px; overflow-y:auto; }
  .scrollbox table { border-collapse:collapse; } .scrollbox thead th { position:sticky; top:0; background:var(--card); z-index:1; }
  /* ── Control-plane (без авторизации — решение владельца) ── */
  .ctlbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:12px; }
  .ctlbtn { background:#1f6feb22; border:1px solid #1f6feb55; color:var(--acc); border-radius:8px; font:inherit; font-size:12px; padding:5px 12px; cursor:pointer; }
  .ctlbtn:hover { background:#1f6feb44; }
  .ctlbtn:disabled { opacity:.5; cursor:default; }
  .ctlbtn.sm { padding:2px 9px; font-size:11px; }
  .ctlbtn.danger { background:#f8514922; border-color:#f8514955; color:#ff8a80; }
  .ctlbtn.danger:hover { background:#f8514944; }
  .ctlmsg { color:var(--mut); font-size:12px; }
  .ctlmsg.ok { color:var(--good); } .ctlmsg.err { color:var(--bad); }
  .sc-section { margin-bottom:14px; }
  .sc-section .sc-label { color:var(--acc); font-size:12px; text-transform:uppercase; letter-spacing:.5px; margin-bottom:5px; }
  .sc-section .sc-line { color:var(--tx); font-size:13px; padding:2px 0; white-space:pre-wrap; }
</style>
</head>
<body>
<header>
  <span class="dot"></span><h1>Alice — Dashboard</h1>
  <span class="meta" id="meta">загрузка…</span>
</header>
<nav class="tabs" id="tabs"></nav>
<div class="wrap">

  <!-- ════════ ОБЗОР ════════ -->
  <section class="tabpage" data-tab="overview">
    <div class="cards" id="cards"></div>
    <div class="grid">
      <div class="panel"><h2>Активность по тикам <span class="hint">действия / успешные</span></h2><div class="chartbox"><canvas id="ovActivityChart"></canvas></div></div>
      <div class="panel"><h2>Голоса <span class="hint">распределение выбора</span></h2><div class="chartbox"><canvas id="ovVoiceChart"></canvas></div></div>
    </div>
    <div class="grid3">
      <div class="panel"><h2>Личность <span class="hint">π = D / C / S / X</span></h2><div class="chartbox"><canvas id="ovPersChart"></canvas></div></div>
      <div class="panel"><h2>Поле давления <span class="hint">сводка</span></h2><div id="ovPressure"></div></div>
      <div class="panel"><h2>Состояние / эмоция</h2><div id="ovState"></div></div>
    </div>
  </section>

  <!-- ════════ КОГНИЦИЯ ════════ -->
  <section class="tabpage" data-tab="cognition">
    <div class="grid">
      <div class="panel"><h2>Личность <span class="hint">π = D / C / S / X · текущий vs base</span></h2><div class="chartbox"><canvas id="persChart"></canvas></div></div>
      <div class="panel"><h2>Дрейф личности <span class="hint">траектория по snapshot'ам</span></h2><div class="chartbox"><canvas id="driftChart"></canvas></div></div>
    </div>
    <div class="panel"><h2>Метрики личности <span class="hint">drift / velocity / per-dim shift</span></h2><div id="persMeta"></div></div>
    <div class="panel"><h2>Поле давления <span class="hint">P1–P6 + prospect</span></h2><div id="pressure"></div></div>
    <div class="grid">
      <div class="panel"><h2>Эмоция <span class="hint">ADR-268</span></h2><div id="emotion"></div></div>
      <div class="panel"><h2>Голоса <span class="hint">распределение + повторы</span></h2><div class="chartbox"><canvas id="voiceChart"></canvas></div></div>
    </div>
    <div class="panel"><h2>Действия по голосам <span class="hint">успех / неуспех</span></h2><div class="chartbox"><canvas id="voiceActChart"></canvas></div></div>
    <div class="panel"><h2>Разнообразие по плоскостям <span class="hint">энтропия выбора голоса в разных точках конвейера</span></h2><div id="planes"></div></div>
  </section>

  <!-- ════════ СОЦИАЛЬНОЕ ════════ -->
  <section class="tabpage" data-tab="social">
    <div class="panel"><h2>Каналы <span class="hint" id="chHint"></span></h2><div id="channels"></div></div>
    <div class="panel"><h2>Контакты <span class="hint">по давлению / tier</span></h2><div id="contacts"></div></div>
    <div class="grid">
      <div class="panel"><h2>Открытые темы</h2><div id="topics"></div></div>
      <div class="panel"><h2>Кризисные каналы</h2><div id="crisis"></div></div>
    </div>
  </section>

  <!-- ════════ АКТИВНОСТЬ ════════ -->
  <section class="tabpage" data-tab="activity">
    <div class="panel">
      <h2>Лента действий <span class="hint">что Алиса делала + почему (голос / цель / тип / текст / уверенность / исход)</span></h2>
      <div id="actionFeed"></div>
    </div>
    <div class="grid">
      <div class="panel"><h2>Активность по тикам <span class="hint">действия / успешные</span></h2><div class="chartbox"><canvas id="activityChart"></canvas></div></div>
      <div class="panel"><h2>Нагрузка API <span class="hint">последние тики</span></h2><div class="chartbox"><canvas id="apiChart"></canvas></div></div>
    </div>
    <div class="grid">
      <div class="panel"><h2>Типы действий</h2><div class="chartbox"><canvas id="actTypeChart"></canvas></div></div>
      <div class="panel"><h2>Молчание <span class="hint">по причинам</span></h2><div class="chartbox"><canvas id="silenceChart"></canvas></div></div>
    </div>
    <div class="grid">
      <div class="panel"><h2>Режимы тиков</h2><div class="chartbox"><canvas id="modeChart"></canvas></div></div>
      <div class="panel"><h2>Последние действия <span class="hint">успех / неуспех по тикам</span></h2><div class="chartbox"><canvas id="actChart"></canvas></div></div>
    </div>
  </section>

  <!-- ════════ ПАМЯТЬ ════════ -->
  <section class="tabpage" data-tab="memory">
    <div class="panel"><h2>Память графа <span class="hint">узлы / рёбра / типы</span></h2><div id="graphmem"></div></div>
    <div class="grid">
      <div class="panel"><h2>Недавние эпизоды</h2><div id="episodes"></div></div>
      <div class="panel">
        <h2>Напоминания / задачи <span class="hint">кнопка отменяет задачу (cancel_task)</span></h2>
        <div id="reminders"></div>
      </div>
    </div>
    <div class="panel"><h2>Состояние / режим <span class="hint">self-узел</span></h2><div id="state"></div></div>
  </section>

  <!-- ════════ SELF-REPORT (selfcheck) ════════ -->
  <section class="tabpage" data-tab="selfcheck">
    <div class="panel">
      <h2>Self-report <span class="hint">семантическое зеркало — то, что Алиса видит в /selfcheck (read-only)</span></h2>
      <div class="ctlbar">
        <button class="ctlbtn" data-sc="">Пересобрать всё</button>
        <button class="ctlbtn" data-sc="mood">Настроение</button>
        <button class="ctlbtn" data-sc="social">Социальное</button>
        <button class="ctlbtn" data-sc="personality">Личность</button>
        <button class="ctlbtn" data-sc="pressure">Давление</button>
        <button class="ctlbtn" data-sc="actions">Действия</button>
        <span class="ctlmsg" id="scMsg"></span>
      </div>
      <div id="selfcheck"></div>
    </div>
    <div class="panel">
      <h2>Управление фидами <span class="hint">пауза/возобновление интернет-восприятия</span></h2>
      <div class="ctlbar">
        <button class="ctlbtn" data-feed="pause">Пауза поллинга</button>
        <button class="ctlbtn" data-feed="resume">Возобновить</button>
        <span class="ctlmsg" id="feedMsg"></span>
      </div>
    </div>
  </section>

  <!-- ════════ WORKI ════════ -->
  <section class="tabpage" data-tab="worki">
    <div class="cards" id="workiCards"></div>
    <div class="ctlbar"><span class="ctlmsg" id="workiMsg"></span></div>
    <div class="panel">
      <h2>В работе <span class="hint">текущие задачи worki · «снять» убирает зависшую (dismiss_worki)</span></h2>
      <div id="workiActive"></div>
    </div>
    <div class="panel">
      <h2>Недавние <span class="hint">завершённые / недоставленные · «снять» чистит застрявшие</span></h2>
      <div id="workiRecent"></div>
    </div>
  </section>

  <!-- ════════ ЗДОРОВЬЕ (аномалии + аудит) ════════ -->
  <section class="tabpage" data-tab="health">
    <div class="panel">
      <h2>Аномалии <span class="hint">живые алерты поля давления / голосов / личности (runAnomalyCheck)</span></h2>
      <div id="anomalies"></div>
    </div>
    <div class="panel">
      <h2>Аудит-события <span class="hint">недавние warn / error из движка с временем</span></h2>
      <div id="auditFeed"></div>
    </div>
  </section>

</div>
<script>
const charts = {};
const $ = (id) => document.getElementById(id);
const palette = ['#7aa2ff','#3fb950','#d29922','#f85149','#bc8cff','#39c5cf','#ff8a80','#7ee787'];
function card(k,v,sub){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'; }
function fmtPct(x){ return x==null?'—':(x*100).toFixed(0)+'%'; }
function fmtN(x,d){ return x==null?'—':Number(x).toFixed(d==null?2:d); }
function fmtInt(x){ return x==null?'—':Number(x).toLocaleString('ru'); }
function fmtDur(sec){ if(sec==null) return '—'; sec=Math.floor(sec); const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60); if(d>0) return d+'д '+h+'ч'; if(h>0) return h+'ч '+m+'м'; if(m>0) return m+'м'; return sec+'с'; }
function fmtAgo(ms){ if(!ms) return '—'; const s=Math.floor((Date.now()-Number(ms))/1000); if(s<0) return 'скоро'; if(s<60) return s+'с назад'; const m=Math.floor(s/60); if(m<60) return m+'м назад'; const h=Math.floor(m/60); if(h<24) return h+'ч назад'; return Math.floor(h/24)+'д назад'; }
function esc(s){ return String(s==null?'':s).replace(/[<>&"']/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[m])); }
/* Стрелка velocity отношения: rising/falling по знаку производной (мёртвая зона у нуля). */
function velArrow(v){ if(v==null||Math.abs(v)<1e-4) return ''; return v>0?' <span class="vel up">▲</span>':' <span class="vel down">▼</span>'; }
/* Ячейка одного измерения вектора отношений ∈ [0,1] → бар v*100 clamp 0..100 (Bug #2: rv_* уже [0,1],
   старое ((v+1)/2)*100 раздувало; нейтральные 0.3 показывались ~65%). + стрелка velocity. */
function rvCell(v,vel){
  if(v==null) return '<td class="num">—</td>';
  const w=Math.max(0,Math.min(100,Number(v)*100));
  return '<td><div class="mini"><div class="bar"><i style="width:'+w+'%"></i></div><span>'+fmtN(v)+velArrow(vel)+'</span></div></td>';
}
/* Важность темы — enum (trivial/minor/major/critical), а НЕ число: рендерим цветной меткой. */
function weightTag(w){
  if(w==null||w==='') return '<span class="empty">—</span>';
  const k=String(w).toLowerCase();
  const cls={trivial:'risk-low',minor:'r-friend',major:'admin',critical:'risk-high'}[k]||'sub';
  return '<span class="pill '+cls+'">'+esc(w)+'</span>';
}
const ax = { color:'#8b97a7' };

/* ── Control-plane: POST /dashboard/control. Без авторизации (решение владельца). ──
   Возвращает разобранный JSON; кидает с .message при не-2xx, чтобы вызвавший показал ошибку. */
async function ctl(payload){
  const r = await fetch('/dashboard/control', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  let j = {}; try { j = await r.json(); } catch(e){}
  if(!r.ok || j.ok===false){ const e=new Error(j.error||('HTTP '+r.status)); e.payload=j; throw e; }
  return j;
}
/* Показывает короткий статус в элементе .ctlmsg и гасит его через паузу. */
function ctlMsg(id, text, kind){
  const el=$(id); if(!el) return;
  el.textContent=text; el.className='ctlmsg'+(kind?(' '+kind):'');
  if(el._t) clearTimeout(el._t);
  el._t=setTimeout(()=>{ el.textContent=''; el.className='ctlmsg'; }, 6000);
}

/* Создаёт/обновляет график. Возвращает экземпляр (или null). Создаём ТОЛЬКО если
   контейнер виден (offsetParent != null) — иначе Chart.js нарисует 0×0 при display:none. */
function upsert(id, type, data, options){
  const el = $(id); if(!el) return null;
  if(charts[id]){ charts[id].data = data; if(options) charts[id].options = options; charts[id].update('none'); return charts[id]; }
  if(el.offsetParent === null) return null; // вкладка скрыта — отложим до показа
  charts[id] = new Chart(el, { type, data, options });
  return charts[id];
}

/* ── Вкладки ── */
const TABS = [
  { id:'overview',  label:'Обзор',      badge:null },
  { id:'cognition', label:'Когниция',   badge:null },
  { id:'social',    label:'Социальное', badge:d=>d&&d.summary?d.summary.channels:null },
  { id:'activity',  label:'Активность', badge:d=>d&&d.db?d.db.actions:null },
  { id:'memory',    label:'Память',     badge:d=>d&&d.summary?d.summary.facts:null },
  { id:'worki',     label:'Worki',      badge:d=>d&&d.summary?d.summary.worki:null },
  { id:'health',    label:'Здоровье',   badge:d=>d&&d.summary?d.summary.anomalies:null },
  { id:'selfcheck', label:'Self-report',badge:d=>d&&d.selfcheck&&d.selfcheck.sections?d.selfcheck.sections.length:null },
];
let activeTab = (location.hash||'').replace('#','') || 'overview';
if(!TABS.some(t=>t.id===activeTab)) activeTab = 'overview';
let lastData = null;

function buildTabs(){
  $('tabs').innerHTML = TABS.map(t=>'<button data-tab="'+t.id+'"><span>'+t.label+'</span><span class="badge" id="badge-'+t.id+'"></span></button>').join('');
  for(const t of TABS){
    $('tabs').querySelector('button[data-tab="'+t.id+'"]').addEventListener('click',()=>selectTab(t.id));
  }
}
function selectTab(id){
  activeTab = id;
  try { history.replaceState(null,'','#'+id); } catch(e){}
  document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===id));
  document.querySelectorAll('.tabpage').forEach(p=>p.classList.toggle('active', p.dataset.tab===id));
  // Перерисовать содержимое активной вкладки из последних данных и подогнать графики.
  if(lastData) renderTab(id, lastData);
  // resize() нужен, т.к. график мог быть создан, пока вкладка была скрыта (0×0).
  requestAnimationFrame(()=>{ for(const k in charts){ const c=charts[k]; if(c && c.canvas && c.canvas.offsetParent!==null){ try{ c.resize(); }catch(e){} } } });
}

/* ── Рендер шапки и бейджей (всегда, независимо от вкладки) ── */
function renderHeader(d){
  const db = d.db||{};
  $('meta').innerHTML =
    'обновлено <b>'+new Date(d.ts).toLocaleTimeString('ru')+'</b>'+
    (d.tick!=null?(' · tick <b>'+fmtInt(d.tick)+'</b>'):'')+
    (d.self&&d.self.mode?(' · режим <b>'+esc(d.self.mode)+'</b>'):'')+
    (d.uptimeSec!=null?(' · uptime <b>'+fmtDur(d.uptimeSec)+'</b>'):'')+
    '<br>тиков '+fmtInt(db.ticks)+' · действий '+fmtInt(db.actions)+' · успешность '+fmtPct(db.successRate);
  for(const t of TABS){
    const el = $('badge-'+t.id); if(!el) continue;
    const val = typeof t.badge==='function' ? t.badge(d) : t.badge;
    if(val==null||val===''){ el.style.display='none'; }
    else { el.style.display=''; el.textContent = fmtInt(val); }
  }
  // Алерт-бейджи: кризисы → Социальное, ошибки → Активность.
  const crisis = (d.summary&&d.summary.crisisChannels)||0;
  const badS = $('badge-social');
  if(badS){ if(crisis>0){ badS.classList.add('alert'); badS.textContent=fmtInt((d.summary&&d.summary.channels)||0)+'!'; } else badS.classList.remove('alert'); }
  const fails = (d.summary&&d.summary.failedActionTypes)||0;
  const badA = $('badge-activity');
  if(badA){ if(fails>0){ badA.classList.add('alert'); } else badA.classList.remove('alert'); }
  // Алерт-бейдж: недоставленные результаты worki → вкладка Worki.
  const undel = (d.summary&&d.summary.workiUndelivered)||0;
  const badW = $('badge-worki');
  if(badW){ if(undel>0){ badW.classList.add('alert'); } else badW.classList.remove('alert'); }
  // Алерт-бейдж: аномалии уровня error → вкладка Здоровье.
  const anomErr = (d.summary&&d.summary.anomalyErrors)||0;
  const badH = $('badge-health');
  if(badH){ if(anomErr>0){ badH.classList.add('alert'); } else badH.classList.remove('alert'); }
}

/* ════════ Рендеры по вкладкам ════════ */

function renderOverview(d){
  const v = d.voices||{}; const db = d.db||{}; const pers = d.personality||{};
  const emo = (d.emotion&&d.emotion.dominant)||null;
  $('cards').innerHTML = [
    card('Тиков', fmtInt(db.ticks), d.uptimeSec!=null?('uptime '+fmtDur(d.uptimeSec)):''),
    card('Действий', fmtInt(db.actions), 'молчание: '+fmtInt(db.silence&&db.silence.total)),
    card('Успешность', fmtPct(db.successRate), (d.summary&&d.summary.failedActionTypes)?('ошибок: '+fmtInt(d.summary.failedActionTypes)):''),
    card('Каналов', fmtInt(d.summary&&d.summary.channels), 'активных: '+fmtInt(d.summary&&d.summary.activeChannels)),
    card('Контактов', fmtInt(d.summary&&d.summary.contacts), (d.summary&&d.summary.botContacts)?('ботов: '+fmtInt(d.summary.botContacts)):''),
    card('Фактов', fmtInt(d.summary&&d.summary.facts), 'потоков: '+fmtInt(d.graph&&d.graph.threads)),
    card('Тем', fmtInt(d.summary&&d.summary.openTopics), 'напоминаний: '+fmtInt(d.summary&&d.summary.reminders)),
    card('API', fmtN(d.pressure&&d.pressure.api), 'arousal: '+fmtN(d.pressure&&d.pressure.arousalDrive)),
    card('Энтропия голосов', v.normalizedEntropy!=null?v.normalizedEntropy.toFixed(2):'—', v.consecutiveRepeatRate!=null?('повторы '+fmtPct(v.consecutiveRepeatRate)):''),
    card('Здоровье π', pers.health??'—', pers.driftMagnitude!=null?('drift '+fmtN(pers.driftMagnitude,4)):''),
    card('Настроение', fmtN(d.self&&d.self.mood), 'valence '+fmtN(d.self&&d.self.valence)),
    card('Эмоция', emo?esc(emo.kind):'нейтр.', emo?('инт. '+fmtN(emo.intensity)):''),
  ].join('');

  // headline: активность
  const ab = db.activityBuckets||[];
  if(ab.length) upsert('ovActivityChart','line',{labels:ab.map(x=>'t'+Math.round(x.bucket)),datasets:[
      {label:'всего', data:ab.map(x=>x.total), borderColor:palette[0], backgroundColor:palette[0], tension:.3, pointRadius:0, borderWidth:2},
      {label:'успешные', data:ab.map(x=>x.ok), borderColor:palette[1], backgroundColor:palette[1], tension:.3, pointRadius:0, borderWidth:2},
    ]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{beginAtZero:true,ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:10}}}});

  // headline: голоса
  const vf = v.voiceFrequencies||{}; const vl=Object.keys(vf);
  if(vl.length) upsert('ovVoiceChart','doughnut',{labels:vl,datasets:[{data:vl.map(k=>vf[k]),backgroundColor:palette}]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}}});

  // личность мини-бар
  if(pers.weights&&pers.labels){
    const ds=[{label:'текущий',data:pers.weights,backgroundColor:palette[0]}];
    if(pers.home&&pers.home.length===pers.weights.length) ds.push({label:'base',data:pers.home,backgroundColor:'#30363d'});
    upsert('ovPersChart','bar',{labels:pers.labels.map(l=>l.short),datasets:ds},{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,max:0.5,ticks:ax},x:{ticks:ax}}});
  }

  // давление сводка
  const pr=d.pressure;
  if(pr){
    const dims=[['P1',pr.P1],['P2',pr.P2],['P3',pr.P3],['P4',pr.P4],['P5',pr.P5],['P6',pr.P6],['prosp',pr.prospect]];
    const mx=Math.max(0.001,...dims.map(x=>Number(x[1])||0));
    $('ovPressure').innerHTML='<div class="kv">'+dims.map(x=>{const val=Number(x[1])||0;const w=Math.min(100,val/mx*100);return '<div class="item"><div class="k">'+x[0]+'</div><div class="v">'+fmtN(val)+'</div><div class="bar"><i style="width:'+w+'%"></i></div></div>';}).join('')+'</div>';
  } else $('ovPressure').innerHTML='<div class="empty">нет данных</div>';

  // состояние / эмоция сводка
  const s=d.self||{};
  const rows=[['Режим',s.mode??'—'],['Valence',fmtN(s.valence)],['Arousal',fmtN(s.arousal)],['Эмоция',emo?esc(emo.kind):'нейтр.']];
  $('ovState').innerHTML='<div class="kv">'+rows.map(x=>'<div class="item"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div></div>').join('')+'</div>'+(emo&&emo.summary?'<div class="sub" style="margin-top:8px;color:#8b97a7">'+esc(emo.summary)+'</div>':'');
}

function renderCognition(d){
  const v = d.voices||{}; const db = d.db||{}; const pers=d.personality||{};
  // личность бар
  if(pers.weights&&pers.labels){
    const ds=[{label:'текущий',data:pers.weights,backgroundColor:palette[0]}];
    if(pers.home&&pers.home.length===pers.weights.length) ds.push({label:'базовый (home)',data:pers.home,backgroundColor:'#30363d'});
    upsert('persChart','bar',{labels:pers.labels.map(l=>l.display),datasets:ds},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{beginAtZero:true,max:0.5,ticks:ax},x:{ticks:ax}}});
  }
  // дрейф траектория
  if(pers.trajectory&&pers.trajectory.length&&pers.labels){
    const labels=pers.trajectory.map(p=>'t'+p.tick);
    const ds=pers.labels.map((l,i)=>({label:l.short,data:pers.trajectory.map(p=>p.w[i]),borderColor:palette[i],backgroundColor:palette[i],tension:.3,pointRadius:0,borderWidth:2}));
    upsert('driftChart','line',{labels,datasets:ds},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:8}}}});
  }
  // метрики личности
  const pm=[];
  pm.push(['Здоровье', pers.health??'—', '']);
  pm.push(['Drift', pers.driftMagnitude!=null?fmtN(pers.driftMagnitude,5):'—', '']);
  pm.push(['Velocity', pers.velocity!=null?Number(pers.velocity).toExponential(2):'—', '']);
  pm.push(['Снимков π', fmtInt(pers.snapshotCount), '']);
  if(pers.perDimDrift&&pers.labels){
    pers.labels.forEach((l,i)=>{ const dv=pers.perDimDrift[i]; pm.push(['Δ '+l.short, (dv>0?'+':'')+fmtN(dv,4), dv>0?'pos':(dv<0?'neg':'')]); });
  }
  $('persMeta').innerHTML='<div class="kv">'+pm.map(x=>'<div class="item"><div class="k">'+x[0]+'</div><div class="v '+x[2]+'">'+x[1]+'</div></div>').join('')+'</div>';

  // давление поле
  const pr=d.pressure;
  if(pr){
    const dims=[['P1','attention',pr.P1],['P2','information',pr.P2],['P3','relationship',pr.P3],['P4','threads',pr.P4],['P5','obligation',pr.P5],['P6','curiosity',pr.P6],['prospect','horizon',pr.prospect]];
    const mx=Math.max(0.001,...dims.map(x=>Number(x[2])||0));
    $('pressure').innerHTML='<div class="kv">'+dims.map(x=>{const val=Number(x[2])||0;const w=Math.min(100,val/mx*100);return '<div class="item"><div class="k">'+x[0]+' · '+x[1]+'</div><div class="v">'+fmtN(val)+'</div><div class="bar"><i style="width:'+w+'%"></i></div></div>';}).join('')+'</div>'+
      '<div style="margin-top:10px;color:#8b97a7;font-size:12px">API '+fmtN(pr.api)+' · API peak '+fmtN(pr.apiPeak)+' · arousal drive '+fmtN(pr.arousalDrive)+'</div>';
  } else $('pressure').innerHTML='<div class="empty">нет данных давления</div>';

  // эмоция
  if(d.emotion&&(d.emotion.dominant||d.emotion.secondary)){
    const row=(e,tag)=>e?'<div class="item"><div class="k">'+tag+': '+esc(e.kind)+'</div><div class="v">инт '+fmtN(e.intensity)+'</div><div class="sub">val '+fmtN(e.valence)+' · ar '+fmtN(e.arousal)+'</div>'+(e.summary?'<div class="sub" style="margin-top:4px">'+esc(e.summary)+'</div>':'')+'</div>':'';
    $('emotion').innerHTML='<div class="kv">'+row(d.emotion.dominant,'доминирует')+row(d.emotion.secondary,'фон')+'</div>'+(d.emotion.updatedAtMs?'<div class="sub" style="margin-top:8px;color:#8b97a7">обновлено '+fmtAgo(d.emotion.updatedAtMs)+'</div>':'');
  } else $('emotion').innerHTML='<div class="empty">нейтральное состояние</div>';

  // голоса doughnut
  const vf=v.voiceFrequencies||{}; const vl=Object.keys(vf);
  if(vl.length) upsert('voiceChart','doughnut',{labels:vl,datasets:[{data:vl.map(k=>vf[k]),backgroundColor:palette}]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}}});

  // голоса успех/неуспех
  const bvo=db.byVoiceOutcome||[];
  if(bvo.length) upsert('voiceActChart','bar',{labels:bvo.map(x=>x.voice),datasets:[
      {label:'успех',data:bvo.map(x=>x.ok),backgroundColor:palette[1]},
      {label:'неуспех',data:bvo.map(x=>x.fail),backgroundColor:palette[3]},
    ]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{x:{stacked:true,ticks:ax},y:{stacked:true,beginAtZero:true,ticks:ax}}});
  else { const bv=db.byVoice||[]; if(bv.length) upsert('voiceActChart','bar',{labels:bv.map(x=>x.voice||'?'),datasets:[{data:bv.map(x=>x.c),backgroundColor:palette[4]}]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:ax},x:{ticks:ax}}}); }

  // плоскости разнообразия
  const planes = v.planes||{};
  const pk = Object.keys(planes);
  if(pk.length){
    $('planes').innerHTML='<table><tr><th>Плоскость</th><th>Выборок</th><th>Норм. энтропия</th><th>Повторы</th><th>Топ-голос</th></tr>'+
      pk.map(k=>{ const p=planes[k]||{}; const vf2=p.voiceFrequencies||{}; let top='—',tv=-1; for(const vn in vf2){ if(vf2[vn]>tv){tv=vf2[vn];top=vn;} }
        const auth = (k===v.authorityPlane)?' <span class="tag" style="border-color:#7aa2ff;color:#7aa2ff">authority</span>':'';
        return '<tr><td>'+esc(k)+auth+'</td><td class="num">'+fmtInt(p.sampleCount)+'</td><td class="num">'+fmtN(p.normalizedEntropy)+'</td><td class="num">'+fmtPct(p.consecutiveRepeatRate)+'</td><td>'+esc(top)+(tv>=0?' ('+fmtPct(tv)+')':'')+'</td></tr>';
      }).join('')+'</table>';
  } else $('planes').innerHTML='<div class="empty">нет данных по плоскостям</div>';
}

function renderSocial(d){
  // каналы
  const ch=d.channels||[];
  $('chHint').textContent = ch.length+' всего'+((d.summary&&d.summary.unreachableChannels)?(' · '+d.summary.unreachableChannels+' недостижимо'):'');
  $('channels').innerHTML = ch.length ? '<table><tr><th>Канал</th><th>Тип</th><th>Непрочит.</th><th>Роль</th><th>Pending</th><th>Подряд исх.</th><th>Привыкание</th><th>Давление</th><th>Риск</th><th>Достижим</th></tr>'+
    ch.map(c=>'<tr><td>'+(c.unreachable?'<span class="gone">'+esc(c.name)+' (нет)</span>':esc(c.name))+'</td><td>'+esc(c.chatType||'')+'</td><td class="num">'+c.unread+'</td><td><span class="pill '+(c.role==='owner'?'owner':c.role==='admin'?'admin':'sub')+'">'+esc(c.role)+'</span></td><td class="num">'+c.pendingDirected+'</td><td class="num">'+(c.consecutiveOutgoing??0)+'</td><td class="num">'+fmtN(c.habituation)+'</td><td class="num">'+fmtN(c.pressure)+'</td><td>'+(c.risk&&c.risk!=='none'?'<span class="pill risk-'+esc(c.risk)+'">'+esc(c.risk)+'</span>':'—')+'</td><td class="num">'+(c.unreachable?'✗':fmtPct(c.reachability))+'</td></tr>').join('')+'</table>'
    : '<div class="empty">нет каналов</div>';

  // контакты — полный вектор отношений (ADR-178): 5 измерений ∈ [0,1] + velocity + фаза.
  const ct=d.contacts||[];
  $('contacts').innerHTML = ct.length ? '<table><tr><th>Контакт</th><th>Tier</th><th>Отношения</th><th>Доверие</th><th>Привяз.</th><th>Знаком.</th><th>Уважение</th><th>Влечение</th><th>Взаимод.</th><th>Давление</th><th>Активность</th></tr>'+
    ct.map(c=>{
      const rt=c.relationType||'unknown';
      const phase=(c.romanticPhase&&c.romanticPhase!=='none')?(' <span class="tag">'+esc(c.romanticPhase)+'</span>'):'';
      return '<tr><td>'+esc(c.name)+(c.isBot?' <span class="tag">bot</span>':'')+phase+'</td>'+
        '<td class="num">'+c.tier+'</td>'+
        '<td><span class="pill r-'+esc(rt)+'">'+esc(rt)+'</span></td>'+
        rvCell(c.trust,c.velTrust)+rvCell(c.affection,c.velAffection)+rvCell(c.familiarity,c.velFamiliarity)+rvCell(c.respect,c.velRespect)+rvCell(c.attraction,c.velAttraction)+
        '<td class="num">'+(c.interactions??0)+'</td><td class="num">'+fmtN(c.pressure)+'</td><td class="num">'+(c.lastSeen?fmtAgo(c.lastSeen):'—')+'</td></tr>';
    }).join('')+'</table>'
    : '<div class="empty">нет контактов</div>';

  // открытые темы (Bug #5: «Вес» — это enum trivial/minor/major/critical, рендерим меткой,
  // а не в числовой колонке; id оборачиваем в esc())
  const tp=d.topics||[];
  $('topics').innerHTML = tp.length ? '<table><tr><th>#</th><th>Тема</th><th>Статус</th><th>Важность</th><th>Давл.</th><th>Релев.</th></tr>'+
    tp.map(t=>'<tr><td>'+esc(t.id??'')+'</td><td>'+esc(t.title)+(t.involves&&t.involves.length?'<br><span class="tag">'+t.involves.map(esc).join('</span><span class="tag">')+'</span>':'')+'</td><td>'+esc(t.status)+'</td><td>'+weightTag(t.weight)+'</td><td class="num">'+fmtN(t.pressure)+'</td><td class="num">'+fmtN(t.relevance)+'</td></tr>').join('')+'</table>'
    : '<div class="empty">нет открытых тем</div>';

  // кризисные каналы
  const cc=d.crisisChannels||[];
  $('crisis').innerHTML = cc.length ? cc.map(c=>'<span class="tag" style="border-color:#f85149;color:#ff8a80">'+esc(c)+'</span>').join(' ')
    : '<div class="empty">кризисных каналов нет</div>';
}

/* Panel #6: лента действий — что Алиса реально делала + почему. Скролл-таблица из action_log. */
function renderActionFeed(d){
  const af=d.actionFeed||[];
  $('actionFeed').innerHTML = af.length
    ? '<div class="scrollbox"><table><thead><tr><th>Тик</th><th>Голос</th><th>Тип</th><th>Цель</th><th>Текст / резон</th><th>Увер.</th><th>Исход</th><th>Когда</th></tr></thead><tbody>'+
      af.map(a=>{
        const txt=a.message?('<div class="feed-text">'+esc(a.message)+'</div>'):'';
        const why=a.reasoning?('<div class="feed-text" style="opacity:.7">'+esc(a.reasoning)+'</div>'):'';
        const both=(txt||why)?(txt+why):'<span class="empty">—</span>';
        const aw=a.afterward?(' <span class="tag">'+esc(a.afterward)+'</span>'):'';
        return '<tr><td class="num">'+esc(a.tick)+'</td>'+
          '<td>'+(a.voice?'<span class="tag">'+esc(a.voice)+'</span>':'—')+'</td>'+
          '<td>'+esc(a.actionType||'—')+aw+'</td>'+
          '<td>'+esc(a.target||'—')+'</td>'+
          '<td>'+both+'</td>'+
          '<td class="num">'+(a.confidence!=null?fmtN(a.confidence):'—')+'</td>'+
          '<td>'+(a.success?'<span class="pill r-close_friend">ok</span>':'<span class="pill risk-high">fail</span>')+'</td>'+
          '<td class="num">'+(a.atMs?fmtAgo(a.atMs):'—')+'</td></tr>';
      }).join('')+'</tbody></table></div>'
    : '<div class="empty">нет записей действий</div>';
}

function renderActivity(d){
  renderActionFeed(d);
  const db=d.db||{};
  const ab=db.activityBuckets||[];
  if(ab.length) upsert('activityChart','line',{labels:ab.map(x=>'t'+Math.round(x.bucket)),datasets:[
      {label:'всего',data:ab.map(x=>x.total),borderColor:palette[0],backgroundColor:palette[0],tension:.3,pointRadius:0,borderWidth:2},
      {label:'успешные',data:ab.map(x=>x.ok),borderColor:palette[1],backgroundColor:palette[1],tension:.3,pointRadius:0,borderWidth:2},
    ]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{beginAtZero:true,ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:10}}}});

  const apis=db.apiSeries||[];
  if(apis.length) upsert('apiChart','line',{labels:apis.map(x=>'t'+x.tick),datasets:[{data:apis.map(x=>x.api),borderColor:palette[5],backgroundColor:'rgba(57,197,207,.15)',fill:true,tension:.3,pointRadius:0,borderWidth:2}]},
      {responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:10}}}});

  const bat=db.byActionType||[];
  if(bat.length) upsert('actTypeChart','bar',{labels:bat.map(x=>x.type),datasets:[{data:bat.map(x=>x.c),backgroundColor:bat.map(x=>/fail|error/.test(x.type)?palette[3]:palette[2])}]},
      {responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{y:{ticks:ax},x:{beginAtZero:true,ticks:ax}}});

  const sr=(db.silence&&db.silence.byReason)||[];
  if(sr.length) upsert('silenceChart','bar',{labels:sr.map(x=>x.reason),datasets:[{data:sr.map(x=>x.c),backgroundColor:palette[7]}]},
      {responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{y:{ticks:ax},x:{beginAtZero:true,ticks:ax}}});

  const bm=db.byMode||[];
  if(bm.length) upsert('modeChart','doughnut',{labels:bm.map(x=>x.mode),datasets:[{data:bm.map(x=>x.c),backgroundColor:palette}]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#e6edf3'}}}});

  const rec=db.recent||[];
  if(rec.length){ const cols=rec.map(r=>r.success?'#3fb950':'#f85149');
    upsert('actChart','bar',{labels:rec.map(r=>'t'+r.tick),datasets:[{data:rec.map(r=>r.success?1:0),backgroundColor:cols}]},{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(c)=>{const r=rec[c.dataIndex];return (r.voice||'?')+' · '+(r.success?'ok':'fail');}}}},scales:{y:{display:false},x:{ticks:{color:'#8b97a7',maxTicksLimit:12}}}}); }
}

function renderMemory(d){
  const g=d.graph;
  if(g){
    $('graphmem').innerHTML='<div class="kv">'+[
      ['Факты',g.facts],['Потоки',g.threads],['Диалоги',g.conversations],['Контакты',g.contacts],['Каналы',g.channels],['Узлы всего',g.totalNodes],['Рёбра',g.edges],
    ].map(x=>'<div class="item"><div class="k">'+x[0]+'</div><div class="v">'+fmtInt(x[1])+'</div></div>').join('')+'</div>';
  } else $('graphmem').innerHTML='<div class="empty">нет данных</div>';

  const ep=d.episodes||[];
  $('episodes').innerHTML = ep.length ? '<table><tr><th>ID</th><th>Цель</th><th>Исход</th><th>Residue</th></tr>'+
    ep.map(e=>'<tr><td>'+esc(e.id)+'</td><td>'+esc(e.target??'?')+'</td><td>'+esc(e.outcome??'open')+'</td><td>'+esc(e.residue??'')+'</td></tr>').join('')+'</table>'
    : '<div class="empty">нет недавних эпизодов</div>';

  const rm=d.reminders||[];
  $('reminders').innerHTML = rm.length ? '<table><tr><th>#</th><th>Тип</th><th>Действие</th><th>Цель</th><th>Когда</th><th></th></tr>'+
    rm.map(r=>'<tr><td>'+esc(r.id??'')+'</td><td>'+esc(r.type)+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.target??'')+'</td><td class="num">'+(r.targetMs?new Date(Number(r.targetMs)).toLocaleString('ru'):(r.intervalMs?('каждые '+fmtDur(Number(r.intervalMs)/1000)):'—'))+'</td><td>'+(r.id!=null?'<button class="ctlbtn sm danger" data-cancel-task="'+esc(r.id)+'">отменить</button>':'')+'</td></tr>').join('')+'</table><div class="ctlmsg" id="rmMsg"></div>'
    : '<div class="empty">нет активных напоминаний</div>';
  // Делегируем клики по кнопкам отмены задач (cancel_task).
  $('reminders').querySelectorAll('button[data-cancel-task]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const taskId=Number(b.getAttribute('data-cancel-task'));
      b.disabled=true;
      try { await ctl({action:'cancel_task', taskId}); ctlMsg('rmMsg','задача '+taskId+' отменена','ok'); setTimeout(refresh, 400); }
      catch(e){ b.disabled=false; ctlMsg('rmMsg','не вышло: '+e.message,'err'); }
    });
  });

  const s=d.self||{};
  $('state').innerHTML='<div class="kv">'+[
    ['Режим',s.mode??'—'],['Mood',fmtN(s.mood)],['Valence',fmtN(s.valence)],['Arousal',fmtN(s.arousal)],['Энергия',s.energy!=null?fmtN(s.energy):'—'],
    ['Думает о',esc(s.thinkingTarget??'—')],['Причина отдыха',esc(s.restingReason??'—')],['Отдых до',s.restingUntilMs?new Date(Number(s.restingUntilMs)).toLocaleTimeString('ru'):'—'],
  ].map(x=>'<div class="item"><div class="k">'+x[0]+'</div><div class="v">'+x[1]+'</div></div>').join('')+'</div>';
}

/* ── Worki: read-only очередь задач (in-flight + недавние). Без управления здесь. ── */
function workiStatusPill(st){
  const cls = st==='running' ? 'risk-medium' : st==='error' ? 'risk-high' : 'r-close_friend';
  const lbl = st==='running' ? 'в работе' : st==='error' ? 'ошибка' : st==='done' ? 'готово' : (st||'?');
  return '<span class="pill '+cls+'">'+esc(lbl)+'</span>';
}
function workiTable(rows){
  if(!rows.length) return null;
  return '<table><tr><th>Вид</th><th>Задача</th><th>Статус</th><th>Прогресс</th><th>Доставлено</th><th>Возраст</th><th></th></tr>'+
    rows.map(w=>'<tr>'+
      '<td><span class="tag">'+esc(w.kind)+'</span></td>'+
      '<td>'+esc(w.task)+(w.project?'<br><span class="tag">'+esc(w.project)+'</span>':'')+'</td>'+
      '<td>'+workiStatusPill(w.status)+'</td>'+
      '<td>'+(w.latestProgress?'<span style="color:#8b97a7">'+esc(w.latestProgress)+'</span>':'<span class="empty">—</span>')+'</td>'+
      '<td>'+(w.delivered?'<span class="pill r-close_friend">да</span>':'<span class="pill risk-high">нет</span>')+'</td>'+
      '<td class="num">'+(w.completedMs?fmtAgo(w.completedMs):(w.createdMs?fmtAgo(w.createdMs):'—'))+'</td>'+
      '<td>'+(w.id!=null?'<button class="ctlbtn sm danger" data-dismiss-worki="'+esc(w.id)+'">снять</button>':'')+'</td>'+
    '</tr>').join('')+'</table>';
}
/* Делегирование кликов по кнопкам «снять» задачу worki (dismiss_worki) внутри контейнера. */
function wireWorkiDismiss(containerId){
  const root=$(containerId); if(!root) return;
  root.querySelectorAll('button[data-dismiss-worki]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const id=b.getAttribute('data-dismiss-worki');
      b.disabled=true;
      try { await ctl({action:'dismiss_worki', id}); ctlMsg('workiMsg','задача снята','ok'); setTimeout(refresh, 400); }
      catch(e){ b.disabled=false; ctlMsg('workiMsg','не вышло: '+e.message,'err'); }
    });
  });
}
function renderWorki(d){
  const wk = d.worki||[];
  const running = wk.filter(w=>w.status==='running');
  const recent = wk.filter(w=>w.status!=='running');
  const undel = wk.filter(w=>!w.delivered).length;
  $('workiCards').innerHTML = [
    card('Всего задач', fmtInt(wk.length), ''),
    card('В работе', fmtInt(running.length), ''),
    card('Недоставлено', fmtInt(undel), undel>0?'ждут отдачи':''),
  ].join('');
  $('workiActive').innerHTML = workiTable(running) || '<div class="empty">нет задач в работе</div>';
  $('workiRecent').innerHTML = workiTable(recent) || '<div class="empty">нет недавних задач</div>';
  wireWorkiDismiss('workiActive');
  wireWorkiDismiss('workiRecent');
}

/* Panel #8: таймлайн аномалий + аудит-события (вынесено из selfcheck в отдельную вкладку). */
function renderHealth(d){
  const an=d.anomalies||[];
  $('anomalies').innerHTML = an.length
    ? '<table><tr><th>Уровень</th><th>Тип</th><th>Сообщение</th><th>Тик</th></tr>'+
      an.map(a=>'<tr><td><span class="pill '+(a.level==='error'?'risk-high':'risk-medium')+'">'+esc(a.level)+'</span></td>'+
        '<td><span class="tag">'+esc(a.type)+'</span></td>'+
        '<td class="lvl-'+esc(a.level)+'">'+esc(a.message)+'</td>'+
        '<td class="num">'+esc(a.tick)+'</td></tr>').join('')+'</table>'
    : '<div class="empty">аномалий не обнаружено</div>';

  const au=d.auditFeed||[];
  $('auditFeed').innerHTML = au.length
    ? '<div class="scrollbox"><table><thead><tr><th>Когда</th><th>Тик</th><th>Уровень</th><th>Источник</th><th>Сообщение</th></tr></thead><tbody>'+
      au.map(e=>'<tr><td class="num">'+(e.atMs?fmtAgo(e.atMs):'—')+'</td>'+
        '<td class="num">'+esc(e.tick)+'</td>'+
        '<td class="lvl-'+esc(e.level)+'">'+esc(e.level)+'</td>'+
        '<td>'+esc(e.source||'—')+'</td>'+
        '<td><div class="feed-text" style="max-width:520px">'+esc(e.message)+'</div></td></tr>').join('')+'</tbody></table></div>'
    : '<div class="empty">нет аудит-событий</div>';
}

/* Локальный self-report для on-demand selfcheck-кнопок (минует автообновляемые lastData). */
let scOverride = null;
function renderSelfcheckSections(sec){
  if(!sec || !sec.length) return '<div class="empty">нет данных self-report</div>';
  return sec.map(s=>'<div class="sc-section"><div class="sc-label">'+esc(s.label||s.dimension||'')+'</div>'+
    (Array.isArray(s.lines)&&s.lines.length ? s.lines.map(l=>'<div class="sc-line">'+esc(l)+'</div>').join('') : '<div class="sc-line" style="color:#8b97a7">—</div>')+
    '</div>').join('');
}
function renderSelfcheck(d){
  const sc = scOverride || d.selfcheck || null;
  $('selfcheck').innerHTML = renderSelfcheckSections(sc && sc.sections);
}

/* Одноразовая привязка статичных кнопок управления (self-report focus + фиды). */
let _ctlWired = false;
function wireControls(){
  if(_ctlWired) return; _ctlWired = true;
  // Кнопки selfcheck-фокуса → пересобрать on-demand и показать сразу.
  document.querySelectorAll('button[data-sc]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const focus=b.getAttribute('data-sc')||'';
      document.querySelectorAll('button[data-sc]').forEach(x=>x.disabled=true);
      try { const j=await ctl({action:'selfcheck', focus}); scOverride=j.result; renderSelfcheck(lastData||{}); ctlMsg('scMsg','обновлено'+(focus?(' · '+focus):''),'ok'); }
      catch(e){ ctlMsg('scMsg','не вышло: '+e.message,'err'); }
      finally { document.querySelectorAll('button[data-sc]').forEach(x=>x.disabled=false); }
    });
  });
  // Кнопки управления фидами (пауза/возобновление поллинга).
  document.querySelectorAll('button[data-feed]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const op=b.getAttribute('data-feed');
      document.querySelectorAll('button[data-feed]').forEach(x=>x.disabled=true);
      try { await ctl({action: op==='pause'?'feeds_pause':'feeds_resume'}); ctlMsg('feedMsg', op==='pause'?'поллинг на паузе':'поллинг возобновлён','ok'); }
      catch(e){ ctlMsg('feedMsg','не поддержано/ошибка: '+e.message,'err'); }
      finally { document.querySelectorAll('button[data-feed]').forEach(x=>x.disabled=false); }
    });
  });
}

const RENDERERS = { overview:renderOverview, cognition:renderCognition, social:renderSocial, activity:renderActivity, memory:renderMemory, worki:renderWorki, health:renderHealth, selfcheck:renderSelfcheck };
function renderTab(id, d){ try { (RENDERERS[id]||(()=>{}))(d); } catch(e){ console.error('render '+id, e); } }

async function refresh(){
  let d; try { d = await (await fetch('/dashboard/data')).json(); } catch(e){ $('meta').textContent='offline'; return; }
  lastData = d;
  renderHeader(d);
  // Рендерим только активную вкладку (графики на скрытых вкладках создались бы 0×0).
  renderTab(activeTab, d);
}

buildTabs();
wireControls();           // привязка статичных кнопок управления (self-report + фиды)
selectTab(activeTab);     // выставляет active-классы + первый рендер (после первого fetch)
refresh();
setInterval(refresh, 5000);
window.addEventListener('resize', ()=>{ for(const k in charts){ const c=charts[k]; if(c&&c.canvas&&c.canvas.offsetParent!==null){ try{ c.resize(); }catch(e){} } } });
</script>
</body>
</html>`;

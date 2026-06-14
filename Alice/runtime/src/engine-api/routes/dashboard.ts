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
import { getDb } from "../../db/connection.js";
import { actionLog, personalitySnapshots, silenceLog, tickLog } from "../../db/schema.js";
import { analyzeVoiceDiversity } from "../../diagnostics/diversity.js";
import { safeDisplayName } from "../../graph/display.js";
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
      contacts.push({
        name: safeDisplayName(G, id),
        tier: Number(c.tier ?? 0),
        relationType: c.relation_type ?? null,
        trust: c.rv_trust != null ? Number(c.rv_trust) : null,
        affection: c.rv_affection != null ? Number(c.rv_affection) : null,
        familiarity: c.rv_familiarity != null ? Number(c.rv_familiarity) : null,
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

  return {
    ts: Date.now(),
    tick,
    summary: {
      channels: channels.length,
      contacts: contacts.length,
      activeChannels: channels.filter((c) => Number(c.unread) > 0 || Number(c.pendingDirected) > 0)
        .length,
      facts: graph ? Number((graph as Record<string, unknown>).facts ?? 0) : null,
      openTopics: topics.length,
      reminders: reminders.length,
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
  };
}

/** Маршрут: /dashboard (страница) и /dashboard/data (JSON). */
export function handleDashboard(
  sub: string | undefined,
  _req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): void {
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
  header { display:flex; align-items:center; gap:14px; padding:14px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:10; }
  header h1 { font-size:18px; margin:0; font-weight:600; }
  header .dot { width:9px; height:9px; border-radius:50%; background:var(--good); box-shadow:0 0 8px var(--good); }
  header .upd { color:var(--mut); font-size:12px; margin-left:auto; }
  .wrap { padding:20px; max-width:1400px; margin:0 auto; }
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
  canvas { max-height:240px; }
  .err { color:var(--bad); font-size:12px; }
  .empty { color:var(--mut); font-size:12px; font-style:italic; }
  .kv { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:10px; }
  .kv .item { background:#0e1116; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  .kv .item .k { color:var(--mut); font-size:11px; text-transform:uppercase; }
  .kv .item .v { font-size:16px; font-weight:600; margin-top:2px; }
  .tag { display:inline-block; background:#0e1116; border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:11px; color:var(--mut); margin:2px 2px 0 0; }
  .pbar { display:flex; height:10px; border-radius:5px; overflow:hidden; background:var(--line); margin-top:6px; }
  .pbar > span { display:block; height:100%; }
</style>
</head>
<body>
<header>
  <span class="dot"></span><h1>Alice — Dashboard</h1>
  <span class="upd" id="upd">загрузка…</span>
</header>
<div class="wrap">
  <div class="cards" id="cards"></div>

  <div class="grid">
    <div class="panel"><h2>Личность <span class="hint">π = D / C / S / X</span></h2><canvas id="persChart"></canvas></div>
    <div class="panel"><h2>Дрейф личности <span class="hint">по snapshot'ам</span></h2><canvas id="driftChart"></canvas></div>
  </div>

  <div class="panel"><h2>Поле давления <span class="hint">P1–P6 + prospect</span></h2><div id="pressure"></div></div>

  <div class="grid3">
    <div class="panel"><h2>Состояние / режим</h2><div id="state"></div></div>
    <div class="panel"><h2>Эмоция <span class="hint">ADR-268</span></h2><div id="emotion"></div></div>
    <div class="panel"><h2>Память графа</h2><div id="graphmem"></div></div>
  </div>

  <div class="grid">
    <div class="panel"><h2>Голоса (распределение)</h2><canvas id="voiceChart"></canvas></div>
    <div class="panel"><h2>Режимы тиков</h2><canvas id="modeChart"></canvas></div>
  </div>

  <div class="grid">
    <div class="panel"><h2>Активность по тикам <span class="hint">действия / успешные</span></h2><canvas id="activityChart"></canvas></div>
    <div class="panel"><h2>Нагрузка API <span class="hint">последние тики</span></h2><canvas id="apiChart"></canvas></div>
  </div>

  <div class="grid">
    <div class="panel"><h2>Действия по голосам <span class="hint">успех / неуспех</span></h2><canvas id="voiceActChart"></canvas></div>
    <div class="panel"><h2>Активность — последние действия</h2><canvas id="actChart"></canvas></div>
  </div>

  <div class="grid">
    <div class="panel"><h2>Типы действий</h2><canvas id="actTypeChart"></canvas></div>
    <div class="panel"><h2>Молчание <span class="hint">по причинам</span></h2><canvas id="silenceChart"></canvas></div>
  </div>

  <div class="grid">
    <div class="panel"><h2>Открытые темы</h2><div id="topics"></div></div>
    <div class="panel"><h2>Напоминания / задачи</h2><div id="reminders"></div></div>
  </div>

  <div class="grid">
    <div class="panel"><h2>Недавние эпизоды</h2><div id="episodes"></div></div>
    <div class="panel"><h2>Кризисные каналы</h2><div id="crisis"></div></div>
  </div>

  <div class="panel"><h2>Каналы</h2><div id="channels"></div></div>
  <div class="panel"><h2>Контакты <span class="hint">по давлению / tier</span></h2><div id="contacts"></div></div>
</div>
<script>
const charts = {};
const $ = (id) => document.getElementById(id);
const palette = ['#7aa2ff','#3fb950','#d29922','#f85149','#bc8cff','#39c5cf','#ff8a80','#7ee787'];
function card(k,v,sub){ return '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'; }
function fmtPct(x){ return x==null?'—':(x*100).toFixed(0)+'%'; }
function fmtN(x,d){ return x==null?'—':Number(x).toFixed(d==null?2:d); }
function esc(s){ return String(s==null?'':s).replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m])); }
const ax = { color:'#8b97a7' };
function upsert(id, type, data, options){
  const el = $(id); if(!el) return;
  if(charts[id]){ charts[id].data = data; charts[id].update(); }
  else { charts[id] = new Chart(el, { type, data, options }); }
}

async function refresh(){
  let d; try { d = await (await fetch('/dashboard/data')).json(); } catch(e){ $('upd').textContent='offline'; return; }
  $('upd').textContent = 'обновлено ' + new Date(d.ts).toLocaleTimeString('ru') + (d.tick!=null?(' · tick '+d.tick):'');
  const v = d.voices || {}; const db = d.db || {};

  // ── Карточки ──
  const pers = d.personality || {};
  const emo = (d.emotion && d.emotion.dominant) || null;
  $('cards').innerHTML = [
    card('Тиков', db.ticks ?? '—'),
    card('Действий', db.actions ?? '—', 'молчание: '+((db.silence&&db.silence.total)??'—')),
    card('Успешность', fmtPct(db.successRate)),
    card('Каналов', d.summary?.channels ?? '—', 'активных: '+(d.summary?.activeChannels ?? '—')),
    card('Контактов', d.summary?.contacts ?? '—'),
    card('Фактов', d.summary?.facts ?? (d.graph?.facts ?? '—'), 'потоков: '+(d.graph?.threads ?? '—')),
    card('Тем', d.summary?.openTopics ?? '—', 'напоминаний: '+(d.summary?.reminders ?? '—')),
    card('API', fmtN(d.pressure?.api), 'A: '+fmtN(d.pressure?.arousalDrive)),
    card('Энтропия голосов', v.normalizedEntropy!=null ? v.normalizedEntropy.toFixed(2) : '—'),
    card('Здоровье π', pers.health ?? '—', pers.driftMagnitude!=null?('drift '+fmtN(pers.driftMagnitude,4)):''),
    card('Настроение', fmtN(d.self?.mood), d.self?.mode?('режим: '+d.self.mode):''),
    card('Эмоция', emo?emo.kind:'—', emo?('инт. '+fmtN(emo.intensity)):''),
  ].join('');

  // ── Личность: бар D/C/S/X ──
  if(pers.weights && pers.labels){
    const labels = pers.labels.map(l=>l.display);
    const cur = pers.weights;
    const home = pers.home;
    const ds = [{label:'текущий', data:cur, backgroundColor:palette[0]}];
    if(home && home.length===cur.length) ds.push({label:'базовый (home)', data:home, backgroundColor:'#30363d'});
    upsert('persChart','bar',{labels,datasets:ds},
      {plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{beginAtZero:true,max:0.5,ticks:ax},x:{ticks:ax}}});
  }

  // ── Дрейф личности: траектория каждого измерения ──
  if(pers.trajectory && pers.trajectory.length && pers.labels){
    const labels = pers.trajectory.map(p=>'t'+p.tick);
    const ds = pers.labels.map((l,i)=>({label:l.short, data:pers.trajectory.map(p=>p.w[i]), borderColor:palette[i], backgroundColor:palette[i], tension:.3, pointRadius:0, borderWidth:2}));
    upsert('driftChart','line',{labels,datasets:ds},
      {plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:8}}}});
  } else if(!pers.trajectory || !pers.trajectory.length){ $('driftChart').parentElement.querySelector('canvas').style.display='none'; }

  // ── Поле давления ──
  const pr = d.pressure;
  if(pr){
    const dims = [['P1','attention',pr.P1],['P2','information',pr.P2],['P3','relationship',pr.P3],['P4','threads',pr.P4],['P5','obligation',pr.P5],['P6','curiosity',pr.P6],['prospect','horizon',pr.prospect]];
    const mx = Math.max(0.001, ...dims.map(x=>Number(x[2])||0));
    $('pressure').innerHTML = '<div class="kv">'+dims.map(x=>{
      const val = Number(x[2])||0; const w = Math.min(100, val/mx*100);
      return '<div class="item"><div class="k">'+x[0]+' · '+x[1]+'</div><div class="v">'+fmtN(val)+'</div><div class="bar"><i style="width:'+w+'%"></i></div></div>';
    }).join('')+'</div>'+
    '<div style="margin-top:10px;color:#8b97a7;font-size:12px">API '+fmtN(pr.api)+' · API peak '+fmtN(pr.apiPeak)+' · arousal drive '+fmtN(pr.arousalDrive)+'</div>';
  } else $('pressure').innerHTML='<div class="empty">нет данных давления</div>';

  // ── Состояние / режим ──
  const s = d.self || {};
  $('state').innerHTML = '<div class="kv">'+[
    ['Режим', s.mode ?? '—'],['Valence', fmtN(s.valence)],['Arousal', fmtN(s.arousal)],
    ['Mood', fmtN(s.mood)],['Думает о', s.thinkingTarget ?? '—'],['Отдых', s.restingReason ?? '—'],
  ].map(x=>'<div class="item"><div class="k">'+x[0]+'</div><div class="v">'+esc(x[1])+'</div></div>').join('')+'</div>';

  // ── Эмоция ──
  if(d.emotion && (d.emotion.dominant||d.emotion.secondary)){
    const row = (e,tag)=> e? '<div class="item"><div class="k">'+tag+': '+esc(e.kind)+'</div><div class="v">инт '+fmtN(e.intensity)+'</div><div class="sub">val '+fmtN(e.valence)+' · ar '+fmtN(e.arousal)+'</div>'+(e.summary?'<div class="sub" style="margin-top:4px">'+esc(e.summary)+'</div>':'')+'</div>' : '';
    $('emotion').innerHTML = '<div class="kv">'+row(d.emotion.dominant,'доминирует')+row(d.emotion.secondary,'фон')+'</div>';
  } else $('emotion').innerHTML='<div class="empty">нейтральное состояние</div>';

  // ── Память графа ──
  const g = d.graph;
  if(g){
    $('graphmem').innerHTML = '<div class="kv">'+[
      ['Факты', g.facts],['Потоки', g.threads],['Диалоги', g.conversations],
      ['Узлы', g.totalNodes],['Рёбра', g.edges],
    ].map(x=>'<div class="item"><div class="k">'+x[0]+'</div><div class="v">'+(x[1]??'—')+'</div></div>').join('')+'</div>';
  } else $('graphmem').innerHTML='<div class="empty">нет данных</div>';

  // ── Голоса ──
  const vf = (v.voiceFrequencies)||{}; const vlabels=Object.keys(vf); const vdata=vlabels.map(k=>vf[k]);
  if(vlabels.length) upsert('voiceChart','doughnut',{labels:vlabels,datasets:[{data:vdata,backgroundColor:palette}]},{plugins:{legend:{labels:{color:'#e6edf3'}}}});

  // ── Режимы тиков ──
  const bm = db.byMode||[];
  if(bm.length) upsert('modeChart','doughnut',{labels:bm.map(x=>x.mode),datasets:[{data:bm.map(x=>x.c),backgroundColor:palette}]},{plugins:{legend:{labels:{color:'#e6edf3'}}}});

  // ── Активность по бакетам тиков ──
  const ab = db.activityBuckets||[];
  if(ab.length) upsert('activityChart','line',{labels:ab.map(x=>'t'+x.bucket),datasets:[
      {label:'всего', data:ab.map(x=>x.total), borderColor:palette[0], backgroundColor:palette[0], tension:.3, pointRadius:0, borderWidth:2},
      {label:'успешные', data:ab.map(x=>x.ok), borderColor:palette[1], backgroundColor:palette[1], tension:.3, pointRadius:0, borderWidth:2},
    ]},{plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{y:{beginAtZero:true,ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:10}}}});

  // ── API серия ──
  const apis = db.apiSeries||[];
  if(apis.length) upsert('apiChart','line',{labels:apis.map(x=>'t'+x.tick),datasets:[{data:apis.map(x=>x.api), borderColor:palette[5], backgroundColor:'rgba(57,197,207,.15)', fill:true, tension:.3, pointRadius:0, borderWidth:2}]},
      {plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:ax},x:{ticks:{color:'#8b97a7',maxTicksLimit:10}}}});

  // ── Действия по голосам (стек успех/неуспех) ──
  const bvo = db.byVoiceOutcome||[];
  if(bvo.length) upsert('voiceActChart','bar',{labels:bvo.map(x=>x.voice),datasets:[
      {label:'успех', data:bvo.map(x=>x.ok), backgroundColor:palette[1]},
      {label:'неуспех', data:bvo.map(x=>x.fail), backgroundColor:palette[3]},
    ]},{plugins:{legend:{labels:{color:'#e6edf3'}}},scales:{x:{stacked:true,ticks:ax},y:{stacked:true,beginAtZero:true,ticks:ax}}});
  else { const bv=db.byVoice||[]; if(bv.length) upsert('voiceActChart','bar',{labels:bv.map(x=>x.voice||'?'),datasets:[{data:bv.map(x=>x.c),backgroundColor:palette[4]}]},{plugins:{legend:{display:false}},scales:{y:{ticks:ax},x:{ticks:ax}}}); }

  // ── Последние действия (успех/неуспех по тикам) ──
  const rec=db.recent||[]; if(rec.length){ const cols=rec.map(r=>r.success?'#3fb950':'#f85149');
    upsert('actChart','bar',{labels:rec.map(r=>'t'+r.tick),datasets:[{data:rec.map(r=>r.success?1:0),backgroundColor:cols}]},{plugins:{legend:{display:false}},scales:{y:{display:false},x:{ticks:{color:'#8b97a7',maxTicksLimit:12}}}}); }

  // ── Типы действий ──
  const bat = db.byActionType||[];
  if(bat.length) upsert('actTypeChart','bar',{labels:bat.map(x=>x.type),datasets:[{data:bat.map(x=>x.c),backgroundColor:palette[2]}]},
      {indexAxis:'y',plugins:{legend:{display:false}},scales:{y:{ticks:ax},x:{beginAtZero:true,ticks:ax}}});

  // ── Молчание по причинам ──
  const sr = (db.silence&&db.silence.byReason)||[];
  if(sr.length) upsert('silenceChart','bar',{labels:sr.map(x=>x.reason),datasets:[{data:sr.map(x=>x.c),backgroundColor:palette[7]}]},
      {indexAxis:'y',plugins:{legend:{display:false}},scales:{y:{ticks:ax},x:{beginAtZero:true,ticks:ax}}});
  else $('silenceChart').style.display='none';

  // ── Открытые темы ──
  const tp = d.topics||[];
  $('topics').innerHTML = tp.length ? '<table><tr><th>#</th><th>Тема</th><th>Статус</th><th>Вес</th><th>Давл.</th></tr>'+
    tp.map(t=>'<tr><td>'+(t.id??'')+'</td><td>'+esc(t.title)+(t.involves&&t.involves.length?'<br><span class="tag">'+t.involves.map(esc).join('</span><span class="tag">')+'</span>':'')+'</td><td>'+esc(t.status)+'</td><td>'+esc(t.weight)+'</td><td class="num">'+fmtN(t.pressure)+'</td></tr>').join('')+'</table>'
    : '<div class="empty">нет открытых тем</div>';

  // ── Напоминания ──
  const rm = d.reminders||[];
  $('reminders').innerHTML = rm.length ? '<table><tr><th>#</th><th>Тип</th><th>Действие</th><th>Цель</th></tr>'+
    rm.map(r=>'<tr><td>'+(r.id??'')+'</td><td>'+esc(r.type)+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.target??'')+'</td></tr>').join('')+'</table>'
    : '<div class="empty">нет активных напоминаний</div>';

  // ── Эпизоды ──
  const ep = d.episodes||[];
  $('episodes').innerHTML = ep.length ? '<table><tr><th>ID</th><th>Цель</th><th>Исход</th><th>Residue</th></tr>'+
    ep.map(e=>'<tr><td>'+esc(e.id)+'</td><td>'+esc(e.target??'?')+'</td><td>'+esc(e.outcome??'open')+'</td><td>'+esc(e.residue??'')+'</td></tr>').join('')+'</table>'
    : '<div class="empty">нет недавних эпизодов</div>';

  // ── Кризисные каналы ──
  const cc = d.crisisChannels||[];
  $('crisis').innerHTML = cc.length ? cc.map(c=>'<span class="tag" style="border-color:#f85149;color:#ff8a80">'+esc(c)+'</span>').join(' ')
    : '<div class="empty">кризисных каналов нет</div>';

  // ── Каналы ──
  const ch=d.channels||[];
  $('channels').innerHTML = '<table><tr><th>Канал</th><th>Тип</th><th>Непрочит.</th><th>Роль</th><th>Pending</th><th>Давление</th><th>Риск</th><th>Достижим</th></tr>'+
    ch.map(c=>'<tr><td>'+(c.unreachable?'<span class="gone">'+esc(c.name)+' (нет)</span>':esc(c.name))+'</td><td>'+esc(c.chatType||'')+'</td><td class="num">'+c.unread+'</td><td><span class="pill '+(c.role==='owner'?'owner':c.role==='admin'?'admin':'sub')+'">'+esc(c.role)+'</span></td><td class="num">'+c.pendingDirected+'</td><td class="num">'+fmtN(c.pressure)+'</td><td>'+(c.risk&&c.risk!=='none'?'<span class="pill risk-'+esc(c.risk)+'">'+esc(c.risk)+'</span>':'—')+'</td><td class="num">'+(c.unreachable?'✗':fmtPct(c.reachability))+'</td></tr>').join('')+'</table>';

  // ── Контакты ──
  const ct=d.contacts||[];
  $('contacts').innerHTML = '<table><tr><th>Контакт</th><th>Tier</th><th>Отношения</th><th>Доверие</th><th>Взаимод.</th><th>Давление</th></tr>'+
    ct.map(c=>{
      const rt = c.relationType||'unknown';
      const trust = c.trust;
      const tw = trust!=null?Math.max(0,Math.min(100,((trust+1)/2)*100)):0;
      return '<tr><td>'+esc(c.name)+(c.isBot?' <span class="tag">bot</span>':'')+'</td><td class="num">'+c.tier+'</td><td><span class="pill r-'+esc(rt)+'">'+esc(rt)+'</span></td><td><div class="mini">'+(trust!=null?'<div class="bar"><i style="width:'+tw+'%"></i></div><span>'+fmtN(trust)+'</span>':'—')+'</div></td><td class="num">'+(c.interactions??0)+'</td><td class="num">'+fmtN(c.pressure)+'</td></tr>';
    }).join('')+'</table>';
}
refresh(); setInterval(refresh, 5000);
</script>
</body>
</html>`;

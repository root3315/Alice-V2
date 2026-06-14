/**
 * Health-Watch Mod — проактивный инцидент-алёрт.
 *
 * Раз в ~3 мин гоняет runAnomalyCheck. На НОВУЮ аномалию уровня "error" (реальная проблема:
 * api_overflow, высокий процент провала действий, нарушение инварианта графа — noisy warn'ы
 * НЕ берём) ставит направленное давление на ЛИЧКУ владельца и подкидывает себе в контекст
 * заметку — чтобы Алиса САМА, своим голосом, сказала владельцу в личке. Никакого хардкод-send:
 * её когниция + сдержанность решают; в других чатах об этом молчит. Дедуп по типу + кулдаун 2ч
 * → без спама.
 *
 * Личность не трогаем: это лишь НОВЫЙ повод заметить (контекст в её pipeline, как scheduler/worki),
 * а не новая «уста». Аномалии и так детектились (db/anomaly), но были видны только по ручному
 * selfcheck — теперь у них есть «голос».
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { header } from "../core/types.js";
import type { ContributionItem } from "../core/types.js";
import { type AnomalyAlert, runAnomalyCheck } from "../db/anomaly.js";
import type { WorldModel } from "../graph/world-model.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("health-watch");

/** Как часто гонять проверку аномалий (мс) — не каждый тик, чтобы не долбить БД. */
const CHECK_THROTTLE_MS = 3 * 60_000;
/** Кулдаун на ПОВТОРНЫЙ алёрт того же типа аномалии (мс) — против спама. */
export const ALERT_COOLDOWN_MS = 2 * 60 * 60_000; // 2ч
/** Сколько держим заметку «на виду» в её контексте, пока она не скажет (мс). */
const PENDING_TTL_MS = 15 * 60_000;

export interface PendingAlert {
  type: string;
  message: string;
  ts: number;
  /** Направленное давление в личку владельца уже поднято. */
  directed: boolean;
}

interface HealthWatchState {
  /** Тип аномалии → когда в последний раз алёртили (кулдаун). */
  alerted: Record<string, number>;
  /** Заметки, ждущие, пока Алиса о них скажет (TTL-окно). */
  pending: PendingAlert[];
  /** Когда последний раз гоняли проверку (троттл). */
  lastCheckMs: number;
}

/** Канал лички владельца — ставится из index.ts (где есть config). null → мод спит. */
let _ownerDm: string | null = null;

/** Задать личку владельца как адресата инцидент-алёртов (вызывается из index.ts при старте). */
export function setHealthWatchTarget(ownerDmGraphId: string): void {
  _ownerDm = ownerDmGraphId || null;
  log.info("health-watch target set", { ownerDm: _ownerDm });
}

/**
 * Брать ли эту аномалию в алёрт: только error-уровень, не в пределах кулдауна по типу,
 * и не дублируя уже ожидающую. ЧИСТАЯ (тестируемая) функция.
 */
export function shouldAlert(
  alert: AnomalyAlert,
  alerted: Record<string, number>,
  pending: PendingAlert[],
  now: number,
): boolean {
  if (alert.level !== "error") return false; // warn'ы (api_stagnant/pressure_dead/...) — noisy, пропускаем
  if (now - (alerted[alert.type] ?? 0) < ALERT_COOLDOWN_MS) return false; // кулдаун по типу
  if (pending.some((p) => p.type === alert.type)) return false; // уже ждёт
  return true;
}

/** Поднять направленное давление на личку владельца (как ensureDirected в worki). true = канал есть. */
function bumpDirected(graph: WorldModel, target: string): boolean {
  try {
    if (graph.has(target)) {
      const cur = Number(
        (graph.getChannel(target) as { pending_directed?: number }).pending_directed ?? 0,
      );
      if (cur <= 0) {
        graph.updateChannel(target, { pending_directed: 1, last_directed_ms: Date.now() });
      }
      return true;
    }
  } catch (err) {
    log.warn("directed bump failed", { target, err: (err as Error).message });
  }
  return false; // канала ещё нет в графе → повторим на следующем onTickEnd
}

export const healthWatchMod = createMod<HealthWatchState>("health_watch", {
  category: "mechanic",
  description:
    "Проактивный инцидент-алёрт: замечает свои сбои (error-аномалии) и просит себя сказать о них владельцу в личку",
  topics: ["health"],
  initialState: { alerted: {}, pending: [], lastCheckMs: 0 },
})
  // contribute — ЧИСТЫЙ: только читает pending и отдаёт заметку (если давление в личку поднято).
  .contribute((ctx): ContributionItem[] => {
    if (!_ownerDm) return [];
    const ready = ctx.state.pending.filter((a) => a.directed);
    if (ready.length === 0) return [];
    const lines = ready.map((a) => `— ${a.message}`).join("\n");
    const raw = [
      "## Заметила у себя неполадку (только для лички владельца)",
      "",
      "Системка зацепила у меня сбой:",
      lines,
      "",
      "Если ты СЕЙЧАС в личке владельца — скажи ему об этом своими словами, по-человечески и " +
        "коротко (не лог, а как подруга-инженер: «слушай, у меня вот что подглючило…»). " +
        "В любом ДРУГОМ чате — молчи об этом, это не для посторонних.",
    ].join("\n");
    return [header(PromptBuilder.fromRaw(raw), 86)];
  })
  // Жизненный цикл (мутации) — проверка аномалий (троттл), направленное давление, TTL.
  .onTickEnd((ctx) => {
    if (!_ownerDm) return;
    const now = ctx.nowMs;

    // 1. Проверка аномалий — троттл, не каждый тик.
    if (now - ctx.state.lastCheckMs > CHECK_THROTTLE_MS) {
      ctx.state.lastCheckMs = now;
      let alerts: AnomalyAlert[] = [];
      try {
        alerts = runAnomalyCheck(ctx.tick, ctx.graph);
      } catch (err) {
        log.warn("runAnomalyCheck failed", { err: (err as Error).message });
      }
      for (const a of alerts) {
        if (!shouldAlert(a, ctx.state.alerted, ctx.state.pending, now)) continue;
        ctx.state.alerted[a.type] = now;
        ctx.state.pending.push({ type: a.type, message: a.message, ts: now, directed: false });
        log.info("health-watch: новая аномалия → алёрт владельцу", { type: a.type });
      }
    }

    // 2. Направленное давление в личку владельца + TTL-чистка (каждый тик, дёшево).
    ctx.state.pending = ctx.state.pending.filter((a) => now - a.ts < PENDING_TTL_MS);
    for (const a of ctx.state.pending) {
      if (!a.directed) a.directed = bumpDirected(ctx.graph, _ownerDm);
    }
  })
  .build();

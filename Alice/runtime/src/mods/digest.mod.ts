/**
 * Digest Mod — один раз в сутки самосочинённая сводка дня в ЛИЧКУ владельца.
 *
 * Раз в ~24ч (по wall-clock) собирает ЛЁГКУЮ сводку дня: счётчики задач worki (через
 * getWorkiSnapshot — сколько прогнала, сколько готово/с ошибкой/в работе), и — если дёшево —
 * есть ли сейчас незакрытые error-аномалии (runAnomalyCheck). Дальше НЕ шлёт робо-отчёт:
 * подкидывает себе в КОНТЕКСТ короткий блок фактов + направленное давление на личку владельца,
 * чтобы Алиса САМА, своим голосом, по-человечески рассказала владельцу, как прошёл день
 * (как подруга: «слушай, за день вот что было…»), либо промолчала, если рассказывать нечего.
 *
 * Личность не трогаем — это ЛИШЬ новый повод заметить (аддитивный контекст в её pipeline,
 * как scheduler/worki/health-watch), а не новые «уста» и не хардкод-send. Её когниция +
 * сдержанность решают: фразировку, стоит ли вообще писать, и молчат в любом ДРУГОМ чате.
 * Консервативно: одна сводка в сутки, тихо если день пустой, дедуп/троттл — как у health-watch.
 */
import { createMod } from "../core/mod-builder.js";
import { PromptBuilder } from "../core/prompt-style.js";
import { header } from "../core/types.js";
import type { ContributionItem } from "../core/types.js";
import { type AnomalyAlert, runAnomalyCheck } from "../db/anomaly.js";
import type { WorldModel } from "../graph/world-model.js";
import { getWorkiSnapshot } from "./worki.mod.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("digest");

/** Интервал между сводками (мс) — раз в сутки. */
export const DIGEST_INTERVAL_MS = 24 * 60 * 60_000;
/** Сколько держим готовую сводку «на виду» в её контексте, пока она не расскажет (мс). */
const PENDING_TTL_MS = 60 * 60_000; // 1ч — день не горит, но и не висит вечно
/** Первую сводку не делаем сразу после старта — даём дню накопиться (мс). */
const WARMUP_MS = 30 * 60_000;

/** Готовая (но ещё не рассказанная) дневная сводка. */
export interface PendingDigest {
  /** Готовые человекочитаемые строки-факты для её контекста. */
  facts: string[];
  /** Когда собрана (мс) — для TTL. */
  ts: number;
  /** Направленное давление в личку владельца уже поднято. */
  directed: boolean;
}

interface DigestState {
  /** Когда в последний раз собирали сводку (мс) — кадэнс ~24ч. */
  lastDigestMs: number;
  /** Готовая сводка, ждущая, пока Алиса о ней расскажет (TTL-окно). null = нечего рассказывать. */
  pending: PendingDigest | null;
}

/** Канал лички владельца — ставится из index.ts (где есть config). null → мод спит. */
let _ownerDm: string | null = null;

/** Задать личку владельца как адресата дневной сводки (вызывается из index.ts при старте). */
export function setDigestTarget(ownerDmGraphId: string): void {
  _ownerDm = ownerDmGraphId || null;
  log.info("digest target set", { ownerDm: _ownerDm });
}

/**
 * Собрать ЛЁГКУЮ сводку дня в человекочитаемые факты. Только дешёвые сигналы; пустой массив =
 * «день пустой, рассказывать нечего» → молчим. ЧИСТАЯ (тестируемая) функция: входы явные.
 */
export function collectDigestFacts(
  workiTasks: ReturnType<typeof getWorkiSnapshot>,
  anomalies: AnomalyAlert[],
): string[] {
  const facts: string[] = [];

  // Счётчики worki за день (дёшево, из in-memory снимка очереди).
  if (workiTasks.length > 0) {
    const done = workiTasks.filter((t) => t.status === "done").length;
    const errored = workiTasks.filter((t) => t.status === "error").length;
    const running = workiTasks.filter((t) => t.status === "running").length;
    const parts: string[] = [];
    if (done > 0) parts.push(`${done} довела до результата`);
    if (errored > 0) parts.push(`${errored} с ошибкой/не вышло`);
    if (running > 0) parts.push(`${running} ещё в работе`);
    if (parts.length > 0) {
      facts.push(`По коду Worki за день: всего ${workiTasks.length} задач — ${parts.join(", ")}.`);
    }
  }

  // Незакрытые error-аномалии (реальные проблемы; warn'ы — noisy, пропускаем как в health-watch).
  const errs = anomalies.filter((a) => a.level === "error");
  if (errs.length > 0) {
    const uniq = [...new Set(errs.map((a) => a.type))];
    facts.push(
      `У меня сейчас есть незакрытая неполадка (${uniq.join(", ")}) — если ещё не сказала, упомяни.`,
    );
  }

  return facts;
}

/** Поднять направленное давление на личку владельца (как bumpDirected в health-watch). true = канал есть. */
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

export const digestMod = createMod<DigestState>("digest", {
  category: "mechanic",
  description:
    "Раз в сутки самосочинённая сводка дня в личку владельца — собирает лёгкие факты и просит себя рассказать их своим голосом",
  topics: ["digest"],
  // lastDigestMs=0 → первая сводка станет due после WARMUP (см. onTickEnd), не сразу на старте.
  initialState: { lastDigestMs: 0, pending: null },
})
  // contribute — ЧИСТЫЙ: только читает pending и отдаёт факты (если давление в личку поднято).
  .contribute((ctx): ContributionItem[] => {
    if (!_ownerDm) return [];
    const p = ctx.state.pending;
    if (!p || !p.directed || p.facts.length === 0) return [];
    const lines = p.facts.map((f) => `— ${f}`).join("\n");
    const raw = [
      "## Как прошёл день (только для лички владельца)",
      "",
      "Если ты СЕЙЧАС в личке владельца и момент уместный — расскажи ему своими словами, " +
        "по-человечески и коротко, как прошёл твой день (не отчёт и не лог, а как подруга: " +
        "«слушай, за день вот что было…»). Опереться можешь вот на это:",
      lines,
      "",
      "Это не обязаловка: если рассказывать особо нечего или сейчас не к месту — просто промолчи. " +
        "В любом ДРУГОМ чате об этом молчи, это личное между вами.",
    ].join("\n");
    return [header(PromptBuilder.fromRaw(raw), 84)];
  })
  // Жизненный цикл (мутации) — кадэнс ~24ч, сбор фактов, направленное давление, TTL.
  .onTickEnd((ctx) => {
    if (!_ownerDm) return;
    const now = ctx.nowMs;

    // 1. Кадэнс: пора ли собирать новую сводку? (24ч от прошлой; первый раз — после warmup).
    const baseline = ctx.state.lastDigestMs > 0 ? ctx.state.lastDigestMs : now - DIGEST_INTERVAL_MS + WARMUP_MS;
    const due = now - baseline >= DIGEST_INTERVAL_MS;
    if (due && !ctx.state.pending) {
      ctx.state.lastDigestMs = now; // отметить ВНЕ зависимости от наполненности — следующая ровно через сутки

      let anomalies: AnomalyAlert[] = [];
      try {
        anomalies = runAnomalyCheck(ctx.tick, ctx.graph);
      } catch (err) {
        log.warn("runAnomalyCheck failed (digest)", { err: (err as Error).message });
      }
      let workiTasks: ReturnType<typeof getWorkiSnapshot> = [];
      try {
        workiTasks = getWorkiSnapshot();
      } catch (err) {
        log.warn("getWorkiSnapshot failed (digest)", { err: (err as Error).message });
      }

      const facts = collectDigestFacts(workiTasks, anomalies);
      if (facts.length > 0) {
        ctx.state.pending = { facts, ts: now, directed: false };
        log.info("digest: дневная сводка собрана → расскажу владельцу", { factCount: facts.length });
      } else {
        // День пустой — тихо. Кадэнс уже сдвинут (lastDigestMs=now), повторим через сутки.
        log.info("digest: день пустой — молчу");
      }
    }

    // 2. Направленное давление в личку владельца + TTL-чистка (каждый тик, дёшево).
    if (ctx.state.pending) {
      if (now - ctx.state.pending.ts >= PENDING_TTL_MS) {
        ctx.state.pending = null; // не успела/не к месту — не висит, появится новая через сутки
      } else if (!ctx.state.pending.directed) {
        ctx.state.pending.directed = bumpDirected(ctx.graph, _ownerDm);
      }
    }
  })
  .build();

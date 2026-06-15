/**
 * Channel Explorer — async-воркер автономного read-only обучения по каналам + ручной Wiki-скан.
 *
 * Это «руки» exploration.mod: у mod'а нет Telegram-клиента (как у всех mod'ов), поэтому тяжёлую
 * async-работу делает этот воркер, внедряемый в mod из index.ts через setExplorationWorker().
 *
 * АВТО-ИССЛЕДОВАНИЕ (по сильнейшей теме её людей):
 *   searchPublic(topic) → для каждого кандидата ПРОВЕРКА chatType === "channel" (ЖЁСТКИЙ guard,
 *   НИКОГДА группы/супергруппы — там Алиса могла бы постить → риск) + не состоит уже + дневной кап
 *   → join ОДНОГО (broadcast-канал → подписчик физически НЕ может постить → read-only by design)
 *   → read recent → KB-ingest заметного (ingestChannelKb) → markRead → вернуть имя канала.
 *
 * РУЧНОЙ WIKI-ПУТЬ (та же воронка ингеста): владелец создаёт канал «Worki Wiki», добавляет Алису
 *   → периодический scanWikiChannels() находит channel-узлы с непрочитанным, читает и ингестит в
 *   ТУ ЖЕ KB. Никаких изменений в pipeline событий/восприятия — самодостаточно и аддитивно.
 *
 * @see mods/exploration.mod.ts — решение/троттл/кап/owner-DM (синхронная часть)
 * @see mods/exploration.mod.ts ingestChannelKb — общая воронка KB-ингеста
 */
import type { TelegramClient } from "@mtcute/node";
import { telegramChannelId } from "../graph/constants.js";
import { safeDisplayName } from "../graph/display.js";
import type { WorldModel } from "../graph/world-model.js";
import type { ExplorationWorker, ExploreRequest } from "../mods/exploration.mod.js";
import { ingestChannelKb } from "../mods/exploration.mod.js";
import { createLogger } from "../utils/logger.js";
import { getExplorationGuard } from "./actions/shared.js";
import { getHistory, joinChat, markRead, searchPublicChats } from "./actions.js";

const log = createLogger("explorer");

/** Сколько кандидатов из поиска максимум проверяем (дёшево, но не бесконечно). */
const MAX_CANDIDATES = 8;
/** Сколько последних сообщений канала читаем для ингеста. */
const READ_LIMIT = 15;
/** Сколько заметных сообщений максимум кладём в KB за одно чтение (анти-KB-спам). */
const MAX_INGEST_PER_READ = 2;
/** Минимальная длина «заметного» сообщения — короткие реакции/ссылки-однострочки пропускаем. */
const MIN_NOTABLE_LEN = 60;

/**
 * ЖЁСТКАЯ проверка: это именно broadcast-КАНАЛ? Единственная точка истины для channels-only.
 * Telegram chatType: "channel" = broadcast (read-only для подписчика). "supergroup"/"group" — НЕТ.
 */
function isBroadcastChannel(chatType: string | undefined): boolean {
  return chatType === "channel";
}

/** Выбирает «заметные» строки из истории канала для KB (длинные, информативные). */
function selectNotable(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts) {
    const clean = (t ?? "").trim();
    if (clean.length < MIN_NOTABLE_LEN) continue;
    const key = clean.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_INGEST_PER_READ) break;
  }
  return out;
}

/**
 * Читает последние сообщения канала и ингестит заметное в KB (общая воронка). Возвращает,
 * сколько новых фактов записано. Помечает канал прочитанным. Используется И авто-исследованием,
 * И ручным Wiki-сканом.
 */
async function readAndIngest(
  client: TelegramClient,
  graph: WorldModel,
  rawChatId: string | number,
  channelGraphId: string,
  topic: string | undefined,
): Promise<number> {
  let ingested = 0;
  try {
    const history = await getHistory(client, rawChatId, READ_LIMIT);
    const texts = history.map((m) => m.text ?? "").filter((s) => s.length > 0);
    for (const note of selectNotable(texts)) {
      if (ingestChannelKb(graph, note, { topic, sourceChannel: channelGraphId })) ingested++;
    }
    await markRead(client, rawChatId);
  } catch (err) {
    log.warn("readAndIngest failed", { channelGraphId, err: (err as Error).message });
  }
  return ingested;
}

/**
 * Создаёт async-воркер исследования для внедрения в exploration.mod (setExplorationWorker).
 * Замыкает client + graph (как setWorkiStatusSender). Возвращает имя сджойненного канала или null
 * (нет подходящего channel-кандидата / кап исчерпан / guard заблокировал / ошибка).
 */
export function createExplorationWorker(
  client: TelegramClient,
  getGraph: () => WorldModel,
): ExplorationWorker {
  return async (req: ExploreRequest): Promise<{ channelName: string } | null> => {
    // Ре-проверка дневного капа на стороне воркера (mod уже проверил, но защита от гонок).
    if (req.joinsUsedToday >= req.dailyCap) return null;

    const graph = getGraph();
    const guard = getExplorationGuard();

    // 1. Поиск публичных кандидатов по теме.
    if (!guard.canSearch("public").allowed) return null;
    let chats: Array<{ id: number; title: string }>;
    try {
      const res = await searchPublicChats(client, req.topic);
      guard.recordSearch();
      guard.recordSuccess("search_public");
      chats = res.chats;
    } catch (err) {
      guard.recordFailure("search_public");
      log.warn("explore search failed", { topic: req.topic, err: (err as Error).message });
      return null;
    }
    if (chats.length === 0) {
      log.info("explore: no public chats for topic", { topic: req.topic });
      return null;
    }

    // 2. Фильтр кандидатов: РОВНО broadcast-каналы, ещё не подписана.
    for (const cand of chats.slice(0, MAX_CANDIDATES)) {
      const channelGraphId = telegramChannelId(cand.id);
      // not-already-member: есть достижимый channel-узел подписки в графе → пропускаем.
      if (graph.has(channelGraphId)) {
        try {
          const attrs = graph.getChannel(channelGraphId) as {
            reachability_score?: number;
            failure_type?: string;
          };
          const reachable =
            attrs.failure_type !== "permanent" && (attrs.reachability_score ?? 1) > 0;
          if (reachable) continue; // уже состоит и достижим
        } catch {
          // узел есть, но не channel-типа — на всякий пропускаем
          continue;
        }
      }

      // ЖЁСТКИЙ guard channels-only: тянем Chat и проверяем chatType === "channel".
      let chatType: string | undefined;
      try {
        const chat = await client.getChat(cand.id);
        chatType = chat.chatType;
      } catch (err) {
        log.debug("explore: getChat failed, skip candidate", {
          id: cand.id,
          err: (err as Error).message,
        });
        continue;
      }
      if (!isBroadcastChannel(chatType)) {
        log.debug("explore: candidate is not a broadcast channel, skip", { id: cand.id, chatType });
        continue; // НИКОГДА не джойним группы/супергруппы авто
      }

      // 3. Join ОДНОГО (read-only канал). Guard L2 — финальная защита cooldown/budget.
      if (!guard.canJoin().allowed) return null;
      try {
        const result = await joinChat(client, cand.id);
        guard.recordJoin();
        guard.recordSuccess("join");
        // ДВОЙНОЙ guard: если join вернул chat — перепроверяем тип (на случай гонок/редиректа).
        const joinedType = result.chat?.chatType;
        if (joinedType && !isBroadcastChannel(joinedType)) {
          log.warn("explore: joined chat is NOT a channel — leaving immediately", {
            id: cand.id,
            joinedType,
          });
          try {
            const { leaveChat } = await import("./actions.js");
            await leaveChat(client, cand.id);
            guard.recordLeave();
          } catch {
            /* best-effort откат */
          }
          return null;
        }
      } catch (err) {
        guard.recordFailure("join");
        log.warn("explore: join failed", { id: cand.id, err: (err as Error).message });
        continue; // попробуем следующего кандидата
      }

      // 4. Читаем + ингестим заметное в KB (та же воронка, что и Wiki-скан).
      const name = cand.title || `@${cand.id}`;
      const ingested = await readAndIngest(client, getGraph(), cand.id, channelGraphId, req.topic);
      log.info("explore: subscribed to channel (read-only)", {
        channel: name,
        topic: req.topic,
        ingested,
      });
      return { channelName: name };
    }

    log.info("explore: no broadcast-channel candidate matched", { topic: req.topic });
    return null;
  };
}

// ── Ручной Wiki-путь: периодический скан подписанных каналов с непрочитанным ──

/** Как часто скан подписанных каналов читает+ингестит непрочитанное (мс). */
const WIKI_SCAN_INTERVAL_MS = 30 * 60_000; // 30 мин
/** Сколько каналов за один проход скана обрабатываем (дёшево, без всплеска запросов). */
const WIKI_SCAN_MAX_CHANNELS = 3;
/** Атрибут-метка времени последнего KB-ингеста канала (анти-повтор). */
const WIKI_INGEST_TS_ATTR = "kb_ingested_ms";

let _wikiTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Один проход Wiki-скана: находит достижимые broadcast-каналы (chat_type === "channel"), где есть
 * непрочитанное и давно (или ни разу) не ингестили — читает и складывает заметное в KB. Это и есть
 * РУЧНОЙ путь: владелец создал «Worki Wiki» и добавил Алису → инфа попадает в память через ту же
 * воронку, что авто-исследование. Чистый канал → подписчик не может постить → read-only.
 */
export async function scanWikiChannels(
  client: TelegramClient,
  graph: WorldModel,
  nowMs = Date.now(),
): Promise<number> {
  let processed = 0;
  const candidates: Array<{ graphId: string; nativeId: string; unread: number }> = [];
  for (const nodeId of graph.getEntitiesByType("channel")) {
    let attrs: Record<string, unknown>;
    try {
      attrs = graph.getChannel(nodeId) as unknown as Record<string, unknown>;
    } catch {
      continue;
    }
    if (attrs.chat_type !== "channel") continue; // ТОЛЬКО broadcast-каналы
    if (attrs.failure_type === "permanent" || Number(attrs.reachability_score ?? 1) <= 0) continue;
    const unread = Number(attrs.unread ?? 0);
    if (unread <= 0) continue; // нечего читать
    if (nowMs - Number(attrs.kb_ingested_ms ?? 0) < WIKI_SCAN_INTERVAL_MS) continue; // недавно ингестили

    // nodeId формата channel:telegram:<native> → достаём native для API.
    const native = nodeId.split(":").pop() ?? "";
    if (!native) continue;
    candidates.push({ graphId: nodeId, nativeId: native, unread });
  }

  candidates.sort((a, b) => b.unread - a.unread);
  for (const c of candidates.slice(0, WIKI_SCAN_MAX_CHANNELS)) {
    const name = safeDisplayName(graph, c.graphId);
    const ingested = await readAndIngest(client, graph, c.nativeId, c.graphId, undefined);
    // Отмечаем время ингеста (даже если 0 новых — чтобы не долбить тот же канал каждый цикл).
    try {
      graph.updateChannel(c.graphId, { [WIKI_INGEST_TS_ATTR]: nowMs } as never);
    } catch {
      /* best-effort */
    }
    if (ingested > 0)
      log.info("wiki-scan: ingested channel content to KB", { channel: name, ingested });
    processed++;
  }
  return processed;
}

/**
 * Запускает периодический Wiki-скан (идемпотентно). Первый проход — сразу (без await), затем
 * каждые WIKI_SCAN_INTERVAL_MS. Уважает конфиг-гейт ALICE_CHANNEL_EXPLORE через сам mod —
 * скан читает только уже подписанные каналы, поэтому безопасен и при включённой фиче.
 */
export function startWikiScan(client: TelegramClient, getGraph: () => WorldModel): void {
  if (_wikiTimer) return;
  log.info("wiki-scan: starting");
  void scanWikiChannels(client, getGraph()).catch((err) =>
    log.warn("wiki-scan first pass failed", { err: (err as Error).message }),
  );
  _wikiTimer = setInterval(() => {
    void scanWikiChannels(client, getGraph()).catch((err) =>
      log.warn("wiki-scan pass failed", { err: (err as Error).message }),
    );
  }, WIKI_SCAN_INTERVAL_MS);
}

/** Останавливает Wiki-скан (для тестов/shutdown). */
export function stopWikiScan(): void {
  if (_wikiTimer) {
    clearInterval(_wikiTimer);
    _wikiTimer = null;
  }
}

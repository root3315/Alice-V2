/**
 * System 1 — рефлекторные решения с нулевыми затратами LLM (ADR-26 §4).
 *
 * Низкорискованные механические действия не требуют рассуждений LLM.
 * System 1 выполняется после выбора голоса и до постановки в очередь.
 * Если System 1 может обработать действие — выполняет напрямую, минуя очередь (без расхода квоты LLM).
 * Иначе — эскалирует в System 2 (ставит в очередь для потока ACT, выполняется LLM).
 *
 * ADR-29 направление 5: S10 leakProb — при совпадении условий с заданной вероятностью пропускает в System 2 (участие в группах).
 * ADR-30: действие digest — mark_read + неглубокое обновление состояния графа (инъекция novelty, затухание relevance).
 */
import type { WorldModel } from "../graph/world-model.js";
import {
  effectiveMention,
  hasObligation,
  isRiskNegligible,
  OBLIGATION_THRESHOLDS,
} from "../pressure/signal-decay.js";
import type { FocalSet } from "../voices/focus.js";
import type { VoiceAction } from "../voices/personality.js";

// -- Типы -------------------------------------------------------------------

export interface System1Decision {
  /** Смог ли System 1 обработать данное действие. */
  handled: boolean;
  /** Тип действия, выполненного System 1. */
  action?: "mark_read" | "skip" | "digest";
  /** ID целевой сущности действия. */
  target?: string;
}

/** Параметры конфигурации System 1. */
export interface System1Options {
  /** S10: вероятность утечки в System 2 при совпадении условий Diligence mark_read. */
  leakProb?: number;
  /** Сигнал продолжения диалога: у target есть активный разговор с turn_state = alice_turn.
   *  При true Diligence безусловно эскалирует в System 2 — digest не должен поглощать неявные ответы. */
  isConversationContinuation?: boolean;
  /** ADR-124: настенные часы в миллисекундах, используется для расчёта effectiveObligation. */
  nowMs?: number;
}

// -- Правила -------------------------------------------------------------------

/**
 * Попытка обработки в System 1.
 *
 * Правила:
 * | Голос     | Условие                                                  | Действие System 1                  |
 * |-----------|----------------------------------------------------------|------------------------------------|
 * | Caution   | все фокальные сущности risk≤low + нет conv alice_turn    | skip                               |
 * | Diligence | target.pending_directed=0 + target.unread>0              | mark_read / digest (утечка leakProb)|
 *
 * @returns System1Decision — handled=true означает, что System 1 обработал действие
 */
export function trySystem1(
  action: VoiceAction,
  focalSets: Record<VoiceAction, FocalSet>,
  G: WorldModel,
  tick: number,
  options?: System1Options,
): System1Decision {
  if (action === "caution") {
    return tryCautionSkip(focalSets.caution, G, tick, options?.nowMs);
  }

  if (action === "diligence") {
    return tryDiligenceMarkRead(
      focalSets.diligence,
      G,
      tick,
      options?.leakProb ?? 0,
      options?.isConversationContinuation ?? false,
      options?.nowMs ?? Date.now(),
    );
  }

  return { handled: false };
}

// -- Caution skip -----------------------------------------------------------

/**
 * Caution skip: все сущности в фокальном множестве имеют риск ≤ low, и нет разговора alice_turn.
 *
 * Есть разговор alice_turn → возможно, нужна оценка LLM для ответа → эскалация в System 2.
 * Есть высокорискованная сущность → нужна оценка риска LLM → эскалация в System 2.
 */
function tryCautionSkip(
  focalSet: FocalSet,
  G: WorldModel,
  _tick: number,
  nowMs?: number,
): System1Decision {
  // пустое фокальное множество → безопасно пропустить
  if (focalSet.entities.length === 0) {
    return { handled: true, action: "skip" };
  }

  for (const eid of focalSet.entities) {
    if (!G.has(eid)) continue;

    // risk_level — атрибут channel, для не-channel сущностей пропускаем
    if (G.getNodeType(eid) !== "channel") continue;

    // высокий риск → эскалация в System 2
    // ADR-126: используем effectiveRisk вместо булевого isLowRisk
    // устаревший рейтинг риска больше не форсирует безусловно System 2
    if (!isRiskNegligible(G, eid, nowMs ?? Date.now())) {
      return { handled: false };
    }
  }

  // проверяем наличие разговора alice_turn (нужен ответ → эскалация в System 2)
  if (hasAliceTurnConversation(G)) {
    return { handled: false };
  }

  return { handled: true, action: "skip" };
}

// -- Diligence mark_read / digest -------------------------------------------

/**
 * Diligence mark_read: у целевого канала есть непрочитанные, но нет pending_directed.
 *
 * Есть pending_directed → нужен ответ LLM → эскалация в System 2.
 * Нет unread → делать нечего → не обрабатываем.
 *
 * ADR-29 S10: при leakProb > 0 после совпадения условий с этой вероятностью пропускается в System 2,
 * реализуя вероятностное участие в группах (Alice иногда высказывается в группах без упоминания @).
 *
 * ADR-30: при высоком unread но directed=0 используется digest (поверхностное усвоение) вместо mark_read.
 * digest = mark_read + инъекция novelty + затухание activity_relevance.
 *
 * G7: динамическое управление частотой — participation_ratio регулирует leakProb, предотвращает чрезмерное участие Alice в группах.
 * Запасной digest для сообщений бота: слой mapper/events уже блокирует создание ботами обязательств/продолжений
 * (не инкрементирует pending_directed, не триггерит isContinuation), поэтому bot-сообщения не эскалируют досрочно на проверках обязательств/продолжений.
 * После достижения ветки unread > 0 срабатывает проверка last_sender_is_bot → digest.
 */
/** ADR-110: окно сигнала продолжения диалога (секунды): сообщения в течение N секунд после высказывания Alice считаются возможными неявными ответами. */
const CONTINUATION_WINDOW_S = 300;
/** Нижний порог leakProb для сигнала продолжения диалога: обеспечивает высокую вероятность захвата неявных ответов. */
const CONTINUATION_LEAK_FLOOR = 0.7;
/** #22: нижний порог вероятности утечки, когда другие упоминают имя Alice. */
const MENTION_LEAK_FLOOR = 0.5;
/** #22: порог обнаружения burst в высокоактивном разговоре (количество непрочитанных сообщений). */
const ACTIVITY_BURST_THRESHOLD = 10;
/** #22: нижний порог вероятности утечки для высокоактивного разговора. */
const ACTIVITY_BURST_LEAK_FLOOR = 0.3;
/**
 * Абсолютный потолок effectiveLeakProb.
 * Многоуровневые Math.max()-полы могут поднять конфигурированное значение до непредсказуемых уровней:
 *   пользователь задал leakProb=0.1 → participation boost(×2)=0.2 → mention floor=0.5 → continuation=0.7
 * Этот потолок гарантирует, что итоговая вероятность не превысит 0.7, предотвращая неожиданное "почти всегда утекает".
 */
const MAX_EFFECTIVE_LEAK_PROB = 0.7;
/**
 * ADR-116: нижний порог вероятности утечки в период наблюдения в новой группе.
 * Используется, когда Alice никогда не высказывалась в этой группе (participation_ratio = 0).
 * Даёт LLM возможность "прочитать атмосферу" и сформировать начальное участие — разрывает замкнутый круг.
 * @see docs/adr/116-group-silence-trap.md §Исправление 1
 */
const NEWCOMER_LEAK_FLOOR = 0.5;

function tryDiligenceMarkRead(
  focalSet: FocalSet,
  G: WorldModel,
  _tick: number,
  leakProb: number,
  isConversationContinuation: boolean,
  nowMs: number,
): System1Decision {
  const target = focalSet.primaryTarget;
  if (!target || !G.has(target)) return { handled: false };

  // Цель Diligence должна быть узлом channel
  if (G.getNodeType(target) !== "channel") return { handled: false };
  const attrs = G.getChannel(target);
  const unread = attrs.unread ?? 0;

  // ADR-124: используем hasObligation вместо pending_directed > 0
  // устаревшие directed-сообщения больше не форсируют безусловно System 2
  // @see docs/adr/126-obligation-field-decay.md §D5
  if (hasObligation(G, target, nowMs, OBLIGATION_THRESHOLDS.system1)) {
    // эффективное обязательство > порога → нужен ответ LLM
    return { handled: false };
  }

  // Продолжение диалога: у target есть активный разговор с turn_state = alice_turn
  // Неявный ответ собеседника (без reply/ без @) не инкрементирует pending_directed, но автомат состояний диалога уже переключился.
  // В этом случае безусловно эскалируем в System 2 — digest поглотит неявный ответ и Alice замолчит в активном диалоге.
  if (isConversationContinuation) {
    return { handled: false };
  }

  if (unread > 0) {
    // ADR-91: последний отправитель — бот → сразу digest, без утечки в System 2
    // Боты в группах (проверочные подсказки, результаты перевода и т.д.) почти никогда не требуют активного ответа Alice
    if (attrs.last_sender_is_bot === true) {
      return { handled: true, action: "digest", target };
    }

    // G7: динамический leakProb на основе participation_ratio
    let effectiveLeakProb = leakProb;
    const ratio = attrs.participation_ratio ?? 0;
    // ADR-161 §3.6: верхний предел участия в онлайн-группах — 15%.
    // Доля >15% в многопользовательской группе уже является чрезмерным участием.
    // @see docs/adr/161-action-space-audit-group-cadence.md §3.6
    if (ratio > 0.15) {
      effectiveLeakProb = 0; // Alice уже чрезмерно участвует, останавливаем утечку
    } else if (ratio === 0) {
      // ADR-116: Alice никогда не высказывалась в этой группе → используем newcomer floor
      // разрываем замкнутый круг: нужно сначала высказаться для participation, но высказывание требует утечки
      effectiveLeakProb = Math.max(effectiveLeakProb, NEWCOMER_LEAK_FLOOR);
    } else if (ratio > 0 && ratio < 0.05) {
      effectiveLeakProb = leakProb * 2; // участие недостаточное, увеличиваем вероятность утечки
    }

    // ADR-78 F4: сигнал продолжения диалога независим от усечения по participation_ratio.
    // "Бумеранг" — это сценарий "собеседник отвечает Alice", отличный от того, что Alice сама вступает в разговор.
    // Даже при ratio > 0.25 неявные ответы сразу после высказывания Alice должны быть захвачены.
    // Динамическое затухание: чем выше ratio, тем ниже вероятность утечки продолжения, предотвращает чрезмерную реакцию при высоком участии.
    {
      // ADR-110: используем настенные часы в мс для определения окна продолжения диалога
      const lastAliceActionMs = Number(attrs.last_alice_action_ms ?? 0);
      if (
        lastAliceActionMs > 0 &&
        ((nowMs ?? Date.now()) - lastAliceActionMs) / 1000 <= CONTINUATION_WINDOW_S
      ) {
        const continuationProb = CONTINUATION_LEAK_FLOOR * Math.max(0, 1 - ratio * 2);
        effectiveLeakProb = Math.max(effectiveLeakProb, continuationProb);
      }
    }

    // #22: неявный ответ — повышаем вероятность утечки, когда другие упоминают имя Alice
    // структурное совпадение (text.includes), не семантическое, соответствует ADR-50
    // ADR-126: используем effectiveMention вместо булевого флага mentions_alice
    // упоминание имени — мгновенный социальный сигнал, затухает с периодом полураспада 15 минут.
    // Вероятность утечки пропорциональна свежести упоминания, а не бинарна.
    if (effectiveLeakProb < MENTION_LEAK_FLOOR) {
      const mentionStrength = effectiveMention(G, target, nowMs);
      if (mentionStrength > 0.1) {
        // затухшее упоминание → затухшая утечка. Свежее упоминание даёт полную ставку, старое — пропорциональную.
        const mentionLeak = MENTION_LEAK_FLOOR * mentionStrength;
        effectiveLeakProb = Math.max(effectiveLeakProb, mentionLeak);
      }
    }

    // #22: высокоактивный разговор с большей вероятностью содержит неявные ответы
    if (effectiveLeakProb > 0 && unread >= ACTIVITY_BURST_THRESHOLD) {
      effectiveLeakProb = Math.max(effectiveLeakProb, ACTIVITY_BURST_LEAK_FLOOR);
    }

    // абсолютный потолок: финальное усечение после многоуровневых Math.max()-полов.
    // предотвращает рост конфигурированного leakProb=0.1 к 1.0 через цепочку увеличений.
    effectiveLeakProb = Math.min(effectiveLeakProb, MAX_EFFECTIVE_LEAK_PROB);

    // S10: вероятностная утечка в System 2 (возможность участия в группе)
    if (effectiveLeakProb > 0 && Math.random() < effectiveLeakProb) {
      return { handled: false };
    }
    // ADR-30: digest (поверхностное усвоение) — один дополнительный уровень когнитивной обработки сверх mark_read
    return { handled: true, action: "digest", target };
  }

  return { handled: false };
}

// -- Вспомогательные функции -------------------------------------------------------------------

/** Есть ли в графе активный разговор с alice_turn. */
function hasAliceTurnConversation(G: WorldModel): boolean {
  for (const convId of G.getEntitiesByType("conversation")) {
    const attrs = G.getConversation(convId);
    if (attrs.state === "cooldown" || attrs.state === "closing") continue;
    if (attrs.turn_state === "alice_turn") return true;
  }
  return false;
}

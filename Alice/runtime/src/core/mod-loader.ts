/**
 * Загрузчик модов — регистрирует все Alice Mods.
 *
 * Загружаются в порядке зависимостей, depends идут первыми.
 * В будущем расширяемо до динамического обнаружения (сканирование папки mods/).
 *
 * Ссылка: narrative-engine/core/engine.ts (mod registration)
 */
import { channelMod } from "../mods/channel.mod.js";
import { consciousnessMod } from "../mods/consciousness.mod.js";
import { consolidationMod } from "../mods/consolidation.mod.js";
import { diaryMod } from "../mods/diary.mod.js";
import { episodeMod } from "../mods/episode.mod.js";
import { feedsMod } from "../mods/feeds.mod.js";
import { healthWatchMod } from "../mods/health-watch.mod.js";
import { learningMod } from "../mods/learning.mod.js";
import { memoryMod } from "../mods/memory.mod.js";
import { metacognitionMod } from "../mods/metacognition.mod.js";
import { observerMod } from "../mods/observer.mod.js";
import { pressureMod } from "../mods/pressure.mod.js";
import { relationshipsMod } from "../mods/relationships.mod.js";
import { schedulerMod } from "../mods/scheduler.mod.js";
import { socialCaseMod } from "../mods/social-case.mod.js";
import { soulMod } from "../mods/soul.mod.js";
import { strategyMod } from "../mods/strategy.mod.js";
import { threadsMod } from "../mods/threads.mod.js";
import { workiMod } from "../mods/worki.mod.js";
import { recallMod } from "../mods/recall.mod.js";
import { kbMod } from "../mods/kb.mod.js";
import { digestMod } from "../mods/digest.mod.js";
import { devOfferMod } from "../mods/dev-offer.mod.js";
import type { ModDefinition } from "./types.js";

/**
 * Загрузить все моды в порядке зависимостей.
 * Core-моды без зависимостей идут первыми, mechanic-моды с зависимостями — последними.
 *
 * director.mod заморожен (фаза M1):
 * - Расчёт NTI концептуально пересекается с полями давления P1-P6 (§17, пробел 7)
 * - Давление теперь обрабатывается в pressure.mod
 * - beat echo и whisper при необходимости будут перенесены в threads.mod
 */
export function loadAllMods(): ModDefinition[] {
  return [
    soulMod,
    pressureMod,
    memoryMod,
    threadsMod,
    socialCaseMod,
    relationshipsMod,
    observerMod,
    consolidationMod,
    learningMod,
    consciousnessMod,
    metacognitionMod, // Wave 4: рефлексия — на значимое событие внутренний шаг осмысления (после consciousness)
    strategyMod,
    schedulerMod,
    feedsMod,
    channelMod, // ADR-206: информационный поток каналов — после feedsMod
    diaryMod,
    episodeMod, // ADR-215: причинно-следственный граф когнитивных эпизодов — после diary
    workiMod, // code_ask/code_fix/code_pr: чистые агенты по коду Worki (async, через прокси)
    healthWatchMod, // проактивный инцидент-алёрт: замечает свои error-аномалии → говорит владельцу в личку
    recallMod, // cross-chat recall: «что мы решили по X» (факты+дневник+эпизоды, read-only query)
    kbMod, // KB-ingestion: «запомни про проект …» (стойкое незатухающее знание)
    digestMod, // раз в сутки самосочинённая сводка дня в личку владельца
    devOfferMod, // очень сдержанный нудж «предложить глянуть код» в рабочем чате
  ];
}

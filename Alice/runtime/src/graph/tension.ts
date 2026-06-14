/**
 * Вектор натяжения сущности (ADR-26 §1) + маршрутизация вкладов.
 *
 * Транспонирует AllPressures.contributions (pk → eid → value) в
 * eid → TensionVector, сохраняя шесть силовых компонент на сущность + P_prospect.
 *
 * ADR-101: маршрутизация вкладов — расчёт давлений ведётся в измерении сущностей
 * (P3→contact, P4→thread, P2→fact), но действия возможны только на каналах (channel:*).
 * routeContributions() — оператор проекции ρ: V → V_A, проецирующий полное
 * пространство сущностей на исполнимое подпространство.
 *
 * @see paper/ §3.3: τ(e) = transpose of contributions matrix
 */

import { ensureChannelId } from "./constants.js";
import type { WorldModel } from "./world-model.js";

// -- Типы -------------------------------------------------------------------

/** Вектор натяжения сущности — многомерная декомпозиция давлений, переносимая каждым узлом графа. */
export interface TensionVector {
  readonly tau1: number; // P1 долг внимания
  readonly tau2: number; // P2 информационное давление
  readonly tau3: number; // P3 охлаждение отношений
  readonly tau4: number; // P4 расхождение треда
  readonly tau5: number; // P5 обязательство ответить
  readonly tau6: number; // P6 любопытство
  readonly tauP: number; // P_prospect перспектива
  readonly tauRisk: number; // сигнал риска (результат flag_risk)
  readonly tauAttraction: number; // ADR-178: сигнал притяжения
  readonly tauSpike: number; // ADR-191: сигнал скачка скорости (z-score > 1)
}

/** Нулевой вектор натяжения. */
export const ZERO_TENSION: TensionVector = Object.freeze({
  tau1: 0,
  tau2: 0,
  tau3: 0,
  tau4: 0,
  tau5: 0,
  tau6: 0,
  tauP: 0,
  tauRisk: 0,
  tauAttraction: 0,
  tauSpike: 0,
});

/**
 * Отображение имён ключей AllPressures.contributions в поля TensionVector.
 * P_prospect (tauP) не входит в это отображение — обрабатывается отдельно
 * через параметр prospectContributions, см. второй аргумент buildTensionMap().
 */
const PK_TO_TAU: Record<string, keyof TensionVector> = {
  P1: "tau1",
  P2: "tau2",
  P3: "tau3",
  P4: "tau4",
  P5: "tau5",
  P6: "tau6",
};

// -- Основные функции ---------------------------------------------------------------

/**
 * Транспонирует AllPressures.contributions в Map векторов натяжения по сущностям.
 *
 * @param contributions - AllPressures.contributions: `{ P1: {eid: val}, ..., P6: {eid: val} }`
 * @param prospectContributions - pProspect().contributions: `{eid: val}` (опционально)
 * @param riskContributions - сигнал риска по сущностям (результат flag_risk), записывается в tauRisk (опционально)
 * @param attractionContributions - ADR-178: сигнал притяжения по сущностям (rv_attraction), записывается в tauAttraction (опционально)
 * @param spikeContributions - ADR-191: сигнал скачка скорости по сущностям (z-score > 1), записывается в tauSpike (опционально)
 * @returns Map<entityId, TensionVector>
 *
 * @see paper/ §3.3: τ(e) = transpose of contributions matrix
 */
export function buildTensionMap(
  contributions: Record<string, Record<string, number>>,
  prospectContributions?: Record<string, number>,
  riskContributions?: Record<string, number>,
  attractionContributions?: Record<string, number>,
  spikeContributions?: Record<string, number>,
): Map<string, TensionVector> {
  // Собираем все встречавшиеся entity id
  const entityIds = new Set<string>();
  for (const pk of Object.keys(PK_TO_TAU)) {
    const ck = contributions[pk];
    if (ck) {
      for (const eid of Object.keys(ck)) entityIds.add(eid);
    }
  }
  if (prospectContributions) {
    for (const eid of Object.keys(prospectContributions)) entityIds.add(eid);
  }
  if (riskContributions) {
    for (const eid of Object.keys(riskContributions)) entityIds.add(eid);
  }
  if (attractionContributions) {
    for (const eid of Object.keys(attractionContributions)) entityIds.add(eid);
  }
  if (spikeContributions) {
    for (const eid of Object.keys(spikeContributions)) entityIds.add(eid);
  }

  const result = new Map<string, TensionVector>();

  for (const eid of entityIds) {
    result.set(eid, {
      tau1: contributions.P1?.[eid] ?? 0,
      tau2: contributions.P2?.[eid] ?? 0,
      tau3: contributions.P3?.[eid] ?? 0,
      tau4: contributions.P4?.[eid] ?? 0,
      tau5: contributions.P5?.[eid] ?? 0,
      tau6: contributions.P6?.[eid] ?? 0,
      tauP: prospectContributions?.[eid] ?? 0,
      tauRisk: riskContributions?.[eid] ?? 0,
      tauAttraction: attractionContributions?.[eid] ?? 0,
      tauSpike: spikeContributions?.[eid] ?? 0,
    });
  }

  return result;
}

/**
 * Обратная агрегация из Map натяжений в глобальные скаляры (для проверки round-trip).
 *
 * Проверяемое равенство: aggregateFromTensionMap(buildTensionMap(c, pc)).Pk ≈ Σ c[Pk][eid]
 */
export function aggregateFromTensionMap(tensionMap: Map<string, TensionVector>): {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  P_prospect: number;
  P_risk: number;
  P_attraction: number;
  P_spike: number;
} {
  let P1 = 0;
  let P2 = 0;
  let P3 = 0;
  let P4 = 0;
  let P5 = 0;
  let P6 = 0;
  let P_prospect = 0;
  let P_risk = 0;
  let P_attraction = 0;
  let P_spike = 0;

  for (const t of tensionMap.values()) {
    P1 += t.tau1;
    P2 += t.tau2;
    P3 += t.tau3;
    P4 += t.tau4;
    P5 += t.tau5;
    P6 += t.tau6;
    P_prospect += t.tauP;
    P_risk += t.tauRisk;
    P_attraction += t.tauAttraction;
    P_spike += t.tauSpike;
  }

  return { P1, P2, P3, P4, P5, P6, P_prospect, P_risk, P_attraction, P_spike };
}

/** Норма L2 — скалярная величина вектора натяжения (без tauRisk: сигнал риска идёт отдельным путём). */
export function tensionNorm(t: TensionVector): number {
  return Math.sqrt(
    t.tau1 * t.tau1 +
      t.tau2 * t.tau2 +
      t.tau3 * t.tau3 +
      t.tau4 * t.tau4 +
      t.tau5 * t.tau5 +
      t.tau6 * t.tau6 +
      t.tauP * t.tauP,
  );
}

// -- Маршрутизация вкладов ---------------------------------------------------------------

/**
 * Разрешает entity ID в исполнимые цели (список ID каналов).
 *
 * Использует entity_type узла графа (не сопоставление префиксов ID),
 * чтобы поведение было одинаковым при разных соглашениях об ID в тестах и продакшене.
 *
 * Правила маршрутизации:
 *   channel    → без изменений (уже исполнимо)
 *   contact    → ensureChannelId → channel:X (приватный чат)
 *   thread     → сущности по рёбрам involves → рекурсивное разрешение
 *   fact       → source_channel или source_contact → канал
 *   прочие     → отброс (agent, conversation и т.п. — не исполнимы)
 *
 * @returns массив исполнимых ID каналов; пустой массив = не исполнимо, вклад отброшен
 */
function resolveActionableTargets(entityId: string, G: WorldModel): string[] {
  if (!G.has(entityId)) return [];

  const nodeType = G.getNodeType(entityId);

  // Канал → напрямую исполнимо
  if (nodeType === "channel") return [entityId];

  // Контакт → приватный чат
  if (nodeType === "contact") {
    const channelId = ensureChannelId(entityId);
    return channelId && G.has(channelId) ? [channelId] : [];
  }

  // Тред → приоритет source_channel (точная маршрутизация), откат на рёбра involves
  // @see docs/adr/102-reflective-action-trace.md (ADR-104)
  if (nodeType === "thread") {
    const threadAttrs = G.getThread(entityId);
    // ADR-104: приоритет source_channel (точная маршрутизация)
    if (threadAttrs.source_channel && G.has(threadAttrs.source_channel)) {
      return [threadAttrs.source_channel];
    }
    // Откат на рёбра involves
    const involvedNodes = G.getNeighbors(entityId, "involves");
    const channels: string[] = [];
    for (const nodeId of involvedNodes) {
      channels.push(...resolveActionableTargets(nodeId, G));
    }
    return [...new Set(channels)];
  }

  // Факт → source_channel или source_contact → канал
  if (nodeType === "fact") {
    const attrs = G.getFact(entityId);
    if (attrs.source_channel && G.has(attrs.source_channel)) {
      return [attrs.source_channel];
    }
    if (attrs.source_contact) {
      return resolveActionableTargets(attrs.source_contact, G);
    }
    return [];
  }

  // Прочие (agent, conversation) → не исполнимо
  return [];
}

/**
 * Маршрутизация вкладов: проецирует давления неисполнимых сущностей на исполнимые каналы.
 *
 * Функции давления рассчитываются по семантическим измерениям (P3→contact, P4→thread, P2→fact),
 * но выполнение действий возможно только на каналах (channel:*). Данная функция — оператор
 * проекции ρ: V → V_A, вставленный между расчётом давлений и Map натяжений, чтобы все
 * кандидаты на нижних уровнях (фокус-сет, V-maximizer) были исполнимы.
 *
 * Стратегия маршрутизации:
 *   contact  →  ensureChannelId → channel:X  («хочу поговорить с X» → «действую в личном чате X»)
 *   thread   →  рёбра involves → связанные каналы  («тема X требует продвижения» → «действую в нужном канале»)
 *   fact     →  source_channel/contact  («факт X надо проверить» → «действую в канале-источнике»)
 *
 * При слиянии нескольких источников вклады суммируются (один канал может получить вклад от P3 contact и P6 contact).
 * Вклады без исполнимых целей отбрасываются (напр. контакт без личного чата).
 *
 * @see paper/ §3.3: исполнимая проекция пространства натяжений
 */
export function routeContributions(
  contributions: Record<string, Record<string, number>>,
  prospectContributions: Record<string, number>,
  G: WorldModel,
): {
  contributions: Record<string, Record<string, number>>;
  prospectContributions: Record<string, number>;
} {
  const routed: Record<string, Record<string, number>> = {};

  for (const [pk, entityContribs] of Object.entries(contributions)) {
    const routedPk: Record<string, number> = {};
    for (const [eid, value] of Object.entries(entityContribs)) {
      const targets = resolveActionableTargets(eid, G);
      if (targets.length === 0) continue;
      const share = value / targets.length;
      for (const target of targets) {
        routedPk[target] = (routedPk[target] ?? 0) + share;
      }
    }
    routed[pk] = routedPk;
  }

  const routedProspect: Record<string, number> = {};
  for (const [eid, value] of Object.entries(prospectContributions)) {
    const targets = resolveActionableTargets(eid, G);
    if (targets.length === 0) continue;
    const share = value / targets.length;
    for (const target of targets) {
      routedProspect[target] = (routedProspect[target] ?? 0) + share;
    }
  }

  return { contributions: routed, prospectContributions: routedProspect };
}

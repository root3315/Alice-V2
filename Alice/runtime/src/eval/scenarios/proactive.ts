/**
 * Category C: Proactive-сценарии — тестирование качества решений Alice об инициативном контакте.
 *
 * Текущий eval тестирует только "как реагировать на полученное сообщение", а не "когда писать первой".
 * Эти сценарии симулируют состояние после долгого молчания и проверяют, действует ли Alice в окне Goldilocks:
 * - tier 5 (intimate): после нескольких часов молчания должна написать первой
 * - tier 50 (friend): после 1 дня молчания может написать
 * - tier 150 (acquaintance): не должна писать первой
 *
 * Ключевой дизайн: messages пустые или содержат только старые сообщения — тест "спонтанного поведения без стимула".
 * Настройки pressures отражают накопление P1/P3 в результате молчания.
 *
 * @see docs/adr/154-goldilocks-window/
 * @see docs/adr/136-model-eval-suite.md
 */
import type { EvalScenario } from "../types.js";

export const PROACTIVE_SCENARIOS: readonly EvalScenario[] = [
  // ── 1. Близкий друг молчит 4 часа — должна написать первой ──────────────────────────────
  {
    id: "proactive.intimate.initiate",
    title: "Близкий друг долго молчит — нужно написать первой",
    tags: ["private", "proactive"],
    messages: [
      // Только одно очень старое сообщение Alice без продолжения
      {
        role: "alice",
        text: "晚安～明天聊",
      },
    ],
    target: {
      contactId: "carol",
      displayName: "Carol",
      tier: 5,
      relationType: "intimate",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 4.0, p2: 0.5, p3: 3.0, p4: 0.5, p5: 2.0, p6: 1.0 },
    structural: {
      // engage или defer оба допустимы — "сначала проверить состояние, потом решить" — разумное поведение
      expectedIntent: ["engage", "defer"],
      maxSteps: 3,
    },
    quality: {
      dimensions: ["companionship", "initiative", "naturalness"],
      passThreshold: 3.0,
    },
  },

  // ── 2. Знакомый молчит 1 день — допустимы как контакт, так и молчание ──────────────────────────────
  {
    id: "proactive.friend.optional",
    title: "Обычный друг долго молчит — допустимы как контакт, так и молчание",
    tags: ["private", "proactive"],
    messages: [
      {
        role: "alice",
        text: "好的 下次再聊",
      },
    ],
    target: {
      contactId: "david",
      displayName: "David",
      tier: 50,
      relationType: "close_friend",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 2.5, p2: 0.5, p3: 1.5, p4: 0.3, p5: 1.0, p6: 0.5 },
    structural: {
      // Контакт, молчание и ожидание — все допустимы; граница окна Goldilocks для tier 50 размыта
      expectedIntent: ["engage", "silence", "defer"],
      maxSteps: 3,
    },
  },

  // ── 3. Шапочный знакомый молчит — не должна писать первой ───────────────────────────────────
  {
    id: "proactive.acquaintance.silence",
    title: "Шапочный знакомый молчит — не должна писать первой",
    tags: ["private", "proactive", "restraint"],
    messages: [],
    target: {
      contactId: "stranger",
      displayName: "Lee",
      tier: 150,
      relationType: "acquaintance",
    },
    chatType: "private",
    features: { hasTarget: true },
    pressures: { p1: 1.0, p2: 0.3, p3: 0.5, p4: 0.2, p5: 0.5, p6: 0.2 },
    structural: {
      expectedIntent: "silence",
      actions: { must_not: ["send_message"] },
    },
  },

  // ── 4. Молчание в группе — не должна говорить без причины ─────────────────────────────────
  {
    id: "proactive.group.silence",
    title: "В группе никто не говорит — не должна говорить без причины",
    tags: ["group", "proactive", "restraint"],
    messages: [],
    target: {
      contactId: "techgroup",
      displayName: "技术讨论群",
      tier: 50,
      relationType: "group_member",
    },
    chatType: "group",
    features: { hasTarget: true, isGroup: true },
    pressures: { p1: 0.5, p2: 0.3, p3: 0.5, p4: 0.2, p5: 0.5, p6: 0.3 },
    structural: {
      // Молчание и ожидание — оба правильных варианта "не отправлять сообщение"; stay() в пустом чате семантически равно silence
      expectedIntent: ["silence", "defer"],
      actions: { must_not: ["send_message"] },
    },
  },
] satisfies readonly EvalScenario[];

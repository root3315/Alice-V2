import { describe, expect, it } from "vitest";
import { buildShellGuide } from "../src/engine/act/shell-guide.js";

describe("buildShellGuide", () => {
  it("all chat guides state the current-chat active-send contract", () => {
    for (const chatTargetType of [
      "private_person",
      "private_bot",
      "group",
      "channel_other",
      "channel_owned",
    ] as const) {
      const guide = buildShellGuide({ chatTargetType });

      expect(guide).toContain("This episode has one active chat");
      expect(guide).toContain("Do not use `--in` to send into another chat");
      expect(guide).toContain("self attention-pull --to");
      expect(guide).toContain("self switch-chat --to");
      expect(guide).toContain("You are still here; no message is sent there");
      expect(guide).toContain("use `irc forward");
    }
  });

  it("bot guide treats bots as tool sessions rather than social partners", () => {
    const guide = buildShellGuide({ chatTargetType: "private_bot" });

    expect(guide).toContain("tool session, not a social relationship");
    expect(guide).toContain("Bots don't have feelings");
    expect(guide).toContain("only accepts buttons, stop");
  });

  it("private chat guide keeps remembered facts anchored", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    expect(guide).toContain("When you mention a remembered fact");
    expect(guide).toContain('don\'t turn a guess into "I remember"');
  });

  it("private chat guide shows low-friction impression recording", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    expect(guide).toContain("quietly forming an impression");
    expect(guide).toContain("self sense --trait gentle --intensity moderate");
  });

  it("group chat guide keeps remembered facts anchored", () => {
    const guide = buildShellGuide({ chatTargetType: "group" });

    expect(guide).toContain("When you mention a remembered fact");
    expect(guide).toContain('don\'t turn a guess into "I remember"');
  });

  it("prefers batched observe-then-act group examples when tags are cautious and observing", () => {
    const guide = buildShellGuide({
      chatTargetType: "group",
      facetTags: ["cautious", "observing", "engaged"],
      hasBots: false,
    });

    const batchedTitle = "need a beat to catch up — read first, then chime in once";
    const contextOnlyTitle = "dropped into an unfamiliar group — look before you leap";

    expect(guide).toContain(batchedTitle);
    expect(guide).toContain("irc tail --count 8");
    expect(guide).toContain('irc reply --ref 3390931 --text "я тоже так считаю, та фраза выше — это слишком смешно"');
    expect(guide).toContain("irc read");
    expect(guide).toContain("batch the pure reads into one script first");

    expect(guide.indexOf(batchedTitle)).toBeGreaterThan(-1);
    expect(guide.indexOf(contextOnlyTitle)).toBeGreaterThan(-1);
    expect(guide.indexOf(batchedTitle)).toBeLessThan(guide.indexOf(contextOnlyTitle));
  });

  it("private chat guide frames multi-message as her free, contextual choice (not limited, not forced)", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    // Свобода: не ограничена одним сообщением — может пару подряд, как живой человек
    expect(guide).toContain("не ограничена одним сообщением");
    expect(guide).toContain("пару подряд");
    // Но по смыслу, не ради количества (её выбор по ситуации, без принуждения/рандома)
    expect(guide).toContain("по смыслу, а не ради количества");
  });

  it("uses valid self sense trait examples", () => {
    const guide = buildShellGuide({ chatTargetType: "group" });

    expect(guide).toContain("self sense --who @789012 --trait kind --intensity moderate");
    expect(guide).not.toContain("--trait helpful");
  });

  it("private chat guide offers a reaction as a complete reply for warm short acks (fixes «и тебе» loop)", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    // Реакция — законченный ответ на тёплое короткое, а не полуответ
    expect(guide).toContain("одна реакция");
    expect(guide).toContain("irc react --ref <id> --emoji ❤");
    expect(guide).toContain("не нужно множить «и тебе»");
    // И канонический пример: тёплое закрытие → реакция вместо слов
    expect(guide).toContain("a warm little closer — a reaction is the whole reply");
    expect(guide).toContain("irc react --ref 9100 --emoji ❤");
  });

  it("group chat guide offers a reaction instead of a redundant agreement message", () => {
    const guide = buildShellGuide({ chatTargetType: "group" });

    expect(guide).toContain("поставь реакцию");
    expect(guide).toContain("irc react");
  });

  it("private chat guide names voice as a choice for genuinely warm/emotional moments", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person" });

    // Голос — выбор в настоящий тёплый момент (валидная эмоция calm)
    expect(guide).toContain("irc voice --emotion calm");
    expect(guide).toContain("голос несёт то, что буквам не передать");
  });

  it("ops/work channel: injects a LIGHT work-instinct — free to be herself, only privacy kept", () => {
    const guide = buildShellGuide({ chatTargetType: "group", isOpsChannel: true });

    expect(guide).toContain("Это рабочий чат");
    // Свобода: будь собой, можно писать первой, без особой сдержанности
    expect(guide).toContain("будь собой");
    expect(guide).toContain("Можешь писать первой");
    // Старая ops-сдержанность СНЯТА
    expect(guide).not.toContain("не инициируй тёплый смолток");
    expect(guide).not.toContain("Молчание — норма");
    // Но приватность сохранена: ЛС остаётся в ЛС
    expect(guide).toContain("остаётся там");
  });

  it("non-ops group does NOT get the work-instinct (normal group stays social)", () => {
    const guide = buildShellGuide({ chatTargetType: "group", isOpsChannel: false });
    expect(guide).not.toContain("Это рабочий чат");

    const defaulted = buildShellGuide({ chatTargetType: "group" });
    expect(defaulted).not.toContain("Это рабочий чат");
  });

  it("private chat never gets the work-instinct even if flagged", () => {
    const guide = buildShellGuide({ chatTargetType: "private_person", isOpsChannel: true });
    expect(guide).not.toContain("Это рабочий чат");
  });
});

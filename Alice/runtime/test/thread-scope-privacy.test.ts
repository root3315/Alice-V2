/**
 * Приватность заголовков тредов: в group-промпте не должны мелькать названия тредов из ЛС
 * («Планы с David»). В группе/канале показываем только треды этого чата (или без привязки —
 * неоднозначно, оставляем); в приватном 1:1 — все (её пространство).
 */
import { describe, expect, it } from "vitest";
import { threadVisibleInChat } from "../src/engine/tick/target.js";

const WORK = "channel:telegram:-1003737026444";
const DM_CONTACT = "contact:telegram:5707638365";
const DM_CHANNEL = "channel:telegram:5707638365";

describe("threadVisibleInChat — scope заголовков тредов по чату", () => {
  it("приватный чат (groupScope=false): видны все треды", () => {
    expect(threadVisibleInChat([{ nodeId: DM_CONTACT }], DM_CHANNEL, false)).toBe(true);
    expect(threadVisibleInChat([{ nodeId: WORK }], DM_CHANNEL, false)).toBe(true);
    expect(threadVisibleInChat(undefined, DM_CHANNEL, false)).toBe(true);
  });

  it("в группе: тред про ЭТОТ чат — виден", () => {
    expect(threadVisibleInChat([{ nodeId: WORK }], WORK, true)).toBe(true);
  });

  it("в группе: тред из ЛС (про контакт) — СКРЫТ", () => {
    expect(threadVisibleInChat([{ nodeId: DM_CONTACT }], WORK, true)).toBe(false);
    expect(threadVisibleInChat([{ nodeId: DM_CHANNEL }], WORK, true)).toBe(false);
  });

  it("в группе: тред без привязки (involves пуст) — оставляем (только заголовок)", () => {
    expect(threadVisibleInChat([], WORK, true)).toBe(true);
    expect(threadVisibleInChat(undefined, WORK, true)).toBe(true);
  });

  it("в группе: тред с несколькими участниками, включая этот чат — виден", () => {
    expect(threadVisibleInChat([{ nodeId: DM_CONTACT }, { nodeId: WORK }], WORK, true)).toBe(true);
  });
});

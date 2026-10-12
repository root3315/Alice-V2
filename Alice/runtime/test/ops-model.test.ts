import { describe, expect, it } from "vitest";
import { OPS_OPUS_WINDOW_MS, shouldUseOpsModel } from "../src/engine/tick/ops-model.js";

// Доказываем главное свойство model-tiering: Opus задействуется ТОЛЬКО когда в работач
// к Алисе реально обращаются (вопрос/код-ревью/инцидент). На всём остальном — sonnet,
// «просто так» Opus не включается.
describe("shouldUseOpsModel — Opus только для реальной ops-работы", () => {
  const OPS = "channel:telegram:-100777"; // работач
  const DM = "channel:telegram:1234567890"; // личка оператора
  const NOW = 1_700_000_000_000;

  it("работач + необработанное обращение (pending_directed>0) → Opus", () => {
    expect(shouldUseOpsModel(OPS, OPS, { pending_directed: 1, last_directed_ms: 0 }, NOW)).toBe(
      true,
    );
  });

  it("работач + недавно адресовали (свежий last_directed_ms) → Opus", () => {
    expect(
      shouldUseOpsModel(OPS, OPS, { pending_directed: 0, last_directed_ms: NOW - 60_000 }, NOW),
    ).toBe(true);
  });

  it("работач + автономный патруль (pending 0, обращение протухло) → sonnet, НЕ Opus", () => {
    expect(
      shouldUseOpsModel(
        OPS,
        OPS,
        { pending_directed: 0, last_directed_ms: NOW - OPS_OPUS_WINDOW_MS - 1 },
        NOW,
      ),
    ).toBe(false);
  });

  it("работач + к ней вообще не обращались → sonnet", () => {
    expect(shouldUseOpsModel(OPS, OPS, { pending_directed: 0, last_directed_ms: 0 }, NOW)).toBe(
      false,
    );
  });

  it("другой канал (личка/школьная группа) даже с обращением → sonnet", () => {
    expect(shouldUseOpsModel(DM, OPS, { pending_directed: 5, last_directed_ms: NOW }, NOW)).toBe(
      false,
    );
  });

  it("нет атрибутов канала → sonnet", () => {
    expect(shouldUseOpsModel(OPS, OPS, null, NOW)).toBe(false);
  });

  it("OPS_CHANNEL_ID не задан (фича выключена) → sonnet всегда", () => {
    expect(
      shouldUseOpsModel(OPS, undefined, { pending_directed: 9, last_directed_ms: NOW }, NOW),
    ).toBe(false);
  });

  it("граница окна: ровно на границе уже не Opus", () => {
    expect(
      shouldUseOpsModel(
        OPS,
        OPS,
        { pending_directed: 0, last_directed_ms: NOW - OPS_OPUS_WINDOW_MS },
        NOW,
      ),
    ).toBe(false);
  });

  it("target=null (внутренний/системный тик) → sonnet", () => {
    expect(shouldUseOpsModel(null, OPS, { pending_directed: 1 }, NOW)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { _resetFeedCache, feedsMod, isFeedsPolling } from "../src/mods/feeds.mod.js";
import { workiMod } from "../src/mods/worki.mod.js";

/**
 * Control-plane инструкции дашборда (раньше были «мёртвыми» — диспатчили несуществующие
 * инструкции и всегда отдавали 501):
 *   - worki_dismiss({ id })       — снять зависшую/недоставленную задачу из очереди + saved.
 *   - feeds_set_polling({ polling }) — пауза/возобновление поллинга фидов.
 *
 * Обе БЕЗ affordance → невидимы для LLM, дёргаются только через dispatchInstruction (дашборд).
 * Тестируем impl напрямую через минимальный ctx (как worki-running-restart.test.ts).
 */

function findInstruction(mod: typeof workiMod | typeof feedsMod, name: string) {
  const def = mod.instructions?.[name];
  expect(def, `instruction ${name} must exist`).toBeDefined();
  return def!;
}

describe("worki_dismiss (dashboard control-plane)", () => {
  it("существует, БЕЗ affordance (engine-owned, невидима для LLM)", () => {
    const def = findInstruction(workiMod, "worki_dismiss");
    expect(def.affordance).toBeUndefined();
    expect(def.impl).toBeTypeOf("function");
  });

  it("удаляет id из ctx.state.saved и сообщает removed=true", () => {
    const def = findInstruction(workiMod, "worki_dismiss");
    const ctx = {
      state: { saved: { "ask-stuck-1": { kind: "ask", status: "error" } } },
    } as never;
    const r = def.impl(ctx, { id: "ask-stuck-1" }) as {
      success: boolean;
      removed: boolean;
      id: string;
    };
    expect(r.success).toBe(true);
    expect(r.removed).toBe(true);
    expect((ctx as { state: { saved: Record<string, unknown> } }).state.saved["ask-stuck-1"]).toBeUndefined();
  });

  it("идемпотентна: повтор на уже снятый id → success, removed=false (не undefined → роут не отдаст 501)", () => {
    const def = findInstruction(workiMod, "worki_dismiss");
    const ctx = { state: { saved: {} } } as never;
    const r = def.impl(ctx, { id: "nope" }) as { success: boolean; removed: boolean };
    expect(r.success).toBe(true);
    expect(r.removed).toBe(false);
  });
});

describe("feeds_set_polling (dashboard control-plane)", () => {
  it("существует, БЕЗ affordance", () => {
    const def = findInstruction(feedsMod, "feeds_set_polling");
    expect(def.affordance).toBeUndefined();
    expect(def.impl).toBeTypeOf("function");
  });

  it("пауза (polling=false) и возобновление (polling=true) переключают состояние поллинга", () => {
    _resetFeedCache(); // сброс pollingPaused → true (активен) для детерминизма
    const def = findInstruction(feedsMod, "feeds_set_polling");
    const ctx = { state: {} } as never;

    const paused = def.impl(ctx, { polling: false }) as { success: boolean; polling: boolean };
    expect(paused.success).toBe(true);
    expect(paused.polling).toBe(false);
    expect(isFeedsPolling()).toBe(false);

    const resumed = def.impl(ctx, { polling: true }) as { success: boolean; polling: boolean };
    expect(resumed.success).toBe(true);
    expect(resumed.polling).toBe(true);
    expect(isFeedsPolling()).toBe(true);

    _resetFeedCache(); // не оставляем глобальное состояние другим тестам
  });
});

import { describe, it, expect } from "vitest";
import { workiMod } from "../src/mods/worki.mod.js";

/**
 * Bug #7: running-задача не должна теряться при рестарте. onTickEnd персистит running в
 * ctx.state.saved, а на регидрации превращает её в честную ошибку «прервалось рестартом»,
 * чтобы спросивший получил ответ, а не молчание.
 *
 * Тест гоняет реальный onTickEnd/contribute собранного мода через минимальный ctx.
 * Граф-заглушка: has() = false → никакая directed/reachability-логика не вмешивается, а
 * задача БЕЗ askGraphId эмитится в contribute() без directed-гейта (детерминированно).
 *
 * _rehydrated — модульный one-shot, поэтому регидрация проверяется ОДНИМ вызовом onTickEnd.
 */

type AnyCtx = Parameters<NonNullable<typeof workiMod.onTickEnd>>[0];

function makeCtx(saved: Record<string, unknown>): AnyCtx {
  const graphStub = {
    has: () => false,
    getChannel: () => ({}),
    updateChannel: () => {},
  };
  return {
    graph: graphStub,
    state: { saved },
    tick: 1,
    nowMs: Date.now(),
    targetWhitelist: null,
    getModState: () => undefined,
    dispatch: () => undefined,
  } as unknown as AnyCtx;
}

describe("worki: running-задача переживает рестарт честной ошибкой (Bug #7)", () => {
  it("регидрация running → честная ошибка «прервалось рестартом», эмит спросившему и персист", () => {
    const onTickEnd = workiMod.onTickEnd;
    const contribute = workiMod.contribute;
    expect(onTickEnd).toBeTypeOf("function");
    expect(contribute).toBeTypeOf("function");

    // Снимок из БД до рестарта: задача всё ещё была "running" (in-flight промис умер с процессом).
    // askGraphId намеренно отсутствует → contribute эмитит без directed-гейта.
    const ctx = makeCtx({
      "ask-restart-1": {
        kind: "ask",
        task: "разбор парсеров",
        status: "running",
        result: "",
        createdMs: Date.now() - 1000,
      },
    });

    // Первый (и единственный) onTickEnd после "рестарта" = регидрация running → error.
    onTickEnd?.(ctx);

    // 1) contribute() предъявляет честную ошибку спросившему, а не молчит.
    const items = contribute?.(ctx) ?? [];
    const text = JSON.stringify(items);
    expect(text).toContain("прервалось рестартом");
    expect(text).toContain("разбор парсеров");

    // 2) недоставленный результат остаётся персистнутым (теперь со status=error) → переживёт
    //    и следующий рестарт, пока не доставлен.
    const saved = (ctx.state as { saved: Record<string, { status?: string }> }).saved;
    expect(saved["ask-restart-1"]).toBeDefined();
    expect(saved["ask-restart-1"].status).toBe("error");
  });
});

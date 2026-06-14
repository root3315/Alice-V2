import { describe, it, expect } from "vitest";
import { looksLikeDelivery } from "../src/mods/worki.mod.js";

// looksLikeDelivery читает только status/task/result — строим частичный Pending (as any).
const done = (task: string, result: string) => ({ kind: "ask", task, status: "done", result }) as any;
const errored = (task: string, result: string) =>
  ({ kind: "ask", task, status: "error", result }) as any;

const review = done(
  "Ревью задачи: возобновление сохранённой вакансии в черновике даёт ошибку",
  "Баг в close: hh_external_id сохраняется, при повторной публикации идёт PUT по архивной вакансии. Файл user_vacancies.py:436, hh_publish.py:241.",
);

describe("worki: looksLikeDelivery (КРИТ-фикс доставки)", () => {
  it("короткий ack / приветствие / реакция / пусто → НЕ доставка", () => {
    expect(looksLikeDelivery("секунду, гляну", review)).toBe(false);
    expect(looksLikeDelivery("привет!", review)).toBe(false);
    expect(looksLikeDelivery("ага 👍", review)).toBe(false);
    expect(looksLikeDelivery("", review)).toBe(false);
    expect(looksLikeDelivery(undefined, review)).toBe(false);
  });

  it("пересказ с упоминанием файла/идентификатора → доставка", () => {
    expect(
      looksLikeDelivery(
        "глянула — баг в user_vacancies.py: при close не обнуляется внешний id, потом падает",
        review,
      ),
    ).toBe(true);
  });

  it("длинный пересказ (≥200) → доставка даже без точного токена", () => {
    const long =
      "готово, рассказываю что нашла по этой задаче и как это чинить шаг за шагом, " +
      "подробности тут ".repeat(15);
    expect(long.length).toBeGreaterThanOrEqual(200);
    expect(looksLikeDelivery(long, review)).toBe(true);
  });

  it("длинная ПОСТОРОННЯЯ реплика (нет пересечения, <200) → НЕ доставка", () => {
    expect(
      looksLikeDelivery(
        "да норм, поедем завтра кудато гулять если погода будет ок наверное по городу",
        review,
      ),
    ).toBe(false);
  });

  it("ошибка: общее объявление провала → доставка", () => {
    const e = errored("Ревью задачи #21 про возобновление", "fetch failed");
    expect(looksLikeDelivery("не вышло, увы — сервис недоступен, попробуй ещё разок позже", e)).toBe(
      true,
    );
  });

  it("ошибка: короткое постороннее → НЕ доставка", () => {
    const e = errored("Ревью задачи #21 про возобновление", "fetch failed");
    expect(looksLikeDelivery("оке", e)).toBe(false);
  });
});

/**
 * Приватность forward: нельзя переслать из личного 1:1 чата (положительный Telegram id) в ДРУГОЙ
 * чат — контент ЛС не должен утекать в группы/каналы. Курирование из групп/каналов (id < 0) — можно.
 *
 * Это authoritative server-side guard в handleTelegramForward (промпт обойти не может).
 */
import { describe, expect, it } from "vitest";
import { isPrivateForwardBlocked } from "../src/engine-api/routes/telegram.js";

describe("isPrivateForwardBlocked — privacy guard on forward", () => {
  const PRIVATE_DM = 5707638365; // личка (положительный id)
  const WORK_GROUP = -1003737026444; // работач (отрицательный = супергруппа)
  const OTHER_GROUP = -1002250041196;

  it("блокирует пересылку из ЛС в группу (главная утечка ЛС→работач)", () => {
    expect(isPrivateForwardBlocked(PRIVATE_DM, WORK_GROUP)).toBe(true);
  });

  it("блокирует пересылку из ЛС в другое ЛС", () => {
    expect(isPrivateForwardBlocked(PRIVATE_DM, 12345678)).toBe(true);
  });

  it("разрешает курирование из группы/канала в группу", () => {
    expect(isPrivateForwardBlocked(OTHER_GROUP, WORK_GROUP)).toBe(false);
    expect(isPrivateForwardBlocked(WORK_GROUP, OTHER_GROUP)).toBe(false);
  });

  it("разрешает пересылку внутри того же ЛС (безвредно)", () => {
    expect(isPrivateForwardBlocked(PRIVATE_DM, PRIVATE_DM)).toBe(false);
  });
});

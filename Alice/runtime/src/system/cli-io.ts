/**
 * CLI IO реализация — привязка к реальной среде (улучшение FP в ADR-235).
 *
 * Предоставляет реальные реализации EngineClient и Output
 * для production-точки входа CLI.
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { engineGet, enginePost, engineQuery } from "../../skills/_lib/engine-client.js";
import { resolveTarget } from "./chat-client.js";
import type { EngineClient, Output, TargetResolver } from "./cli-types.js";

function currentChatIdFromEnv(): number | undefined {
  const raw = process.env.ALICE_CTX_TARGET_CHAT?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ── Реализация Engine Client ──

/** Реальный клиент Engine API. */
export const realEngine: EngineClient = {
  post: enginePost,
  get: engineGet,
  query: engineQuery,
};

// ── Реализация Output ──

/** Реальный вывод в консоль. */
export const realOutput: Output = {
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
  exit: (code: number) => {
    process.exitCode = code;
    process.exit(code);
  },
};

// ── Реализация Target Resolver ──

/** Реальный резолвер цели (возвращает числовой ID для Engine API). */
export const realResolveTarget: TargetResolver = async (target) => {
  return resolveTarget(target);
};

// ── Фабрика контекста команды ──

import type { CliContext } from "./cli-types.js";

/** Создаёт реальный контекст команды. */
export function createRealContext(): CliContext {
  return {
    engine: realEngine,
    output: realOutput,
    resolveTarget: realResolveTarget,
    currentChatId: currentChatIdFromEnv(),
  };
}

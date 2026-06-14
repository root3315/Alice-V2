/**
 * Единый модуль логирования. На основе consola, с цветным выводом.
 *
 * ADR-54: error/warn/fatal также пишутся в отдельный файл alice-errors.log,
 * для быстрого поиска аномалий через `tail -f alice-errors.log` или `grep`.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { createConsola } from "consola";
import { ALICE_ERROR_LOG_PATH, ensureParentDir } from "../runtime-paths.js";

const root = createConsola({
  level: process.env.LOG_LEVEL === "debug" ? 4 : 3,
});

// ADR-54: Ошибки в отдельный файл — error/warn/fatal → alice-errors.log
// В тестовой среде файл не пишется (во избежание замусоривания директории вывода CI)
let _errorStream: WriteStream | null = null;

if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
  ensureParentDir(ALICE_ERROR_LOG_PATH);
  _errorStream = createWriteStream(ALICE_ERROR_LOG_PATH, { flags: "a" });
  // H18: без error-listener сбой записи (диск полон / права) рушит весь процесс через
  // unhandled 'error' — ровно когда бот пишет ошибку. Гасим и отключаем файловый репортер.
  _errorStream.on("error", (err) => {
    _errorStream = null; // reporter уже null-safe (_errorStream?.write)
    console.error("alice-errors.log write failed, file logging disabled:", err);
  });
  root.addReporter({
    log(logObj) {
      // consola level: 0=fatal/error, 1=warn
      if (logObj.level > 1) return;
      const ts = new Date().toISOString();
      const tag = logObj.tag ? `[${logObj.tag}]` : "";
      const level = (logObj.type ?? "error").toUpperCase();
      const parts: string[] = [];
      for (const arg of logObj.args ?? []) {
        if (typeof arg === "string") parts.push(arg);
        else if (arg instanceof Error) parts.push(`${arg.message}\n${arg.stack ?? ""}`);
        else {
          try {
            parts.push(JSON.stringify(arg));
          } catch {
            parts.push(String(arg));
          }
        }
      }
      _errorStream?.write(`${ts} ${level} ${tag} ${parts.join(" ")}\n`);
    },
  });
}

/** Создаёт дочерний logger с тегом. */
export function createLogger(tag: string) {
  return root.withTag(tag);
}

export { root as logger };

/**
 * Bootstrap bundled static assets into $ALICE_HOME.
 *
 * `irc send-file` can only upload files that live under $ALICE_HOME (see the
 * telegramUpload path guard in index.ts). Repo-tracked assets therefore have to
 * be mirrored into the runtime home on startup before they become send-able.
 *
 * Idempotent and defensive: copies the repo `assets/` tree into
 * `$ALICE_HOME/assets/` on every boot, never throws (asset plumbing must never
 * block startup).
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ALICE_HOME } from "../core/shell-executor.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bootstrap-assets");

/** Repo-tracked bundled assets (runtime/assets). */
const BUNDLED_ASSETS_DIR = resolve(import.meta.dirname ?? ".", "..", "..", "assets");

/**
 * Mirror runtime/assets → $ALICE_HOME/assets so bundled media (e.g. the
 * Auserlese verdict card) passes the send-file ALICE_HOME guard.
 */
export function ensureBundledAssets(): void {
  try {
    if (!existsSync(BUNDLED_ASSETS_DIR)) return;
    const target = resolve(ALICE_HOME, "assets");
    mkdirSync(target, { recursive: true });
    cpSync(BUNDLED_ASSETS_DIR, target, { recursive: true, force: true });
    log.info("Bundled assets mirrored into ALICE_HOME", { from: BUNDLED_ASSETS_DIR, to: target });
  } catch (err) {
    log.warn("Failed to mirror bundled assets", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

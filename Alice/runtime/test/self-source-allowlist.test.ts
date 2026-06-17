/**
 * Безопасность самочтения (`irc self-source`): read-only, и СТРОГО без секретов/данных.
 * Алисе можно читать SOUL.md, src/**.ts, docs/**, README — и ничего больше.
 */
import { describe, expect, it } from "vitest";
import { isAllowedSelfPath, isListableDir } from "../src/engine-api/routes/self-source.js";

describe("self-source — allowlist чтения", () => {
  it("разрешает SOUL.md, src/**.ts, docs/**, README", () => {
    expect(isAllowedSelfPath("SOUL.md")).toBe(true);
    expect(isAllowedSelfPath("SOUL.ojou.md")).toBe(true);
    expect(isAllowedSelfPath("src/mods/soul.mod.ts")).toBe(true);
    expect(isAllowedSelfPath("docs/adr/174-persona-facets.md")).toBe(true);
    expect(isAllowedSelfPath("README.md")).toBe(true);
  });

  it("БЛОКИРУЕТ секреты и данные", () => {
    expect(isAllowedSelfPath(".env")).toBe(false);
    expect(isAllowedSelfPath("alice.db")).toBe(false);
    expect(isAllowedSelfPath("config.toml")).toBe(false);
    expect(isAllowedSelfPath("src/whatever.session")).toBe(false);
    expect(isAllowedSelfPath("node_modules/pkg/index.ts")).toBe(false);
    expect(isAllowedSelfPath(".git/config")).toBe(false);
    expect(isAllowedSelfPath("alice-errors.log")).toBe(false);
  });

  it("БЛОКИРУЕТ обход пути (..)", () => {
    expect(isAllowedSelfPath("../.env")).toBe(false);
    expect(isAllowedSelfPath("src/../../secret")).toBe(false);
    expect(isAllowedSelfPath("..")).toBe(false);
  });

  it("блокирует не-исходные файлы", () => {
    expect(isAllowedSelfPath("src/data.json")).toBe(false); // не .ts
    expect(isAllowedSelfPath("package.json")).toBe(false);
    expect(isAllowedSelfPath("")).toBe(false);
  });

  it("листать можно только корень / src / docs", () => {
    expect(isListableDir(".")).toBe(true);
    expect(isListableDir("")).toBe(true);
    expect(isListableDir("src")).toBe(true);
    expect(isListableDir("src/mods")).toBe(true);
    expect(isListableDir("docs")).toBe(true);
    expect(isListableDir("node_modules")).toBe(false);
    expect(isListableDir("../etc")).toBe(false);
  });
});

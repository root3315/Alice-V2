/**
 * 编译 system-bin CLI 脚本为自包含 Node.js 可执行文件。
 *
 * 产物输出到 dist/bin/，每个文件是带 shebang 的 ESM bundle，
 * 容器内只需 `node` 即可运行——不依赖 tsx、citty 或任何 npm 包。
 *
 * Usage: node --import tsx scripts/build-bin.ts
 */

import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const SRC_DIR = resolve(ROOT, "skills/system-bin");
const OUT_DIR = resolve(ROOT, "dist/bin");

mkdirSync(OUT_DIR, { recursive: true });

// 收集所有 .ts 入口（排除 _lib 等非入口文件）
const entries = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({
    name: f.replace(/\.ts$/, ""),
    path: resolve(SRC_DIR, f),
  }));

console.log(`Building ${entries.length} system-bin entries → dist/bin/`);

for (const entry of entries) {
  const outfile = resolve(OUT_DIR, entry.name);
  buildSync({
    entryPoints: [entry.path],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    // Node 内置模块不打包
    external: ["node:*"],
    // 输出不带 sourcemap（容器内不需要调试）
    sourcemap: false,
    // 压缩去注释
    minifySyntax: true,
    legalComments: "none",
  });
  chmodSync(outfile, 0o755);
  console.log(`  ✓ ${entry.name}`);
}

console.log("Done.");

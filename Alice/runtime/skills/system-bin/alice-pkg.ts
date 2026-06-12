/**
 * alice-pkg — Alice OS 包管理器 CLI 入口。
 *
 * 命令定义下沉到 `src/system/alice-pkg-cli.ts`，让 CLI 本体和 shell manual
 * 共用同一份 citty 定义。
 *
 * @see docs/adr/201-ai-native-os.md
 * @see docs/adr/235-cli-human-readable-output.md
 */

import { runMain } from "citty";
import { alicePkgCommand } from "../../src/system/alice-pkg-cli.ts";

await runMain(alicePkgCommand);

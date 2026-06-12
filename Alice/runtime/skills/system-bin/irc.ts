/**
 * irc — IRC-native Telegram system client (CLI 入口)。
 *
 * 命令定义下沉到 `src/system/irc-cli.ts`，避免 CLI 本体和 shell manual
 * 各自维护一份子命令签名。
 *
 * @see docs/adr/238-citty-native-cli-redesign.md
 */

import { runMain } from "citty";
import { ircCommand, validateIrcRawArgs } from "../../src/system/irc-cli.ts";

const rawArgs = process.argv.slice(2);
await validateIrcRawArgs(rawArgs);
await runMain(ircCommand, { rawArgs });

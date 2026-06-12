# Alice system-bin

These commands are built by `pnpm run build:bin` and emitted into `runtime/dist/bin/`.

Current entries:

- `irc`: IRC-like Telegram facade for chat actions such as `say`, `reply`, `react`, `read`, `tail`, `who`, `topic`, `join`, and `leave`
- `self`: perception, memory, bookkeeping, and command/query bridge
- `alice-pkg`: Alice OS package manager for `search`, `install`, `remove`, `upgrade`, and `rollback`

## Important

- `self` absorbed the old `engine` CLI. New deployments must build and ship `self`; there is no separate `engine.ts` entry in this directory anymore.
- If runtime startup or `alice doctor` reports missing system-bin commands, rebuild them from `runtime/`:

```bash
pnpm run build:bin
test -x dist/bin/irc
test -x dist/bin/self
test -x dist/bin/alice-pkg
```

System commands live beside installed app commands, but remain engine-owned.
Use `<command> --help` for usage details.

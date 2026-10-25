# Bots client logic

The client for the Bots daemon: domain types, the wire codec, the socket and the view
models. The UI lives in the Eagle app (`apps/macos`), which depends on this package —
this package depends on nothing from Eagle.

```sh
swift test                  # logic plus an integration test that spawns the daemon
./Scripts/coverage.sh       # 90% logic coverage gate
```

The integration test starts the production daemon (`apps/bots/scripts/serve.ts`) on a
temporary root and the stub model endpoint (`apps/bots/scripts/stub-model.ts`), so the
only fake is the model network. Point the Eagle app at a daemon with `BOTS_ROOT` and
`BOTS_PORT` (defaults: `~/.local/share/eagle-bots`, `43117`); `BOTS_OPEN=1` selects the
first bot on launch, which is handy for a demo shell.

Contract: [PROTOCOL.md](../../docs/bots/PROTOCOL.md); layout and layer rules:
[ARCHITECTURE.md](../../docs/bots/ARCHITECTURE.md); what is built and next:
[PLAN.md](../../docs/bots/PLAN.md).

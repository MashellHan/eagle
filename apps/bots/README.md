# Bots daemon

Local multi-bot chat daemon. Each bot is one independent durable conversation
backed by [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi).

This is an **isolated project** inside the repository: its own npm project, own
lockfile, own lint and test gates. It shares nothing with the Eagle website,
Worker or Agent; the only shared code in the whole product is
`apps/macos/Sources/EagleDesign`, used by the separate client package
`apps/bots-macos`.

The contract is documentation-first:

| Document | Owns |
| --- | --- |
| [PRODUCT.md](../../docs/bots/PRODUCT.md) | Scope, decisions, journeys, speed targets |
| [ARCHITECTURE.md](../../docs/bots/ARCHITECTURE.md) | Layers, ports, lifecycle, isolation |
| [PROTOCOL.md](../../docs/bots/PROTOCOL.md) | Wire format v1 and its fixtures |
| [RUNTIME.md](../../docs/bots/RUNTIME.md) | pi-durable mapping, probed facts, recovery |
| [OBSERVABILITY.md](../../docs/bots/OBSERVABILITY.md) | Layer logging and trace rules |
| [TESTING.md](../../docs/bots/TESTING.md) | Test ladder, fakes, gates |

## Status

Phase 1, implementation starting. No daemon code exists yet; the repository holds
the contract, the protocol fixtures and a model smoke script.

## Setup

Node ≥ 24 (pi-durable needs ≥ 22.19; verified on Node 26.12.0). Runtime TypeScript
goes through Node's type stripper, so there is no build step and only erasable
syntax (`type`, `interface`, `satisfies`; no `enum` or `namespace`).

```sh
cd apps/bots
npm install
cp .env.example .env      # then fill BOTS_API_KEY
chmod 600 .env
```

`.env` is ignored by Git and must never be committed. It holds:

| Variable | Meaning |
| --- | --- |
| `BOTS_BASE_URL` | Model endpoint, OpenAI Responses shape (`POST /responses`) |
| `BOTS_API_KEY` | Bearer key for that endpoint |
| `BOTS_PROVIDER` | Provider id stored in `bot.json` and the protocol |
| `BOTS_MODEL` | Pinned development model |

## Commands

```sh
npm run smoke:model    # one real conversation against BOTS_BASE_URL, prints timings
npm test               # fast gate
npm run typecheck
npm run lint
npm run coverage       # enforced thresholds
npm run check          # everything above except coverage, in gate order
```

`smoke:model` never prints the key and exits non-zero when the endpoint, the model
or the conversation fails.

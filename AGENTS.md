# Eagle engineering

- Implement on `main` with coherent atomic commits. Preserve user changes. The integrating agent owns writes; reviewers in the Herdr Space are read-only.
- Strict TDD: first demonstrate a failing behavior, then implement the smallest fix and run the affected checks. `npm run check` and `npm run test:browser` are release gates. Use real Miniflare/D1 in API tests, isolated from development storage.
- Fixed stack: Vite, Biome, TypeScript 7.0.2. All controls and application chrome use @nocoo/basalt. Follow its installed integration docs; no second component or color system.
- Tokens live only in secure configuration. Never put them in report payloads, D1, URLs, source, browser storage, screenshots, or command arguments. Authentication errors fail closed.
- Preserve versioned whole-machine snapshots, idempotency, capture ordering, session-scoped identities, explicit freshness and evidence provenance. Lifecycle badges never certify task completion. Missing data remains unknown.
- Local: eagle.dev.hexly.ai -> 6001 Vite -> 36001 Worker. Browser tests: 26001. Public: eagle.hexly.ai.
- For long implementation work, record a user-view checkpoint every 15 minutes in docs/CHECKPOINTS.md: actual Herdr collection, authentication, D1, page rendering and the next broken hop. Release requires scripts/verify-live.ts against the real local and public origins.

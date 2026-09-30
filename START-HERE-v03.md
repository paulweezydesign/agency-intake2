# v0.3.0 development snapshot

This archive contains the v0.2.0 baseline plus unfinished v0.3 source additions. It is not a completed v0.3 release; package.json intentionally still identifies the baseline as 0.2.0.

New files: src/providers.ts, src/model-session.ts, src/research-contracts.ts, src/research.ts, test/providers.test.ts, test/research.test.ts.

Remaining work: wire the new model session/provider configuration into the planner and CLI, implement the live research runner and credential-check command, validate follow-up/restart memory, and run live trials with credentials. No live-provider results are claimed.

Validation at export: TypeScript fails at src/model-session.ts:28 (boolean is not assignable to number). The full test run has not completed at export. Earlier VALIDATION.md and results describe the v0.2 baseline, not these new additions.

No credentials or node_modules are included. Keep credentials in a local .env file; do not commit it. Read README.md for the baseline setup instructions.

# Validation record

## Version 0.2.0 — September 27, 2026

Environment: Linux, Node.js 24.19.0, MongoDB 8.2.6. Installed from the pinned lockfile with dependency lifecycle scripts disabled. No new dependencies or dependency upgrades were introduced.

| Check | Executed result |
|---|---|
| Original baseline before edits | 8/8 tests passed |
| Test-first delivery suite | Failed before implementation because the baseline/delivery modules did not exist; initial six tests passed after implementation |
| Type check | Passed against installed pinned packages |
| Full suite after changes | 16 passed, 0 failed, 0 skipped |
| Process-kill recovery | 2/2 paths passed; a real child process was killed with SIGKILL after the destination write, then a fresh child recovered the original project |
| Controlled fixture comparison | 40/40 runs passed, 20 per arm; zero duplicate destination projects |
| Native dependency audit | 0 known vulnerabilities reported |

Fixture timing in this environment:

| Path | Median | p95 | Samples |
|---|---:|---:|---:|
| Plain state machine | 9.36 ms | 16.59 ms | 20 |
| Mastra workflow | 23.57 ms | 199.43 ms | 20 |

These descriptive timings cover draft, approval, fake project creation, duplicate approval, and duplicate delivery. Connection setup is excluded; first-operation initialization is included. The process-kill demonstration ran concurrently with this measurement, so host load and cold initialization can affect the values. The sample is small and has no live model work. Do not extrapolate production latency, cost, or throughput from it.

Evidence: `results/tests-v0.2.txt`, `results/typecheck-v0.2.txt`, `results/process-recovery.txt`, `results/comparison.json`, `results/comparison.txt`, and `results/audit-v0.2.json`. Earlier evidence remains in its original files. Expected invalid-model errors appear in test output because the original negative test deliberately triggers Mastra error logging; the final test summary determines success.

### Review performed for this change

Self-review using the Code Review and Quality and Security and Hardening skills. Checked atomic intent creation, immutable approval, bounded/strict request schemas, tenant filters, stable operation keys, destination insert races, response validation, and conflicting receipts. The lockfile change only updates the package version. No secrets or unreviewed lifecycle scripts were added.

Two additional checks verify that separate intakes for the same project reuse its creation, a changed approved scope conflicts, and opposing concurrent baseline decisions cannot both succeed. Destination records compare the complete request fingerprint as well as the proposal hash.

No unresolved blocking issue was found for the local fixture scope. This was not an independent review or production approval. Known gaps remain: real destination adapter, destination timeouts, background scheduling, project-level authorization, data lifecycle controls, arbitrary workflow-engine recovery, and live model/OM validation. The fake destination demonstrates a required contract, not a guarantee for third-party services.

## Historical version 0.1.0 validation

Date: September 25, 2026. Environment: Linux, Node.js 24.19.0, npm 11.9.0, MongoDB 8.2.6.

## Executed

| Check | Result and scope |
|---|---|
| Clean lockfile installation | `npm ci --ignore-scripts` succeeded |
| Type checking | `npm run typecheck` passed against the pinned Mastra packages |
| Integration tests | 8 passed, 0 failed, 0 skipped; actual temporary MongoDB and actual Mastra workflow engine |
| CLI demo | Draft, recovery, approval, and repeated approval completed in separate Node processes |
| Fixture comparison | 30/30 workflow runs completed; paired direct/planned outputs saved |
| Dependency audit | No known vulnerabilities reported by `npm audit` at validation time |

The fixture comparison recorded direct-call p95 0.240 ms and workflow-to-approval p95 147.612 ms on one sequential run. These values describe a deterministic planner and local database, exclude human approval time, and do not estimate live LLM latency or production throughput. There were no provider calls in these executed checks.

## Test coverage

1. Persist a draft, close/recreate the app, resume approval without calling the planner again, and repeat approval without new assignments.
2. Deny cross-tenant reads/decisions and decisions by an actor without approval permission.
3. Reject stale plan hashes; preserve rejection as a terminal decision.
4. Reject unknown intake fields, whitespace/oversized briefs, and invalid model output; persist planner failure without assignments.
5. Submit eight concurrent approvals and verify one assignment batch. Busy callers may retry.
6. Reject a MongoDB query object supplied as a run ID.
7. Inject a committed decision/dispatch while the workflow snapshot is still suspended, then replay without duplicating assignments.
8. Check that memory resource/thread IDs separate tenants and runs.

The process-boundary CLI demo supplements test 1. Test 7 is a controlled durable-state injection; it is not a kill-at-every-instruction crash test. Test 8 validates identifier construction, not live memory retrieval isolation.

## Review performed

Applied the Code Review and Quality skill across correctness, readability, architecture, security, and performance.

Fixed two issues found during implementation/review and demonstrated them with failing regression tests first:

- Run IDs were only TypeScript-typed, allowing query objects at runtime. Application entry points now parse UUIDs before MongoDB queries.
- Planner failures left records labeled `drafting`. They now become `failed`, with zero assignments.

Other checks: plan schemas bound task count and text size; every public application lookup includes the authenticated-context tenant; decisions cannot be reversed; dispatch updates one document atomically; the model has no dispatch tools; secrets are excluded from the archive and Git.

## Remaining validation and implementation

- Live model calls, structured-output behavior, token cost, and plan quality require provider configuration.
- OM is configured but its Observer/Reflector have not been exercised. Long conversations and recall evaluation remain necessary.
- Semantic recall/vector retrieval and their authorization tests are not implemented in this slice.
- External specialist execution is not implemented; assignments are queued records.
- The CLI trusts the local operator. A network service needs verified authentication, project permissions, throttling, telemetry, and data lifecycle controls.
- Automatic recovery of arbitrary running/failed workflow snapshots and renewal/fencing under lease expiry remain future work. Supported recovery here is from a persisted approval suspension.

Conclusion: suitable for a local prototype and engineering review; not a production deployment or evidence that workflow planning outperforms direct planning.

# Execute one approved Research assignment

This adds an explicit, single-assignment Research worker to the existing intake CLI. It reads a supplied evidence packet, produces a cited report, and stores that report for human review. It does not browse, contact clients, execute other specialists, create an external project, or authorize implementation.

## Upgrade your existing checkout

Keep your existing `.env` and the same MongoDB database and tenant. Existing run IDs, approvals, and assignment IDs remain valid; no migration or reapproval is needed. Install with `npm ci`, then run `npm run typecheck`.

Keep the working Flash model. The example configuration now uses:

```dotenv
LLM_PROVIDER=nim
PM_MODEL=z-ai/glm-5.3-flash
MEMORY_MODEL=z-ai/glm-5.3-flash
RESEARCH_MODEL=z-ai/glm-5.3-flash
OUTPUT_MODE=prompt
```

Updating `.env.example` does not change your `.env`. If your current `.env` explicitly sets the full model for MEMORY_MODEL or RESEARCH_MODEL, change those entries too. Omitted memory/research model settings inherit PM_MODEL. Existing planner JSON-correction and NIM low-reasoning settings are preserved. Research uses the same low-reasoning setting, a 4096-token output cap, no automatic retry, and a 60-second model-call timeout. Provider behavior remains model-dependent.

## Run it in PowerShell

Set these variables to an existing approved run and its Research assignment from `show`:

```powershell
$runId = 'YOUR_RUN_ID'
$assignmentId = 'YOUR_RESEARCH_ASSIGNMENT_ID'
npm run cli -- show $runId
npm run cli -- research-packet $runId .\research-packet.json
```

The packet command exports only the saved client brief, with a capture timestamp. It refuses to overwrite an existing file. Review the packet before executing. Additional sources may be added as objects in `sources`, each with a unique `id`, descriptive `title`, UTC `retrievedAt`, and exact `text`; an HTTPS `url` is optional. URLs are citation metadata and are never fetched. Do not invent a public URL for private client notes. Max 8 sources, 16,000 characters each, 60,000 combined, and a 512 KB JSON file. If an unusually long intake brief exceeds a source limit, prepare multiple accurately labeled source excerpts manually.

Budget and launch date are not confirmed merely because the brief asks for confirmation. With only the original brief, expect a gap analysis and client questions—not completed discovery.

```powershell
npm run cli -- research $runId $assignmentId .\research-packet.json
npm run cli -- research-show $assignmentId
```

`research` calls the configured provider even if PLANNER_MODE is demo: it is an explicit live execution command. It requires AGENCY_CAN_APPROVE=true and persisted approval for this tenant/run/assignment. The evidence and brief are sent to the model provider. Inspect sources before doing so.

Success returns `status: "awaiting_qa"`, an `artifact`, and `artifactHash`. Token/latency metrics are emitted to stderr; report JSON goes to stdout. These are reported model usage values, not a complete billing ledger. Failed calls may have unknown token counts.

## Review the report

Check whether each quote supports its claim, whether the source is trustworthy, and whether limitations accurately identify missing answers. Mechanical citation checks prove only that a quote exists in the supplied source, not that the claim follows from it.

Create `research-review.json` with the exact returned artifact hash and your decision:

```json
{
  "artifactHash": "COPY_THE_64_CHARACTER_ARTIFACT_HASH_HERE",
  "accepted": true,
  "notes": "Reviewed against the supplied brief. Budget and date still require client confirmation."
}
```

```powershell
npm run cli -- research-review $assignmentId .\research-review.json
npm run cli -- research-show $assignmentId
```

Use `accepted: false` when changes are needed. Review is bound to the artifact hash and is immutable; a conflicting later decision is rejected. Accepting a gap-analysis report does not mean the client's budget/date are confirmed or that all assignment acceptance criteria are met. It does not release engineering.

## State and recovery

- Intake `dispatched` and assignment `queued` are the original dispatch record. Read the separate Research job via `research-show` for execution and review state: running, failed, awaiting_qa, accepted, or changes_requested.
- A completed replay with the exact same packet returns the saved artifact without another model call. The packet, including timestamps, is immutable for that assignment after first execution. Do not regenerate it between retries.
- Invalid JSON, schema violations, invented source IDs, or non-verbatim quotes fail closed. Fix provider settings and retry the same command and packet if status is failed.
- An interrupted running attempt becomes eligible for retry after its three-minute lease expires. A recovered attempt can incur another model charge; only the winning attempt can publish. This is not exactly-once billing.
- The CLI intentionally avoids printing raw provider/driver errors. On failure check arguments, `.env`, MongoDB access, tenant, approval, assignment role, packet format, and output mode; use `research-show` to inspect persisted state. Typecheck and tests are separate diagnostics.
- A different packet conflicts; automatic revision cycles are not implemented. For genuinely changed evidence or requirements, create and approve a new intake rather than editing an approved plan, deleting the job, or bypassing review.
- `projectDelivery: pending` is independent of Research and remains unchanged.

## Verification and boundaries

Run `npm test` and `npm run typecheck`. The new tests use real local MongoDB, an injected deterministic Research runner, and a local OpenAI-compatible protocol server through the actual Mastra adapter. They cover CLI routing, persisted replay, tenant/role restrictions, citations, tamper detection, stale-worker fencing, immutable QA, prompt/schema output, and conversation persistence across session restarts. Protocol token counts are synthetic. These tests do not measure live GLM report quality or observational-memory compression quality.

This is a trusted local-operator CLI, not a network authentication service. Keep .env, evidence packets, generated reports, and review notes out of Git. No new dependencies are added. Automated specialist scheduling and client-confirmation gates for future implementation workers remain future work.

# Bounded live comparison

## Question

Does an explicit intake workflow improve completion and recovery sufficiently to justify its operational overhead compared with a direct Project Manager planning call?

## Implemented baseline

`scripts/benchmark.ts` compares a direct planner call plus schema validation against workflow execution through the persisted approval pause. Both use the same planner, strict plan schema, 30 briefs, and fresh run IDs. Each workflow plan is then approved by the test harness to verify queue completion.

This baseline is **direct planning**, not a complete autonomous multi-agent agency. The fixture run checks wiring. It cannot establish a quality advantage for either architecture.

## Run with a provider

After setting a development MongoDB connection and provider credentials in `.env`:

```sh
node --env-file=.env --import tsx scripts/benchmark.ts
```

Set `PLANNER_MODE=live` in that file. This makes up to 60 planning calls, plus any memory/provider overhead. The script stops on the first error. A unique `agency_bench_*` database holds the run data for inspection; it is not automatically deleted on live runs. Raw paired drafts are saved to `results/live-benchmark.json`.

Use synthetic cases only. The script reports elapsed time; token usage and live dollar cost remain `null`. Obtain actual usage from provider billing/telemetry rather than inferring it from prompt length. Do not run a paid trial until you have set a provider-side budget cap.

## Proposed next evaluation

1. Freeze the lockfile, model identifiers, cases, prompts, and MongoDB deployment.
2. Randomize which condition runs first, repeat each case three times, and measure cold starts separately. The included smoke script currently uses one direct-first repetition.
3. Blind-review each draft against the rubric below. Record reviewer and disagreement resolution.
4. Record input/output tokens, memory-model tokens, elapsed time, retry count, approval corrections, and dollars per accepted plan.
5. Run the recovery tests under actual worker termination at drafting, approval, and dispatch boundaries. Test slow I/O and lease expiry too.
6. Stop on any tenant data leak, unapproved assignment, duplicate external effect, or exhausted provider budget. Investigate before continuing.

## Proposed rubric and thresholds — not measured outcomes

Score each dimension 0 (missing/incorrect), 1 (partly useful), or 2 (sufficient):

| Dimension | Sufficient means |
|---|---|
| Scope | Preserves requested outcomes and excludes unapproved expansions |
| Unknowns | Identifies consequential missing facts without fabricating answers |
| Ownership | Assigns bounded work to suitable specialists |
| Acceptance | Supplies observable pass/fail criteria |
| Risk | Handles conflicting deadlines, unsupported promises, and access boundaries |

Candidate quality gate: at least 27/30 cases score at least 8/10 and have no access-control failure. These are starting proposals for review.

Candidate reliability gate: all approval and isolation tests pass; no duplicate assignment batch under 100 repeated/concurrent decisions. Latency and cost limits should be set after the first live sample; fixture timing is not a production SLO.

Keep observational-memory evaluation separate: use sufficiently long multi-turn transcripts, known facts, corrections, and cross-tenant negative controls. Confirm that observation generation actually occurred before measuring recall. A single intake call does not test long-horizon memory.

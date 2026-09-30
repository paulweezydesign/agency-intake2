# Changelog

## Unreleased — Research worker

### Added
- Explicit CLI commands to export intake evidence, execute one approved Research assignment, inspect its cited report, and record hash-bound human review.
- Protocol and MongoDB integration tests for model output, restart persistence, replay, stale workers, and tampered assignments.

### Fixed
- Invalid observational-memory reflection configuration in the draft.
- Research execution now verifies assignment content against the approved plan.
- Hosted-provider selection rejects inherited object properties.

### Changed
- Example memory and Research models now match the working GLM-5.3 Flash planner. Existing local .env files are not overwritten.
- Research sources may omit a URL for private client evidence.

## 0.2.0 — 2026-09-27

### Added
- Plain application state-machine baseline sharing the workflow's approval contracts.
- Atomic project-creation intent alongside queued assignments, with validated delivery receipts.
- Persistent fake destination that deduplicates concurrent creation and rejects changed payloads.
- Worker process-kill recovery demonstration for both orchestration paths.
- Forty-run comparison on identical fixtures, with raw samples and stated measurement limits.
- Regression coverage for lost responses, concurrent delivery, stale/unauthorized approvals, destination conflicts, and project identity across intake runs.

### Compatibility
- New runs receive delivery intents. Existing dispatched 0.1 records are not backfilled.
- Real model calls, real destination integrations, and specialist execution remain outside the executed fixture scope.

## 0.1.0 — 2026-09-25

### Added
- Mastra intake workflow with persisted human approval and MongoDB assignment queue.
- Tenant access checks, strict plan validation, and immutable decisions tied to a plan hash.
- CLI and a demo that restores the draft in a new process.
- Deterministic 30-case comparison harness and optional live planner with observational memory.
- Recovery, concurrency, access-control, and input-validation integration tests.

# Onboarding recovery contract

Research-to-code slice, September 27, 2026. Built on the saved agency intake 0.1.0 prototype. Direct dependency versions are unchanged.

## Decision and bounded scope

Compare a plain application state machine with the Mastra workflow around the same deterministic planner, MongoDB repository, approval policy, and delivery worker. The PM may produce a proposal; it cannot approve the proposal or create a project. The fixture destination is a separate MongoDB database, not an external SaaS integration.

The existing Mastra workflow is retained as the agency candidate because it exposes explicit steps and suspension. The simpler baseline is adequate for this small control flow. Local timing data does not establish model quality or justify a production orchestrator by itself.

## Authority and trust boundaries

- Principals are supplied by a trusted local operator. A future HTTP service must derive tenant, identity, and reviewer permission from verified authentication. Request JSON and LLM output cannot set them.
- Client input and planner output pass strict schemas. Approval is immutable and bound to the persisted plan hash. Rejection is terminal for that intake.
- The delivery worker reloads the approved record and checks the intent against its tenant/project identity and plan hash before calling a destination.
- The destination response is untrusted. Its schema, operation key, payload hash, and external ID are validated before recording completion.
- Observations are conversational context. They do not supply approval authority. The live planner's OM wiring is inherited from 0.1; this slice does not call a model or validate Observer/Reflector behavior.

## Delivery protocol

1. A single conditional MongoDB document update commits the queued assignments and pending project intent together. No gap exists between those two application writes.
2. The operation key hashes `['create-project:v1', tenantId, projectId]`. Its payload hash is the approved plan hash.
3. The destination atomically binds tenant + operation key to the complete request and one external ID. Concurrent replays return the same ID. Different content under the same key is a conflict.
4. The worker validates the receipt and conditionally stores it. Concurrent identical receipts converge. A conflicting receipt is rejected.
5. A crash between destination commit and application completion leaves the intent pending. A new process repeats the same request, obtains the original receipt, and completes it.

The fake destination uses a unique `_id` derived from tenant + key and `$setOnInsert`, then compares the stored request fingerprint. It is persistent across application/worker restarts while the demo MongoDB server runs. It is not a model of independent network partitions or database failover.

The guarantee is **one project per creation key, assuming the destination durably enforces that contract**. There is no universal exactly-once claim. Destinations without durable deduplication require reconciliation before resending an ambiguous request. Retain destination idempotency records for the entire supported replay period.

## Recovery boundaries and limits

- Each delivery invocation attempts one call; there is no automatic retry loop or unbounded scheduler. Destination timeouts/cancellation belong in a future real adapter.
- The process-kill demo kills the worker, not MongoDB. It validates acknowledged writes surviving a worker crash, not replica-set failover, majority durability, or regional recovery.
- The Mastra approval lease and operator-recovery behavior remain as documented in README. The new delivery worker can operate independently once a valid intent is committed.
- A changed plan for an existing tenant/project requires an explicit update workflow. Creating a new idempotency key to suppress the conflict is prohibited by the contract.
- Tenant-level operator access is supported; project-level membership, HTTP authentication, retention/deletion, and deployment are future work.
- Existing 0.1 dispatched records are not migrated. A new development database is the recommended test target.

## Validation scope

Correctness gates: zero effects before approval; rejection and stale approvals cannot dispatch; cross-tenant access is denied; conflicting decisions cannot both win; duplicate deliveries produce one project; wrong receipts stay pending; worker termination after an effect can recover the original project.

The comparison uses ten fixed briefs, two repeats, and two orchestrators. The model and destination are deterministic, runs are sequential, and engine order alternates. Timings include draft, approval, creation, duplicate approval, and duplicate delivery; connection setup is excluded, but first-operation initialization is included. No warm-up is discarded. Treat percentiles from 20 samples per arm as descriptive only.

The earlier proposed 60-run live-agent experiment remains unexecuted. Before that stage: select a model/provider, use a spending cap, add long-conversation persistence checks, and verify the durable-agent OM issue against the pinned runtime. A free-form direct-agent comparison must enforce the same approval and destination boundaries.

## Primary references

Checked September 27, 2026:

- MongoDB atomicity and conditional updates: https://www.mongodb.com/docs/manual/core/write-operations-atomicity/
- Mastra suspend/resume: https://mastra.ai/docs/workflows/suspend-and-resume

Installed pinned packages were type-checked and exercised. The design recommendations and fake-destination protocol are application-level choices, not additional framework guarantees.

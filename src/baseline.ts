import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { principalSchema, intakeSchema, planSchema, decisionSchema, type Planner } from './contracts.js';
import { Repository } from './repository.js';

// Deliberately simple comparison: the same contracts and persistence, no workflow engine.
export async function createBaselineApp(config: { uri: string; dbName: string; planner: Planner }) {
  const client = await new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000 }).connect();
  const repo = new Repository(client.db(config.dbName));
  return {
    async start(principal: unknown, body: unknown) {
      const actor = principalSchema.parse(principal);
      const input = { ...intakeSchema.parse(body), tenantId: actor.tenantId, runId: randomUUID() };
      await repo.create(input);
      try {
        await repo.savePlan(input, planSchema.parse(await config.planner(input)));
      } catch {
        await repo.failDraft(actor.tenantId, input.runId);
        throw new Error(`Draft failed; runId=${input.runId}`);
      }
      return repo.get(actor.tenantId, input.runId);
    },
    async get(principal: unknown, runId: string) {
      const actor = principalSchema.parse(principal);
      return repo.get(actor.tenantId, z.uuid().parse(runId));
    },
    async decide(principal: unknown, runId: string, body: unknown) {
      const actor = principalSchema.parse(principal);
      runId = z.uuid().parse(runId);
      if (!actor.canApprove) throw new Error('Forbidden');
      const decision = decisionSchema.parse(body);
      await repo.decide(actor.tenantId, runId, actor.userId, decision.approved, decision.planHash);
      return repo.dispatch(actor.tenantId, runId);
    },
    async close() { await client.close(); },
  };
}

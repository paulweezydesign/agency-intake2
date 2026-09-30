import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { Mastra } from '@mastra/core';
import { MongoDBStore } from '@mastra/mongodb';
import { z } from 'zod';
import { principalSchema, intakeSchema, decisionSchema, type Planner } from './contracts.js';
import { Repository } from './repository.js';
import { buildWorkflow } from './workflow.js';

export async function createApp(config: { uri: string; dbName: string; planner: Planner }) {
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const repo = new Repository(client.db(config.dbName));
  const storage = new MongoDBStore({ id: 'agency-storage', uri: config.uri, dbName: config.dbName });
  const workflow = buildWorkflow(repo, config.planner);
  const mastra = new Mastra({ storage, workflows: { intake: workflow } });
  const registered = mastra.getWorkflow('intake');
  return {
    async start(principal: unknown, body: unknown) {
      const actor = principalSchema.parse(principal);
      const input = { ...intakeSchema.parse(body), tenantId: actor.tenantId, runId: randomUUID() };
      await repo.create(input);
      try {
        const run = await registered.createRun({ runId: input.runId, resourceId: actor.tenantId });
        const result = await run.start({ inputData: input });
        if (result.status !== 'suspended') throw new Error('Draft did not reach approval');
      } catch {
        await repo.failDraft(actor.tenantId, input.runId);
        throw new Error(`Workflow failed; runId=${input.runId}`);
      }
      return repo.get(actor.tenantId, input.runId);
    },
    async get(principal: unknown, runId: string) {
      const actor = principalSchema.parse(principal);
      runId = z.uuid().parse(runId);
      return repo.get(actor.tenantId, runId);
    },
    async decide(principal: unknown, runId: string, body: unknown) {
      const actor = principalSchema.parse(principal);
      runId = z.uuid().parse(runId);
      if (!actor.canApprove) throw new Error('Forbidden');
      const decision = decisionSchema.parse(body);
      await repo.get(actor.tenantId, runId);
      const token = await repo.acquire(actor.tenantId, runId);
      try {
        await repo.decide(actor.tenantId, runId, actor.userId, decision.approved, decision.planHash);
        const state = await registered.getWorkflowRunById(runId);
        if (state?.status !== 'success') {
          if (state?.status !== 'suspended') throw new Error('Run requires operator recovery');
          const run = await registered.createRun({ runId });
          const result = await run.resume({ step: 'human-approval', resumeData: { wake: true } });
          if (result.status !== 'success') throw new Error(`Resume failed: ${result.status}`);
        }
        return repo.get(actor.tenantId, runId);
      } finally { await repo.release(actor.tenantId, runId, token); }
    },
    async close() { await storage.close(); await client.close(); },
  };
}

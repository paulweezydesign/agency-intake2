import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { envelopeSchema, planSchema, type Planner } from './contracts.js';
import type { Repository } from './repository.js';

export function buildWorkflow(repo: Repository, planner: Planner) {
  const draft = createStep({
    id: 'draft-plan', inputSchema: envelopeSchema, outputSchema: envelopeSchema,
    execute: async ({ inputData }) => {
      const record = await repo.get(inputData.tenantId, inputData.runId);
      if (!record.plan) await repo.savePlan(inputData, planSchema.parse(await planner(inputData)));
      return inputData;
    },
  });
  const approve = createStep({
    id: 'human-approval', inputSchema: envelopeSchema, outputSchema: envelopeSchema,
    resumeSchema: z.object({ wake: z.literal(true) }),
    suspendSchema: z.object({ planHash: z.string() }),
    execute: async ({ inputData, suspend }) => {
      const record = await repo.get(inputData.tenantId, inputData.runId);
      // Authority comes from our persisted decision, never from model or resume payload.
      if (!record.decision) return suspend({ planHash: record.planHash! });
      return inputData;
    },
  });
  const dispatch = createStep({
    id: 'queue-assignments', inputSchema: envelopeSchema,
    outputSchema: z.object({ runId: z.string(), status: z.enum(['rejected', 'dispatched']) }),
    execute: async ({ inputData }) => {
      const record = await repo.dispatch(inputData.tenantId, inputData.runId);
      if (record.status !== 'rejected' && record.status !== 'dispatched') throw new Error('Dispatch incomplete');
      return { runId: inputData.runId, status: record.status };
    },
  });
  return createWorkflow({ id: 'agency-intake', inputSchema: envelopeSchema, outputSchema: dispatch.outputSchema })
    .then(draft).then(approve).then(dispatch).commit();
}

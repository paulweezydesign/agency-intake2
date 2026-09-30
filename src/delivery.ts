import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { digest, planSchema, principalSchema } from './contracts.js';
import { projectKey, projectRequestSchema, receiptSchema, type ProjectDestination } from './delivery-contracts.js';
import { Repository } from './repository.js';

export async function createDeliveryWorker(config: { uri: string; dbName: string; destination: ProjectDestination }) {
  const client = await new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000 }).connect();
  const repo = new Repository(client.db(config.dbName));
  return {
    async deliver(principal: unknown, runId: string) {
      const actor = principalSchema.parse(principal);
      if (!actor.canApprove) throw new Error('Forbidden');
      runId = z.uuid().parse(runId);
      const record = await repo.get(actor.tenantId, runId);
      const intent = record.projectDelivery;
      if (record.status !== 'dispatched' || !record.decision?.approved || !intent) {
        throw new Error('Approval required; no delivery intent');
      }
      const plan = planSchema.parse(record.plan);
      if (digest(plan) !== record.planHash || intent.payloadHash !== record.planHash ||
          intent.key !== projectKey(record.tenantId, record.projectId)) {
        throw new Error('Delivery intent does not match approved plan');
      }
      if (intent.status === 'delivered') {
        const receipt = receiptSchema.parse(intent.receipt);
        if (receipt.key !== intent.key || receipt.payloadHash !== intent.payloadHash) throw new Error('Receipt conflict');
        return receipt;
      }
      const request = projectRequestSchema.parse({
        key: intent.key, payloadHash: intent.payloadHash, tenantId: record.tenantId,
        projectId: record.projectId, scope: plan.scope,
      });
      // One attempt per call. Ambiguous failure preserves the intent for replay with the same key.
      // The destination must durably deduplicate concurrent requests and reject changed payloads.
      const receipt = receiptSchema.parse(await config.destination.createProject(request));
      if (receipt.key !== intent.key || receipt.payloadHash !== intent.payloadHash) throw new Error('Receipt conflict');
      return repo.completeDelivery(actor.tenantId, runId, receipt);
    },
    async close() { await client.close(); },
  };
}

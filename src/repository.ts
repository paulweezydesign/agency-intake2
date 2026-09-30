import type { Collection, Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { digest, type Envelope, type Plan } from './contracts.js';
import { projectKey, type ProjectDelivery, type Receipt } from './delivery-contracts.js';

export type Record = Envelope & {
  _id: string; status: 'drafting' | 'failed' | 'awaiting_approval' | 'approved' | 'rejected' | 'dispatched';
  plan?: Plan; planHash?: string;
  decision?: { approved: boolean; userId: string; at: string };
  assignments: Array<Plan['tasks'][number] & { id: string; status: 'queued' }>;
  projectDelivery?: ProjectDelivery;
  lease?: { token: string; until: Date };
};

export class Repository {
  readonly records: Collection<Record>;
  constructor(db: Db) { this.records = db.collection<Record>('agency_intakes'); }
  async create(input: Envelope) {
    await this.records.insertOne({ ...input, _id: input.runId, status: 'drafting', assignments: [] });
  }
  async get(tenantId: string, runId: string) {
    const record = await this.records.findOne({ _id: runId, tenantId });
    if (!record) throw new Error('Run not found');
    return record;
  }
  async savePlan(input: Envelope, plan: Plan) {
    await this.records.updateOne({ _id: input.runId, tenantId: input.tenantId, status: 'drafting' },
      { $set: { plan, planHash: digest(plan), status: 'awaiting_approval' } });
    return this.get(input.tenantId, input.runId);
  }
  async failDraft(tenantId: string, runId: string) {
    await this.records.updateOne({ _id: runId, tenantId, status: 'drafting' }, { $set: { status: 'failed' } });
  }
  async decide(tenantId: string, runId: string, userId: string, approved: boolean, planHash: string) {
    const record = await this.get(tenantId, runId);
    if (record.planHash !== planHash) throw new Error('Stale plan approval');
    await this.records.updateOne({ _id: runId, tenantId, status: 'awaiting_approval', planHash },
      { $set: { status: approved ? 'approved' : 'rejected', decision: { approved, userId, at: new Date().toISOString() } } });
    const current = await this.get(tenantId, runId);
    if (!current.decision || current.decision.approved !== approved) throw new Error('Decision conflict');
    return current;
  }
  async dispatch(tenantId: string, runId: string) {
    const record = await this.get(tenantId, runId);
    if (record.status === 'rejected' || record.status === 'dispatched') return record;
    if (record.status !== 'approved' || !record.plan || !record.decision?.approved) throw new Error('Approval required');
    // Commit the assignment batch and project creation intent in one atomic document update.
    const assignments = record.plan.tasks.map((task, index) => ({
      ...task, id: digest([tenantId, runId, record.planHash, index]), status: 'queued' as const,
    }));
    await this.records.updateOne({ _id: runId, tenantId, status: 'approved' },
      { $set: { status: 'dispatched', assignments, projectDelivery: {
        key: projectKey(tenantId, record.projectId), payloadHash: record.planHash!, status: 'pending',
      } } });
    return this.get(tenantId, runId);
  }
  async completeDelivery(tenantId: string, runId: string, receipt: Receipt) {
    await this.records.updateOne({ _id: runId, tenantId, status: 'dispatched',
      'projectDelivery.status': 'pending', 'projectDelivery.key': receipt.key,
      'projectDelivery.payloadHash': receipt.payloadHash,
    }, { $set: { 'projectDelivery.status': 'delivered', 'projectDelivery.receipt': receipt } });
    const record = await this.get(tenantId, runId);
    const stored = record.projectDelivery;
    if (stored?.status !== 'delivered' || digest(stored.receipt) !== digest(receipt)) throw new Error('Receipt conflict');
    return receipt;
  }
  async acquire(tenantId: string, runId: string) {
    const token = randomUUID();
    const result = await this.records.updateOne({ _id: runId, tenantId,
      $or: [{ lease: { $exists: false } }, { 'lease.until': { $lt: new Date() } }] },
    { $set: { lease: { token, until: new Date(Date.now() + 300_000) } } });
    if (!result.modifiedCount) throw new Error('Run busy; retry later');
    return token;
  }
  async release(tenantId: string, runId: string, token: string) {
    await this.records.updateOne({ _id: runId, tenantId, 'lease.token': token }, { $unset: { lease: '' } });
  }
}

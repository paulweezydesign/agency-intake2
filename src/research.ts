import { randomUUID } from 'node:crypto';
import { type Db, type Collection } from 'mongodb';
import { z } from 'zod';
import { digest, planSchema, principalSchema } from './contracts.js';
import { Repository, type Record as IntakeRecord } from './repository.js';
import { packetSchema, researchSchema, reviewSchema, hashSchema, checkCitations, type Packet, type Research } from './research-contracts.js';

type Task = IntakeRecord['assignments'][number];
export type ResearchRunner = (input: { brief: string; task: Task; packet: Packet; ids: { resource: string; thread: string } }) => Promise<unknown>;
export type ResearchJob = { _id: string; tenantId: string; runId: string; sourceHash: string; planHash: string;
  status: 'running' | 'failed' | 'awaiting_qa' | 'accepted' | 'changes_requested';
  token?: string; leaseUntil?: Date; packet: Packet; artifact?: Research; artifactHash?: string;
  citationsChecked?: number; qa?: { accepted: boolean; notes: string; userId: string; at: string } };

export class ResearchService {
  private readonly jobs: Collection<ResearchJob>;
  private readonly repo: Repository;
  constructor(db: Db) { this.jobs = db.collection<ResearchJob>('agency_research'); this.repo = new Repository(db); }
  async get(principal: unknown, assignmentId: string) {
    const actor = principalSchema.parse(principal);
    const job = await this.jobs.findOne({ _id: hashSchema.parse(assignmentId), tenantId: actor.tenantId });
    if (!job) throw new Error('Research job not found');
    return job;
  }
  async execute(principal: unknown, runId: string, assignmentId: string, evidence: unknown, runner: ResearchRunner) {
    const actor = principalSchema.parse(principal);
    if (!actor.canApprove) throw new Error('Forbidden');
    runId = z.uuid().parse(runId); assignmentId = hashSchema.parse(assignmentId);
    const record = await this.repo.get(actor.tenantId, runId);
    if (record.status !== 'dispatched' || !record.decision?.approved) throw new Error('Persisted approval required');
    const plan = planSchema.parse(record.plan);
    if (digest(plan) !== record.planHash) throw new Error('Approved plan integrity failure');
    const task = record.assignments.find(a => a.id === assignmentId);
    if (!task || task.role !== 'research') throw new Error('An approved Research assignment is required');
    const index = record.assignments.findIndex(a => a.id === assignmentId);
    const approvedTask = plan.tasks[index];
    if (!approvedTask || task.id !== digest([actor.tenantId, runId, record.planHash, index]) ||
      digest({ role: task.role, objective: task.objective, acceptance: task.acceptance }) !== digest(approvedTask)) {
      throw new Error('Approved assignment integrity failure');
    }
    const packet = packetSchema.parse(evidence);
    const sourceHash = digest(packet);
    // Replays share a durable job. The source packet is immutable for that assignment.
    try {
      await this.jobs.insertOne({ _id: assignmentId, tenantId: actor.tenantId, runId, sourceHash, planHash: record.planHash!,
        status: 'failed', packet });
    } catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error; }
    const job = await this.get(actor, assignmentId);
    if (job.runId !== runId || job.sourceHash !== sourceHash || job.planHash !== record.planHash) throw new Error('Research input conflict');
    if (job.artifact) return job;
    const token = randomUUID();
    const claimed = await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId,
      $or: [{ status: 'failed' }, { status: 'running', leaseUntil: { $lt: new Date() } }] },
    { $set: { status: 'running', token, leaseUntil: new Date(Date.now() + 180_000) } });
    if (!claimed.modifiedCount) throw new Error('Research busy; retry later');
    try {
      const artifact = researchSchema.parse(await runner({ brief: record.brief, task, packet,
        ids: { resource: digest([actor.tenantId, record.projectId, 'research']), thread: digest([actor.tenantId, assignmentId, token]) } }));
      const citationsChecked = checkCitations(artifact, packet);
      const artifactHash = digest({ artifact, sourceHash, planHash: record.planHash, assignmentId });
      const saved = await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, status: 'running', token },
        { $set: { artifact, artifactHash, citationsChecked, status: 'awaiting_qa' }, $unset: { token: '', leaseUntil: '' } });
      if (!saved.modifiedCount) throw new Error('Research lease lost; result discarded');
      return this.get(actor, assignmentId);
    } catch (error) {
      await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, status: 'running', token },
        { $set: { status: 'failed' }, $unset: { token: '', leaseUntil: '' } });
      throw error;
    }
  }
  async review(principal: unknown, assignmentId: string, body: unknown) {
    const actor = principalSchema.parse(principal);
    if (!actor.canApprove) throw new Error('Forbidden');
    const input = reviewSchema.parse(body);
    const job = await this.get(actor, assignmentId);
    if (!job.artifact || input.artifactHash !== job.artifactHash) throw new Error('Stale research artifact');
    await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, status: 'awaiting_qa', artifactHash: input.artifactHash },
      { $set: { status: input.accepted ? 'accepted' : 'changes_requested',
        qa: { accepted: input.accepted, notes: input.notes, userId: actor.userId, at: new Date().toISOString() } } });
    const current = await this.get(actor, assignmentId);
    if (!current.qa || current.qa.accepted !== input.accepted) throw new Error('QA decision conflict');
    return current;
  }
}

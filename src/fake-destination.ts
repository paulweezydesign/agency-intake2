import { randomUUID } from 'node:crypto';
import { MongoServerError, type Db, type Collection } from 'mongodb';
import { digest } from './contracts.js';
import { projectRequestSchema, type ProjectDestination, type ProjectRequest, type Receipt } from './delivery-contracts.js';

type FakeProject = ProjectRequest & { _id: string; externalId: string; requestHash: string };

// Test destination backed by a separate MongoDB database. No external project service is called.
export class MongoProjectDestination implements ProjectDestination {
  readonly projects: Collection<FakeProject>;
  constructor(db: Db) { this.projects = db.collection<FakeProject>('fake_projects'); }
  async createProject(input: ProjectRequest): Promise<Receipt> {
    const request = projectRequestSchema.parse(input);
    const _id = digest([request.tenantId, request.key]);
    const requestHash = digest(request);
    try {
      await this.projects.updateOne({ _id }, { $setOnInsert: {
        ...request, requestHash, externalId: randomUUID(),
      } }, { upsert: true });
    } catch (error) {
      // An insert race can lose to the unique _id index; inspect the winner below.
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
    }
    const stored = await this.projects.findOne({ _id });
    if (!stored || stored.requestHash !== requestHash) throw new Error('Destination idempotency conflict');
    return { key: stored.key, payloadHash: stored.payloadHash, externalId: stored.externalId };
  }
}

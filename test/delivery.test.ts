import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { createBaselineApp } from '../src/baseline.js';
import { createDeliveryWorker } from '../src/delivery.js';
import { MongoProjectDestination } from '../src/fake-destination.js';
import { demoPlanner } from '../src/planner.js';
import { planSchema } from '../src/contracts.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let serial = 0;
const owner = { tenantId: 'tenant-a', userId: 'reviewer', canApprove: true };
const brief = { projectId: 'website', brief: 'Build an accessible five page website with contact form.' };
before(async () => {
  mongo = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
  });
  client = await new MongoClient(mongo.getUri()).connect();
});
after(async () => { await client?.close(); await mongo?.stop(); });

for (const [name, factory] of [['baseline', createBaselineApp], ['mastra', createApp]] as const) {
  test(`${name}: approval gates external delivery; recovery and duplicates preserve one project`, async () => {
    const dbName = `delivery_${++serial}`;
    let app = await factory({ uri: mongo.getUri(), dbName, planner: demoPlanner });
    const destination = new MongoProjectDestination(client.db(`${dbName}_destination`));
    let worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination });
    try {
      const pending = await app.start(owner, brief);
      await assert.rejects(worker.deliver(owner, pending.runId), /approval required/i);
      await assert.rejects(app.decide(owner, pending.runId, { approved: true, planHash: '0'.repeat(64) }), /stale/i);
      await assert.rejects(app.decide({ ...owner, canApprove: false }, pending.runId,
        { approved: true, planHash: pending.planHash! }), /forbidden/i);
      await assert.rejects(app.decide({ ...owner, tenantId: 'other' }, pending.runId,
        { approved: true, planHash: pending.planHash! }), /not found/i);
      await app.close();
      app = await factory({ uri: mongo.getUri(), dbName, planner: async () => { throw new Error('Unexpected replan'); } });
      const approved = await app.decide(owner, pending.runId, { approved: true, planHash: pending.planHash! });
      assert.equal(approved.projectDelivery?.status, 'pending');
      const duplicate = await app.decide(owner, pending.runId, { approved: true, planHash: pending.planHash! });
      assert.deepEqual(duplicate.decision, approved.decision);
      assert.deepEqual(duplicate.projectDelivery, approved.projectDelivery);
      await assert.rejects(worker.deliver({ ...owner, tenantId: 'other' }, pending.runId), /not found/i);
      await assert.rejects(worker.deliver({ ...owner, canApprove: false }, pending.runId), /forbidden/i);

      // The destination commits, but the caller receives an ambiguous failure.
      await worker.close();
      worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination: {
        async createProject(request) {
          await destination.createProject(request);
          throw new Error('Response lost after destination commit');
        },
      } });
      await assert.rejects(worker.deliver(owner, pending.runId), /response lost/i);
      assert.equal(await destination.projects.countDocuments(), 1);
      assert.equal((await app.get(owner, pending.runId)).projectDelivery?.status, 'pending');
      await worker.close();
      worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination });
      const receipts = await Promise.all(Array.from({ length: 8 }, () => worker.deliver(owner, pending.runId)));
      assert.equal(new Set(receipts.map(receipt => receipt.externalId)).size, 1);
      assert.equal(await destination.projects.countDocuments(), 1);
      assert.equal((await app.get(owner, pending.runId)).projectDelivery?.status, 'delivered');
      const before = await app.get(owner, pending.runId);
      await app.decide(owner, pending.runId, { approved: true, planHash: pending.planHash! });
      assert.deepEqual((await app.get(owner, pending.runId)).projectDelivery, before.projectDelivery);
    } finally { await worker.close(); await app.close(); }
  });

  test(`${name}: rejected proposal is terminal and creates no delivery intent`, async () => {
    const dbName = `rejection_${++serial}`;
    const app = await factory({ uri: mongo.getUri(), dbName, planner: demoPlanner });
    const destination = new MongoProjectDestination(client.db(`${dbName}_destination`));
    const worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination });
    try {
      const run = await app.start(owner, brief);
      const rejected = await app.decide(owner, run.runId, { approved: false, planHash: run.planHash! });
      assert.equal(rejected.projectDelivery, undefined);
      assert.equal(rejected.assignments.length, 0);
      await assert.rejects(app.decide(owner, run.runId, { approved: true, planHash: run.planHash! }), /conflict/i);
      await assert.rejects(worker.deliver(owner, run.runId), /approval required/i);
      assert.equal(await destination.projects.countDocuments(), 0);
    } finally { await worker.close(); await app.close(); }
  });
}

test('destination rejects key reuse with changed proposal and separates tenants', async () => {
  const destination = new MongoProjectDestination(client.db(`destination_${++serial}`));
  const request = { key: 'a'.repeat(64), payloadHash: 'b'.repeat(64),
    tenantId: 'tenant-a', projectId: 'website', scope: 'An accessible client website.' };
  const first = await destination.createProject(request);
  assert.deepEqual(await destination.createProject(request), first);
  await assert.rejects(destination.createProject({ ...request, payloadHash: 'c'.repeat(64) }), /conflict/i);
  const other = await destination.createProject({ ...request, tenantId: 'tenant-b' });
  assert.notEqual(other.externalId, first.externalId);
  assert.equal(await destination.projects.countDocuments(), 2);
});

test('delivery refuses a mismatched destination receipt and leaves intent pending', async () => {
  const dbName = `bad_receipt_${++serial}`;
  const app = await createBaselineApp({ uri: mongo.getUri(), dbName, planner: demoPlanner });
  const worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination: {
    async createProject(request) { return { key: request.key, payloadHash: '0'.repeat(64), externalId: 'wrong' }; },
  } });
  try {
    const run = await app.start(owner, brief);
    await app.decide(owner, run.runId, { approved: true, planHash: run.planHash! });
    await assert.rejects(worker.deliver(owner, run.runId), /receipt/i);
    assert.equal((await app.get(owner, run.runId)).projectDelivery?.status, 'pending');
    await assert.rejects(worker.deliver(owner, { $ne: null } as unknown as string));
  } finally { await worker.close(); await app.close(); }
});

test('separate intakes for the same project reuse creation; changed scope conflicts', async () => {
  const dbName = `project_identity_${++serial}`;
  const app = await createBaselineApp({ uri: mongo.getUri(), dbName, planner: demoPlanner });
  const destination = new MongoProjectDestination(client.db(`${dbName}_destination`));
  const worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination });
  const changed = await createBaselineApp({ uri: mongo.getUri(), dbName, planner: async input => ({
    ...planSchema.parse(await demoPlanner(input)), scope: 'An explicitly revised project scope requiring an update operation.',
  }) });
  try {
    const first = await app.start(owner, brief);
    await app.decide(owner, first.runId, { approved: true, planHash: first.planHash! });
    const original = await worker.deliver(owner, first.runId);
    const second = await app.start(owner, brief);
    await app.decide(owner, second.runId, { approved: true, planHash: second.planHash! });
    assert.deepEqual(await worker.deliver(owner, second.runId), original);
    const revision = await changed.start(owner, brief);
    await changed.decide(owner, revision.runId, { approved: true, planHash: revision.planHash! });
    await assert.rejects(worker.deliver(owner, revision.runId), /conflict/i);
    assert.equal(await destination.projects.countDocuments(), 1);
  } finally { await worker.close(); await app.close(); await changed.close(); }
});

test('baseline rejects untrusted input and races opposing decisions atomically', async () => {
  const dbName = `baseline_contract_${++serial}`;
  const app = await createBaselineApp({ uri: mongo.getUri(), dbName, planner: demoPlanner });
  try {
    await assert.rejects(app.start(owner, { ...brief, tenantId: 'injected' }));
    await assert.rejects(app.start(owner, { ...brief, brief: ' ' }));
    await assert.rejects(app.get(owner, { $ne: null } as unknown as string));
    const run = await app.start(owner, brief);
    const decisions = await Promise.allSettled([true, false].map(approved =>
      app.decide(owner, run.runId, { approved, planHash: run.planHash! })));
    assert.equal(decisions.filter(result => result.status === 'fulfilled').length, 1);
    const record = await app.get(owner, run.runId);
    assert.equal(record.status, record.decision!.approved ? 'dispatched' : 'rejected');
    assert.equal(Boolean(record.projectDelivery), record.decision!.approved);
  } finally { await app.close(); }
});

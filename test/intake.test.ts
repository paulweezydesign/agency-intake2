import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { demoPlanner } from '../src/planner.js';
import { MongoClient } from 'mongodb';
import { Repository } from '../src/repository.js';
import { memoryIds } from '../src/contracts.js';

let mongo: MongoMemoryServer;
let uri: string;
const owner = { tenantId: 'tenant-a', userId: 'reviewer', canApprove: true };
const brief = { projectId: 'website', brief: 'Build an accessible five page website with contact form.' };
before(async () => { mongo = await MongoMemoryServer.create({
  binary: { version: '8.2.6' },
  instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
}); uri = mongo.getUri(); });
after(async () => { await mongo?.stop(); });

test('persists approval pause, restores in a new app, dispatches once', async () => {
  let app = await createApp({ uri, dbName: 'recovery', planner: demoPlanner });
  const started = await app.start(owner, brief);
  assert.equal(started.status, 'awaiting_approval');
  assert.equal(started.assignments.length, 0);
  await app.close();
  app = await createApp({ uri, dbName: 'recovery', planner: async () => { throw new Error('must not replan'); } });
  try {
    const done = await app.decide(owner, started.runId, { approved: true, planHash: started.planHash! });
    assert.equal(done.status, 'dispatched');
    assert.ok(done.assignments.length >= 2);
    const again = await app.decide(owner, started.runId, { approved: true, planHash: started.planHash! });
    assert.deepEqual(again.assignments, done.assignments);
  } finally { await app.close(); }
});

test('denies cross-tenant reads and approvals, and unauthorized reviewers', async () => {
  const app = await createApp({ uri, dbName: 'isolation', planner: demoPlanner });
  try {
    const run = await app.start(owner, brief);
    const other = { ...owner, tenantId: 'tenant-b' };
    await assert.rejects(app.get(other, run.runId), /not found/i);
    await assert.rejects(app.decide(other, run.runId, { approved: true, planHash: run.planHash! }), /not found/i);
    await assert.rejects(app.decide({ ...owner, canApprove: false }, run.runId,
      { approved: true, planHash: run.planHash! }), /forbidden/i);
    assert.equal((await app.get(owner, run.runId)).assignments.length, 0);
  } finally { await app.close(); }
});

test('rejects stale approvals and makes rejection terminal', async () => {
  const app = await createApp({ uri, dbName: 'decisions', planner: demoPlanner });
  try {
    const run = await app.start(owner, brief);
    await assert.rejects(app.decide(owner, run.runId, { approved: true, planHash: '0'.repeat(64) }), /stale/i);
    const rejected = await app.decide(owner, run.runId, { approved: false, planHash: run.planHash! });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.assignments.length, 0);
    await assert.rejects(app.decide(owner, run.runId, { approved: true, planHash: run.planHash! }), /conflict/i);
  } finally { await app.close(); }
});

test('strict input and model output cannot inject tenancy or assignments', async () => {
  const app = await createApp({ uri, dbName: 'validation', planner: async () => ({ tasks: [], scope: 'bad' }) });
  try {
    await assert.rejects(app.start(owner, { ...brief, tenantId: 'tenant-b' }));
    await assert.rejects(app.start(owner, { ...brief, brief: '  ' }));
    await assert.rejects(app.start(owner, { ...brief, brief: 'x'.repeat(20_001) }));
    let failedId = '';
    await assert.rejects(app.start(owner, brief), error => {
      failedId = String(error).match(/runId=([a-f0-9-]+)/)?.[1] ?? '';
      return /workflow failed/i.test(String(error));
    });
    const failed = await app.get(owner, failedId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.assignments.length, 0);
  } finally { await app.close(); }
});

test('concurrent duplicate approvals never duplicate assignments', async () => {
  const app = await createApp({ uri, dbName: 'concurrency', planner: demoPlanner });
  try {
    const run = await app.start(owner, brief);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () =>
      app.decide(owner, run.runId, { approved: true, planHash: run.planHash! })));
    assert.ok(attempts.some(r => r.status === 'fulfilled'));
    const stored = await app.get(owner, run.runId);
    assert.equal(stored.status, 'dispatched');
    assert.equal(new Set(stored.assignments.map(a => a.id)).size, stored.assignments.length);
    assert.equal(stored.assignments.length, stored.plan!.tasks.length);
  } finally { await app.close(); }
});

test('refuses MongoDB query objects supplied as run IDs', async () => {
  const app = await createApp({ uri, dbName: 'query-input', planner: demoPlanner });
  try {
    await app.start(owner, brief);
    await assert.rejects(app.get(owner, { $ne: null } as unknown as string));
  } finally { await app.close(); }
});

test('recovers when the process dies after dispatch but before workflow completion', async () => {
  let app = await createApp({ uri, dbName: 'partial-write', planner: demoPlanner });
  const run = await app.start(owner, brief);
  await app.close();
  const client = await new MongoClient(uri).connect();
  try {
    const repo = new Repository(client.db('partial-write'));
    await assert.rejects(repo.dispatch(owner.tenantId, run.runId), /approval required/i);
    await repo.decide(owner.tenantId, run.runId, owner.userId, true, run.planHash!);
    const first = await repo.dispatch(owner.tenantId, run.runId);
    app = await createApp({ uri, dbName: 'partial-write', planner: async () => { throw new Error('must not replan'); } });
    const recovered = await app.decide(owner, run.runId, { approved: true, planHash: run.planHash! });
    assert.deepEqual(recovered.assignments, first.assignments);
    assert.equal(recovered.status, 'dispatched');
  } finally { await app.close(); await client.close(); }
});

test('memory identifiers separate tenants and runs', () => {
  const input = { tenantId: 'tenant-a', runId: 'run-one', projectId: 'project', brief: 'example' };
  assert.notEqual(memoryIds(input).resource, memoryIds({ ...input, tenantId: 'tenant-b' }).resource);
  assert.notEqual(memoryIds(input).thread, memoryIds({ ...input, runId: 'run-two' }).thread);
});

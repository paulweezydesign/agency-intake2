import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { demoPlanner } from '../src/planner.js';
import { ResearchService } from '../src/research.js';

let server: MongoMemoryServer;
let client: MongoClient;
const actor = { tenantId: 'tenant-a', userId: 'reviewer', canApprove: true };
const packet = { sources: [{ id: 's1', title: 'Workflow docs', url: 'https://mastra.ai/docs/workflows/suspend-and-resume',
  retrievedAt: '2026-09-29T00:00:00.000Z', text: 'Suspension saves the current execution state as a snapshot.' }] };
const output = { summary: 'Use a persisted approval pause before dispatching work.',
  findings: [{ claim: 'Suspension records workflow state for later use.', citations: [{ sourceId: 's1', quote: 'execution state as a snapshot' }] }],
  limitations: ['A snapshot does not guarantee exactly-once external delivery.'] };
before(async () => {
  server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
  });
  client = await new MongoClient(server.getUri()).connect();
});
after(async () => { await client?.close(); await server?.stop(); });

async function setup(name: string, approved = true) {
  const app = await createApp({ uri: server.getUri(), dbName: name, planner: demoPlanner });
  let run = await app.start(actor, { projectId: 'website', brief: 'Research a reliable client approval workflow for our agency.' });
  if (approved) run = await app.decide(actor, run.runId, { approved: true, planHash: run.planHash! });
  await app.close();
  return { run, service: new ResearchService(client.db(name)) };
}

test('approved research produces one persisted artifact and explicit QA decision', async () => {
  const { run, service } = await setup('research-happy');
  const assignment = run.assignments.find(a => a.role === 'research')!;
  let calls = 0;
  const runner = async () => { calls++; return output; };
  const job = await service.execute(actor, run.runId, assignment.id, packet, runner);
  assert.equal(job.status, 'awaiting_qa');
  assert.equal(job.citationsChecked, 1);
  const again = await new ResearchService(client.db('research-happy')).execute(actor, run.runId, assignment.id, packet, runner);
  assert.equal(again.artifactHash, job.artifactHash);
  assert.equal(calls, 1);
  const reviewed = await service.review(actor, assignment.id, { artifactHash: job.artifactHash!, accepted: true, notes: 'Verified the claim against its quoted source.' });
  assert.equal(reviewed.status, 'accepted');
  await assert.rejects(service.review(actor, assignment.id, { artifactHash: '0'.repeat(64), accepted: true, notes: 'Incorrect artifact hash.' }), /stale/i);
});

test('unapproved, cross-tenant, and non-research assignments cannot execute', async () => {
  const pending = await setup('research-pending', false);
  await assert.rejects(pending.service.execute(actor, pending.run.runId, '0'.repeat(64), packet, async () => output), /approval/i);
  const { run, service } = await setup('research-access');
  const task = run.assignments.find(a => a.role === 'research')!;
  await assert.rejects(service.execute({ ...actor, tenantId: 'tenant-b' }, run.runId, task.id, packet, async () => output), /not found/i);
  await assert.rejects(service.execute({ ...actor, canApprove: false }, run.runId, task.id, packet, async () => output), /forbidden/i);
  await assert.rejects(service.execute(actor, run.runId, run.assignments.find(a => a.role === 'design')!.id, packet, async () => output), /research/i);
});

test('invented sources and quotations fail closed and can retry with valid output', async () => {
  const { run, service } = await setup('research-citations');
  const id = run.assignments[0].id;
  for (const citation of [{ sourceId: 'invented', quote: 'execution state as a snapshot' }, { sourceId: 's1', quote: 'guarantees exactly once delivery' }]) {
    await assert.rejects(service.execute(actor, run.runId, id, packet, async () => ({ ...output,
      findings: [{ claim: 'An unsupported factual claim in this test.', citations: [citation] }] })), /citation/i);
    assert.equal((await service.get(actor, id)).status, 'failed');
  }
  const valid = await service.execute(actor, run.runId, id, packet, async () => output);
  assert.equal(valid.status, 'awaiting_qa');
  await assert.rejects(service.execute(actor, run.runId, id, { sources: [{ ...packet.sources[0], text: 'Different evidence packet for the same assignment.' }] }, async () => output), /conflict/i);
});

test('concurrent executions do not publish competing artifacts', async () => {
  const { run, service } = await setup('research-concurrent');
  let calls = 0;
  const runner = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); return output; };
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => service.execute(actor, run.runId, run.assignments[0].id, packet, runner)));
  assert.ok(attempts.some(r => r.status === 'fulfilled'));
  assert.equal(calls, 1);
  assert.equal((await service.get(actor, run.assignments[0].id)).status, 'awaiting_qa');
});

test('tampered assignment cannot change the approved research task', async () => {
  const { run, service } = await setup('research-integrity');
  await client.db('research-integrity').collection('agency_intakes').updateOne({ _id: run.runId } as never,
    { $set: { 'assignments.0.objective': 'Different unapproved research work.' } });
  await assert.rejects(service.execute(actor, run.runId, run.assignments[0].id, packet, async () => output), /integrity/i);
});

test('expired attempt is fenced when a replacement publishes, and QA cannot be reversed', async () => {
  const { run, service } = await setup('research-fencing');
  const id = run.assignments[0].id;
  let started!: () => void;
  let finish!: (value: typeof output) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const deferred = new Promise<typeof output>(resolve => { finish = resolve; });
  const old = service.execute(actor, run.runId, id, packet, async () => { started(); return deferred; });
  const oldRejected = assert.rejects(old, /lease lost/i);
  await entered;
  await client.db('research-fencing').collection('agency_research').updateOne({ _id: id } as never, { $set: { leaseUntil: new Date(0) } });
  const replacement = await service.execute(actor, run.runId, id, packet, async () => output);
  finish({ ...output, summary: 'This stale result must never replace the winning artifact.' });
  await oldRejected;
  assert.equal((await service.get(actor, id)).artifactHash, replacement.artifactHash);
  await assert.rejects(service.review({ ...actor, canApprove: false }, id,
    { artifactHash: replacement.artifactHash, accepted: true, notes: 'A review without permission.' }), /forbidden/i);
  await service.review(actor, id, { artifactHash: replacement.artifactHash, accepted: false, notes: 'Needs stronger evidence for the recommendation.' });
  await assert.rejects(service.review(actor, id, { artifactHash: replacement.artifactHash, accepted: true, notes: 'Attempt to reverse the recorded review.' }), /conflict/i);
});

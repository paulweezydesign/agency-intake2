import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { demoPlanner } from '../src/planner.js';
import { runResearchCommand } from '../src/research-cli.js';

const actor = { tenantId: 'client-a', userId: 'reviewer', canApprove: true };
test('CLI packet, research, replay, show, and hash-bound human review', async () => {
 const server = await MongoMemoryServer.create({ binary: { version: '8.2.6' }, instance: { args: ['--nounixsocket'] } });
 const client = await new MongoClient(server.getUri()).connect();
 const dir = await mkdtemp(join(tmpdir(), 'agency-cli-'));
 const app = await createApp({ uri: server.getUri(), dbName: 'cli', planner: demoPlanner });
 try {
  let run = await app.start(actor, { projectId: 'website', brief: 'Confirm the budget and launch date before implementation.' });
  run = await app.decide(actor, run.runId, { approved: true, planHash: run.planHash! });
  let calls = 0;
  const context = { db: client.db('cli'), principal: actor, runner: async () => {
    calls++;
    return { summary: 'Budget and launch date remain unconfirmed in the supplied brief.',
     findings: [{ claim: 'The client requires confirmation before implementation.', citations: [{ sourceId: 'client-brief', quote: 'Confirm the budget and launch date' }] }],
     limitations: ['No confirmed budget or launch date was supplied.'] };
  } };
  const packet = join(dir, 'packet.json');
  await runResearchCommand('research-packet', [run.runId, packet], context);
  const evidence = JSON.parse(await readFile(packet, 'utf8'));
  assert.equal(evidence.sources[0].text, run.brief);
  await assert.rejects(runResearchCommand('research-packet', [run.runId, packet], context), /exist/i);
  const id = run.assignments[0].id;
  const result = await runResearchCommand('research', [run.runId, id, packet], context) as { status: string; artifactHash: string };
  assert.equal(result.status, 'awaiting_qa');
  await runResearchCommand('research', [run.runId, id, packet], context);
  assert.equal(calls, 1);
  const review = join(dir, 'review.json');
  await writeFile(review, JSON.stringify({ artifactHash: result.artifactHash, accepted: true, notes: 'Evidence reviewed; budget and date still need client confirmation.' }));
  const reviewed = await runResearchCommand('research-review', [id, review], context) as { status: string };
  assert.equal(reviewed.status, 'accepted');
  const shown = await runResearchCommand('research-show', [id], context) as { status: string };
  assert.equal(shown.status, 'accepted');
  assert.equal((await app.get(actor, run.runId)).assignments[1].status, 'queued');
  await assert.rejects(runResearchCommand('research-show', [id], { ...context, principal: { ...actor, tenantId: 'other' } }), /not found/i);
 } finally { await app.close(); await client.close(); await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

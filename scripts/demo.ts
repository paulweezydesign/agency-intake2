import { MongoMemoryServer } from 'mongodb-memory-server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const mongo = await MongoMemoryServer.create({
  binary: { version: '8.2.6' },
  instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
});
const env = { ...process.env, MONGODB_URI: mongo.getUri(), MONGODB_DB_NAME: 'agency_demo',
  AGENCY_TENANT: 'demo-client', AGENCY_USER: 'local-reviewer', AGENCY_CAN_APPROVE: 'true', PLANNER_MODE: 'demo' };
async function cli(...args: string[]) {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env });
  return JSON.parse(stdout);
}
try {
  const pending = await cli('start', 'fixtures/intake.json');
  assert.equal(pending.status, 'awaiting_approval');
  console.log(`1. Draft saved; awaiting approval. Run: ${pending.runId}`);
  console.log(JSON.stringify(pending.plan, null, 2));
  const restored = await cli('show', pending.runId);
  assert.equal(restored.planHash, pending.planHash);
  console.log('2. Original process exited. A new process recovered the same draft.');
  const approved = await cli('approve', pending.runId, pending.planHash);
  assert.equal(approved.status, 'dispatched');
  const duplicate = await cli('approve', pending.runId, pending.planHash);
  assert.deepEqual(duplicate.assignments, approved.assignments);
  console.log(`3. Approved and queued ${approved.assignments.length} assignments. Duplicate approval created zero extra assignments.`);
  console.log('Demo complete: real MongoDB and Mastra workflow; deterministic planner; no external tasks executed.');
} finally { await mongo.stop(); }

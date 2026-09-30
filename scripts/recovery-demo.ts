import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { createBaselineApp } from '../src/baseline.js';
import { demoPlanner } from '../src/planner.js';

const mongo = await MongoMemoryServer.create({
  binary: { version: '8.2.6' },
  instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
});
const client = await new MongoClient(mongo.getUri()).connect();
const owner = { tenantId: 'demo-client', userId: 'reviewer', canApprove: true };
const brief = JSON.parse(await readFile(new URL('../fixtures/intake.json', import.meta.url), 'utf8'));

async function child(mode: 'crash' | 'recover', dbName: string, runId: string) {
  const processHandle = fork(fileURLToPath(new URL('./delivery-child.ts', import.meta.url)), [mode, dbName, runId], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, DEMO_MONGO_URI: mongo.getUri() },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let sawEvent = false;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; processHandle.kill('SIGKILL'); }, 30_000);
  processHandle.on('message', message => {
    const event = (message as { event?: string }).event;
    if (mode === 'crash' && event === 'destination-committed') {
      sawEvent = true; processHandle.kill('SIGKILL');
    } else if (mode === 'recover' && event === 'delivered') sawEvent = true;
  });
  try {
    const [code, signal] = await once(processHandle, 'exit');
    assert.equal(timedOut, false, 'Child exceeded the recovery test deadline');
    assert.equal(sawEvent, true, 'Child never reached the expected persistence boundary');
    if (mode === 'crash') assert.equal(signal, 'SIGKILL');
    else assert.equal(code, 0);
  } finally { clearTimeout(timeout); if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL'); }
}

try {
  for (const [name, factory] of [['baseline', createBaselineApp], ['mastra', createApp]] as const) {
    const dbName = `recovery_${name}`;
    let app = await factory({ uri: mongo.getUri(), dbName, planner: demoPlanner });
    let started;
    try { started = await app.start(owner, brief); } finally { await app.close(); }
    app = await factory({ uri: mongo.getUri(), dbName, planner: async () => { throw new Error('Must not replan'); } });
    try {
      await app.decide(owner, started.runId, { approved: true, planHash: started.planHash! });
      await child('crash', dbName, started.runId);
      assert.equal((await app.get(owner, started.runId)).projectDelivery?.status, 'pending');
      const projects = client.db(`${dbName}_destination`).collection('fake_projects');
      assert.equal(await projects.countDocuments(), 1);
      const firstProject = await projects.findOne({});
      await child('recover', dbName, started.runId);
      const restored = await app.get(owner, started.runId);
      assert.equal(restored.projectDelivery?.status, 'delivered');
      assert.equal(restored.projectDelivery?.receipt?.externalId, firstProject!.externalId);
      await child('recover', dbName, started.runId);
      assert.equal(await projects.countDocuments(), 1);
      console.log(`${name}: SIGKILL after destination commit; fresh worker recovered the same project; duplicate delivery created 0 extras.`);
    } finally { await app.close(); }
  }
  console.log('PASS: 2/2 recovery paths. Real MongoDB and child processes; fake destination; no model calls.');
} finally { await client.close(); await mongo.stop(); }

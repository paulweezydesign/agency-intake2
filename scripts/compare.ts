import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { createBaselineApp } from '../src/baseline.js';
import { createDeliveryWorker } from '../src/delivery.js';
import { MongoProjectDestination } from '../src/fake-destination.js';
import { demoPlanner } from '../src/planner.js';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url), 'utf8')).slice(0, 10);
const mongo = await MongoMemoryServer.create({
  binary: { version: '8.2.6' },
  instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
});
const client = await new MongoClient(mongo.getUri()).connect();
const owner = { tenantId: 'fixture-client', userId: 'reviewer', canApprove: true };
const samples: Array<{ mode: string; fixture: string; repeat: number; elapsedMs: number; assignments: number }> = [];
const factories = { baseline: createBaselineApp, mastra: createApp };
try {
  for (let repeat = 0; repeat < 2; repeat++) {
    // Alternate order to reduce a systematic warm-up advantage.
    const order = repeat === 0 ? ['baseline', 'mastra'] as const : ['mastra', 'baseline'] as const;
    for (const mode of order) {
      const dbName = `comparison_${mode}_${repeat}`;
      const app = await factories[mode]({ uri: mongo.getUri(), dbName, planner: demoPlanner });
      const destination = new MongoProjectDestination(client.db(`${dbName}_destination`));
      const worker = await createDeliveryWorker({ uri: mongo.getUri(), dbName, destination });
      try {
        for (const input of fixtures) {
          const start = performance.now();
          const run = await app.start(owner, input);
          const approved = await app.decide(owner, run.runId, { approved: true, planHash: run.planHash! });
          const receipt = await worker.deliver(owner, run.runId);
          await app.decide(owner, run.runId, { approved: true, planHash: run.planHash! });
          assert.deepEqual(await worker.deliver(owner, run.runId), receipt);
          assert.equal(await destination.projects.countDocuments({ projectId: input.projectId }), 1);
          assert.equal(approved.assignments.length, approved.plan!.tasks.length);
          samples.push({ mode, fixture: input.projectId, repeat, elapsedMs: performance.now() - start,
            assignments: approved.assignments.length });
        }
      } finally { await worker.close(); await app.close(); }
    }
  }
  const summary = Object.keys(factories).map(mode => {
    const elapsed = samples.filter(sample => sample.mode === mode).map(sample => sample.elapsedMs).sort((a, b) => a - b);
    return { mode, runs: elapsed.length, medianMs: elapsed[Math.floor(elapsed.length / 2)],
      p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1], duplicateProjects: 0 };
  });
  const report = { date: new Date().toISOString(), node: process.version, mongo: '8.2.6', modelCalls: 0,
    scope: 'Local fixture comparison: draft, approval, fake project creation, duplicate approval and delivery. Excludes connection setup; first operation initialization is included. No live model, OM quality, or production throughput measurement.',
    summary, samples };
  await writeFile(new URL('../results/comparison.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.table(summary);
} finally { await client.close(); await mongo.stop(); }

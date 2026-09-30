import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { demoPlanner, createLivePlanner } from '../src/planner.js';
import { intakeSchema, planSchema } from '../src/contracts.js';
import { providerConfig } from '../src/providers.js';

const cases = z.array(intakeSchema).length(30).parse(JSON.parse(await readFile('fixtures/cases.json', 'utf8')));
const liveMode = process.env.PLANNER_MODE === 'live';
if (liveMode && !process.env.MONGODB_URI) throw new Error('Live benchmark requires MONGODB_URI');
const mongo = liveMode ? undefined : await MongoMemoryServer.create({
  binary: { version: '8.2.6' },
  instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] },
});
const uri = process.env.MONGODB_URI ?? mongo!.getUri();
// Always isolate benchmark data from operational records.
const dbName = `agency_bench_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
const live = liveMode ? createLivePlanner({ uri, dbName, ...providerConfig() }) : undefined;
const planner = live?.planner ?? demoPlanner;
const app = await createApp({ uri, dbName, planner });
const actor = { tenantId: 'benchmark', userId: 'fixture-reviewer', canApprove: true };
const rows: Array<{ projectId: string; directMs: number; workflowMs: number; direct: unknown; workflow: unknown; status: string }> = [];
try {
  for (const item of cases) {
    let start = performance.now();
    const direct = planSchema.parse(await planner({ ...item, tenantId: actor.tenantId, runId: randomUUID() }));
    const directMs = performance.now() - start;
    start = performance.now();
    const workflow = await app.start(actor, item);
    const workflowMs = performance.now() - start;
    // This is a test harness decision, not an inferred or model-generated approval.
    const decision = await app.decide(actor, workflow.runId, { approved: true, planHash: workflow.planHash! });
    rows.push({ projectId: item.projectId, directMs, workflowMs, direct, workflow: workflow.plan, status: decision.status });
  }
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
  const report = { createdAt: new Date().toISOString(), mode: liveMode ? 'live-model' : 'deterministic-fixture',
    database: dbName, cases: rows.length, completed: rows.filter(row => row.status === 'dispatched').length,
    measurement: 'Direct planner and schema validation versus workflow start through persisted approval pause. Approval time excluded.',
    directP95Ms: p95(rows.map(r => r.directMs)), workflowP95Ms: p95(rows.map(r => r.workflowMs)),
    quality: 'Not graded. Review paired outputs against the rubric in EXPERIMENT.md.',
    tokenUsage: null, costUSD: liveMode ? null : 0,
    limitations: 'Single sequential run; fixed direct-first order; no quality, cost, or production throughput conclusion. Fixture mode uses no LLM and does not exercise observational memory.', rows };
  const destination = liveMode ? 'results/live-benchmark.json' : 'results/fixture-benchmark.json';
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mode: report.mode, cases: report.cases, completed: report.completed,
    directP95Ms: report.directP95Ms, workflowP95Ms: report.workflowP95Ms, destination }, null, 2));
} finally { await app.close(); await live?.close(); await mongo?.stop(); }

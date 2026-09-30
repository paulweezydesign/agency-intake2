import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createLivePlanner, demoPlanner } from './planner.js';
import { providerConfig } from './providers.js';

async function main() {
  const [command, first, hash] = process.argv.slice(2);
  if (!['start', 'show', 'approve', 'reject'].includes(command ?? '')) {
    throw new Error('Usage: npm run cli -- start intake.json | show RUN_ID | approve RUN_ID PLAN_HASH | reject RUN_ID PLAN_HASH');
  }
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME;
  const tenantId = process.env.AGENCY_TENANT;
  const userId = process.env.AGENCY_USER;
  if (!uri || !dbName || !tenantId || !userId) throw new Error('Set MONGODB_URI, MONGODB_DB_NAME, AGENCY_TENANT, and AGENCY_USER');
  if (!first) throw new Error('Missing file or run ID');
  // This CLI is a trusted local operator interface, not an authentication service.
  const principal = { tenantId, userId, canApprove: process.env.AGENCY_CAN_APPROVE === 'true' };
  const mode = process.env.PLANNER_MODE ?? 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Error('PLANNER_MODE must be demo or live');
  const live = mode === 'live' && command === 'start'
    ? createLivePlanner({ uri, dbName, ...providerConfig() })
    : undefined;
  const app = await createApp({ uri, dbName, planner: live?.planner ?? demoPlanner });
  try {
    const result = command === 'start'
      ? await app.start(principal, JSON.parse(await readFile(first, 'utf8')))
      : command === 'show'
        ? await app.get(principal, first)
        : await app.decide(principal, first, { approved: command === 'approve', planHash: hash });
    const { _id, lease, ...output } = result;
    console.log(JSON.stringify(output, null, 2));
  } finally { await app.close(); await live?.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Operation failed'); process.exitCode = 1; });

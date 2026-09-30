import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { createLivePlanner, demoPlanner } from './planner.js';
import { providerConfig } from './providers.js';
import { createLiveResearcher } from './researcher.js';
import { researchCommands, researchUsage, runResearchCommand, readJson } from './research-cli.js';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const [first, hash] = args;
  if (![...researchCommands, 'start', 'show', 'approve', 'reject'].includes(command ?? '')) {
    throw new Error('Usage: npm run cli -- start intake.json | show RUN_ID | approve RUN_ID PLAN_HASH | reject RUN_ID PLAN_HASH | ' + researchUsage);
  }
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME;
  const tenantId = process.env.AGENCY_TENANT;
  const userId = process.env.AGENCY_USER;
  if (!uri || !dbName || !tenantId || !userId) throw new Error('Set MONGODB_URI, MONGODB_DB_NAME, AGENCY_TENANT, and AGENCY_USER');
  if (!first) throw new Error('Missing file or ID');
  // Trusted local operator interface; environment variables are not remote authentication.
  const principal = { tenantId, userId, canApprove: process.env.AGENCY_CAN_APPROVE === 'true' };
  if (researchCommands.includes(command)) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    let researcher: ReturnType<typeof createLiveResearcher> | undefined;
    try {
      await client.connect();
      const result = await runResearchCommand(command, args, { db: client.db(dbName), principal,
        runner: async input => {
          if (!researcher) {
            const config = providerConfig();
            researcher = createLiveResearcher({ uri, dbName, ...config, model: config.researchModel,
              onMetric: metric => { console.error(JSON.stringify({ metric })); } });
          }
          return researcher.runner(input);
        },
      });
      console.log(JSON.stringify(result, null, 2));
    } finally { await researcher?.close(); await client.close(); }
    return;
  }
  const mode = process.env.PLANNER_MODE ?? 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Error('PLANNER_MODE must be demo or live');
  const live = mode === 'live' && command === 'start' ? createLivePlanner({ uri, dbName, ...providerConfig() }) : undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ uri, dbName, planner: live?.planner ?? demoPlanner });
    const result = command === 'start'
      ? await app.start(principal, await readJson(first))
      : command === 'show' ? await app.get(principal, first)
        : await app.decide(principal, first, { approved: command === 'approve', planHash: hash });
    const { _id, lease, ...output } = result;
    console.log(JSON.stringify(output, null, 2));
  } finally { await app?.close(); await live?.close(); }
}
main().catch(() => {
  // Provider/driver errors can contain credentials or request bodies. Do not echo raw exceptions.
  console.error('Command failed. Check command arguments, .env settings, database availability, and saved approval. See RESEARCH.md for recovery steps.');
  process.exitCode = 1;
});

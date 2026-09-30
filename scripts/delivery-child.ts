import { MongoClient } from 'mongodb';
import { createDeliveryWorker } from '../src/delivery.js';
import { MongoProjectDestination } from '../src/fake-destination.js';

const [mode, dbName, runId] = process.argv.slice(2);
const uri = process.env.DEMO_MONGO_URI;
if (!uri || !dbName || !runId || !['crash', 'recover'].includes(mode ?? '')) throw new Error('Invalid demo arguments');
const client = await new MongoClient(uri).connect();
const destination = new MongoProjectDestination(client.db(`${dbName}_destination`));
const worker = await createDeliveryWorker({ uri, dbName, destination: {
  async createProject(request) {
    const receipt = await destination.createProject(request);
    if (mode === 'crash') {
      // Tell the parent the destination write has completed, then hold before receipt persistence.
      process.send?.({ event: 'destination-committed' });
      await new Promise<never>(() => {});
    }
    return receipt;
  },
} });
try {
  const receipt = await worker.deliver({ tenantId: 'demo-client', userId: 'reviewer', canApprove: true }, runId);
  process.send?.({ event: 'delivered', receipt });
} finally {
  await worker.close(); await client.close(); process.disconnect?.();
}

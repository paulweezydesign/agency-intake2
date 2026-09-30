import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createLiveResearcher } from '../src/researcher.js';
import { createModelSession, type Metric } from '../src/model-session.js';

test('real Mastra adapter validates Research output and preserves conversations across restart', { timeout: 90_000 }, async () => {
 const report = { summary: 'The supplied brief does not confirm a budget or launch date.',
  findings: [{ claim: 'The client requires confirmation before implementation.', citations: [{ sourceId: 'brief', quote: 'Confirm budget before implementation.' }] }],
  limitations: ['Ask the client for a confirmed budget and launch date.'] };
 const requests: Array<{ model: string; messages: unknown[] }> = [];
 let reply = JSON.stringify(report);
 const http = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  if (!request.stream) {
   res.writeHead(200, { 'Content-Type': 'application/json' });
   res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: 'fixture-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
   return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  event({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'fixture-flash', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] });
  event({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'fixture-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
 const server = await MongoMemoryServer.create({ binary: { version: '8.2.6' }, instance: { args: ['--nounixsocket'] } });
 const model = { providerId: 'test-provider', modelId: 'fixture-flash', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`, apiKey: 'test-only', api: 'chat' as const };
 const metrics: Metric[] = [];
 const config = { uri: server.getUri(), dbName: 'model-protocol', model, memoryModel: model, onMetric: (m: Metric) => { metrics.push(m); } };
 try {
  for (const outputMode of ['prompt', 'schema'] as const) {
   const researcher = createLiveResearcher({ ...config, outputMode });
   try {
    const actual = await researcher.runner({ brief: 'Confirm budget before implementation.',
     task: { id: '0'.repeat(64), role: 'research', objective: 'Clarify requirements before work.', acceptance: ['Budget must be confirmed.'], status: 'queued' },
     packet: { sources: [{ id: 'brief', title: 'Client brief', retrievedAt: '2026-09-30T00:00:00Z', text: 'Confirm budget before implementation.' }] },
     ids: { resource: 'client', thread: 'research-' + outputMode } });
    assert.deepEqual(actual, report);
   } finally { await researcher.close(); }
  }
  assert.equal(metrics.length, 2);
  assert.ok(metrics.every(m => m.ok && m.totalTokens === 30)); // Synthetic endpoint usage, not live cost.
  assert.ok(requests.every(r => r.model === 'fixture-flash'));
  reply = 'Acknowledged: the revised budget is 7200.';
  const ids = { resource: 'tenant-a', thread: 'follow-up' };
  const one = createModelSession({ ...config, role: 'memory-test', instructions: 'Remember the supplied project facts.' });
  try { await one.chat('Correction: the revised budget is 7200.', ids); } finally { await one.close(); }
  const two = createModelSession({ ...config, role: 'memory-test', instructions: 'Remember the supplied project facts.' });
  try {
   await two.chat('What was the corrected budget?', ids);
   assert.match(JSON.stringify(requests.at(-1)?.messages), /revised budget is 7200/);
   await two.chat('What was the corrected budget?', { resource: 'tenant-b', thread: 'other-thread' });
   assert.doesNotMatch(JSON.stringify(requests.at(-1)?.messages), /7200/);
  } finally { await two.close(); }
 } finally { await server.stop(); await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())); }
});

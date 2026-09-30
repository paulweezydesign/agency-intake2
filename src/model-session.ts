import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import type { MastraModelConfig } from '@mastra/core/llm';
import { Memory } from '@mastra/memory';
import { MongoDBStore } from '@mastra/mongodb';
import { z } from 'zod';

export type Metric = { role: string; operation: string; ok: boolean; elapsedMs: number;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
export type SessionConfig = {
  uri: string; dbName: string; role: string; instructions: string;
  model: MastraModelConfig; memoryModel: MastraModelConfig;
  outputMode?: 'schema' | 'prompt'; onMetric?: (metric: Metric) => void | Promise<void>;
};
export type MemoryIds = { resource: string; thread: string };

export function createModelSession(config: SessionConfig) {
  const storage = new MongoDBStore({ id: `${config.role}-memory`, uri: config.uri, dbName: config.dbName });
  const report = async (operation: string, start: number, ok: boolean,
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => {
    await config.onMetric?.({ role: config.role, operation, ok, elapsedMs: Date.now() - start,
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, totalTokens: usage?.totalTokens ?? null });
  };
  let observationStarted = 0;
  let reflectionStarted = 0;
  const memory = new Memory({ storage, options: { observationalMemory: {
    model: config.memoryModel, scope: 'thread',
    observation: { bufferTokens: false, modelSettings: { maxOutputTokens: 4096, maxRetries: 0 } },
    reflection: { modelSettings: { maxOutputTokens: 4096, maxRetries: 0 } },
    hooks: {
      onObservationStart: () => { observationStarted = Date.now(); },
      onObservationEnd: r => report('observation', observationStarted, !r.error, r.usage),
      onReflectionStart: () => { reflectionStarted = Date.now(); },
      onReflectionEnd: r => report('reflection', reflectionStarted, !r.error, r.usage),
    },
  } } });
  const agent = new Agent({ id: config.role, name: config.role, instructions: config.instructions, model: config.model, memory });
  // Emit bounded metrics instead of SDK errors containing request bodies.
  agent.__setLogger(noopLogger);
  const providerOptions = typeof config.model === 'object' && 'providerId' in config.model && config.model.providerId === 'agency-nim'
    ? { 'agency-nim': { reasoningEffort: 'low' as const } } : undefined;
  const options = (ids: MemoryIds) => ({ memory: ids, maxSteps: 1,
    modelSettings: { maxRetries: 0, maxOutputTokens: 4096 }, abortSignal: AbortSignal.timeout(60_000), providerOptions });
  return {
    async structured<T>(prompt: string, schema: z.ZodType<T>, ids: MemoryIds): Promise<T> {
      const start = Date.now();
      try {
        if (config.outputMode === 'prompt') {
          const result = await agent.generate(`${prompt}\nReturn only JSON matching this schema:\n${JSON.stringify(z.toJSONSchema(schema))}`, options(ids));
          const parsed = schema.parse(JSON.parse(result.text));
          await report('structured', start, true, result.totalUsage);
          return parsed;
        }
        const result = await agent.generate(prompt, { ...options(ids), structuredOutput: { schema } });
        const parsed = schema.parse(result.object);
        await report('structured', start, true, result.totalUsage);
        return parsed;
      } catch { await report('structured', start, false); throw new Error('Model call or output validation failed; check provider access, model capabilities, and OUTPUT_MODE'); }
    },
    async chat(message: string, ids: MemoryIds) {
      const start = Date.now();
      try {
        const result = await agent.generate(z.string().trim().min(1).max(10_000).parse(message), options(ids));
        await report('chat', start, true, result.totalUsage);
        return result.text;
      } catch { await report('chat', start, false); throw new Error('Model conversation failed'); }
    },
    async observe(ids: MemoryIds) {
      const engine = await memory.omEngine;
      if (!engine) throw new Error('Observational memory is not configured');
      const result = await engine.observe({ threadId: ids.thread, resourceId: ids.resource });
      return { observed: result.observed, reflected: result.reflected, hasObservations: !!result.record.activeObservations.trim() };
    },
    async memoryStatus(ids: MemoryIds) {
      const domain = await storage.getStore('memory');
      const record = await domain?.getObservationalMemory(ids.thread, ids.resource);
      return { hasObservations: !!record?.activeObservations?.trim(), observationTokens: record?.observationTokenCount ?? 0 };
    },
    async close() { await storage.close(); },
  };
}

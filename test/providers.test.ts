import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelConfig } from '@mastra/core/llm';
import { generatePlanWithCorrection, parsePlanText } from '../src/planner.js';
import { providerConfig } from '../src/providers.js';

test('NIM and HF use explicit hosted chat endpoints and preserve model IDs', async () => {
  const nim = providerConfig({ LLM_PROVIDER: 'nim', NVIDIA_API_KEY: 'test-key', PM_MODEL: 'z-ai/glm-5.3' });
  assert.equal(nim.model.url, 'https://integrate.api.nvidia.com/v1');
  assert.equal(nim.model.modelId, 'z-ai/glm-5.3');
  assert.equal(nim.model.api, 'chat');
  assert.equal(nim.memoryModel.modelId, 'z-ai/glm-5.3');
  const resolved = await resolveModelConfig(nim.model);
  assert.equal(resolved.modelId, 'z-ai/glm-5.3');
  const hf = providerConfig({ LLM_PROVIDER: 'huggingface', HF_TOKEN: 'test-key', PM_MODEL: 'org/model:provider' });
  assert.equal(hf.model.url, 'https://router.huggingface.co/v1');
  assert.equal(hf.model.modelId, 'org/model:provider');
});

test('configuration fails early without a key or model; errors never include keys', () => {
  assert.throws(() => providerConfig({ LLM_PROVIDER: 'nim', PM_MODEL: 'vendor/model' }), /NVIDIA_API_KEY/);
  assert.throws(() => providerConfig({ LLM_PROVIDER: 'huggingface', HF_TOKEN: 'private-value' }), /PM_MODEL/);
  assert.throws(() => providerConfig({ LLM_PROVIDER: 'other', NVIDIA_API_KEY: 'private-value' }), /LLM_PROVIDER/);
});

test('prompt-mode planner parses JSON and still enforces the strict plan schema', () => {
  const plan = { scope: 'Plan the requested accessible client website.', unknowns: [], tasks: [
    { role: 'qa', objective: 'Verify every approved requirement against its acceptance criteria.',
      acceptance: ['Every requirement has a recorded pass or fail result.'] },
  ] };
  assert.deepEqual(parsePlanText(JSON.stringify(plan)), plan);
  assert.throws(() => parsePlanText(JSON.stringify({ ...plan, unexpected: true })), /Unrecognized key/);
  assert.throws(() => parsePlanText(''), /empty response/);
});

test('prompt-mode planner retries once with schema correction after an extra model key', async () => {
  const plan = { scope: 'Plan the requested accessible client website.', unknowns: [], tasks: [
    { role: 'qa', objective: 'Verify every approved requirement against its acceptance criteria.',
      acceptance: ['Every requirement has a recorded pass or fail result.'] },
  ] };
  const prompts: string[] = [];
  const generated = await generatePlanWithCorrection(async prompt => {
    prompts.push(prompt);
    return { text: prompts.length === 1
      ? JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], Note: 'unexpected extra field' }] })
      : JSON.stringify(plan), finishReason: 'stop', outputTokens: 100, reasoningTokens: 5 };
  }, 'Create a plan.');
  assert.deepEqual(generated, plan);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Do not add Note/);
});

test('empty planner responses report safe generation metadata after one retry', async () => {
  let calls = 0;
  await assert.rejects(generatePlanWithCorrection(async () => {
    calls++;
    return { text: '', finishReason: 'length', outputTokens: 4096, reasoningTokens: 3900 };
  }, 'Create a plan.'), /finishReason=length, outputTokens=4096, reasoningTokens=3900/);
  assert.equal(calls, 2);
});

test('Flash is inherited by Research and memory unless explicitly overridden', () => {
 const config = providerConfig({ LLM_PROVIDER: 'nim', NVIDIA_API_KEY: 'test-key', PM_MODEL: 'z-ai/glm-5.3-flash', OUTPUT_MODE: 'prompt' });
 assert.equal(config.researchModel.modelId, 'z-ai/glm-5.3-flash');
 assert.equal(config.memoryModel.modelId, 'z-ai/glm-5.3-flash');
 assert.throws(() => providerConfig({ LLM_PROVIDER: 'constructor' }), /LLM_PROVIDER/);
});

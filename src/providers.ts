import type { OpenAICompatibleConfig } from '@mastra/core/llm';

type HostedModel = Extract<OpenAICompatibleConfig, { modelId: string }>;
export type ProviderConfig = { name: string; model: HostedModel; memoryModel: HostedModel; researchModel: HostedModel; outputMode: 'schema' | 'prompt' };

export function providerConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const name = env.LLM_PROVIDER ?? 'openai';
  const providers: Record<string, { url: string; key: string }> = {
    nim: { url: 'https://integrate.api.nvidia.com/v1', key: 'NVIDIA_API_KEY' },
    huggingface: { url: 'https://router.huggingface.co/v1', key: 'HF_TOKEN' },
    openai: { url: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  };
  const selected = providers[name];
  if (!Object.hasOwn(providers, name)) throw new Error('LLM_PROVIDER must be nim, huggingface, or openai');
  const apiKey = env[selected.key]?.trim();
  if (!apiKey) throw new Error(`Set ${selected.key} in your local .env file`);
  const model = env.PM_MODEL?.trim();
  if (!model) throw new Error('Set PM_MODEL to a model ID served by your selected provider');
  const outputMode = env.OUTPUT_MODE ?? 'schema';
  if (outputMode !== 'schema' && outputMode !== 'prompt') throw new Error('OUTPUT_MODE must be schema or prompt');
  const make = (modelId: string): HostedModel => ({ providerId: `agency-${name}`, modelId,
    url: selected.url, apiKey, api: 'chat' });
  return { name, model: make(model), memoryModel: make(env.MEMORY_MODEL?.trim() || model),
    researchModel: make(env.RESEARCH_MODEL?.trim() || model), outputMode };
}

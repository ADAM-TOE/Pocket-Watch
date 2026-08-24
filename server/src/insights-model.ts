import { z } from 'zod';
import type { InsightModel, InsightModelInput } from './insights.js';

type AzureOpenAIConfig = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
};

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

const systemPrompt = `You select and rewrite validated budgeting facts into concise, neutral language.
Use only candidate IDs, evidence fact IDs, and exact allowedTemplates supplied in the input.
Return at most three insights. Copy an allowed template exactly; never add numbers, claims, or causes.
Return JSON matching the supplied schema and nothing else.`;

export function createAzureOpenAIInsightModel(
  config: AzureOpenAIConfig,
  request: typeof fetch = fetch,
): InsightModel {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}`
    + `/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;

  return {
    async rewrite(input: InsightModelInput, signal: AbortSignal): Promise<unknown> {
      const response = await request(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'api-key': config.apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) },
          ],
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'pocket_watch_insights',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['insights'],
                properties: {
                  insights: {
                    type: 'array',
                    maxItems: 3,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['candidateId', 'evidenceFactIds', 'text'],
                      properties: {
                        candidateId: { type: 'string' },
                        evidenceFactIds: { type: 'array', items: { type: 'string' } },
                        text: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Azure OpenAI request failed with status ${response.status}.`);
      }
      const completion = completionSchema.parse(await response.json());
      return JSON.parse(completion.choices[0].message.content) as unknown;
    },
  };
}

export function createAzureOpenAIInsightModelFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): InsightModel | undefined {
  const endpoint = environment.AZURE_OPENAI_ENDPOINT?.trim() ?? '';
  const apiKey = environment.AZURE_OPENAI_API_KEY?.trim() ?? '';
  if (!endpoint && !apiKey) return undefined;
  if (!endpoint || !apiKey) {
    throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set together.');
  }
  new URL(endpoint);

  return createAzureOpenAIInsightModel({
    endpoint,
    apiKey,
    deployment: environment.AZURE_OPENAI_DEPLOYMENT?.trim() || 'gpt-4.1-mini',
    apiVersion: environment.AZURE_OPENAI_API_VERSION?.trim() || '2024-10-21',
  }, request);
}
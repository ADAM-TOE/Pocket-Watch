import assert from 'node:assert/strict';
import test from 'node:test';
import { createAzureOpenAIInsightModel } from './insights-model.js';
import type { InsightModelInput } from './insights.js';

test('Azure adapter requests strict JSON and parses only assistant content', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"insights":[]}' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const model = createAzureOpenAIInsightModel({
    endpoint: 'https://pocket-watch.openai.azure.com/',
    apiKey: 'server-only-test-key',
    deployment: 'gpt-5-mini',
  }, fakeFetch);
  const input: InsightModelInput = {
    period: '2026-08',
    candidateFacts: [],
    allowedPlaceholders: [],
    maximumInsights: 3,
    tone: 'concise-neutral',
  };

  const output = await model.rewrite(input, new AbortController().signal);

  assert.deepEqual(output, { insights: [] });
  assert.equal(
    requestedUrl,
    'https://pocket-watch.openai.azure.com/openai/v1/chat/completions',
  );
  const headers = new Headers(requestedInit?.headers);
  assert.equal(headers.get('api-key'), 'server-only-test-key');
  const body = JSON.parse(String(requestedInit?.body));
  assert.equal(body.model, 'gpt-5-mini');
  assert.equal(body.reasoning_effort, 'minimal');
  assert.equal('temperature' in body, false);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal('maxItems' in body.response_format.json_schema.schema.properties.insights, false);
  assert.equal(body.messages[1].content.includes('2026-08'), true);
});
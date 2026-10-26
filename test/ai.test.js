'use strict';

// B6 AI client. Covers T-06 (reply must match schema), T-07 and T-14 (prompt variables).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPrompt, createAiClient } = require('../src/ai');
const { PromptVariableError, AiResponseError } = require('../src/errors');

test('T-07/T-14: a missing template variable is an explicit error, never an empty value', () => {
  assert.throws(
    () => renderPrompt('Hello {name}, price {price}', { name: 'Dana' }),
    (err) => err instanceof PromptVariableError && err.missing.join() === 'price'
  );
});

test('T-07/T-14: an empty or null value counts as missing (F-29)', () => {
  assert.throws(
    () => renderPrompt('Price {price}', { price: '' }),
    (err) => err instanceof PromptVariableError && err.missing.includes('price')
  );
  assert.throws(() => renderPrompt('Price {price}', { price: null }), PromptVariableError);
});

test('renders every placeholder when all values are present', () => {
  assert.equal(renderPrompt('Hello {name}, price {price}', { name: 'Dana', price: '100' }), 'Hello Dana, price 100');
});

test('model is required from config; there is no default model in code', () => {
  assert.throws(() => createAiClient({ apiKey: 'k' }), /model/i);
});

test('T-06: a reply that does not match the tool schema is rejected, not returned', async () => {
  const fetchStub = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'tool_use', name: 'send_whatsapp_reply', input: { wrong: 1 } }] }),
  });
  const client = createAiClient({ apiKey: 'k', model: 'test-model', fetch: fetchStub });
  const tool = {
    name: 'send_whatsapp_reply',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  };
  await assert.rejects(
    () => client.reply({ systemPrompt: 'x', messages: [{ role: 'user', content: 'hi' }], tool }),
    AiResponseError
  );
});

test('T-06: a reply without the forced tool call is rejected', async () => {
  const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) });
  const client = createAiClient({ apiKey: 'k', model: 'test-model', fetch: fetchStub });
  const tool = { name: 'send_whatsapp_reply', inputSchema: { type: 'object', properties: {} } };
  await assert.rejects(
    () => client.reply({ systemPrompt: 'x', messages: [{ role: 'user', content: 'hi' }], tool }),
    AiResponseError
  );
});

// Branch C additions.

const replyTool = {
  name: 'send_whatsapp_reply',
  inputSchema: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: {
      text: { type: 'string', minLength: 1 },
      handoff: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string', enum: ['lead', 'support'] } },
    },
  },
};

function stubFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const ask = { systemPrompt: 'You are a bot', messages: [{ role: 'user', content: 'hi' }], tool: replyTool };

test('T-07/T-14: every missing placeholder is listed once, in order of use', () => {
  assert.throws(
    () => renderPrompt('{a} {b} {a} {c}', { b: 'x' }),
    (err) => err instanceof PromptVariableError && err.missing.join() === 'a,c'
  );
});

test('T-07/T-14: a whitespace-only value counts as missing', () => {
  assert.throws(
    () => renderPrompt('Price {price}', { price: '   ' }),
    (err) => err instanceof PromptVariableError && err.missing.join() === 'price'
  );
});

test('renderPrompt ignores unused values, inserts values once, and keeps $ patterns literal', () => {
  assert.equal(renderPrompt('Hi {name}', { name: '{other} $& $1', other: 'x', unused: '' }), 'Hi {other} $& $1');
  assert.equal(renderPrompt('No placeholders', undefined), 'No placeholders');
});

test('renderPrompt accepts numbers, including 0', () => {
  assert.equal(renderPrompt('{n} items', { n: 0 }), '0 items');
});

test('apiKey is required', () => {
  assert.throws(() => createAiClient({ model: 'test-model' }), /apiKey/);
});

test('reply sends model from config, forced tool choice and tool schema; returns the tool input', async () => {
  const fetchFn = stubFetch({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'send_whatsapp_reply', input: { text: 'Hello', tags: ['lead'] } }],
  });
  const client = createAiClient({ apiKey: 'secret', model: 'claude-haiku-5-5', fetch: fetchFn });
  const result = await client.reply(ask);

  assert.deepEqual(result, { text: 'Hello', tags: ['lead'] });
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], 'secret');
  assert.ok(init.headers['anthropic-version']);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.system, 'You are a bot');
  assert.deepEqual(body.messages, ask.messages);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'send_whatsapp_reply' });
  assert.deepEqual(body.tools, [{ name: 'send_whatsapp_reply', input_schema: replyTool.inputSchema }]);
  assert.ok(body.max_tokens > 0);
});

test('T-06: wrong type, extra field, empty text or bad enum value is rejected', async () => {
  const bad = [
    { text: 5 },
    { text: 'ok', extra: true },
    { text: '' },
    { text: 'ok', tags: ['other'] },
    { text: 'ok', handoff: 'yes' },
    'not an object',
  ];
  for (const input of bad) {
    const client = createAiClient({
      apiKey: 'k',
      model: 'test-model',
      fetch: stubFetch({ content: [{ type: 'tool_use', name: 'send_whatsapp_reply', input }] }),
    });
    await assert.rejects(() => client.reply(ask), AiResponseError, JSON.stringify(input));
  }
});

test('T-06: a call to a different tool is rejected', async () => {
  const client = createAiClient({
    apiKey: 'k',
    model: 'test-model',
    fetch: stubFetch({ content: [{ type: 'tool_use', name: 'other_tool', input: { text: 'x' } }] }),
  });
  await assert.rejects(() => client.reply(ask), AiResponseError);
});

test('T-06: a reply cut off by max_tokens is rejected', async () => {
  const client = createAiClient({
    apiKey: 'k',
    model: 'test-model',
    fetch: stubFetch({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', name: 'send_whatsapp_reply', input: { text: 'x' } }] }),
  });
  await assert.rejects(() => client.reply(ask), AiResponseError);
});

test('an HTTP error or a network failure is an AiResponseError', async () => {
  const httpError = createAiClient({ apiKey: 'k', model: 'm', fetch: stubFetch({}, { ok: false, status: 529 }) });
  await assert.rejects(() => httpError.reply(ask), (err) => err instanceof AiResponseError && /529/.test(err.message));

  const network = createAiClient({ apiKey: 'k', model: 'm', fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => network.reply(ask), AiResponseError);
});

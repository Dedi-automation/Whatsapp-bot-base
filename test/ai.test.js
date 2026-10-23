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

'use strict';

// B5 WhatsApp client. Covers T-17 (non-text messages) and API error handling.
// Uses a stub fetch passed in by the test. The network is never called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsAppClient } = require('../src/whatsapp');
const { WhatsAppError } = require('../src/errors');

function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
  return { fn, calls };
}

test('sendText posts to the Cloud API with the bearer token and returns the message ID', async () => {
  const { fn, calls } = stubFetch(200, { messages: [{ id: 'wamid.abc' }] });
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: fn });
  const result = await client.sendText({ to: '972500000000', text: 'hi' });
  assert.equal(result.messageId, 'wamid.abc');
  assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/123\/messages$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('API error becomes a WhatsAppError with the Meta error code (for example 133010)', async () => {
  const { fn } = stubFetch(400, { error: { code: 133010, message: 'Number blocked' } });
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: fn });
  await assert.rejects(
    () => client.sendText({ to: '972500000000', text: 'hi' }),
    (err) => err instanceof WhatsAppError && err.code === 133010 && err.status === 400
  );
});

test('T-17: a voice note becomes kind "unsupported" with text null, not an empty string', () => {
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: stubFetch(200, {}).fn });
  const payload = {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.v1', from: '972500000000', type: 'audio' }] } }] }],
  };
  assert.deepEqual(client.parseIncoming(payload), [
    { kind: 'unsupported', messageId: 'wamid.v1', from: '972500000000', mediaType: 'audio', text: null },
  ]);
});

test('text message parses to kind "text"; status-only payloads produce no entries', () => {
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: stubFetch(200, {}).fn });
  const text = {
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.t1', from: '972500000000', type: 'text', text: { body: 'שלום' } }] } }] }],
  };
  assert.deepEqual(client.parseIncoming(text), [
    { kind: 'text', messageId: 'wamid.t1', from: '972500000000', text: 'שלום' },
  ]);
  assert.deepEqual(client.parseIncoming({ entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] }), []);
});

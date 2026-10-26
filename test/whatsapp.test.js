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

test('sendTemplate sends name, language and body parameters', async () => {
  const { fn, calls } = stubFetch(200, { messages: [{ id: 'wamid.tpl' }] });
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: fn });
  await client.sendTemplate({ to: '972500000000', templateName: 'reminder', language: 'he', params: ['Dana'] });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.type, 'template');
  assert.deepEqual(sent.template, {
    name: 'reminder',
    language: { code: 'he' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Dana' }] }],
  });
});

test('a network failure becomes a WhatsAppError', async () => {
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(() => client.sendText({ to: '972500000000', text: 'hi' }), WhatsAppError);
});

test('T-17: a quick-reply button counts as text; an empty text body is unsupported, never ""', () => {
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: stubFetch(200, {}).fn });
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { id: 'wamid.b1', from: '972500000000', type: 'button', button: { text: 'כן' } },
      { id: 'wamid.e1', from: '972500000000', type: 'text', text: { body: '' } },
    ] } }] }],
  };
  assert.deepEqual(client.parseIncoming(payload), [
    { kind: 'text', messageId: 'wamid.b1', from: '972500000000', text: 'כן' },
    { kind: 'unsupported', messageId: 'wamid.e1', from: '972500000000', mediaType: 'text', text: null },
  ]);
});

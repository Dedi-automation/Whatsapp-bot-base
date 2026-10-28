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

test('an image keeps its media ID, type and caption so it can be stored', () => {
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: stubFetch(200, {}).fn });
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { id: 'wamid.i1', from: '972500000000', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'צילום מסך' } },
    ] } }] }],
  };
  assert.deepEqual(client.parseIncoming(payload), [{
    kind: 'unsupported', messageId: 'wamid.i1', from: '972500000000', mediaType: 'image', text: null,
    media: { id: 'media-1', mimeType: 'image/jpeg', caption: 'צילום מסך' },
  }]);
});

test('downloadMedia resolves the media URL, then fetches the file with the token', async () => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/media-1')) {
      return { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.example/file', mime_type: 'image/jpeg' }) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: fn });
  const result = await client.downloadMedia({ mediaId: 'media-1' });
  assert.deepEqual([...result.data], [1, 2, 3]);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/media-1$/);
  assert.equal(calls[1].url, 'https://lookaside.example/file');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
});

test('downloadMedia fails with a WhatsAppError on an API error or a non-https URL', async () => {
  const apiError = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: stubFetch(404, { error: { code: 100, message: 'no media' } }).fn });
  await assert.rejects(() => apiError.downloadMedia({ mediaId: 'x' }), (err) => err instanceof WhatsAppError && err.status === 404);
  const httpUrl = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: stubFetch(200, { url: 'http://insecure.example/f' }).fn });
  await assert.rejects(() => httpUrl.downloadMedia({ mediaId: 'x' }), WhatsAppError);
});

// ---- base 1.1.0: outbound campaigns ----

test('sendTemplate adds the URL button parameter when the template has one', async () => {
  const { fn, calls } = stubFetch(200, { messages: [{ id: 'wamid.tpl' }] });
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: fn });
  await client.sendTemplate({ to: '972500000000', templateName: 'signup', language: 'he', params: [], urlButtonParam: 'abc' });
  assert.deepEqual(JSON.parse(calls[0].init.body).template, {
    name: 'signup',
    language: { code: 'he' },
    components: [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc' }] }],
  });
});

test('parseEvents reads statuses, quality and template updates; parseIncoming ignores them', () => {
  const client = createWhatsAppClient({ token: 'tok', phoneNumberId: '123', fetch: async () => { throw new Error('no network'); } });
  const payload = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              statuses: [
                { id: 'wamid.a', status: 'delivered', recipient_id: '972500000000' },
                { id: 'wamid.b', status: 'failed', recipient_id: '972500000001', errors: [{ code: 131026, title: 'Message undeliverable' }] },
                { status: 'read' },
              ],
            },
          },
          { field: 'phone_number_quality_update', value: { display_phone_number: '1', event: 'FLAGGED', current_limit: 'TIER_250' } },
          { field: 'message_template_status_update', value: { event: 'PAUSED', message_template_name: 'offer', reason: 'low quality' } },
          { field: 'message_template_quality_update', value: { new_quality_score: 'RED', message_template_name: 'offer' } },
        ],
      },
    ],
  };
  assert.deepEqual(client.parseEvents(payload), [
    { kind: 'status', messageId: 'wamid.a', status: 'delivered', recipient: '972500000000', errorCode: null, errorTitle: null },
    { kind: 'status', messageId: 'wamid.b', status: 'failed', recipient: '972500000001', errorCode: 131026, errorTitle: 'Message undeliverable' },
    { kind: 'quality', event: 'FLAGGED', currentLimit: 'TIER_250' },
    { kind: 'template', event: 'PAUSED', templateName: 'offer', reason: 'low quality' },
    { kind: 'template', event: 'RED', templateName: 'offer', reason: 'quality' },
  ]);
  assert.deepEqual(client.parseIncoming(payload), []);
  assert.deepEqual(client.parseEvents(null), []);
});

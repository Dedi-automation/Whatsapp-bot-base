'use strict';

// HTTP entry (Branch B). Covers T-02 and T-16 at the HTTP level, plus the webhook
// handshake, health route and job routes. Real HTTP on a random local port;
// WhatsApp, AI and storage are fakes or recording stubs, so nothing is sent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createServer, MAX_BODY_BYTES } = require('../src/server');
const { createWhatsAppClient } = require('../src/whatsapp');
const { createBot } = require('../src/index');
const { REQUIRED_ENV } = require('../src/config');
const { ConfigError } = require('../src/errors');

const config = {
  whatsappAppSecret: 'app-secret',
  whatsappVerifyToken: 'verify-me',
  scheduledJobToken: 'job-token',
};
const quietLog = { info() {}, error() {} };

async function start({ engine, jobs } = {}) {
  const handled = [];
  const whatsapp = createWhatsAppClient({ token: 't', phoneNumberId: '1', fetch: async () => { throw new Error('no network in tests'); } });
  const server = createServer({
    config,
    whatsapp,
    engine: engine || { handleIncoming: async (m) => { handled.push(m); return { status: 'replied', conversationId: m.from }; } },
    jobs,
    log: quietLog,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, handled, close: () => new Promise((resolve) => server.close(resolve)) };
}

const payload = (messages) => JSON.stringify({ entry: [{ changes: [{ value: { messages } }] }] });
const sign = (body, secret = config.whatsappAppSecret) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const textMessage = (id) => ({ id, from: '972500000000', type: 'text', text: { body: 'שלום' } });

test('GET /whatsapp-webhook answers the challenge only with the right verify token', async (t) => {
  const app = await start();
  t.after(app.close);
  const ok = await fetch(`${app.base}/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '123');
  const bad = await fetch(`${app.base}/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123`);
  assert.equal(bad.status, 403);
});

test('T-02: POST /whatsapp-webhook with a valid signature hands each message to the engine', async (t) => {
  const app = await start();
  t.after(app.close);
  const body = payload([textMessage('wamid.1'), textMessage('wamid.2')]);
  const res = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': sign(body) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: 2, results: ['replied', 'replied'] });
  assert.deepEqual(app.handled.map((m) => m.messageId), ['wamid.1', 'wamid.2']);
});

test('T-02: an invalid or missing signature is rejected with 401 and nothing is processed', async (t) => {
  const app = await start();
  t.after(app.close);
  const body = payload([textMessage('wamid.x')]);
  const forged = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': sign(body, 'other') } });
  const missing = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body });
  assert.equal(forged.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(app.handled.length, 0);
});

test('a signed body that is not JSON is 400; an oversized body is 413', async (t) => {
  const app = await start();
  t.after(app.close);
  const notJson = 'not json';
  const res = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body: notJson, headers: { 'X-Hub-Signature-256': sign(notJson) } });
  assert.equal(res.status, 400);
  const big = 'x'.repeat(MAX_BODY_BYTES + 1);
  const tooBig = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body: big, headers: { 'X-Hub-Signature-256': sign(big) } });
  assert.equal(tooBig.status, 413);
});

test('one failing message is logged and does not stop the others; the answer is still 200', async (t) => {
  const engine = {
    handleIncoming: async (m) => {
      if (m.messageId === 'wamid.bad') throw new Error('boom');
      return { status: 'replied', conversationId: m.from };
    },
  };
  const app = await start({ engine });
  t.after(app.close);
  const body = payload([textMessage('wamid.bad'), textMessage('wamid.good')]);
  const res = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': sign(body) } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).results, ['error', 'replied']);
});

test('GET /health is a liveness check', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('T-16: a job runs only with the job token in the Authorization header', async (t) => {
  let runs = 0;
  const app = await start({ jobs: { 'send-reminders': async () => { runs += 1; return { sent: 0 }; } } });
  t.after(app.close);
  const url = `${app.base}/jobs/send-reminders`;
  const noToken = await fetch(url, { method: 'POST' });
  const inQuery = await fetch(`${url}?token=job-token`, { method: 'POST', headers: { Authorization: 'Bearer job-token' } });
  const ok = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer job-token' } });
  assert.equal(noToken.status, 401);
  assert.equal(inQuery.status, 401);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, result: { sent: 0 } });
  assert.equal(runs, 1);
});

test('an unknown job is 404, a failing job is 500, a GET on a job is 405', async (t) => {
  const app = await start({ jobs: { 'archive-leads': async () => { throw new Error('boom'); } } });
  t.after(app.close);
  const auth = { Authorization: 'Bearer job-token' };
  assert.equal((await fetch(`${app.base}/jobs/nope`, { method: 'POST', headers: auth })).status, 404);
  assert.equal((await fetch(`${app.base}/jobs/archive-leads`, { method: 'POST', headers: auth })).status, 500);
  assert.equal((await fetch(`${app.base}/jobs/archive-leads`, { headers: auth })).status, 405);
});

test('F-26: routes outside the base do not exist', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const path of ['/test-sheet', '/billing/charge', '/demo-intake', '/admin/agents']) {
    assert.equal((await fetch(`${app.base}${path}`)).status, 404, path);
  }
});

test('T-01: createBot fails at startup when a required variable is missing', () => {
  assert.throws(() => createBot({ env: {}, systemPrompt: 's', tool: {}, unsupportedReplyText: 'x' }), ConfigError);
});

test('createBot wires the engine to the webhook route', async (t) => {
  const { createMemoryStorage } = require('../src/fakes/memory-storage');
  const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
  const { createFakeAiClient } = require('../src/fakes/ai-fake');
  const env = Object.fromEntries(REQUIRED_ENV.map((name) => [name, `value-of-${name}`]));
  const whatsapp = createFakeWhatsAppClient();
  whatsapp.parseIncoming = createWhatsAppClient({ token: 't', phoneNumberId: '1' }).parseIncoming;
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const bot = createBot({
    env,
    storage,
    whatsapp,
    ai: createFakeAiClient([{ text: 'תודה' }]),
    holidays: [],
    now: () => new Date('2026-10-25T08:00:00Z'),
    systemPrompt: 'system',
    tool: { name: 'send_whatsapp_reply', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    unsupportedReplyText: 'text only',
    log: quietLog,
  });
  // Sunday 11:00 Israel time: inside the real send window (Branch D).
  await new Promise((resolve) => bot.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bot.server.close(resolve)));
  const body = payload([textMessage('wamid.wired')]);
  const res = await fetch(`http://127.0.0.1:${bot.server.address().port}/whatsapp-webhook`, {
    method: 'POST',
    body,
    headers: { 'X-Hub-Signature-256': sign(body, 'value-of-WHATSAPP_APP_SECRET') },
  });
  assert.equal(res.status, 200);
  const { received, results } = await res.json();
  assert.equal(received, 1);
  assert.equal(results[0], 'replied');
  assert.equal(whatsapp.sent[0].text, 'תודה');
  assert.equal((await storage.get('messages', '972500000000:1')).messageId, 'wamid.wired');
});

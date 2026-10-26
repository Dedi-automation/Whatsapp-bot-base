'use strict';

// Stage 2 integration. T-09 DRY RUN against Firestore (emulator), and createBot
// wiring of the admin dashboard and email (B10, B11).
// The same DRY RUN on the in-memory fake runs in test/conversation.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runDryRun } = require('../scripts/dry-run');
const { createStorage } = require('../src/storage');
const { createBot } = require('../src/index');
const { REQUIRED_ENV } = require('../src/config');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { createFakeAiClient } = require('../src/fakes/ai-fake');
const { createFakeEmailClient } = require('../src/fakes/email-fake');

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const firestoreSkip = EMULATOR ? false : 'not run: FIRESTORE_EMULATOR_HOST is not set';

test('T-09: DRY RUN end to end on Firestore (emulator), nothing real sent', { skip: firestoreSkip }, async () => {
  const report = await runDryRun({ storage: createStorage({ projectId: `t09-${Date.now()}` }) });
  assert.deepEqual(report.checks.filter(([, pass]) => !pass), []);
  assert.ok(report.wouldSend.length > 0);
});

const env = (extra = {}) => ({ ...Object.fromEntries(REQUIRED_ENV.map((n) => [n, `value-of-${n}`])), APP_BASE_URL: 'https://bot.example.com', ...extra });
const TOOL = { name: 'send_whatsapp_reply', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, handoff: { type: 'boolean' } } } };

async function startBot(options) {
  const bot = createBot({
    systemPrompt: 's',
    tool: TOOL,
    unsupportedReplyText: 'x',
    storage: createMemoryStorage({ projectId: 'wiring' }),
    whatsapp: createFakeWhatsAppClient(),
    log: { info() {}, error() {} },
    // Monday 12:00 Israel time, inside the send window.
    now: () => new Date('2026-10-26T10:00:00Z'),
    ...options,
  });
  bot.server.listen(0, '127.0.0.1');
  await new Promise((r) => bot.server.once('listening', r));
  return { bot, base: `http://127.0.0.1:${bot.server.address().port}`, close: () => new Promise((r) => bot.server.close(r)) };
}

test('createBot mounts the admin dashboard at /admin', async (t) => {
  const app = await startBot({ env: env(), ai: createFakeAiClient([]) });
  t.after(app.close);
  const res = await fetch(`${app.base}/admin/leads`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login');
});

test('createBot: with email configured, a handoff emails NOTIFY_EMAIL a dashboard link without a token', async (t) => {
  const email = createFakeEmailClient();
  const storage = createMemoryStorage({ projectId: 'wiring-email' });
  const app = await startBot({
    env: env({ SENDGRID_API_KEY: 'k', SENDGRID_FROM_EMAIL: 'bot@example.com', NOTIFY_EMAIL: 'agent@example.com' }),
    ai: createFakeAiClient([{ text: 'thanks', handoff: true }]),
    email,
    storage,
    botName: 'Bot',
  });
  t.after(app.close);
  const crypto = require('node:crypto');
  const raw = JSON.stringify({ messages: [{ kind: 'text', messageId: 'w1', from: '972500000001', text: 'agent please' }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'value-of-WHATSAPP_APP_SECRET').update(raw).digest('hex');
  const res = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig } });
  assert.deepEqual((await res.json()).results, ['handoff']);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0].to, 'agent@example.com');
  assert.match(email.sent[0].text, /https:\/\/bot\.example\.com\/admin\/leads\/972500000001/);
  assert.ok(!email.sent[0].text.includes('value-of-ADMIN_TOKEN'));
});

test('createBot: without email variables, a handoff sends no email and still succeeds', async (t) => {
  const email = createFakeEmailClient();
  const app = await startBot({ env: env(), ai: createFakeAiClient([{ text: 'thanks', handoff: true }]), email });
  t.after(app.close);
  const crypto = require('node:crypto');
  const raw = JSON.stringify({ messages: [{ kind: 'text', messageId: 'w1', from: '972500000001', text: 'agent please' }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'value-of-WHATSAPP_APP_SECRET').update(raw).digest('hex');
  const res = await fetch(`${app.base}/whatsapp-webhook`, { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig } });
  assert.deepEqual((await res.json()).results, ['handoff']);
  assert.equal(email.sent.length, 0);
});

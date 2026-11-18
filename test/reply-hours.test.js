'use strict';

// T-25 Reply hours per bot (decisions.md item 58, base 1.2.0): replyHours 'always'
// answers customers at any hour; the default keeps the send window; outbound keeps
// the send window either way.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBot } = require('../src/index');
const { REQUIRED_ENV } = require('../src/config');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { createFakeAiClient } = require('../src/fakes/ai-fake');

const env = Object.fromEntries(REQUIRED_ENV.map((n) => [n, `value-of-${n}`]));
env.APP_BASE_URL = 'https://bot.example.com';
const TOOL = { name: 'send_whatsapp_reply', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } };
const SATURDAY_NIGHT = new Date('2026-11-21T21:30:00Z'); // Saturday 23:30 Israel time
const WEDNESDAY_EVENING = new Date('2026-11-18T18:00:00Z'); // Wednesday 20:00

async function startBot({ replyHours, when, aiReplies = [], outbound }) {
  const whatsapp = createFakeWhatsAppClient();
  const ai = createFakeAiClient(aiReplies);
  const bot = createBot({
    env,
    systemPrompt: 's',
    tool: TOOL,
    unsupportedReplyText: 'text only please',
    storage: createMemoryStorage({ projectId: 'reply-hours' }),
    whatsapp,
    ai,
    now: () => when,
    log: { info() {}, error() {} },
    ...(replyHours === undefined ? {} : { replyHours }),
    ...(outbound ? { outbound } : {}),
  });
  bot.server.listen(0, '127.0.0.1');
  await new Promise((r) => bot.server.once('listening', r));
  const base = `http://127.0.0.1:${bot.server.address().port}`;
  let n = 0;
  const deliver = async (message) => {
    n += 1;
    const raw = JSON.stringify({ messages: [{ messageId: `w${n}`, from: '972500000001', ...message }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
    const res = await fetch(`${base}/whatsapp-webhook`, { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig } });
    return (await res.json()).results[0];
  };
  const job = async (name) => {
    const res = await fetch(`${base}/jobs/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${env.SCHEDULED_JOB_TOKEN}` } });
    return res.json();
  };
  return { whatsapp, ai, deliver, job, close: () => new Promise((r) => bot.server.close(r)) };
}

test('T-25 default reply hours: no reply on a weekday evening (send window, item 17)', async (t) => {
  const app = await startBot({ when: WEDNESDAY_EVENING });
  t.after(app.close);
  assert.equal(await app.deliver({ kind: 'text', text: 'hi' }), 'outside_window');
  assert.equal(app.whatsapp.sent.length, 0);
  assert.equal(app.ai.calls.length, 0);
});

test('T-25 replyHours always: answers on Saturday night, text and voice note', async (t) => {
  const app = await startBot({ replyHours: 'always', when: SATURDAY_NIGHT, aiReplies: [{ text: 'hello at night' }] });
  t.after(app.close);
  assert.equal(await app.deliver({ kind: 'text', text: 'hi' }), 'replied');
  assert.equal(await app.deliver({ kind: 'unsupported', mediaType: 'audio' }), 'unsupported_reply');
  assert.deepEqual(app.whatsapp.sent.map((s) => s.text), ['hello at night', 'text only please']);
});

test("T-25 replyHours 'window' explicitly is the same as the default", async (t) => {
  const app = await startBot({ replyHours: 'window', when: SATURDAY_NIGHT });
  t.after(app.close);
  assert.equal(await app.deliver({ kind: 'text', text: 'hi' }), 'outside_window');
});

test('T-25 replyHours always: campaigns still send only inside the send window', async (t) => {
  const app = await startBot({
    replyHours: 'always',
    when: SATURDAY_NIGHT,
    outbound: { optOutReplyText: 'removed', templates: { offer: { name: 'offer', language: 'he', params: [] } } },
  });
  t.after(app.close);
  const out = await app.job('send-campaigns');
  assert.equal(out.result.status, 'outside_window');
  assert.equal(app.whatsapp.sent.length, 0);
});

test('T-25 replyHours always: an opt-out word at night is confirmed at once', async (t) => {
  const app = await startBot({ replyHours: 'always', when: SATURDAY_NIGHT, outbound: { optOutReplyText: 'removed' } });
  t.after(app.close);
  assert.equal(await app.deliver({ kind: 'text', text: 'הסר' }), 'opted_out');
  assert.deepEqual(app.whatsapp.sent.map((s) => s.text), ['removed']);
});

test('T-25 a bad replyHours value stops startup', () => {
  assert.throws(() => createBot({ env, systemPrompt: 's', tool: TOOL, unsupportedReplyText: 'x', storage: createMemoryStorage({ projectId: 'x' }), whatsapp: createFakeWhatsAppClient(), ai: createFakeAiClient([]), replyHours: '24/7' }), /replyHours must be 'window' or 'always'/);
});

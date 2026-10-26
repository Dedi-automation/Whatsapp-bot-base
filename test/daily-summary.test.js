'use strict';

// Daily summary for the agent (Dedi, 2026-10-26: every day at 18:15).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDailySummary } = require('../src/daily-summary');
const { createMemoryStorage } = require('../src/fakes/memory-storage');

// Monday 26 Oct 2026, 18:15 Israel time (UTC+2 after the clock change on 25 Oct).
const NOW = new Date('2026-10-26T16:15:00Z');

async function seed() {
  const storage = createMemoryStorage({ projectId: 'summary' });
  // New today, asked for an agent today, waiting, callback today.
  await storage.set('conversations', '972500000001', { lastMessageAt: '2026-10-26T08:00:00Z', handoffAt: '2026-10-26T08:05:00Z', agent_action_required: true, handoff_reason: 'price', callbackDate: '26/10/2026' });
  await storage.set('messages', '972500000001:1', { at: '2026-10-26T07:59:00Z' });
  // Old lead, active today, callback tomorrow.
  await storage.set('conversations', '972500000002', { lastMessageAt: '2026-10-26T15:00:00Z', callbackDate: '27/10/2026' });
  await storage.set('messages', '972500000002:1', { at: '2026-10-20T10:00:00Z' });
  // Old lead waiting since yesterday, malformed callback date (skipped, not thrown).
  await storage.set('conversations', '972500000003', { lastMessageAt: '2026-10-25T10:00:00Z', agent_action_required: true, callbackDate: '2026-10-26' });
  await storage.set('messages', '972500000003:1', { at: '2026-10-25T09:00:00Z' });
  // 22:30 UTC on the 25th is 00:30 on the 26th in Israel: counts as today.
  await storage.set('conversations', '972500000004', { lastMessageAt: '2026-10-25T22:30:00Z' });
  await storage.set('messages', '972500000004:1', { at: '2026-10-25T22:30:00Z' });
  return storage;
}

test('counts are for the Israel calendar day', async () => {
  const s = await buildDailySummary({ storage: await seed(), now: () => NOW, dashboardUrl: 'https://bot.example.com/' });
  assert.deepEqual(s.counts, { newLeads: 2, activeToday: 3, handoffsToday: 1, waiting: 2, callbacksToday: 1 });
});

test('text lists the leads waiting for the agent and links to the dashboard without a token', async () => {
  const s = await buildDailySummary({ storage: await seed(), now: () => NOW, botName: 'בוט', dashboardUrl: 'https://bot.example.com/' });
  assert.match(s.subject, /סיכום יומי - בוט - 26\/10\/2026/);
  assert.match(s.text, /- 972500000001 \(price\)/);
  assert.match(s.text, /- 972500000003/);
  assert.match(s.text, /ללוח: https:\/\/bot\.example\.com\/admin\/leads$/);
  assert.ok(!s.text.includes('token'));
});

test('an empty day gives zeros, not an error', async () => {
  const s = await buildDailySummary({ storage: createMemoryStorage({ projectId: 'empty' }), now: () => NOW, dashboardUrl: 'https://x.example.com' });
  assert.deepEqual(s.counts, { newLeads: 0, activeToday: 0, handoffsToday: 0, waiting: 0, callbacksToday: 0 });
  assert.ok(!s.text.includes('מחכים לטיפול:'));
});

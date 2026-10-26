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

// Weekly and monthly summaries (Dedi, 2026-10-26): the daily counts are saved and summed.
const { buildDigest, SUMMARIES } = require('../src/daily-summary');

const at = (iso) => () => new Date(iso);
async function seedDays(storage, from, to, counts) {
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    await storage.set(SUMMARIES, date, { date, ...counts });
  }
}

test('digest on a Monday saves the day and sends no week or month', async () => {
  const storage = await seed();
  const r = await buildDigest({ storage, now: () => NOW, dashboardUrl: 'https://bot.example.com' });
  assert.equal(r.date, '2026-10-26');
  assert.equal(r.week, null);
  assert.equal(r.monthly, null);
  const saved = await storage.get(SUMMARIES, '2026-10-26');
  assert.equal(saved.newLeads, 2);
  assert.equal(saved.handoffsToday, 1);
});

test('digest on Thursday adds the 7 days ending that day (Friday to Thursday)', async () => {
  const storage = createMemoryStorage({ projectId: 'week' });
  await seedDays(storage, '2026-10-22', '2026-10-28', { newLeads: 2, activeToday: 5, handoffsToday: 1, callbacksToday: 1, waiting: 0 });
  // Thursday 29 Oct 2026, 18:15 Israel time. The 22nd belongs to the week before.
  const r = await buildDigest({ storage, now: at('2026-10-29T16:15:00Z'), botName: 'בוט', dashboardUrl: 'https://bot.example.com' });
  assert.deepEqual(r.week, { from: '2026-10-23', to: '2026-10-29', totals: { newLeads: 12, activeToday: 30, handoffsToday: 6, callbacksToday: 6 }, daysRecorded: 7 });
  assert.match(r.daily.subject, /סיכום יומי ושבועי - בוט - 29\/10\/2026/);
  assert.match(r.daily.text, /סיכום שבועי 23\/10\/2026 עד 29\/10\/2026\nלידים חדשים: 12\nביקשו נציג: 6/);
  assert.ok(r.daily.text.endsWith('ללוח: https://bot.example.com/admin/leads'), 'link stays last');
  assert.ok(!r.daily.text.includes('שים לב'), 'all 7 days recorded');
});

test('a day the job did not run is reported as missing, not guessed', async () => {
  const storage = createMemoryStorage({ projectId: 'gap' });
  await seedDays(storage, '2026-10-23', '2026-10-25', { newLeads: 1, activeToday: 1, handoffsToday: 0, callbacksToday: 0, waiting: 0 });
  const r = await buildDigest({ storage, now: at('2026-10-29T16:15:00Z'), dashboardUrl: 'https://bot.example.com' });
  assert.equal(r.week.daysRecorded, 4);
  assert.equal(r.week.totals.newLeads, 3);
  assert.match(r.daily.text, /שים לב: נשמרו נתונים ל-4 ימים מתוך 7/);
});

test('digest on the 1st adds the previous month by weeks, with the bot note', async () => {
  const storage = createMemoryStorage({ projectId: 'month' });
  await seedDays(storage, '2026-09-30', '2026-10-30', { newLeads: 1, activeToday: 2, handoffsToday: 1, callbacksToday: 0, waiting: 0 });
  await storage.set(SUMMARIES, '2026-10-31', { date: '2026-10-31', newLeads: 0, activeToday: 0, handoffsToday: 0, callbacksToday: 0, waiting: 0 });
  // Sunday 1 Nov 2026 (not a Thursday): monthly for October only.
  const r = await buildDigest({ storage, now: at('2026-11-01T16:15:00Z'), botName: 'בוט', dashboardUrl: 'https://bot.example.com', monthlyNote: 'החשבונית החודשית נשלחת בנפרד מ-Grow.\nתודה' });
  assert.equal(r.week, null);
  assert.equal(r.monthly.from, '2026-10-01');
  assert.equal(r.monthly.to, '2026-10-31');
  assert.equal(r.monthly.daysRecorded, 31);
  assert.equal(r.monthly.totals.newLeads, 30, 'September 30 and November 1 are not counted');
  assert.match(r.monthly.subject, /סיכום חודשי - בוט - 10\/2026/);
  const weeks = r.monthly.text.split('\n').filter((l) => l.startsWith('- ') && l.includes(' עד '));
  assert.deepEqual(weeks.map((l) => l.slice(2, 16)), ['01/10 עד 01/10', '02/10 עד 08/10', '09/10 עד 15/10', '16/10 עד 22/10', '23/10 עד 29/10', '30/10 עד 31/10']);
  assert.match(weeks[1], /לידים חדשים 7, ביקשו נציג 7/);
  assert.match(r.monthly.text, /החשבונית החודשית נשלחת בנפרד מ-Grow\. תודה/);
  assert.ok(r.monthly.text.endsWith('ללוח: https://bot.example.com/admin/leads'));
});

test('a Thursday on the 1st gives both the week and the previous month', async () => {
  const storage = createMemoryStorage({ projectId: 'both' });
  await storage.set(SUMMARIES, '2026-09-30', { date: '2026-09-30', newLeads: 4, activeToday: 4, handoffsToday: 0, callbacksToday: 0, waiting: 0 });
  // Thursday 1 Oct 2026, 18:15 Israel time (UTC+3).
  const r = await buildDigest({ storage, now: at('2026-10-01T15:15:00Z'), dashboardUrl: 'https://bot.example.com' });
  assert.equal(r.week.from, '2026-09-25');
  assert.equal(r.week.totals.newLeads, 4);
  assert.equal(r.monthly.from, '2026-09-01');
  assert.equal(r.monthly.to, '2026-09-30');
  assert.match(r.monthly.subject, /09\/2026/);
  assert.match(r.monthly.text, /שים לב: נשמרו נתונים ל-1 ימים מתוך 30/);
  assert.ok(!r.monthly.text.includes('Grow'), 'no note unless the bot sets one');
});

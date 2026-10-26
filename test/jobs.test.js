'use strict';

// B9 Scheduled jobs. Covers T-08 (one send per run key), F-15 (all agents), F-16 (DD/MM/YYYY).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJobRunner, parseDdMmYyyy } = require('../src/jobs');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { SchemaError } = require('../src/errors');

const now = () => new Date('2026-10-25T10:00:00+02:00');

test('T-08: two runs of the same reminder with the same run key send one message only', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const runner = createJobRunner({ storage, now });
  let sends = 0;
  const action = async () => {
    sends += 1;
  };
  const [a, b] = await Promise.all([
    runner.runOnce('send-reminders', 'reminders-2026-10-25', action),
    runner.runOnce('send-reminders', 'reminders-2026-10-25', action),
  ]);
  assert.equal(sends, 1);
  assert.deepEqual([a.status, b.status].sort(), ['already_done', 'ran']);
});

test('T-08: a later run with the same key is already_done and does not send again', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const runner = createJobRunner({ storage, now });
  let sends = 0;
  await runner.runOnce('send-reminders', 'k1', async () => { sends += 1; });
  const again = await runner.runOnce('send-reminders', 'k1', async () => { sends += 1; });
  assert.equal(again.status, 'already_done');
  assert.equal(sends, 1);
});

test('F-15: due reminders are found across all agents in the collection, not one tab', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await storage.set('leads', 'c1', { agent: 'dedi', callbackDate: '25/10/2026' });
  await storage.set('leads', 'c2', { agent: 'ofir', callbackDate: '25/10/2026' });
  const runner = createJobRunner({ storage, now });
  const due = await runner.findDueReminders({ collection: 'leads', today: now() });
  assert.deepEqual(due.map((r) => r.id).sort(), ['c1', 'c2']);
});

test('F-16: DD/MM/YYYY is parsed as day, month, year (05/03/2026 is 5 March)', () => {
  const d = parseDdMmYyyy('05/03/2026');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 5);
});

test('F-16: an impossible or malformed date is an error, not a silent shift', () => {
  assert.throws(() => parseDdMmYyyy('31/02/2026'), SchemaError);
  assert.throws(() => parseDdMmYyyy('2026-03-05'), SchemaError);
});

test('T-08: a failed run releases the lock so a retry can run', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const runner = createJobRunner({ storage, now });
  await assert.rejects(
    runner.runOnce('send-reminders', 'k1', async () => { throw new Error('send failed'); }),
    /send failed/,
  );
  let sends = 0;
  const retry = await runner.runOnce('send-reminders', 'k1', async () => { sends += 1; });
  assert.equal(retry.status, 'ran');
  assert.equal(sends, 1);
});

test('T-08: different run keys or job names each run once', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const runner = createJobRunner({ storage, now });
  let sends = 0;
  const action = async () => { sends += 1; };
  await runner.runOnce('send-reminders', 'k1', action);
  await runner.runOnce('send-reminders', 'k2', action);
  await runner.runOnce('send-daily-digest', 'k1', action);
  assert.equal(sends, 3);
});

test('F-15: records due on another date or with no date are not returned', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await storage.set('leads', 'today', { agent: 'dedi', callbackDate: '25/10/2026' });
  await storage.set('leads', 'tomorrow', { agent: 'dedi', callbackDate: '26/10/2026' });
  await storage.set('leads', 'yesterday', { agent: 'ofir', callbackDate: '24/10/2026' });
  await storage.set('leads', 'none', { agent: 'ofir', callbackDate: '' });
  await storage.set('leads', 'missing', { agent: 'ofir' });
  const runner = createJobRunner({ storage, now });
  const due = await runner.findDueReminders({ collection: 'leads', today: now() });
  assert.deepEqual(due.map((r) => r.id), ['today']);
});

test('F-15: "today" is the Israel date, even when the UTC date differs', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await storage.set('leads', 'c1', { callbackDate: '26/10/2026' });
  const runner = createJobRunner({ storage, now });
  // 2026-10-25T22:30Z is 2026-10-26 00:30 in Israel.
  const due = await runner.findDueReminders({ collection: 'leads', today: new Date('2026-10-25T22:30:00Z') });
  assert.deepEqual(due.map((r) => r.id), ['c1']);
});

test('F-15: the date field name can be passed in', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await storage.set('leads', 'c1', { followupDate: '25/10/2026' });
  const runner = createJobRunner({ storage, now });
  const due = await runner.findDueReminders({ collection: 'leads', today: now(), dateField: 'followupDate' });
  assert.deepEqual(due.map((r) => r.id), ['c1']);
});

test('F-16: a malformed date in a record is a SchemaError naming the record', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await storage.set('leads', 'bad', { callbackDate: '10/25/2026' });
  const runner = createJobRunner({ storage, now });
  await assert.rejects(
    runner.findDueReminders({ collection: 'leads', today: now() }),
    (err) => err instanceof SchemaError && /leads\/bad/.test(err.message),
  );
});

test('F-16: single-digit day and month, and surrounding spaces, are accepted', () => {
  const d = parseDdMmYyyy(' 5/3/2026 ');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 2, 5]);
  const leap = parseDdMmYyyy('29/02/2028');
  assert.equal(leap.getDate(), 29);
});

test('F-16: more malformed inputs are errors', () => {
  for (const bad of ['29/02/2026', '00/01/2026', '01/13/2026', '1/1/26', '', '05-03-2026', '05/03/2026 10:00']) {
    assert.throws(() => parseDdMmYyyy(bad), SchemaError, bad);
  }
  assert.throws(() => parseDdMmYyyy(undefined), SchemaError);
});

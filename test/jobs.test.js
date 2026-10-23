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

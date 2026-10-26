'use strict';

// B13 Archive. Covers F-17 (start date and eligible statuses from config) and archive correctness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createArchiver } = require('../src/archive');
const { createMemoryStorage } = require('../src/fakes/memory-storage');

const config = { archive: { startDate: '2026-01-01', eligibleStatuses: ['closed'] } };
const now = () => new Date('2026-10-25T10:00:00+02:00');

async function seed(storage) {
  await storage.set('leads', 'old-closed', { status: 'closed', createdAt: '2025-06-01' });
  await storage.set('leads', 'old-open', { status: 'open', createdAt: '2025-06-01' });
  await storage.set('leads', 'new-closed', { status: 'closed', createdAt: '2026-05-01' });
}

test('moves eligible records created before the start date to the archive collection', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await seed(storage);
  const archiver = createArchiver({ storage, now, config });
  const result = await archiver.archiveOldRecords('leads', 'leads_archive');
  assert.equal(result.moved, 1);
  assert.notEqual(await storage.get('leads_archive', 'old-closed'), null);
  assert.equal(await storage.get('leads', 'old-closed'), null);
});

test('records that are not eligible or are too recent stay in place', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await seed(storage);
  await createArchiver({ storage, now, config }).archiveOldRecords('leads', 'leads_archive');
  assert.notEqual(await storage.get('leads', 'old-open'), null);
  assert.notEqual(await storage.get('leads', 'new-closed'), null);
});

test('running twice moves nothing the second time', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await seed(storage);
  const archiver = createArchiver({ storage, now, config });
  await archiver.archiveOldRecords('leads', 'leads_archive');
  const second = await archiver.archiveOldRecords('leads', 'leads_archive');
  assert.equal(second.moved, 0);
});

test('F-17: start date and statuses come from config, not code', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await seed(storage);
  const other = { archive: { startDate: '2026-12-31', eligibleStatuses: ['closed', 'open'] } };
  const result = await createArchiver({ storage, now, config: other }).archiveOldRecords('leads', 'leads_archive');
  assert.equal(result.moved, 3);
});

test('createdAt as an ISO timestamp is read by its date; missing createdAt stays in place', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await storage.set('leads', 'iso', { status: 'closed', createdAt: '2025-06-01T08:00:00.000Z' });
  await storage.set('leads', 'no-date', { status: 'closed' });
  const result = await createArchiver({ storage, now, config }).archiveOldRecords('leads', 'leads_archive');
  assert.equal(result.moved, 1);
  assert.notEqual(await storage.get('leads', 'no-date'), null);
});

test('the archived copy keeps the record data unchanged', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await seed(storage);
  await createArchiver({ storage, now, config }).archiveOldRecords('leads', 'leads_archive');
  assert.deepEqual(await storage.get('leads_archive', 'old-closed'), { status: 'closed', createdAt: '2025-06-01' });
});

test('missing or malformed archive config is an error at startup', () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  assert.throws(() => createArchiver({ storage, now, config: {} }), TypeError);
  assert.throws(() => createArchiver({ storage, now, config: { archive: { startDate: '01/01/2026', eligibleStatuses: ['closed'] } } }), TypeError);
  assert.throws(() => createArchiver({ storage, now, config: { archive: { startDate: '2026-01-01', eligibleStatuses: [] } } }), TypeError);
});

'use strict';

// B3 Storage contract. The same contract runs against:
//  - the real Firestore-backed createStorage (fails until Branch A), and
//  - the in-memory fake (must pass; see test/fakes/memory-storage.test.js).
// Covers T-05 (project isolation) and T-11 (records survive a restart).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/storage');
const { createMemoryStorage } = require('../src/fakes/memory-storage');

function storageContract(name, factory) {
  test(`${name}: get returns null for a missing record`, async () => {
    const s = factory('bot-a');
    assert.equal(await s.get('leads', 'nope'), null);
  });

  test(`${name}: set then get returns the same fields`, async () => {
    const s = factory('bot-a');
    await s.set('leads', 'c1', { status: 'new', name: 'Dana' });
    assert.deepEqual(await s.get('leads', 'c1'), { status: 'new', name: 'Dana' });
  });

  test(`${name}: createIfAbsent is true once, false after`, async () => {
    const s = factory('bot-a');
    assert.equal(await s.createIfAbsent('locks', 'job-1', { at: 1 }), true);
    assert.equal(await s.createIfAbsent('locks', 'job-1', { at: 2 }), false);
    assert.deepEqual(await s.get('locks', 'job-1'), { at: 1 });
  });

  test(`${name}: delete of a missing record is not an error`, async () => {
    const s = factory('bot-a');
    await s.delete('leads', 'missing');
  });

  test(`${name}: list returns every record of the collection`, async () => {
    const s = factory('bot-a');
    await s.set('leads', 'c1', { agent: 'a' });
    await s.set('leads', 'c2', { agent: 'b' });
    const ids = (await s.list('leads')).map((r) => r.id).sort();
    assert.deepEqual(ids, ['c1', 'c2']);
  });

  test(`${name} T-05: two projects never see each other's records`, async () => {
    const a = factory('project-a');
    const b = factory('project-b');
    await a.set('leads', 'c1', { secret: 'only-a' });
    assert.equal(await b.get('leads', 'c1'), null);
    assert.deepEqual(await b.list('leads'), []);
  });
}

storageContract('Firestore storage', (projectId) => createStorage({ projectId }));
storageContract('Memory fake', (projectId) => createMemoryStorage({ projectId }));

test('T-11: a transcript record survives a restart (new storage instance, same project)', async () => {
  // Real test needs Firestore. Written here so Branch A cannot skip it.
  const first = createStorage({ projectId: 'test-a' });
  await first.set('messages', 'conv-1:1', { text: 'hello' });
  const second = createStorage({ projectId: 'test-a' });
  assert.deepEqual(await second.get('messages', 'conv-1:1'), { text: 'hello' });
});

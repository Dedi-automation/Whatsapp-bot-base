'use strict';

// B3 Storage contract. The same contract runs against:
//  - the real Firestore-backed createStorage (fails until Branch A), and
//  - the in-memory fake (must pass; see test/fakes/memory-storage.test.js).
// Covers T-05 (project isolation) and T-11 (records survive a restart).
//
// Firestore cases run against the Firestore emulator (Branch A):
//   1. Start it: gcloud emulators firestore start --host-port=127.0.0.1:8080
//   2. Set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 in the shell.
//   3. npm run test:firestore   (fails at once if the variable is not set)
// Under plain `npm test` without the emulator they are reported as skipped
// (not run), never as passed. Emulator data is cleared before they run.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/storage');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { StorageError } = require('../src/errors');

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
if (!EMULATOR && process.env.npm_lifecycle_event === 'test:firestore') {
  throw new Error('test:firestore needs FIRESTORE_EMULATOR_HOST (see the top of test/storage.test.js)');
}
const firestoreSkip = EMULATOR ? false : 'not run: FIRESTORE_EMULATOR_HOST is not set';
const FIRESTORE_PROJECTS = ['bot-a', 'project-a', 'project-b', 'test-a'];

if (EMULATOR) {
  before(async () => {
    for (const projectId of FIRESTORE_PROJECTS) {
      const url = `http://${EMULATOR}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Could not clear emulator data for ${projectId}: HTTP ${res.status}`);
    }
  });
}

function storageContract(name, factory, skip = false) {
  test(`${name}: get returns null for a missing record`, { skip }, async () => {
    const s = factory('bot-a');
    assert.equal(await s.get('leads', 'nope'), null);
  });

  test(`${name}: set then get returns the same fields`, { skip }, async () => {
    const s = factory('bot-a');
    await s.set('leads', 'c1', { status: 'new', name: 'Dana' });
    assert.deepEqual(await s.get('leads', 'c1'), { status: 'new', name: 'Dana' });
  });

  test(`${name}: createIfAbsent is true once, false after`, { skip }, async () => {
    const s = factory('bot-a');
    assert.equal(await s.createIfAbsent('locks', 'job-1', { at: 1 }), true);
    assert.equal(await s.createIfAbsent('locks', 'job-1', { at: 2 }), false);
    assert.deepEqual(await s.get('locks', 'job-1'), { at: 1 });
  });

  test(`${name}: delete of a missing record is not an error`, { skip }, async () => {
    const s = factory('bot-a');
    await s.delete('leads', 'missing');
  });

  test(`${name}: list returns every record of the collection`, { skip }, async () => {
    const s = factory('bot-a');
    await s.set('leads', 'c1', { agent: 'a' });
    await s.set('leads', 'c2', { agent: 'b' });
    const ids = (await s.list('leads')).map((r) => r.id).sort();
    assert.deepEqual(ids, ['c1', 'c2']);
  });

  test(`${name} T-05: two projects never see each other's records`, { skip }, async () => {
    const a = factory('project-a');
    const b = factory('project-b');
    await a.set('leads', 'c1', { secret: 'only-a' });
    assert.equal(await b.get('leads', 'c1'), null);
    assert.deepEqual(await b.list('leads'), []);
  });
}

storageContract('Firestore storage', (projectId) => createStorage({ projectId }), firestoreSkip);
storageContract('Memory fake', (projectId) => createMemoryStorage({ projectId }));

test('T-11: a transcript record survives a restart (new storage instance, same project)', { skip: firestoreSkip }, async () => {
  // Real test needs Firestore. Written here so Branch A cannot skip it.
  const first = createStorage({ projectId: 'test-a' });
  await first.set('messages', 'conv-1:1', { text: 'hello' });
  const second = createStorage({ projectId: 'test-a' });
  assert.deepEqual(await second.get('messages', 'conv-1:1'), { text: 'hello' });
});

// Added in Branch A. These use a stub Firestore client, so they always run.

function stubFirestore({ createError, setError } = {}) {
  const docs = new Map();
  return {
    collection(collection) {
      return {
        doc(id) {
          const key = `${collection}/${id}`;
          return {
            async get() {
              return { exists: docs.has(key), data: () => structuredClone(docs.get(key)) };
            },
            async set(data) {
              if (setError) throw setError;
              docs.set(key, structuredClone(data));
            },
            async create(data) {
              if (createError) throw createError;
              if (docs.has(key)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 });
              docs.set(key, structuredClone(data));
            },
            async delete() {
              docs.delete(key);
            },
          };
        },
        async get() {
          const prefix = `${collection}/`;
          return {
            docs: [...docs].filter(([k]) => k.startsWith(prefix))
              .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => structuredClone(v) })),
          };
        },
      };
    },
  };
}

storageContract('Firestore storage (stub client)', () => createStorage({ projectId: 'stub', firestore: stubFirestore() }));

test('createStorage requires a projectId', () => {
  assert.throws(() => createStorage({}), StorageError);
  assert.throws(() => createStorage({ projectId: '' }), StorageError);
});

test('createIfAbsent maps ALREADY_EXISTS to false and the record is unchanged', async () => {
  const s = createStorage({ projectId: 'stub', firestore: stubFirestore() });
  assert.equal(await s.createIfAbsent('locks', 'job-1', { at: 1 }), true);
  assert.equal(await s.createIfAbsent('locks', 'job-1', { at: 2 }), false);
  assert.deepEqual(await s.get('locks', 'job-1'), { at: 1 });
});

test('createIfAbsent rethrows any other backend error as StorageError', async () => {
  const backend = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
  const s = createStorage({ projectId: 'stub', firestore: stubFirestore({ createError: backend }) });
  await assert.rejects(
    s.createIfAbsent('locks', 'job-1', { at: 1 }),
    (err) => err instanceof StorageError && err.cause === backend
  );
});

test('a write error is never swallowed and does not leak field values', async () => {
  const backend = new Error('permission denied');
  const s = createStorage({ projectId: 'stub', firestore: stubFirestore({ setError: backend }) });
  await assert.rejects(
    s.set('leads', 'c1', { phone: '+972500000000' }),
    (err) => err instanceof StorageError && err.message.includes('leads/c1') && !err.message.includes('+972500000000')
  );
});

test('a "/" in a collection or record ID is rejected, not written to another path', async () => {
  const s = createStorage({ projectId: 'stub', firestore: stubFirestore() });
  await assert.rejects(s.set('leads', 'a/b', { x: 1 }), StorageError);
  await assert.rejects(s.get('leads/x', 'c1'), StorageError);
  await assert.rejects(s.list(''), StorageError);
});

test('record data must be a plain object', async () => {
  const s = createStorage({ projectId: 'stub', firestore: stubFirestore() });
  await assert.rejects(s.set('leads', 'c1', null), StorageError);
  await assert.rejects(s.createIfAbsent('leads', 'c1', ['x']), StorageError);
});

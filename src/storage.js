'use strict';

// B3 Storage, backed by Firestore.
//
// Rules:
// - Modules never call the database directly; they go through this interface.
// - Records are addressed by collection name and record ID.
// - Two storages with different projectId never see each other's records (T-05).
// - createIfAbsent is atomic. Duplicate checks (B2) and job locks (B9) depend on it.
//
// - Each projectId is its own Firestore project, so isolation (T-05) is enforced
//   by Firestore itself, not by key prefixes.
// - Error messages name the operation and path, never field values.
//
// Backend selection is done by the Firestore client library:
// - FIRESTORE_EMULATOR_HOST set: the local emulator (tests, no credentials).
// - Otherwise: Google application default credentials (GOOGLE_APPLICATION_CREDENTIALS
//   or the runtime service account).
//
// Fake for tests: src/fakes/memory-storage.js (in-memory, same contract).

const { StorageError } = require('./errors');

// gRPC status code returned by Firestore create() when the document exists.
const ALREADY_EXISTS = 6;

/**
 * @typedef {Record<string, unknown>} RecordData  Plain JSON-compatible fields. No "id" field.
 *
 * @typedef {Object} Storage
 * @property {(collection: string, id: string) => Promise<RecordData | null>} get
 *   Returns null when the record does not exist.
 * @property {(collection: string, id: string, data: RecordData) => Promise<void>} set
 *   Replaces the whole record.
 * @property {(collection: string, id: string, data: RecordData) => Promise<boolean>} createIfAbsent
 *   Creates the record only if it does not exist. true = created, false = already exists.
 * @property {(collection: string, id: string) => Promise<void>} delete
 *   Deleting a missing record is not an error.
 * @property {(collection: string) => Promise<Array<{id: string, data: RecordData}>>} list
 *   All records of a collection. Used by reminders, which must see every agent (F-15).
 */

/**
 * @param {{projectId: string, firestore?: object}} options
 *   `firestore` is an optional ready client (tests only). By default a client is
 *   created for `projectId`.
 * @returns {Storage}
 * Errors: StorageError on backend failure. Never swallow a write error.
 */
function createStorage(options) {
  if (!options || typeof options.projectId !== 'string' || options.projectId === '') {
    throw new StorageError('projectId is required');
  }
  const db = options.firestore || newFirestore(options.projectId);

  const doc = (collection, id) => {
    checkName('collection', collection);
    checkName('record id', id);
    return db.collection(collection).doc(id);
  };

  return {
    async get(collection, id) {
      const ref = doc(collection, id);
      const snap = await call('get', `${collection}/${id}`, () => ref.get());
      return snap.exists ? snap.data() : null;
    },
    async set(collection, id, data) {
      const ref = doc(collection, id);
      checkData(data);
      await call('set', `${collection}/${id}`, () => ref.set(data));
    },
    async createIfAbsent(collection, id, data) {
      const ref = doc(collection, id);
      checkData(data);
      try {
        // create() is atomic on the server: it fails if the document exists.
        await ref.create(data);
        return true;
      } catch (err) {
        if (err && err.code === ALREADY_EXISTS) return false;
        throw wrap('createIfAbsent', `${collection}/${id}`, err);
      }
    },
    async delete(collection, id) {
      const ref = doc(collection, id);
      await call('delete', `${collection}/${id}`, () => ref.delete());
    },
    async list(collection) {
      checkName('collection', collection);
      const snap = await call('list', collection, () => db.collection(collection).get());
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
  };
}

function newFirestore(projectId) {
  // Loaded lazily so modules that only use the fake do not load the client.
  const { Firestore } = require('@google-cloud/firestore');
  return new Firestore({ projectId });
}

async function call(operation, path, fn) {
  try {
    return await fn();
  } catch (err) {
    throw wrap(operation, path, err);
  }
}

function wrap(operation, path, err) {
  const reason = err && err.message ? err.message : String(err);
  const wrapped = new StorageError(`Storage ${operation} failed for ${path}: ${reason}`);
  wrapped.cause = err;
  return wrapped;
}

// Firestore paths use "/" as a separator, so a "/" in a name would address a
// different document. Reject it instead of writing to the wrong place.
function checkName(kind, value) {
  if (typeof value !== 'string' || value === '' || value.includes('/')) {
    throw new StorageError(`Invalid ${kind}: must be a non-empty string without "/"`);
  }
}

function checkData(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new StorageError('Record data must be a plain object');
  }
}

module.exports = { createStorage };

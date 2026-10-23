'use strict';

// B3 Storage. Contract only (step 0). Firestore implementation comes in Branch A.
//
// Rules:
// - Modules never call the database directly; they go through this interface.
// - Records are addressed by collection name and record ID.
// - Two storages with different projectId never see each other's records (T-05).
// - createIfAbsent is atomic. Duplicate checks (B2) and job locks (B9) depend on it.
//
// Fake for tests: src/fakes/memory-storage.js (in-memory, same contract).

const { NotImplementedError } = require('./errors');

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
 * @param {{projectId: string}} options
 * @returns {Storage}
 * Errors: StorageError on backend failure. Never swallow a write error.
 */
function createStorage(options) {
  void options;
  throw new NotImplementedError('createStorage');
}

module.exports = { createStorage };

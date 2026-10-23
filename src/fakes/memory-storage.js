'use strict';

// Fake for B3 Storage (step 0). In-memory, same contract as src/storage.js.
// Each call to createMemoryStorage returns an isolated store, so two bots
// with two projectIds never share records (T-05).
// This is a fake for tests and for other branches. It is not production code.

const { StorageError } = require('../errors');

/**
 * @param {{projectId: string}} options
 * @returns {import('../storage').Storage}
 */
function createMemoryStorage(options) {
  if (!options || typeof options.projectId !== 'string' || options.projectId === '') {
    throw new StorageError('projectId is required');
  }
  /** @type {Map<string, Map<string, object>>} */
  const collections = new Map();

  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };

  return {
    async get(name, id) {
      const value = collection(name).get(id);
      return value === undefined ? null : structuredClone(value);
    },
    async set(name, id, data) {
      collection(name).set(id, structuredClone(data));
    },
    async createIfAbsent(name, id, data) {
      const col = collection(name);
      if (col.has(id)) return false;
      col.set(id, structuredClone(data));
      return true;
    },
    async delete(name, id) {
      collection(name).delete(id);
    },
    async list(name) {
      return [...collection(name)].map(([id, data]) => ({ id, data: structuredClone(data) }));
    },
  };
}

module.exports = { createMemoryStorage };

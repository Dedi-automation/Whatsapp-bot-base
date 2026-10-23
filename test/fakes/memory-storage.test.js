'use strict';

// The in-memory fake must satisfy the same B3 contract as the real storage.
// Contract cases are in test/storage.test.js; this file only checks the fake
// rejects a missing projectId, so the isolation rule (T-05) cannot be bypassed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStorage } = require('../../src/fakes/memory-storage');
const { StorageError } = require('../../src/errors');

test('the fake requires a projectId', () => {
  assert.throws(() => createMemoryStorage({}), StorageError);
});

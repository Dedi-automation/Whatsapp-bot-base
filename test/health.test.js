'use strict';

// B12 Health check. Covers the check contract and F-17 (numbers from config).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkHealth } = require('../src/health');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { createFakeAiClient } = require('../src/fakes/ai-fake');

const config = { healthCheck: { phone: '972500000000' } };

test('all dependencies healthy: ok is true', async () => {
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp: createFakeWhatsAppClient(),
    ai: createFakeAiClient(),
    config,
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.storage.ok, true);
});

test('a failing storage is reported in checks and does not throw', async () => {
  const broken = {
    get: async () => { throw new Error('down'); },
    set: async () => { throw new Error('down'); },
    createIfAbsent: async () => { throw new Error('down'); },
    delete: async () => { throw new Error('down'); },
    list: async () => { throw new Error('down'); },
  };
  const report = await checkHealth({
    storage: broken,
    whatsapp: createFakeWhatsAppClient(),
    ai: createFakeAiClient(),
    config,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.storage.ok, false);
});

test('F-17: the test phone number comes from config, not from code', async () => {
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp: createFakeWhatsAppClient(),
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: undefined } },
  });
  assert.equal(report.checks.whatsapp.ok, false);
});

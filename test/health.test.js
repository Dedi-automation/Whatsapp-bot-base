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

// Added in Branch E.

test('the storage probe record is removed after the check', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  await checkHealth({ storage, whatsapp: createFakeWhatsAppClient(), ai: createFakeAiClient(), config });
  assert.deepEqual(await storage.list('health_checks'), []);
});

test('F-17: the health message goes to the phone from config', async () => {
  const whatsapp = createFakeWhatsAppClient();
  await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972511111111' } },
  });
  assert.equal(whatsapp.sent.length, 1);
  assert.equal(whatsapp.sent[0].to, '972511111111');
});

test('a WhatsApp API error is reported in checks and does not throw', async () => {
  const { WhatsAppError } = require('../src/errors');
  const whatsapp = createFakeWhatsAppClient();
  whatsapp.failNextWith(new WhatsAppError('blocked', { status: 400, code: 133010 }));
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp,
    ai: createFakeAiClient(),
    config,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.whatsapp.ok, false);
  assert.match(report.checks.whatsapp.detail, /blocked/);
  assert.equal(report.checks.storage.ok, true);
});

test('a missing AI client is reported in checks', async () => {
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp: createFakeWhatsAppClient(),
    ai: undefined,
    config,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.ai.ok, false);
});

test('the AI check makes no model call', async () => {
  const ai = createFakeAiClient();
  await checkHealth({ storage: createMemoryStorage({ projectId: 'test-a' }), whatsapp: createFakeWhatsAppClient(), ai, config });
  assert.equal(ai.calls.length, 0);
});

test('a hanging dependency is reported as timed out, the other checks still run', async () => {
  const hanging = {
    get: () => new Promise(() => {}),
    set: () => new Promise(() => {}),
    createIfAbsent: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
    list: () => new Promise(() => {}),
  };
  const report = await checkHealth({
    storage: hanging,
    whatsapp: createFakeWhatsAppClient(),
    ai: createFakeAiClient(),
    config,
    timeoutMs: 20,
  });
  assert.equal(report.checks.storage.ok, false);
  assert.match(report.checks.storage.detail, /timed out/);
  assert.equal(report.checks.whatsapp.ok, true);
});

test('missing dependencies are reported, never thrown', async () => {
  const report = await checkHealth({});
  assert.equal(report.ok, false);
  assert.equal(report.checks.storage.ok, false);
  assert.equal(report.checks.whatsapp.ok, false);
  assert.equal(report.checks.ai.ok, false);
});

// Every run sends a real result message; a failure also sends a copy to the alert
// phone (Dedi, 2026-10-26).

const brokenStorage = () => ({
  get: async () => { throw new Error('down'); },
  set: async () => { throw new Error('down'); },
  createIfAbsent: async () => { throw new Error('down'); },
  delete: async () => { throw new Error('down'); },
  list: async () => { throw new Error('down'); },
});

test('a healthy run sends one OK message to the health-check phone and no alert', async () => {
  const whatsapp = createFakeWhatsAppClient();
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972511111111', alertPhone: '972522222222' } },
    now: () => new Date('2026-10-25T10:00:00Z'),
  });
  assert.equal(report.alert, null);
  assert.deepEqual(whatsapp.sent.map((m) => [m.to, m.text]), [['972511111111', 'Health check OK 2026-10-25T10:00:00.000Z']]);
});

test('a failed check is in the result message and a copy goes to the alert phone', async () => {
  const whatsapp = createFakeWhatsAppClient();
  const report = await checkHealth({
    storage: brokenStorage(),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972511111111', alertPhone: '972522222222' } },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(whatsapp.sent.map((m) => m.to), ['972511111111', '972522222222']);
  for (const m of whatsapp.sent) assert.match(m.text, /FAILED.*storage: down/);
  assert.equal(report.alert.sent, true);
  assert.equal(report.alert.to, '972522222222');
});

test('when the result message itself fails, the alert phone still gets the problem', async () => {
  const { WhatsAppError } = require('../src/errors');
  const whatsapp = createFakeWhatsAppClient();
  whatsapp.failNextWith(new WhatsAppError('blocked', { status: 400, code: 133010 }));
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972511111111', alertPhone: '972522222222' } },
  });
  assert.equal(report.checks.whatsapp.ok, false);
  assert.equal(report.alert.sent, true);
  assert.equal(whatsapp.sent.length, 1);
  assert.equal(whatsapp.sent[0].to, '972522222222');
  assert.match(whatsapp.sent[0].text, /whatsapp: blocked/);
});

test('a missing health-check phone still alerts the alert phone', async () => {
  const whatsapp = createFakeWhatsAppClient();
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: undefined, alertPhone: '972522222222' } },
  });
  assert.equal(report.alert.sent, true);
  assert.match(whatsapp.sent[0].text, /HEALTH_CHECK_PHONE is not set/);
});

test('when the alert phone is the health-check phone, the problem is sent once', async () => {
  const whatsapp = createFakeWhatsAppClient();
  const report = await checkHealth({
    storage: brokenStorage(),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972511111111', alertPhone: '972511111111' } },
  });
  assert.equal(whatsapp.sent.length, 1);
  assert.equal(report.alert.sent, false);
  assert.match(report.alert.detail, /already sent/);
});

test('a failure with no alert phone configured is reported in the alert field', async () => {
  const report = await checkHealth({
    storage: brokenStorage(),
    whatsapp: createFakeWhatsAppClient(),
    ai: createFakeAiClient(),
    config,
  });
  assert.equal(report.alert.sent, false);
  assert.match(report.alert.detail, /HEALTH_CHECK_ALERT_PHONE/);
});

test('a failing alert send is reported, never thrown', async () => {
  const whatsapp = {
    sendText: async () => { throw new Error('network down'); },
    sendTemplate: async () => { throw new Error('network down'); },
    parseIncoming: () => [],
  };
  const report = await checkHealth({
    storage: createMemoryStorage({ projectId: 'test-a' }),
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972511111111', alertPhone: '972522222222' } },
  });
  assert.equal(report.checks.whatsapp.ok, false);
  assert.equal(report.alert.sent, false);
  assert.match(report.alert.detail, /network down/);
});

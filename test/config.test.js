'use strict';

// B1 Config. Covers T-01 and T-13.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, REQUIRED_ENV } = require('../src/config');
const { ConfigError } = require('../src/errors');

const fullEnv = () =>
  Object.fromEntries(REQUIRED_ENV.map((name) => [name, `value-of-${name}`]));

test('T-01/T-13: startup fails and lists every missing required variable', () => {
  const env = fullEnv();
  delete env.WHATSAPP_TOKEN;
  delete env.ADMIN_TOKEN;
  assert.throws(
    () => loadConfig(env),
    (err) => err instanceof ConfigError && err.missing.includes('WHATSAPP_TOKEN') && err.missing.includes('ADMIN_TOKEN') && err.missing.length === 2
  );
});

test('T-01: the error message names variables but never prints a value', () => {
  const env = fullEnv();
  env.WHATSAPP_TOKEN = '';
  assert.throws(
    () => loadConfig(env),
    (err) => err.message.includes('WHATSAPP_TOKEN') && !err.message.includes('value-of-')
  );
});

test('loads a complete environment into the camelCase Config shape', () => {
  const config = loadConfig(fullEnv());
  assert.equal(config.whatsappToken, 'value-of-WHATSAPP_TOKEN');
  assert.equal(config.aiModel, 'value-of-AI_MODEL');
  assert.equal(config.firestoreProjectId, 'value-of-FIRESTORE_PROJECT_ID');
});

test('T-01: a whitespace-only value counts as missing', () => {
  const env = fullEnv();
  env.AI_MODEL = '   ';
  assert.throws(() => loadConfig(env), (err) => err instanceof ConfigError && err.missing.join() === 'AI_MODEL');
});

test('PORT is optional with default 8080; an invalid PORT fails at startup', () => {
  assert.equal(loadConfig(fullEnv()).port, 8080);
  assert.equal(loadConfig({ ...fullEnv(), PORT: '3000' }).port, 3000);
  assert.throws(() => loadConfig({ ...fullEnv(), PORT: 'abc' }), (err) => err instanceof ConfigError && err.missing.join() === 'PORT');
});

test('HEALTH_CHECK_PHONE is optional (F-17)', () => {
  assert.equal(loadConfig(fullEnv()).healthCheck.phone, undefined);
  assert.equal(loadConfig({ ...fullEnv(), HEALTH_CHECK_PHONE: '972500000000' }).healthCheck.phone, '972500000000');
});

test('HEALTH_CHECK_ALERT_PHONE is optional and loads as healthCheck.alertPhone', () => {
  assert.equal(loadConfig(fullEnv()).healthCheck.alertPhone, undefined);
  const config = loadConfig({ ...fullEnv(), HEALTH_CHECK_PHONE: '972500000001', HEALTH_CHECK_ALERT_PHONE: '972500000002' });
  assert.deepEqual({ ...config.healthCheck }, { phone: '972500000001', alertPhone: '972500000002' });
});

const { EMAIL_ENV } = require('../src/config');

test('B10: email is off (null) when no email variable is set', () => {
  assert.equal(loadConfig(fullEnv()).email, null);
});

test('B10: all three email variables give an email config', () => {
  const env = { ...fullEnv(), SENDGRID_API_KEY: 'k', SENDGRID_FROM_EMAIL: 'bot@example.com', NOTIFY_EMAIL: 'agent@example.com' };
  assert.deepEqual({ ...loadConfig(env).email }, { apiKey: 'k', from: 'bot@example.com', notifyTo: 'agent@example.com' });
});

test('B10: some but not all email variables is a startup error naming the missing ones', () => {
  const env = { ...fullEnv(), SENDGRID_API_KEY: 'secret-key' };
  assert.throws(
    () => loadConfig(env),
    (err) => err instanceof ConfigError && err.missing.join() === 'SENDGRID_FROM_EMAIL,NOTIFY_EMAIL' && !err.message.includes('secret-key')
  );
  assert.equal(EMAIL_ENV.length, 3);
});

test('agent WhatsApp: off without AGENT_WHATSAPP_PHONE', () => {
  assert.equal(loadConfig(fullEnv()).agentWhatsApp, null);
});

test('agent WhatsApp: phone alone means all events, no template', () => {
  const c = loadConfig({ ...fullEnv(), AGENT_WHATSAPP_PHONE: '972500000077' }).agentWhatsApp;
  assert.deepEqual([...c.events], ['handoff', 'daily_summary', 'monthly_summary', 'recommendation']);
  assert.equal(c.template, null);
});

test('agent WhatsApp: listed events and a template (default language he)', () => {
  const c = loadConfig({ ...fullEnv(), AGENT_WHATSAPP_PHONE: '972500000077', AGENT_WHATSAPP_EVENTS: 'handoff, daily_summary', AGENT_WHATSAPP_TEMPLATE: 'agent_alert' }).agentWhatsApp;
  assert.deepEqual([...c.events], ['handoff', 'daily_summary']);
  assert.deepEqual({ ...c.template }, { name: 'agent_alert', language: 'he' });
});

test('agent WhatsApp: unknown event or events without a phone is a startup error', () => {
  assert.throws(() => loadConfig({ ...fullEnv(), AGENT_WHATSAPP_PHONE: '1', AGENT_WHATSAPP_EVENTS: 'handoff,party' }), /unknown events: party/);
  assert.throws(() => loadConfig({ ...fullEnv(), AGENT_WHATSAPP_EVENTS: 'handoff' }), (err) => err instanceof ConfigError && err.missing.includes('AGENT_WHATSAPP_PHONE'));
});

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

'use strict';

// B2 Security. Covers T-02, T-03 (duplicate rejection), T-16.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWhatsAppSignature, checkBearerToken, createDeduplicator } = require('../src/security');
const { createMemoryStorage } = require('../src/fakes/memory-storage');

const APP_SECRET = 'test-app-secret';
const body = Buffer.from('{"entry":[]}');
const goodSig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');

test('T-02: a valid X-Hub-Signature-256 is accepted', () => {
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: goodSig, appSecret: APP_SECRET }), true);
});

test('T-02: a signature made with another secret is rejected, not processed', () => {
  const badSig = 'sha256=' + crypto.createHmac('sha256', 'other').update(body).digest('hex');
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: badSig, appSecret: APP_SECRET }), false);
});

test('T-02: a missing header or missing prefix is rejected without throwing', () => {
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: undefined, appSecret: APP_SECRET }), false);
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: goodSig.slice(7), appSecret: APP_SECRET }), false);
});

test('T-16: admin token in the Authorization header is accepted', () => {
  const ok = checkBearerToken({
    url: '/admin/agents',
    headers: { authorization: 'Bearer s3cret' },
    expected: 's3cret',
  });
  assert.equal(ok, true);
});

test('T-16: the same token in the URL query string is rejected, even with a valid header', () => {
  const ok = checkBearerToken({
    url: '/admin/agents?token=s3cret',
    headers: { authorization: 'Bearer s3cret' },
    expected: 's3cret',
  });
  assert.equal(ok, false);
});

test('T-16: a wrong or missing header token is rejected', () => {
  assert.equal(checkBearerToken({ url: '/jobs/send-reminders', headers: {}, expected: 's3cret' }), false);
  assert.equal(
    checkBearerToken({ url: '/jobs/send-reminders', headers: { authorization: 'Bearer nope' }, expected: 's3cret' }),
    false
  );
});

test('T-03: concurrent markSeen calls for one message ID return true exactly once', async () => {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const dedup = createDeduplicator({ storage });
  const results = await Promise.all([dedup.markSeen('wamid.1'), dedup.markSeen('wamid.1'), dedup.markSeen('wamid.1')]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('T-16: a token in the URL path is rejected (F-04)', () => {
  assert.equal(
    checkBearerToken({ url: '/admin/s3cret/agents', headers: { authorization: 'Bearer s3cret' }, expected: 's3cret' }),
    false
  );
});

test('T-16: header name and Bearer scheme are case-insensitive; an empty expected token never matches', () => {
  assert.equal(checkBearerToken({ url: '/jobs/x', headers: { Authorization: 'bearer s3cret' }, expected: 's3cret' }), true);
  assert.equal(checkBearerToken({ url: '/jobs/x', headers: { authorization: 'Bearer ' }, expected: '' }), false);
});

test('T-02: a malformed digest is rejected without throwing', () => {
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: 'sha256=zz', appSecret: APP_SECRET }), false);
});

test('T-03: a different message ID is not a duplicate', async () => {
  const dedup = createDeduplicator({ storage: createMemoryStorage({ projectId: 'test-a' }) });
  assert.equal(await dedup.markSeen('wamid.a'), true);
  assert.equal(await dedup.markSeen('wamid.b'), true);
  assert.equal(await dedup.markSeen('wamid.a'), false);
});

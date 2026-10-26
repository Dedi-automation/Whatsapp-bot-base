'use strict';

// B10 email. Covers F-22 (every field escaped), F-04/F-05 (no token in links),
// clear config errors, and SendGrid errors reported, never swallowed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmailClient,
  notifyEmail,
  recommendationEmail,
  recommendationLink,
  validationErrorEmail,
} = require('../src/email');
const { EmailError } = require('../src/errors');
const { createFakeEmailClient } = require('../src/fakes/email-fake');

const ATTACK = `<img src=x onerror="alert('x')">`;

function recordingFetch(status = 202) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status, ok: status >= 200 && status < 300 };
  };
  fn.calls = calls;
  return fn;
}

function validRecommendation(overrides = {}) {
  return {
    to: 'owner@example.com',
    botName: 'Bot',
    recommendationId: 'trial-1:1',
    suggestion: 'Ask for the travel dates first',
    reasoning: 'Customers asked twice',
    excerpt: 'customer: when?',
    dashboardUrl: 'https://bot.example.com',
    ...overrides,
  };
}

test('options: missing API key or bad from address is a clear error', () => {
  assert.throws(() => createEmailClient({ from: 'a@b.co', fetch: recordingFetch() }), /SENDGRID_API_KEY/);
  assert.throws(() => createEmailClient({ apiKey: 'k', from: 'not-an-address', fetch: recordingFetch() }), /SENDGRID_FROM_EMAIL/);
});

test('send: posts one message to SendGrid with the key in the Authorization header', async () => {
  const fetch = recordingFetch();
  const client = createEmailClient({ apiKey: 'SG.key', from: 'bot@example.com', fetch });
  const result = await client.send(notifyEmail({ to: 'agent@example.com', subject: 'Handoff', text: 'Lead 7 wants a call' }));
  assert.deepEqual(result, { accepted: true });
  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(init.headers.Authorization, 'Bearer SG.key');
  assert.ok(!url.includes('SG.key'), 'key never in the URL');
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'agent@example.com' }] }]);
  assert.deepEqual(body.from, { email: 'bot@example.com' });
  assert.equal(body.subject, 'Handoff');
  assert.deepEqual(body.content.map((c) => c.type), ['text/plain', 'text/html']);
});

test('send: a SendGrid error status is reported as EmailError with the status', async () => {
  const client = createEmailClient({ apiKey: 'k', from: 'bot@example.com', fetch: recordingFetch(401) });
  await assert.rejects(
    client.send(notifyEmail({ to: 'a@example.com', subject: 's', text: 't' })),
    (err) => err instanceof EmailError && err.status === 401
  );
});

test('send: a network failure is reported, not swallowed', async () => {
  const client = createEmailClient({
    apiKey: 'k',
    from: 'bot@example.com',
    fetch: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(client.send(notifyEmail({ to: 'a@example.com', subject: 's', text: 't' })), /ECONNRESET/);
});

test('send: a subject with a line break is rejected (header injection)', async () => {
  const fetch = recordingFetch();
  const client = createEmailClient({ apiKey: 'k', from: 'bot@example.com', fetch });
  await assert.rejects(
    client.send({ to: 'a@example.com', subject: 'Hi\r\nBcc: x@evil.com', text: 't', html: 't' }),
    /line breaks/
  );
  await assert.rejects(client.send({ to: 'a@example.com\nBcc: x@evil.com', subject: 's', text: 't', html: 't' }), EmailError);
  assert.equal(fetch.calls.length, 0, 'nothing sent');
});

test('F-22: notifyEmail escapes the text in the HTML body', () => {
  const message = notifyEmail({ to: 'a@example.com', subject: `Lead ${ATTACK}`, text: `Name: ${ATTACK}` });
  assert.ok(!message.html.includes('<img'), message.html);
  assert.ok(message.html.includes('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;'));
  assert.equal(message.text, `Name: ${ATTACK}`, 'plain-text body keeps the raw text');
});

test('notifyEmail: line breaks in a subject built from data become spaces', () => {
  assert.equal(notifyEmail({ to: 'a@example.com', subject: 'Lead\r\nBcc: x', text: 't' }).subject, 'Lead Bcc: x');
});

test('F-22: recommendationEmail escapes every field', () => {
  const message = recommendationEmail(
    validRecommendation({ botName: ATTACK, suggestion: ATTACK, reasoning: ATTACK, excerpt: ATTACK })
  );
  assert.ok(!message.html.includes('<img'), message.html);
  assert.equal(message.html.split('&lt;img').length - 1, 4, 'four escaped copies');
  assert.ok(!/[\r\n]/.test(message.subject));
});

test('F-04/F-05: the recommendation link has no token and no query string', () => {
  const message = recommendationEmail(validRecommendation({ dashboardUrl: 'https://bot.example.com/?token=abc' }));
  const link = recommendationLink('https://bot.example.com/?token=abc', 'trial-1:1');
  assert.equal(link, 'https://bot.example.com/admin/recommendations/trial-1%3A1');
  assert.ok(!message.html.includes('token'));
  assert.ok(!message.text.includes('token'));
});

test('recommendation link: http or an invalid base URL is an error', () => {
  assert.throws(() => recommendationLink('http://bot.example.com', 'r1'), /https/);
  assert.throws(() => recommendationLink('not a url', 'r1'), /valid URL/);
  assert.throws(() => recommendationLink('https://bot.example.com', ''), /recommendationId/);
});

test('recommendationEmail: the excerpt is optional', () => {
  const message = recommendationEmail(validRecommendation({ excerpt: undefined }));
  assert.ok(!message.html.includes('<pre'));
  assert.ok(!message.text.includes('undefined'));
});

test('F-22: validationErrorEmail escapes the text', () => {
  const message = validationErrorEmail({ to: 'a@example.com', subject: 'Form error', text: ATTACK });
  assert.ok(!message.html.includes('<img'));
});

test('fake: records emails, sends nothing, and can fail on demand', async () => {
  const fake = createFakeEmailClient();
  await fake.send(notifyEmail({ to: 'a@example.com', subject: 's', text: 't' }));
  assert.equal(fake.sent.length, 1);
  fake.failNextWith(new EmailError('down'));
  await assert.rejects(fake.send(notifyEmail({ to: 'a@example.com', subject: 's', text: 't' })), /down/);
  assert.equal(fake.sent.length, 1);
});

'use strict';

// Notifications to the agent and owner (Dedi, 2026-10-26): email by default,
// WhatsApp to the agent for the events the bot lists, template outside 24 hours.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, templateParam } = require('../src/notify');
const { createFakeEmailClient } = require('../src/fakes/email-fake');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { EmailError, WhatsAppError } = require('../src/errors');

const quiet = { info() {}, error() {} };
const msg = { subject: 'Handoff', text: 'Lead 1 wants an agent\nreason: price' };

test('email only: every event goes to the configured address', async () => {
  const email = createFakeEmailClient();
  const n = createNotifier({ email, emailTo: 'agent@example.com', log: quiet });
  for (const event of ['handoff', 'daily_summary', 'recommendation']) {
    const r = await n.send(event, msg);
    assert.deepEqual(r.channels, [{ channel: 'email', ok: true }]);
  }
  assert.equal(email.sent.length, 3);
  assert.equal(email.sent[0].to, 'agent@example.com');
});

test('WhatsApp to the agent only for the listed events; email still goes for all', async () => {
  const email = createFakeEmailClient();
  const whatsapp = createFakeWhatsAppClient();
  const n = createNotifier({ email, emailTo: 'a@example.com', whatsapp, agentPhone: '972500000077', whatsappEvents: ['handoff', 'daily_summary'], log: quiet });
  assert.deepEqual(n.channelsFor('handoff'), ['email', 'whatsapp']);
  assert.deepEqual(n.channelsFor('recommendation'), ['email']);
  await n.send('handoff', msg);
  await n.send('recommendation', msg);
  assert.equal(whatsapp.sent.length, 1);
  assert.equal(whatsapp.sent[0].to, '972500000077');
  assert.equal(whatsapp.sent[0].text, msg.text);
  assert.equal(email.sent.length, 2);
});

test('WhatsApp only (no email set up) works', async () => {
  const whatsapp = createFakeWhatsAppClient();
  const n = createNotifier({ whatsapp, agentPhone: '972500000077', whatsappEvents: ['handoff'], log: quiet });
  const r = await n.send('handoff', msg);
  assert.deepEqual(r.channels, [{ channel: 'whatsapp', ok: true }]);
});

test('with a template, WhatsApp sends the approved template with the text on one line', async () => {
  const whatsapp = createFakeWhatsAppClient();
  const n = createNotifier({ whatsapp, agentPhone: '972500000077', whatsappEvents: ['handoff'], whatsappTemplate: { name: 'agent_alert', language: 'he' }, log: quiet });
  await n.send('handoff', msg);
  assert.equal(whatsapp.sent[0].type, 'template');
  assert.equal(whatsapp.sent[0].templateName, 'agent_alert');
  assert.deepEqual(whatsapp.sent[0].params, ['Lead 1 wants an agent | reason: price']);
});

test('templateParam: no new lines, tabs or long runs of spaces; capped length', () => {
  assert.equal(templateParam('a\n\nb\tc     d'), 'a | b | c   d');
  assert.equal(templateParam('x'.repeat(2000)).length, 1000);
});

test('a failing channel is reported and logged; the other channel still sends; nothing is thrown', async () => {
  const email = createFakeEmailClient();
  const whatsapp = createFakeWhatsAppClient();
  const errors = [];
  const n = createNotifier({ email, emailTo: 'a@example.com', whatsapp, agentPhone: '972500000077', whatsappEvents: ['handoff'], log: { info() {}, error: (m) => errors.push(m) } });
  email.failNextWith(new EmailError('down'));
  const r1 = await n.send('handoff', msg);
  assert.deepEqual(r1.channels.map((c) => [c.channel, c.ok]), [['email', false], ['whatsapp', true]]);
  whatsapp.failNextWith(new WhatsAppError('blocked', { code: 131047 }));
  const r2 = await n.send('handoff', msg);
  assert.deepEqual(r2.channels.map((c) => [c.channel, c.ok]), [['email', true], ['whatsapp', false]]);
  assert.equal(errors.length, 2);
  assert.ok(!errors.join().includes('972500000077'), 'no phone number in logs');
});

test('no channel set up: nothing sent, empty result', async () => {
  const r = await createNotifier({ log: quiet }).send('handoff', msg);
  assert.deepEqual(r.channels, []);
});

test('startup errors: unknown event, WhatsApp events without a phone, email without address', () => {
  const whatsapp = createFakeWhatsAppClient();
  assert.throws(() => createNotifier({ whatsapp, agentPhone: '1', whatsappEvents: ['nope'] }), /Unknown notification events: nope/);
  assert.throws(() => createNotifier({ whatsapp, whatsappEvents: ['handoff'] }), /AGENT_WHATSAPP_PHONE/);
  assert.throws(() => createNotifier({ email: createFakeEmailClient() }), /email and emailTo/);
});

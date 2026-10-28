'use strict';

// Outbound messages (base 1.1.0, decisions.md items 46 to 51). Covers T-18 to T-24:
// phones and lists, the daily limit and its weekly ramp, the send window, opt-out,
// automatic pause, one send per recipient, and recipient status from Meta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOutbound, normalizePhone, parseRecipientList, decodeText } = require('../src/outbound');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { isWithinSendWindow } = require('../src/schedule-window');
const { WhatsAppError, OutboundError } = require('../src/errors');

// Monday 26 Oct 2026, 12:00 Israel time.
const MONDAY_NOON = new Date('2026-10-26T10:00:00Z');
const quiet = { info() {}, error() {} };

function setup(overrides = {}) {
  const storage = createMemoryStorage({ projectId: 'test-outbound' });
  const whatsapp = createFakeWhatsAppClient();
  const alerts = [];
  const clock = { now: MONDAY_NOON };
  const outbound = createOutbound({
    storage,
    whatsapp,
    isWithinSendWindow: (when) => isWithinSendWindow(when),
    now: () => clock.now,
    optOutReplyText: 'הוסרת מהרשימה.',
    signup: { template: { name: 'signup_link', language: 'he', params: ['{name}'], urlButtonParam: '{link}' }, link: 'https://example.com/join' },
    templates: {
      travel: { name: 'travel_offer', language: 'he', params: ['{name}'], label: 'הצעת ביטוח נסיעות' },
      plain: { name: 'plain_offer', language: 'he' },
    },
    fallbacks: { name: 'לקוח יקר' },
    notifier: { send: async (event, message) => alerts.push({ event, ...message }) },
    log: quiet,
    ...overrides,
  });
  return { storage, whatsapp, outbound, alerts, clock };
}

function phones(n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ phone: `05${String(from + i).padStart(8, '0')}`, name: `לקוח ${from + i}` }));
}

async function runningCampaign(o, rows, templateKey = 'travel') {
  const id = await o.createCampaign({ name: 'קמפיין', templateKey });
  await o.addRecipients(id, rows);
  await o.setStatus(id, 'start');
  return id;
}

// ---- T-18 phones and lists ----

test('T-18 normalizePhone: Israeli formats become 9725XXXXXXXX; landlines and junk are refused', () => {
  assert.equal(normalizePhone('050-1234567'), '972501234567');
  assert.equal(normalizePhone('0501234567'), '972501234567');
  assert.equal(normalizePhone('501234567'), '972501234567');
  assert.equal(normalizePhone('+972 50 123 4567'), '972501234567');
  assert.equal(normalizePhone('972-050-1234567'), '972501234567');
  assert.equal(normalizePhone('00972501234567'), '972501234567');
  assert.equal(normalizePhone('972501234567'), '972501234567');
  assert.equal(normalizePhone('+1 202 555 0123'), '12025550123');
  assert.equal(normalizePhone('03-6123456'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(undefined), null);
});

test('T-18 parseRecipientList: header skipped, phone in any column, invalid lines reported', () => {
  const text = '﻿שם,טלפון\r\nדנה כהן,050-1234567\n"0527654321";"יוסי"\n\nלא מספר,123\n0541112222\n';
  const { rows, invalid } = parseRecipientList(text);
  assert.deepEqual(rows, [
    { phone: '972501234567', name: 'דנה כהן' },
    { phone: '972527654321', name: 'יוסי' },
    { phone: '972541112222', name: '' },
  ]);
  assert.deepEqual(invalid, [{ line: 5, text: 'לא מספר,123' }]);
});

test('T-18 decodeText: UTF-8 as is, a Hebrew Excel CSV (Windows-1255) is read correctly', () => {
  assert.equal(decodeText(Buffer.from('דנה,0501234567', 'utf8')), 'דנה,0501234567');
  // "דנה" in Windows-1255 is E3 F0 E4.
  assert.equal(decodeText(Buffer.from([0xe3, 0xf0, 0xe4, 0x2c, 0x30, 0x35])), 'דנה,05');
});

test('T-18 addRecipients: one phone once per campaign, also across uploads; invalid phones counted', async () => {
  const { outbound: o } = setup();
  const id = await o.createCampaign({ name: 'א', templateKey: 'travel' });
  const first = await o.addRecipients(id, [{ phone: '0501234567', name: 'דנה' }, { phone: '050-1234567' }, { phone: 'xx' }, { phone: '0527654321' }]);
  assert.deepEqual(first, { added: 2, duplicates: 1, invalid: 1 });
  const second = await o.addRecipients(id, [{ phone: '+972501234567' }, { phone: '0531112222' }]);
  assert.deepEqual(second, { added: 1, duplicates: 1, invalid: 0 });
  const list = await o.listRecipients(id);
  assert.deepEqual(list.map((r) => [r.data.index, r.data.phone]), [[0, '972501234567'], [1, '972527654321'], [2, '972531112222']]);
  assert.equal((await o.getCampaign(id)).total, 3);
});

test('createOutbound refuses bad setup: unknown placeholder, signup link not https, no opt-out text', () => {
  const base = { storage: createMemoryStorage({ projectId: 'x' }), whatsapp: createFakeWhatsAppClient(), isWithinSendWindow: () => true, now: () => MONDAY_NOON, optOutReplyText: 'x' };
  assert.throws(() => createOutbound({ ...base, templates: { t: { name: 'n', language: 'he', params: ['{city}'] } } }), /unknown placeholder \{city\}/);
  assert.throws(() => createOutbound({ ...base, signup: { template: { name: 'n', language: 'he' }, link: 'http://x' } }), /https/);
  assert.throws(() => createOutbound({ ...base, optOutReplyText: ' ' }), /optOutReplyText/);
  assert.throws(() => createOutbound({ ...base, templates: { t: { name: 'n' } } }), /name and a language/);
});

// ---- T-19 daily limit and weekly ramp ----

test('T-19 ramp: 100 a day in week 1, +50 each week, stops at the 250 ceiling', async () => {
  const { outbound: o, clock, storage } = setup();
  await runningCampaign(o, phones(3));
  assert.equal((await storage.get('outbound_settings', 'ramp')).startDate, '2026-10-26');
  const at = async (iso) => {
    clock.now = new Date(iso);
    const d = await o.todayStatus();
    return [d.week, d.quota];
  };
  assert.deepEqual(await at('2026-10-29T10:00:00Z'), [1, 100]);
  assert.deepEqual(await at('2026-11-02T10:00:00Z'), [2, 150]);
  assert.deepEqual(await at('2026-11-09T10:00:00Z'), [3, 200]);
  assert.deepEqual(await at('2026-11-16T10:00:00Z'), [4, 250]);
  assert.deepEqual(await at('2026-11-23T10:00:00Z'), [5, 250]);
  await o.updateRamp({ startPerDay: '100', stepPerWeek: '50', maxPerDay: '' });
  assert.deepEqual(await at('2026-11-23T10:00:00Z'), [5, 300]);
  await assert.rejects(o.updateRamp({ startPerDay: '0', stepPerWeek: '50', maxPerDay: '' }), OutboundError);
  await assert.rejects(o.updateRamp({ startPerDay: '100', stepPerWeek: '50', maxPerDay: '90' }), OutboundError);
});

test('T-19 the daily limit is shared by all campaigns and counts signup links; batches are small', async () => {
  const { outbound: o, whatsapp } = setup({ ramp: { startPerDay: 5, stepPerWeek: 0, maxPerDay: 5 }, batchPerRun: 3 });
  const a = await runningCampaign(o, phones(4, 0));
  await runningCampaign(o, phones(4, 100));
  assert.equal((await o.sendSignupLink({ phone: '0599999999', name: 'רון' })).status, 'sent');
  const r1 = await o.runCampaigns();
  assert.deepEqual([r1.status, r1.sent, r1.sentToday], ['ran', 3, 4]);
  const r2 = await o.runCampaigns();
  assert.deepEqual([r2.status, r2.sent, r2.sentToday], ['ran', 1, 5]);
  const r3 = await o.runCampaigns();
  assert.deepEqual([r3.status, r3.sent], ['daily_limit', 0]);
  assert.equal(whatsapp.sent.length, 5);
  // The older campaign goes first.
  assert.equal((await o.getCampaign(a)).sent, 4);
});

// ---- T-20 send window ----

test('T-20 outside the send window: the job sends nothing and a signup link is refused', async () => {
  const { outbound: o, whatsapp, clock } = setup();
  await runningCampaign(o, phones(2));
  clock.now = new Date('2026-10-26T15:51:00Z'); // 17:51 Israel time
  assert.equal((await o.runCampaigns()).status, 'outside_window');
  assert.equal((await o.sendSignupLink({ phone: '0501234567' })).status, 'outside_window');
  clock.now = new Date('2026-10-30T09:00:00Z'); // Friday
  assert.equal((await o.runCampaigns()).status, 'outside_window');
  assert.equal(whatsapp.sent.length, 0);
});

test('signup link: Meta template with the name and the link button; failures are recorded', async () => {
  const { outbound: o, whatsapp, storage } = setup();
  assert.equal((await o.sendSignupLink({ phone: 'abc' })).status, 'invalid_phone');
  const r = await o.sendSignupLink({ phone: '050-1234567', name: '' });
  assert.equal(r.status, 'sent');
  assert.deepEqual(whatsapp.sent[0], {
    type: 'template', to: '972501234567', templateName: 'signup_link', language: 'he', params: ['לקוח יקר'], urlButtonParam: 'https://example.com/join', messageId: 'fake-msg-1',
  });
  assert.equal((await storage.get('outbound_days', '2026-10-26')).sent, 1);
  whatsapp.failNextWith(new WhatsAppError('bad number', { status: 400, code: 131026 }));
  const failed = await o.sendSignupLink({ phone: '0527654321' });
  assert.equal(failed.status, 'failed');
  const signups = await o.listSignups();
  assert.equal(signups.length, 2);
  assert.ok(signups.some((s) => s.data.status === 'failed' && s.data.error.includes('131026')));
});

// ---- T-21 opt-out ----

test('T-21 opt-out words match exactly after cleanup, not inside a longer sentence', () => {
  const { outbound: o } = setup();
  for (const t of ['הסר', ' הסר. ', 'לא מעוניין', 'לא  מעוניינת!', 'STOP', 'הסירו אותי']) assert.equal(o.isOptOutText(t), true, t);
  for (const t of ['הסר את הביטוח הקודם', 'מעוניין', 'כן', '']) assert.equal(o.isOptOutText(t), false, t);
});

test('T-21 an opted-out phone gets no campaign message and no signup link', async () => {
  const { outbound: o, whatsapp } = setup();
  assert.equal(await o.recordOptOut({ phone: '972500000001', source: 'keyword' }), true);
  assert.equal(await o.recordOptOut({ phone: '0500000001', source: 'admin' }), false);
  assert.equal((await o.sendSignupLink({ phone: '0500000001' })).status, 'opted_out');
  const id = await runningCampaign(o, phones(3));
  await o.runCampaigns();
  assert.deepEqual(whatsapp.sent.map((s) => s.to), ['972500000000', '972500000002']);
  const statuses = (await o.listRecipients(id)).map((r) => r.data.status);
  assert.deepEqual(statuses, ['sent', 'opted_out', 'sent']);
  assert.equal((await o.getCampaign(id)).skipped, 1);
});

// ---- T-22 automatic pause ----

test('T-22 a Meta limit error on a send pauses the campaign, frees the recipient and alerts the owner; resume sends to them', async () => {
  const { outbound: o, whatsapp, alerts } = setup();
  const id = await runningCampaign(o, phones(3));
  await o.runCampaigns();
  assert.equal(whatsapp.sent.length, 3);

  const id2 = await runningCampaign(o, phones(3, 50));
  whatsapp.failNextWith(new WhatsAppError('Spam rate limit hit', { status: 400, code: 131048 }));
  const r = await o.runCampaigns();
  assert.equal(r.sent, 0);
  const c = await o.getCampaign(id2);
  assert.equal(c.status, 'paused_auto');
  assert.match(c.pauseReason, /131048/);
  assert.equal(c.nextIndex, 0);
  assert.equal(alerts.length, 2); // first campaign done, then the pause
  assert.equal(alerts[1].event, 'campaign_alert');
  assert.equal((await o.listRecipients(id2))[0].data.status, 'pending');

  assert.equal((await o.runCampaigns()).sent, 0); // paused: nothing goes out
  await o.setStatus(id2, 'start');
  assert.equal((await o.runCampaigns()).sent, 3);
  assert.equal((await o.getCampaign(id2)).status, 'done');
  assert.equal((await o.getCampaign(id)).status, 'done');
});

test('T-22 ten failed sends in a row pause the campaign; a per-recipient failure alone does not', async () => {
  const { outbound: o, whatsapp } = setup({ batchPerRun: 25 });
  const id = await runningCampaign(o, phones(12));
  const original = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async () => {
    throw new WhatsAppError('Message undeliverable', { status: 400, code: 131026 });
  };
  await o.runCampaigns();
  const c = await o.getCampaign(id);
  assert.equal(c.status, 'paused_auto');
  assert.equal(c.failed, 10);
  assert.match(c.pauseReason, /10/);
  whatsapp.sendTemplate = original;
  await o.setStatus(id, 'start');
  await o.runCampaigns();
  const statuses = (await o.listRecipients(id)).map((r) => r.data.status);
  assert.deepEqual(statuses.filter((s) => s === 'failed').length, 10);
  assert.deepEqual(statuses.filter((s) => s === 'sent').length, 2);
});

test('T-22 Meta webhook: quality flagged pauses running campaigns; template paused pauses only its campaigns', async () => {
  const { outbound: o, alerts } = setup();
  const a = await runningCampaign(o, phones(2), 'travel');
  const b = await runningCampaign(o, phones(2, 10), 'plain');
  await o.handleEvents([{ kind: 'template', event: 'PAUSED', templateName: 'travel_offer', reason: 'low quality' }]);
  assert.equal((await o.getCampaign(a)).status, 'paused_auto');
  assert.equal((await o.getCampaign(b)).status, 'running');
  await o.handleEvents([{ kind: 'quality', event: 'UPGRADE', currentLimit: 'TIER_1K' }]);
  assert.equal((await o.getCampaign(b)).status, 'running');
  const out = await o.handleEvents([{ kind: 'quality', event: 'FLAGGED', currentLimit: 'TIER_250' }]);
  assert.equal(out.paused, 1);
  const c = await o.getCampaign(b);
  assert.equal(c.status, 'paused_auto');
  assert.match(c.pauseReason, /FLAGGED/);
  assert.equal(alerts.length, 2);
  // No campaign running: the owner is still told about the warning.
  await o.handleEvents([{ kind: 'quality', event: 'DOWNGRADE', currentLimit: 'TIER_250' }]);
  assert.equal(alerts.length, 3);
});

// ---- T-23 one send per recipient ----

test('T-23 two job runs at the same time never send to the same recipient twice', async () => {
  const { outbound: o, whatsapp } = setup({ batchPerRun: 10 });
  await runningCampaign(o, phones(6));
  await Promise.all([o.runCampaigns(), o.runCampaigns()]);
  const to = whatsapp.sent.map((s) => s.to);
  assert.equal(new Set(to).size, to.length);
  assert.equal(to.length, 6);
});

test('T-23 a finished campaign sends nothing more; adding recipients pauses it for a person to restart', async () => {
  const { outbound: o, whatsapp } = setup();
  const id = await runningCampaign(o, phones(2));
  await o.runCampaigns();
  assert.equal((await o.getCampaign(id)).status, 'done');
  await o.runCampaigns();
  assert.equal(whatsapp.sent.length, 2);
  await o.addRecipients(id, phones(3)); // 2 old + 1 new
  const c = await o.getCampaign(id);
  assert.deepEqual([c.status, c.total], ['paused', 3]);
  await assert.rejects(o.setStatus(id, 'pause'), OutboundError);
  await o.setStatus(id, 'start');
  await o.runCampaigns();
  assert.equal(whatsapp.sent.length, 3);
});

test('campaign rules: start needs recipients, unknown template refused, missing value fails one recipient', async () => {
  const { outbound: o, whatsapp } = setup({ fallbacks: {} });
  await assert.rejects(o.createCampaign({ name: 'x', templateKey: 'nope' }), OutboundError);
  await assert.rejects(o.createCampaign({ name: ' ', templateKey: 'travel' }), OutboundError);
  const id = await o.createCampaign({ name: 'x', templateKey: 'travel' });
  await assert.rejects(o.setStatus(id, 'start'), /אין נמענים/);
  await o.addRecipients(id, [{ phone: '0501234567', name: '' }, { phone: '0527654321', name: 'דנה' }]);
  await o.setStatus(id, 'start');
  await o.runCampaigns();
  const list = await o.listRecipients(id);
  assert.equal(list[0].data.status, 'failed');
  assert.match(list[0].data.error, /\{name\}/);
  assert.equal(list[1].data.status, 'sent');
  assert.deepEqual(whatsapp.sent[0].params, ['דנה']);
});

// ---- T-24 recipient status from Meta ----

test('T-24 statuses from the webhook move a recipient forward only; failed keeps the reason', async () => {
  const { outbound: o, whatsapp } = setup();
  const id = await runningCampaign(o, phones(2));
  await o.runCampaigns();
  const [m1, m2] = whatsapp.sent.map((s) => s.messageId);
  const out = await o.handleEvents([
    { kind: 'status', messageId: m1, status: 'delivered' },
    { kind: 'status', messageId: m1, status: 'read' },
    { kind: 'status', messageId: m1, status: 'delivered' },
    { kind: 'status', messageId: m2, status: 'failed', errorCode: 131026, errorTitle: 'Message undeliverable' },
    { kind: 'status', messageId: 'unknown-id', status: 'read' },
  ]);
  assert.deepEqual(out, { statuses: 4, paused: 0 });
  const list = await o.listRecipients(id);
  assert.equal(list[0].data.status, 'read');
  assert.equal(list[1].data.status, 'failed');
  assert.match(list[1].data.error, /131026 Message undeliverable/);
});

test('T-24 a failed status with a Meta limit code pauses the campaign', async () => {
  const { outbound: o, whatsapp } = setup({ batchPerRun: 1 });
  const id = await runningCampaign(o, phones(3));
  await o.runCampaigns();
  const out = await o.handleEvents([{ kind: 'status', messageId: whatsapp.sent[0].messageId, status: 'failed', errorCode: 131048, errorTitle: 'Spam rate limit hit' }]);
  assert.equal(out.paused, 1);
  assert.equal((await o.getCampaign(id)).status, 'paused_auto');
});

// ---- replies (Dedi, 2026-10-28: the agent sees who answered and what) ----

test('T-24 a reply from a contacted customer marks them "replied" with the text; not-yet-sent customers stay waiting', async () => {
  const { outbound: o } = setup({ batchPerRun: 1 });
  const id = await runningCampaign(o, phones(2));
  await o.runCampaigns(); // only the first is sent
  const source = await o.recordReply({ phone: '972500000000', text: 'כן, מעוניין. כמה זה עולה?' });
  assert.deepEqual(source, { campaignId: id, campaignName: 'קמפיין' });
  assert.equal(await o.recordReply({ phone: '972500000001', text: 'מי זה?' }), null);
  assert.equal(await o.recordReply({ phone: '972599999999', text: 'שלום' }), null);
  const list = await o.listRecipients(id);
  assert.deepEqual([list[0].data.status, list[0].data.reply], ['replied', 'כן, מעוניין. כמה זה עולה?']);
  assert.equal(list[1].data.status, 'pending');
  // A later Meta "read" status does not move a replied recipient back.
  await o.handleEvents([{ kind: 'status', messageId: list[0].data.messageId, status: 'read' }]);
  assert.equal((await o.listRecipients(id))[0].data.status, 'replied');
});

test('T-21 an opt-out reply marks the recipient opted out, also in a campaign that has not sent yet', async () => {
  const { outbound: o, whatsapp } = setup({ batchPerRun: 1 });
  const id = await runningCampaign(o, phones(2));
  await o.runCampaigns();
  await o.recordReply({ phone: '972500000000', text: 'הסר', optedOut: true });
  await o.recordReply({ phone: '972500000001', text: 'הסר', optedOut: true });
  await o.recordOptOut({ phone: '972500000001', source: 'keyword' });
  await o.runCampaigns();
  const list = await o.listRecipients(id);
  assert.deepEqual(list.map((r) => r.data.status), ['opted_out', 'opted_out']);
  assert.equal(whatsapp.sent.length, 1);
});

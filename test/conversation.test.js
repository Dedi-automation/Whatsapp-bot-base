'use strict';

// B7 Conversation engine. Covers T-03, T-09 (full DRY RUN), T-10, T-11, T-17, and the send-window rule (B8).
// Uses the fakes for B3, B5 and B6, and the real deduplicator from B2 (security.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConversationEngine } = require('../src/conversation');
const { createDeduplicator } = require('../src/security');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { createFakeAiClient } = require('../src/fakes/ai-fake');

const TOOL = { name: 'send_whatsapp_reply', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } };

function build({ withinWindow = true, aiReplies = [{ text: 'תודה' }], media = {} } = {}) {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const whatsapp = createFakeWhatsAppClient();
  const ai = createFakeAiClient(aiReplies);
  const engine = createConversationEngine({
    storage,
    whatsapp,
    ai,
    deduplicator: createDeduplicator({ storage }),
    isWithinSendWindow: () => withinWindow,
    now: () => new Date('2026-10-25T10:00:00Z'),
    unsupportedReplyText: 'Sorry, I can only read text messages.',
    ...media,
    systemPrompt: 'system',
    tool: TOOL,
  });
  return { storage, whatsapp, ai, engine };
}

const textMsg = (messageId = 'wamid.1') => ({ kind: 'text', messageId, from: '972500000000', text: 'שלום' });

test('T-03: the same message ID is processed once; the second delivery is a duplicate', async () => {
  const { engine, whatsapp } = build({ aiReplies: [{ text: 'a' }] });
  const first = await engine.handleIncoming(textMsg('wamid.dup'));
  const second = await engine.handleIncoming(textMsg('wamid.dup'));
  assert.equal(first.status, 'replied');
  assert.equal(second.status, 'duplicate');
  assert.equal(whatsapp.sent.length, 1);
});

test('T-11: the inbound message is saved as a transcript record before any reply', async () => {
  const { engine, storage } = build();
  const outcome = await engine.handleIncoming(textMsg('wamid.t'));
  const saved = await storage.get('messages', `${outcome.conversationId}:1`);
  assert.equal(saved.text, 'שלום');
});

test('T-17: a voice note gets the defined reply text, not silence', async () => {
  const { engine, whatsapp } = build();
  const outcome = await engine.handleIncoming({ kind: 'unsupported', messageId: 'wamid.v', from: '972500000000', mediaType: 'audio', text: null });
  assert.equal(outcome.status, 'unsupported_reply');
  assert.equal(whatsapp.sent[0].text, 'Sorry, I can only read text messages.');
});

test('T-06: an AI reply that fails the schema is not sent', async () => {
  const { engine, whatsapp } = build({ aiReplies: [{ wrong: true }] });
  await assert.rejects(() => engine.handleIncoming(textMsg('wamid.bad')));
  assert.equal(whatsapp.sent.length, 0);
});

test('outside the send window the message is saved and no reply is sent', async () => {
  const { engine, whatsapp, storage } = build({ withinWindow: false });
  const outcome = await engine.handleIncoming(textMsg('wamid.late'));
  assert.equal(outcome.status, 'outside_window');
  assert.equal(whatsapp.sent.length, 0);
  assert.notEqual(await storage.get('messages', `${outcome.conversationId}:1`), null);
});

test('handoff to the agent sets agent_action_required on the conversation', async () => {
  const { engine, storage } = build({ aiReplies: [{ text: 'handoff', handoff: true }] });
  const outcome = await engine.handleIncoming(textMsg('wamid.h'));
  assert.equal(outcome.status, 'handoff');
  const conv = await storage.get('conversations', outcome.conversationId);
  assert.equal(conv.agent_action_required, true);
});

test('T-09: DRY RUN end to end, nothing real sent (scripts/dry-run.js; Firestore case in test/integration.test.js)', async () => {
  const { runDryRun } = require('../scripts/dry-run');
  const report = await runDryRun({ storage: createMemoryStorage({ projectId: 'dry-run-t09' }) });
  assert.deepEqual(report.checks.filter(([, pass]) => !pass), []);
  assert.ok(report.ok);
});

test('T-10: test mode ends with 4 to 6 questions to the agent, answers routed by the engine', async () => {
  const { createTestMode } = require('../src/test-mode');
  const storage = createMemoryStorage({ projectId: 'test-t10' });
  const whatsapp = createFakeWhatsAppClient();
  const questions = ['q1', 'q2', 'q3', 'q4'];
  const module_ = createTestMode({ storage, whatsapp, isWithinSendWindow: () => true, now: () => new Date('2026-10-26T10:00:00Z'), questions, closingText: 'bye' });
  const closed = [];
  const ai = createFakeAiClient([{ text: 'trial reply' }]);
  const engine = createConversationEngine({
    storage, whatsapp, ai,
    deduplicator: createDeduplicator({ storage }),
    isWithinSendWindow: () => true,
    now: () => new Date('2026-10-26T10:00:00Z'),
    unsupportedReplyText: 'text only',
    systemPrompt: 'system',
    tool: TOOL,
    testMode: { phones: ['972500000099'], endKeyword: 'סיום בדיקה', module: module_, onTrialClosed: async (id) => closed.push(id) },
  });
  const from = '972500000099';
  let n = 0;
  const say = (text) => engine.handleIncoming({ kind: 'text', messageId: `w${(n += 1)}`, from, text });

  assert.equal((await say('hello bot')).status, 'replied', 'the trial conversation goes to the AI');
  assert.equal((await say(' סיום בדיקה ')).status, 'test_trial_ended');
  for (const answer of ['a1', 'a2', 'a3', 'a4']) assert.equal((await say(answer)).status, 'test_feedback');

  const texts = whatsapp.sent.map((m) => m.text);
  assert.deepEqual(texts, ['trial reply', 'q1', 'q2', 'q3', 'q4', 'bye']);
  assert.equal(ai.calls.length, 1, 'answers never reach the AI');
  assert.equal(closed.length, 1);
  assert.deepEqual((await module_.listImprovements(closed[0])).map((r) => r.data.answer), ['a1', 'a2', 'a3', 'a4']);
  const conv = await storage.get('conversations', from);
  assert.equal(conv.activeTrialId, null);
  assert.equal(conv.lastTrialId, closed[0]);
});

test('test mode: the end keyword from a customer (not a tester) goes to the AI as usual', async () => {
  const { createTestMode } = require('../src/test-mode');
  const storage = createMemoryStorage({ projectId: 'test-t10b' });
  const whatsapp = createFakeWhatsAppClient();
  const module_ = createTestMode({ storage, whatsapp, isWithinSendWindow: () => true, now: () => new Date(), questions: ['1', '2', '3', '4'], closingText: 'bye' });
  const engine = createConversationEngine({
    storage, whatsapp, ai: createFakeAiClient([{ text: 'ok' }]),
    deduplicator: createDeduplicator({ storage }), isWithinSendWindow: () => true, now: () => new Date(),
    unsupportedReplyText: 'x', systemPrompt: 's', tool: TOOL,
    testMode: { phones: ['972500000099'], endKeyword: 'סיום בדיקה', module: module_ },
  });
  const outcome = await engine.handleIncoming({ kind: 'text', messageId: 'c1', from: '972500000001', text: 'סיום בדיקה' });
  assert.equal(outcome.status, 'replied');
});

test('decisions.md item 32: an accepted file is downloaded and stored next to its transcript record', async () => {
  const { storage, whatsapp, engine } = build({
    media: { acceptedMediaTypes: ['image'], mediaReceivedReplyText: 'got it', mediaRejectedReplyText: 'only {accepted}' },
  });
  whatsapp.downloadMedia = async ({ mediaId }) => ({ data: Buffer.from(`file-${mediaId}`), mimeType: 'image/jpeg' });
  const outcome = await engine.handleIncoming({ kind: 'unsupported', messageId: 'm1', from: '972500000000', mediaType: 'image', text: null, media: { id: 'mid-1', mimeType: 'image/jpeg', caption: null } });
  assert.equal(outcome.status, 'media_received');
  const file = await storage.get('media', '972500000000:1');
  assert.equal(file.stored, true);
  assert.equal(Buffer.from(file.data, 'base64').toString(), 'file-mid-1');
  assert.equal(file.mimeType, 'image/jpeg');
});

test('a failed or too large download keeps the reason; the customer still gets the reply', async () => {
  const { MAX_MEDIA_BYTES } = require('../src/conversation');
  const { storage, whatsapp, engine } = build({
    media: { acceptedMediaTypes: ['image'], mediaReceivedReplyText: 'got it', mediaRejectedReplyText: 'only {accepted}' },
  });
  let big = false;
  whatsapp.downloadMedia = async () => {
    if (big) return { data: Buffer.alloc(MAX_MEDIA_BYTES + 1), mimeType: 'image/png' };
    throw new Error('network down');
  };
  const img = (id) => ({ kind: 'unsupported', messageId: id, from: '972500000000', mediaType: 'image', text: null, media: { id, mimeType: 'image/png', caption: null } });
  assert.equal((await engine.handleIncoming(img('a'))).status, 'media_received');
  assert.match((await storage.get('media', '972500000000:1')).detail, /network down/);
  big = true;
  await engine.handleIncoming(img('b'));
  const second = (await storage.list('media')).find((r) => r.data.mediaId === 'b');
  assert.equal(second.data.stored, false);
  assert.match(second.data.detail, /over the/);
  assert.equal(whatsapp.sent.filter((m) => m.text === 'got it').length, 2);
});

test('handoff: the onHandoff hook runs after the handoff is recorded; its failure is logged, not thrown', async () => {
  const calls = [];
  const errors = [];
  const storage = createMemoryStorage({ projectId: 'test-h' });
  const make = (hook) => createConversationEngine({
    storage, whatsapp: createFakeWhatsAppClient(), ai: createFakeAiClient([{ text: 'thanks', handoff: true, handoff_reason: 'price' }]),
    deduplicator: createDeduplicator({ storage }), isWithinSendWindow: () => true, now: () => new Date(),
    unsupportedReplyText: 'x', systemPrompt: 's', tool: TOOL, onHandoff: hook,
    log: { info() {}, error: (m) => errors.push(m) },
  });
  const ok = await make(async (input) => {
    calls.push({ ...input, recorded: (await storage.get('conversations', input.conversationId)).agent_action_required });
  }).handleIncoming(textMsg('h1'));
  assert.equal(ok.status, 'handoff');
  assert.deepEqual(calls, [{ conversationId: '972500000000', reason: 'price', recorded: true }]);

  const failing = await make(async () => { throw new Error('smtp down'); }).handleIncoming(textMsg('h2'));
  assert.equal(failing.status, 'handoff');
  assert.equal(errors.length, 1);
});

test('the AI gets the full transcript, and the reply is saved as the next record', async () => {
  const { engine, ai, storage } = build({ aiReplies: [{ text: 'one' }, { text: 'two' }] });
  await engine.handleIncoming(textMsg('wamid.a'));
  const outcome = await engine.handleIncoming(textMsg('wamid.b'));
  assert.deepEqual(ai.calls[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const reply = await storage.get('messages', `${outcome.conversationId}:4`);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.text, 'two');
});

test('T-17: outside the send window a voice note gets no reply either', async () => {
  const { engine, whatsapp } = build({ withinWindow: false });
  const outcome = await engine.handleIncoming({ kind: 'unsupported', messageId: 'wamid.v2', from: '972500000000', mediaType: 'audio', text: null });
  assert.equal(outcome.status, 'outside_window');
  assert.equal(whatsapp.sent.length, 0);
});

test('handoff: the customer gets the reply first, then the handoff is recorded', async () => {
  const { engine, storage, whatsapp } = build({ aiReplies: [{ text: 'תודה, נציג יחזור אליך', handoff: true }] });
  let flaggedAtSend;
  const realSend = whatsapp.sendText;
  whatsapp.sendText = async (input) => {
    const conv = await storage.get('conversations', input.to);
    flaggedAtSend = Boolean(conv && conv.agent_action_required);
    return realSend(input);
  };
  const outcome = await engine.handleIncoming(textMsg('wamid.order'));
  assert.equal(flaggedAtSend, false);
  assert.equal((await storage.get('conversations', outcome.conversationId)).agent_action_required, true);
});

test('handoff is still recorded when the reply cannot be sent', async () => {
  const { WhatsAppError } = require('../src/errors');
  const { engine, storage, whatsapp } = build({ aiReplies: [{ text: 'תודה', handoff: true }] });
  whatsapp.failNextWith(new WhatsAppError('down', { status: 500 }));
  await assert.rejects(() => engine.handleIncoming(textMsg('wamid.fail')), WhatsAppError);
  assert.equal((await storage.get('conversations', '972500000000')).agent_action_required, true);
});

test('an image is saved in the transcript with its media reference', async () => {
  const { engine, storage } = build();
  const media = { id: 'media-1', mimeType: 'image/jpeg', caption: null };
  const outcome = await engine.handleIncoming({ kind: 'unsupported', messageId: 'wamid.img', from: '972500000000', mediaType: 'image', text: null, media });
  const saved = await storage.get('messages', `${outcome.conversationId}:1`);
  assert.deepEqual(saved.media, media);
});

const idPhoto = (type = 'image', id = 'media-id-1') => ({
  kind: 'unsupported', messageId: `wamid.${type}.${id}`, from: '972500000000', mediaType: type, text: null,
  media: { id, mimeType: 'image/jpeg', caption: null },
});
const ACCEPT_ID_PHOTO = {
  acceptedMediaTypes: ['image', 'document'],
  mediaReceivedReplyText: 'Thanks, we received your file.',
  mediaRejectedReplyText: 'אני מקבל קבצים רק בפורמט: {accepted}',
  mediaTypeLabels: { image: 'תמונה', document: 'מסמך' },
};

test('a media type the bot accepts is saved and gets the bot acknowledgement', async () => {
  const { engine, whatsapp, storage, ai } = build({ media: ACCEPT_ID_PHOTO });
  const outcome = await engine.handleIncoming(idPhoto('image'));
  assert.equal(outcome.status, 'media_received');
  assert.equal(whatsapp.sent[0].text, 'Thanks, we received your file.');
  assert.equal((await storage.get('messages', `${outcome.conversationId}:1`)).media.id, 'media-id-1');
  assert.equal(ai.calls.length, 0);
});

test('a media type the bot does not accept gets a reply naming the accepted formats, and is still saved', async () => {
  const { engine, whatsapp, storage } = build({ media: ACCEPT_ID_PHOTO });
  const outcome = await engine.handleIncoming(idPhoto('video'));
  assert.equal(outcome.status, 'media_rejected');
  assert.equal(whatsapp.sent[0].text, 'אני מקבל קבצים רק בפורמט: תמונה, מסמך');
  assert.equal((await storage.get('messages', `${outcome.conversationId}:1`)).media.id, 'media-id-1');
});

test('without labels the accepted formats are named by type', async () => {
  const { engine, whatsapp } = build({ media: { ...ACCEPT_ID_PHOTO, mediaTypeLabels: undefined } });
  await engine.handleIncoming(idPhoto('audio'));
  assert.equal(whatsapp.sent[0].text, 'אני מקבל קבצים רק בפורמט: image, document');
});

test('by default no media type is accepted', async () => {
  const { engine } = build();
  assert.equal((await engine.handleIncoming(idPhoto('image'))).status, 'unsupported_reply');
});

test('an accepted type without a media ID is not acknowledged as received', async () => {
  const { engine } = build({ media: ACCEPT_ID_PHOTO });
  const msg = { kind: 'unsupported', messageId: 'wamid.noid', from: '972500000000', mediaType: 'image', text: null };
  assert.equal((await engine.handleIncoming(msg)).status, 'unsupported_reply');
});

test('outside the send window an accepted file is saved and not acknowledged', async () => {
  const { engine, whatsapp } = build({ withinWindow: false, media: ACCEPT_ID_PHOTO });
  assert.equal((await engine.handleIncoming(idPhoto('document'))).status, 'outside_window');
  assert.equal(whatsapp.sent.length, 0);
});

test('media config is checked at startup: unknown type, missing texts, or no {accepted} placeholder', () => {
  assert.throws(() => build({ media: { ...ACCEPT_ID_PHOTO, acceptedMediaTypes: ['pdf'] } }), /unknown types: pdf/);
  assert.throws(() => build({ media: { ...ACCEPT_ID_PHOTO, mediaReceivedReplyText: undefined } }), /mediaReceivedReplyText is required/);
  assert.throws(() => build({ media: { ...ACCEPT_ID_PHOTO, mediaRejectedReplyText: 'no placeholder' } }), /\{accepted\} is required/);
});

// ---- base 1.1.0: opt-out (decisions.md item 49, T-21) ----

function buildWithOptOut({ withinWindow = true } = {}) {
  const built = build({ withinWindow, aiReplies: [{ text: 'תשובה' }] });
  const recorded = new Set();
  const engine = createConversationEngine({
    storage: built.storage,
    whatsapp: built.whatsapp,
    ai: built.ai,
    deduplicator: createDeduplicator({ storage: built.storage }),
    isWithinSendWindow: () => withinWindow,
    now: () => new Date('2026-10-25T10:00:00Z'),
    unsupportedReplyText: 'x',
    systemPrompt: 'system',
    tool: TOOL,
    optOut: {
      isOptOutText: (t) => t.trim() === 'הסר',
      recordOptOut: async ({ phone }) => {
        const added = !recorded.has(phone);
        recorded.add(phone);
        return added;
      },
      replyText: 'הוסרת.',
    },
  });
  return { ...built, engine, recorded };
}

test('T-21 an opt-out word is recorded, confirmed once, and does not reach the AI', async () => {
  const { engine, whatsapp, ai, recorded, storage } = buildWithOptOut();
  const first = await engine.handleIncoming({ kind: 'text', messageId: 'o1', from: '972500000000', text: 'הסר' });
  const again = await engine.handleIncoming({ kind: 'text', messageId: 'o2', from: '972500000000', text: 'הסר' });
  assert.deepEqual([first.status, again.status], ['opted_out', 'opted_out']);
  assert.ok(recorded.has('972500000000'));
  assert.deepEqual(whatsapp.sent.map((s) => s.text), ['הוסרת.']);
  assert.equal(ai.calls ? ai.calls.length : 0, 0);
  assert.equal((await storage.get('conversations', '972500000000')).optedOut, true);
  const normal = await engine.handleIncoming({ kind: 'text', messageId: 'o3', from: '972500000000', text: 'שאלה' });
  assert.equal(normal.status, 'replied');
});

test('T-21 outside the send window the opt-out is recorded with no confirmation', async () => {
  const { engine, whatsapp, recorded } = buildWithOptOut({ withinWindow: false });
  const out = await engine.handleIncoming({ kind: 'text', messageId: 'o1', from: '972500000000', text: 'הסר' });
  assert.equal(out.status, 'opted_out');
  assert.ok(recorded.has('972500000000'));
  assert.equal(whatsapp.sent.length, 0);
});

test('campaign reply: onCustomerText marks the conversation with the campaign, then the AI answers as usual', async () => {
  const built = build({ aiReplies: [{ text: 'שמח לעזור' }] });
  const seen = [];
  const engine = createConversationEngine({
    storage: built.storage,
    whatsapp: built.whatsapp,
    ai: built.ai,
    deduplicator: createDeduplicator({ storage: built.storage }),
    isWithinSendWindow: () => true,
    now: () => new Date('2026-10-25T10:00:00Z'),
    unsupportedReplyText: 'x',
    systemPrompt: 'system',
    tool: TOOL,
    onCustomerText: async (input) => {
      seen.push(input);
      return { campaignId: 'c1', campaignName: 'נסיעות' };
    },
  });
  const out = await engine.handleIncoming({ kind: 'text', messageId: 'r1', from: '972500000000', text: 'מעוניין' });
  assert.equal(out.status, 'replied');
  assert.deepEqual(seen, [{ phone: '972500000000', text: 'מעוניין', optedOut: false }]);
  const conv = await built.storage.get('conversations', '972500000000');
  assert.deepEqual([conv.campaignId, conv.campaignName], ['c1', 'נסיעות']);
});

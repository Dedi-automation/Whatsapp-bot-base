'use strict';

// B7 Conversation engine. Covers T-03, T-10 (todo), T-11, T-17, and the send-window rule (B8).
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

test('T-09: DRY RUN end to end (todo: needs Branch E test mode and all modules)', { todo: 'Step 2 integration' }, () => {});
test('T-10: test mode ends with 4 to 6 questions to the agent (todo: section 9, Branch E)', { todo: 'Branch E' }, () => {});

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

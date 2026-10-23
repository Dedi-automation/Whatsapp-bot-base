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

function build({ withinWindow = true, aiReplies = [{ text: 'תודה' }] } = {}) {
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

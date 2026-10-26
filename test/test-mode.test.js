'use strict';

// Test mode and feedback (spec section 9). Covers T-10 for Branch E.
// The T-10 todo in test/conversation.test.js (Branch B) is switched on in step 2.
// Uses the fakes for B3 and B5.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestMode, TestModeError } = require('../src/test-mode');
const { checkHealth } = require('../src/health');
const { createMemoryStorage } = require('../src/fakes/memory-storage');
const { createFakeWhatsAppClient } = require('../src/fakes/whatsapp-fake');
const { createFakeAiClient } = require('../src/fakes/ai-fake');

const QUESTIONS = [
  'Was the bot clear?',
  'Was anything missing?',
  'Was anything wrong?',
  'Was the tone right?',
  'What would you change first?',
];
const CLOSING = 'Thank you, your notes were saved.';
const AGENT = '972500000001';
const TRIAL = { trialId: 'trial-1', conversationId: 'conv-1', agentPhone: AGENT };

function build({ questions = QUESTIONS, withinWindow = () => true } = {}) {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const whatsapp = createFakeWhatsAppClient();
  const mode = createTestMode({
    storage,
    whatsapp,
    isWithinSendWindow: (now) => withinWindow(now),
    now: () => new Date('2026-10-25T10:00:00Z'),
    questions,
    closingText: CLOSING,
  });
  return { storage, whatsapp, mode };
}

test('T-10: a complete test conversation ends with 4 to 6 questions to the agent', async () => {
  const { mode, whatsapp } = build();
  let outcome = await mode.endTrial(TRIAL);
  let answers = 0;
  while (outcome.status === 'question_sent') {
    answers += 1;
    outcome = await mode.handleAnswer({ trialId: 'trial-1', text: `answer ${answers}` });
  }
  assert.equal(outcome.status, 'closed');

  const toAgent = whatsapp.sent.filter((m) => m.to === AGENT).map((m) => m.text);
  const asked = toAgent.filter((t) => QUESTIONS.includes(t));
  assert.ok(asked.length >= 4 && asked.length <= 6, `asked ${asked.length} questions`);
  assert.deepEqual(asked, QUESTIONS);
  assert.equal(toAgent.at(-1), CLOSING);
  assert.equal(await mode.isCollectingFeedback('trial-1'), false);
});

test('each answer is saved as an improvement record through storage', async () => {
  const { mode, storage } = build();
  await mode.endTrial(TRIAL);
  const first = await mode.handleAnswer({ trialId: 'trial-1', text: 'too long' });
  assert.equal(first.saved, 'trial-1:1');

  const record = await storage.get('improvements', 'trial-1:1');
  assert.equal(record.question, QUESTIONS[0]);
  assert.equal(record.answer, 'too long');
  assert.equal(record.conversationId, 'conv-1');
  assert.equal(record.status, 'open');
  assert.equal(record.createdAt, '2026-10-25T10:00:00.000Z');
});

test('all notes of a trial are listed in order', async () => {
  const { mode } = build();
  await mode.endTrial(TRIAL);
  for (let i = 1; i <= QUESTIONS.length; i += 1) {
    await mode.handleAnswer({ trialId: 'trial-1', text: `note ${i}` });
  }
  const notes = await mode.listImprovements('trial-1');
  assert.deepEqual(notes.map((n) => n.data.answer), ['note 1', 'note 2', 'note 3', 'note 4', 'note 5']);
  assert.deepEqual(notes.map((n) => n.data.questionIndex), [0, 1, 2, 3, 4]);
});

test('fewer than 4 or more than 6 questions is a config error', () => {
  assert.throws(() => build({ questions: QUESTIONS.slice(0, 3) }), TestModeError);
  assert.throws(() => build({ questions: [...QUESTIONS, 'six', 'seven'] }), TestModeError);
  assert.doesNotThrow(() => build({ questions: QUESTIONS.slice(0, 4) }));
  assert.doesNotThrow(() => build({ questions: [...QUESTIONS, 'six'] }));
});

test('an empty question or closing text is a config error', () => {
  assert.throws(() => build({ questions: ['a', 'b', ' ', 'd'] }), /index 2/);
  assert.throws(
    () => createTestMode({
      storage: createMemoryStorage({ projectId: 'test-a' }),
      whatsapp: createFakeWhatsAppClient(),
      isWithinSendWindow: () => true,
      now: () => new Date(),
      questions: QUESTIONS,
      closingText: '',
    }),
    TestModeError,
  );
});

test('outside the send window nothing is sent; the question is sent on resume inside the window', async () => {
  let open = false;
  const { mode, whatsapp } = build({ withinWindow: () => open });
  const ended = await mode.endTrial(TRIAL);
  assert.equal(ended.status, 'outside_window');
  assert.equal(whatsapp.sent.length, 0);

  open = true;
  const resumed = await mode.resume('trial-1');
  assert.equal(resumed.status, 'question_sent');
  assert.deepEqual(whatsapp.sent.map((m) => m.text), [QUESTIONS[0]]);
});

test('an answer outside the send window is saved; the next question waits for the window', async () => {
  let open = true;
  const { mode, whatsapp, storage } = build({ withinWindow: () => open });
  await mode.endTrial(TRIAL);
  open = false;
  const outcome = await mode.handleAnswer({ trialId: 'trial-1', text: 'late note' });
  assert.equal(outcome.status, 'outside_window');
  assert.equal((await storage.get('improvements', 'trial-1:1')).answer, 'late note');
  assert.equal(whatsapp.sent.length, 1);

  open = true;
  await mode.resume('trial-1');
  assert.equal(whatsapp.sent.at(-1).text, QUESTIONS[1]);
});

test('a second answer before the next question is sent is kept, not overwritten', async () => {
  let open = true;
  const { mode } = build({ withinWindow: () => open });
  await mode.endTrial(TRIAL);
  open = false;
  await mode.handleAnswer({ trialId: 'trial-1', text: 'first' });
  await mode.handleAnswer({ trialId: 'trial-1', text: 'and one more thing' });
  const notes = await mode.listImprovements('trial-1');
  assert.deepEqual(notes.map((n) => n.data.answer), ['first', 'and one more thing']);
  assert.deepEqual(notes.map((n) => n.data.question), [QUESTIONS[0], QUESTIONS[0]]);
});

test('a question already sent is not sent again by endTrial or resume', async () => {
  const { mode, whatsapp } = build();
  await mode.endTrial(TRIAL);
  const again = await mode.endTrial(TRIAL);
  const resumed = await mode.resume('trial-1');
  assert.equal(again.status, 'waiting_for_answer');
  assert.equal(resumed.status, 'waiting_for_answer');
  assert.equal(whatsapp.sent.length, 1);
});

test('a closed trial accepts no more answers and sends nothing more', async () => {
  const { mode, whatsapp } = build({ questions: QUESTIONS.slice(0, 4) });
  await mode.endTrial(TRIAL);
  for (let i = 0; i < 4; i += 1) await mode.handleAnswer({ trialId: 'trial-1', text: 'ok' });
  const sentBefore = whatsapp.sent.length;
  await assert.rejects(() => mode.handleAnswer({ trialId: 'trial-1', text: 'late' }), TestModeError);
  assert.equal((await mode.endTrial(TRIAL)).status, 'already_closed');
  assert.equal(whatsapp.sent.length, sentBefore);
});

test('two trials keep their notes apart', async () => {
  const { mode } = build();
  await mode.endTrial(TRIAL);
  await mode.endTrial({ trialId: 'trial-2', conversationId: 'conv-2', agentPhone: '972500000002' });
  await mode.handleAnswer({ trialId: 'trial-1', text: 'one' });
  await mode.handleAnswer({ trialId: 'trial-2', text: 'two' });
  assert.deepEqual((await mode.listImprovements('trial-1')).map((n) => n.data.answer), ['one']);
  assert.deepEqual((await mode.listImprovements('trial-2')).map((n) => n.data.answer), ['two']);
});

test('a WhatsApp send error is not swallowed and the question stays pending', async () => {
  const { WhatsAppError } = require('../src/errors');
  const { mode, whatsapp } = build();
  whatsapp.failNextWith(new WhatsAppError('down', { status: 500 }));
  await assert.rejects(() => mode.endTrial(TRIAL), WhatsAppError);
  const retry = await mode.resume('trial-1');
  assert.equal(retry.status, 'question_sent');
  assert.equal(whatsapp.sent.length, 1);
});

test('an answer for an unknown trial is an error', async () => {
  const { mode } = build();
  await assert.rejects(() => mode.handleAnswer({ trialId: 'nope', text: 'x' }), TestModeError);
});

// Branch E dry run: the health check and a full test-mode cycle with fakes only.
// Nothing real is sent; every message that would have been sent is logged as a diagnostic.
// The full-system DRY RUN (T-09) is step 2.
test('DRY RUN (Branch E): health check, full test-mode cycle and recommendations, nothing real sent, messages logged', async (t) => {
  const storage = createMemoryStorage({ projectId: 'dry-run' });
  const whatsapp = createFakeWhatsAppClient();
  const report = await checkHealth({
    storage,
    whatsapp,
    ai: createFakeAiClient(),
    config: { healthCheck: { phone: '972500000000' } },
    now: () => new Date('2026-10-25T10:00:00Z'),
  });
  t.diagnostic(`health: ${JSON.stringify(report)}`);
  assert.equal(report.ok, true);

  const mode = createTestMode({
    storage,
    whatsapp,
    ai: createFakeAiClient([{ recommendations: [{ summary: 'dry-run recommendation', change: 'dry-run change', reason: 'dry-run note 1' }] }]),
    isWithinSendWindow: () => true,
    now: () => new Date('2026-10-25T10:00:00Z'),
    questions: QUESTIONS,
    closingText: CLOSING,
  });
  let outcome = await mode.endTrial(TRIAL);
  let n = 0;
  while (outcome.status === 'question_sent') {
    n += 1;
    outcome = await mode.handleAnswer({ trialId: 'trial-1', text: `dry-run note ${n}` });
  }
  for (const m of whatsapp.sent) t.diagnostic(`would send to ${m.to}: ${m.text}`);
  const notes = await mode.listImprovements('trial-1');
  t.diagnostic(`improvement records saved: ${notes.length}`);
  const recs = await mode.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'dry-run prompt' });
  for (const r of recs) t.diagnostic(`recommendation ${r.id} (${r.data.status}): ${r.data.summary}`);
  assert.equal(recs[0].data.status, 'pending_approval');

  assert.equal(outcome.status, 'closed');
  assert.equal(notes.length, QUESTIONS.length);
  assert.equal(whatsapp.sent.length, 1 + QUESTIONS.length + 1);
});

test('a screenshot is saved in storage with the current question and sends nothing', async () => {
  const { mode, whatsapp, storage } = build();
  await mode.endTrial(TRIAL);
  const { saved } = await mode.handleMedia({ trialId: 'trial-1', mediaType: 'image', mediaId: 'media-1', caption: 'see this' });
  const record = await storage.get('improvements', saved);
  assert.deepEqual(record.media, { type: 'image', id: 'media-1' });
  assert.equal(record.question, QUESTIONS[0]);
  assert.equal(record.answer, 'see this');
  assert.equal(whatsapp.sent.length, 1);

  // The screenshot does not count as the answer: the next text answers question 1.
  const next = await mode.handleAnswer({ trialId: 'trial-1', text: 'answer' });
  assert.equal(next.questionIndex, 1);
  assert.equal((await mode.listImprovements('trial-1')).length, 2);
});

test('a screenshot after the trial closed is still kept', async () => {
  const { mode } = build({ questions: QUESTIONS.slice(0, 4) });
  await mode.endTrial(TRIAL);
  for (let i = 0; i < 4; i += 1) await mode.handleAnswer({ trialId: 'trial-1', text: 'ok' });
  const { saved } = await mode.handleMedia({ trialId: 'trial-1', mediaType: 'image', mediaId: 'media-late' });
  assert.equal(saved, 'trial-1:5');
});

test('media without type or ID is an error', async () => {
  const { mode } = build();
  await mode.endTrial(TRIAL);
  await assert.rejects(() => mode.handleMedia({ trialId: 'trial-1', mediaType: 'image', mediaId: '' }), TestModeError);
});

// Recommendations: feedback and transcript lead to prompt recommendations that the
// project owner approves. Nothing changes the prompt automatically (Dedi, 2026-10-26).

async function closedTrial({ aiReplies = [] } = {}) {
  const storage = createMemoryStorage({ projectId: 'test-a' });
  const whatsapp = createFakeWhatsAppClient();
  const ai = createFakeAiClient(aiReplies);
  const mode = createTestMode({
    storage,
    whatsapp,
    ai,
    isWithinSendWindow: () => true,
    now: () => new Date('2026-10-25T10:00:00Z'),
    questions: QUESTIONS.slice(0, 4),
    closingText: CLOSING,
  });
  await storage.set('messages', 'conv-1:1', { role: 'user', text: 'How much is it?' });
  await storage.set('messages', 'conv-1:2', { role: 'assistant', text: 'It depends.' });
  await storage.set('messages', 'other:1', { role: 'user', text: 'not this trial' });
  await mode.endTrial(TRIAL);
  for (let i = 1; i <= 4; i += 1) await mode.handleAnswer({ trialId: 'trial-1', text: `note ${i}` });
  return { storage, ai, mode };
}

const REC = { summary: 'Give the price range', change: 'Add: state the price range when asked', reason: 'note 2' };

test('recommendations are built from the trial notes and transcript and saved as pending approval', async () => {
  const { ai, mode } = await closedTrial({ aiReplies: [{ recommendations: [REC] }] });
  const saved = await mode.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'You are a bot.' });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'trial-1:1');
  assert.equal(saved[0].data.status, 'pending_approval');
  assert.equal(saved[0].data.change, REC.change);

  const call = ai.calls[0];
  assert.equal(call.tool.name, 'propose_prompt_improvements');
  const content = call.messages[0].content;
  assert.match(content, /You are a bot\./);
  assert.match(content, /user: How much is it\?/);
  assert.match(content, /note 4/);
  assert.doesNotMatch(content, /not this trial/);
});

test('approving a recommendation changes only its status, never the prompt', async () => {
  const { mode, storage } = await closedTrial({ aiReplies: [{ recommendations: [REC, { ...REC, summary: 'second' }] }] });
  await mode.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'You are a bot.' });
  const approved = await mode.decideRecommendation({ id: 'trial-1:1', decision: 'approved', decidedBy: 'Dedi' });
  await mode.decideRecommendation({ id: 'trial-1:2', decision: 'rejected', decidedBy: 'Dedi' });

  assert.equal(approved.status, 'approved');
  assert.equal(approved.decidedBy, 'Dedi');
  assert.deepEqual((await mode.listRecommendations('trial-1')).map((r) => r.data.status), ['approved', 'rejected']);
  await assert.rejects(() => mode.decideRecommendation({ id: 'trial-1:1', decision: 'rejected', decidedBy: 'Dedi' }), /already approved/);
  assert.deepEqual((await storage.list('prompts')), []);
});

test('recommendations need a closed trial and an AI client', async () => {
  const { mode } = build();
  await mode.endTrial(TRIAL);
  await assert.rejects(() => mode.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'p' }), /AI client/);

  const storage = createMemoryStorage({ projectId: 'test-a' });
  const withAi = createTestMode({
    storage,
    whatsapp: createFakeWhatsAppClient(),
    ai: createFakeAiClient([{ recommendations: [] }]),
    isWithinSendWindow: () => true,
    now: () => new Date(),
    questions: QUESTIONS,
    closingText: CLOSING,
  });
  await withAi.endTrial(TRIAL);
  await assert.rejects(() => withAi.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'p' }), /not closed/);
});

test('an AI reply without a recommendations list is rejected and nothing is saved', async () => {
  const { mode } = await closedTrial({ aiReplies: [{ wrong: true }] });
  await assert.rejects(() => mode.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'p' }), TestModeError);
  assert.deepEqual(await mode.listRecommendations('trial-1'), []);
});

test('a decision must be approved or rejected, by a named person', async () => {
  const { mode } = await closedTrial({ aiReplies: [{ recommendations: [REC] }] });
  await mode.proposeRecommendations({ trialId: 'trial-1', currentPrompt: 'p' });
  await assert.rejects(() => mode.decideRecommendation({ id: 'trial-1:1', decision: 'auto', decidedBy: 'Dedi' }), TestModeError);
  await assert.rejects(() => mode.decideRecommendation({ id: 'trial-1:1', decision: 'approved', decidedBy: '' }), TestModeError);
});

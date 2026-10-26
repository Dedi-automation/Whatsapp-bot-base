'use strict';

// Test mode and feedback (spec section 9, Branch E).
//
// The agent holds a trial conversation with the bot (through B7). When the agent
// ends the trial, the bot asks 4 to 6 improvement questions, one at a time. Each
// answer is saved as an improvement record for the next version (T-10).
//
// - Questions and the closing text are per bot (decisions.md item 12), passed in as config.
// - The send window applies: nothing is sent outside it (decisions.md item 17).
//   A question that could not be sent stays pending and is sent by the next call
//   to endTrial or resume inside the window.
// - Answers are always saved, even outside the window. Notes are never dropped.
// - Screenshots and other media are saved in the database with the notes and are
//   shown to the agent in the dashboard (Dedi, 2026-10-26). B11 dashboard is postponed.
// - Recommendations: after a trial closes, the AI client reads that trial's notes and
//   transcript and proposes prompt changes. They are saved as pending and only the
//   project owner approves or rejects them. Nothing here edits a prompt (Dedi, 2026-10-26).
//   Only one trial's data is sent to the model, not the whole history (narrows F-23).
//
// Records:
// - 'test_sessions' / trialId: {conversationId, agentPhone, status, questionIndex, asked, ...}
// - 'improvements' / `${trialId}:${seq}`: one record per answer.
// - 'recommendations' / `${trialId}:${seq}`: one record per proposed prompt change.

const MIN_QUESTIONS = 4;
const MAX_QUESTIONS = 6;
const SESSIONS = 'test_sessions';
const IMPROVEMENTS = 'improvements';
const RECOMMENDATIONS = 'recommendations';
const TRANSCRIPT = 'messages';

/** Tool the AI client is forced to use when proposing recommendations. */
const RECOMMENDATION_TOOL = {
  name: 'propose_prompt_improvements',
  inputSchema: {
    type: 'object',
    required: ['recommendations'],
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['summary', 'change', 'reason'],
          properties: {
            summary: { type: 'string' },
            change: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

const DEFAULT_REVIEW_PROMPT = [
  'You review a trial conversation between an agent and their WhatsApp bot.',
  'You get the bot prompt, the trial transcript and the agent\'s feedback notes.',
  'Propose concrete changes to the bot prompt that address the feedback.',
  'Each recommendation has a short summary, the exact change, and the reason from the feedback.',
  'Do not invent prices, terms or claims. Propose no change when the feedback needs none.',
].join(' ');

class TestModeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestModeError';
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @typedef {'collecting' | 'closed'} SessionStatus
 *
 * @typedef {Object} TestSession
 * @property {string} conversationId
 * @property {string} agentPhone
 * @property {SessionStatus} status
 * @property {number} questionIndex   index of the current question; equals questions.length when only the closing text is left
 * @property {boolean} asked          true when the current question (or closing text) was sent
 * @property {number} answerCount
 * @property {string} endedAt
 * @property {string | null} closedAt
 *
 * @typedef {Object} TrialOutcome
 * @property {'question_sent' | 'closed' | 'outside_window' | 'waiting_for_answer' | 'already_closed'} status
 * @property {number} [questionIndex]
 */

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   whatsapp: import('./whatsapp').WhatsAppClient,
 *   isWithinSendWindow: (now: Date) => boolean,
 *   now: () => Date,
 *   questions: string[],
 *   closingText: string,
 *   ai?: import('./ai').AiClient,
 *   reviewPrompt?: string
 * }} deps
 *   `ai` is needed only for proposeRecommendations.
 * Errors: TestModeError when questions are not 4 to 6 non-empty strings or closingText is empty.
 */
function createTestMode(deps) {
  const { storage, whatsapp, isWithinSendWindow, now, questions, closingText, ai } = deps || {};
  const reviewPrompt = (deps && deps.reviewPrompt) || DEFAULT_REVIEW_PROMPT;
  if (!storage || !whatsapp || typeof isWithinSendWindow !== 'function' || typeof now !== 'function') {
    throw new TestModeError('storage, whatsapp, isWithinSendWindow and now are required');
  }
  if (!Array.isArray(questions) || questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
    throw new TestModeError(`test mode needs ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions`);
  }
  const empty = questions.map((q, i) => (isNonEmptyString(q) ? null : i)).filter((i) => i !== null);
  if (empty.length > 0) {
    throw new TestModeError(`questions must be non-empty text (empty at index ${empty.join(', ')})`);
  }
  if (!isNonEmptyString(closingText)) {
    throw new TestModeError('closingText is required');
  }

  const loadSession = async (trialId) => {
    const session = await storage.get(SESSIONS, trialId);
    if (!session) throw new TestModeError(`no test session ${trialId}`);
    return session;
  };

  // Sends the current question, or the closing text after the last one. Idempotent:
  // a question already sent is not sent again.
  const askNext = async (trialId, session) => {
    if (session.status === 'closed') return { status: 'already_closed' };
    if (session.asked) return { status: 'waiting_for_answer', questionIndex: session.questionIndex };
    if (!isWithinSendWindow(now())) return { status: 'outside_window', questionIndex: session.questionIndex };

    const last = session.questionIndex >= questions.length;
    const text = last ? closingText : questions[session.questionIndex];
    await whatsapp.sendText({ to: session.agentPhone, text });

    const next = last
      ? { ...session, asked: true, status: 'closed', closedAt: now().toISOString() }
      : { ...session, asked: true };
    await storage.set(SESSIONS, trialId, next);
    return last ? { status: 'closed' } : { status: 'question_sent', questionIndex: session.questionIndex };
  };

  // Saves one record under the next free sequence number, so two records that
  // arrive together never overwrite each other.
  const saveNext = async (collection, trialId, data) => {
    for (let seq = 1; ; seq += 1) {
      if (await storage.createIfAbsent(collection, `${trialId}:${seq}`, data)) return seq;
    }
  };
  const saveImprovement = (trialId, data) => saveNext(IMPROVEMENTS, trialId, data);

  const seqOf = (id) => Number(id.split(':').pop());
  const listForTrial = async (collection, trialId) => {
    const all = await storage.list(collection);
    return all.filter((r) => r.data.trialId === trialId).sort((a, b) => seqOf(a.id) - seqOf(b.id));
  };

  return {
    /**
     * Ends the trial conversation and starts the feedback questions.
     * Calling it again for the same trial resumes a pending question.
     * @param {{trialId: string, conversationId: string, agentPhone: string}} input
     * @returns {Promise<TrialOutcome>}
     */
    async endTrial({ trialId, conversationId, agentPhone }) {
      if (!isNonEmptyString(trialId) || !isNonEmptyString(conversationId) || !isNonEmptyString(agentPhone)) {
        throw new TestModeError('trialId, conversationId and agentPhone are required');
      }
      /** @type {TestSession} */
      const fresh = {
        conversationId,
        agentPhone,
        status: 'collecting',
        questionIndex: 0,
        asked: false,
        answerCount: 0,
        endedAt: now().toISOString(),
        closedAt: null,
      };
      await storage.createIfAbsent(SESSIONS, trialId, fresh);
      return askNext(trialId, await loadSession(trialId));
    },

    /**
     * Sends a question that is pending because it was outside the send window.
     * @param {string} trialId
     * @returns {Promise<TrialOutcome>}
     */
    async resume(trialId) {
      return askNext(trialId, await loadSession(trialId));
    },

    /**
     * Saves the agent's answer as an improvement record, then asks the next question.
     * An answer that arrives before the next question was sent is still saved, under
     * the last question that was sent.
     * @param {{trialId: string, text: string}} input
     * @returns {Promise<TrialOutcome & {saved: string}>}  saved = improvement record ID
     */
    async handleAnswer({ trialId, text }) {
      const session = await loadSession(trialId);
      if (session.status === 'closed') throw new TestModeError(`test session ${trialId} is closed`);

      const answered = session.asked ? session.questionIndex : session.questionIndex - 1;
      const seq = await saveImprovement(trialId, {
        trialId,
        conversationId: session.conversationId,
        agentPhone: session.agentPhone,
        questionIndex: answered >= 0 ? answered : null,
        question: answered >= 0 ? questions[answered] : null,
        answer: typeof text === 'string' ? text : '',
        status: 'open',
        createdAt: now().toISOString(),
      });

      const next = session.asked
        ? { ...session, questionIndex: session.questionIndex + 1, asked: false, answerCount: session.answerCount + 1 }
        : { ...session, answerCount: session.answerCount + 1 };
      await storage.set(SESSIONS, trialId, next);

      const outcome = await askNext(trialId, next);
      return { ...outcome, saved: `${trialId}:${seq}` };
    },

    /**
     * Saves a screenshot or other media the agent sends during feedback as an
     * improvement record, so it is kept in the database next to the notes and can
     * be shown in the agent's dashboard (Dedi, 2026-10-26). Only a reference is
     * stored here; downloading the file from WhatsApp is a B5 contract change.
     * Does not advance the questions and sends nothing.
     * @param {{trialId: string, mediaType: string, mediaId: string, caption?: string}} input
     * @returns {Promise<{saved: string}>}
     */
    async handleMedia({ trialId, mediaType, mediaId, caption }) {
      if (!isNonEmptyString(mediaType) || !isNonEmptyString(mediaId)) {
        throw new TestModeError('mediaType and mediaId are required');
      }
      const session = await loadSession(trialId);
      const current = session.asked ? session.questionIndex : session.questionIndex - 1;
      const answered = current >= 0 && current < questions.length ? current : null;
      const seq = await saveImprovement(trialId, {
        trialId,
        conversationId: session.conversationId,
        agentPhone: session.agentPhone,
        questionIndex: answered,
        question: answered === null ? null : questions[answered],
        answer: isNonEmptyString(caption) ? caption : '',
        media: { type: mediaType, id: mediaId },
        status: 'open',
        createdAt: now().toISOString(),
      });
      return { saved: `${trialId}:${seq}` };
    },

    /**
     * True while the trial is collecting feedback. The conversation engine uses this to
     * route the agent's messages here instead of to the AI (step 2 integration).
     * @param {string} trialId
     */
    async isCollectingFeedback(trialId) {
      const session = await storage.get(SESSIONS, trialId);
      return Boolean(session && session.status === 'collecting');
    },

    /**
     * All improvement records of one trial, in the order they were saved.
     * @param {string} trialId
     */
    async listImprovements(trialId) {
      return listForTrial(IMPROVEMENTS, trialId);
    },

    /**
     * Asks the AI client for prompt recommendations based on one closed trial: its
     * feedback notes and its transcript. Each recommendation is saved with status
     * 'pending_approval'. The prompt itself is never changed here.
     * @param {{trialId: string, currentPrompt: string}} input
     * @returns {Promise<Array<{id: string, data: Record<string, unknown>}>>} the saved recommendations
     * Errors: TestModeError when there is no AI client, the trial is not closed, or the
     * reply has no recommendations list. AI client errors are not swallowed.
     */
    async proposeRecommendations({ trialId, currentPrompt }) {
      if (!ai || typeof ai.reply !== 'function') throw new TestModeError('an AI client is required for recommendations');
      if (!isNonEmptyString(currentPrompt)) throw new TestModeError('currentPrompt is required');
      const session = await loadSession(trialId);
      if (session.status !== 'closed') throw new TestModeError(`test session ${trialId} is not closed yet`);

      const notes = await listForTrial(IMPROVEMENTS, trialId);
      const prefix = `${session.conversationId}:`;
      const transcript = (await storage.list(TRANSCRIPT))
        .filter((r) => r.id.startsWith(prefix))
        .sort((a, b) => seqOf(a.id) - seqOf(b.id));

      const content = [
        'BOT PROMPT:',
        currentPrompt,
        '',
        'TRANSCRIPT:',
        ...transcript.map((r) => `${r.data.role || r.data.direction || 'message'}: ${r.data.text ?? ''}`),
        '',
        'FEEDBACK NOTES:',
        ...notes.map((n) => `Q: ${n.data.question ?? '(none)'}\nA: ${n.data.answer}${n.data.media ? ` [${n.data.media.type} attached]` : ''}`),
      ].join('\n');

      const result = await ai.reply({
        systemPrompt: reviewPrompt,
        messages: [{ role: 'user', content }],
        tool: RECOMMENDATION_TOOL,
      });
      if (!result || !Array.isArray(result.recommendations)) {
        throw new TestModeError('AI reply has no recommendations list');
      }

      const saved = [];
      for (const rec of result.recommendations) {
        const data = {
          trialId,
          conversationId: session.conversationId,
          summary: String(rec.summary ?? ''),
          change: String(rec.change ?? ''),
          reason: String(rec.reason ?? ''),
          status: 'pending_approval',
          createdAt: now().toISOString(),
          decidedAt: null,
          decidedBy: null,
        };
        const seq = await saveNext(RECOMMENDATIONS, trialId, data);
        saved.push({ id: `${trialId}:${seq}`, data });
      }
      return saved;
    },

    /**
     * Records the project owner's decision on one recommendation. This only changes
     * its status; applying an approved change to the prompt is a manual step.
     * @param {{id: string, decision: 'approved' | 'rejected', decidedBy: string}} input
     */
    async decideRecommendation({ id, decision, decidedBy }) {
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new TestModeError("decision must be 'approved' or 'rejected'");
      }
      if (!isNonEmptyString(decidedBy)) throw new TestModeError('decidedBy is required');
      const rec = await storage.get(RECOMMENDATIONS, id);
      if (!rec) throw new TestModeError(`no recommendation ${id}`);
      if (rec.status !== 'pending_approval') throw new TestModeError(`recommendation ${id} is already ${rec.status}`);
      const next = { ...rec, status: decision, decidedAt: now().toISOString(), decidedBy };
      await storage.set(RECOMMENDATIONS, id, next);
      return next;
    },

    /**
     * All recommendations of one trial, in the order they were saved.
     * @param {string} trialId
     */
    async listRecommendations(trialId) {
      return listForTrial(RECOMMENDATIONS, trialId);
    },
  };
}

module.exports = { createTestMode, TestModeError, MIN_QUESTIONS, MAX_QUESTIONS, RECOMMENDATION_TOOL };

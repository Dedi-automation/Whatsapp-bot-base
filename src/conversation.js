'use strict';

// B7 Conversation engine (Branch B).
//
// Handles one incoming message:
// - duplicate message IDs are processed once (T-03, via B2 deduplicator)
// - the inbound message is saved as a transcript record before any reply (T-11)
// - non-text messages get a defined reply, not silence (T-17, F-20)
// - media types the bot accepts (per bot, e.g. an ID photo) are saved and get the
//   bot's acknowledgement; other media gets mediaRejectedReplyText, which names the
//   accepted types, so the customer knows what to send (owner decision 2026-10-26)
// - the reply is produced by the AI client and must pass its schema check (T-06)
// - outside the send window the message is saved and no reply is sent (B8)
// - handoff: the reply to the customer is sent first, then agent_action_required is set
//   on the conversation, then the optional onHandoff hook runs (stage 2: email to the
//   agent, B10). A failing hook is logged; the handoff stays recorded.
// - accepted media is downloaded and stored in 'media' under the transcript record ID,
//   so the agent sees it on the dashboard (decisions.md item 32). A failed or too large
//   download keeps the reference and the reason; the customer still gets the reply.
// - test mode (spec section 9, stage 2 wiring): a message from a tester phone that is
//   exactly the end keyword ends the trial and starts the feedback questions. While the
//   trial collects feedback, the tester's text goes to testMode.handleAnswer and media to
//   testMode.handleMedia, not to the AI. When the last answer closes the trial, the
//   optional onTrialClosed hook runs (stage 2: prompt recommendations + email).
//
// Transcript: one record per message in collection 'messages', ID `${conversationId}:${seq}`.
// Per-message records avoid the single-cell size problem (F-27).
// Conversation record: collection 'conversations', ID = the customer's WhatsApp number.
//
// Order for each message: duplicate check, save inbound, window check, reply.
// The reply from the AI is checked against the tool schema here too, so a bad
// reply is never sent even if the AI client let it through (T-06).

const { AiResponseError } = require('./errors');
const { MEDIA_TYPES } = require('./whatsapp');

const MESSAGES = 'messages';
const CONVERSATIONS = 'conversations';
const MEDIA = 'media';
// Firestore documents are limited to 1 MiB; base64 adds a third (same cap as test mode).
const MAX_MEDIA_BYTES = 700 * 1024;

/**
 * @typedef {Object} Outcome
 * @property {'replied' | 'handoff' | 'duplicate' | 'outside_window' | 'unsupported_reply' | 'media_received' | 'media_rejected' | 'test_trial_ended' | 'test_feedback'} status
 * @property {string} conversationId
 */

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   whatsapp: import('./whatsapp').WhatsAppClient,
 *   ai: import('./ai').AiClient,
 *   deduplicator: {markSeen: (id: string) => Promise<boolean>},
 *   isWithinSendWindow: (now: Date) => boolean,
 *   now: () => Date,
 *   unsupportedReplyText: string,
 *   acceptedMediaTypes?: string[],
 *   mediaReceivedReplyText?: string,
 *   mediaRejectedReplyText?: string,
 *   mediaTypeLabels?: Record<string, string>,
 *   systemPrompt: string,
 *   tool: import('./ai').ToolDefinition,
 *   onHandoff?: (input: {conversationId: string, reason: string | null}) => Promise<void>,
 *   testMode?: {
 *     phones: string[],
 *     endKeyword: string,
 *     module: ReturnType<typeof import('./test-mode').createTestMode>,
 *     onTrialClosed?: (trialId: string) => Promise<void>
 *   },
 *   log?: {info: (...args: unknown[]) => void, error: (...args: unknown[]) => void}
 * }} deps
 *   acceptedMediaTypes: media types this bot accepts, from 'image', 'audio', 'video',
 *   'document', 'sticker'. Default none. When the list is not empty, both texts are required:
 *   mediaReceivedReplyText for an accepted file, and mediaRejectedReplyText for any other
 *   media. mediaRejectedReplyText must contain {accepted}, which is filled with the
 *   accepted types, named by mediaTypeLabels (for example {image: 'תמונה'}) or by type.
 *   testMode.phones: WhatsApp numbers of testers (the agent, the owner), per bot.
 *   testMode.endKeyword: the exact text that ends a trial, per bot (for example 'סיום בדיקה').
 * @returns {{handleIncoming: (message: import('./whatsapp').IncomingMessage) => Promise<Outcome>}}
 */
function createConversationEngine(deps) {
  const { storage, whatsapp, ai, deduplicator, isWithinSendWindow, now, unsupportedReplyText, systemPrompt, tool } = deps;
  const { acceptedMediaTypes = [], mediaReceivedReplyText, mediaRejectedReplyText, mediaTypeLabels = {} } = deps;
  const { onHandoff, testMode, log = console } = deps;
  if (testMode) {
    if (!Array.isArray(testMode.phones) || testMode.phones.length === 0) throw new TypeError('testMode.phones is required');
    if (typeof testMode.endKeyword !== 'string' || testMode.endKeyword.trim() === '') throw new TypeError('testMode.endKeyword is required');
    if (!testMode.module || typeof testMode.module.endTrial !== 'function') throw new TypeError('testMode.module is required');
  }
  const testerPhones = new Set(testMode ? testMode.phones : []);
  if (typeof unsupportedReplyText !== 'string' || unsupportedReplyText.trim() === '') {
    throw new TypeError('unsupportedReplyText is required (T-17)');
  }
  const unknownTypes = acceptedMediaTypes.filter((type) => !MEDIA_TYPES.has(type));
  if (unknownTypes.length > 0) throw new TypeError(`acceptedMediaTypes has unknown types: ${unknownTypes.join(', ')}`);
  if (acceptedMediaTypes.length > 0 && (typeof mediaReceivedReplyText !== 'string' || mediaReceivedReplyText.trim() === '')) {
    throw new TypeError('mediaReceivedReplyText is required when acceptedMediaTypes is set');
  }
  if (acceptedMediaTypes.length > 0 && (typeof mediaRejectedReplyText !== 'string' || !mediaRejectedReplyText.includes('{accepted}'))) {
    throw new TypeError('mediaRejectedReplyText with {accepted} is required when acceptedMediaTypes is set');
  }
  const accepted = new Set(acceptedMediaTypes);
  const rejectedText = accepted.size > 0
    ? mediaRejectedReplyText.split('{accepted}').join(acceptedMediaTypes.map((type) => mediaTypeLabels[type] || type).join(', '))
    : null;

  /** Append one transcript record. createIfAbsent makes the sequence safe under concurrent writes. */
  async function appendMessage(conversationId, record) {
    const conversation = (await storage.get(CONVERSATIONS, conversationId)) || {};
    let seq = (Number.isInteger(conversation.messageCount) ? conversation.messageCount : 0) + 1;
    while (!(await storage.createIfAbsent(MESSAGES, `${conversationId}:${seq}`, { conversationId, seq, ...record }))) {
      seq += 1;
    }
    await updateConversation(conversationId, (current) => ({
      ...current,
      messageCount: Math.max(seq, Number.isInteger(current.messageCount) ? current.messageCount : 0),
      lastMessageAt: record.at,
    }));
    return seq;
  }

  async function updateConversation(conversationId, change) {
    const current = (await storage.get(CONVERSATIONS, conversationId)) || { customerPhone: conversationId };
    await storage.set(CONVERSATIONS, conversationId, change(current));
  }

  /** Transcript as AI messages, oldest first. Non-text entries are not sent to the model. */
  async function history(conversationId) {
    const messages = [];
    for (let seq = 1; ; seq += 1) {
      const record = await storage.get(MESSAGES, `${conversationId}:${seq}`);
      if (record === null) break;
      if (typeof record.text === 'string' && record.text !== '') {
        messages.push({ role: record.role, content: record.text });
      }
    }
    return messages;
  }

  /** Download an accepted file and store it next to its transcript record. Never throws. */
  async function storeMedia(conversationId, seq, media) {
    const id = `${conversationId}:${seq}`;
    const base = { conversationId, mediaId: media.id, createdAt: now().toISOString() };
    try {
      if (typeof whatsapp.downloadMedia !== 'function') throw new Error('WhatsApp client cannot download media');
      const { data, mimeType } = await whatsapp.downloadMedia({ mediaId: media.id });
      if (data.length > MAX_MEDIA_BYTES) {
        await storage.set(MEDIA, id, { ...base, stored: false, detail: `file is ${data.length} bytes, over the ${MAX_MEDIA_BYTES} byte limit` });
        return;
      }
      await storage.set(MEDIA, id, { ...base, stored: true, data: data.toString('base64'), mimeType: mimeType || media.mimeType || null, bytes: data.length });
    } catch (err) {
      log.error(`conversation: media not stored: ${err && err.name}`);
      try {
        await storage.set(MEDIA, id, { ...base, stored: false, detail: `download failed: ${err && err.message}` });
      } catch {
        // The transcript record keeps the reference either way.
      }
    }
  }

  /** Test mode routing for a tester's message. Returns an Outcome, or null when not a test-mode message. */
  async function routeTestMode(message, conversationId) {
    if (!testMode || !testerPhones.has(message.from)) return null;
    const tm = testMode.module;
    const conversation = (await storage.get(CONVERSATIONS, conversationId)) || {};
    const trialId = conversation.activeTrialId;

    if (trialId && (await tm.isCollectingFeedback(trialId))) {
      if (message.kind === 'text') {
        const outcome = await tm.handleAnswer({ trialId, text: message.text });
        if (outcome.status === 'closed') await trialClosed(conversationId, trialId);
      } else if (message.media) {
        await tm.handleMedia({ trialId, mediaType: message.mediaType, mediaId: message.media.id, mimeType: message.media.mimeType, caption: message.media.caption });
      } else {
        await tm.handleAnswer({ trialId, text: `[${message.mediaType || 'unsupported'}]` });
      }
      return { status: 'test_feedback', conversationId };
    }

    if (message.kind === 'text' && message.text.trim() === testMode.endKeyword.trim()) {
      const newTrialId = `${conversationId}-${now().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
      await updateConversation(conversationId, (current) => ({ ...current, activeTrialId: newTrialId }));
      const outcome = await tm.endTrial({ trialId: newTrialId, conversationId, agentPhone: message.from });
      if (outcome.status === 'closed') await trialClosed(conversationId, newTrialId);
      return { status: 'test_trial_ended', conversationId };
    }
    return null;
  }

  async function trialClosed(conversationId, trialId) {
    await updateConversation(conversationId, (current) => ({ ...current, activeTrialId: null, lastTrialId: trialId }));
    if (typeof testMode.onTrialClosed !== 'function') return;
    try {
      await testMode.onTrialClosed(trialId);
    } catch (err) {
      log.error(`conversation: onTrialClosed failed: ${err && err.name}: ${err && err.message}`);
    }
  }

  async function send(conversationId, to, text, extra = {}) {
    const { messageId } = await whatsapp.sendText({ to, text });
    await appendMessage(conversationId, { role: 'assistant', kind: 'text', text, messageId, at: now().toISOString(), ...extra });
  }

  return {
    async handleIncoming(message) {
      const conversationId = message.from;

      if (!(await deduplicator.markSeen(message.messageId))) {
        return { status: 'duplicate', conversationId };
      }

      const routed = await routeTestMode(message, conversationId);
      if (routed) return routed;

      const receivedAt = now();
      const seq = await appendMessage(conversationId, {
        role: 'user',
        kind: message.kind,
        text: message.kind === 'text' ? message.text : null,
        mediaType: message.kind === 'unsupported' ? message.mediaType : null,
        // Reference only; the file is fetched with whatsapp.downloadMedia (Branch E stores it).
        media: message.kind === 'unsupported' && message.media ? message.media : null,
        messageId: message.messageId,
        at: receivedAt.toISOString(),
      });

      // Accepted only with a media ID, so the file can be downloaded. Stored even
      // outside the send window: nothing is sent to the customer here.
      const isAccepted = message.kind !== 'text' && message.media && accepted.has(message.mediaType);
      if (isAccepted) await storeMedia(conversationId, seq, message.media);

      if (!isWithinSendWindow(receivedAt)) {
        return { status: 'outside_window', conversationId };
      }

      if (isAccepted) {
        await send(conversationId, message.from, mediaReceivedReplyText);
        return { status: 'media_received', conversationId };
      }

      if (message.kind !== 'text' && message.media && rejectedText) {
        await send(conversationId, message.from, rejectedText);
        return { status: 'media_rejected', conversationId };
      }

      if (message.kind !== 'text') {
        await send(conversationId, message.from, unsupportedReplyText);
        return { status: 'unsupported_reply', conversationId };
      }

      const reply = await ai.reply({ systemPrompt, messages: await history(conversationId), tool });
      checkToolInput(reply, tool);

      if (reply.handoff === true) {
        // The customer gets the reply (thanks) first, then the handoff to the agent
        // is recorded (owner decision, 2026-10-26). The handoff is recorded even if
        // the send fails, so the agent still sees the request.
        try {
          await send(conversationId, message.from, reply.text, { handoff: true });
        } finally {
          await updateConversation(conversationId, (current) => ({
            ...current,
            agent_action_required: true,
            handoff_reason: typeof reply.handoff_reason === 'string' ? reply.handoff_reason : null,
            handoffAt: now().toISOString(),
          }));
        }
        if (typeof onHandoff === 'function') {
          try {
            await onHandoff({ conversationId, reason: typeof reply.handoff_reason === 'string' ? reply.handoff_reason : null });
          } catch (err) {
            log.error(`conversation: onHandoff failed: ${err && err.name}: ${err && err.message}`);
          }
        }
        return { status: 'handoff', conversationId };
      }

      await send(conversationId, message.from, reply.text);
      return { status: 'replied', conversationId };
    },
  };
}

/**
 * Minimal check of the tool input: an object, every required field present,
 * declared property types respected, and a non-empty `text` to send.
 * Errors: AiResponseError.
 */
function checkToolInput(input, tool) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiResponseError('AI reply is not an object');
  }
  const schema = (tool && tool.inputSchema) || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((name) => input[name] === undefined || input[name] === null);
  if (missing.length > 0) throw new AiResponseError(`AI reply is missing required fields: ${missing.join(', ')}`);

  const properties = schema.properties || {};
  for (const [name, def] of Object.entries(properties)) {
    if (input[name] === undefined || !def || typeof def.type !== 'string') continue;
    const actual = Array.isArray(input[name]) ? 'array' : typeof input[name];
    const expected = def.type === 'integer' ? 'number' : def.type;
    if (actual !== expected) throw new AiResponseError(`AI reply field ${name} must be ${def.type}`);
  }

  if (typeof input.text !== 'string' || input.text.trim() === '') {
    throw new AiResponseError('AI reply has no text to send');
  }
}

module.exports = { createConversationEngine, MESSAGES, CONVERSATIONS, MEDIA, MAX_MEDIA_BYTES };

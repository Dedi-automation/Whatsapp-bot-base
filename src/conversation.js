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
//   on the conversation (B10 is postponed)
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

/**
 * @typedef {Object} Outcome
 * @property {'replied' | 'handoff' | 'duplicate' | 'outside_window' | 'unsupported_reply' | 'media_received' | 'media_rejected'} status
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
 *   tool: import('./ai').ToolDefinition
 * }} deps
 *   acceptedMediaTypes: media types this bot accepts, from 'image', 'audio', 'video',
 *   'document', 'sticker'. Default none. When the list is not empty, both texts are required:
 *   mediaReceivedReplyText for an accepted file, and mediaRejectedReplyText for any other
 *   media. mediaRejectedReplyText must contain {accepted}, which is filled with the
 *   accepted types, named by mediaTypeLabels (for example {image: 'תמונה'}) or by type.
 * @returns {{handleIncoming: (message: import('./whatsapp').IncomingMessage) => Promise<Outcome>}}
 */
function createConversationEngine(deps) {
  const { storage, whatsapp, ai, deduplicator, isWithinSendWindow, now, unsupportedReplyText, systemPrompt, tool } = deps;
  const { acceptedMediaTypes = [], mediaReceivedReplyText, mediaRejectedReplyText, mediaTypeLabels = {} } = deps;
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

      const receivedAt = now();
      await appendMessage(conversationId, {
        role: 'user',
        kind: message.kind,
        text: message.kind === 'text' ? message.text : null,
        mediaType: message.kind === 'unsupported' ? message.mediaType : null,
        // Reference only; the file is fetched with whatsapp.downloadMedia (Branch E stores it).
        media: message.kind === 'unsupported' && message.media ? message.media : null,
        messageId: message.messageId,
        at: receivedAt.toISOString(),
      });

      if (!isWithinSendWindow(receivedAt)) {
        return { status: 'outside_window', conversationId };
      }

      // Accepted only with a media ID, so the file can be downloaded later.
      if (message.kind !== 'text' && message.media && accepted.has(message.mediaType)) {
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

module.exports = { createConversationEngine, MESSAGES, CONVERSATIONS };

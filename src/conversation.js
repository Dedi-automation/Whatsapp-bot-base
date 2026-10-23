'use strict';

// B7 Conversation engine. Contract only (step 0). Logic comes in Branch B.
//
// Handles one incoming message:
// - duplicate message IDs are processed once (T-03, via B2 deduplicator)
// - the inbound message is saved as a transcript record before any reply (T-11)
// - non-text messages get a defined reply, not silence (T-17, F-20)
// - the reply is produced by the AI client and must pass its schema check (T-06)
// - outside the send window the message is saved and no reply is sent (B8)
// - handoff to the agent sets agent_action_required on the conversation (B10 is postponed)
//
// Transcript: one record per message in collection 'messages', ID `${conversationId}:${seq}`.
// Per-message records avoid the single-cell size problem (F-27).

const { NotImplementedError } = require('./errors');

/**
 * @typedef {Object} Outcome
 * @property {'replied' | 'handoff' | 'duplicate' | 'outside_window' | 'unsupported_reply'} status
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
 *   systemPrompt: string,
 *   tool: import('./ai').ToolDefinition
 * }} deps
 * @returns {{handleIncoming: (message: import('./whatsapp').IncomingMessage) => Promise<Outcome>}}
 */
function createConversationEngine(deps) {
  void deps;
  throw new NotImplementedError('createConversationEngine');
}

module.exports = { createConversationEngine };

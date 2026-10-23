'use strict';

// B5 WhatsApp client. Contract only (step 0). Logic comes in Branch B.
//
// Talks to the WhatsApp Cloud API. Base URL and version are a default that the
// caller may override (MyDoctor uses v21.0; to be confirmed when the client is built).
// Fake for tests: src/fakes/whatsapp-fake.js.

const { NotImplementedError } = require('./errors');

/**
 * Result of parsing one incoming webhook message.
 * - kind 'text': text is the message body.
 * - kind 'unsupported': voice note, image, sticker, etc. text is null. The
 *   conversation engine must still send a defined reply (T-17, F-20).
 *
 * @typedef {{kind: 'text', messageId: string, from: string, text: string}
 *         | {kind: 'unsupported', messageId: string, from: string, mediaType: string, text: null}} IncomingMessage
 *
 * @typedef {Object} WhatsAppClient
 * @property {(input: {to: string, text: string}) => Promise<{messageId: string}>} sendText
 * @property {(input: {to: string, templateName: string, language: string, params: string[]}) => Promise<{messageId: string}>} sendTemplate
 * @property {(payload: unknown) => IncomingMessage[]} parseIncoming
 *   Returns one entry per message in the payload. Status updates produce no entry.
 */

/**
 * @param {{
 *   token: string,
 *   phoneNumberId: string,
 *   fetch?: typeof fetch,
 *   baseUrl?: string
 * }} options
 * @returns {WhatsAppClient}
 * Errors: WhatsAppError with `.status` and `.code` (the Meta error code) on API failure.
 */
function createWhatsAppClient(options) {
  void options;
  throw new NotImplementedError('createWhatsAppClient');
}

module.exports = { createWhatsAppClient };

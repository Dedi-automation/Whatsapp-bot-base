'use strict';

// B5 WhatsApp client (Branch B).
//
// Talks to the WhatsApp Cloud API. Base URL and version are a default that the
// caller may override (v21.0, as in MyDoctor).
// Fake for tests: src/fakes/whatsapp-fake.js.

const { WhatsAppError } = require('./errors');

const DEFAULT_BASE_URL = 'https://graph.facebook.com/v21.0';

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
  const { token, phoneNumberId, fetch: fetchFn = globalThis.fetch, baseUrl = DEFAULT_BASE_URL } = options || {};
  if (!token || !phoneNumberId) throw new WhatsAppError('token and phoneNumberId are required');
  const messagesUrl = `${baseUrl.replace(/\/+$/, '')}/${phoneNumberId}/messages`;

  async function post(body) {
    let response;
    try {
      response = await fetchFn(messagesUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
      });
    } catch (err) {
      throw new WhatsAppError(`WhatsApp request failed: ${err.message}`);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Non-JSON body. Handled below.
    }

    if (!response.ok) {
      const apiError = (data && data.error) || {};
      throw new WhatsAppError(`WhatsApp API error ${response.status}: ${apiError.message || 'no details'}`, {
        status: response.status,
        code: apiError.code,
      });
    }
    const messageId = data && Array.isArray(data.messages) && data.messages[0] && data.messages[0].id;
    if (!messageId) throw new WhatsAppError('WhatsApp API response has no message ID', { status: response.status });
    return { messageId };
  }

  return {
    async sendText({ to, text }) {
      return post({ to, type: 'text', text: { body: text, preview_url: false } });
    },

    async sendTemplate({ to, templateName, language, params = [] }) {
      const template = { name: templateName, language: { code: language } };
      if (params.length > 0) {
        template.components = [{ type: 'body', parameters: params.map((value) => ({ type: 'text', text: String(value) })) }];
      }
      return post({ to, type: 'template', template });
    },

    parseIncoming(payload) {
      const result = [];
      const entries = payload && Array.isArray(payload.entry) ? payload.entry : [];
      for (const entry of entries) {
        const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
          const messages = change && change.value && Array.isArray(change.value.messages) ? change.value.messages : [];
          for (const message of messages) {
            const parsed = parseMessage(message);
            if (parsed) result.push(parsed);
          }
        }
      }
      return result;
    },
  };
}

/**
 * One Cloud API message object to an IncomingMessage. Button and list replies
 * carry the text the customer tapped, so they count as text. Every other type
 * is 'unsupported' and never an empty string (F-20).
 * @returns {IncomingMessage | null} null when the message has no ID or sender.
 */
function parseMessage(message) {
  if (!message || typeof message.id !== 'string' || typeof message.from !== 'string') return null;
  const base = { messageId: message.id, from: message.from };
  const text = textOf(message);
  if (typeof text === 'string' && text.trim() !== '') return { kind: 'text', ...base, text };
  return { kind: 'unsupported', ...base, mediaType: typeof message.type === 'string' ? message.type : 'unknown', text: null };
}

function textOf(message) {
  switch (message.type) {
    case 'text':
      return message.text && message.text.body;
    case 'button':
      return message.button && message.button.text;
    case 'interactive': {
      const reply = message.interactive && (message.interactive.button_reply || message.interactive.list_reply);
      return reply && reply.title;
    }
    default:
      return undefined;
  }
}

module.exports = { createWhatsAppClient };

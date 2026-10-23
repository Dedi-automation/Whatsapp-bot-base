'use strict';

// Fake for B5 WhatsApp client (step 0). Records outgoing messages in memory.
// It does not call the network. Failure injection via failNextWith.

const { WhatsAppError } = require('../errors');

/**
 * @returns {import('../whatsapp').WhatsAppClient & {sent: Array<object>, failNextWith: (err: WhatsAppError) => void}}
 */
function createFakeWhatsAppClient() {
  const sent = [];
  let nextError = null;
  let counter = 0;

  const record = (entry) => {
    if (nextError) {
      const err = nextError;
      nextError = null;
      throw err;
    }
    counter += 1;
    const messageId = `fake-msg-${counter}`;
    sent.push({ ...entry, messageId });
    return { messageId };
  };

  return {
    sent,
    failNextWith(err) {
      if (!(err instanceof WhatsAppError)) throw new TypeError('failNextWith needs a WhatsAppError');
      nextError = err;
    },
    async sendText(input) {
      return record({ type: 'text', ...input });
    },
    async sendTemplate(input) {
      return record({ type: 'template', ...input });
    },
    parseIncoming(payload) {
      // Fake returns whatever the test puts in payload.messages, unchanged.
      return Array.isArray(payload && payload.messages) ? payload.messages : [];
    },
  };
}

module.exports = { createFakeWhatsAppClient };

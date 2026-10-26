'use strict';

// Fake for B10 email client. Records outgoing emails in memory; nothing is sent.
// Used by tests and the dry run. Failure injection via failNextWith.

const { EmailError } = require('../errors');

/**
 * @returns {import('../email').EmailClient & {sent: Array<import('../email').EmailMessage>, failNextWith: (err: EmailError) => void}}
 */
function createFakeEmailClient() {
  const sent = [];
  let nextError = null;

  return {
    sent,
    failNextWith(err) {
      if (!(err instanceof EmailError)) throw new TypeError('failNextWith needs an EmailError');
      nextError = err;
    },
    async send(message) {
      if (nextError) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      sent.push({ ...message });
      return { accepted: true };
    },
  };
}

module.exports = { createFakeEmailClient };

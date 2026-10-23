'use strict';

// B2 Security. Contract only (step 0). Logic comes in Branch B.
//
// Covers: WhatsApp signature check (X-Hub-Signature-256), admin and job tokens
// sent in a header only (F-04, F-05, T-16), and duplicate message rejection (T-03).
// Header name for tokens: "Authorization: Bearer <token>" is a proposal (spec 12/13).

const { NotImplementedError } = require('./errors');

/**
 * Verify X-Hub-Signature-256 over the raw request body.
 * Must use a constant-time comparison (F-14 context, spec section 4).
 *
 * @param {{rawBody: Buffer, signatureHeader: string | undefined, appSecret: string}} input
 * @returns {boolean} false for a missing header, a bad prefix or a bad digest. Never throws for bad input.
 */
function verifyWhatsAppSignature(input) {
  void input;
  throw new NotImplementedError('verifyWhatsAppSignature');
}

/**
 * Check an admin or job token. The token must be in the Authorization header.
 * A request whose URL carries the token in the query string is rejected, even if
 * the header is also correct (T-16, F-04).
 *
 * @param {{url: string, headers: Record<string, string | undefined>, expected: string}} input
 * @returns {boolean}
 */
function checkBearerToken(input) {
  void input;
  throw new NotImplementedError('checkBearerToken');
}

/**
 * Duplicate message rejection (T-03). Atomic: two concurrent calls with the same
 * messageId must return true to exactly one caller.
 *
 * @param {{storage: import('./storage').Storage}} deps  Uses storage.createIfAbsent.
 * @returns {{markSeen: (messageId: string) => Promise<boolean>}}
 *   markSeen resolves true on the first call for an id, false afterwards.
 */
function createDeduplicator(deps) {
  void deps;
  throw new NotImplementedError('createDeduplicator');
}

module.exports = { verifyWhatsAppSignature, checkBearerToken, createDeduplicator };

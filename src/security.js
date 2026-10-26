'use strict';

// B2 Security (Branch B).
//
// Covers: WhatsApp signature check (X-Hub-Signature-256), admin and job tokens
// sent in a header only (F-04, F-05, T-16), and duplicate message rejection (T-03).
// Header name for tokens: "Authorization: Bearer <token>" is a proposal (spec 12/13).

const crypto = require('node:crypto');

const SIGNATURE_PREFIX = 'sha256=';
const SEEN_COLLECTION = 'processed_messages';

/** Constant-time string comparison. Hashing first makes both sides the same length. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Verify X-Hub-Signature-256 over the raw request body.
 * Must use a constant-time comparison (F-14 context, spec section 4).
 *
 * @param {{rawBody: Buffer, signatureHeader: string | undefined, appSecret: string}} input
 * @returns {boolean} false for a missing header, a bad prefix or a bad digest. Never throws for bad input.
 */
function verifyWhatsAppSignature(input) {
  const { rawBody, signatureHeader, appSecret } = input || {};
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  if (typeof appSecret !== 'string' || appSecret === '') return false;
  if (!Buffer.isBuffer(rawBody)) return false;

  const received = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(received, 'hex'));
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
  const { url, headers, expected } = input || {};
  if (typeof expected !== 'string' || expected === '') return false;

  // A token anywhere in the URL (path or query) may already have leaked into
  // logs, so the request is refused even when the header is right (F-04).
  const rawUrl = typeof url === 'string' ? url : '';
  let decodedUrl = rawUrl;
  try {
    decodedUrl = decodeURIComponent(rawUrl);
  } catch {
    // Malformed escapes: keep the raw URL for the check below.
  }
  if (rawUrl.includes(expected) || decodedUrl.includes(expected)) return false;

  const header = headerValue(headers, 'authorization');
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return false;
  return safeEqual(match[1], expected);
}

/** Case-insensitive header lookup. Node lowercases names, other callers may not. */
function headerValue(headers, name) {
  if (!headers) return undefined;
  if (headers[name] !== undefined) return headers[name];
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
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
  const { storage } = deps;
  return {
    async markSeen(messageId) {
      if (typeof messageId !== 'string' || messageId === '') {
        throw new TypeError('markSeen needs a non-empty message ID');
      }
      return storage.createIfAbsent(SEEN_COLLECTION, messageId, { seenAt: new Date().toISOString() });
    },
  };
}

module.exports = { verifyWhatsAppSignature, checkBearerToken, createDeduplicator, SEEN_COLLECTION };

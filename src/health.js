'use strict';

// B12 Health check (Branch E).
//
// Checks storage and the external services. Numbers come from config, not from code (F-17).
// Every check runs on its own. A failing or hanging dependency is reported in `checks`,
// it never throws and never stops the other checks.

const PROBE_COLLECTION = 'health_checks';
const PROBE_ID = 'probe';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @typedef {Object} HealthReport
 * @property {boolean} ok                      true only when every check passed
 * @property {Record<string, {ok: boolean, detail?: string}>} checks
 */

/**
 * Storage: write a probe record, read it back, delete it.
 * @param {import('./storage').Storage} storage
 * @param {() => Date} now
 */
async function checkStorage(storage, now) {
  const stamp = now().toISOString();
  await storage.set(PROBE_COLLECTION, PROBE_ID, { checkedAt: stamp });
  const read = await storage.get(PROBE_COLLECTION, PROBE_ID);
  if (!read || read.checkedAt !== stamp) {
    return { ok: false, detail: 'probe record was not read back' };
  }
  await storage.delete(PROBE_COLLECTION, PROBE_ID);
  return { ok: true };
}

/**
 * WhatsApp: send a text to the health-check phone from config (F-17).
 * @param {import('./whatsapp').WhatsAppClient} whatsapp
 * @param {string | undefined} phone
 * @param {() => Date} now
 */
async function checkWhatsApp(whatsapp, phone, now) {
  if (typeof phone !== 'string' || phone.trim() === '') {
    return { ok: false, detail: 'HEALTH_CHECK_PHONE is not set' };
  }
  const { messageId } = await whatsapp.sendText({ to: phone, text: `Health check ${now().toISOString()}` });
  return { ok: true, detail: `sent ${messageId}` };
}

/**
 * AI: the client is present and callable. No model call, so a health check costs no tokens.
 * A live model call is checked in step 2 integration.
 * @param {import('./ai').AiClient} ai
 */
async function checkAi(ai) {
  if (!ai || typeof ai.reply !== 'function') {
    return { ok: false, detail: 'AI client is not configured' };
  }
  return { ok: true, detail: 'client configured, no live call' };
}

/**
 * Runs one check with a timeout. Any throw or rejection becomes {ok: false}.
 * @param {() => Promise<{ok: boolean, detail?: string}>} run
 * @param {number} timeoutMs
 */
async function guarded(run, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: `timed out after ${timeoutMs} ms` }), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } catch (err) {
    return { ok: false, detail: err && err.message ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   whatsapp: import('./whatsapp').WhatsAppClient,
 *   ai: import('./ai').AiClient,
 *   config: {healthCheck: {phone: string | undefined}},
 *   now?: () => Date,
 *   timeoutMs?: number
 * }} deps
 * @returns {Promise<HealthReport>}
 * A failing dependency is reported in `checks`, it does not throw.
 */
async function checkHealth(deps) {
  const { storage, whatsapp, ai, config } = deps || {};
  const now = (deps && deps.now) || (() => new Date());
  const timeoutMs = (deps && deps.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const phone = config && config.healthCheck ? config.healthCheck.phone : undefined;

  const [storageCheck, whatsappCheck, aiCheck] = await Promise.all([
    guarded(() => checkStorage(storage, now), timeoutMs),
    guarded(() => checkWhatsApp(whatsapp, phone, now), timeoutMs),
    guarded(() => checkAi(ai), timeoutMs),
  ]);

  const checks = { storage: storageCheck, whatsapp: whatsappCheck, ai: aiCheck };
  const ok = Object.values(checks).every((c) => c.ok === true);
  return { ok, checks };
}

module.exports = { checkHealth };

'use strict';

// B12 Health check (Branch E).
//
// Checks storage and the external services. Numbers come from config, not from code (F-17).
// Every check runs on its own. A failing or hanging dependency is reported in `checks`,
// it never throws and never stops the other checks.
//
// Every run sends a real WhatsApp message with the result to the health-check phone
// (now the owner's test number; in production the clerk's or client's number). When any
// check fails, a copy of the problem also goes to the alert phone, so the owner always
// hears about a problem at once (Dedi, 2026-10-26). Both numbers come from config.
// The send window does not apply here: the owner gets alerts on any day and hour
// (Dedi, 2026-10-26). Recipients and timing for a client's bot are set per client at go-live.

const PROBE_COLLECTION = 'health_checks';
const PROBE_ID = 'probe';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @typedef {Object} HealthReport
 * @property {boolean} ok                      true only when every check passed
 * @property {Record<string, {ok: boolean, detail?: string}>} checks
 * @property {{sent: boolean, to?: string, detail?: string} | null} alert
 *   the copy sent to the alert phone; null when every check passed
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

const isPhone = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Result text sent on every run. Names each failed check and its detail.
 * @param {Record<string, {ok: boolean, detail?: string}>} checks
 * @param {string} stamp
 */
function resultText(checks, stamp) {
  const failed = Object.entries(checks).filter(([, c]) => !c.ok);
  if (failed.length === 0) return `Health check OK ${stamp}`;
  const list = failed.map(([name, c]) => `${name}: ${c.detail || 'failed'}`).join('; ');
  return `Health check FAILED ${stamp}. ${list}`;
}

/**
 * WhatsApp: send the result of the other checks to the health-check phone from config (F-17).
 * A successful send is itself the WhatsApp check.
 * @param {import('./whatsapp').WhatsAppClient} whatsapp
 * @param {string | undefined} phone
 * @param {string} text
 */
async function checkWhatsApp(whatsapp, phone, text) {
  if (!isPhone(phone)) {
    return { ok: false, detail: 'HEALTH_CHECK_PHONE is not set' };
  }
  const { messageId } = await whatsapp.sendText({ to: phone, text });
  return { ok: true, detail: `sent ${messageId}` };
}

/**
 * Sends a copy of a failed result to the alert phone. Skipped when the alert phone is
 * the health-check phone and the result already reached it.
 * @returns {Promise<{sent: boolean, to?: string, detail?: string}>}
 */
async function sendAlert(whatsapp, alertPhone, phone, whatsappOk, text, timeoutMs) {
  if (!isPhone(alertPhone)) return { sent: false, detail: 'HEALTH_CHECK_ALERT_PHONE is not set' };
  if (alertPhone === phone && whatsappOk) return { sent: false, to: alertPhone, detail: 'result already sent to this number' };
  const result = await guarded(async () => {
    const { messageId } = await whatsapp.sendText({ to: alertPhone, text });
    return { ok: true, detail: `sent ${messageId}` };
  }, timeoutMs);
  return { sent: result.ok, to: alertPhone, detail: result.detail };
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
 *   config: {healthCheck: {phone: string | undefined, alertPhone?: string | undefined}},
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
  const healthConfig = (config && config.healthCheck) || {};
  const { phone, alertPhone } = healthConfig;
  const stamp = () => now().toISOString();

  const [storageCheck, aiCheck] = await Promise.all([
    guarded(() => checkStorage(storage, now), timeoutMs),
    guarded(() => checkAi(ai), timeoutMs),
  ]);
  const whatsappCheck = await guarded(
    () => checkWhatsApp(whatsapp, phone, resultText({ storage: storageCheck, ai: aiCheck }, stamp())),
    timeoutMs,
  );

  const checks = { storage: storageCheck, whatsapp: whatsappCheck, ai: aiCheck };
  const ok = Object.values(checks).every((c) => c.ok === true);
  const alert = ok
    ? null
    : await sendAlert(whatsapp, alertPhone, phone, whatsappCheck.ok, resultText(checks, stamp()), timeoutMs);
  return { ok, checks, alert };
}

module.exports = { checkHealth };

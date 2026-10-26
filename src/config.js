'use strict';

// B1 Config (Branch B).
//
// Required variables: missing any of them is a startup error (ConfigError),
// never a silent start (F-14, T-01, T-13).
// Variable names follow spec.md Appendix A. FIRESTORE_PROJECT_ID is a proposal
// (decisions.md, Open). AI_MODEL is a proposal; its value is TO VERIFY.

const { ConfigError } = require('./errors');
const { EVENTS: NOTIFY_EVENTS } = require('./notify');

const DEFAULT_PORT = 8080;

/** Email (B10) is optional; when any of these is set, all of them are required. */
const EMAIL_ENV = Object.freeze(['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL', 'NOTIFY_EMAIL']);

/** @type {readonly string[]} */
const REQUIRED_ENV = Object.freeze([
  'ANTHROPIC_API_KEY',
  'AI_MODEL',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'FIRESTORE_PROJECT_ID',
  'ADMIN_TOKEN',
  'SCHEDULED_JOB_TOKEN',
  'APP_BASE_URL',
]);

/**
 * @typedef {Object} Config
 * @property {string} anthropicApiKey
 * @property {string} aiModel
 * @property {string} whatsappToken
 * @property {string} whatsappPhoneNumberId
 * @property {string} whatsappAppSecret
 * @property {string} whatsappVerifyToken
 * @property {string} firestoreProjectId
 * @property {string} adminToken
 * @property {string} scheduledJobToken
 * @property {string} appBaseUrl
 * @property {number} port                 PORT, optional (default 8080). Invalid value: ConfigError
 * @property {{phone: string|undefined, alertPhone: string|undefined}} healthCheck
 *   HEALTH_CHECK_PHONE: recipient of the health check message, optional (F-17).
 *   HEALTH_CHECK_ALERT_PHONE: gets a copy of every failed check (owner decision 2026-10-26), optional.
 * @property {{apiKey: string, from: string, notifyTo: string} | null} email
 *   B10. SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, NOTIFY_EMAIL: all three or none.
 *   null when none is set (the bot sends no email). Some but not all: ConfigError.
 * @property {{phone: string, events: string[], template: {name: string, language: string} | null} | null} agentWhatsApp
 *   WhatsApp notifications to the agent, optional (Dedi, 2026-10-26: email by default,
 *   WhatsApp when asked). AGENT_WHATSAPP_PHONE turns it on. AGENT_WHATSAPP_EVENTS is a
 *   comma list of handoff, daily_summary, monthly_summary, recommendation (default: all of them).
 *   AGENT_WHATSAPP_TEMPLATE (+ AGENT_WHATSAPP_TEMPLATE_LANGUAGE, default 'he') sends a
 *   Meta-approved template, needed outside a 24-hour conversation. Events or template
 *   without a phone, or an unknown event: ConfigError.
 */

/**
 * Load and validate configuration.
 *
 * Errors:
 * - ConfigError (`.missing` lists every missing required name, not only the first).
 *   The message must not contain any variable value.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
function loadConfig(env = process.env) {
  // An empty or whitespace-only value counts as missing. Values are never trimmed
  // or printed: they may be secrets.
  const isSet = (name) => typeof env[name] === 'string' && env[name].trim() !== '';
  const optional = (name) => (isSet(name) ? env[name] : undefined);
  const missing = REQUIRED_ENV.filter((name) => !isSet(name));
  if (missing.length > 0) throw new ConfigError(missing);

  let port = DEFAULT_PORT;
  if (isSet('PORT')) {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const err = new ConfigError(['PORT']);
      err.message = 'Invalid environment variable: PORT must be an integer from 1 to 65535';
      throw err;
    }
  }

  const emailSet = EMAIL_ENV.filter(isSet);
  if (emailSet.length > 0 && emailSet.length < EMAIL_ENV.length) {
    const missingEmail = EMAIL_ENV.filter((name) => !isSet(name));
    const err = new ConfigError(missingEmail);
    err.message = `Email needs all of ${EMAIL_ENV.join(', ')}; missing: ${missingEmail.join(', ')}`;
    throw err;
  }
  const email =
    emailSet.length === EMAIL_ENV.length
      ? Object.freeze({ apiKey: env.SENDGRID_API_KEY, from: env.SENDGRID_FROM_EMAIL, notifyTo: env.NOTIFY_EMAIL })
      : null;

  let agentWhatsApp = null;
  const listed = isSet('AGENT_WHATSAPP_EVENTS')
    ? env.AGENT_WHATSAPP_EVENTS.split(',').map((e) => e.trim()).filter((e) => e !== '')
    : null;
  if (isSet('AGENT_WHATSAPP_PHONE')) {
    const unknown = (listed || []).filter((e) => !NOTIFY_EVENTS.includes(e));
    if (unknown.length > 0) {
      const err = new ConfigError(['AGENT_WHATSAPP_EVENTS']);
      err.message = `AGENT_WHATSAPP_EVENTS has unknown events: ${unknown.join(', ')} (known: ${NOTIFY_EVENTS.join(', ')})`;
      throw err;
    }
    agentWhatsApp = Object.freeze({
      phone: env.AGENT_WHATSAPP_PHONE,
      events: Object.freeze(listed || [...NOTIFY_EVENTS]),
      template: isSet('AGENT_WHATSAPP_TEMPLATE')
        ? Object.freeze({ name: env.AGENT_WHATSAPP_TEMPLATE, language: optional('AGENT_WHATSAPP_TEMPLATE_LANGUAGE') || 'he' })
        : null,
    });
  } else if (listed || isSet('AGENT_WHATSAPP_TEMPLATE')) {
    const err = new ConfigError(['AGENT_WHATSAPP_PHONE']);
    err.message = 'AGENT_WHATSAPP_EVENTS or AGENT_WHATSAPP_TEMPLATE is set, but AGENT_WHATSAPP_PHONE is missing';
    throw err;
  }

  return Object.freeze({
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    aiModel: env.AI_MODEL,
    whatsappToken: env.WHATSAPP_TOKEN,
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappAppSecret: env.WHATSAPP_APP_SECRET,
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN,
    firestoreProjectId: env.FIRESTORE_PROJECT_ID,
    adminToken: env.ADMIN_TOKEN,
    scheduledJobToken: env.SCHEDULED_JOB_TOKEN,
    appBaseUrl: env.APP_BASE_URL,
    port,
    healthCheck: Object.freeze({
      phone: optional('HEALTH_CHECK_PHONE'),
      alertPhone: optional('HEALTH_CHECK_ALERT_PHONE'),
    }),
    email,
    agentWhatsApp,
  });
}

module.exports = { loadConfig, REQUIRED_ENV, EMAIL_ENV };

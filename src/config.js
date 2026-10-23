'use strict';

// B1 Config. Contract only (step 0). Logic comes in Branch B.
//
// Required variables: missing any of them is a startup error (ConfigError),
// never a silent start (F-14, T-01, T-13).
// Variable names follow spec.md Appendix A. FIRESTORE_PROJECT_ID is a proposal
// (decisions.md, Open). AI_MODEL is a proposal; its value is TO VERIFY.

const { NotImplementedError } = require('./errors');

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
 * @property {number} port                 PORT, optional
 * @property {{phone: string|undefined}} healthCheck  HEALTH_CHECK_PHONE, optional (F-17)
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
  void env;
  throw new NotImplementedError('loadConfig');
}

module.exports = { loadConfig, REQUIRED_ENV };

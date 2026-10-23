'use strict';

// B12 Health check. Contract only (step 0). Logic comes in Branch E.
//
// Checks storage and the external services. Numbers come from config, not from code (F-17).

const { NotImplementedError } = require('./errors');

/**
 * @typedef {Object} HealthReport
 * @property {boolean} ok                      true only when every check passed
 * @property {Record<string, {ok: boolean, detail?: string}>} checks
 */

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   whatsapp: import('./whatsapp').WhatsAppClient,
 *   ai: import('./ai').AiClient,
 *   config: {healthCheck: {phone: string | undefined}}
 * }} deps
 * @returns {Promise<HealthReport>}
 * A failing dependency is reported in `checks`, it does not throw.
 */
function checkHealth(deps) {
  void deps;
  throw new NotImplementedError('checkHealth');
}

module.exports = { checkHealth };

'use strict';

// B9 Scheduled jobs. Contract only (step 0). Logic comes in Branch D.
//
// - A job run is identified by (jobName, runKey). Two runs with the same key
//   execute the action once (T-08, F-06). Locking uses storage.createIfAbsent.
// - Reminders read every record of the collection, not one agent tab (F-15).
// - Dates are DD/MM/YYYY, parsed explicitly, never with new Date (F-16).

const { NotImplementedError } = require('./errors');

/**
 * @typedef {Object} JobResult
 * @property {'ran' | 'already_done'} status
 */

/**
 * @param {{storage: import('./storage').Storage, now: () => Date}} deps
 * @returns {{
 *   runOnce: (jobName: string, runKey: string, action: () => Promise<void>) => Promise<JobResult>,
 *   findDueReminders: (input: {collection: string, today: Date}) => Promise<Array<{id: string, data: object}>>
 * }}
 */
function createJobRunner(deps) {
  void deps;
  throw new NotImplementedError('createJobRunner');
}

/**
 * Parse a DD/MM/YYYY string as a calendar date (local midnight of that date).
 * Errors: SchemaError for malformed input or a date that does not exist (e.g. 31/02/2026).
 *
 * @param {string} text
 * @returns {Date}
 */
function parseDdMmYyyy(text) {
  void text;
  throw new NotImplementedError('parseDdMmYyyy');
}

module.exports = { createJobRunner, parseDdMmYyyy };

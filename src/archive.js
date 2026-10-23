'use strict';

// B13 Archive (optional). Contract only (step 0). Logic comes in Branch D.
//
// Moves old records from a collection to an archive collection (F-17).
// The start date and the list of eligible statuses come from config, not code.
// Values are TO VERIFY against MyDoctor archive.js before the config is written.

const { NotImplementedError } = require('./errors');

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   now: () => Date,
 *   config: {archive: {startDate: string, eligibleStatuses: string[]}}
 * }} deps
 *   config.archive.startDate: 'YYYY-MM-DD'. Records created before it are not archived.
 * @returns {{archiveOldRecords: (collection: string, archiveCollection: string) => Promise<{moved: number}>}}
 */
function createArchiver(deps) {
  void deps;
  throw new NotImplementedError('createArchiver');
}

module.exports = { createArchiver };

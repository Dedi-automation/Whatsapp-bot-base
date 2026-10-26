'use strict';

// B13 Archive (optional).
//
// Moves old records from a collection to an archive collection (F-17).
// The start date and the list of eligible statuses come from config, not code
// (decisions.md, item 19: archive rules are set per bot; the base keeps
// placeholder config only). config.archive.startDate is the bot's go-live
// (production) date, set in config when the bot launches (Dedi, 2026-10-26).
//
// A record is moved when its status is in config.archive.eligibleStatuses and
// its createdAt date (YYYY-MM-DD, or an ISO timestamp starting with it) is before
// config.archive.startDate. A record with no readable createdAt stays in place.
// The move writes the archive copy first and then deletes the original, so a
// crash between the two steps leaves a duplicate, never a lost record, and the
// next run finishes the move.

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   now: () => Date,
 *   config: {archive: {startDate: string, eligibleStatuses: string[]}}
 * }} deps
 *   config.archive.startDate: 'YYYY-MM-DD', the go-live date. Records created on or after it are not archived.
 * @returns {{archiveOldRecords: (collection: string, archiveCollection: string) => Promise<{moved: number}>}}
 */
function createArchiver(deps) {
  const { storage, config } = deps || {};
  if (!storage) throw new TypeError('createArchiver: storage is required');
  const archive = config && config.archive;
  if (!archive || typeof archive.startDate !== 'string' || !DATE_ONLY.test(archive.startDate)) {
    throw new TypeError('createArchiver: config.archive.startDate must be YYYY-MM-DD');
  }
  if (!Array.isArray(archive.eligibleStatuses) || archive.eligibleStatuses.length === 0) {
    throw new TypeError('createArchiver: config.archive.eligibleStatuses must be a non-empty list');
  }
  const startDate = archive.startDate;
  const eligible = new Set(archive.eligibleStatuses);

  function isEligible(data) {
    if (!data || !eligible.has(data.status)) return false;
    const match = typeof data.createdAt === 'string' ? DATE_PREFIX.exec(data.createdAt) : null;
    if (!match) return false;
    // YYYY-MM-DD strings compare correctly as text.
    return match[1] < startDate;
  }

  async function archiveOldRecords(collection, archiveCollection) {
    if (typeof collection !== 'string' || collection === '') {
      throw new TypeError('archiveOldRecords: collection is required');
    }
    if (typeof archiveCollection !== 'string' || archiveCollection === '' || archiveCollection === collection) {
      throw new TypeError('archiveOldRecords: archiveCollection is required and must differ from collection');
    }
    let moved = 0;
    for (const { id, data } of await storage.list(collection)) {
      if (!isEligible(data)) continue;
      await storage.set(archiveCollection, id, data);
      await storage.delete(collection, id);
      moved += 1;
    }
    return { moved };
  }

  return { archiveOldRecords };
}

module.exports = { createArchiver };

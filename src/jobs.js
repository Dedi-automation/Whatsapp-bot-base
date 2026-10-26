'use strict';

// B9 Scheduled jobs.
//
// - A job run is identified by (jobName, runKey). Two runs with the same key
//   execute the action once (T-08, F-06). Locking uses storage.createIfAbsent.
//   If the action throws, the lock is released so a retry can run, and the error
//   is rethrown. For a strict one-message-per-customer guarantee, give each
//   message its own runKey (for example `reminder-<recordId>-<date>`).
// - Reminders read every record of the collection, not one agent tab (F-15).
// - Dates are DD/MM/YYYY, parsed explicitly, never with new Date (F-16).

const { SchemaError } = require('./errors');
const { wallClock } = require('./schedule-window');

const DEFAULT_LOCK_COLLECTION = 'job_runs';
const DEFAULT_DATE_FIELD = 'callbackDate';
const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';
const DD_MM_YYYY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * @typedef {Object} JobResult
 * @property {'ran' | 'already_done'} status
 */

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   now: () => Date,
 *   lockCollection?: string,
 *   timeZone?: string,
 * }} deps
 *   lockCollection defaults to 'job_runs'. timeZone (for "today") defaults to 'Asia/Jerusalem'.
 * @returns {{
 *   runOnce: (jobName: string, runKey: string, action: () => Promise<void>) => Promise<JobResult>,
 *   findDueReminders: (input: {collection: string, today: Date, dateField?: string}) => Promise<Array<{id: string, data: object}>>
 * }}
 */
function createJobRunner(deps) {
  const { storage, now, lockCollection = DEFAULT_LOCK_COLLECTION, timeZone = DEFAULT_TIME_ZONE } = deps || {};
  if (!storage || typeof storage.createIfAbsent !== 'function') {
    throw new TypeError('createJobRunner: storage with createIfAbsent is required');
  }
  if (typeof now !== 'function') throw new TypeError('createJobRunner: now() is required');

  async function runOnce(jobName, runKey, action) {
    if (typeof jobName !== 'string' || jobName === '') throw new TypeError('runOnce: jobName is required');
    if (typeof runKey !== 'string' || runKey === '') throw new TypeError('runOnce: runKey is required');
    if (typeof action !== 'function') throw new TypeError('runOnce: action must be a function');

    const lockId = `${jobName}:${runKey}`;
    const acquired = await storage.createIfAbsent(lockCollection, lockId, {
      jobName,
      runKey,
      status: 'running',
      startedAt: now().toISOString(),
    });
    if (!acquired) return { status: 'already_done' };

    try {
      await action();
    } catch (err) {
      await storage.delete(lockCollection, lockId);
      throw err;
    }
    await storage.set(lockCollection, lockId, {
      jobName,
      runKey,
      status: 'done',
      finishedAt: now().toISOString(),
    });
    return { status: 'ran' };
  }

  // A record is due when its date field is today's date in Israel time.
  // Records with an empty date field are skipped. A malformed date is a
  // SchemaError naming the record, never a silent shift (F-16).
  async function findDueReminders(input) {
    const { collection, today, dateField = DEFAULT_DATE_FIELD } = input || {};
    if (typeof collection !== 'string' || collection === '') {
      throw new TypeError('findDueReminders: collection is required');
    }
    if (!(today instanceof Date) || Number.isNaN(today.getTime())) {
      throw new TypeError('findDueReminders: today must be a valid Date');
    }
    const todayKey = wallClock(today, timeZone).date;

    const records = await storage.list(collection);
    const due = [];
    for (const record of records) {
      const value = record.data ? record.data[dateField] : undefined;
      if (value === undefined || value === null || value === '') continue;
      let date;
      try {
        date = parseDdMmYyyy(value);
      } catch (err) {
        throw new SchemaError(`Record ${collection}/${record.id}: ${err.message}`, [dateField]);
      }
      if (dateKey(date) === todayKey) due.push(record);
    }
    return due;
  }

  return { runOnce, findDueReminders };
}

function dateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parse a DD/MM/YYYY string as a calendar date (local midnight of that date).
 * Day and month may have one or two digits. Surrounding whitespace is ignored.
 * Errors: SchemaError for malformed input or a date that does not exist (e.g. 31/02/2026).
 *
 * @param {string} text
 * @returns {Date}
 */
function parseDdMmYyyy(text) {
  if (typeof text !== 'string') {
    throw new SchemaError(`Expected a DD/MM/YYYY string, got ${typeof text}`);
  }
  const match = DD_MM_YYYY.exec(text.trim());
  if (!match) throw new SchemaError(`Not a DD/MM/YYYY date: ${JSON.stringify(text)}`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new SchemaError(`Date does not exist: ${JSON.stringify(text)}`);
  }
  return date;
}

module.exports = { createJobRunner, parseDdMmYyyy };

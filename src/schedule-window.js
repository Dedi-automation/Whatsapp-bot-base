'use strict';

// B8 Send window.
//
// Rule: Sunday to Thursday, 09:00 to 17:50 Israel time, inclusive, no holidays (T-04).
// 17:50:59 is inside; 17:51:00 is outside. Nothing is sent after 17:50 on any day
// (decisions.md, item 17).
// Holidays are passed in as YYYY-MM-DD strings (Israel local date). The holiday
// source (Hebcal in MyDoctor) is not part of this contract: the caller reads the
// list from config, so the base has no holiday dependency.
// The Israel wall-clock time is read with Intl, so DST changes need no special code.

const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';
const SEND_DAYS = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
const WINDOW_START_MINUTE = 9 * 60;
const WINDOW_END_MINUTE = 17 * 60 + 50;
const HOLIDAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

/**
 * Wall-clock parts of an instant in a time zone.
 *
 * @param {Date} when
 * @param {string} timeZone
 * @returns {{weekday: string, date: string, minuteOfDay: number}}
 *   date is YYYY-MM-DD in that time zone.
 */
function wallClock(when, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(when);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * @param {Date} when
 * @param {{holidays?: Iterable<string>, timeZone?: string}} [options]
 *   timeZone defaults to 'Asia/Jerusalem'.
 *   holidays: YYYY-MM-DD strings. A malformed entry is a TypeError, so a bad
 *   config value cannot silently let messages out on a holiday.
 * @returns {boolean}
 */
function isWithinSendWindow(when, options = {}) {
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
    throw new TypeError('isWithinSendWindow: when must be a valid Date');
  }
  const { holidays = [], timeZone = DEFAULT_TIME_ZONE } = options;
  const holidaySet = new Set();
  for (const holiday of holidays) {
    if (typeof holiday !== 'string' || !HOLIDAY_PATTERN.test(holiday)) {
      throw new TypeError(`isWithinSendWindow: holiday must be YYYY-MM-DD, got ${JSON.stringify(holiday)}`);
    }
    holidaySet.add(holiday);
  }

  const local = wallClock(when, timeZone);
  if (!SEND_DAYS.has(local.weekday)) return false;
  if (holidaySet.has(local.date)) return false;
  return local.minuteOfDay >= WINDOW_START_MINUTE && local.minuteOfDay <= WINDOW_END_MINUTE;
}

module.exports = { isWithinSendWindow, wallClock };

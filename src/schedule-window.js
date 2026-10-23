'use strict';

// B8 Send window. Contract only (step 0). Logic comes in Branch D.
//
// Rule: Sunday to Thursday, 09:00 to 17:50 Israel time, no holidays (T-04).
// Holidays are passed in as YYYY-MM-DD strings (Israel local date). The holiday
// source (Hebcal in MyDoctor) is not part of this contract.
// Boundary at 17:50: decision recorded in project-log.md. Confirm with owner.

const { NotImplementedError } = require('./errors');

/**
 * @param {Date} when
 * @param {{holidays?: Iterable<string>, timeZone?: string}} [options]
 *   timeZone defaults to 'Asia/Jerusalem'.
 * @returns {boolean}
 */
function isWithinSendWindow(when, options = {}) {
  void when; void options;
  throw new NotImplementedError('isWithinSendWindow');
}

module.exports = { isWithinSendWindow };

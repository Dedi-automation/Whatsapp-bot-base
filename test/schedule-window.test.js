'use strict';

// B8 Send window. Covers T-04. All times are Israel time (Asia/Jerusalem).
// Boundary: window is 09:00 up to, not including, 17:50. Confirm with owner (see project-log.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWithinSendWindow } = require('../src/schedule-window');

// 2026-10-25 is a Sunday; 2026-10-30 is a Friday; 2026-10-29 is a Thursday.
const at = (iso) => new Date(iso);

test('T-04: Sunday to Thursday, 09:00 to 17:49 is inside the window', () => {
  assert.equal(isWithinSendWindow(at('2026-10-25T09:00:00+02:00')), true);
  assert.equal(isWithinSendWindow(at('2026-10-29T17:49:00+02:00')), true);
});

test('T-04: before 09:00 and at 17:50 are outside the window', () => {
  assert.equal(isWithinSendWindow(at('2026-10-25T08:59:59+02:00')), false);
  assert.equal(isWithinSendWindow(at('2026-10-25T17:50:00+02:00')), false);
});

test('T-04: Friday and Saturday are outside the window', () => {
  assert.equal(isWithinSendWindow(at('2026-10-30T10:00:00+02:00')), false);
  assert.equal(isWithinSendWindow(at('2026-10-31T10:00:00+02:00')), false);
});

test('T-04: a holiday on a weekday is outside the window', () => {
  assert.equal(isWithinSendWindow(at('2026-10-25T10:00:00+02:00'), { holidays: ['2026-10-25'] }), false);
});

test('T-04: the check uses Israel time, not UTC (06:30 UTC is 09:30 in Israel in late October)', () => {
  assert.equal(isWithinSendWindow(at('2026-10-25T06:30:00Z')), true);
  assert.equal(isWithinSendWindow(at('2026-10-25T06:59:00Z')), true);
  assert.equal(isWithinSendWindow(at('2026-10-25T07:00:00Z')), true);
  assert.equal(isWithinSendWindow(at('2026-10-25T08:00:00Z')), false);
});

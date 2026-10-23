'use strict';

// B8 Send window. Covers T-04.
// Window: Sunday to Thursday, 09:00 to 17:50 inclusive, Israel time (Asia/Jerusalem).
// Nothing is sent after 17:50 on any day (spec.md sections 1, 8, 11; decisions.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWithinSendWindow } = require('../src/schedule-window');

// 2026-10-25 is a Sunday; 2026-10-29 is a Thursday; 2026-10-30 is a Friday; 2026-10-31 is a Saturday.

// Offset of Asia/Jerusalem from UTC at the given instant, in milliseconds.
function israelOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallAsUtc - instant.getTime();
}

// Build the instant whose Israel wall-clock time is `wall` ('YYYY-MM-DDTHH:MM[:SS]').
function israel(wall) {
  const asUtc = Date.parse(`${wall}Z`);
  let instant = new Date(asUtc - israelOffsetMs(new Date(asUtc)));
  instant = new Date(asUtc - israelOffsetMs(instant));
  return instant;
}

test('T-04: Sunday to Thursday, 09:00 to 17:50 inclusive, is inside the window', () => {
  assert.equal(isWithinSendWindow(israel('2026-10-25T09:00')), true);
  assert.equal(isWithinSendWindow(israel('2026-10-29T17:49')), true);
  assert.equal(isWithinSendWindow(israel('2026-10-29T17:50')), true);
  assert.equal(isWithinSendWindow(israel('2026-10-29T17:50:59')), true);
});

test('T-04: before 09:00 and from 17:51 onward are outside the window', () => {
  assert.equal(isWithinSendWindow(israel('2026-10-25T08:59:59')), false);
  assert.equal(isWithinSendWindow(israel('2026-10-25T17:51:00')), false);
  assert.equal(isWithinSendWindow(israel('2026-10-29T18:30')), false);
});

test('T-04: Friday and Saturday are outside the window', () => {
  assert.equal(isWithinSendWindow(israel('2026-10-30T10:00')), false);
  assert.equal(isWithinSendWindow(israel('2026-10-31T10:00')), false);
});

test('T-04: a holiday on a weekday is outside the window', () => {
  assert.equal(isWithinSendWindow(israel('2026-10-25T10:00'), { holidays: ['2026-10-25'] }), false);
});

test('T-04: the check uses Israel time, not UTC (summer date, IDT is UTC+3)', () => {
  // 2026-07-05 is a Sunday. 06:00Z is 09:00 in Israel; 14:50Z is 17:50 in Israel.
  assert.equal(isWithinSendWindow(new Date('2026-07-05T06:00:00Z')), true);
  assert.equal(isWithinSendWindow(new Date('2026-07-05T14:50:00Z')), true);
  assert.equal(isWithinSendWindow(new Date('2026-07-05T05:59:00Z')), false);
  assert.equal(isWithinSendWindow(new Date('2026-07-05T14:51:00Z')), false);
});

'use strict';

// Daily summary for the agent (stage 2, Dedi's decision 2026-10-26: every day at 18:15).
//
// Built from the bot's own records for the Israel calendar day of `now`:
// - new leads: conversations whose first message is from today
// - active today: conversations with a message today
// - asked for an agent today: handoffAt today
// - waiting for the agent: agent_action_required is true (any day), listed by phone
// - callbacks today: callbackDate (DD/MM/YYYY) is today (F-16: explicit parse, never new Date(string))
// The text links to the dashboard; no token in the link (F-04).
// The 18:15 time is set by the scheduler that calls POST /jobs/send-daily-digest;
// runOnce in the job makes a second call on the same day send nothing (T-08).
//
// Weekly and monthly summaries (Dedi, 2026-10-26): each day's counts are saved in
// daily_summaries/<YYYY-MM-DD>. On Thursday the daily message also sums the 7 days
// ending that day (Friday to Thursday, so every day is in exactly one week). On the
// 1st of the month a separate monthly message sums the previous month's days, broken
// down by the weeks that end on Thursday (Dedi: the monthly summary arrives on the 1st). A day with no saved counts (the job did not
// run) is reported as missing, never guessed.
// The monthly invoice comes from Grow in its own email (Dedi, 2026-10-26: two separate
// emails, billing stays outside the base); a bot may add one line about it (monthlyNote).

const { wallClock } = require('./schedule-window');
const { parseDdMmYyyy } = require('./jobs');
const { MESSAGES, CONVERSATIONS } = require('./conversation');

const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';
const MAX_LISTED = 10;
const SUMMARIES = 'daily_summaries';
const SUMMED = Object.freeze(['newLeads', 'activeToday', 'handoffsToday', 'callbacksToday']);
const THURSDAY = 4;

/**
 * @param {{storage: import('./storage').Storage, now: () => Date, botName?: string, dashboardUrl: string, timeZone?: string}} deps
 * @returns {Promise<{subject: string, text: string, counts: {newLeads: number, activeToday: number, handoffsToday: number, waiting: number, callbacksToday: number}}>}
 */
async function buildDailySummary(deps) {
  const { storage, now, botName = '', dashboardUrl, timeZone = DEFAULT_TIME_ZONE } = deps;
  const today = wallClock(now(), timeZone).date;
  const sameDay = (iso) => typeof iso === 'string' && iso !== '' && !Number.isNaN(Date.parse(iso)) && wallClock(new Date(iso), timeZone).date === today;
  const [y, m, d] = today.split('-');
  const todayDdMm = `${d}/${m}/${y}`;

  const conversations = await storage.list(CONVERSATIONS);
  let newLeads = 0;
  let activeToday = 0;
  let handoffsToday = 0;
  let callbacksToday = 0;
  const waiting = [];
  for (const { id, data } of conversations) {
    if (sameDay(data.lastMessageAt)) activeToday += 1;
    if (sameDay(data.handoffAt)) handoffsToday += 1;
    if (data.agent_action_required === true) waiting.push({ id, reason: data.handoff_reason || null });
    if (typeof data.callbackDate === 'string' && data.callbackDate !== '') {
      try {
        const date = parseDdMmYyyy(data.callbackDate);
        const key = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
        if (key === todayDdMm) callbacksToday += 1;
      } catch {
        // A malformed date is reported by the reminders job (F-16); the summary skips it.
      }
    }
    const first = await storage.get(MESSAGES, `${id}:1`);
    if (first && sameDay(first.at)) newLeads += 1;
  }

  const base = String(dashboardUrl).replace(/\/+$/, '');
  const lines = [
    `סיכום יומי${botName ? ` - ${botName}` : ''} - ${todayDdMm}`,
    `לידים חדשים היום: ${newLeads}`,
    `שיחות פעילות היום: ${activeToday}`,
    `ביקשו נציג היום: ${handoffsToday}`,
    `מחכים לטיפול שלך: ${waiting.length}`,
    `שיחות חוזרות שנקבעו להיום: ${callbacksToday}`,
  ];
  if (waiting.length > 0) {
    lines.push('', 'מחכים לטיפול:');
    for (const w of waiting.slice(0, MAX_LISTED)) lines.push(`- ${w.id}${w.reason ? ` (${w.reason})` : ''}`);
    if (waiting.length > MAX_LISTED) lines.push(`ועוד ${waiting.length - MAX_LISTED}`);
  }
  lines.push('', `ללוח: ${base}/admin/leads`);

  return {
    date: today,
    subject: `סיכום יומי${botName ? ` - ${botName}` : ''} - ${todayDdMm}`,
    text: lines.join('\n'),
    counts: { newLeads, activeToday, handoffsToday, waiting: waiting.length, callbacksToday },
  };
}

/**
 * The 18:15 job: builds the daily summary, saves its counts, and adds the week on
 * Thursday and the previous month on the 1st. Sends nothing itself.
 *
 * @param {{storage: import('./storage').Storage, now: () => Date, botName?: string, dashboardUrl: string, timeZone?: string, monthlyNote?: string}} deps
 *   monthlyNote: one line added to the monthly summary, for example that the invoice comes from Grow.
 * @returns {Promise<{
 *   date: string,
 *   daily: {subject: string, text: string, counts: object},
 *   week: {from: string, to: string, totals: object, daysRecorded: number} | null,
 *   monthly: {subject: string, text: string, from: string, to: string, totals: object, daysRecorded: number} | null
 * }>}
 */
async function buildDigest(deps) {
  const { storage, now, botName = '', dashboardUrl, monthlyNote = '' } = deps;
  const summary = await buildDailySummary(deps);
  const day = summary.date;
  await storage.set(SUMMARIES, day, { date: day, ...summary.counts, savedAt: now().toISOString() });

  const base = String(dashboardUrl).replace(/\/+$/, '');
  const link = `ללוח: ${base}/admin/leads`;
  const dailyLines = summary.text.split('\n');
  dailyLines.pop(); // the dashboard link goes last, after the week
  const name = botName ? ` - ${botName}` : '';

  let week = null;
  let daily = { subject: summary.subject, text: summary.text, counts: summary.counts };
  if (weekday(day) === THURSDAY) {
    const from = addDays(day, -6);
    const period = await sumDays(storage, from, day);
    week = { from, to: day, totals: period.totals, daysRecorded: period.daysRecorded };
    const text = [...dailyLines, `סיכום שבועי ${ddMmYyyy(from)} עד ${ddMmYyyy(day)}`, ...periodLines(period, 7), '', link];
    daily = { subject: `סיכום יומי ושבועי${name} - ${ddMmYyyy(day)}`, text: text.join('\n'), counts: summary.counts };
  }

  let monthly = null;
  if (day.endsWith('-01')) {
    const to = addDays(day, -1);
    const from = `${to.slice(0, 7)}-01`;
    const period = await sumDays(storage, from, to);
    const daysInMonth = Number(to.slice(8, 10));
    const lines = [`סיכום חודשי${name} - ${monthLabel(to)}`, ...periodLines(period, daysInMonth), '', 'לפי שבועות (עד יום חמישי):'];
    for (const w of weeksOf(from, to)) {
      const t = sumOf(period.byDay, w.from, w.to);
      lines.push(`- ${ddMm(w.from)} עד ${ddMm(w.to)}: לידים חדשים ${t.newLeads}, ביקשו נציג ${t.handoffsToday}`);
    }
    lines.push(`מחכים לטיפול שלך עכשיו: ${summary.counts.waiting}`);
    if (monthlyNote) lines.push('', String(monthlyNote).replace(/[\r\n]+/g, ' '));
    lines.push('', link);
    monthly = {
      subject: `סיכום חודשי${name} - ${monthLabel(to)}`,
      text: lines.join('\n'),
      from,
      to,
      totals: period.totals,
      daysRecorded: period.daysRecorded,
    };
  }

  return { date: day, daily, week, monthly };
}

async function sumDays(storage, from, to) {
  const byDay = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const saved = await storage.get(SUMMARIES, d);
    if (saved) byDay.set(d, saved);
  }
  return { byDay, totals: sumOf(byDay, from, to), daysRecorded: byDay.size };
}

function sumOf(byDay, from, to) {
  const totals = Object.fromEntries(SUMMED.map((k) => [k, 0]));
  for (const [d, saved] of byDay) {
    if (d < from || d > to) continue;
    for (const k of SUMMED) totals[k] += Number.isFinite(saved[k]) ? saved[k] : 0;
  }
  return totals;
}

function periodLines(period, days) {
  const t = period.totals;
  const lines = [
    `לידים חדשים: ${t.newLeads}`,
    `ביקשו נציג: ${t.handoffsToday}`,
    `שיחות חוזרות שנקבעו: ${t.callbacksToday}`,
    `שיחות פעילות (סך כל הימים): ${t.activeToday}`,
  ];
  if (period.daysRecorded < days) lines.push(`שים לב: נשמרו נתונים ל-${period.daysRecorded} ימים מתוך ${days}`);
  return lines;
}

// Weeks inside [from, to] that end on Thursday; the last one ends at `to`.
function weeksOf(from, to) {
  const weeks = [];
  let start = from;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (weekday(d) === THURSDAY || d === to) {
      weeks.push({ from: start, to: d });
      start = addDays(d, 1);
    }
  }
  return weeks;
}

// Calendar arithmetic on YYYY-MM-DD strings, in UTC so no time zone can shift the day.
function toUtc(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(date, n) {
  const t = toUtc(date);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function weekday(date) {
  return toUtc(date).getUTCDay();
}
function ddMmYyyy(date) {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
function ddMm(date) {
  return ddMmYyyy(date).slice(0, 5);
}
function monthLabel(date) {
  return `${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

module.exports = { buildDailySummary, buildDigest, SUMMARIES, addDays };

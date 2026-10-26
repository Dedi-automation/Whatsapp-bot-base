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

const { wallClock } = require('./schedule-window');
const { parseDdMmYyyy } = require('./jobs');
const { MESSAGES, CONVERSATIONS } = require('./conversation');

const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';
const MAX_LISTED = 10;

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
    subject: `סיכום יומי${botName ? ` - ${botName}` : ''} - ${todayDdMm}`,
    text: lines.join('\n'),
    counts: { newLeads, activeToday, handoffsToday, waiting: waiting.length, callbacksToday },
  };
}

module.exports = { buildDailySummary };

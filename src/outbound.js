'use strict';

// Outbound messages (base 1.1.0, decisions.md items 46 to 51).
//
// - Signup link: the agent enters one phone on the dashboard; the bot sends the bot's
//   Meta-approved signup template with the link. Refused outside the send window.
// - Campaign: a list of recipients gets a Meta-approved marketing template. The job
//   POST /jobs/send-campaigns (every 10 minutes) sends a small batch per run, only in
//   the customer send window.
// - Daily limit for the whole number (all campaigns together): startPerDay in the
//   first week, plus stepPerWeek each week, up to maxPerDay. Week 1 starts on the day
//   the first campaign starts. Signup links count toward the day but are not blocked.
// - Opt-out: an opt-out word from a customer puts the phone in 'optouts' for good.
//   No campaign or signup message goes to an opted-out phone.
// - Automatic pause: a Meta limit or block error on a send, a failed status with such
//   an error, a quality warning on the number, a template paused/disabled/red, or ten
//   failed sends in a row. Only a person resumes a campaign. The owner gets a
//   'campaign_alert' notification.
// - Replies (Dedi, 2026-10-28: the agent sees who answered and what): when a customer
//   who got a campaign message writes back, the recipient becomes 'replied' with the
//   text, and the conversation gets the campaign's name for the lead board.
// - A recipient is sent at most once per campaign: the send lock (campaign_sends) is
//   created atomically before the send, so two overlapping job runs cannot both send.
//
// Records:
//   campaigns/<id>                       name, templateKey, status, progress counters
//   campaign_recipients/<id>:<000001>    phone, name, status, messageId, error
//   campaign_phones/<id>:<phone>         one phone once per campaign, and its recipient record
//   campaign_sends/<id>:<000001>         send lock
//   outbound_messages/<hash of wamid>    which recipient a Meta status belongs to
//   outbound_days/<YYYY-MM-DD>           messages sent that day (Israel date)
//   outbound_settings/ramp               the daily limit settings and week 1 start date
//   optouts/<phone>                      opted-out phones
//   signup_sends/<phone>:<time>          signup links sent from the dashboard
//
// Logs never contain phone numbers or message text.

const crypto = require('node:crypto');
const { OutboundError, WhatsAppError } = require('./errors');
const { wallClock } = require('./schedule-window');

const CAMPAIGNS = 'campaigns';
const RECIPIENTS = 'campaign_recipients';
const PHONES = 'campaign_phones';
const SENDS = 'campaign_sends';
const OUTBOUND_MESSAGES = 'outbound_messages';
const OUTBOUND_DAYS = 'outbound_days';
const SETTINGS = 'outbound_settings';
const OPTOUTS = 'optouts';
const SIGNUPS = 'signup_sends';

const DEFAULT_RAMP = Object.freeze({ startPerDay: 100, stepPerWeek: 50, maxPerDay: 250 });
const DEFAULT_BATCH = 25;
const MAX_FAILURES_IN_A_ROW = 10;
const WRITE_CONCURRENCY = 20;
const DEFAULT_OPT_OUT_WORDS = Object.freeze(['הסר', 'לא מעוניין', 'לא מעוניינת', 'הסירו אותי', 'stop']);
const PLACEHOLDERS = new Set(['name', 'phone', 'link']);

// Meta error codes that mean the number, the app or the template must stop, not only
// one recipient: rate and spam limits, policy blocks, a paused or disabled template,
// an expired token or missing permission.
const PAUSE_CODES = new Set([4, 10, 190, 368, 80007, 130429, 130497, 131005, 131031, 131048, 132015, 132016]);
const QUALITY_PAUSE = new Set(['FLAGGED', 'DOWNGRADE']);
const TEMPLATE_PAUSE = new Set(['PAUSED', 'DISABLED', 'REJECTED', 'RED', 'FLAGGED']);
const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3, replied: 4 };
const CONTACTED = new Set(['sent', 'delivered', 'read', 'replied']);
const MAX_REPLY_CHARS = 500;

/**
 * @typedef {{name: string, language: string, params?: string[], urlButtonParam?: string, label?: string}} TemplateDef
 *   params and urlButtonParam may hold {name}, {phone} and {link}.
 * @typedef {{startPerDay: number, stepPerWeek: number, maxPerDay: number | null}} Ramp
 *   maxPerDay null: no ceiling.
 */

/**
 * @param {{
 *   storage: import('./storage').Storage,
 *   whatsapp: import('./whatsapp').WhatsAppClient,
 *   isWithinSendWindow: (when: Date) => boolean,
 *   now: () => Date,
 *   optOutReplyText: string,
 *   signup?: {template: TemplateDef, link: string},
 *   templates?: Record<string, TemplateDef>,
 *   optOutKeywords?: string[],
 *   fallbacks?: {name?: string},
 *   ramp?: Partial<Ramp>,
 *   batchPerRun?: number,
 *   notifier?: {send: (event: string, message: {subject: string, text: string}) => Promise<unknown>} | null,
 *   botName?: string,
 *   timeZone?: string,
 *   log?: {info: (...args: unknown[]) => void, error: (...args: unknown[]) => void}
 * }} deps
 *   templates: the campaign templates by key, as the bot lists them (approved by Meta).
 *   fallbacks.name: used for {name} when a recipient has no name (Meta refuses an empty value).
 *   ramp: the defaults until the owner changes them on the dashboard.
 * Errors: TypeError at startup for a missing dependency or a bad template definition.
 */
function createOutbound(deps) {
  const { storage, whatsapp, isWithinSendWindow, now, optOutReplyText } = deps || {};
  const { signup = null, templates = {}, fallbacks = {}, batchPerRun = DEFAULT_BATCH, notifier = null } = deps || {};
  const { botName = '', timeZone = 'Asia/Jerusalem', log = console } = deps || {};
  if (!storage || typeof storage.createIfAbsent !== 'function') throw new TypeError('outbound: storage is required');
  if (!whatsapp || typeof whatsapp.sendTemplate !== 'function') throw new TypeError('outbound: whatsapp with sendTemplate is required');
  if (typeof isWithinSendWindow !== 'function') throw new TypeError('outbound: isWithinSendWindow is required');
  if (typeof now !== 'function') throw new TypeError('outbound: now() is required');
  if (typeof optOutReplyText !== 'string' || optOutReplyText.trim() === '') throw new TypeError('outbound: optOutReplyText is required');
  if (!Number.isInteger(batchPerRun) || batchPerRun < 1) throw new TypeError('outbound: batchPerRun must be a positive integer');
  if (signup) {
    checkTemplate(signup.template, 'signup.template');
    if (typeof signup.link !== 'string' || !/^https:\/\/\S+$/.test(signup.link)) throw new TypeError('outbound: signup.link must be an https URL');
  }
  for (const [key, def] of Object.entries(templates)) {
    if (!/^[a-z0-9_-]+$/i.test(key)) throw new TypeError(`outbound: template key "${key}" may hold only letters, digits, _ and -`);
    checkTemplate(def, `templates.${key}`);
  }
  const defaultRamp = checkRamp({ ...DEFAULT_RAMP, ...(deps.ramp || {}) });
  const optOutWords = new Set((deps.optOutKeywords || DEFAULT_OPT_OUT_WORDS).map(normalizeWords).filter((w) => w !== ''));
  if (optOutWords.size === 0) throw new TypeError('outbound: optOutKeywords must hold at least one word');

  const today = () => wallClock(now(), timeZone).date;
  const stamp = () => now().toISOString();

  // ---- opt-out ----

  function isOptOutText(text) {
    return typeof text === 'string' && optOutWords.has(normalizeWords(text));
  }

  async function isOptedOut(phone) {
    return (await storage.get(OPTOUTS, phone)) !== null;
  }

  /** @returns {Promise<boolean>} true when the phone was not on the list before */
  async function recordOptOut({ phone, source }) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new OutboundError('מספר טלפון לא תקין');
    const added = await storage.createIfAbsent(OPTOUTS, normalized, { phone: normalized, source, at: stamp() });
    if (added) log.info(`outbound: opt-out recorded (${source})`);
    return added;
  }

  async function listOptOuts() {
    return (await storage.list(OPTOUTS)).sort((a, b) => String(b.data.at).localeCompare(String(a.data.at)));
  }

  // ---- daily limit ----

  async function getRamp() {
    const stored = (await storage.get(SETTINGS, 'ramp')) || {};
    return {
      startPerDay: stored.startPerDay ?? defaultRamp.startPerDay,
      stepPerWeek: stored.stepPerWeek ?? defaultRamp.stepPerWeek,
      maxPerDay: stored.maxPerDay !== undefined ? stored.maxPerDay : defaultRamp.maxPerDay,
      startDate: stored.startDate || null,
    };
  }

  async function updateRamp(input) {
    const ramp = checkRamp(input, OutboundError);
    const current = (await storage.get(SETTINGS, 'ramp')) || {};
    await storage.set(SETTINGS, 'ramp', { ...current, ...ramp, updatedAt: stamp() });
    log.info('outbound: daily limit settings changed');
  }

  /** The day's limit for the number. Before the first campaign starts, week 1 applies. */
  function quotaFor(ramp, date) {
    const week = ramp.startDate ? Math.max(0, Math.floor(daysBetween(ramp.startDate, date) / 7)) : 0;
    const quota = ramp.startPerDay + ramp.stepPerWeek * week;
    return { week: week + 1, quota: ramp.maxPerDay === null ? quota : Math.min(quota, ramp.maxPerDay) };
  }

  async function sentOn(date) {
    const day = await storage.get(OUTBOUND_DAYS, date);
    return day && Number.isInteger(day.sent) ? day.sent : 0;
  }

  async function countSent(date) {
    const day = (await storage.get(OUTBOUND_DAYS, date)) || { sent: 0 };
    await storage.set(OUTBOUND_DAYS, date, { ...day, sent: (Number.isInteger(day.sent) ? day.sent : 0) + 1 });
  }

  async function todayStatus() {
    const ramp = await getRamp();
    const date = today();
    const { week, quota } = quotaFor(ramp, date);
    return { date, week, quota, sent: await sentOn(date), ramp, inWindow: isWithinSendWindow(now()) };
  }

  // ---- signup link ----

  /**
   * @returns {Promise<{status: 'sent' | 'invalid_phone' | 'opted_out' | 'outside_window' | 'failed', phone?: string, detail?: string}>}
   */
  async function sendSignupLink({ phone, name = '' }) {
    if (!signup) throw new OutboundError('לבוט הזה לא הוגדרה תבנית הרשמה');
    const to = normalizePhone(phone);
    if (!to) return { status: 'invalid_phone' };
    if (await isOptedOut(to)) return { status: 'opted_out', phone: to };
    if (!isWithinSendWindow(now())) return { status: 'outside_window', phone: to };
    const id = `${to}:${stamp().replace(/[^0-9]/g, '')}`;
    const base = { phone: to, name: String(name || '').trim(), at: stamp() };
    let messageId;
    try {
      messageId = await sendTemplate(signup.template, to, { name: base.name, phone: to, link: signup.link });
    } catch (err) {
      const detail = describeError(err);
      await storage.set(SIGNUPS, id, { ...base, status: 'failed', error: detail });
      log.error(`outbound: signup link failed: ${err && err.name}`);
      return { status: 'failed', phone: to, detail };
    }
    await storage.set(SIGNUPS, id, { ...base, status: 'sent', messageId });
    await storage.set(OUTBOUND_MESSAGES, messageKey(messageId), { kind: 'signup', signupId: id });
    await countSent(today());
    log.info('outbound: signup link sent');
    return { status: 'sent', phone: to };
  }

  async function listSignups() {
    return (await storage.list(SIGNUPS)).sort((a, b) => String(b.data.at).localeCompare(String(a.data.at)));
  }

  // ---- campaigns ----

  async function createCampaign({ name, templateKey }) {
    const title = String(name || '').trim();
    if (title === '') throw new OutboundError('חסר שם לקמפיין');
    if (!Object.hasOwn(templates, templateKey)) throw new OutboundError('תבנית לא מוכרת');
    const id = `c${stamp().replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
    await storage.set(CAMPAIGNS, id, {
      name: title,
      templateKey,
      status: 'draft',
      createdAt: stamp(),
      total: 0,
      nextIndex: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      failuresInARow: 0,
      pauseReason: null,
    });
    log.info('outbound: campaign created');
    return id;
  }

  async function getCampaign(id) {
    return typeof id === 'string' && id !== '' && !id.includes('/') ? storage.get(CAMPAIGNS, id) : null;
  }

  async function listCampaigns() {
    return (await storage.list(CAMPAIGNS)).sort((a, b) => String(a.data.createdAt).localeCompare(String(b.data.createdAt)));
  }

  /**
   * Add recipients to a campaign. A phone already in the campaign is skipped.
   * @param {string} campaignId
   * @param {Array<{phone: string, name?: string}>} rows
   * @returns {Promise<{added: number, duplicates: number, invalid: number}>}
   */
  async function addRecipients(campaignId, rows) {
    const campaign = await getCampaign(campaignId);
    if (!campaign) throw new OutboundError('הקמפיין לא נמצא');
    let invalid = 0;
    const seen = new Set();
    const fresh = [];
    for (const row of rows) {
      const phone = normalizePhone(row && row.phone);
      if (!phone) {
        invalid += 1;
        continue;
      }
      if (seen.has(phone)) continue;
      seen.add(phone);
      fresh.push({ phone, name: String((row && row.name) || '').trim().slice(0, 100) });
    }
    const duplicatesInList = rows.length - invalid - fresh.length;

    // One phone once per campaign, also across several uploads.
    const claimed = await mapLimit(fresh, WRITE_CONCURRENCY, async (r) =>
      (await storage.createIfAbsent(PHONES, `${campaignId}:${r.phone}`, { at: stamp() })) ? r : null
    );
    const toAdd = claimed.filter(Boolean);
    const start = campaign.total;
    const indexes = await mapLimit(toAdd, WRITE_CONCURRENCY, async (r, i) => {
      // createIfAbsent keeps two uploads at the same time from writing the same slot.
      let index = start + i;
      while (!(await storage.createIfAbsent(RECIPIENTS, recipientId(campaignId, index), { campaignId, index, phone: r.phone, name: r.name, status: 'pending', addedAt: stamp() }))) {
        index += toAdd.length;
      }
      // Lets a reply from this phone find its recipient record without reading the whole list.
      await storage.set(PHONES, `${campaignId}:${r.phone}`, { at: stamp(), recipientId: recipientId(campaignId, index) });
      return index;
    });
    const current = await getCampaign(campaignId);
    const total = Math.max(current.total, ...indexes.map((i) => i + 1));
    const status = current.status === 'done' && toAdd.length > 0 ? 'paused' : current.status;
    await storage.set(CAMPAIGNS, campaignId, { ...current, total, status, pauseReason: status === 'paused' && current.status === 'done' ? 'נוספו נמענים' : current.pauseReason });
    log.info(`outbound: ${toAdd.length} recipients added`);
    return { added: toAdd.length, duplicates: duplicatesInList + (fresh.length - toAdd.length), invalid };
  }

  async function listRecipients(campaignId) {
    return (await storage.list(RECIPIENTS)).filter((r) => r.data.campaignId === campaignId).sort((a, b) => a.data.index - b.data.index);
  }

  /** start: draft or paused -> running. pause: running -> paused. */
  async function setStatus(campaignId, action) {
    const campaign = await getCampaign(campaignId);
    if (!campaign) throw new OutboundError('הקמפיין לא נמצא');
    if (action === 'start') {
      if (!['draft', 'paused', 'paused_auto'].includes(campaign.status)) throw new OutboundError('אפשר להפעיל רק קמפיין שעדיין לא רץ או שנעצר');
      if (campaign.total === 0) throw new OutboundError('אין נמענים בקמפיין');
      const ramp = (await storage.get(SETTINGS, 'ramp')) || {};
      if (!ramp.startDate) await storage.set(SETTINGS, 'ramp', { ...ramp, startDate: today() });
      await storage.set(CAMPAIGNS, campaignId, { ...campaign, status: 'running', startedAt: campaign.startedAt || stamp(), pauseReason: null, failuresInARow: 0 });
      log.info('outbound: campaign started');
      return 'running';
    }
    if (action === 'pause') {
      if (campaign.status !== 'running') throw new OutboundError('הקמפיין לא רץ');
      await storage.set(CAMPAIGNS, campaignId, { ...campaign, status: 'paused', pauseReason: 'נעצר ידנית', pausedAt: stamp() });
      log.info('outbound: campaign paused');
      return 'paused';
    }
    throw new OutboundError('פעולה לא מוכרת');
  }

  async function autoPause(campaignId, reason) {
    const campaign = await getCampaign(campaignId);
    if (!campaign || campaign.status !== 'running') return false;
    await storage.set(CAMPAIGNS, campaignId, { ...campaign, status: 'paused_auto', pauseReason: reason, pausedAt: stamp() });
    log.error('outbound: campaign paused automatically');
    await alert(`${botName || 'בוט'}: קמפיין נעצר`, [`הקמפיין "${campaign.name}" נעצר אוטומטית.`, `סיבה: ${reason}`, 'בדקו את מצב המספר ב-Meta, ואז הפעילו שוב בלוח הבקרה.'].join('\n'));
    return true;
  }

  async function alert(subject, text) {
    if (!notifier) return;
    try {
      await notifier.send('campaign_alert', { subject, text });
    } catch (err) {
      log.error(`outbound: alert failed: ${err && err.name}`);
    }
  }

  /** Progress fields belong to the job; status belongs to people and to autoPause. */
  async function saveProgress(campaignId, progress) {
    const current = await getCampaign(campaignId);
    await storage.set(CAMPAIGNS, campaignId, { ...current, ...progress });
    return current.status;
  }

  /**
   * The scheduled job. Sends up to batchPerRun messages, within the day's limit and the window.
   * @returns {Promise<{status: 'outside_window' | 'daily_limit' | 'ran', sent: number, quota: number, sentToday: number}>}
   */
  async function runCampaigns() {
    const { date, quota, sent: sentBefore, inWindow } = await todayStatus();
    if (!inWindow) return { status: 'outside_window', sent: 0, quota, sentToday: sentBefore };
    let left = Math.min(quota - sentBefore, batchPerRun);
    if (left <= 0) return { status: 'daily_limit', sent: 0, quota, sentToday: sentBefore };
    let sent = 0;
    for (const { id } of await listCampaigns()) {
      if (left <= 0) break;
      const n = await runOne(id, left, date);
      sent += n;
      left -= n;
    }
    return { status: 'ran', sent, quota, sentToday: sentBefore + sent };
  }

  async function runOne(campaignId, allowance, date) {
    let c = await getCampaign(campaignId);
    if (!c || c.status !== 'running') return 0;
    const template = templates[c.templateKey];
    if (!template) {
      await autoPause(campaignId, 'התבנית של הקמפיין לא מוגדרת בבוט');
      return 0;
    }
    const progress = { nextIndex: c.nextIndex, sent: c.sent, failed: c.failed, skipped: c.skipped, failuresInARow: c.failuresInARow || 0 };
    let sent = 0;
    while (sent < allowance && progress.nextIndex < c.total) {
      const index = progress.nextIndex;
      const rid = recipientId(campaignId, index);
      progress.nextIndex += 1;
      const rec = await storage.get(RECIPIENTS, rid);
      if (!rec || rec.status !== 'pending') {
        if ((await saveProgress(campaignId, progress)) !== 'running') return sent;
        continue;
      }
      if (await isOptedOut(rec.phone)) {
        await storage.set(RECIPIENTS, rid, { ...rec, status: 'opted_out' });
        progress.skipped += 1;
        if ((await saveProgress(campaignId, progress)) !== 'running') return sent;
        continue;
      }
      if (!(await storage.createIfAbsent(SENDS, rid, { at: stamp() }))) {
        if ((await saveProgress(campaignId, progress)) !== 'running') return sent;
        continue;
      }
      let messageId;
      try {
        messageId = await sendTemplate(template, rec.phone, { name: rec.name, phone: rec.phone });
      } catch (err) {
        if (err instanceof WhatsAppError && PAUSE_CODES.has(err.code)) {
          // Not this recipient's fault: free the lock and send to them after a resume.
          await storage.delete(SENDS, rid);
          progress.nextIndex = index;
          await saveProgress(campaignId, progress);
          await autoPause(campaignId, `שגיאת Meta ${err.code}: ${err.message}`);
          return sent;
        }
        await storage.set(RECIPIENTS, rid, { ...rec, status: 'failed', error: describeError(err), failedAt: stamp() });
        progress.failed += 1;
        progress.failuresInARow += 1;
        await saveProgress(campaignId, progress);
        if (progress.failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          await autoPause(campaignId, `${MAX_FAILURES_IN_A_ROW} שליחות נכשלו ברצף. אחרונה: ${describeError(err)}`);
          return sent;
        }
        c = await getCampaign(campaignId);
        if (c.status !== 'running') return sent;
        continue;
      }
      await storage.set(RECIPIENTS, rid, { ...rec, status: 'sent', messageId, sentAt: stamp() });
      await storage.set(OUTBOUND_MESSAGES, messageKey(messageId), { kind: 'campaign', campaignId, recipientId: rid });
      await countSent(date);
      progress.sent += 1;
      progress.failuresInARow = 0;
      sent += 1;
      if ((await saveProgress(campaignId, progress)) !== 'running') return sent;
    }
    if (progress.nextIndex >= c.total) {
      const current = await getCampaign(campaignId);
      if (current.status === 'running' && progress.nextIndex >= current.total) {
        await storage.set(CAMPAIGNS, campaignId, { ...current, ...progress, status: 'done', finishedAt: stamp() });
        log.info('outbound: campaign done');
        await alert(`${botName || 'בוט'}: קמפיין הסתיים`, `הקמפיין "${current.name}" נשלח לכל הנמענים: ${progress.sent} נשלחו, ${progress.failed} נכשלו, ${progress.skipped} הוסרו לפי בקשתם.`);
      }
    }
    return sent;
  }

  async function sendTemplate(def, to, values) {
    const params = (def.params || []).map((p) => fill(p, values));
    const urlButtonParam = def.urlButtonParam ? fill(def.urlButtonParam, values) : undefined;
    const { messageId } = await whatsapp.sendTemplate({ to, templateName: def.name, language: def.language, params, urlButtonParam });
    return messageId;
  }

  function fill(text, values) {
    const out = text.replace(/\{(name|phone|link)\}/g, (_, key) => {
      const value = String(values[key] || '').trim() || (key === 'name' ? String(fallbacks.name || '').trim() : '');
      if (value === '') throw new OutboundError(`חסר ערך ל-{${key}}`);
      return value;
    });
    // Meta template parameters: one line, no tabs, no runs of more than 4 spaces.
    return out.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  }

  // ---- replies from customers ----

  /**
   * A customer wrote to the bot. Each campaign that already sent them a message marks
   * them 'replied' with the text ('opted_out' for an opt-out word). An opt-out also
   * marks them in campaigns that have not sent yet.
   * @returns {Promise<{campaignId: string, campaignName: string} | null>} the latest campaign that contacted them
   */
  async function recordReply({ phone, text, optedOut = false }) {
    const to = normalizePhone(phone);
    if (!to) return null;
    let latest = null;
    for (const c of await listCampaigns()) {
      const link = await storage.get(PHONES, `${c.id}:${to}`);
      if (!link || typeof link.recipientId !== 'string') continue;
      const rec = await storage.get(RECIPIENTS, link.recipientId);
      if (!rec) continue;
      const contacted = CONTACTED.has(rec.status);
      if (optedOut && rec.status !== 'opted_out' && (contacted || rec.status === 'pending')) {
        await storage.set(RECIPIENTS, link.recipientId, { ...rec, status: 'opted_out', reply: String(text || '').slice(0, MAX_REPLY_CHARS), repliedAt: stamp() });
      } else if (!optedOut && contacted) {
        await storage.set(RECIPIENTS, link.recipientId, { ...rec, status: 'replied', reply: String(text || '').slice(0, MAX_REPLY_CHARS), repliedAt: stamp() });
      }
      if (contacted) latest = { campaignId: c.id, campaignName: c.data.name };
    }
    return latest;
  }

  // ---- Meta webhook events ----

  /**
   * Statuses of sent messages update the recipient; quality and template warnings pause.
   * @param {import('./whatsapp').WebhookEvent[]} events
   * @returns {Promise<{statuses: number, paused: number}>}
   */
  async function handleEvents(events) {
    let statuses = 0;
    let paused = 0;
    for (const event of events || []) {
      if (event.kind === 'status') {
        const ref = await storage.get(OUTBOUND_MESSAGES, messageKey(event.messageId));
        if (!ref) continue;
        statuses += 1;
        const failed = event.status === 'failed';
        const error = failed ? `${event.errorCode ?? ''} ${event.errorTitle || ''}`.trim() || 'failed' : null;
        if (ref.kind === 'signup') {
          const s = await storage.get(SIGNUPS, ref.signupId);
          if (s && advances(s.status, event.status)) await storage.set(SIGNUPS, ref.signupId, { ...s, status: event.status, ...(error ? { error } : {}) });
          continue;
        }
        const rec = await storage.get(RECIPIENTS, ref.recipientId);
        if (rec && advances(rec.status, event.status)) {
          await storage.set(RECIPIENTS, ref.recipientId, { ...rec, status: event.status, ...(error ? { error } : {}), [`${event.status}At`]: stamp() });
        }
        if (failed && PAUSE_CODES.has(event.errorCode)) {
          if (await autoPause(ref.campaignId, `שגיאת Meta ${event.errorCode}: ${event.errorTitle || ''}`.trim())) paused += 1;
        }
      } else if (event.kind === 'quality' && QUALITY_PAUSE.has(event.event)) {
        const reason = `איכות המספר ב-Meta: ${event.event}${event.currentLimit ? ` (מגבלה ${event.currentLimit})` : ''}`;
        let any = false;
        for (const c of await listCampaigns()) {
          if (c.data.status === 'running' && (await autoPause(c.id, reason))) {
            paused += 1;
            any = true;
          }
        }
        if (!any) await alert(`${botName || 'בוט'}: אזהרת איכות מ-Meta`, `${reason}\nאין קמפיין רץ כרגע. מומלץ לא להפעיל קמפיין עד שהאיכות חוזרת.`);
      } else if (event.kind === 'template' && TEMPLATE_PAUSE.has(event.event)) {
        const keys = Object.keys(templates).filter((k) => templates[k].name === event.templateName);
        for (const c of await listCampaigns()) {
          if (c.data.status === 'running' && keys.includes(c.data.templateKey)) {
            if (await autoPause(c.id, `התבנית ${event.templateName} במצב ${event.event} ב-Meta`)) paused += 1;
          }
        }
      }
    }
    return { statuses, paused };
  }

  return {
    templates,
    hasSignup: Boolean(signup),
    optOutReplyText,
    isOptOutText,
    isOptedOut,
    recordOptOut,
    recordReply,
    listOptOuts,
    getRamp,
    updateRamp,
    todayStatus,
    sendSignupLink,
    listSignups,
    createCampaign,
    getCampaign,
    listCampaigns,
    addRecipients,
    listRecipients,
    setStatus,
    runCampaigns,
    handleEvents,
  };
}

function checkTemplate(def, where) {
  if (!def || typeof def.name !== 'string' || def.name === '' || typeof def.language !== 'string' || def.language === '') {
    throw new TypeError(`outbound: ${where} needs a name and a language`);
  }
  const texts = [...(def.params || []), ...(def.urlButtonParam ? [def.urlButtonParam] : [])];
  if (!Array.isArray(def.params || []) || texts.some((t) => typeof t !== 'string')) throw new TypeError(`outbound: ${where} params must be strings`);
  for (const t of texts) {
    for (const [, key] of t.matchAll(/\{([^}]*)\}/g)) {
      if (!PLACEHOLDERS.has(key)) throw new TypeError(`outbound: ${where} has an unknown placeholder {${key}}`);
    }
  }
}

function checkRamp(input, ErrorType = TypeError) {
  const int = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  const startPerDay = int(input.startPerDay);
  const stepPerWeek = int(input.stepPerWeek);
  const max = input.maxPerDay === null || input.maxPerDay === '' ? null : int(input.maxPerDay);
  if (!Number.isInteger(startPerDay) || startPerDay < 1) throw new ErrorType('מספר ההודעות ביום בשבוע הראשון חייב להיות מספר שלם חיובי');
  if (!Number.isInteger(stepPerWeek) || stepPerWeek < 0) throw new ErrorType('התוספת השבועית חייבת להיות מספר שלם, 0 או יותר');
  if (max !== null && (!Number.isInteger(max) || max < startPerDay)) throw new ErrorType('התקרה היומית חייבת להיות מספר שלם, לפחות כמו השבוע הראשון');
  return { startPerDay, stepPerWeek, maxPerDay: max };
}

/**
 * A phone as WhatsApp wants it: digits with the country code. Israeli formats
 * (050-1234567, 501234567 after Excel drops the 0, +972 50..., 972-050...) become 9725XXXXXXXX.
 * An Israeli number that is not a mobile is refused. Other countries need + or 00.
 * @returns {string | null}
 */
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim();
  let d = text.replace(/[\s\-().]/g, '');
  const international = d.startsWith('+') || d.startsWith('00');
  d = d.replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d+$/.test(d)) return null;
  if (!international && d.startsWith('0')) d = `972${d.slice(1)}`;
  else if (!international && /^5\d{8}$/.test(d)) d = `972${d}`;
  if (d.startsWith('9720')) d = `972${d.slice(4)}`;
  if (d.startsWith('972')) return /^9725\d{8}$/.test(d) ? d : null;
  return international && /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

/**
 * Lines of "phone, name" (comma, semicolon or tab), as saved from Excel as CSV or pasted.
 * The phone may be in any column; the first other cell with letters is the name.
 * A first line without a phone is a header. Other lines without a valid phone are invalid.
 * @returns {{rows: Array<{phone: string, name: string}>, invalid: Array<{line: number, text: string}>}}
 */
function parseRecipientList(text) {
  const rows = [];
  const invalid = [];
  let first = true;
  String(text || '').replace(/^﻿/, '').split(/\r\n|\n|\r/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || /^[,;\t\s"]*$/.test(line)) return;
    const isFirst = first;
    first = false;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    let phone = null;
    let name = '';
    for (const cell of cells) {
      const p = phone ? null : normalizePhone(cell);
      if (p) phone = p;
      else if (!name && /\p{L}/u.test(cell)) name = cell;
    }
    if (phone) rows.push({ phone, name });
    else if (!isFirst) invalid.push({ line: i + 1, text: line.slice(0, 80) });
  });
  return { rows, invalid };
}

/** Text of an uploaded file: UTF-8, or Windows-1255 (Hebrew Excel CSV) when it is not valid UTF-8. */
function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1255').decode(buffer);
  }
}

function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[.,!?;:"'׳״()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function advances(from, to) {
  if (to === 'failed') return from !== 'failed';
  return (STATUS_RANK[to] ?? -1) > (STATUS_RANK[from] ?? -1) && from !== 'failed';
}

function describeError(err) {
  if (err instanceof WhatsAppError) return `${err.code ?? err.status ?? ''} ${err.message}`.trim().slice(0, 300);
  return String((err && err.message) || err).slice(0, 300);
}

function recipientId(campaignId, index) {
  return `${campaignId}:${String(index + 1).padStart(6, '0')}`;
}

// A WhatsApp message ID may hold characters a record ID cannot ("/"), so it is hashed.
function messageKey(messageId) {
  return crypto.createHash('sha256').update(String(messageId)).digest('hex').slice(0, 40);
}

function daysBetween(fromDate, toDate) {
  const ms = (d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(toDate) - ms(fromDate)) / 86400000);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = {
  createOutbound,
  normalizePhone,
  parseRecipientList,
  decodeText,
  DEFAULT_RAMP,
  DEFAULT_OPT_OUT_WORDS,
  PAUSE_CODES,
};

# Changelog

Bots pin a tag (README.md). Every version passes T-01 to T-17 and the DRY RUN (T-09)
before it is tagged (documents/test-plan.md). Details per change: documents/project-log.md.

## 1.2.0 - 2026-11-18

Reply hours per bot (decisions.md item 58). Bots on 1.0.0 or 1.1.0 are not affected;
on 1.2.0 nothing changes unless the bot passes the new option.

- `createBot({ replyHours: 'always' })` answers customers at any hour, every day. The
  default `'window'` keeps Sunday to Thursday 09:00 to 17:50.
- Campaigns, signup links and test-mode questions keep the send window. Test T-25.

## 1.1.0 - 2026-10-28

Outbound messages for every bot (decisions.md items 46 to 51). Bots on 1.0.0 are not
affected until they upgrade; without the new `outbound` option nothing changes.

- Signup link: the dashboard sends a Meta-approved template with the link to one phone.
- Campaigns: upload a CSV or pasted list (Hebrew Excel CSV is read correctly), start and
  pause, status per recipient (waiting, sent, delivered, read, replied with the text,
  failed, opted out). The lead board shows which campaign a lead answered.
- Daily limit for the number: 100 a day in week 1, +50 a day each week, up to a ceiling
  (default 250), changed on the dashboard. Only inside the customer send window. The job
  `POST /jobs/send-campaigns` sends a small batch every 10 minutes.
- Opt-out: "הסר", "לא מעוניין" and similar words, or the template's quick-reply button,
  stop all outbound messages to that phone for good.
- Automatic pause and an alert to the owner (new notification event `campaign_alert`) on
  Meta limit errors, quality warnings, paused templates or ten failures in a row.
- WhatsApp client: `parseEvents` (statuses, quality, template updates), URL button
  parameter in `sendTemplate`. Tests T-18 to T-24.

## 1.0.0 - 2026-10-26

First release of the base (stages 0 to 2 in documents/spec.md section 8).

- WhatsApp: webhook with verify token and signature check, duplicate message filter,
  text and template sending, media download, defined reply to message types the bot
  does not read (T-17).
- Conversation engine: AI reply through one tool, handoff to an agent (the customer is
  thanked first), accepted media stored for the dashboard, send window Sunday to
  Thursday 09:00 to 17:50 Israel time with holidays.
- Storage on Firestore with an in-memory fake for tests; scheduled jobs that run once
  per key (T-08); reminders by DD/MM/YYYY date (F-16); archive.
- Test mode: tester phones, end keyword, feedback questions, prompt recommendations
  approved by the owner.
- Agent dashboard: lead board, lead page with transcript and media, status change,
  test-mode trials, recommendations. Login form and signed cookie, CSRF, no token in a
  URL (T-16), every field escaped.
- Email through SendGrid, every field escaped (F-22).
- Notifications: email by default, WhatsApp to the agent per event; daily summary at
  18:15, week on Thursday, previous month on the 1st (decisions.md items 42 to 44).
- Health check with alerts to the owner.
- Tooling: GitHub Actions with the Firestore emulator, release check, DRY RUN, manual
  real-environment check.

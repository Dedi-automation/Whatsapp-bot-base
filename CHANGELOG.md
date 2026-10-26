# Changelog

Bots pin a tag (README.md). Every version passes T-01 to T-17 and the DRY RUN (T-09)
before it is tagged (documents/test-plan.md). Details per change: documents/project-log.md.

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

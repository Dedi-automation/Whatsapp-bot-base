# Decisions

Last updated: 2026-10-26 (stage 2)

## Decided (approved by project owner)

1. Start: new project. MyDoctor stays read-only reference.
2. Fixes: only in the new base, not in MyDoctor.
3. Base repo: whatsapp-bot-base, private.
4. Storage: Firestore, one Firestore project per bot (changed 2026-10-26, see item 21).
5. Contracts include B2 (security) and B4 (schema). B4 comes before B3.
6. Secrets: new keys and tokens in the new project. README is not copied.
7. AI model for first build: Haiku 5.5 (sufficient for now).
8. Billing (Grow) and employee/commission modules: outside the base.
9. One bot per agent, built on a locked base version. Copy and swap of token, profile and sources without code changes.
10. Transcripts kept until the end of the travel insurance policy; otherwise agreed with the agent.
11. Ofir lead routing: outside the base; specified separately.
12. Prompts, prices, reminders and outbound messages: per bot.
13. Demo bot: conversation only.
14. Test setup: separate Firestore project, separate test WhatsApp number, test data only.
15. Distribution: versioned package, pinned per bot. Upgrades are explicit.
16. Documents: all four files are stored in git under `documents/`.
17. Send window ends at 17:50 inclusive. Nothing is sent after 17:50 on any day. Window: Sunday to Thursday, 09:00 to 17:50 Israel time.
18. AI model string: `claude-haiku-5-5`, verified against public docs (docs.claude.com, AIMLAPI, LLMReference). Config only; there is no default in code.
19. Archive rules are set per bot. The base keeps placeholder config only.
20. Transcript is stored as one record per message. Retention is set per bot.

Decided 2026-10-26 (Dedi's answers during step 1):

21. One Firestore project per bot, not one collection per bot. One agent may run several bots, and similar bots run for different agents (T-05).
22. Firestore environment variables: `FIRESTORE_PROJECT_ID`, `FIRESTORE_EMULATOR_HOST`, `GOOGLE_APPLICATION_CREDENTIALS`.
23. Firestore tests need the emulator. Without it they are reported as "not run", never as passed. They must run with the emulator before a merge.
24. The HTTP server and the WhatsApp webhook route are built in step 1 (branch B), with the routes from spec Appendix B.
25. Duplicate messages: the bot checks the message ID before it saves the message, and ignores a message it already received, so the customer never gets two replies.
26. Handoff to the agent: the bot thanks the customer first, then the handoff is recorded for the agent.
27. A prompt value that contains only spaces counts as missing (explicit error).
28. Default `max_tokens` for an AI reply is 1024.
29. Archive start date is the bot's go-live (production) date, set in config at launch. Records start new at go-live.
30. Reminders follow the MyDoctor reminder pattern. The reminder date field is `callbackDate`.
31. Dates are always generated automatically in the correct format. A malformed date is an error that names the record.
32. All media a customer sends is stored in the bot's database and shown on the agent's dashboard. Test-mode screenshots are stored the same way.
33. Each bot sets which media types it accepts (for example an ID photo: image or document). An accepted file is saved and acknowledged. For any other format the bot replies with the formats it accepts ("I accept files only as ..."), filled in from the bot's config. Specific bot behavior is defined in stage 2.
34. Test-mode feedback questions are fixed text per bot, from config. Feedback and conversations produce recommendations to improve the prompt, as in MyDoctor; the owner approves each change manually, nothing is applied automatically. This keeps improvement-review.js (F-23) in the base, inside test mode, with one trial per AI call.
35. The health check sends a real WhatsApp message on every run. The recipient is set in config: the owner's test number now, the clerk's or client's number in production. A copy of every failed check goes to the owner (`HEALTH_CHECK_ALERT_PHONE`).
36. Health check messages and failure alerts to the owner are sent at any day and hour, outside the send window. At go-live, who receives alerts and when is set per client.
37. Every branch runs its tests and a dry run before commit and merge, and records each test run (date, commit, result, rollback point).
38. B10 (email to the agent) and B11 (admin dashboard, the agent's lead board) move to stage 2. They are rebuilt from the MyDoctor logic, not copied: email.js keeps its logic and escapes every field (F-22); the admin dashboard is rewritten (F-01, F-04, F-12, F-21). The agent dashboard that shows media and test-mode notes (items 32, 34) is part of B11.

Decided 2026-10-26 (Dedi approved the stage 2 plan):

39. No token in any URL (F-04). Scheduled jobs send the job token in the Authorization header. The agent's dashboard uses a login page; the admin token is posted once and the server sets a signed session cookie (HttpOnly, Secure, SameSite=Strict). Every change on the dashboard is a POST with a CSRF field.
40. Email (B10) goes through the SendGrid HTTP API. SENDGRID_API_KEY, SENDGRID_FROM_EMAIL and NOTIFY_EMAIL are set all together or not at all. Emails link to the dashboard and never carry a token.
41. Stage 2 is built and tested from the cloud session and GitHub Actions; the owner does not run commands locally. The real test environment check runs as a manual GitHub Actions workflow with repository secrets.

Decided 2026-10-26 (Dedi, after stage 2):

42. Notifications to the agent and owner: email is the default channel, sent automatically to the configured address (NOTIFY_EMAIL). WhatsApp to the agent is optional, per bot and per event, when needed or asked for (AGENT_WHATSAPP_PHONE, AGENT_WHATSAPP_EVENTS, AGENT_WHATSAPP_TEMPLATE). Events: a customer asked for an agent, the daily summary, the monthly summary, a prompt improvement suggestion.
43. The agent gets a daily summary at 18:15 Israel time (the scheduler calls POST /jobs/send-daily-digest). Like health alerts (item 36), messages to the agent and owner are sent at any hour; the 17:50 window applies to customers only.
44. Weekly and monthly summaries (Dedi, 2026-10-26). Each daily summary saves the day's counts (daily_summaries/<date>). On Thursday the daily message also sums the 7 days ending that day (Friday to Thursday). On the 1st of the month a separate message sums the previous month, broken down by weeks ending on Thursday. A day with no saved counts is reported as missing. The monthly invoice comes from Grow in its own email; billing stays outside the base (item 8). A bot may add one line about the invoice (createBot option monthlyNote).

Decided 2026-10-26 (stage 3; Dedi: "continue to stage 3 and finish the base"):

45. Release 1.0.0. Tags are `vX.Y.Z` on main, created only after the release PR is merged, the release check (T-01 to T-17) and the DRY RUN pass on main, and the result is in project-log.md. A bot pins a tag in its package.json (`github:Dedi-automation/Whatsapp-bot-base#v1.0.0`); upgrades are explicit (item 15, T-15). A bot receives only `src/`. Node.js 22 or later (the version CI runs; the test runner needs 21+). The real WhatsApp and SendGrid checks need test keys and a public URL, so they move to the first bot's deployment (stage 4); the real Firestore check runs before the tag when its secrets are fixed.

Decided 2026-10-28 (Dedi: outbound messages in every bot, base 1.1.0):

46. Every bot can send outbound WhatsApp messages from the dashboard: (a) a signup link to one customer, entered by phone, as a Meta-approved template; (b) a campaign: a list of customers gets a Meta-approved marketing template. The list is uploaded on the dashboard (CSV, or pasted lines of phone and name); a bot may add recipients from code (for example from a CRM such as Surense).
47. Daily limit with a weekly ramp, shared by the whole WhatsApp number (all campaigns together): 100 per day in the first week, plus 50 per day each week (Dedi). The first week starts on the day the first campaign starts sending. The limit stops at a ceiling, default 250 per day (the usual Meta limit for a new number), changed on the dashboard when Meta raises the number's tier (proposed default, waiting for Dedi's answer). Manual signup links count toward the day but are not blocked by it.
48. Campaign messages go only inside the customer send window (Sunday to Thursday, 09:00 to 17:50, not on holidays, item 17). The scheduler calls POST /jobs/send-campaigns every 10 minutes; each run sends a small batch (default 25), so the day's messages are spread out. A manual signup link outside the window is refused with a clear message, not queued.
49. Opt-out: a customer who answers with an opt-out word ("הסר", "לא מעוניין", "לא מעוניינת", "הסירו אותי", "stop", or the template's quick-reply button with that text) is never sent a campaign or signup message again from this bot. The bot confirms once (inside the send window). The dashboard can add a number to the opt-out list; it cannot remove one. The template itself carries the opt-out option (Dedi: the 5,000 are existing customers of the agent; the template is approved by Meta and says how to opt out).
50. Automatic pause: a campaign stops sending, and the owner gets a campaign_alert notification, when Meta reports a problem: the number's quality is flagged or its limit is lowered, the template is paused, disabled or rated red, or a send fails with a Meta limit or block error. Ten failed sends in a row also pause it. Only a person resumes a paused campaign on the dashboard.
51. Every recipient has a status on the dashboard: waiting, sent, delivered, read, replied (with the customer's text and a link to the conversation), failed (with the reason), or opted out. A lead who answers a campaign shows the campaign's name on the lead board. A phone appears once per campaign; a phone in Israeli format (05X...) is converted to 9725X....
52. The campaign screen is part of the agent's dashboard in every bot (Dedi, 2026-10-28). The agent chooses how to fill a list: upload a file or paste it, or pull it from the client's CRM (Surense, BAFI and similar). The CRM pull is built per bot, on the base's `addRecipients`, when the CRM's API access exists; both ways feed the same campaign, daily limit and opt-out list.

Decided 2026-11-02 (Dedi: one billing model for every bot, the same agents buy MyDoctor and custom bots):

53. One agent, one WhatsApp number and one cloud project for all of the agent's bots (MyDoctor and custom bots alike), so costs per agent are clear. The agent pays Meta for WhatsApp from the agent's own account; Dedi pays the cloud and the AI.
54. A conversation, in every bot: all messages from one customer phone within 24 hours, opened by a customer message (the bot's own opening messages or reminders with no reply do not open one). A conversation has at most 30 bot replies (every reply the bot sends counts, AI or fixed text). At 30 the bot sends a fixed thank-you text and hands off to the agent like a regular handoff (item 26), reason "30 replies in a conversation"; after that handoff the bot stays silent until 24 hours from the conversation's start, and the next message opens a new conversation. A regular handoff does not silence the bot.
55. Pricing per agent, one shared pool for all of the agent's bots, counted per calendar month (Israel time): MyDoctor 250 ILS a month adds 500 conversations; a custom bot 650 ILS a month adds 1,000 conversations (both: 900 ILS, 1,500). Above the pool, for every bot: a pack of 500 more conversations for 150 ILS, valid until the end of the month. This replaces the earlier proposal (2,000 conversations for 1,000 ILS, 0.80 ILS per conversation above that).
56. Grow has no API for us, only webhooks, so nothing is charged automatically. The agent buys a pack through a Grow payment link. When 50 conversations remain the agent gets a WhatsApp template with the link and Dedi gets an email; when none remain (no pack bought), the same again. The bot never stops answering because of the pool.
57. Grow payments: a successful subscription payment (first or monthly) sets the agent's subscription status to active and the next charge date (payment date + 1 month), and emails only Dedi (Grow sends the agent the invoice, item 44). A failed monthly charge sets the status to "payment failed" and emails Dedi at once; the bot keeps working. A paid pack adds 500 conversations for the current month. Payments are identified by Grow product name, the amount only as a fallback; anything else is ignored. Billing code stays per bot (item 8); a shared conversation counter across an agent's bots comes into the base with the first agent who has MyDoctor and a custom bot. Built first in MyDoctor (mydoctor-whatsapp-bot, CODEFIX group 8).

## Proposed, not yet approved

- Source of truth for documents: git. Claude Docs pages are read-only views refreshed from git.
- Use the existing D&D Meta business account for WhatsApp testing.

## Open

- Revocation of the old service key: confirm it is disabled in Google Cloud.
- Who besides the agent can see test-mode notes (storage is decided, item 32).

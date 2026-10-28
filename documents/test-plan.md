# Test plan

Every release must pass all tests below before it is tagged. Tests marked TO VERIFY describe the expected result; their setup still has to be confirmed.

## Base tests (T-01 to T-11)

- T-01 Config: startup fails when a required variable is missing. Error is clear, no silent start. (B1, F-14)
- T-02 Security: a webhook request with an invalid signature is rejected and not processed. (B2, F-04)
- T-03 WhatsApp: the same message ID received twice is processed once. (B2, B5)
- T-04 Send window: messages are not sent outside Sunday to Thursday, 09:00 to 17:50, or on holidays. (B8)
- T-05 Data: two bots with two Firestore projects never see each other's records. (B3)
- T-06 AI: the AI reply is accepted only if it matches the tool schema; otherwise it is rejected, not sent. (B6)
- T-07 Prompt: a missing template variable causes an explicit error, never an empty value. (B6, F-10, F-29)
- T-08 Jobs: two runs of the same scheduled reminder send one message only. (B9, F-06)
- T-09 DRY RUN: the full flow runs, nothing real is sent, and the messages that would have been sent are logged. (all)
- T-10 Demo: a complete test conversation finishes with 4 to 6 questions to the agent. (B7, section 9)
- T-11 Transcript: a transcript is saved and survives a restart. (B3, B7)

## Added 2026-10-23

- T-12 Schema: startup fails if a required field header is missing or renamed. (B4, F-07, F-12)
- T-13 Config: startup fails with a clear error when a required environment variable is missing. (B1, F-14)
- T-14 Prompt: rendering fails when a template variable is missing; it never sends an empty value. (B6, F-10, F-29)
- T-15 Version pin: a bot built on base 1.0.0 keeps running after the base receives a new tag until it is upgraded on purpose. (section 2)
- T-16 Security: admin and job tokens are accepted in headers only; a token in the URL is rejected. (B2, F-04, F-05)
- T-17 Non-text messages: an incoming voice note or image gets a defined reply, not silence. (B5, F-20, TO VERIFY)

## Added 2026-10-28 (base 1.1.0, outbound messages, decisions.md items 46 to 51)

- T-18 Lists: Israeli phone formats become 9725XXXXXXXX; landlines and junk are refused; a CSV (UTF-8 or Hebrew Windows-1255) or pasted list is read with its header skipped and bad lines reported; a phone is added once per campaign. (outbound, admin)
- T-19 Daily limit: 100 a day in week 1, +50 each week, up to the ceiling; the limit is shared by all campaigns and counts signup links; each job run sends one small batch. (outbound)
- T-20 Send window: the campaign job sends nothing outside Sunday to Thursday 09:00 to 17:50 or on holidays; a signup link outside the window is refused. (outbound, B8)
- T-21 Opt-out: an opt-out word or the template's "not interested" button is recorded, confirmed once, does not reach the AI, and the phone gets no campaign or signup message again. (outbound, B7)
- T-22 Automatic pause: a Meta limit or block error, a quality warning on the number, a paused or red template, or ten failed sends in a row pause the campaign and alert the owner; the recipient is sent after a person resumes. (outbound)
- T-23 One send per recipient: overlapping job runs, duplicate rows and uploads never send twice to the same phone in a campaign. (outbound)
- T-24 Recipient status: Meta's delivered, read and failed statuses update the recipient, forward only, with the failure reason; a customer's reply marks the recipient "replied" with the text and tags the lead with the campaign. (outbound, B5, B7)

## Release procedure

1. Run T-01 to T-24. Stop at the first failure.
2. Record the results in project-log.md: date, version, test IDs run, result, DRY RUN result.
3. Project owner approves the release.
4. Tag the version.

Rule: every bug found in practice gets a new test with a new ID and a log entry.

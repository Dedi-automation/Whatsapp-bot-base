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

## Release procedure

1. Run T-01 to T-17. Stop at the first failure.
2. Record the results in project-log.md: date, version, test IDs run, result, DRY RUN result.
3. Project owner approves the release.
4. Tag the version.

Rule: every bug found in practice gets a new test with a new ID and a log entry.

# Decisions

Last updated: 2026-10-23

## Decided (approved by project owner)

1. Start: new project. MyDoctor stays read-only reference.
2. Fixes: only in the new base, not in MyDoctor.
3. Base repo: whatsapp-bot-base, private.
4. Storage: Firestore, one collection per bot.
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

## Proposed, not yet approved

- Source of truth for documents: git. Claude Docs pages are read-only views refreshed from git.
- Postpone B10 (email) and B11 (admin dashboard) to a later phase.
- Admin and job tokens sent in headers, not in URLs.
- Use the existing D&D Meta business account for WhatsApp testing.

## Open

- Revocation of the old service key: confirm it is disabled in Google Cloud.
- Firestore variable names (for example FIRESTORE_PROJECT_ID). Set in step 0.
- Exact model string for Haiku 5.5 (verify before B6).
- Where test screenshots are stored and who can see the notes.
- Whether improvement-review.js (F-23) is kept in the base at all.

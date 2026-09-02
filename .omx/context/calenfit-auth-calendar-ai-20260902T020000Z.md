# Calenfit Auth + Calendar + AI Ralph Context

## Task

Advance the Calenfit challenge MVP to a submission-ready flow: leave Kakao AlimTalk as planned work, implement login/profile-driven policy matching, Google Calendar server integration contracts, and a Grok-compatible AI placeholder that feeds safe event classification into policy recommendations.

## Desired outcome

An evaluator can sign in with a supported provider or email flow when configured, complete a profile, connect Google Calendar through a backend endpoint, import normalized events, and see policy candidates recalculated. The static demo remains usable without credentials and never fakes external success.

## Constraints

- No secrets, OAuth tokens, phone numbers or provider keys in frontend, localStorage or Git.
- Kakao AlimTalk is documented as future work; no live delivery now.
- Grok API is not yet supplied, so implement a server-proxy placeholder contract and local fallback.
- AI may classify/contextualize events only; deterministic policy rules decide candidate status.
- Preserve existing functionality and tests; no remote repository changes.

## Known facts

- Static dependency-free app at `2026-금융-AI-Challenge/`.
- Existing local classifier, policy matching, ICS parser, event CRUD, evidence/task state and Google endpoint placeholder.
- Current seeds include interview, exam, Hanam basic income, youth savings follow-up and future-tomorrow work-experience examples.
- Current local server runs at `http://localhost:8000`.

## Likely touchpoints

`app.js`, `index.html`, `calendar-focus.css`, `tests/app.test.js`, `tests/e2e.mjs`, `docs/ARCHITECTURE.md`, `docs/FEATURE-SPEC.md`, `README.md`, plus a no-secret server integration contract document.

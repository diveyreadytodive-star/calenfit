# Calenfit Connected Calendar Ralph Context

## Task
Build a submission-ready Calenfit MVP for the 2026 Financial AI Challenge: calendar integration, AI candidate analysis, policy matching, evidence actions, and notification channel demo adapters.

## Desired outcome
A no-login demo can use a self-managed September 2026 monthly calendar, import ICS, preview Google OAuth integration, classify events with AI adapter/fallback, map policy candidates, and schedule safe notification payloads. Documentation must explain production OAuth/token/webhook/message architecture.

## Known facts
- Static dependency-free app in .
- Existing local classifier, policy rules, event CRUD, ICS, evidence/recovery and E2E tests.
- Current visual direction: bold yellow/black hero; monthly calendar is the internal primary surface.
- Existing AI settings are session-only and must not leak secrets.

## Constraints
- No real credentials, API secrets, phone numbers, OAuth tokens or external message delivery.
- AI may classify/summarize only; explicit policy rules decide eligibility/status.
- Preserve existing tests and functionality; do not delete tests.
- No real policy crawling; use verified snapshots and adapters.

## Unknowns
- Provider credentials and production backend are unavailable.
- Apple/iCloud/Android direct sync is a documented extension, not a first-pass live integration.

## Touchpoints
- , , , , , 
- , 
- , , new architecture/demo/proposal docs

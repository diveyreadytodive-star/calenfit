# Calenfit Authenticated MVP Ralph Context

## Task

Deliver the Calenfit submission as an authenticated MVP, not a demo: anonymous users must see only login/service introduction and no seeded profile, events, policies, evidence, or private settings. Authenticated users need server-backed account/session/profile data, direct event entry without a calendar connection, Groq server-proxy analysis, deterministic policy recommendations, and Google OAuth-ready calendar sync. Kakao AlimTalk remains future work.

## Desired outcome

An evaluator can create an account or log in, complete a personalized profile, add an event from the browser, run Groq analysis through the server, and see policy candidates recalculated for that account. Logout or expired sessions clear the private surface. The flow works without credentials using safe empty states and local AI fallback, but never displays fake user data.

## Constraints

- Never commit or persist API keys, OAuth secrets, session tokens or refresh tokens in frontend storage, source, Git or logs.
- Groq key is server process environment only; no direct browser-to-Groq call.
- Google tokens stay server-side; use PKCE, state/session binding and encrypted storage.
- Kakao AlimTalk is explicitly deferred.
- Preserve existing regression tests and add server/browser coverage; no test deletion or remote changes.

## Current evidence

- Existing `server.mjs` has account endpoints, Google/Groq contracts and local in-memory persistence.
- Existing `app.js` has local event/policy logic, but must gate seed state and correctly synchronize auth/profile.
- Prior architect findings identified stale demo seed exposure, browser profile persistence ordering and auth state drift; these are in scope to close.

## Touchpoints

`server.mjs`, `app.js`, `index.html`, `calendar-focus.css`, `tests/app.test.js`, `tests/server.test.mjs`, `tests/e2e.mjs`, `README.md`, `docs/ARCHITECTURE.md`, PRD/test-spec state files.

# Calenfit Connected Calendar Test Specification

## Unit / contract tests

- 기존 분류·정책·ICS·CRUD·증빙·저장 테스트 유지.
- Calendar provider adapter contract: Google placeholder 상태, ICS 성공/실패, Calenfit CRUD.
- AI adapter contract: 제목·설명·시간만 전달, 유효 결과, schema 위반, 실패 fallback, 정책 판단 필드 거부.
- Policy source snapshot: 공식 URL/checkedAt 보존, 상태별 CTA와 unknown 보수성.
- Notification adapters: 채널 미설정, 동의 없음, 데모 예약 payload, credential 없는 발송 차단, 실패 mock.
- profile change recalculates policy matches without changing AI output.
- secret hygiene: API key/phone never in localStorage, rendered HTML, console or logs.

## Browser E2E

1. Landing → 로직 맵 → 데모 시작, 2026-09 월간 캘린더 노출.
2. 면접·시험 일정과 날짜 셀 태스크/정책 위험 표시.
3. 자체 캘린더 일정 추가·수정·삭제와 새로고침 지속.
4. ICS invalid → readable error → valid preview → import success.
5. Google 연결: 미설정 → 대기 → mock success / permission denied.
6. AI 미설정 fallback, proxy mock valid, malformed/failure fallback.
7. 정책 open/closed/exhausted/unknown CTA 전환.
8. 알림 channel/consent/scheduled/failed outbox state.
9. evidence metadata only, XSS-safe rendering, console errors 0, network external mutation 0.
10. 390×844 및 1440×900 screenshots; horizontal overflow 0.

## Commands

```sh
node tests/app.test.js
node tests/e2e.mjs
node --check app.js
```

## Exit criteria

모든 단위/E2E 검증 통과, 문서·링크·자산 검사 통과, architect `APPROVED`, 새 저장소 생성·외부 원격 변경 없음.

## Iteration 2 additions

- login demo/server-configured states; profile setup persistence and recalculation after profile edits.
- auth tokens absent from localStorage/sessionStorage/DOM/logs; logout clears session projection.
- Google start/callback/disconnect/sync contracts, normalized events, missing-backend honest failure, token-free browser state.
- Grok proxy request sends only title/description/startTime; valid response, malformed response and network failure fallback to local classifier.
- policy candidate aggregation shows interview, exam, Hanam basic income and work-experience candidates with official provenance.
- Kakao AlimTalk remains visibly planned and is never sent.

## Iteration 3 additions

- Fresh browser load without a cookie: login surface visible; profile summary, calendar events, policy cards, evidence, and private controls absent/empty.
- Seed data is never restored for anonymous localStorage; logout clears rendered/private state and subsequent reload remains anonymous.
- Signup/login/session/logout/profile API flow is exercised through the browser, not only direct HTTP tests.
- Authenticated direct event creation sends only allowed fields to `/api/ai/analyze`, updates event type, and refreshes policy matches.
- Groq 200, malformed response, 401/429/5xx and timeout all preserve local fallback and never expose the key.
- User A and User B have isolated profiles/events/policy results.

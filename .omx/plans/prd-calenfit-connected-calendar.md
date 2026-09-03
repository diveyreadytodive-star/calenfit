# Calenfit Connected Calendar MVP PRD

> 2026-09-02 인증 MVP 개정: 비로그인 시드와 데모 로그인은 폐기한다. 서버 세션을 인증의 유일한 기준으로 사용하고, 회원가입 직후 빈 계정과 프로필 온보딩을 제공한다. 프로필·일정·Google 연결은 userId별 서버 저장 데이터만 렌더링한다. Google Calendar는 설정된 환경에서 PKCE callback, 암호화 token, refresh, 증분 sync까지 실제 동작한다.

## Product

**슬로건:** AI가 내 일정을 읽고, 받을 혜택을 찾습니다.

캘린핏은 일정 신호를 AI가 분류하고, 정책 규칙 엔진이 공식 정책 후보와 증빙 행동을 연결하며, 사용자가 선택한 채널의 알림 예약 payload를 보여주는 금융 AI Challenge 제출용 웹 데모다.

## User stories

### US-001 — 로그인 없는 월간 캘린더

가상 사용자는 로그인 없이 2026년 9월 월간 캘린더에서 면접·시험 일정, 정책 상태, 마감 위험, 증빙 태스크를 한눈에 보고 날짜를 클릭해 상세를 연다.

- 내부 첫 화면은 월간 캘린더다.
- 일정 유형·태스크·위험 상태가 날짜 셀에 표시된다.
- 기존 랜딩 히어로와 로직 맵은 유지하고 부드러운 이동을 제공한다.

### US-002 — 일정 입력과 provider 상태

사용자는 자체 캘린더에 일정을 CRUD하고 ICS를 미리보기 후 가져오며, Google Calendar 연결은 OAuth placeholder의 설정 필요/대기/성공 mock/권한 거부 상태를 구분해 본다.

- `CalendarProviderAdapter`, Google/ICS/Calenfit 구현.
- 실제 credential·token·외부 변경은 없다.
- 새로고침 후 자체 일정은 지속된다.

### US-003 — AI 맥락 분석과 수정

사용자는 제목·설명·시간만 AI 분석에 제공하고 일정 유형·신뢰도·짧은 근거·증빙 후보를 확인한 뒤 직접 수정한다.

- `AIAnalysisAdapter`와 로컬 fallback.
- 유효/잘못된/실패/미설정 상태를 정직하게 표현한다.
- AI는 자격, 예산 소진, 공고 유효성, 최종 신청 가능 여부를 결정하지 않는다.

### US-004 — 정책 후보와 provenance

사용자는 정책 후보마다 공식 URL·확인 시각·상태·불확실성을 보고 CTA가 상태에 따라 바뀌는 것을 확인한다.

- `PolicySourceAdapter`와 검증된 데모 snapshot.
- 정책 matching은 결정론적 규칙 엔진.
- 접수 중이 아니면 신청 가능처럼 표현하지 않는다.

### US-005 — 증빙 행동과 복구

사용자는 면접·시험 일정에서 D-7/D-3/D-1/당일/D+1 행동과 증빙 후보를 확인하고 체크 상태를 저장한다.

- 면접: 공고 저장, 확인서 요청, 미회신 후속.
- 시험: 영수증, 접수 확인, 응시 사실, 취업 상태 기록.
- 원본 문서는 보관하지 않고 메타데이터만 저장한다.

### US-006 — 알림 아웃박스

사용자는 웹/이메일/SMS/카카오 채널, 수신 동의, 예약 시각, payload, 실패 사유를 확인하고 데모 예약을 재현한다.

- `NotificationChannelAdapter`와 4개 채널 구현.
- credential 없는 실제 발송은 금지한다.
- 전화번호는 마스킹된 가상 번호만 사용한다.

### US-007 — 보안과 문서

심사자는 API 키·OAuth·알림 보안 경계와 실제 서비스 확장 구조를 UI·아키텍처·데모 스크립트·제안서·README에서 이해한다.

- API 키는 `sessionStorage`만 사용한다.
- OAuth token은 서버 암호화 저장 전제로 문서화한다.
- webhook, 동의, 삭제, 서버 proxy 경계를 문서화한다.

## Acceptance / verification

각 story는 기존 로직 테스트와 확장 단위 테스트, 브라우저 E2E, JS 문법 검사, 자산/링크 검사, 모바일·데스크톱 캡처로 검증한다. 완료 전 architect의 `APPROVED`가 필요하다.

## Iteration 2 — Auth, connected calendar, Grok placeholder

- 로그인은 데모 모드와 실제 provider-ready 모드를 분리한다. 심사자는 서버 설정 환경에서 이메일/Google provider로 로그인하고, 설정이 없으면 데모 흐름을 재현한다.
- 로그인 직후 출생일·거주지·학력/학년·취업 상태·목표·알림 동의 프로필을 저장하고, 프로필 변경 시 모든 이벤트의 정책 후보를 재계산한다.
- Google OAuth는 server start/callback/disconnect/status/sync contract와 normalized event schema를 제공한다. access/refresh token은 서버 전용이다.
- Grok adapter는 `/api/ai/analyze` proxy contract를 사용하고, 입력은 제목·설명·시작시각으로 제한한다. 실패·미설정 시 로컬 안전 분류기로 fallback한다.
- Kakao AlimTalk live delivery는 이번 iteration의 비목표이며 승인 템플릿·사업자 API·수신 동의가 필요한 후속 작업으로 문서화한다.

## Iteration 3 — Authenticated MVP gate

- Anonymous state is an explicit empty state: no seed profile/events/policies/evidence/private settings are rendered or restored.
- Signup/login establishes a server session; session restore is authoritative and logout/401 clears the private client state.
- Profile onboarding is required before private recommendations; profile persistence is server-backed when authenticated and recalculates only that user's matches.
- Direct event creation is available after login when Google is disconnected. It sends title, description and start time through the Groq proxy, then applies deterministic policy rules.
- The existing local classifier remains an offline fallback, but its output never causes anonymous data to appear.

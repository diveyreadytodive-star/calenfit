# Calenfit Architecture

## Browser/server boundary

정적 브라우저 데모는 가상 사용자·가상 일정, 자체 캘린더 CRUD, ICS local parse/preview, 로컬 AI fallback, 정책 snapshot/rules, 증빙 메타데이터, 비발송 알림 outbox만 담당한다. 외부 계정 변경, credential, token, 실제 발송은 서버 경계다.

```text
CalendarProviderAdapter -> Calenfit local | ICS | Google OAuth placeholder
  -> AIAnalysisAdapter (title, description, start time only)
  -> deterministic PolicySource/Rules (official URL, checkedAt, uncertainty)
  -> NotificationChannelAdapter -> Web | Email | SMS | Kakao demo outbox
```

## Google Calendar production path

브라우저는 `GET /api/calendar/google/connect`로 서버가 만든 PKCE/state authorization URL을 요청한다. callback 서버는 state를 검증하고 code를 교환한 뒤 refresh/access token을 암호화 secret store에 보관하며 브라우저에는 token을 반환하지 않는다. 서버는 최소 read scope로 이벤트를 normalize하고 cursor를 저장하며 `events.watch` webhook을 만료 전에 갱신한다. 401은 token refresh, 410은 full resync로 처리하고 disconnect 시 watch·token·projection·동의를 철회한다. 현재 UI의 설정 필요/대기/성공 mock/권한 거부는 모두 가상 상태다.

## AI, policy, privacy

AI 허용 출력은 type, confidence, 짧은 rationale, evidence candidates다. 자격·금액·예산·정책 상태·최종 신청 결정은 schema에서 거부하고 deterministic rules가 공식 snapshot을 평가한다. API key는 탭 `sessionStorage`와 HTTPS/server-relative proxy만 사용한다. OAuth token, SMS signing key, Kakao credentials는 서버 전용이다. SMS는 수신 동의·서버 키, Kakao는 승인 BizMessage template·동의·사업자 서버가 없으면 outbox에 차단 사유만 기록한다. iCloud/Android는 ICS·CalDAV 확장 계획이다.
## Local MVP endpoints

`node server.mjs`는 메모리 기반 로컬 계정과 HttpOnly 세션 cookie를 제공한다. Google은 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, 선택적 `GOOGLE_REDIRECT_URI`가 없으면 연결 endpoint가 503을 반환한다. Grok은 `XAI_API_KEY`, 선택적 `XAI_API_URL`, `XAI_MODEL`이 없으면 503을 반환하고 브라우저가 로컬 classifier로 fallback한다. 운영 배포에서는 users/sessions/token map을 Postgres·KMS/secret manager·queue로 교체하고 CSRF, rate limit, audit log를 추가해야 한다. Kakao AlimTalk 실발송은 이번 범위에서 제외한다.

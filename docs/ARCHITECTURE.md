# 캘린핏 아키텍처

## 경계

브라우저 `client.js`는 UI와 서버 API 호출만 담당합니다. 인증 여부, 프로필, 일정, Google 연결 상태의 유일한 기준은 `server.mjs`입니다. 인증 token, Groq key, Google access/refresh token을 브라우저 storage에 저장하지 않습니다.

```text
Browser UI
  ├─ /api/auth/*       → session/account
  ├─ /api/profile      → userId 소유 프로필
  ├─ /api/events       → userId 소유 일정
  ├─ /api/policies     → profile/event 규칙 기반 후보 + 공식 출처 탐색
  ├─ /api/ai/analyze   → Groq server proxy
  └─ /api/calendar/*   → Google OAuth/token/sync
                              ↓
                  local persistent store (MVP)
                  managed DB + KMS (production)
```

## 인증

이메일 비밀번호는 무작위 salt와 `scrypt`로 해시합니다. 세션 ID는 32바이트 난수이고 HMAC 서명 후 HttpOnly, SameSite=Lax 쿠키로 전달합니다. 서버가 만료 시각과 사용자 존재 여부를 확인합니다. 회원가입 직후 프로필은 `null`이며, 사용자가 출생연도·거주지·상태·학력·학교·전공·생활 목표를 직접 입력해 온보딩을 완료해야 합니다.

Google 로그인은 익명 브라우저용 일회성 HttpOnly nonce, OAuth state, PKCE verifier를 묶습니다. callback에서 Google userinfo의 검증된 이메일을 조회한 뒤 계정을 생성하거나 기존 계정에 로그인합니다. 카카오 로그인은 후속 범위입니다.

## Google Calendar

1. 로그인 세션이 `/api/calendar/google/connect`를 요청합니다.
2. 서버가 sessionId와 userId에 묶인 10분 만료 state 및 PKCE challenge를 생성합니다.
3. 최소 `calendar.events.readonly` scope와 offline access로 Google 동의 화면으로 이동합니다.
4. callback은 state/session/user를 모두 검증하고 일회 사용 후 폐기합니다.
5. token은 AES-256-GCM으로 암호화해 userId의 Google connection에 저장합니다.
6. 만료된 access token은 서버가 refresh token으로 갱신합니다.
7. 최초 동기화 후 `nextSyncToken`을 저장하고 다음 호출부터 증분 동기화합니다.
8. Google이 410을 반환하면 sync cursor를 버리고 전체 동기화합니다.
9. provider event ID로 내부 일정을 upsert하고 cancelled event를 제거합니다.
10. disconnect는 connection과 Google projection을 제거합니다.

운영 환경에서는 callback URI를 고정 HTTPS 주소로 등록하고, token 암호화는 KMS envelope encryption으로 교체합니다. `events.watch` webhook은 사용자·calendar별 channel ID/token/expiration을 DB에 저장하고 만료 전 queue job으로 재발급해야 합니다. webhook 본문에는 변경 상세가 없으므로 알림을 받으면 증분 sync를 예약합니다.

## AI와 정책 규칙

Groq 입력은 일정 제목·설명·시각으로 제한합니다. 출력은 유형, 신뢰도, 짧은 근거, 증빙 후보, 의도 태그와 제한된 정책 분야 enum만 허용합니다. 규칙 엔진이 이 분야를 검증된 공식 정책 카탈로그에 연결하며, 키워드 규칙은 AI 장애와 명백한 신호 누락을 막는 fallback입니다. 직접 추가 일정과 새 Google 동기화 일정 모두 분석 대상입니다. 정책 자격·금액·예산·공고 유효성·최종 신청 여부는 AI가 결정하지 않습니다.

일정 생성·수정 API는 브라우저가 전송한 `type`, `policyDomains`, `intentTags`, `classificationSource`를 권한 있는 분석 결과로 사용하지 않습니다. 서버는 제목·설명·날짜만 정규화한 뒤 Groq proxy 또는 로컬 분류기로 다시 계산하고, 저장된 서버 결과만 정책 규칙 엔진에 전달합니다. 따라서 enum 형태로 조작된 클라이언트 메타데이터도 정책 후보를 만들 수 없습니다.

프로필 저장 시에도 학교·전공·상태·생활 목표를 같은 제한된 정책 분야로만 분석해 `intentDomains`와 `intentTags`를 서버에 저장합니다. Groq 장애나 429에서는 로컬 도메인 추론을 저장하며 정책 ID와 자격 상태는 계속 deterministic rules engine이 정합니다. 현재 세부 분야에는 일경험·실업·장학·자산형성·결혼·출산·보육·마음건강·교통이 포함됩니다.

`policy-sources.mjs`는 정책 URL의 운영기관, 확인 시각, 수집 방식, 불확실성을 정규화합니다. 현재 카드 데이터는 공식 페이지를 사람이 검증한 스냅샷이며 실시간 크롤링 결과가 아닙니다. 범위 밖 입력에는 온통청년·정부24 혜택알리미·복지로·고용24와 경기·서울·부산·광주 청년포털을 공식 탐색 경로로 반환합니다. 학교명이 있으면 `ac.kr` 범위에서 학교·학과 공지를 찾는 locator를 추가하지만 검색 결과를 자동으로 정책으로 확정하지 않습니다.

온통청년과 고용24 Open API는 승인 키가 필요한 별도 adapter 경계입니다. 서버 환경변수 유무를 `configured` 또는 `approval-required`로 구분하며, 승인 전에는 live catalog로 표시하지 않습니다. 운영형 수집기는 원문 snapshot/hash, source ID, 조회·상태확인 시각, 파서 버전과 실패 상태를 DB에 저장해야 합니다.

`scripts/verify-policy-sources.mjs`는 카탈로그와 포털 URL을 실제 요청하고 허용된 공식 hostname, HTTP 도달 여부와 최종 URL을 JSON 감사 산출물로 기록합니다. 이 검사는 페이지가 살아 있음을 증명하지만 내용의 자동 파싱이나 자격 최신성을 대신하지 않습니다.

## 로컬 MVP와 운영 차이

로컬 실행은 권한 0600의 JSON 파일을 사용하고, Vercel Production은 Neon PostgreSQL의 `calenfit_state` JSONB 레코드를 사용합니다. 계정·세션·OAuth transaction·일정·Google connection이 영속 저장되며 revision 기반 낙관적 잠금으로 충돌을 감지합니다. Vercel 암호화 환경변수에는 DB URL, 세션 암호화 키, Groq 키를 저장합니다. 트래픽 확장 시 엔터티별 관계형 테이블, Redis rate limit, KMS, audit log, sync queue로 분리합니다.

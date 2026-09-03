# 캘린핏 (Calenfit)

`AI가 내 일정을 읽고, 받을 혜택을 찾습니다.`

캘린핏은 로그인한 사용자의 프로필과 일정만 서버에서 불러와 면접·시험·창업 일정을 분류하고, 확인할 정책 후보와 증빙 행동을 연결하는 MVP입니다. 비로그인 사용자도 빈 월간 달력을 둘러볼 수 있지만 개인 프로필·일정·정책 추천은 렌더링하지 않습니다.

## 실행

Node.js 20 이상에서 다음과 같이 실행합니다.

```bash
CALENFIT_SESSION_SECRET='충분히 긴 임의 값' node server.mjs
```

로컬 secret은 `.env.example`을 `.env.local`로 복사해 채운 뒤 다음처럼 실행할 수도 있습니다.

```bash
node --env-file=.env.local server.mjs
```

브라우저에서 `http://localhost:8000`을 엽니다. 로컬 실행의 계정·프로필·일정은 기본적으로 `.data/calenfit.json`에 저장되며 Git에서 제외됩니다. Vercel에서는 연결된 Neon PostgreSQL을 사용합니다.

## 환경변수

```text
CALENFIT_SESSION_SECRET  세션 서명과 OAuth token 암호화 키. 운영환경 필수
CALENFIT_DATA_FILE       로컬 MVP 데이터 파일 경로(선택)
GROQ_API_KEY             서버 전용 Groq 키
GROQ_MODEL               기본 openai/gpt-oss-20b
GROQ_API_URL             기본 https://api.groq.com/openai/v1/chat/completions
GROQ_MODELS_URL          기본 https://api.groq.com/openai/v1/models
GOOGLE_CLIENT_ID         Google OAuth 웹 클라이언트 ID
GOOGLE_CLIENT_SECRET     Google OAuth 웹 클라이언트 secret
GOOGLE_REDIRECT_URI      캘린더 callback URI
GOOGLE_AUTH_REDIRECT_URI Google 로그인 callback URI
YOUTH_POLICY_API_KEY     온통청년 Open API 승인 후 서버에만 등록(선택)
WORK24_API_KEY           고용24 Open API 승인 후 서버에만 등록(선택)
```

키와 OAuth token은 브라우저 storage나 DOM으로 전달하지 않습니다. Google Cloud Console에는 실행 주소와 정확히 일치하는 callback URI를 등록해야 합니다.

## 실제 동작 범위

- 이메일 회원가입·로그인·로그아웃과 HttpOnly/SameSite 세션
- 최초 로그인 후 빈 계정과 프로필 온보딩
- 사용자별 프로필(학교·전공·생활 목표 포함)·일정 저장 및 격리
- 날짜 클릭 또는 캘린더 버튼으로 일정 추가
- 월 이동 화살표와 월별 일정 표시
- 일정 기반 정책과 일정 없이 프로필로 찾는 일반 정책 분리
- Groq 서버 proxy와 실패 시 로컬 안전 분류
- 일정 생성·수정 시 브라우저가 보낸 분류 메타데이터를 신뢰하지 않고 서버가 원문에서 다시 분석
- Google 로그인 OAuth 시작/callback
- Google Calendar Authorization Code + PKCE 연결
- 암호화된 access/refresh token 저장, 만료 시 refresh
- `nextSyncToken` 증분 동기화, 410 발생 시 전체 동기화 (`POST /api/calendar/google/sync`)
- provider event ID 기준 중복 방지 및 연결 해제
- 검증 시각이 있는 공식 정책 스냅샷과 온통청년·정부24 혜택알리미·복지로·고용24·지역 청년포털 탐색 링크
- 학교명이 입력된 경우 `ac.kr` 학교·학과 공식 공지 탐색 링크

Google 자격증명이 없으면 성공한 것처럼 표시하지 않고 “서버 설정 필요” 오류를 보여줍니다. 카카오 로그인과 카카오 알림톡은 후속 구현 예정입니다.

## 검증

```bash
node --check app.js
node --check client.js
node --check server.mjs
node tests/app.test.js
node tests/server.test.mjs
node tests/policy-eval-matrix.test.mjs
node tests/e2e.mjs
npm run test:sources
# GROQ_API_KEY를 서버 환경변수로 둔 로컬 환경
npm run test:live-ai
# 또는 배포된 서버의 실제 proxy 평가
CALENFIT_BASE_URL=https://calenfit.vercel.app npm run test:live-ai
git diff --check
```

현재 Production은 Neon PostgreSQL과 Vercel 암호화 환경변수를 사용합니다. 트래픽 확장 시에는 별도 Redis rate limit, KMS envelope encryption, 감사 로그, 백그라운드 동기화 queue, Google webhook watch 갱신이 추가로 필요합니다.

## Vercel 배포

Vercel에서는 `api/index.mjs`가 `server.mjs`의 API handler를 실행하고, `DATABASE_URL`이 있으면 Neon PostgreSQL을 영속 저장소로 사용합니다. 세션·계정·프로필·일정·OAuth state·암호화된 Google 연결 정보가 Neon에 보관됩니다.

```bash
vercel link
vercel env pull .env.local --yes
vercel build
vercel deploy --prebuilt
```

현재 Production URL은 `https://calenfit.vercel.app`입니다. Google Cloud Console에는 `https://calenfit.vercel.app/api/auth/google/callback`과 `https://calenfit.vercel.app/api/calendar/google/callback`을 승인된 리디렉션 URI로 등록해야 합니다.

## 정책 데이터 경계

정책 카드 자체는 공식 운영기관 URL과 마지막 확인 시각을 보존한 검증 스냅샷입니다. 온통청년과 고용24의 실시간 Open API는 각각 회원 가입·인증키 신청·담당자 승인이 필요하므로 키가 없을 때 연결 성공으로 표시하지 않습니다. 검색 결과가 없거나 현재 카탈로그 범위를 벗어나면 온통청년, 정부24 혜택알리미, 복지로, 고용24, 거주 지역 청년포털, 학교 공식 공지 검색으로 이어 줍니다. 이 탐색 링크는 정책 자격 판정이나 실시간 수집 결과가 아닙니다.

`npm run test:sources`는 현재 정책 카드와 출처 레지스트리의 공식 URL을 실제 요청해 죽은 링크·비공식 hostname·정책 제목 근거 불일치를 검출하고 `artifacts/policy-source-verification.json`에 결과를 남깁니다. `test:live-ai`는 30개 자연어 문장을 실제 Groq proxy에 보내되 예상 밖 도메인도 실패로 처리하고 임시 계정을 종료 시 삭제합니다. Groq 429는 연결 실패와 구분해 `GROQ_RATE_LIMITED`로 반환하며 일정 저장 API는 로컬 안전 분류를 계속 사용합니다.

# Calenfit Connected Calendar — Quick Requirements Interview

## Context

금융 AI Challenge 제출용 정적 웹 MVP를 현재 `2026-금융-AI-Challenge/`에 완성한다. 심사자는 로그인·자격증명 없이 브라우저에서 가상 일정으로 핵심 흐름을 재현해야 한다.

## Goals

- 2026년 9월 월간 캘린더를 첫 내부 화면으로 제공한다.
- 자체 캘린더 CRUD/ICS/Google OAuth placeholder를 일정 입력 경로로 보여준다.
- AI는 제목·설명·시간에서 일정 유형과 근거만 후보로 제시하고, 로컬 분류기로 안전하게 fallback한다.
- 정책 규칙 엔진은 공식 출처·확인 시각·상태·증빙 행동을 보존한다.
- 알림은 동의·채널·예약·실패 상태를 표시하는 데모 아웃박스로 제한한다.
- 구조·데모 스크립트·제안서·README를 심사자가 이해할 수 있게 제공한다.

## Scope decisions

- 실제 Google OAuth, 정책 크롤링, SMS/카카오/이메일 발송, 로그인과 개인정보 인증은 구현하지 않는다.
- API 키는 세션 저장소에만 보관하며 서버 프록시 전제를 UI에 표시한다.
- 모든 시드 일정·프로필은 가상 데이터다.
- AI와 자격/예산/공고 유효성 판단은 분리하고 정책 상태는 데모 스냅샷으로 표시한다.
- 기존 테스트와 디자인 방향을 유지하고 테스트 삭제로 문제를 숨기지 않는다.

## Validation

`node tests/app.test.js`, `node tests/e2e.mjs`, `node --check app.js`, 자산·링크 검사, 390x844/1440x900 캡처, 콘솔 오류·가로 overflow 0개, architect `APPROVED`를 완료 증거로 삼는다.

## Open production questions

OAuth callback/refresh token 암호화 저장, Calendar webhook watch 갱신, policy snapshot provenance, 동의 철회·삭제, 알림 provider 서명키는 서버 구현 시 확정한다.

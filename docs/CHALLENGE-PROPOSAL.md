# 캘린핏 금융 AI Challenge 제안서

## 문제와 해결

청년은 면접·시험 일정은 관리하지만 지원금, 증빙, 마감을 놓친다. 캘린핏은 일정 제목·설명·시간을 읽는 AI 캘린더 혜택 에이전트로, 정책 후보와 다음 행동을 연결하고 동의 기반 알림을 예약한다.

## 흐름

`일정 연동 → AI 맥락 분석 → 공식 기준 확인 → 증빙 행동 → 외부 알림 예약 → 사용자가 공식 신청`

## 기술과 역할

CalendarProviderAdapter(자체/ICS/Google placeholder), AIAnalysisAdapter(로컬 fallback), PolicySourceAdapter와 결정론적 rules, metadata-only evidence, NotificationChannelAdapter(웹/이메일/SMS/카카오 비발송 outbox)로 구성한다. AI는 유형·신뢰도·근거·증빙 후보만 반환하고 자격·예산·공고 유효성·최종 신청 가능 여부는 판단하지 않는다.

## 보안과 범위

API key는 `sessionStorage`, OAuth token·provider key는 서버 암호화 저장이다. OAuth callback/PKCE, webhook watch 갱신, 동의 철회·삭제, 최소 scope는 실제 서버 확장 범위다. 현재는 가상 프로필·2026년 9월 캘린더·검증된 정책 snapshot·ICS·Google 상태 mock·알림 outbox만 제공하고 실제 로그인/발송/크롤링은 하지 않는다.

## 심사 장면

월간 면접 셀 → 정책 공식 URL → 면접확인서 없음과 대체 증빙 → 상태별 CTA → 시험 영수증 태스크 → D-3 웹 알림 예약과 SMS/Kakao 차단 사유를 한 흐름으로 시연한다.

## 한 달 로드맵

1주차 캘린더/ICS, 2주차 AI proxy·정책 rules·증빙, 3주차 OAuth/token/webhook·알림 서버, 4주차 동의·삭제·보안·E2E와 배포 검수.

# 캘린핏 — AI 캘린더 혜택 에이전트

“캘린더를 잘 쓰면, 돈이 나온다.”

경기도 하남시에 사는 2001년생 대학교 4학년·취업준비생을 가정한 로그인 없는 정적 데모입니다. 면접·자격시험·청년기본소득·청년 일경험·금융상품 확인 일정을 분류하고, 연결 가능한 정책과 증빙 확보 행동을 안내합니다. 화면의 프로필과 일정은 모두 가상 데이터이며 최종 자격·예산·정책 유효성을 확정하지 않습니다.

- GitHub: https://github.com/diveyreadytodive-star/calenfit

현재 공개 배포는 비활성화되어 있습니다. 데모는 로컬 정적 서버에서 실행합니다.

## 실행

의존성이나 빌드 단계가 없습니다. 이 폴더에서 정적 서버를 실행합니다.

```sh
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000/`을 엽니다. 직접 `file://`로 열면 브라우저 보안 정책에 따라 스크립트가 제한될 수 있습니다.

## 데모 흐름

1. 일정 인박스에서 면접 또는 정보보안기사 일정을 선택합니다.
2. 연결 정책의 가능성, 공식 출처, 마지막 확인 시각을 확인하고 데모 정책 상태를 전환합니다.
3. 사건 상세에서 일정을 수정·삭제하고, 행동 타임라인 체크 상태를 완료 처리합니다.
4. 증빙 복구 모드에서 보유 증빙과 면접확인서 여부를 표시하고 확인서 요청 초안을 복사합니다.
5. 증빙 보관함에는 이미지/PDF 파일의 원본이 아니라 파일명·형식·크기·수정 시각만 기록합니다.
6. `.ics` 파일을 선택하면 미리보기가 열립니다. 내용을 확인한 뒤 `가져오기 확인`을 눌러 일정을 추가합니다.
7. 새로고침해도 이벤트·태스크 완료·복구·정책 상태가 `localStorage`에 남으며 `데모 초기화`로 시드 상태를 복원합니다.
8. 일정 연결 상태에서 자체 캘린더·ICS·Google OAuth placeholder의 상태를 비교합니다. Google의 성공/권한 거부 버튼은 가상 상태이며 실제 계정에 접근하지 않습니다.
9. 마감 알림에서 웹/이메일/SMS/카카오 채널과 수신 동의를 선택하면 발송하지 않는 데모 outbox에 예약 payload 또는 차단 사유가 남습니다.

## 검증과 한계

- HTML은 `styles.css`와 `app.js`를 외부 파일로 로드하며 키보드 포커스, skip link, 레이블, live region, 오류·빈 상태를 제공합니다.
- `app.js`의 결정론적 로컬 분류기와 명시적 정책 규칙을 사용합니다. AI API, OAuth, 실제 캘린더·메일·신청 전송은 포함하지 않습니다.
- 정책 상태는 공식 링크를 참고한 데모 스냅샷이며 신청 전 각 공식 링크를 다시 확인해야 합니다.
- 정적 브라우저 수동 확인 대상: 일정 추가/선택, 복구 체크박스, 증빙 메타데이터 표시, 모바일 390px·데스크톱 레이아웃.
- 데모 컨트롤에서 정책 상태(접수 중·마감·예산 소진·확인 필요)를 전환할 수 있으며, 초기화는 가상 시드 상태로 되돌립니다. 로컬 ICS 파싱·미리보기·확정 가져오기가 구현되어 있고 VCALENDAR/VEVENT, 접힌 행, 날짜·시간대 경고를 검증합니다. Google은 OAuth callback·암호화 token·webhook watch를 확장할 수 있는 adapter placeholder이며, 실제 외부 캘린더 동기화는 하지 않습니다.
- API 키는 `sessionStorage`에만 보관하고, OAuth token·알림 provider key는 서버 전용입니다. SMS·카카오·이메일은 credential과 동의가 없으면 발송하지 않습니다. 자세한 운영 경계는 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), 심사용 진행은 [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md)를 참고하세요.

### 테스트

```sh
node tests/app.test.js
```

결과: `app logic tests: 94 passed` (Node의 `--localstorage-file` 환경 경고가 있어도 테스트 결과에는 영향이 없습니다).

브라우저 E2E:

```sh
node tests/e2e.mjs
```

결과: `E2E passed: 14 checks` — 로드/콘솔·네트워크·자산, 이벤트 CRUD·증빙 제한, 상태 persistence·연결 삭제, 유효/무효 ICS, 시험 전용 UI, 클립보드 성공/실패, 정책 CTA·출처 실패, 손상 저장/XSS 복구, 키보드 흐름, 월간 달력·provider 상태·알림 outbox, 데스크톱/모바일 horizontal overflow를 검증합니다.

렌더 검증 산출물: [`artifacts/screenshots/final-desktop-1440x900.png`](artifacts/screenshots/final-desktop-1440x900.png), [`artifacts/screenshots/final-mobile-390x844.png`](artifacts/screenshots/final-mobile-390x844.png).

시나리오 증거는 `scenario-a-prevention-*`, `scenario-b-recovery-*`, `scenario-c-exam-support-*`, `scenario-d-policy-{open,closed,exhausted,unknown}-*` 파일로 데스크톱·모바일 각각 보관합니다. ICS 실패 후 성공 재시도는 `ics-retry-success-*`로 별도 보관합니다.

알려진 비목표: 실제 정책 상태 자동 수집, 정부·잡아바 자동 신청, Google Calendar/Gmail OAuth 발급·동기화, 실제 메일/SMS/카카오 발송, OCR/원문 파일 업로드, 다중 사용자 계정 및 금융상품 추천. Google OAuth의 서버 확장 계약과 네 가지 알림 채널의 비발송 outbox 데모는 포함합니다.

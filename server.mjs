import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPolicyDiscoveryLinks, decoratePolicySource, policyConnectorStatus } from "./policy-sources.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 8000);
const DATA_FILE = resolve(process.env.CALENFIT_DATA_FILE || `${ROOT}/.data/calenfit.json`);
if (process.env.NODE_ENV === "production" && !process.env.CALENFIT_SESSION_SECRET) throw new Error("CALENFIT_SESSION_SECRET is required in production");
const SESSION_SECRET = process.env.CALENFIT_SESSION_SECRET || randomBytes(32).toString("hex");
const rootKey = Buffer.from(SESSION_SECRET, "utf8");
const sessionSigningKey = Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), "calenfit-session-signing", 32));
const encryptionKey = Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), "calenfit-oauth-encryption", 32));
const SESSION_TTL = 86_400_000;
const OAUTH_TTL = 600_000;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const GOOGLE_EVENTS = process.env.GOOGLE_EVENTS_URL || "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_API_URL = process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL = process.env.GROQ_MODELS_URL || "https://api.groq.com/openai/v1/models";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const PUBLIC_FILES = new Set(["index.html", "privacy.html", "terms.html", "client.js", "styles.css", "landing.css", "logic-map.css", "calendar-focus.css", "legal.css"]);
const EVENT_POLICY_CATALOG = {
  interview: { id: "interview-allowance", title: "경기도 청년 면접수당", amount: "면접 1회당 5만원", url: "https://www.jobaba.net/jobSprt/detail.do?seq=1678", evidence: ["채용공고", "면접확인서"], condition: "경기도 거주와 구직 면접 여부 확인", checkedAt: "2026-09-03 13:00", applies: profile => /경기|하남/.test(profile?.residence || "") },
  exam: { id: "exam-support", title: "경기청년 역량강화 기회지원", amount: "응시료 지원", url: "https://youth.gg.go.kr/gg/intro/youth-policy-culture-test.do?articleNo=8951&mode=view", evidence: ["응시확인서", "결제영수증"], condition: "거주지·미취업 여부·지원 시험 종목 확인", checkedAt: "2026-09-03 13:00", applies: profile => /경기|하남/.test(profile?.residence || "") },
  startup: { id: "startup-support", title: "경기청년포털 창업 지원사업 확인", amount: "사업별 상이", url: "https://youth.gg.go.kr/gg/intro/introducing-the-gyeonggi-youth-portal.do", evidence: ["사업계획서", "신청확인"], condition: "포털의 최신 창업 공고에서 연령·소재지·사업단계 확인", checkedAt: "2026-09-03 13:00", applies: profile => /경기|하남/.test(profile?.residence || "") },
};
const GENERAL_EVENT_POLICY_RULES = [
  {
    pattern: /자취|월세|임대차|전세|주택\s*계약|방\s*계약/,
    applies: profile => /하남/.test(profile?.residence || ""),
    policy: { id: "hanam-youth-rent-2026", title: "하남시 청년월세지원", amount: "월 최대 20만원·최대 24개월", url: "https://www.hanam.go.kr/www/contents.do?key=12878", evidence: ["임대차계약서", "월세 이체내역", "가족관계증명서"], condition: "19~34세 독립거주 무주택 청년의 소득·재산·가구 조건 확인", checkedAt: "2026-09-03 09:00", status: "closed", deadline: "2026-05-29 신청 종료", signal: "주거 계약" },
  },
  {
    pattern: /근로\s*장려금|근로장려금|홈택스\s*장려금/,
    policy: { id: "earned-income-tax-credit-2026-h1", title: "2026년 상반기분 근로장려금", amount: "가구·소득·재산 심사 후 산정", url: "https://b.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238977&mi=40397", evidence: ["근로소득 내역", "가구원·재산 정보", "신청 안내문"], condition: "2026년 근로소득만 있는 가구 등 소득·재산·가구 요건 확인", checkedAt: "2026-09-03 09:00", status: "open", deadline: "2026-09-15", signal: "근로장려금" },
  },
  {
    pattern: /입영|군\s*입대|군대\s*입대|사회복무|입영통지/,
    applies: profile => /하남/.test(profile?.residence || ""),
    policy: { id: "hanam-enlistment-support", title: "하남시 입영지원금", amount: "1인 10만원 지역화폐", url: "https://www.hanam.go.kr/www/contents.do?key=12881", evidence: ["입영통지서", "주민등록초본"], condition: "입영통지일 기준 하남시 1년 이상 거주 및 해당 연도 입영 여부 확인", checkedAt: "2026-09-03 09:00", status: "open", deadline: "연중", signal: "입영" },
  },
  {
    pattern: /건강\s*검진|건강검진|보건소\s*검진/,
    applies: profile => /하남/.test(profile?.residence || ""),
    policy: { id: "hanam-youth-health-check", title: "하남시 1인가구 청년 무료 건강검진", amount: "연 1회 무료 검진·상담", url: "https://www.hanam.go.kr/www/contents.do?key=12879", evidence: ["신분증", "주민등록등본"], condition: "하남시 거주 19~39세 청년 1인 가구 여부 확인", checkedAt: "2026-09-03 09:00", status: "open", deadline: "평일 운영", signal: "건강검진" },
  },
  {
    pattern: /취업\s*교육|직무\s*교육|학원\s*수강|강의\s*수강|부트\s*캠프|부트캠프/,
    applies: profile => /하남/.test(profile?.residence || ""),
    policy: { id: "hanam-job-training-2026", title: "하남시 취업교육 청년지원사업", amount: "수강료 최대 200만원", url: "https://www.hanam.go.kr/www/selectGosiData.do?key=171&not_ancmt_mgt_no=49963&not_ancmt_se_code=01%2C04", evidence: ["수강 신청·결제 내역", "주민등록초본", "미취업 확인"], condition: "하남시 1년 이상 거주, 만 19~39세 미취업, 국민내일배움카드 미발급 등 확인", checkedAt: "2026-09-03 09:00", status: "open", deadline: "모집 마감 시", signal: "취업교육" },
  },
  {
    pattern: /취업\s*교육|직무\s*교육|학원\s*수강|강의\s*수강|부트\s*캠프|부트캠프|직업\s*훈련/,
    policy: { id: "national-learning-card", title: "국민내일배움카드", amount: "직업훈련비 지원", url: "https://m.work24.go.kr/hr/h/a/1100/selectIssuGudn.do", evidence: ["본인 확인", "훈련과정 정보", "대상자별 추가 서류"], condition: "국민 누구나 신청 가능하나 일부 발급 제한 대상과 과정별 자부담 여부 확인", checkedAt: "2026-09-03 12:00", status: "review", deadline: "상시 신청", signal: "직업훈련" },
  },
  {
    pattern: /인턴|일\s*경험|일경험|현장\s*실습|현장실습/,
    policy: { id: "future-tomorrow-experience-event", title: "미래내일 일경험 지원사업", amount: "프로그램별 참여 지원", url: "https://yw.work24.go.kr/main.do", evidence: ["참여 신청", "재학·졸업 상태", "프로그램 안내"], condition: "프로그램별 연령·취업 상태·교육 및 참여 조건 확인", checkedAt: "2026-09-03 09:00", status: "review", deadline: "공고별 확인", signal: "인턴·일경험" },
  },
  {
    pattern: /실직|퇴사|구직\s*등록|구직등록|국민취업지원|취업\s*지원\s*신청/,
    policy: { id: "national-employment-support", title: "국민취업지원제도", amount: "취업지원 서비스·수당 조건별 상이", url: "https://www.work24.go.kr/ua/z/z/1300/selectEmssRqutIntro.do", evidence: ["취업 상태", "가구·소득 정보", "구직활동 계획"], condition: "연령·소득·재산·취업경험 및 유형별 요건 확인", checkedAt: "2026-09-03 09:00", status: "review", deadline: "상시 확인", signal: "실직·구직" },
  },
  {
    pattern: /수영|헬스|운동|체육|스포츠|요가|필라테스|배드민턴|테니스|클라이밍|커뮤니티\s*센터|문화\s*센터/,
    policy: { id: "tunteun-money-2026", title: "국민체력100 튼튼머니", amount: "활동별 포인트·운영 공지 확인", url: "https://nfa.kspo.or.kr/community/board/selectNoticeList.kspo?menuId=A05_B01", evidence: ["튼튼머니 가입", "적립시설 확인", "운동 인증"], condition: "만 11세 이상, 이용 시설과 현재 포인트 지급 운영 여부 확인", checkedAt: "2026-09-03 12:00", status: "review", deadline: "2026-08-03 이후 포인트 지급 중단 공지 확인", signal: "운동·체육 수업" },
  },
  {
    pattern: /수영|헬스|운동|체육|스포츠|요가|필라테스|배드민턴|테니스|클라이밍|문화\s*센터/,
    policy: { id: "culture-nuri-card-2026", title: "2026 문화누리카드 체육활동 지원", amount: "연 15만원·생애주기별 추가 지원", url: "https://www.mnuri.kr/munhwa/cardIssueGuide.do", evidence: ["수급자·차상위 자격", "문화누리카드", "체육 가맹점 확인"], condition: "6세 이상 기초생활수급자·차상위계층이며 해당 시설이 문화누리카드 가맹점인지 확인", checkedAt: "2026-09-03 09:00", status: "open", deadline: "2026 발급·사용기간 확인", signal: "체육활동" },
  },
  {
    pattern: /수영|헬스|운동|체육|스포츠|태권도|축구|농구|배드민턴/,
    applies: profile => /하남/.test(profile?.residence || "") && Number(profile?.birthYear) >= 2008,
    policy: { id: "sports-class-voucher-2026", title: "2026 스포츠강좌이용권", amount: "월 최대 10만 5천원 수강료", url: "https://www.hanam.go.kr/www/selectBbsNttView.do?bbsNo=30&key=170&nttNo=494309", evidence: ["연령 확인", "수급자격", "가구 정보"], condition: "5~18세 저소득층 유·청소년 등 세부 대상 확인", checkedAt: "2026-09-03 09:00", status: "review", deadline: "모집 공고 확인", signal: "스포츠 수업" },
  },
  {
    pattern: /자취|월세|임대차|전세|보증금|이사|주택\s*계약|방\s*계약/,
    applies: profile => { const age = 2026 - Number(profile?.birthYear); return age >= 19 && age <= 34; },
    policy: { id: "national-youth-rent", title: "청년월세 지원사업", amount: "소득·주거 조건별 지원", url: "https://www.bokjiro.go.kr/ssis-teu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00004661", evidence: ["임대차계약서", "월세 이체내역", "가구·소득 자료"], condition: "19~34세 독립거주 무주택 청년의 소득·재산·주거 요건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "복지로 최신 공고 확인", signal: "주거·월세" },
  },
  {
    pattern: /이사|중개\s*보수|복비|부동산\s*계약/,
    applies: profile => /서울/.test(profile?.residence || "") && 2026 - Number(profile?.birthYear) >= 19 && 2026 - Number(profile?.birthYear) <= 39,
    policy: { id: "seoul-moving-cost-2026", title: "서울 청년 부동산 중개보수 및 이사비 지원", amount: "공고별 지원 한도 확인", url: "https://youth.seoul.go.kr/infoData/plcyInfo/view.do?key=2309150002&plcyBizId=V202600006&sprtInfoId=", evidence: ["임대차계약서", "중개보수·이사비 영수증", "주민등록초본"], condition: "서울 거주 청년의 연령·소득·주택·이사일 조건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "2026 공고 확인", signal: "서울 이사" },
  },
  {
    pattern: /출산|출생\s*신고|아기\s*태어|산후|신생아/,
    policy: { id: "first-meeting-voucher", title: "첫만남이용권", amount: "출생 순위 등에 따라 바우처 지급", url: "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00004656", evidence: ["출생신고", "보호자 확인", "국민행복카드"], condition: "출생신고되어 주민등록번호를 부여받은 아동 등 최신 지원대상 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "출생일 기준 사용기간 확인", signal: "출산·출생" },
  },
  {
    pattern: /육아\s*휴직|출산\s*휴가|배우자\s*출산\s*휴가/,
    policy: { id: "parental-leave-benefit", title: "육아휴직급여", amount: "휴직기간·통상임금·제도별 산정", url: "https://www.work24.go.kr/cm/c/f/1100/selecSystInfo.do?systId=SI00000402", evidence: ["육아휴직 확인", "고용보험 가입 이력", "임금 자료"], condition: "고용보험 피보험기간·육아휴직 사용 등 지급요건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "신청 가능 기간 확인", signal: "육아휴직" },
  },
  {
    pattern: /권고\s*사직|계약\s*만료|해고|실업\s*급여|구직\s*급여|퇴사/,
    policy: { id: "unemployment-benefit", title: "실업급여", amount: "피보험기간·이직 전 임금 등에 따라 산정", url: "https://m.work24.go.kr/cm/c/f/1100/selecSystInfo.do?systCnntId=CI00001715&systId=SI00000411", evidence: ["이직확인서", "고용보험 이력", "구직등록"], condition: "피보험단위기간·비자발적 이직·재취업 노력 등 수급요건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "퇴직 다음 날부터 신청기간 확인", signal: "실직·퇴사" },
  },
  {
    pattern: /결혼|혼인\s*신고|웨딩|예식/,
    applies: profile => /경기|하남/.test(profile?.residence || ""),
    policy: { id: "gyeonggi-marriage-points-2026", title: "경기청년 결혼 축하 복지포인트 지원", amount: "공고별 복지포인트 확인", url: "https://youth.gg.go.kr/gg/intro/youth-policy-housing-test.do?articleNo=8975&mode=view", evidence: ["혼인관계증명서", "주민등록초본", "연령 확인"], condition: "경기도 거주·연령·혼인신고일 등 2026 공고 조건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "공고 신청기간 확인", signal: "결혼·혼인" },
  },
  {
    pattern: /문화\s*패스|공연|콘서트|뮤지컬|연극|영화\s*관람/,
    applies: profile => /부산/.test(profile?.residence || ""),
    policy: { id: "busan-culture-pass-2026", title: "부산청년만원+문화패스", amount: "공연별 청년 할인 지원", url: "https://young.busan.go.kr/index.nm?menuCd=234", evidence: ["부산 거주 확인", "연령 확인", "예매 내역"], condition: "부산 거주 청년·대상 공연·예매기간 등 공고 조건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "공연별 확인", signal: "부산 문화생활" },
  },
  {
    pattern: /인턴|일\s*경험|일경험|현장\s*실습|직무\s*체험/,
    applies: profile => /광주/.test(profile?.residence || ""),
    policy: { id: "gwangju-work-experience-2026", title: "광주청년 일경험드림", amount: "유형·근무기간별 지원", url: "https://youth.gwangju.go.kr/www/50?policyId=1252", evidence: ["광주 거주 확인", "취업 상태", "참여 신청"], condition: "광주 거주·연령·취업 상태와 프로그램별 조건 확인", checkedAt: "2026-09-03 13:00", status: "review", deadline: "기수별 모집 공고 확인", signal: "광주 일경험" },
  },
  {
    pattern: /국가\s*장학금|학자금|대학(?:교)?\s*등록금|장학금\s*신청/,
    applies: profile => profile?.status === "학생" && /대학|대학교/.test(profile?.education || ""),
    policy: { id: "national-scholarship-2026-fall", title: "2026년 2학기 국가장학금", amount: "학자금 지원구간·유형별 차등", url: "https://www.kosaf.go.kr/ko/scholar.do?naviParam=JH%2C02%2C00%2C00&pg=scholarship_submain01", evidence: ["학적 정보", "가구원 동의", "요청 시 추가 서류"], condition: "국내 대학 재학·학자금 지원구간·성적 등 유형별 요건 확인", checkedAt: "2026-09-03 13:00", status: "open", deadline: "신청 2026-09-09 18:00", signal: "장학금·등록금" },
  },
];
const POLICY_DOMAINS = new Set(["employment", "work-experience", "unemployment", "exam", "housing", "tax-credit", "sports", "culture", "education", "scholarship", "military", "health", "mental-health", "startup", "finance", "assets", "marriage", "family", "childbirth", "childcare", "welfare", "transport", "general"]);
const POLICY_DOMAIN_BY_ID = {
  "hanam-youth-rent-2026": ["housing"],
  "earned-income-tax-credit-2026-h1": ["tax-credit"],
  "hanam-enlistment-support": ["military"],
  "hanam-youth-health-check": ["health"],
  "hanam-job-training-2026": ["education"],
  "national-learning-card": ["education"],
  "tunteun-money-2026": ["sports"],
  "culture-nuri-card-2026": ["sports", "culture"],
  "sports-class-voucher-2026": ["sports"],
  "national-youth-rent": ["housing", "welfare"],
  "first-meeting-voucher": ["childbirth"],
  "parental-leave-benefit": ["childcare"],
  "unemployment-benefit": ["unemployment"],
  "gyeonggi-marriage-points-2026": ["marriage", "family"],
  "busan-culture-pass-2026": ["culture"],
  "gwangju-work-experience-2026": ["work-experience"],
  "national-scholarship-2026-fall": ["scholarship"],
};

function inferPolicyDomains(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();
  const domains = new Set();
  if (/면접|채용|구직|퇴사|실직|인턴|일\s*경험/.test(text)) domains.add("employment");
  if (/인턴|일\s*경험|현장\s*실습|직무\s*체험/.test(text)) domains.add("work-experience");
  if (/권고\s*사직|계약\s*만료|해고|실업\s*급여|구직\s*급여|퇴사/.test(text)) domains.add("unemployment");
  if (/시험|응시|자격|토익|기사/.test(text)) domains.add("exam");
  if (/자취|월세|임대차|전세|보증금|이사|주택\s*계약/.test(text)) domains.add("housing");
  if (/근로\s*장려금|세금|홈택스|연말정산/.test(text)) domains.add("tax-credit");
  if (/수영|헬스|운동|체육|스포츠|요가|필라테스|배드민턴|테니스|클라이밍/.test(text)) domains.add("sports");
  if (/문화\s*센터|공연|전시|영화|문화/.test(text)) domains.add("culture");
  if (/교육|수강|학원\s*(?:수강|등록|수업)|학원비|강의|부트\s*캠프/.test(text)) domains.add("education");
  if (/입영|군\s*입대|사회복무|입영통지/.test(text)) domains.add("military");
  if (/건강\s*검진|건강검진|보건소|진료/.test(text)) domains.add("health");
  if (/창업|사업자|데모데이|스타트업/.test(text)) domains.add("startup");
  if (/국가\s*장학금|장학금\s*신청|학자금|대학(?:교)?\s*등록금/.test(text)) domains.add("scholarship");
  if (/결혼|혼인|웨딩|예식/.test(text)) domains.add("marriage");
  if (/가족|가구/.test(text)) domains.add("family");
  if (/출산|출생\s*신고|신생아|아기\s*태어|산후/.test(text)) domains.add("childbirth");
  if (/육아|보육|어린이집|아이\s*돌봄/.test(text)) domains.add("childcare");
  if (/저축|적금|자산\s*형성|통장/.test(text)) domains.add("assets");
  if (/우울|불안|심리\s*상담|마음\s*(?:건강|상담)|정신\s*건강/.test(text)) domains.add("mental-health");
  if (/교통|대중교통|버스|지하철/.test(text)) domains.add("transport");
  return domains.size ? [...domains] : ["general"];
}

function reconcilePolicyDomains(input, aiDomains = []) {
  const text = `${input.title || ""} ${input.description || ""}`.toLowerCase();
  const domains = new Set([...aiDomains, ...inferPolicyDomains(input.title, input.description)].filter(domain => POLICY_DOMAINS.has(domain)));
  const smokingNegated = /(?:금연|담배|흡연).*(?:생각\s*없|하지\s*않|안\s*할|포기)|담배.*(?:계속|끊지)/.test(text);
  const independentHealthSignal = /건강\s*검진|병원|진료|보건소|치료|상담\s*예약/.test(text);
  if (smokingNegated && !independentHealthSignal) domains.delete("health");
  if (!/인턴|일\s*경험|일경험|현장\s*실습|직무\s*체험|회사\s*체험|기업\s*체험/.test(text)) domains.delete("work-experience");
  if (!/저축|적금|목돈|자산\s*형성|재테크|금융\s*자산|청년\s*통장/.test(text)) domains.delete("assets");
  if (!/우울|불안|심리\s*상담|마음\s*(?:건강|상담)|정신\s*건강/.test(text)) domains.delete("mental-health");
  if (!/면접|채용|구직|취업|직장|입사|인턴|일\s*경험|고용\s*센터|이직/.test(text)) domains.delete("employment");
  if (!/문화|공연|콘서트|뮤지컬|연극|영화|전시|관람/.test(text)) domains.delete("culture");
  if (domains.size > 1) domains.delete("general");
  return domains.size ? [...domains].slice(0, 10) : ["general"];
}

function inferServerEventType(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();
  if (/면접|interview|채용/.test(text)) return { type: "interview", confidence: 0.84 };
  if (/시험|응시|기사|토익|toeic|exam|자격/.test(text)) return { type: "exam", confidence: 0.86 };
  if (/창업|startup|데모데이|demo day/.test(text)) return { type: "startup", confidence: 0.72 };
  return { type: "general", confidence: 0.55 };
}
const authAttempts = new Map();

const emptyDatabase = () => ({ version: 1, users: {}, emails: {}, sessions: {}, oauthStates: {}, googleConnections: {} });
let sqlClient;
let postgresInitialized = false;
let databaseRevision = 0;
async function getSqlClient() {
  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    return null;
  }
  if (!sqlClient) {
    const { neon } = await import("@neondatabase/serverless");
    sqlClient = neon(process.env.DATABASE_URL);
  }
  if (!postgresInitialized) {
    await sqlClient`CREATE TABLE IF NOT EXISTS calenfit_state (id integer PRIMARY KEY, data jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sqlClient`INSERT INTO calenfit_state (id, data) VALUES (1, ${JSON.stringify(emptyDatabase())}::jsonb) ON CONFLICT (id) DO NOTHING`;
    postgresInitialized = true;
  }
  return sqlClient;
}
async function loadDatabase() {
  const sql = await getSqlClient();
  if (sql) {
    const rows = await sql`SELECT data, revision FROM calenfit_state WHERE id = 1`;
    databaseRevision = Number(rows[0]?.revision || 0);
    const data = rows[0]?.data || emptyDatabase();
    return { ...emptyDatabase(), ...data, users: data.users || {}, emails: data.emails || {}, sessions: data.sessions || {}, oauthStates: data.oauthStates || {}, googleConnections: data.googleConnections || {} };
  }
  try {
    const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
    return { ...emptyDatabase(), ...data, users: data.users || {}, emails: data.emails || {}, sessions: data.sessions || {}, oauthStates: data.oauthStates || {}, googleConnections: data.googleConnections || {} };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Calenfit data load failed:", error.message);
    return emptyDatabase();
  }
}
let database = await loadDatabase();
const sessions = {
  get: key => database.sessions[key],
  set: (key, value) => { database.sessions[key] = value; },
  delete: key => delete database.sessions[key],
};
const oauthStates = {
  get: key => database.oauthStates[key],
  set: (key, value) => { database.oauthStates[key] = value; },
  delete: key => delete database.oauthStates[key],
};
let persistQueue = Promise.resolve();
function persistDatabase() {
  persistQueue = persistQueue.catch(() => {}).then(async () => {
    const sql = await getSqlClient();
    if (sql) {
      const rows = await sql`UPDATE calenfit_state SET data = ${JSON.stringify(database)}::jsonb, revision = revision + 1, updated_at = now() WHERE id = 1 AND revision = ${databaseRevision} RETURNING revision`;
      if (!rows.length) throw new Error("Concurrent data update detected; retry the request");
      databaseRevision = Number(rows[0].revision);
      return;
    }
    await mkdir(dirname(DATA_FILE), { recursive: true });
    const temporary = `${DATA_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(database, null, 2), { mode: 0o600 });
    await rename(temporary, DATA_FILE);
  });
  return persistQueue;
}

const json = value => JSON.stringify(value);
function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(json(body));
}
function redirect(response, location, headers = {}) {
  response.writeHead(302, { location, "cache-control": "no-store", ...headers });
  response.end();
}
function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    request.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("request too large"));
    });
    request.on("end", () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    request.on("error", reject);
  });
}
function readCookie(request, name) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}
const cookieAttributes = maxAge => `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
const sessionToken = id => `${id}.${createHmac("sha256", sessionSigningKey).update(id).digest("base64url")}`;
function issueSession(userId) {
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { userId, expiresAt: Date.now() + SESSION_TTL });
  return sessionToken(id);
}
function currentSession(request) {
  const [id, signature] = readCookie(request, "calenfit_session").split(".");
  const record = sessions.get(id);
  if (!id || !signature || !record || record.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  const expected = sessionToken(id).split(".")[1];
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const user = database.users[record.userId];
  return user ? { id, user } : null;
}
const publicUser = user => ({ id: user.id, email: user.email, profile: user.profile || null, mode: "account" });

const validCredentials = (email, password) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && String(password).length >= 10;
function passwordHash(password) {
  const salt = randomBytes(16);
  return `${salt.toString("base64url")}.${scryptSync(String(password), salt, 32).toString("base64url")}`;
}
function passwordMatches(password, stored) {
  try {
    const [saltText, digestText] = String(stored).split(".");
    const digest = Buffer.from(digestText, "base64url");
    const actual = scryptSync(String(password), Buffer.from(saltText, "base64url"), 32);
    return digest.length === actual.length && timingSafeEqual(digest, actual);
  } catch { return false; }
}
function normalizeProfile(value) {
  const birthYear = Number(value?.birthYear);
  const residence = String(value?.residence || "").trim().slice(0, 120);
  const status = String(value?.status || "").trim().slice(0, 40);
  const education = String(value?.education || "").trim().slice(0, 80);
  const school = String(value?.school || "").trim().slice(0, 100);
  const major = String(value?.major || "").trim().slice(0, 80);
  const goal = String(value?.goal || "").trim().slice(0, 160);
  if (!Number.isInteger(birthYear) || birthYear < 1940 || birthYear > new Date().getFullYear() || !residence || !status) throw new Error("필수 프로필 항목을 확인하세요.");
  return { birthYear, residence, status, education, school, major, goal };
}

async function analyzeProfileIntent(profile) {
  const description = `${profile.status} · ${profile.education} · ${profile.school} · ${profile.major} · 목표: ${profile.goal}`;
  const localDomains = inferPolicyDomains("사용자 프로필 목표", description);
  if (!process.env.GROQ_API_KEY) return { ...profile, intentDomains: localDomains, intentTags: [], intentAnalysisSource: "local" };
  try {
    const analysis = await requestGroqAnalysis({ title: "사용자 프로필 목표", description, startTime: "" });
    return { ...profile, intentDomains: [...new Set([...analysis.policyDomains, ...localDomains])].slice(0, 10), intentTags: analysis.intentTags, intentAnalysisSource: "ai" };
  } catch {
    return { ...profile, intentDomains: localDomains, intentTags: [], intentAnalysisSource: "local" };
  }
}

async function analyzeEventIntent(title, description, date = "") {
  const localType = inferServerEventType(title, description);
  const localDomains = inferPolicyDomains(title, description);
  if (!process.env.GROQ_API_KEY) return { type: localType.type, confidence: localType.confidence, classificationSource: "local", analysisRationale: "로컬 안전 분류를 사용했습니다.", evidenceCandidates: [], intentTags: [], policyDomains: localDomains };
  try {
    const analysis = await requestGroqAnalysis({ title, description, startTime: date ? `${date}T09:00:00+09:00` : "" });
    return { type: analysis.type === "general" && localType.type !== "general" ? localType.type : analysis.type, confidence: analysis.confidence, classificationSource: "ai", analysisRationale: analysis.rationale, evidenceCandidates: analysis.evidenceCandidates, intentTags: analysis.intentTags, policyDomains: reconcilePolicyDomains({ title, description }, analysis.policyDomains) };
  } catch {
    return { type: localType.type, confidence: localType.confidence, classificationSource: "local", analysisRationale: "AI 연결 실패로 로컬 안전 분류를 사용했습니다.", evidenceCandidates: [], intentTags: [], policyDomains: localDomains };
  }
}

function profilePolicyCandidates(profile) {
  if (!profile) return [];
  const age = 2026 - profile.birthYear;
  const isHanam = profile.residence.includes("하남");
  const isUnemployed = ["미취업", "학생", "졸업"].includes(profile.status);
  const profileIntent = `${profile.status} ${profile.education} ${profile.school || ""} ${profile.major} ${profile.goal}`;
  const intentDomains = new Set(profile.intentDomains || []);
  const employmentGoalNegated = /(?:취업|구직|이직|커리어).*(?:생각\s*없|하지\s*않|안\s*할|포기)/.test(profileIntent);
  const candidates = [];
  if (isHanam && [2001, 2002].includes(profile.birthYear)) {
    candidates.push({
      id: "hanam-basic-income-2026-q3", title: "하남시 청년기본소득 3분기", amount: "분기 25만원 지역화폐", url: "https://www.hanam.go.kr/www/contents.do?key=12491", status: "open", eligibility: "review", checkedAt: "2026-09-02 20:00",
      reason: "하남 거주와 출생연도를 기준으로 찾은 후보입니다. 정확한 생년월일과 거주기간을 공식 공고에서 확인하세요.",
      condition: "정확한 생년월일이 2001-07-02~2002-07-01이고 하남시 주민등록, 경기도 3년 연속 또는 합산 10년 거주", evidence: ["주민등록초본"], deadline: "2026-10-02",
    });
  }
  if (isHanam && isUnemployed && age >= 19 && age <= 39) {
    candidates.push({
      id: "hanam-job-training-2026", title: "하남시 취업교육 청년지원사업", amount: "수강료 최대 200만원", url: "https://www.hanam.go.kr/www/selectGosiData.do?key=171&not_ancmt_mgt_no=49963&not_ancmt_se_code=01%2C04", status: "open", eligibility: "review", checkedAt: "2026-09-02 20:00",
      reason: `${profile.major || "전공 미입력"} 전공·${profile.goal || "취업"} 목표와 미취업 상태를 바탕으로 찾았습니다.`, condition: "하남시 1년 이상 거주, 만 19~39세 미취업, 국민내일배움카드 미발급 등 확인", evidence: ["주민등록초본", "미취업 확인", "수강 증빙"], deadline: "모집 마감 시",
    });
  }
  if (age >= 19 && age <= 34) candidates.push({
    id: "youth-hope-savings", title: "청년희망적금", amount: "기존 가입·만기 이력 확인", url: "https://www.fsc.go.kr/po020201/77339", status: "closed", eligibility: "info", checkedAt: "2026-09-02 20:00", reason: "연령상 관련 이력이 있을 수 있어 만기·가입 기록 확인용으로 표시합니다.", condition: "신규 가입은 종료된 상품이며 기존 가입자 정보만 확인", evidence: ["가입 확인", "납입·만기 내역"], deadline: "신규 가입 종료",
  });
  if (isHanam) candidates.push({
    id: "hanam-high-oil-relief-2026", title: "2026 고유가 피해지원금", amount: "대상 구간별 차등", url: "https://www.hanam.go.kr/cleanh/cleanhBbsNttWebView.do?key=4348&nttNo=3353", status: "closed", eligibility: "info", checkedAt: "2026-09-02 20:00", reason: "하남 거주 조건으로 찾았지만 2026년 사용기한이 종료되어 기록 확인용으로 표시합니다.", condition: "소득·가구 조건 및 신청 당시 주소지 확인", evidence: ["주소지", "소득·가구 조건"], deadline: "2026-08-31 종료",
  });
  if (profile.status === "학생" && /대학|대학교/.test(profile.education)) candidates.push({
    id: "national-scholarship-2026-fall", title: "2026년 2학기 국가장학금", amount: "학자금 지원구간·유형별 차등", url: "https://www.kosaf.go.kr/ko/scholar.do?naviParam=JH%2C02%2C00%2C00&pg=scholarship_submain01", status: "open", eligibility: "review", checkedAt: "2026-09-03 12:00",
    reason: `${profile.school || "입력한 학교"} ${profile.education} 재학 상태를 대학생 지원 신호로 사용했습니다.`, condition: "대한민국 국적, 국내 대학 재학, 학자금 지원구간·성적·가구원 동의 등 유형별 요건 확인", evidence: ["학적 정보", "가구원 동의", "요청 시 추가 서류"], deadline: "신청 2026-09-09 18:00 · 서류/가구원 동의 2026-09-16 18:00",
  });
  if (profile.status === "학생" && /대학|대학교/.test(profile.education)) candidates.push({
    id: "university-career-service", title: "대학 재학생 맞춤형 고용서비스", amount: "대학별 상담·직무역량·일경험 연계", url: "https://www.work24.go.kr/fs/b/a/0100/selectOperUnivList.do?currentPageNo=1&recordCountPerPage=10", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: `${profile.school || "소속 대학"} 재학생과 ${profile.major || "전공"} 정보를 대학생 고용서비스 탐색 신호로 사용했습니다.`, condition: "소속 대학의 사업 참여 여부와 학년·프로그램별 모집 조건 확인", evidence: ["재학 정보", "소속 대학", "프로그램 신청"], deadline: "대학별 확인",
  });
  if (isUnemployed || (!employmentGoalNegated && (["employment", "work-experience", "unemployment"].some(domain => intentDomains.has(domain)) || /취업|구직|이직|커리어|직무|인턴/.test(profileIntent)))) candidates.push({
    id: "national-employment-support", title: "국민취업지원제도", amount: "취업지원 서비스·수당 조건별 상이", url: "https://www.work24.go.kr/ua/z/z/1300/selectEmssRqutIntro.do", status: "review", eligibility: "review", checkedAt: "2026-09-03 12:00",
    reason: `${profile.status || "현재 상태"}와 ${profile.goal || "입력한 목표"}를 취업·구직 신호로 보아 전국 제도를 찾았습니다.`, condition: "연령·소득·재산·취업경험 및 유형별 요건 확인", evidence: ["취업 상태", "가구·소득 정보", "구직활동 계획"], deadline: "상시 확인",
  });
  if (/학생|졸업|미취업/.test(profile.status) || intentDomains.has("education") || /교육|학습|자격|직무|취업|이직|전환|개발|데이터|디자인/.test(profileIntent)) candidates.push({
    id: "national-learning-card", title: "국민내일배움카드", amount: "직업훈련비 지원", url: "https://m.work24.go.kr/hr/h/a/1100/selectIssuGudn.do", status: "review", eligibility: "review", checkedAt: "2026-09-03 12:00",
    reason: `${profile.major || "전공 미입력"} 전공과 ${profile.goal || "역량 개발"} 목표를 직업훈련 탐색 신호로 사용했습니다.`, condition: "국민 누구나 신청 가능하나 일부 발급 제한 대상과 과정별 자부담 여부 확인", evidence: ["본인 확인", "훈련과정 정보", "대상자별 추가 서류"], deadline: "상시 신청",
  });
  if ((intentDomains.has("sports") || /수영|운동|체육|헬스|요가|필라테스|다이어트|건강|체중\s*관리|유산소|근력/.test(profileIntent)) && age >= 11) candidates.push({
    id: "tunteun-money-2026", title: "국민체력100 튼튼머니", amount: "활동별 포인트·운영 공지 확인", url: "https://nfa.kspo.or.kr/community/board/selectNoticeList.kspo?menuId=A05_B01", status: "review", eligibility: "review", checkedAt: "2026-09-03 12:00",
    reason: `${profile.goal || "건강·운동"} 목표를 생활체육 신호로 보아 찾았습니다.`, condition: "만 11세 이상, 적립시설 및 현재 포인트 지급 운영 여부 확인", evidence: ["튼튼머니 가입", "적립시설 확인", "운동 인증"], deadline: "운영 공지 확인",
  });
  const smokingGoalNegated = /(?:금연|담배|흡연).*(?:생각\s*없|하지\s*않|안\s*할|포기)|담배.*(?:계속|끊지)/.test(profileIntent);
  if (!smokingGoalNegated && /금연|담배\s*끊|흡연\s*중단|니코틴\s*끊/.test(profileIntent)) candidates.push({
    id: "public-health-smoking-clinic", title: "보건소 금연클리닉", amount: "금연상담·검사·보조제 등 무료 지원", url: "https://nosmk.khepi.or.kr/nsk/ntcc/subIndex/66.do", status: "open", eligibility: "review", checkedAt: "2026-09-03 12:00",
    reason: `${profile.goal || "금연"} 목표와 직접 관련된 전국 보건소 서비스를 찾았습니다.`, condition: "지역사회 흡연자(청소년 포함), 지역 보건소 운영시간·재고·예약 여부 확인", evidence: ["본인 확인", "지역 보건소 상담"], deadline: "평일 운영·기관별 확인",
  });
  if (["미취업", "졸업"].includes(profile.status) && age >= 18 && age <= 34) candidates.push({
    id: "youth-challenge-program", title: "청년도전지원사업", amount: "상담·프로그램·참여수당 등 유형별 지원", url: "https://www.work24.go.kr/wk/g/b/1100/busiIntro.do", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: `${profile.status} 상태와 ${profile.goal || "진로 탐색"} 목표를 구직 재진입 지원 신호로 사용했습니다.`, condition: "구직단념청년 등 사업 대상과 운영기관별 참여 조건 확인", evidence: ["취업 상태", "구직활동 이력", "운영기관 상담"], deadline: "지역 운영기관별 확인",
  });
  if (/서울/.test(profile.residence) && ["미취업", "졸업"].includes(profile.status) && age >= 19 && age <= 34) candidates.push({
    id: "seoul-youth-allowance-2026", title: "서울 청년수당", amount: "2026 공고의 활동지원 내용 확인", url: "https://youth.seoul.go.kr/infoData/plcyInfo/view.do?key=2309150002&plcyBizId=V202600005&sprtInfoId=", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: "서울 거주와 미취업·졸업 상태를 지역 청년정책 탐색 신호로 사용했습니다.", condition: "서울 거주·연령·최종학력·취업·소득 등 2026 공고 조건 확인", evidence: ["주민등록", "졸업·취업 상태", "소득 관련 자료"], deadline: "2026 모집 공고 확인",
  });
  if (/부산/.test(profile.residence) && ["미취업", "졸업"].includes(profile.status) && age >= 18 && age <= 39) candidates.push({
    id: "busan-didimdol-plus-2026", title: "부산청년디딤돌카드 플러스", amount: "구직활동비·프로그램 지원 여부 확인", url: "https://young.busan.go.kr/index.nm?menuCd=31", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: "부산 거주와 취업준비 상태를 지역 구직지원 신호로 사용했습니다.", condition: "부산 거주·연령·미취업·소득 등 해당 연도 공고 조건 확인", evidence: ["주민등록", "미취업 확인", "구직활동 계획"], deadline: "2026 모집 공고 확인",
  });
  if (/광주/.test(profile.residence) && ["미취업", "졸업", "학생"].includes(profile.status) && age >= 18 && age <= 39) candidates.push({
    id: "gwangju-work-experience-2026", title: "광주청년 일경험드림", amount: "유형·근무기간별 지원", url: "https://youth.gwangju.go.kr/www/50?policyId=1252", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: "광주 거주와 학업·취업준비 상태를 지역 일경험 신호로 사용했습니다.", condition: "광주 거주·연령·취업 상태와 기수별 참여 조건 확인", evidence: ["광주 거주 확인", "취업 상태", "참여 신청"], deadline: "기수별 모집 공고 확인",
  });
  if ((intentDomains.has("assets") || /저축|적금|자산\s*형성|목돈|통장/.test(profileIntent)) && age >= 19 && age <= 34) candidates.push({
    id: "youth-tomorrow-savings", title: "청년내일저축계좌", amount: "소득·근로 조건에 따른 정부지원금 적립", url: "https://www.bokjiro.go.kr/ssis-teu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00000060", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: `${profile.goal || "자산 형성"} 목표를 청년 자산형성 지원 탐색 신호로 사용했습니다.`, condition: "연령·근로/사업소득·가구소득·재산 및 유지 조건 확인", evidence: ["근로·사업소득", "가구소득·재산", "저축계좌"], deadline: "연도별 모집 공고 확인",
  });
  if (/서울/.test(profile.residence) && (intentDomains.has("mental-health") || /우울|불안|심리\s*상담|마음\s*(?:건강|상담)|정신\s*건강/.test(profileIntent)) && age >= 19 && age <= 39) candidates.push({
    id: "seoul-youth-mental-health", title: "서울 청년 마음건강 지원", amount: "심리검사·상담 유형별 지원", url: "https://youth.seoul.go.kr/youthConts.do?key=2310100076&sc_bbsStngSn=2212200001&sc_pbancSeCd=009", status: "review", eligibility: "review", checkedAt: "2026-09-03 13:00",
    reason: "서울 거주와 입력한 마음건강 목표를 상담지원 탐색 신호로 사용했습니다.", condition: "서울 거주·연령·신청차수 및 상담 참여 조건 확인", evidence: ["서울 거주 확인", "신청서", "상담 참여"], deadline: "차수별 모집 확인",
  });
  return candidates;
}

function eventPolicyCandidates(user) {
  const candidates = new Map();
  for (const event of user.events) {
    const eventText = `${event.title || ""} ${event.description || ""} ${(event.intentTags || []).join(" ")}`;
    const eventDomains = new Set((event.policyDomains || []).filter(domain => POLICY_DOMAINS.has(domain)));
    const typedPolicy = EVENT_POLICY_CATALOG[event.type];
    const matchedPolicies = [typedPolicy && (!typedPolicy.applies || typedPolicy.applies(user.profile)) ? typedPolicy : null, ...GENERAL_EVENT_POLICY_RULES.filter(rule => {
      const domainMatch = (POLICY_DOMAIN_BY_ID[rule.policy.id] || []).some(domain => eventDomains.has(domain));
      return (domainMatch || rule.pattern.test(eventText)) && (!rule.applies || rule.applies(user.profile));
    }).map(rule => rule.policy)].filter(Boolean);
    for (const policy of matchedPolicies) {
      const existing = candidates.get(policy.id);
      if (existing) {
        existing.eventIds.push(event.id);
        existing.eventTitles.push(event.title);
        continue;
      }
      const signal = policy.signal || (event.type === "interview" ? "면접" : event.type === "exam" ? "시험" : "창업");
      const intent = event.classificationSource === "ai" && event.intentTags?.length ? `AI가 ${event.intentTags.slice(0, 3).join("·")} 의도로 분석해` : `${signal} 일정 신호로`;
      candidates.set(policy.id, { ...policy, status: policy.status || "review", eligibility: "review", eventIds: [event.id], eventTitles: [event.title], reason: `${intent} 연결했습니다. 최종 조건은 공식 공고에서 확인하세요.` });
    }
  }
  return [...candidates.values()];
}

function policyRecommendationsFor(user) {
  const profileBased = profilePolicyCandidates(user.profile);
  const profileById = new Map(profileBased.map(policy => [policy.id, policy]));
  const eventBased = [];
  for (const policy of eventPolicyCandidates(user)) {
    const profilePolicy = profileById.get(policy.id);
    if (!profilePolicy) {
      eventBased.push(policy);
      continue;
    }
    profilePolicy.eventIds = policy.eventIds;
    profilePolicy.eventTitles = policy.eventTitles;
    profilePolicy.reason = `${profilePolicy.reason} ${policy.reason} 연결 일정: ${policy.eventTitles.join(", ")}.`;
  }
  return {
    profileBased: profileBased.map(decoratePolicySource),
    eventBased: eventBased.map(decoratePolicySource),
    discoveryLinks: buildPolicyDiscoveryLinks(user.profile, user.events),
    connectors: policyConnectorStatus(),
  };
}

function authRateLimited(request, email) {
  const now = Date.now();
  const key = `${request.socket.remoteAddress || "unknown"}:${email}`;
  const record = authAttempts.get(key);
  const current = !record || record.resetAt <= now ? { count: 0, resetAt: now + 15 * 60_000 } : record;
  current.count += 1;
  authAttempts.set(key, current);
  return current.count > 10;
}
function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
function decryptSecret(value) {
  const [iv, tag, encrypted] = String(value || "").split(".");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const googleRedirectUri = kind => (kind === "signin" ? process.env.GOOGLE_AUTH_REDIRECT_URI : process.env.GOOGLE_REDIRECT_URI) || `http://localhost:${PORT}/api/${kind === "signin" ? "auth/google" : "calendar/google"}/callback`;
function createPkceState(record) {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  oauthStates.set(state, { ...record, verifier, createdAt: Date.now() });
  return { state, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
function readOAuthState(state) {
  const record = oauthStates.get(state);
  return record && Date.now() - record.createdAt <= OAUTH_TTL ? record : null;
}
async function exchangeGoogleCode(code, verifier, redirectUri) {
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  return response.json();
}
async function refreshAccessToken(connection) {
  if (connection.expiresAt > Date.now() + 60_000) return decryptSecret(connection.accessToken);
  if (!connection.refreshToken) throw new Error("Google refresh token is missing; reconnect required");
  const response = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: decryptSecret(connection.refreshToken), grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Google token refresh failed (${response.status})`);
  const tokens = await response.json();
  connection.accessToken = encryptSecret(tokens.access_token);
  connection.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  await persistDatabase();
  return tokens.access_token;
}
function normalizeGoogleEvent(item) {
  const start = item.start?.dateTime || item.start?.date || "";
  const end = item.end?.dateTime || item.end?.date || "";
  const title = String(item.summary || "일정").slice(0, 200);
  const description = String(item.description || "").slice(0, 2000);
  const localAnalysis = inferServerEventType(title, description);
  return {
    id: `google-${createHash("sha256").update(String(item.id)).digest("hex").slice(0, 24)}`,
    providerId: String(item.id), title, description,
    date: start.slice(0, 10), startTime: start.includes("T") ? start.slice(11, 16) : "", endTime: end.includes("T") ? end.slice(11, 16) : "",
    type: localAnalysis.type, confidence: localAnalysis.confidence, classificationSource: "local", policyDomains: inferPolicyDomains(title, description), intentTags: [], source: "google", channel: "google",
  };
}
async function fetchGoogleChanges(connection, forceFull = false) {
  const accessToken = await refreshAccessToken(connection);
  const items = [];
  let pageToken = "";
  let nextSyncToken = null;
  do {
    const params = new URLSearchParams({ maxResults: "2500", showDeleted: "true" });
    if (!forceFull && connection.nextSyncToken) params.set("syncToken", connection.nextSyncToken);
    else params.set("singleEvents", "true");
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${GOOGLE_EVENTS}?${params}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (response.status === 410 && !forceFull) return fetchGoogleChanges({ ...connection, nextSyncToken: null }, true);
    if (!response.ok) throw new Error(`Google calendar sync failed (${response.status})`);
    const body = await response.json();
    items.push(...(body.items || []));
    pageToken = body.nextPageToken || "";
    nextSyncToken = body.nextSyncToken || nextSyncToken;
  } while (pageToken);
  return { items, nextSyncToken, fullSync: forceFull || !connection.nextSyncToken };
}
function applyGoogleChanges(user, items, fullSync) {
  const existing = new Map(user.events.filter(event => event.providerId).map(event => [event.providerId, event]));
  if (fullSync) user.events = user.events.filter(event => !event.providerId);
  for (const item of items) {
    const previous = existing.get(String(item.id));
    user.events = user.events.filter(event => event.providerId !== String(item.id));
    if (item.status === "cancelled") continue;
    const normalized = normalizeGoogleEvent(item);
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized.date)) user.events.push({ ...normalized, type: previous?.type || normalized.type });
  }
}

async function enrichGoogleEventsWithAI(user) {
  if (!process.env.GROQ_API_KEY) return;
  const targets = user.events.filter(event => event.providerId && event.classificationSource !== "ai").slice(0, 12);
  await Promise.all(targets.map(async event => {
    try {
      const analysis = await requestGroqAnalysis({ title: event.title, description: event.description, startTime: `${event.date}T${event.startTime || "09:00"}:00+09:00` });
      const localType = inferServerEventType(event.title, event.description);
      event.type = analysis.type === "general" && localType.type !== "general" ? localType.type : analysis.type;
      event.confidence = analysis.confidence;
      event.classificationSource = "ai";
      event.analysisRationale = analysis.rationale;
      event.intentTags = analysis.intentTags;
      event.evidenceCandidates = analysis.evidenceCandidates;
      event.policyDomains = [...new Set([...analysis.policyDomains, ...inferPolicyDomains(event.title, event.description)])].slice(0, 8);
    } catch {
      // Local intent extraction remains available when Groq is unavailable.
    }
  }));
}

async function handleAuth(request, response, url) {
  if (request.method === "POST" && ["/api/auth/signup", "/api/auth/login"].includes(url.pathname)) {
    const body = await readBody(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!validCredentials(email, password)) return send(response, 400, { error: "이메일 형식과 10자 이상 비밀번호를 확인하세요." });
    if (authRateLimited(request, email)) return send(response, 429, { error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
    let user = database.users[database.emails[email]];
    if (url.pathname.endsWith("signup")) {
      if (user) return send(response, 409, { error: "계정을 만들 수 없습니다. 입력 내용을 확인하거나 로그인하세요." });
      const id = randomBytes(16).toString("hex");
      user = { id, email, password: passwordHash(password), profile: null, events: [], createdAt: Date.now() };
      database.users[id] = user;
      database.emails[email] = id;
      await persistDatabase();
    } else if (!user || !user.password || !passwordMatches(password, user.password)) return send(response, 401, { error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    const token = issueSession(user.id);
    await persistDatabase();
    return send(response, 200, { user: publicUser(user), session: { expiresIn: SESSION_TTL / 1000 } }, { "set-cookie": `calenfit_session=${token}; ${cookieAttributes(SESSION_TTL / 1000)}` });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const session = currentSession(request);
    return send(response, session ? 200 : 401, session ? { user: publicUser(session.user) } : { error: "not authenticated" });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = currentSession(request);
    if (session) sessions.delete(session.id);
    await persistDatabase();
    return send(response, 200, { ok: true }, { "set-cookie": `calenfit_session=; ${cookieAttributes(0)}` });
  }
  if (request.method === "DELETE" && url.pathname === "/api/auth/account") {
    const session = currentSession(request);
    if (!session) return send(response, 401, { error: "login required" });
    const body = await readBody(request);
    const confirmed = session.user.password
      ? passwordMatches(String(body.password || ""), session.user.password)
      : String(body.confirmEmail || "").trim().toLowerCase() === session.user.email;
    if (!confirmed) return send(response, 403, { error: "계정 삭제 확인 정보가 올바르지 않습니다." });
    const userId = session.user.id;
    delete database.emails[session.user.email];
    delete database.users[userId];
    delete database.googleConnections[userId];
    for (const [id, record] of Object.entries(database.sessions)) if (record.userId === userId) delete database.sessions[id];
    for (const [state, record] of Object.entries(database.oauthStates)) if (record.userId === userId || record.sessionId === session.id) delete database.oauthStates[state];
    await persistDatabase();
    return send(response, 200, { ok: true }, { "set-cookie": `calenfit_session=; ${cookieAttributes(0)}` });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/google/start") {
    if (!googleConfigured()) return send(response, 503, { code: "SOCIAL_AUTH_NOT_CONFIGURED", error: "Google 로그인 서버 설정이 필요합니다." });
    const nonce = randomBytes(24).toString("base64url");
    const { state, challenge } = createPkceState({ purpose: "signin", nonce });
    await persistDatabase();
    const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri("signin"), response_type: "code", scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", access_type: "online", include_granted_scopes: "true" });
    return send(response, 200, { authorizationUrl: `${GOOGLE_AUTH}?${params}` }, { "set-cookie": `calenfit_oauth_nonce=${nonce}; ${cookieAttributes(OAUTH_TTL / 1000)}` });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/google/callback") {
    const stateValue = url.searchParams.get("state");
    const state = readOAuthState(stateValue);
    if (!state || state.purpose !== "signin" || state.nonce !== readCookie(request, "calenfit_oauth_nonce")) return redirect(response, "/?auth=error");
    oauthStates.delete(stateValue);
    if (url.searchParams.get("error")) { await persistDatabase(); return redirect(response, "/?auth=denied"); }
    const tokens = await exchangeGoogleCode(url.searchParams.get("code"), state.verifier, googleRedirectUri("signin"));
    const infoResponse = await fetch(process.env.GOOGLE_USERINFO_URL || "https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    if (!infoResponse.ok) return redirect(response, "/?auth=error");
    const info = await infoResponse.json();
    if (!info.email || info.verified_email === false) return redirect(response, "/?auth=error");
    const email = String(info.email).trim().toLowerCase();
    let user = database.users[database.emails[email]];
    if (!user) {
      const id = randomBytes(16).toString("hex");
      user = { id, email, password: null, profile: null, events: [], googleSubject: String(info.id || ""), createdAt: Date.now() };
      database.users[id] = user;
      database.emails[email] = id;
      await persistDatabase();
    }
    const token = issueSession(user.id);
    await persistDatabase();
    return redirect(response, "/?auth=google", { "set-cookie": [`calenfit_session=${token}; ${cookieAttributes(SESSION_TTL / 1000)}`, `calenfit_oauth_nonce=; ${cookieAttributes(0)}`] });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/kakao/start") return send(response, 501, { code: "KAKAO_AUTH_PLANNED", error: "카카오 로그인은 후속 구현 예정입니다." });
  return false;
}

async function handlePrivateData(request, response, url) {
  if (!(url.pathname === "/api/profile" || url.pathname === "/api/policies" || url.pathname === "/api/events" || url.pathname.startsWith("/api/events/"))) return false;
  const session = currentSession(request);
  if (!session) return send(response, 401, { error: "login required" });
  if (url.pathname === "/api/profile" && request.method === "GET") return send(response, 200, { profile: session.user.profile });
  if (url.pathname === "/api/profile" && request.method === "POST") {
    session.user.profile = await analyzeProfileIntent(normalizeProfile(await readBody(request)));
    await persistDatabase();
    return send(response, 200, { profile: session.user.profile });
  }
  if (url.pathname === "/api/profile" && request.method === "DELETE") {
    session.user.profile = null;
    await persistDatabase();
    return send(response, 200, { ok: true });
  }
  if (url.pathname === "/api/policies" && request.method === "GET") return send(response, 200, policyRecommendationsFor(session.user));
  if (url.pathname === "/api/events" && request.method === "GET") return send(response, 200, { events: session.user.events });
  if (url.pathname === "/api/events" && request.method === "POST") {
    const body = await readBody(request);
    const title = String(body.title || "").trim().slice(0, 200);
    const description = String(body.description || "").slice(0, 2000);
    const date = String(body.date || "").slice(0, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(response, 400, { error: "title and valid date are required" });
    const analysis = await analyzeEventIntent(title, description, date);
    const event = { id: randomBytes(16).toString("hex"), title, date, description, startTime: String(body.startTime || "").slice(0, 5), endTime: String(body.endTime || "").slice(0, 5), ...analysis, source: "calenfit", channel: "manual" };
    session.user.events.push(event);
    await persistDatabase();
    return send(response, 201, { event });
  }
  if ((request.method === "PATCH" || request.method === "DELETE") && url.pathname.startsWith("/api/events/")) {
    const id = url.pathname.split("/").pop();
    const index = session.user.events.findIndex(item => item.id === id);
    if (index < 0) return send(response, 404, { error: "event not found" });
    if (request.method === "DELETE") {
      const removed = session.user.events[index];
      if (removed.providerId) return send(response, 409, { error: "Google Calendar 일정은 Google Calendar에서 삭제한 뒤 동기화하세요." });
      session.user.events.splice(index, 1);
      await persistDatabase();
      return send(response, 200, { ok: true });
    }
    const body = await readBody(request);
    const current = session.user.events[index];
    if (body.title !== undefined && !String(body.title).trim()) return send(response, 400, { error: "title is required" });
    if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) return send(response, 400, { error: "valid date is required" });
    const nextTitle = body.title === undefined ? current.title : String(body.title).trim().slice(0, 200);
    const nextDescription = body.description === undefined ? current.description : String(body.description).slice(0, 2000);
    const nextDate = body.date === undefined ? current.date : String(body.date).slice(0, 10);
    const analysis = await analyzeEventIntent(nextTitle, nextDescription, nextDate);
    session.user.events[index] = { ...current, title: nextTitle, date: nextDate, description: nextDescription, ...analysis };
    await persistDatabase();
    return send(response, 200, { event: session.user.events[index] });
  }
  return send(response, 405, { error: "method not allowed" });
}

async function handleGoogleCalendar(request, response, url) {
  const routes = ["/api/calendar/google/connect", "/api/calendar/google/callback", "/api/calendar/google/status", "/api/calendar/status", "/api/calendar/google/sync", "/api/calendar/google/disconnect"];
  if (!routes.includes(url.pathname)) return false;
  const session = currentSession(request);
  if (!session) return send(response, 401, { error: "login required" });
  if (["/api/calendar/google/status", "/api/calendar/status"].includes(url.pathname)) {
    const connection = database.googleConnections[session.user.id];
    return send(response, 200, { provider: "google", state: connection ? "synced" : googleConfigured() ? "configured" : "not-configured", lastSyncAt: connection?.lastSyncAt || null });
  }
  if (url.pathname.endsWith("/connect") && request.method === "GET") {
    if (!googleConfigured()) return send(response, 503, { code: "GOOGLE_OAUTH_NOT_CONFIGURED", error: "Google OAuth 서버 설정이 필요합니다." });
    const { state, challenge } = createPkceState({ purpose: "calendar", sessionId: session.id, userId: session.user.id });
    await persistDatabase();
    const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri("calendar"), response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true", scope: CALENDAR_SCOPE, state, code_challenge: challenge, code_challenge_method: "S256" });
    return send(response, 200, { authorizationUrl: `${GOOGLE_AUTH}?${params}` });
  }
  if (url.pathname.endsWith("/callback") && request.method === "GET") {
    const stateValue = url.searchParams.get("state");
    const state = readOAuthState(stateValue);
    if (!state || state.purpose !== "calendar" || state.sessionId !== session.id || state.userId !== session.user.id) return redirect(response, "/?google=error");
    oauthStates.delete(stateValue);
    if (url.searchParams.get("error")) { await persistDatabase(); return redirect(response, "/?google=denied"); }
    const tokens = await exchangeGoogleCode(url.searchParams.get("code"), state.verifier, googleRedirectUri("calendar"));
    if (!tokens.access_token) return redirect(response, "/?google=error");
    const previous = database.googleConnections[session.user.id];
    database.googleConnections[session.user.id] = { accessToken: encryptSecret(tokens.access_token), refreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : previous?.refreshToken || null, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, nextSyncToken: null, lastSyncAt: null };
    await persistDatabase();
    return redirect(response, "/?google=connected");
  }
  if (url.pathname.endsWith("/sync") && request.method === "POST") {
    const connection = database.googleConnections[session.user.id];
    if (!connection) return send(response, 409, { error: "Google calendar is not connected" });
    const result = await fetchGoogleChanges(connection);
    applyGoogleChanges(session.user, result.items, result.fullSync);
    await enrichGoogleEventsWithAI(session.user);
    connection.nextSyncToken = result.nextSyncToken || connection.nextSyncToken;
    connection.lastSyncAt = new Date().toISOString();
    await persistDatabase();
    return send(response, 200, { events: session.user.events.filter(item => item.providerId), nextSyncTokenStored: Boolean(connection.nextSyncToken), fullSync: result.fullSync });
  }
  if (url.pathname.endsWith("/disconnect") && request.method === "POST") {
    delete database.googleConnections[session.user.id];
    session.user.events = session.user.events.filter(event => !event.providerId);
    await persistDatabase();
    return send(response, 200, { state: "disconnected" });
  }
  return send(response, 405, { error: "method not allowed" });
}

async function requestGroqAnalysis(input) {
  if (!process.env.GROQ_API_KEY) throw Object.assign(new Error("Groq proxy is not configured"), { status: 503, code: "GROQ_NOT_CONFIGURED" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let upstream;
  try {
    upstream = await fetch(GROQ_API_URL, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" }, body: json({ model: GROQ_MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: "Return JSON only with type, confidence, rationale, evidenceCandidates, intentTags, policyDomains. type: interview|exam|startup|general. confidence: 0..1. policyDomains is an array chosen only from employment, work-experience, unemployment, exam, housing, tax-credit, sports, culture, education, scholarship, military, health, mental-health, startup, finance, assets, marriage, family, childbirth, childcare, welfare, transport, general. Infer the underlying life event, including paraphrases, but do not infer a life event contradicted or negated by the text. Examples: swimming class=>sports, lease contract=>housing, earned-income tax credit=>tax-credit, contract termination=>unemployment, internship orientation=>work-experience, birth registration=>childbirth, parental leave=>childcare, tuition payment=>scholarship. intentTags is up to 10 short Korean phrases. Never name or decide a specific benefit, eligibility, amount, budget, validity, application result, financial suitability, or credit." }, { role: "user", content: json(input) }] }) });
  } finally { clearTimeout(timeout); }
  if (!upstream.ok) {
    const rateLimited = upstream.status === 429;
    throw Object.assign(new Error(rateLimited ? "Groq rate limit reached" : `Groq upstream ${upstream.status}`), {
      status: rateLimited ? 429 : 502,
      code: rateLimited ? "GROQ_RATE_LIMITED" : "GROQ_UPSTREAM_ERROR",
      upstreamStatus: upstream.status,
      retryAfter: upstream.headers.get("retry-after") || null,
    });
  }
  const result = await upstream.json();
  let parsed;
  const content = String(result.choices?.[0]?.message?.content || "{}");
  try { parsed = JSON.parse(content); }
  catch {
    try { parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || "{}"); }
    catch { throw Object.assign(new Error("Groq returned invalid JSON"), { status: 502, code: "GROQ_INVALID_JSON" }); }
  }
  const local = inferServerEventType(input.title, input.description);
  const confidenceValue = Number(parsed.confidence);
  const type = ["interview", "exam", "startup", "general"].includes(parsed.type) ? parsed.type : local.type;
  const confidence = Number.isFinite(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 1 ? confidenceValue : local.confidence;
  const aiPolicyDomains = Array.isArray(parsed.policyDomains) ? parsed.policyDomains.filter(domain => POLICY_DOMAINS.has(domain)).slice(0, 8) : [];
  const policyDomains = reconcilePolicyDomains(input, aiPolicyDomains);
  const domainsCorrected = policyDomains.some(domain => !aiPolicyDomains.includes(domain)) || aiPolicyDomains.some(domain => !policyDomains.includes(domain));
  return { type, confidence, rationale: String(parsed.rationale || "").slice(0, 300), evidenceCandidates: Array.isArray(parsed.evidenceCandidates) ? parsed.evidenceCandidates.filter(item => typeof item === "string").map(item => item.slice(0, 100)).slice(0, 8) : [], intentTags: Array.isArray(parsed.intentTags) ? parsed.intentTags.filter(item => typeof item === "string").map(item => item.slice(0, 60)).slice(0, 10) : [], policyDomains, corrected: parsed.type !== type || confidenceValue !== confidence || domainsCorrected, providerResponseId: String(result.id || "").slice(0, 120), providerModel: String(result.model || GROQ_MODEL).slice(0, 120) };
}

let groqHealthCache = { checkedAt: 0, result: null };
async function probeGroq() {
  if (!process.env.GROQ_API_KEY) return { configured: false, reachable: false, provider: "groq", code: "GROQ_NOT_CONFIGURED" };
  if (groqHealthCache.result && Date.now() - groqHealthCache.checkedAt < 30_000) return groqHealthCache.result;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  let result;
  try {
    const response = await fetch(GROQ_MODELS_URL, { signal: controller.signal, headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" } });
    const body = response.ok ? await response.json() : {};
    const modelAvailable = Array.isArray(body.data) ? body.data.some(model => model.id === GROQ_MODEL) : response.ok;
    result = { configured: true, reachable: response.ok && modelAvailable, provider: "groq", model: GROQ_MODEL, modelAvailable, upstreamStatus: response.status };
  } catch (error) {
    result = { configured: true, reachable: false, provider: "groq", model: GROQ_MODEL, modelAvailable: false, code: error.name === "AbortError" ? "GROQ_HEALTH_TIMEOUT" : "GROQ_HEALTH_FAILED" };
  } finally { clearTimeout(timeout); }
  groqHealthCache = { checkedAt: Date.now(), result };
  return result;
}

async function handleAI(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/ai/health") {
    const health = await probeGroq();
    return send(response, health.reachable ? 200 : health.configured ? 502 : 503, health);
  }
  if (request.method !== "POST" || url.pathname !== "/api/ai/analyze") return false;
  if (!currentSession(request)) return send(response, 401, { error: "login required" });
  const body = await readBody(request);
  const input = { title: String(body.input?.title || body.title || "").slice(0, 200), description: String(body.input?.description || body.description || "").slice(0, 2000), startTime: String(body.input?.startTime || body.startTime || "").slice(0, 80) };
  try { return send(response, 200, await requestGroqAnalysis(input)); }
  catch (error) { return send(response, error.name === "AbortError" ? 504 : error.status || 502, { code: error.code || "GROQ_ANALYSIS_FAILED", error: error.name === "AbortError" ? "Groq analysis timed out" : error.message, ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}), ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }); }
}

const contentType = file => ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" }[extname(file).toLowerCase()] || "application/octet-stream");
async function serveStatic(request, response) {
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!PUBLIC_FILES.has(relative)) return send(response, 404, { error: "not found" });
  const file = resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) return send(response, 403, { error: "forbidden" });
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(body);
  } catch (error) { send(response, error.code === "ENOENT" ? 404 : 500, { error: error.code === "ENOENT" ? "not found" : "server error" }); }
}
async function handle(request, response) {
  const url = new URL(request.url || "/", "http://localhost");
  try {
    if (process.env.DATABASE_URL) database = await loadDatabase();
    if (url.pathname.startsWith("/api/") && ["POST", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) return send(response, 403, { error: "cross-origin request rejected" });
    }
    if (await handleAuth(request, response, url) !== false) return;
    if (await handlePrivateData(request, response, url) !== false) return;
    if (await handleGoogleCalendar(request, response, url) !== false) return;
    if (await handleAI(request, response, url) !== false) return;
    return serveStatic(request, response);
  } catch (error) {
    const timeout = error.name === "AbortError";
    return send(response, timeout ? 504 : 400, { error: timeout ? "upstream timeout" : error.message || "bad request" });
  }
}

export { handle };

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) createServer(handle).listen(PORT, () => console.log(`Calenfit server listening on http://localhost:${PORT}`));

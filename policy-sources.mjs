export const POLICY_SOURCE_REGISTRY = Object.freeze({
  youthCenter: {
    id: "youth-center",
    name: "온통청년",
    homepage: "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch?pubotYn=Y",
    apiGuide: "https://www.youthcenter.go.kr/cmnFooter/openapiIntro/oaiGuide",
    coverage: "전국 청년정책",
    apiRequiresApproval: true,
  },
  governmentBenefits: {
    id: "government-benefits",
    name: "정부24 혜택알리미",
    homepage: "https://plus.gov.kr/portal/benefitV2/",
    coverage: "중앙부처·지자체·공공기관·교육청 혜택",
  },
  bokjiro: {
    id: "bokjiro",
    name: "복지로",
    homepage: "https://www.bokjiro.go.kr/",
    coverage: "복지서비스·자산형성·주거·건강 지원",
  },
  work24: {
    id: "work24",
    name: "고용24",
    homepage: "https://www.work24.go.kr/cm/main.do",
    apiGuide: "https://www.work24.go.kr/cm/e/a/0110/selectOpenApiIntro.do",
    coverage: "취업·일경험·직업훈련",
    apiRequiresApproval: true,
  },
  gyeonggiYouth: {
    id: "gyeonggi-youth",
    name: "경기청년포털",
    homepage: "https://youth.gg.go.kr/gg/intro/introducing-the-gyeonggi-youth-portal.do",
    coverage: "경기도 청년정책",
  },
  seoulYouth: { id: "seoul-youth", name: "청년몽땅정보통", homepage: "https://youth.seoul.go.kr/mainA.do", coverage: "서울 청년정책" },
  busanYouth: { id: "busan-youth", name: "부산청년플랫폼", homepage: "https://young.busan.go.kr/", coverage: "부산 청년정책" },
  gwangjuYouth: { id: "gwangju-youth", name: "광주청년통합플랫폼", homepage: "https://youth.gwangju.go.kr/www/50", coverage: "광주 청년정책" },
});

const sourceByHost = [
  ["hanam.go.kr", "하남시"],
  ["apply.jobaba.net", "잡아바 어플라이"],
  ["jobaba.net", "잡아바"],
  ["youth.gg.go.kr", "경기청년포털"],
  ["youthcenter.go.kr", "온통청년"],
  ["plus.gov.kr", "정부24 혜택알리미"],
  ["bokjiro.go.kr", "복지로"],
  ["youth.seoul.go.kr", "청년몽땅정보통"],
  ["young.busan.go.kr", "부산청년플랫폼"],
  ["youth.gwangju.go.kr", "광주청년통합플랫폼"],
  ["work24.go.kr", "고용24"],
  ["nts.go.kr", "국세청"],
  ["fsc.go.kr", "금융위원회"],
  ["kspo.or.kr", "국민체력100"],
  ["mnuri.kr", "문화누리"],
  ["khepi.or.kr", "국가금연지원센터"],
  ["kosaf.go.kr", "한국장학재단"],
  ["gov.kr", "정부24"],
];

export function decoratePolicySource(policy) {
  let hostname = "";
  try { hostname = new URL(policy.url).hostname; } catch {}
  const sourcePortal = sourceByHost.find(([host]) => hostname.endsWith(host))?.[1] || "공식 운영기관";
  return {
    ...policy,
    sourcePortal,
    sourceHost: hostname,
    sourceUrl: policy.url,
    retrievedAt: policy.checkedAt || null,
    sourceMode: policy.checkedAt ? "maintainer-verified-snapshot" : "unverified",
    verificationMethod: policy.checkedAt ? "official-page-review" : "not-verified",
    uncertainty: policy.uncertainty || "공고 변경·예산·세부 자격은 공식 페이지에서 다시 확인해야 합니다.",
  };
}

function uniqueTerms(values) {
  return [...new Set(values.flatMap(value => String(value || "").split(/[\s,/·]+/)).map(value => value.trim()).filter(value => value.length >= 2))].slice(0, 10);
}

function searchUrl(base, query) {
  const url = new URL(base);
  url.searchParams.set("keyword", query);
  return url.toString();
}

export function buildPolicyDiscoveryLinks(profile, events = []) {
  if (!profile) return [];
  const eventTerms = events.flatMap(event => [event.title, ...(event.intentTags || []), ...(event.policyDomains || [])]);
  const profileTerms = [profile.residence, profile.status, profile.education, profile.school, profile.major, profile.goal, `${profile.birthYear}년생`];
  const query = uniqueTerms([...profileTerms, ...eventTerms]).join(" ") || "청년 정책";
  const links = [
    {
      id: "discover-youth-center",
      title: "온통청년에서 더 찾기",
      sourcePortal: "온통청년",
      url: searchUrl("https://www.youthcenter.go.kr/totalSearch/search", query),
      reason: "나이·지역·학력·상태·목표와 일정 신호를 묶어 전국 청년정책을 탐색합니다.",
      coverage: POLICY_SOURCE_REGISTRY.youthCenter.coverage,
      sourceMode: "official-search",
      destinationKind: "official",
    },
    {
      id: "discover-government-benefits",
      title: "정부24 혜택알리미 확인",
      sourcePortal: "정부24 혜택알리미",
      url: POLICY_SOURCE_REGISTRY.governmentBenefits.homepage,
      reason: "중앙부처와 지자체, 공공기관, 교육청 혜택을 추가로 확인합니다.",
      coverage: POLICY_SOURCE_REGISTRY.governmentBenefits.coverage,
      sourceMode: "official-search",
      destinationKind: "official",
    },
    {
      id: "discover-work24",
      title: "고용24에서 취업·훈련 찾기",
      sourcePortal: "고용24",
      url: POLICY_SOURCE_REGISTRY.work24.homepage,
      reason: `${profile.status || "현재 상태"}·${profile.major || "전공"}·${profile.goal || "목표"}에 맞는 일경험과 직업훈련을 확인합니다.`,
      coverage: POLICY_SOURCE_REGISTRY.work24.coverage,
      sourceMode: "official-search",
      destinationKind: "official",
    },
    {
      id: "discover-bokjiro",
      title: "복지로에서 더 찾기",
      sourcePortal: "복지로",
      url: POLICY_SOURCE_REGISTRY.bokjiro.homepage,
      reason: "주거·자산형성·건강 등 복지서비스의 지원대상과 신청방법을 추가로 확인합니다.",
      coverage: POLICY_SOURCE_REGISTRY.bokjiro.coverage,
      sourceMode: "official-search",
      destinationKind: "official",
    },
  ];
  if (/경기|하남|수원|성남|용인|고양|부천|안양|남양주|화성|평택/.test(profile.residence)) links.push({
    id: "discover-gyeonggi-youth",
    title: "경기청년포털 확인",
    sourcePortal: "경기청년포털",
    url: POLICY_SOURCE_REGISTRY.gyeonggiYouth.homepage,
    reason: `${profile.residence}와 관련된 경기도 청년정책을 추가로 확인합니다.`,
    coverage: POLICY_SOURCE_REGISTRY.gyeonggiYouth.coverage,
    sourceMode: "official-search",
    destinationKind: "official",
  });
  const regionalSource = /서울/.test(profile.residence) ? POLICY_SOURCE_REGISTRY.seoulYouth
    : /부산/.test(profile.residence) ? POLICY_SOURCE_REGISTRY.busanYouth
      : /광주/.test(profile.residence) ? POLICY_SOURCE_REGISTRY.gwangjuYouth : null;
  if (regionalSource) links.push({
    id: `discover-${regionalSource.id}`,
    title: `${regionalSource.name} 확인`,
    sourcePortal: regionalSource.name,
    url: regionalSource.homepage,
    reason: `${profile.residence} 거주자를 위한 지역 청년정책을 추가로 확인합니다.`,
    coverage: regionalSource.coverage,
    sourceMode: "official-search",
    destinationKind: "official",
  });
  if (profile.school) {
    const schoolQuery = `site:ac.kr "${profile.school}" 공지 장학금 지원 사업`;
    links.push({
      id: "discover-school-notices",
      title: `${profile.school} 공지 검색 경로`,
      sourcePortal: "Google 검색 locator",
      url: `https://www.google.com/search?q=${encodeURIComponent(schoolQuery)}`,
      reason: `${profile.school}와 ${profile.major || "입력한 전공"} 관련 장학·지원·현장실습 공지를 찾습니다. 검색 결과의 학교 공식 도메인 여부를 확인하세요.`,
      coverage: "학교·학과 공식 공지",
      sourceMode: "official-site-locator",
      destinationKind: "locator",
    });
  }
  return links;
}

export function policyConnectorStatus(environment = process.env) {
  return {
    youthCenter: environment.YOUTH_POLICY_API_KEY ? "configured" : "approval-required",
    work24: environment.WORK24_API_KEY ? "configured" : "approval-required",
    snapshots: "active",
  };
}

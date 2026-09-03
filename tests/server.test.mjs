import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18000 + Math.floor(Math.random() * 1000);
const testDirectory = await mkdtemp(join(tmpdir(), "calenfit-server-test-"));
const dataFile = join(testDirectory, "calenfit.json");
const child = spawn(
  process.execPath,
  ["--import", new URL("./support/mock-google-oauth.mjs", import.meta.url).pathname, "server.mjs"],
  {
    env: {
      ...process.env,
      PORT: String(port),
      CALENFIT_SESSION_SECRET: "test-secret-not-production",
      CALENFIT_DATA_FILE: dataFile,
      MOCK_GOOGLE_OAUTH: "1",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      GROQ_API_KEY: "test-groq-key",
      YOUTH_POLICY_API_KEY: "",
      WORK24_API_KEY: "",
      GOOGLE_REDIRECT_URI: `http://localhost:${port}/api/calendar/google/callback`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server start timeout")), 5000);
  child.stdout.on("data", chunk => {
    if (String(chunk).includes("listening")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.once("error", reject);
});

const base = `http://127.0.0.1:${port}`;
const createClient = () => {
  let cookie = "";
  return async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(options.headers || {}),
      },
      redirect: "manual",
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, cookie };
  };
};

const signupPayload = (email, overrides = {}) => ({
  email,
  password: "correct horse battery",
  profile: {
    birthYear: 2001,
    residence: "경기도 하남시",
    status: "미취업",
    education: "대학교 4학년",
    goal: "취업 준비",
    ...overrides,
  },
});

try {
  const anonymous = createClient();
  for (const path of [
    "/api/auth/session",
    "/api/profile",
    "/api/policies",
    "/api/events",
    "/api/calendar/google/connect",
    "/api/calendar/google/sync",
  ]) {
    const result = await anonymous(path);
    assert.equal(result.response.status, 401, `${path} should require auth`);
  }
  const indexResponse = await fetch(`${base}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/.data/calenfit.json`)).status, 404);

  const primary = createClient();
  const secondary = createClient();

  const signup = await primary("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify(signupPayload("server-test@example.com")),
  });
  assert.equal(signup.response.status, 200);
  assert.equal(signup.body.user.email, "server-test@example.com");
  assert.match(signup.cookie, /^calenfit_session=/);

  const duplicateSignup = await primary("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify(signupPayload("server-test@example.com")),
  });
  assert.equal(duplicateSignup.response.status, 409);
  assert.equal(duplicateSignup.body.error.includes("이미 가입"), false);

  const session = await primary("/api/auth/session");
  assert.equal(session.response.status, 200);
  assert.equal(session.body.user.mode, "account");
  assert.equal(session.body.user.profile, null);

  const profile = await primary("/api/profile", {
    method: "POST",
    body: JSON.stringify({
      birthYear: 2001,
      residence: "경기도 하남시",
      status: "학생",
      education: "대학교 4학년",
      school: "한국대학교",
      major: "정보보안학",
      goal: "데이터 직무",
    }),
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.profile.goal, "데이터 직무");
  assert.equal(profile.body.profile.major, "정보보안학");
  assert.equal(profile.body.profile.school, "한국대학교");
  assert.equal((await primary("/api/auth/session")).body.user.profile.status, "학생");
  const profilePolicies = await primary("/api/policies");
  assert.equal(profilePolicies.response.status, 200);
  assert.equal(profilePolicies.body.profileBased.some(policy => policy.id === "hanam-basic-income-2026-q3"), true);
  assert.equal(profilePolicies.body.profileBased.some(policy => policy.id === "hanam-job-training-2026"), true);
  assert.equal(profilePolicies.body.profileBased.some(policy => policy.id === "national-scholarship-2026-fall"), true);
  assert.equal(profilePolicies.body.profileBased.every(policy => policy.sourcePortal && policy.sourceUrl && policy.retrievedAt && policy.uncertainty), true);
  assert.equal(profilePolicies.body.discoveryLinks.some(link => link.id === "discover-school-notices"), true);
  assert.deepEqual(profilePolicies.body.connectors, { youthCenter: "approval-required", work24: "approval-required", snapshots: "active" });
  assert.equal(profilePolicies.body.discoveryLinks.some(link => link.id === "discover-youth-center"), true);
  assert.equal(profilePolicies.body.discoveryLinks.some(link => link.id === "discover-work24"), true);
  assert.equal(JSON.stringify(profilePolicies.body.connectors).includes("live"), false);
  assert.equal(profilePolicies.body.eventBased.length, 0);
  const aiHealth = await primary("/api/ai/health");
  assert.equal(aiHealth.response.status, 200);
  assert.equal(aiHealth.body.reachable, true);
  assert.equal(aiHealth.body.modelAvailable, true);
  const csrf = await primary("/api/profile", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
    body: JSON.stringify({ birthYear: 2000, residence: "서울", status: "재직" }),
  });
  assert.equal(csrf.response.status, 403);

  const forgedIntent = await primary("/api/events", { method: "POST", body: JSON.stringify({ title: "친구 생일파티", date: "2026-09-18", description: "케이크 픽업", type: "interview", classificationSource: "ai", policyDomains: ["housing"], intentTags: ["월세 계약"] }) });
  assert.equal(forgedIntent.response.status, 201);
  assert.equal(forgedIntent.body.event.type, "general");
  assert.deepEqual(forgedIntent.body.event.policyDomains, ["general"]);
  const policiesAfterForgery = (await primary("/api/policies")).body;
  const forgedLinked = [...policiesAfterForgery.profileBased, ...policiesAfterForgery.eventBased].filter(policy => (policy.eventIds || []).includes(forgedIntent.body.event.id));
  assert.equal(forgedLinked.length, 0);
  const forgedPatch = await primary(`/api/events/${forgedIntent.body.event.id}`, { method: "PATCH", body: JSON.stringify({ type: "exam", classificationSource: "ai", policyDomains: ["tax-credit"], intentTags: ["근로장려금"] }) });
  assert.equal(forgedPatch.response.status, 200);
  assert.equal(forgedPatch.body.event.type, "general");
  assert.deepEqual(forgedPatch.body.event.policyDomains, ["general"]);
  assert.equal((await primary(`/api/events/${forgedIntent.body.event.id}`, { method: "DELETE" })).response.status, 200);

  const event = await primary("/api/events", {
    method: "POST",
    body: JSON.stringify({
      title: "서버 저장 면접",
      date: "2026-09-20",
      description: "직접 추가",
      type: "interview",
    }),
  });
  assert.equal(event.response.status, 201);
  assert.equal((await primary("/api/events")).body.events.length, 1);
  assert.equal((await primary("/api/policies")).body.eventBased[0].id, "interview-allowance");
  const duplicatePolicyEvent = await primary("/api/events", {
    method: "POST",
    body: JSON.stringify({ title: "두 번째 서버 면접", date: "2026-09-21", type: "interview" }),
  });
  const deduplicatedPolicies = (await primary("/api/policies")).body.eventBased;
  assert.equal(deduplicatedPolicies.length, 1);
  assert.equal(deduplicatedPolicies[0].eventTitles.length, 2);
  assert.equal((await primary(`/api/events/${duplicatePolicyEvent.body.event.id}`, { method: "DELETE" })).response.status, 200);
  assert.equal((await primary("/api/events")).body.events.length, 1);
  const housingEvent = await primary("/api/events", { method: "POST", body: JSON.stringify({ title: "자취방 임대차 계약", date: "2026-09-22", type: "general" }) });
  assert.equal(housingEvent.body.event.policyDomains.includes("housing"), true);
  const taxCreditEvent = await primary("/api/events", { method: "POST", body: JSON.stringify({ title: "근로장려금 신청", date: "2026-09-10", type: "general" }) });
  const generalEventPolicyIds = (await primary("/api/policies")).body.eventBased.map(policy => policy.id);
  assert.equal(generalEventPolicyIds.includes("hanam-youth-rent-2026"), true);
  assert.equal(generalEventPolicyIds.includes("earned-income-tax-credit-2026-h1"), true);
  const expandedRuleEvents = [];
  for (const title of ["입영통지서 확인", "보건소 건강검진", "직무교육 수강", "인턴 일경험 신청", "퇴사 후 구직등록", "하남시 커뮤니티센터 수영 수업"]) {
    expandedRuleEvents.push(await primary("/api/events", { method: "POST", body: JSON.stringify({ title, date: "2026-09-24", type: "general" }) }));
  }
  const expandedRecommendations = (await primary("/api/policies")).body;
  const expandedPolicyIds = [...expandedRecommendations.profileBased, ...expandedRecommendations.eventBased].map(policy => policy.id);
  for (const id of ["hanam-enlistment-support", "hanam-youth-health-check", "hanam-job-training-2026", "future-tomorrow-experience-event", "national-employment-support", "tunteun-money-2026", "culture-nuri-card-2026"]) assert.equal(expandedPolicyIds.includes(id), true);
  assert.equal(expandedPolicyIds.includes("sports-class-voucher-2026"), false);
  assert.equal(expandedPolicyIds.filter(id => id === "hanam-job-training-2026").length, 1);
  await primary(`/api/events/${housingEvent.body.event.id}`, { method: "DELETE" });
  await primary(`/api/events/${taxCreditEvent.body.event.id}`, { method: "DELETE" });
  for (const result of expandedRuleEvents) await primary(`/api/events/${result.body.event.id}`, { method: "DELETE" });

  const otherSignup = await secondary("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify(signupPayload("isolated-user@example.com", { goal: "창업" })),
  });
  assert.equal(otherSignup.response.status, 200);
  assert.equal((await secondary("/api/events")).body.events.length, 0);

  const authorization = await primary("/api/calendar/google/connect");
  assert.equal(authorization.response.status, 200);
  const authorizationUrl = new URL(authorization.body.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "test-google-client-id");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), `http://localhost:${port}/api/calendar/google/callback`);
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events.readonly");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  assert.ok(authorizationUrl.searchParams.get("state"));

  const crossSessionCallback = await secondary(
    `/api/calendar/google/callback?state=${authorizationUrl.searchParams.get("state")}&code=test-code`,
  );
  assert.equal(crossSessionCallback.response.status, 302);
  assert.equal(crossSessionCallback.response.headers.get("location"), "/?google=error");

  const invalidState = await primary("/api/calendar/google/callback?state=wrong-state&code=test-code");
  assert.equal(invalidState.response.status, 302);
  assert.equal(invalidState.response.headers.get("location"), "/?google=error");

  const successfulCallback = await primary(
    `/api/calendar/google/callback?state=${authorizationUrl.searchParams.get("state")}&code=test-code`,
  );
  assert.equal(successfulCallback.response.status, 302);
  assert.equal(successfulCallback.response.headers.get("location"), "/?google=connected");

  const syncedStatus = await primary("/api/calendar/status");
  assert.equal(syncedStatus.response.status, 200);
  assert.equal(syncedStatus.body.state, "synced");
  assert.equal((await primary("/api/calendar/google/sync")).response.status, 405);
  const storedData = await readFile(dataFile, "utf8");
  assert.equal(storedData.includes("test-access-token"), false);
  assert.equal(storedData.includes("test-refresh-token"), false);

  const secondCallback = await primary(
    `/api/calendar/google/callback?state=${authorizationUrl.searchParams.get("state")}&code=test-code`,
  );
  assert.equal(secondCallback.response.status, 302);
  assert.equal(secondCallback.response.headers.get("location"), "/?google=error");

  const aiAnalysis = await primary("/api/ai/analyze", {
    method: "POST",
    body: JSON.stringify({
      input: {
        title: "시험",
        description: "응시",
        startTime: "2026-09-19T09:00:00+09:00",
      },
    }),
  });
  assert.equal(aiAnalysis.response.status, 200);
  assert.equal(aiAnalysis.body.type, "exam");
  assert.equal(aiAnalysis.body.policyDomains.includes("exam"), true);
  assert.equal(aiAnalysis.body.intentTags.includes("자격시험 응시"), true);
  const correctedSportsAnalysis = await primary("/api/ai/analyze", { method: "POST", body: JSON.stringify({ input: { title: "수영 수업", description: "운동 강습", startTime: "2026-09-20" } }) });
  assert.equal(correctedSportsAnalysis.response.status, 200);
  assert.equal(correctedSportsAnalysis.body.type, "general");
  assert.equal(correctedSportsAnalysis.body.policyDomains.includes("sports"), true);
  assert.equal(correctedSportsAnalysis.body.corrected, true);

  const logout = await primary("/api/auth/logout", { method: "POST" });
  assert.equal(logout.response.status, 200);
  assert.equal(logout.body.ok, true);
  assert.match(logout.response.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal((await primary("/api/auth/session")).response.status, 401);

  const invalidCredentials = await primary("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "server-test@example.com", password: "wrong-pass" }),
  });
  assert.equal(invalidCredentials.response.status, 401);

  const login = await primary("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "server-test@example.com", password: "correct horse battery" }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.profile.status, "학생");
  assert.equal((await primary("/api/events")).body.events.length, 1);
  assert.equal((await primary("/api/events")).body.events[0].title, "서버 저장 면접");
  assert.equal((await secondary("/api/events")).body.events.length, 0);
  assert.equal((await primary("/api/calendar/google/status")).body.state, "synced");

  const bruteForceClient = createClient();
  let throttled;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    throttled = await bruteForceClient("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "brute-force@example.com", password: "incorrect password" }),
    });
  }
  assert.equal(throttled.response.status, 429);

  const wrongDelete = await primary("/api/auth/account", { method: "DELETE", body: JSON.stringify({ password: "incorrect password" }) });
  assert.equal(wrongDelete.response.status, 403);
  const accountDelete = await primary("/api/auth/account", { method: "DELETE", body: JSON.stringify({ password: "correct horse battery" }) });
  assert.equal(accountDelete.response.status, 200);
  assert.match(accountDelete.response.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal((await primary("/api/auth/session")).response.status, 401);
  assert.equal((await primary("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "server-test@example.com", password: "correct horse battery" }) })).response.status, 401);
  assert.equal((await readFile(dataFile, "utf8")).includes("server-test@example.com"), false);

  console.log("server integration tests: 95 passed");
} finally {
  child.kill("SIGTERM");
  await rm(testDirectory, { recursive: true, force: true });
}

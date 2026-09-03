import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptanceThresholds,
  aiFallbackCases,
  eventCases,
  negativeControlCases,
  profileCases,
} from "./policy-eval-matrix.cases.mjs";

const port = 19000 + Math.floor(Math.random() * 1000);
const testDirectory = await mkdtemp(join(tmpdir(), "calenfit-policy-matrix-"));
const dataFile = join(testDirectory, "calenfit.json");
const child = spawn(
  process.execPath,
  ["--import", new URL("./support/mock-adversarial-ai.mjs", import.meta.url).pathname, "server.mjs"],
  {
    env: {
      ...process.env,
      PORT: String(port),
      CALENFIT_SESSION_SECRET: "matrix-test-secret",
      CALENFIT_DATA_FILE: dataFile,
      MOCK_ADVERSARIAL_AI: "1",
      GROQ_API_KEY: "matrix-groq-key",
      YOUTH_POLICY_API_KEY: "",
      WORK24_API_KEY: "",
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
    return { response, body: text ? JSON.parse(text) : null };
  };
};

async function createSignedInClient(email, profile) {
  const client = createClient();
  const signup = await client("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: "correct horse battery",
      profile,
    }),
  });
  assert.equal(signup.response.status, 200, `signup failed for ${email}`);
  const profileSave = await client("/api/profile", {
    method: "POST",
    body: JSON.stringify(profile),
  });
  assert.equal(profileSave.response.status, 200, `profile save failed for ${email}`);
  return client;
}

function ratio(passed, total) {
  return total === 0 ? 1 : passed / total;
}

const officialDiscoveryHosts = new Set(["www.youthcenter.go.kr", "plus.gov.kr", "www.work24.go.kr", "www.bokjiro.go.kr", "youth.gg.go.kr", "youth.seoul.go.kr", "young.busan.go.kr", "youth.gwangju.go.kr"]);

const score = {
  profiles: { passed: 0, total: profileCases.length },
  eventDomains: { passed: 0, total: eventCases.length + negativeControlCases.length },
  eventPolicies: { passed: 0, total: eventCases.length + negativeControlCases.length },
  negativeControls: { passed: 0, total: negativeControlCases.length },
  aiFallback: { passed: 0, total: aiFallbackCases.length },
};

try {
  for (let index = 0; index < profileCases.length; index += 1) {
    const testCase = profileCases[index];
    const client = await createSignedInClient(`profile-matrix-${index}@example.com`, testCase.profile);
    const policies = await client("/api/policies");
    assert.equal(policies.response.status, 200, `${testCase.name}: policies request failed`);
    const actualProfilePolicyIds = policies.body.profileBased.map(policy => policy.id);
    for (const expectedPolicy of testCase.expectedProfilePolicies) assert.equal(actualProfilePolicyIds.includes(expectedPolicy), true, `${testCase.name}: missing profile policy ${expectedPolicy}`);
    if (testCase.exactProfilePolicies) assert.deepEqual([...actualProfilePolicyIds].sort(), [...testCase.expectedProfilePolicies].sort(), `${testCase.name}: unexpected profile policy set`);
    assert.equal(new Set(actualProfilePolicyIds).size, actualProfilePolicyIds.length, `${testCase.name}: duplicate profile policy`);
    const residence = testCase.profile.residence;
    if (!/하남/.test(residence)) assert.equal(actualProfilePolicyIds.some(id => id.startsWith("hanam-")), false, `${testCase.name}: leaked Hanam policy`);
    if (!/서울/.test(residence)) assert.equal(actualProfilePolicyIds.some(id => id.startsWith("seoul-")), false, `${testCase.name}: leaked Seoul policy`);
    if (!/부산/.test(residence)) assert.equal(actualProfilePolicyIds.some(id => id.startsWith("busan-")), false, `${testCase.name}: leaked Busan policy`);
    if (!/광주/.test(residence)) assert.equal(actualProfilePolicyIds.some(id => id.startsWith("gwangju-")), false, `${testCase.name}: leaked Gwangju policy`);
    assert.equal(policies.body.profileBased.every(policy => policy.sourcePortal && policy.sourceHost && policy.sourceUrl && policy.retrievedAt && policy.uncertainty && policy.verificationMethod === "official-page-review"), true, `${testCase.name}: missing policy provenance`);
    const discoveryIds = new Set(policies.body.discoveryLinks.map(link => link.id));
    for (const requiredId of ["discover-youth-center", "discover-government-benefits", "discover-work24", "discover-bokjiro"]) assert.equal(discoveryIds.has(requiredId), true, `${testCase.name}: missing ${requiredId}`);
    for (const link of policies.body.discoveryLinks.filter(link => link.destinationKind === "official")) assert.equal(officialDiscoveryHosts.has(new URL(link.url).hostname), true, `${testCase.name}: non-official destination marked official`);
    assert.deepEqual(policies.body.connectors, { youthCenter: "approval-required", work24: "approval-required", snapshots: "active" }, `${testCase.name}: unavailable API connector overstated`);
    if (testCase.profile.school) {
      const schoolLink = policies.body.discoveryLinks.find(link => link.id === "discover-school-notices");
      assert.equal(schoolLink?.destinationKind, "locator", `${testCase.name}: school link must be a locator`);
      assert.equal(new URL(schoolLink.url).hostname, "www.google.com", `${testCase.name}: unexpected school locator host`);
    }
    score.profiles.passed += 1;
  }

  for (let index = 0; index < eventCases.length; index += 1) {
    const testCase = eventCases[index];
    const client = await createSignedInClient(`event-matrix-${index}@example.com`, testCase.profile);
    const eventCreation = await client("/api/events", {
      method: "POST",
      body: JSON.stringify(testCase.event),
    });
    assert.equal(eventCreation.response.status, 201, `${testCase.name}: event creation failed`);
    for (const expectedDomain of testCase.expectedDomains) {
      assert.equal(eventCreation.body.event.policyDomains.includes(expectedDomain), true, `${testCase.name}: missing expected domain ${expectedDomain}`);
    }
    score.eventDomains.passed += 1;

    const policies = await client("/api/policies");
    assert.equal(policies.response.status, 200, `${testCase.name}: policies request failed`);
    const allPolicies = [...policies.body.profileBased, ...policies.body.eventBased];
    assert.equal(allPolicies.every(policy => policy.sourcePortal && policy.sourceHost && policy.sourceUrl && policy.retrievedAt && policy.uncertainty && policy.verificationMethod === "official-page-review"), true, `${testCase.name}: missing event policy provenance`);
    const linkedPolicies = allPolicies.filter(policy => (policy.eventIds || []).includes(eventCreation.body.event.id));
    const eventPolicyIds = linkedPolicies.map(policy => policy.id).sort();
    assert.deepEqual(eventPolicyIds, [...testCase.expectedPolicies].sort(), `${testCase.name}: unexpected linked policy set`);
    for (const forbiddenPolicy of testCase.forbiddenPolicies || []) {
      assert.equal(eventPolicyIds.includes(forbiddenPolicy), false, `${testCase.name}: leaked regional policy ${forbiddenPolicy}`);
    }
    if (testCase.expectedDiscovery) assert.ok(policies.body.discoveryLinks.length >= 3, `${testCase.name}: missing official discovery fallback`);
    if (testCase.expectedReasonIncludes) {
      const target = allPolicies.find(policy => policy.id === testCase.expectedPolicies[0]);
      assert.equal(Boolean(target), true, `${testCase.name}: target policy not found for reason check`);
      assert.equal(target.reason.includes(testCase.expectedReasonIncludes), true, `${testCase.name}: missing AI intent phrasing`);
    }
    score.eventPolicies.passed += 1;
  }

  for (let index = 0; index < negativeControlCases.length; index += 1) {
    const testCase = negativeControlCases[index];
    const client = await createSignedInClient(`negative-matrix-${index}@example.com`, testCase.profile);
    const eventCreation = await client("/api/events", {
      method: "POST",
      body: JSON.stringify(testCase.event),
    });
    assert.equal(eventCreation.response.status, 201, `${testCase.name}: event creation failed`);
    for (const expectedDomain of testCase.expectedDomains) {
      assert.equal(eventCreation.body.event.policyDomains.includes(expectedDomain), true, `${testCase.name}: missing expected domain ${expectedDomain}`);
    }
    score.eventDomains.passed += 1;

    const policies = await client("/api/policies");
    assert.equal(policies.response.status, 200, `${testCase.name}: policies request failed`);
    const linkedPolicies = [...policies.body.profileBased, ...policies.body.eventBased].filter(policy => (policy.eventIds || []).includes(eventCreation.body.event.id));
    const eventPolicyIds = linkedPolicies.map(policy => policy.id);
    assert.equal(linkedPolicies.length, testCase.expectedEventPolicyCount, `${testCase.name}: unexpected event policy count`);
    for (const forbiddenPolicy of testCase.forbiddenPolicies) {
      assert.equal(eventPolicyIds.includes(forbiddenPolicy), false, `${testCase.name}: leaked forbidden policy ${forbiddenPolicy}`);
    }
    score.eventPolicies.passed += 1;
    score.negativeControls.passed += 1;
  }

  const aiClient = await createSignedInClient("ai-matrix@example.com", {
    birthYear: 2001,
    residence: "경기도 하남시",
    status: "학생",
    education: "대학교 4학년",
    major: "정보보안학",
    goal: "평가",
  });
  for (const testCase of aiFallbackCases) {
    const analysis = await aiClient("/api/ai/analyze", {
      method: "POST",
      body: JSON.stringify({ input: testCase.input }),
    });
    assert.equal(analysis.response.status, 200, `${testCase.name}: AI analysis failed`);
    assert.equal(analysis.body.type, testCase.expectedType, `${testCase.name}: unexpected analysis type`);
    assert.equal(analysis.body.corrected, testCase.expectedCorrected, `${testCase.name}: unexpected corrected flag`);
    for (const expectedDomain of testCase.expectedDomains) {
      assert.equal(analysis.body.policyDomains.includes(expectedDomain), true, `${testCase.name}: missing expected AI domain ${expectedDomain}`);
    }
    if (testCase.expectedIntentTags) {
      for (const tag of testCase.expectedIntentTags) {
        assert.equal(analysis.body.intentTags.includes(tag), true, `${testCase.name}: missing expected intent tag ${tag}`);
      }
    }
    score.aiFallback.passed += 1;
  }

  assert.ok(ratio(score.profiles.passed, score.profiles.total) >= acceptanceThresholds.profileExactPassRate, "profile policy threshold failed");
  assert.ok(ratio(score.eventDomains.passed, score.eventDomains.total) >= acceptanceThresholds.eventDomainPassRate, "event domain threshold failed");
  assert.ok(ratio(score.eventPolicies.passed, score.eventPolicies.total) >= acceptanceThresholds.eventPolicyPassRate, "event policy threshold failed");
  assert.ok(ratio(score.negativeControls.passed, score.negativeControls.total) >= acceptanceThresholds.negativeControlPassRate, "negative control threshold failed");
  assert.ok(ratio(score.aiFallback.passed, score.aiFallback.total) >= acceptanceThresholds.aiFallbackPassRate, "AI fallback threshold failed");

  const total = profileCases.length + eventCases.length + negativeControlCases.length + aiFallbackCases.length;
  console.log(`policy evaluation matrix tests: ${total} passed`);
} finally {
  child.kill("SIGTERM");
  await rm(testDirectory, { recursive: true, force: true });
}

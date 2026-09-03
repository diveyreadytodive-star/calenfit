import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveIntentCases } from "../tests/live-ai-intent.cases.mjs";

const remoteBase = String(process.env.CALENFIT_BASE_URL || "").replace(/\/$/, "");
if (!remoteBase && !process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is required; pass it as a server environment variable.");
  process.exit(2);
}

const port = 20000 + Math.floor(Math.random() * 1000);
const directory = remoteBase ? null : await mkdtemp(join(tmpdir(), "calenfit-live-ai-"));
const child = remoteBase ? null : spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port), DATABASE_URL: "", CALENFIT_DATA_FILE: join(directory, "data.json"), CALENFIT_SESSION_SECRET: "live-eval-ephemeral-session-secret" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
if (child) {
  child.stderr.on("data", chunk => { stderr += String(chunk).slice(0, 2000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout: ${stderr}`)), 8000);
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", reject);
  });
}

const base = remoteBase || `http://127.0.0.1:${port}`;
let cookie = "";
const password = "temporary evaluation password";
const email = `live-eval-${Date.now()}@example.com`;
async function request(path, options = {}, attempt = 0) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const body = await response.json();
  if (response.status === 429 && path === "/api/ai/analyze" && attempt < 3) {
    const retrySeconds = Math.max(1, Math.min(10, Number(body.retryAfter) || 2));
    await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000 + 250));
    return request(path, options, attempt + 1);
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${body.code || body.error}${body.upstreamStatus ? ` upstream=${body.upstreamStatus}` : ""}${body.retryAfter ? ` retry-after=${body.retryAfter}` : ""}`);
  return body;
}

try {
  await request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
  const results = [];
  for (const testCase of liveIntentCases) {
    const output = await request("/api/ai/analyze", { method: "POST", body: JSON.stringify({ title: testCase.title, description: testCase.description, startTime: "2026-09-15T09:00:00+09:00" }) });
    const domains = new Set(output.policyDomains || []);
    const hit = testCase.expectedAny.some(domain => domains.has(domain));
    const forbiddenHit = (testCase.forbidden || []).some(domain => domains.has(domain));
    const safeShape = !["policy", "policyId", "eligibility", "amount", "budget", "credit"].some(key => Object.hasOwn(output, key));
    const allowedDomains = new Set([...testCase.expectedAny, ...(testCase.allowedExtra || [])]);
    const unexpectedDomains = [...domains].filter(domain => !allowedDomains.has(domain));
    results.push({ name: testCase.name, input: { title: testCase.title, description: testCase.description }, expectedAny: testCase.expectedAny, allowedExtra: testCase.allowedExtra || [], hit, forbiddenHit, safeShape, unexpectedDomains, domains: [...domains], output });
  }
  const passed = results.filter(result => result.hit && !result.forbiddenHit && result.safeShape && result.unexpectedDomains.length === 0).length;
  const rate = passed / results.length;
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/live-ai-intent-evaluation.json", `${JSON.stringify({ checkedAt: new Date().toISOString(), target: remoteBase ? "production-proxy" : "local-proxy", passed, total: results.length, rate, results }, null, 2)}\n`);
  for (const result of results.filter(item => !item.hit || item.forbiddenHit || !item.safeShape || item.unexpectedDomains.length)) console.error(`${result.name}: domains=${result.domains.join(",")} unexpected=${result.unexpectedDomains.join(",")} hit=${result.hit} forbidden=${result.forbiddenHit} shape=${result.safeShape}`);
  console.log(`live Groq intent evaluation: ${passed}/${results.length} (${(rate * 100).toFixed(1)}%)`);
  assert.ok(rate >= 0.9, `live intent accuracy below 90% (${(rate * 100).toFixed(1)}%)`);
} finally {
  if (cookie) {
    await request("/api/auth/account", { method: "DELETE", body: JSON.stringify({ password }) });
    cookie = "";
    const deletedLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(deletedLogin.status, 401, "temporary evaluation account was not deleted");
    console.log("temporary evaluation account cleanup: verified");
  }
  if (child) child.kill("SIGTERM");
  if (directory) await rm(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 18000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: String(port), CALENFIT_SESSION_SECRET: "test-secret-not-production" }, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("server start timeout")), 5000); child.stdout.on("data", chunk => { if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); } }); child.once("error", reject); });
const base = `http://127.0.0.1:${port}`;
let cookie = "";
const request = async (path, options = {}) => { const response = await fetch(`${base}${path}`, { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(options.headers || {}) } }); const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0]; return { response, body: await response.json() }; };
try {
  const signup = await request("/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "server-test@example.com", password: "correct horse battery", profile: { birthYear: 2001, residence: "경기도 하남시", status: "미취업", education: "대학교 4학년", goal: "취업 준비" } }) });
  assert.equal(signup.response.status, 200);
  const session = await request("/api/auth/session");
  assert.equal(session.body.user.mode, "account");
  assert.equal(session.body.user.profile.education, "대학교 4학년");
  const profile = await request("/api/profile", { method: "POST", body: JSON.stringify({ birthYear: 2001, residence: "경기도 하남시", status: "학생", education: "대학교 4학년", goal: "데이터 직무" }) });
  assert.equal(profile.body.profile.goal, "데이터 직무");
  assert.equal((await request("/api/auth/session")).body.user.profile.status, "학생");
  assert.equal((await request("/api/calendar/google/connect")).response.status, 503);
  assert.equal((await request("/api/ai/analyze", { method: "POST", body: JSON.stringify({ input: { title: "시험", description: "응시", startTime: "2026-09-19T09:00:00+09:00" } }) })).response.status, 503);
  assert.equal((await request("/api/auth/logout", { method: "POST" })).body.ok, true);
  assert.equal((await request("/api/auth/session")).response.status, 401);
  console.log("server integration tests: 8 passed");
} finally { child.kill("SIGTERM"); }

#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCREENSHOT_ROOT = join(APP_ROOT, "artifacts", "screenshots");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const json = value => JSON.stringify(value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const assertEqual = (actual, expected, message) => { if (actual !== expected) throw new Error(`${message} (expected ${json(expected)}, got ${json(actual)})`); };

async function waitFor(check, { timeout = 7000, interval = 50, message = "condition" } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function findChrome() {
  const binary = CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  if (!binary) throw new Error("Google Chrome/Chromium was not found");
  return binary;
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result || {});
        return;
      }
      for (const callback of this.handlers.get(message.method) || []) callback(message);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }
  on(method, callback) {
    const callbacks = this.handlers.get(method) || [];
    callbacks.push(callback);
    this.handlers.set(method, callbacks);
  }
  once(method, predicate = () => true, timeout = 10_000) {
    return new Promise((resolvePromise, reject) => {
      const callbacks = this.handlers.get(method) || [];
      const callback = message => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.handlers.set(method, (this.handlers.get(method) || []).filter(item => item !== callback));
        resolvePromise(message);
      };
      callbacks.push(callback);
      this.handlers.set(method, callbacks);
      const timer = setTimeout(() => {
        this.handlers.set(method, (this.handlers.get(method) || []).filter(item => item !== callback));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
    });
  }
}

async function startAppServer(testRoot) {
  const port = 19_000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["--import", join(APP_ROOT, "tests/support/mock-google-oauth.mjs"), "server.mjs"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CALENFIT_SESSION_SECRET: "e2e-secret-not-production",
      CALENFIT_DATA_FILE: join(testRoot, "calenfit.json"),
      MOCK_GOOGLE_OAUTH: "1",
      GOOGLE_CLIENT_ID: "e2e-google-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
      GOOGLE_REDIRECT_URI: `http://127.0.0.1:${port}/api/calendar/google/callback`,
      GOOGLE_AUTH_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/google/callback`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout ${stderr}`)), 5000);
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("listening")) { clearTimeout(timer); resolvePromise(); }
    });
    child.once("error", reject);
  });
  return { child, origin: `http://127.0.0.1:${port}` };
}

async function connectChrome(origin) {
  const profileRoot = await mkdtemp(join(tmpdir(), "calenfit-e2e-profile-"));
  const chrome = spawn(findChrome(), ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${profileRoot}`], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeStderr = "";
  chrome.stderr.on("data", chunk => { chromeStderr += String(chunk); });
  let version;
  await waitFor(async () => {
    const match = chromeStderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (!match) return null;
    const response = await fetch(`http://${new URL(match[1]).host}/json/version`);
    if (response.ok) version = await response.json();
    return version;
  }, { timeout: 15_000, interval: 100, message: "Chrome DevTools endpoint" });
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await waitFor(() => socket.readyState === WebSocket.OPEN, { message: "CDP WebSocket" });
  const cdp = new CdpConnection(socket);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  return { chrome, cdp, sessionId, pageSend: (method, params = {}) => cdp.send(method, params, sessionId), origin, profileRoot };
}

async function run() {
  const testRoot = await mkdtemp(join(tmpdir(), "calenfit-e2e-"));
  const app = await startAppServer(testRoot);
  let browser;
  const passed = [];
  const record = label => { passed.push(label); console.log(`  ✓ ${label}`); };
  const errors = { console: [], exceptions: [] };
  try {
    browser = await connectChrome(app.origin);
    const { cdp, sessionId, pageSend } = browser;
    cdp.on("Runtime.consoleAPICalled", message => {
      if (message.sessionId === sessionId && message.params.type === "error") errors.console.push(message.params.args?.map(argument => argument.value ?? argument.description).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", message => {
      if (message.sessionId === sessionId) errors.exceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
    });
    await Promise.all([pageSend("Page.enable"), pageSend("Runtime.enable"), pageSend("Network.enable")]);
    const evaluate = async expression => {
      const result = await pageSend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const click = selector => evaluate(`(() => { const element=document.querySelector(${json(selector)}); if(!element)return false;element.click();return true; })()`).then(value => assert(value, `missing ${selector}`));
    const fill = (selector, value) => evaluate(`(() => { const element=document.querySelector(${json(selector)});if(!element)return false;element.value=${json(String(value))};element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return true; })()`).then(result => assert(result, `missing ${selector}`));
    const text = selector => evaluate(`document.querySelector(${json(selector)})?.textContent?.trim()||""`);
    const visible = selector => evaluate(`(() => { const element=document.querySelector(${json(selector)});if(!element)return false;const style=getComputedStyle(element);return !element.hidden&&style.display!=="none"&&style.visibility!=="hidden";})()`);
    const navigate = async url => {
      const loaded = cdp.once("Page.loadEventFired", message => message.sessionId === sessionId);
      await pageSend("Page.navigate", { url });
      await loaded;
      await sleep(150);
    };
    const reload = async () => {
      const loaded = cdp.once("Page.loadEventFired", message => message.sessionId === sessionId);
      await pageSend("Page.reload", { ignoreCache: true });
      await loaded;
      await sleep(150);
    };
    const setDevice = async (width, height, mobile) => {
      await pageSend("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
      await sleep(100);
      const dimensions = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`);
      assert(dimensions.scrollWidth <= dimensions.width, `horizontal overflow ${dimensions.scrollWidth} > ${dimensions.width}`);
    };
    const capture = async (name, width, height, mobile) => {
      await setDevice(width, height, mobile);
      await evaluate("scrollTo(0,0)");
      const screenshot = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await mkdir(SCREENSHOT_ROOT, { recursive: true });
      await writeFile(join(SCREENSHOT_ROOT, name), Buffer.from(screenshot.data, "base64"));
    };

    await navigate(`${app.origin}/`);
    assert(await visible("#landing-screen"), "landing page is not visible");
    assertEqual(await visible("#auth-screen"), false, "auth opens before user action");
    assertEqual(await evaluate(`Promise.all([fetch("/privacy.html"),fetch("/terms.html")]).then(items=>items.every(response=>response.ok))`), true, "public legal pages are unavailable");
    assertEqual(await evaluate(`document.querySelectorAll(".month-event").length`), 0, "anonymous user sees events");
    assert(!(await text("#profile-summary")).includes("하남"), "anonymous user sees seeded profile");
    await capture("hero-mobile-390x844.png", 390, 844, true);
    await capture("hero-desktop-1440x900.png", 1440, 900, false);
    record("anonymous landing contains no profile, events, or recommendations");

    await click("#landing-start-button");
    assertEqual(await visible("#auth-screen"), false, "guest workspace should not force auth");
    assert(await visible("#calendar-panel"), "guest workspace calendar is not visible");
    assertEqual(await evaluate(`document.querySelectorAll(".month-event").length`), 0, "guest workspace sees private events");
    assert((await text("#profile-summary")).includes("로그인 후"), "guest profile guidance is missing");
    assert((await text("[data-google-connect]")).includes("Google Calendar 연결"), "guest Google action is stuck loading");
    await click("[data-google-connect]");
    assert(await visible("#auth-screen"), "guest Google action did not request login");
    await click("#auth-screen");
    await capture("guest-workspace-mobile-390x844.png", 390, 844, true);
    await capture("guest-workspace-desktop-1440x900.png", 1440, 900, false);
    await click("#profile-login-trigger");
    assert(await visible("#auth-screen"), "profile login trigger did not open auth");
    await fill('#account-auth-form input[name="email"]', "browser-user@example.com");
    await fill('#account-auth-form input[name="password"]', "correct horse battery");
    await click('#account-auth-form button[value="signup"]');
    await waitFor(() => visible("#profile-form"), { message: "onboarding profile" });
    assertEqual(await evaluate(`document.querySelectorAll(".month-event").length`), 0, "new account has seeded events");
    record("real signup enters empty account onboarding");

    await fill('#profile-form input[name="birthYear"]', "2001");
    await fill('#profile-form input[name="residence"]', "경기도 하남시");
    await fill('#profile-form select[name="status"]', "미취업");
    await fill('#profile-form input[name="education"]', "대학교 4학년");
    await fill('#profile-form input[name="school"]', "한국대학교");
    await fill('#profile-form input[name="major"]', "정보보안학");
    await fill('#profile-form input[name="goal"]', "데이터 직무");
    await click('#profile-form button[type="submit"]');
    await waitFor(() => text("#profile-summary").then(value => value.includes("경기도 하남시")), { message: "saved profile" });
    assert((await text("#profile-summary")).includes("정보보안학"), "major is missing from profile summary");
    assert((await text("#profile-summary")).includes("한국대학교"), "school is missing from profile summary");
    assertEqual(await visible("#profile-form"), false, "saved profile form should collapse");
    assertEqual(await visible("#profile-edit-button"), true, "profile edit button is missing");
    assert((await text("#policy-source-links")).includes("한국대학교 공지"), "school notice discovery link is missing");
    assert((await text("#profile-policy-cards")).includes("하남시 청년기본소득"), "profile policy is missing without an event");
    assert((await text("#profile-policy-cards")).includes("취업교육 청년지원사업"), "profile-based job training policy is missing");
    assertEqual(await visible("#task-panel"), false, "right rail to-do panel should be removed");
    assertEqual(await evaluate(`document.querySelector("#profile-policy-cards details")?.open`), false, "policy card should start collapsed");
    await click("#profile-policy-cards details > summary");
    assertEqual(await evaluate(`document.querySelector("#profile-policy-cards details")?.open`), true, "policy card did not expand");
    await click("#profile-policy-cards details > summary");
    record("profile saves to the signed-in account");

    await click("#calendar-next-month");
    assertEqual(await text("#calendar-heading"), "2026년 10월 월간 달력", "next month navigation");
    await click("#calendar-prev-month");
    assertEqual(await text("#calendar-heading"), "2026년 9월 월간 달력", "previous month navigation");
    record("calendar arrows navigate between real month grids");

    await click('[data-month-date="2026-09-12"]');
    assert(await visible("#event-modal"), "date click did not open event modal");
    assertEqual(await evaluate(`document.querySelector("#event-date").value`), "2026-09-12", "clicked date not prefilled");
    await fill("#event-title", "정보보안기사 필기 시험");
    await fill("#event-description", "응시료 영수증 보관");
    await click('#event-form button[type="submit"]');
    await waitFor(() => text("#month-calendar").then(value => value.includes("정보보안기사")), { message: "calendar event" });
    assert((await text("#event-policy-cards")).includes("역량강화"), "event did not produce policy candidate");
    assert((await text("#event-list")).includes("증빙 행동 보기"), "event evidence actions should remain accessible");
    record("modal event creation renders on the selected calendar date");

    await click('[data-month-date="2026-09-13"]');
    await fill("#event-title", "삭제할 정보보안 시험");
    await fill("#event-description", "잘못 추가한 일정");
    await click('#event-form button[type="submit"]');
    await waitFor(() => text("#month-calendar").then(value => value.includes("삭제할 정보보안 시험")), { message: "temporary event" });
    assertEqual(await evaluate(`document.querySelectorAll("#event-policy-cards details").length`), 1, "duplicate event policy was rendered");
    assert(await evaluate(`(() => { const button=Array.from(document.querySelectorAll("[data-delete-event]")).find(item=>item.closest(".event-card")?.textContent.includes("삭제할 정보보안 시험"));if(!button)return false;button.click();return true;})()`), "event delete action is missing");
    assert(await visible("#delete-event-modal"), "delete confirmation modal did not open");
    await click("[data-confirm-delete-event]");
    await waitFor(() => text("#month-calendar").then(value => !value.includes("삭제할 정보보안 시험")), { message: "event deletion" });
    assertEqual(await evaluate(`document.querySelectorAll("#event-policy-cards details").length`), 1, "policy count changed after duplicate event deletion");
    record("event deletion and policy deduplication");

    await reload();
    await waitFor(() => text("#month-calendar").then(value => value.includes("정보보안기사")), { message: "event after reload" });
    assert((await text("#profile-summary")).includes("경기도 하남시"), "profile did not survive reload");
    record("server session restores account profile and events after reload");

    const oauth = await evaluate(`fetch("/api/calendar/google/connect").then(response=>response.json())`);
    const authorizationUrl = new URL(oauth.authorizationUrl);
    assertEqual(authorizationUrl.searchParams.get("code_challenge_method"), "S256", "Google PKCE method");
    assertEqual(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events.readonly", "Google minimum scope");
    await navigate(`${app.origin}/api/calendar/google/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get("state"))}&code=e2e-code`);
    await waitFor(() => text("#month-calendar").then(value => value.includes("Google 연결 면접")), { message: "Google event after OAuth callback" });
    assert((await text("[data-google-connect]")).includes("동기화"), "Google connected state not rendered");
    assert((await text("#google-calendar-status")).includes("연결됨"), "top Google connection status is missing");
    record("Google OAuth callback and calendar sync populate the account calendar");
    assertEqual(await evaluate(`Array.from(document.querySelectorAll(".event-card")).find(item=>item.textContent.includes("Google 연결 면접"))?.querySelector("[data-delete-event]")===null`), true, "Google source event exposes a misleading delete action");
    assert((await text("#event-list")).includes("Google Calendar"), "Google source badge is missing");
    await evaluate(`document.querySelector(".profile-panel").open=true`);
    assertEqual(await evaluate(`document.querySelector("#google-disconnect-button").hidden`), false, "Google disconnect action is hidden while connected");
    await click("#google-disconnect-button");
    await waitFor(() => text("#google-calendar-status").then(value => value.includes("미연결")), { message: "Google disconnect status" });
    assert(!(await text("#month-calendar")).includes("Google 연결 면접"), "Google disconnect left synchronized events");
    record("Google disconnect removes its token and synchronized event projection");

    await click("#profile-login-button");
    await waitFor(() => evaluate(`document.querySelectorAll(".month-event").length === 0`), { message: "private events cleared after logout" });
    assert(await visible("#calendar-panel"), "guest calendar is hidden after logout");
    assertEqual(await visible("#landing-screen"), false, "logout should keep the guest workspace open");
    assertEqual(await evaluate(`document.querySelectorAll(".month-event").length`), 0, "logout leaves private events visible");
    await click("#profile-login-trigger");
    await fill('#account-auth-form input[name="email"]', "browser-user@example.com");
    await fill('#account-auth-form input[name="password"]', "correct horse battery");
    await click('#account-auth-form button[value="login"]');
    await waitFor(() => text("#month-calendar").then(value => value.includes("정보보안기사")), { message: "event after relogin" });
    assert((await text("#profile-summary")).includes("경기도 하남시"), "wrong profile after relogin");
    record("logout clears the page and relogin restores only that account");

    await capture("final-desktop-1440x900.png", 1440, 900, false);
    await capture("final-mobile-390x844.png", 390, 844, true);
    record("desktop and mobile have no horizontal overflow");
    assert(!errors.console.length, `console errors: ${errors.console.join(" | ")}`);
    assert(!errors.exceptions.length, `page exceptions: ${errors.exceptions.join(" | ")}`);
    console.log(`E2E passed: ${passed.length} checks`);
  } finally {
    if (browser) {
      try { await browser.pageSend("Browser.close"); } catch {}
      try { browser.chrome.kill("SIGTERM"); } catch {}
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { await rm(browser.profileRoot, { recursive: true, force: true }); break; }
        catch (error) { if (error.code !== "ENOTEMPTY") throw error; await sleep(100); }
      }
    }
    app.child.kill("SIGTERM");
    await rm(testRoot, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(`E2E failed: ${error.message}`);
  process.exitCode = 1;
});

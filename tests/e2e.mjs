#!/usr/bin/env node

/*
 * Dependency-free browser E2E checks for the demo.  The harness intentionally
 * talks to Chrome over CDP instead of using a test framework so it can run in
 * the challenge repository with only Node and an installed Chrome binary.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCREENSHOT_ROOT = join(APP_ROOT, "artifacts", "screenshots");
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const json = value => JSON.stringify(value);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${json(expected)}, got ${json(actual)})`);
}

async function waitFor(check, { timeout = 5000, interval = 50, message = "condition" } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function findChrome() {
  const binary = CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  if (!binary) throw new Error("Google Chrome/Chromium was not found");
  return binary;
}

function contentType(file) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  }[extname(file).toLowerCase()] || "application/octet-stream";
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      if (requestPath === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
      const file = resolve(APP_ROOT, relative);
      if (file !== APP_ROOT && !file.startsWith(`${APP_ROOT}${sep}`)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500);
      response.end(error?.code === "ENOENT" ? "not found" : "server error");
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function httpGet(url) {
  return new Promise((resolvePromise, reject) => {
    const request = fetch(url).then(async response => {
      resolvePromise({ status: response.status, body: await response.text() });
    }).catch(reject);
    void request;
  });
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
      const callbacks = this.handlers.get(message.method) || [];
      for (const callback of callbacks) callback(message);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP WebSocket closed"));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(method, callback) {
    const callbacks = this.handlers.get(method) || [];
    callbacks.push(callback);
    this.handlers.set(method, callbacks);
    return () => this.handlers.set(method, callbacks.filter(item => item !== callback));
  }

  once(method, predicate = () => true, timeout = 10000) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeout);
      const callback = message => {
        try {
          if (!predicate(message)) return;
          clearTimeout(timer);
          off();
          resolvePromise(message);
        } catch (error) {
          clearTimeout(timer);
          off();
          reject(error);
        }
      };
      const off = this.on(method, callback);
    });
  }
}

async function connectChrome(origin) {
  const profileRoot = await mkdtemp(join(tmpdir(), "calenfit-e2e-profile-"));
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileRoot}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let chromeStderr = "";
  chrome.stderr.on("data", chunk => { chromeStderr += String(chunk); });
  let version;
  await waitFor(async () => {
    const match = chromeStderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      const wsUrl = match[1];
      const response = await httpGet(`http://${new URL(wsUrl).host}/json/version`);
      if (response.status === 200) version = JSON.parse(response.body);
    }
    return version;
  }, { timeout: 15000, interval: 100, message: "Chrome DevTools endpoint" }).catch(error => {
    try { chrome.kill("SIGTERM"); } catch {}
    void rm(profileRoot, { recursive: true, force: true });
    throw new Error(`${error.message}${chromeStderr ? `; ${chromeStderr.trim()}` : ""}`);
  });

  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await waitFor(() => socket.readyState === WebSocket.OPEN, { timeout: 10000, interval: 20, message: "CDP WebSocket" });
  const cdp = new CdpConnection(socket);
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  const pageSend = (method, params = {}) => cdp.send(method, params, sessionId);
  return { chrome, cdp, sessionId, pageSend, origin, profileRoot };
}

async function run() {
  const { server, origin } = await startStaticServer();
  const tempRoot = await mkdtemp(join(tmpdir(), "calenfit-e2e-fixtures-"));
  let browser;
  const passed = [];
  const record = label => { passed.push(label); console.log(`  ✓ ${label}`); };
  const network = { requests: [], responses: [], failures: [], consoleErrors: [], exceptions: [] };
  try {
    browser = await connectChrome(origin);
    const { cdp, sessionId, pageSend } = browser;
    const pageEvent = (method, callback) => cdp.on(method, message => {
      if (message.sessionId === sessionId) callback(message.params || message);
    });
    pageEvent("Network.requestWillBeSent", payload => network.requests.push(payload.request?.url));
    pageEvent("Network.responseReceived", payload => network.responses.push({ url: payload.response?.url, status: payload.response?.status }));
    pageEvent("Network.loadingFailed", payload => network.failures.push({ url: payload.requestId, error: payload.errorText }));
    pageEvent("Runtime.consoleAPICalled", payload => {
      if (payload.type === "error") network.consoleErrors.push(payload.args?.map(arg => arg.value ?? arg.description).join(" "));
    });
    pageEvent("Runtime.exceptionThrown", payload => network.exceptions.push(payload.exceptionDetails?.exception?.description || payload.exceptionDetails?.text || "page exception"));
    await pageSend("Page.enable");
    await pageSend("Runtime.enable");
    await pageSend("Network.enable");
    await pageSend("DOM.enable");

    const evaluate = async (expression) => {
      const result = await pageSend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(details.exception?.description || details.text || "Runtime.evaluate failed");
      }
      return result.result?.value;
    };
    const click = async selector => assert(await evaluate(`(() => { const element = document.querySelector(${json(selector)}); if (!element) return false; element.click(); return true; })()`), `missing clickable element ${selector}`);
    const focus = async selector => assert(await evaluate(`(() => { const element = document.querySelector(${json(selector)}); if (!element) return false; element.focus(); return document.activeElement === element; })()`), `missing focusable element ${selector}`);
    const key = async (keyValue, code = keyValue === " " ? "Space" : keyValue, keyCode) => {
      const value = { type: "keyDown", key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await pageSend("Input.dispatchKeyEvent", value);
      await pageSend("Input.dispatchKeyEvent", { ...value, type: "keyUp" });
    };
    const keyboardActivate = async (selector, keyValue = "Enter") => {
      await focus(selector);
      assert(await evaluate(`(() => { const element = document.querySelector(${json(selector)}); if (!element) return false; element.dispatchEvent(new KeyboardEvent("keydown", { key: ${json(keyValue)}, bubbles: true })); element.click(); element.dispatchEvent(new KeyboardEvent("keyup", { key: ${json(keyValue)}, bubbles: true })); return true; })()`), `missing keyboard target ${selector}`);
      await sleep(80);
    };
    const keyboardSelect = async (selector, optionIndex) => {
      await focus(selector);
      assert(await evaluate(`(() => { const element = document.querySelector(${json(selector)}); if (!element || !element.options[${optionIndex}]) return false; element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); element.selectedIndex = ${optionIndex}; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); element.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true })); return true; })()`), `missing keyboard select target ${selector}`);
      await sleep(100);
    };
    const fill = async (selector, value) => assert(await evaluate(`(() => { const element = document.querySelector(${json(selector)}); if (!element) return false; element.focus(); const proto = Object.getPrototypeOf(element); const descriptor = Object.getOwnPropertyDescriptor(proto, "value"); if (descriptor?.set) descriptor.set.call(element, ${json(String(value))}); else element.value = ${json(String(value))}; element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`), `missing form field ${selector}`);
    const select = async (selector, value) => { await fill(selector, value); await evaluate(`document.querySelector(${json(selector)})?.dispatchEvent(new Event("change", { bubbles: true }))`); };
    const text = selector => evaluate(`document.querySelector(${json(selector)})?.textContent?.trim() || ""`);
    const visible = selector => evaluate(`(() => { const element = document.querySelector(${json(selector)}); if (!element) return false; const style = getComputedStyle(element); return !element.hidden && style.display !== "none" && style.visibility !== "hidden"; })()`);
    const state = () => evaluate(`globalThis.calenfit ? JSON.parse(JSON.stringify(globalThis.calenfit.state)) : null`);
    const reload = async () => {
      const loaded = cdp.once("Page.loadEventFired", event => event.sessionId === sessionId);
      await pageSend("Page.reload", { ignoreCache: true });
      await loaded;
      await sleep(100);
    };
    const navigate = async () => {
      const loaded = cdp.once("Page.loadEventFired", event => event.sessionId === sessionId);
      await pageSend("Page.navigate", { url: `${origin}/` });
      await loaded;
      await sleep(150);
    };
    const waitState = predicate => waitFor(async () => predicate(await state()), { message: "application state" });
    const setFile = async (selector, file) => {
      const documentRoot = await pageSend("DOM.getDocument", { depth: -1 });
      const node = await pageSend("DOM.querySelector", { nodeId: documentRoot.root.nodeId, selector });
      assert(node.nodeId, `missing file input ${selector}`);
      await pageSend("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [file] });
    };
    const setDevice = async (width, height, mobile) => {
      await pageSend("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
      await sleep(100);
      const dimensions = await evaluate(`(() => { const viewport = window.innerWidth; const offenders = Array.from(document.querySelectorAll("body *")).map(element => { const rect = element.getBoundingClientRect(); return { tag: element.tagName.toLowerCase(), id: element.id, className: String(element.className || "").slice(0, 80), width: Math.round(rect.width), right: Math.round(rect.right) }; }).filter(item => item.right > viewport + 1).sort((a, b) => b.right - a.right).slice(0, 5); return { innerWidth: viewport, innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, offenders }; })()`);
      if (!mobile) assertEqual(dimensions.innerWidth, width, "desktop innerWidth");
      assert(dimensions.scrollWidth <= dimensions.innerWidth, `${mobile ? "mobile" : "desktop"} horizontal overflow: ${dimensions.scrollWidth}px > ${dimensions.innerWidth}px; offenders=${JSON.stringify(dimensions.offenders)}`);
      return dimensions;
    };
    const capture = async (name, target = null) => {
      await setDevice(1440, 900, false);
      await evaluate(target ? `document.querySelector(${json(target)})?.scrollIntoView({ block: "start" })` : "window.scrollTo(0, 0)");
      const desktop = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await mkdir(SCREENSHOT_ROOT, { recursive: true });
      await writeFile(join(SCREENSHOT_ROOT, `${name}-desktop-1440x900.png`), Buffer.from(desktop.data, "base64"));
      await setDevice(390, 844, true);
      await evaluate(target ? `document.querySelector(${json(target)})?.scrollIntoView({ block: "start" })` : "window.scrollTo(0, 0)");
      const mobile = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(join(SCREENSHOT_ROOT, `${name}-mobile-390x844.png`), Buffer.from(mobile.data, "base64"));
      await setDevice(1440, 900, false);
    };

    await navigate();
    await waitFor(() => evaluate(`Boolean(globalThis.calenfit && document.querySelector("#event-list"))`), { message: "initial app render" });
    const sameOrigin = new URL(origin).origin;
    const unexpected = network.requests.filter(url => /^https?:/i.test(url) && new URL(url).origin !== sameOrigin);
    const failedAssets = network.responses.filter(item => new URL(item.url).origin === sameOrigin && item.status >= 400);
    assert(!network.consoleErrors.length, `console errors on load: ${network.consoleErrors.join(" | ")}`);
    assert(!network.exceptions.length, `page exceptions on load: ${network.exceptions.join(" | ")}`);
    assert(!unexpected.length, `unexpected network requests: ${unexpected.join(", ")}`);
    assert(!network.failures.length, `failed network requests: ${network.failures.map(item => item.error).join(" | ")}`);
    assert(!failedAssets.length, `failed local assets: ${failedAssets.map(item => `${item.url} (${item.status})`).join(", ")}`);
    const localAssets = await evaluate(`Array.from(document.querySelectorAll("link[href],script[src],img[src],source[src]"), node => node.href || node.src).filter(Boolean)`);
    assert(localAssets.every(url => new URL(url).origin === sameOrigin), `non-local asset reference found: ${localAssets.join(", ")}`);
    await capture("scenario-a-prevention", "#task-list");
    record("A load, console/page errors, network, and local asset checks");

    // B: create, edit, complete a task, select recovery alternatives, attach metadata, delete.
    await keyboardActivate("#reset-demo");
    await waitState(current => current?.events?.length >= 2);
    await keyboardActivate("#quick-add-panel > summary");
    await fill("#event-title", "신규 핀테크 면접");
    await fill("#event-date", "2026-09-12");
    await fill("#event-description", "온라인 면접 일정");
    await keyboardActivate("#event-form button[type=submit]");
    await waitState(current => current?.events?.some(event => event.title === "신규 핀테크 면접"));
    let current = await state();
    const createdId = current.selectedEventId;
    assertEqual(await text("#detail-heading") || "사건 상세", "사건 상세", "detail heading remains present");
    assert((await text("#event-detail")).includes("신규 핀테크 면접"), "created event was not selected");
    await fill("[data-edit-form] input[name=title]", "수정된 핀테크 면접");
    await fill("[data-edit-form] input[name=date]", "2026-09-13");
    await fill("[data-edit-form] textarea[name=description]", "수정된 온라인 면접 일정");
    await keyboardActivate("[data-edit-form] button[type=submit]");
    await waitState(next => next?.events?.find(event => event.id === createdId)?.title === "수정된 핀테크 면접");
    current = await state();
    assertEqual(current.events.find(event => event.id === createdId).type, "interview", "edited event classification");
    const firstTaskId = (await evaluate(`document.querySelector("[data-task-id]")?.dataset.taskId || ""`));
    assert(firstTaskId, "edited event has no task");
    await keyboardActivate("[data-task-id]", " ");
    await waitState(next => next?.taskCompletion?.[firstTaskId] === true);
    await keyboardActivate("[data-recovery-option=invite-email]", " ");
    await keyboardActivate("[data-recovery-option=job-post]", " ");
    await waitState(next => next?.events?.find(event => event.id === createdId)?.recovery?.alternatives?.length === 2);
    const evidenceFile = join(tempRoot, "면접-확인서.pdf");
    await writeFile(evidenceFile, "%PDF-1.4\n% demo evidence\n", "utf8");
    await setFile("#evidence-upload", evidenceFile);
    await waitState(next => next?.evidenceFiles?.length === 1);
    assert((await text("#evidence-list")).includes("면접-확인서.pdf"), "evidence metadata is not rendered");
    const tooLarge = join(tempRoot, "too-large.pdf");
    await writeFile(tooLarge, Buffer.alloc(MAX_EVIDENCE_BYTES + 1));
    await setFile("#evidence-upload", tooLarge);
    await sleep(100);
    current = await state();
    assertEqual(current.evidenceFiles.length, 1, "oversized evidence was rejected");
    assert((await text("#app-message")).includes("10MiB"), "oversized evidence error is not announced in the global message area");
    await capture("scenario-b-recovery", "#recovery-panel");
    record("B event add/edit/delete flow and evidence metadata/limit");
    await evaluate(`document.querySelector("#quick-add-panel").open = false`);

    // C: state survives reload, then deletion removes linked task/evidence state.
    await reload();
    current = await state();
    assert(current.events.some(event => event.id === createdId && event.title === "수정된 핀테크 면접"), "edited event did not persist after reload");
    assertEqual(current.taskCompletion[firstTaskId], true, "completed task did not persist after reload");
    assertEqual(current.evidenceFiles.length, 1, "evidence metadata did not persist after reload");
    assertEqual(await evaluate(`document.querySelector("[data-task-id]")?.checked === true`), true, "checked task is not rendered after reload");
    assertEqual(await evaluate(`document.querySelectorAll("[data-recovery-option]:checked").length`), 2, "recovery alternatives did not persist after reload");
    await keyboardActivate(`[data-delete-event=${json(createdId)}]`);
    await keyboardActivate(`[data-confirm-delete=${json(createdId)}]`);
    await waitState(next => next?.events?.length >= 2 && !next.events.some(event => event.id === createdId));
    current = await state();
    assertEqual(current.evidenceFiles.length, 0, "deleting an event left evidence metadata");
    assert(!Object.keys(current.taskCompletion).some(key => key.startsWith(`${createdId}:`)), "deleting an event left task state");
    record("C task/recovery/evidence persistence and linked cleanup after delete");

    // D: invalid ICS is rejected; valid ICS previews and imports a real event.
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.events?.length >= 2 && next.selectedEventId === "event-interview");
    await keyboardActivate("#calendar-import-panel > summary");
    const invalidIcs = join(tempRoot, "invalid.ics");
    await writeFile(invalidIcs, "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:제목만 있음\nEND:VEVENT\nEND:VCALENDAR", "utf8");
    await setFile("#ics-upload", invalidIcs);
    await waitFor(() => visible("#ics-error"), { message: "invalid ICS error" });
    assert((await text("#ics-error")).includes("ICS를 가져오지 못했습니다"), "invalid ICS error text");
    const validIcs = join(tempRoot, "valid.ics");
    await writeFile(validIcs, "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260915\nSUMMARY:토익 시험\nDESCRIPTION:응시료\\, 영수증\nEND:VEVENT\nEND:VCALENDAR", "utf8");
    await setFile("#ics-upload", validIcs);
    await waitFor(() => visible("[data-confirm-ics]"), { message: "ICS import preview" });
    assert((await text("[data-ics-preview]")).includes("토익 시험"), "valid ICS preview missing event");
    await click("[data-confirm-ics]");
    await waitState(next => next?.events?.some(event => event.channel === "ics" && event.title === "토익 시험"));
    assertEqual(await visible("#ics-error"), false, "successful ICS retry left the prior error visible");
    await capture("ics-retry-success", "#event-detail");
    record("valid ICS retry clears the prior invalid-ICS error");
    await evaluate(`document.querySelector("#calendar-import-panel").open = false`);

    // Exam-specific UI has a different task plan, recovery model, and policy CTA.
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.events?.length >= 2 && next.selectedEventId === "event-interview");
    await keyboardActivate('[data-event-id="event-exam"]');
    await waitState(next => next?.selectedEventId === "event-exam");
    assert((await text("#event-detail")).includes("정보보안기사 필기"), "exam event was not selected");
    assert((await text("#task-list")).includes("결제영수증·접수확인 보관"), "exam receipt task is missing");
    assert((await text("#task-list")).includes("응시 사실 보존"), "exam attendance task is missing");
    assert((await text("#policy-cards")).includes("경기청년 역량강화 기회지원"), "exam policy match is missing");
    assert((await text(".policy-card .cta-row .button-link")).includes("공식 공고 확인"), "unknown exam policy CTA is missing");
    const examEvidence = join(tempRoot, "시험-영수증.pdf");
    await writeFile(examEvidence, "%PDF-1.4\n% exam evidence\n", "utf8");
    await setFile("#evidence-upload", examEvidence);
    await waitState(next => next?.evidenceFiles?.some(file => file.eventId === "event-exam"));
    const examTaskId = await evaluate(`document.querySelector("[data-task-id]")?.dataset.taskId || ""`);
    await keyboardActivate("[data-task-id]", " ");
    await waitState(next => next?.taskCompletion?.[examTaskId] === true);
    await capture("scenario-c-exam-support", "#event-detail");
    record("exam UI, policy match, evidence metadata, and task plan");

    // Clipboard success and the visible failure/fallback status are both browser-injectable.
    await keyboardActivate('[data-event-id="event-interview"]');
    await waitState(next => next?.selectedEventId === "event-interview");
    await evaluate(`(() => { window.__copiedText = ""; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.__copiedText = value; } } }); })()`);
    await keyboardActivate("[data-copy-request]");
    await waitFor(() => text("[data-copy-status]").then(value => value.includes("클립보드에 복사했습니다")), { message: "clipboard success status" });
    assert((await evaluate("window.__copiedText || \"\"" )).includes("안랩 PM 면접"), "clipboard success did not receive the event draft");
    await evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("forced clipboard failure"); } } })`);
    await keyboardActivate("[data-copy-request]");
    await waitFor(() => text("[data-copy-status]").then(value => value.includes("직접 복사")), { message: "clipboard fallback status" });
    assertEqual(await visible("#app-message"), true, "clipboard failure is not shown in the global message area");
    assertEqual(await visible("#ics-error"), false, "clipboard failure leaked into the ICS error area");
    record("clipboard success and visible failure fallback");

    // Policy state changes must alter the CTA, and reset must restore the demo snapshot.
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.events?.length >= 2 && next?.policies?.[0]?.status === "open");
    assertEqual(await visible("#app-message"), false, "reset did not clear the global error message");
    assertEqual(await visible("#ics-error"), false, "reset did not clear the ICS error message");
    assert((await text(".policy-card .cta-row .button-link")).includes("공식 신청 페이지"), "open policy CTA missing");
    const openCtaColors = await evaluate(`(() => { const style = getComputedStyle(document.querySelector(".policy-card .cta-row .button-link")); return [style.color, style.backgroundColor]; })()`);
    assert(openCtaColors[0] !== openCtaColors[1], `open policy CTA text is invisible: ${openCtaColors.join(" / ")}`);
    await capture("scenario-d-policy-open", "#policy-cards");
    await keyboardSelect("#policy-state", 1);
    await waitState(next => next?.policies?.find(policy => policy.id === "interview-allowance")?.status === "closed");
    assert((await text(".policy-card .cta-row .button-link")).includes("마감"), "closed policy CTA does not explain the block");
    await capture("scenario-d-policy-closed", "#policy-cards");
    await keyboardSelect("#policy-state", 2);
    await waitState(next => next?.policies?.find(policy => policy.id === "interview-allowance")?.status === "exhausted");
    assertEqual(await evaluate(`document.querySelector(".policy-card .cta-row .button-link")?.disabled === true`), true, "exhausted policy CTA is not disabled");
    assert((await text(".policy-card .cta-row .button-link")).includes("예산 소진"), "exhausted policy CTA does not explain the block");
    await capture("scenario-d-policy-exhausted", "#policy-cards");
    await keyboardSelect("#policy-state", 3);
    await waitState(next => next?.policies?.find(policy => policy.id === "interview-allowance")?.status === "unknown");
    assertEqual(await evaluate(`document.querySelector(".policy-card .cta-row .button-link")?.tagName`), "A", "unknown policy CTA should link to the source");
    assert((await text(".policy-card .cta-row .button-link")).includes("공식 공고 확인"), "unknown policy CTA label");
    const unknownCtaColors = await evaluate(`(() => { const style = getComputedStyle(document.querySelector(".policy-card .cta-row .button-link")); return [style.color, style.backgroundColor]; })()`);
    assert(unknownCtaColors[0] !== unknownCtaColors[1], `unknown policy CTA text is invisible: ${unknownCtaColors.join(" / ")}`);
    await capture("scenario-d-policy-unknown", "#policy-cards");
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.events?.length >= 2 && next?.policies?.find(policy => policy.id === "interview-allowance")?.status === "open");
    record("policy CTA state transition and reset");

    // A browser-injected source failure must degrade to an explicit, disabled CTA.
    await evaluate(`(() => { const policy = globalThis.calenfit.state.policies.find(item => item.id === "interview-allowance"); policy.sourceUrl = "https://evil.example/not-an-official-source"; policy.applicationUrl = ""; policy.officialUrl = ""; globalThis.calenfit.render(); })()`);
    await waitFor(() => text(".policy-card .cta-row .button-link").then(value => value.includes("출처 확인 필요")), { message: "policy source fallback CTA" });
    assertEqual(await evaluate(`document.querySelector(".policy-card .cta-row .button-link")?.disabled === true`), true, "missing policy source CTA is not disabled");
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.policies?.find(policy => policy.id === "interview-allowance")?.status === "open");
    record("policy source failure fallback");

    // Corrupt storage recovers to seed data; escaped rendering prevents an injected element.
    const unrelatedKey = "calenfit-e2e-unrelated";
    await evaluate(`(() => { localStorage.setItem(${json(unrelatedKey)}, "keep-me"); localStorage.setItem("calenfit-calendar-benefit-v1", "{bad"); })()`);
    await reload();
    current = await state();
    assert(current.events.length >= 2, "corrupt localStorage did not recover to seed events");
    assert((current.error || "").includes("저장"), "corrupt localStorage recovery was not announced");
    assertEqual(await evaluate(`localStorage.getItem(${json(unrelatedKey)})`), "keep-me", "unrelated localStorage key was lost during recovery");
    await keyboardActivate("#quick-add-panel > summary");
    await fill("#event-title", '<img src=x onerror="window.__xss=1"> 안전 테스트');
    await fill("#event-date", "2026-09-20");
    await keyboardActivate("#event-form button[type=submit]");
    await waitState(next => next?.events?.some(event => event.title.includes("<img")));
    assertEqual(await evaluate(`document.querySelector("#event-detail img") === null`), true, "event title created an executable image element");
    assert((await text("#event-detail")).includes("<img src=x"), "escaped event title is not visible as text");
    assertEqual(await evaluate("Boolean(window.__xss)"), false, "XSS marker executed");
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.events?.length >= 2 && next?.error === "");
    assertEqual(await evaluate(`localStorage.getItem(${json(unrelatedKey)})`), "keep-me", "reset removed unrelated localStorage key");
    record("corrupt storage recovery, XSS-safe rendering, and reset isolation");

    // Recovery primary and alternatives are operable from the keyboard alone.
    await keyboardActivate('[data-primary-proof=yes]', " ");
    await waitState(next => next?.events?.find(event => event.id === "event-interview")?.recovery?.hasPrimary === true);
    await keyboardActivate('[data-primary-proof=no]', " ");
    await waitState(next => next?.events?.find(event => event.id === "event-interview")?.recovery?.hasPrimary === false);
    await keyboardActivate("[data-recovery-option=invite-email]", " ");
    await keyboardActivate("[data-recovery-option=job-post]", " ");
    await waitState(next => next?.events?.find(event => event.id === "event-interview")?.recovery?.alternatives?.length === 2);
    record("keyboard recovery primary and alternative controls");

    // The compact month calendar can expand the connected calendar without losing keyboard escape.
    await keyboardActivate("#expand-calendar");
    assertEqual(await evaluate(`document.body.classList.contains("calendar-focus-mode")`), true, "full calendar view did not open");
    assertEqual(await evaluate(`document.querySelector("#expand-calendar")?.getAttribute("aria-expanded")`), "true", "full calendar control did not expose expanded state");
    await key("Escape");
    assertEqual(await evaluate(`document.body.classList.contains("calendar-focus-mode")`), false, "Escape did not return to dashboard view");
    record("month calendar expands and returns with Escape");

    // Keyboard focus basics: skip link can receive focus and Tab advances into the form.
    await evaluate(`document.querySelector(".skip-link")?.focus()`);
    assertEqual(await evaluate(`document.activeElement?.classList.contains("skip-link")`), true, "skip link is not keyboard focusable");
    await pageSend("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await pageSend("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    assertEqual(await evaluate(`document.activeElement !== document.body`), true, "Tab did not move focus");
    record("keyboard focus basics");

    // Capture exact viewport screenshots from the browser, after returning to a clean demo state.
    await keyboardActivate("#reset-demo");
    await waitState(next => next?.events?.length >= 2 && next?.selectedEventId === "event-interview");
    assertEqual(await evaluate(`document.querySelectorAll("#month-calendar .month-cell").length`), 32, "September monthly calendar cells");
    assert((await text("#month-calendar")).includes("면접"), "monthly calendar interview marker");
    await keyboardActivate("#calendar-connections-panel > summary");
    assert((await text("#calendar-connections")).includes("서버 설정 필요"), "Google unconfigured state");
    await click("[data-google-outcome=success]");
    await waitState(next => next?.calendarConnections?.google?.state === "synced");
    await keyboardActivate("#notification-panel > summary");
    await click("#notification-consent");
    await click("#notification-form button[type=submit]");
    await waitState(next => next?.notifications?.some(item => item.status === "scheduled"));
    assert((await text("#notification-outbox")).includes("예약됨"), "notification outbox scheduled state");
    assertEqual(await evaluate(`localStorage.getItem("calenfit-ai-session-config")`), null, "AI settings do not use localStorage");
    record("monthly calendar, provider states, and notification outbox");
    await evaluate(`document.querySelectorAll(".rail-disclosure").forEach(item => { item.open = false; })`);
    await setDevice(1440, 900, false);
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(120);
    const desktopShot = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await mkdir(SCREENSHOT_ROOT, { recursive: true });
    await writeFile(join(SCREENSHOT_ROOT, "final-desktop-1440x900.png"), Buffer.from(desktopShot.data, "base64"));
    await setDevice(390, 844, true);
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(120);
    const mobileShot = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(SCREENSHOT_ROOT, "final-mobile-390x844.png"), Buffer.from(mobileShot.data, "base64"));
    record("true desktop/mobile screenshots with no horizontal overflow");

    assert(!network.consoleErrors.length, `console errors during E2E: ${network.consoleErrors.join(" | ")}`);
    assert(!network.exceptions.length, `page exceptions during E2E: ${network.exceptions.join(" | ")}`);
    console.log(`E2E passed: ${passed.length} checks`);
    for (const check of passed) console.log(`  ✓ ${check}`);
  } finally {
    if (browser) {
      try { await browser.pageSend("Browser.close"); } catch {}
      try { browser.chrome.kill("SIGTERM"); } catch {}
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { await rm(browser.profileRoot, { recursive: true, force: true }); break; }
        catch (error) { if (error.code !== "ENOTEMPTY") throw error; await sleep(100); }
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
    await new Promise(resolvePromise => server.close(() => resolvePromise()));
  }
}

run().catch(error => {
  console.error(`E2E failed: ${error.message}`);
  process.exitCode = 1;
});

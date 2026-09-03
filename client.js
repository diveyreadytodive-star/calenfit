const appState = {
  phase: "booting",
  workspaceVisible: false,
  user: null,
  profile: null,
  events: [],
  selectedEventId: null,
  pendingDeleteEventId: null,
  currentMonth: "2026-09",
  policyRecommendations: { profileBased: [], eventBased: [] },
  google: { state: "loading", lastSyncAt: null },
};
const CALENDAR_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let googleSyncInFlight = false;
let profileEditing = false;

const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const typeLabel = type => ({ interview: "면접", exam: "시험", startup: "창업", general: "일반" })[type] || "일반";
const formatDate = value => new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", weekday: "short" }).format(new Date(`${value}T09:00:00+09:00`));

function announce(message, isError = false) {
  const live = $("#app-status");
  const error = $("#app-message");
  if (live) live.textContent = message;
  if (error) {
    error.textContent = isError ? message : "";
    error.hidden = !isError;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.error || `요청 실패 (${response.status})`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}

function setAuthVisibility() {
  const authenticated = appState.phase === "authenticated" || appState.phase === "onboarding";
  document.body.classList.toggle("auth-anonymous", !authenticated);
  document.body.classList.toggle("workspace-visible", authenticated || appState.workspaceVisible);
  $("#landing-screen")?.classList.toggle("is-hidden", authenticated || appState.workspaceVisible);
  if (authenticated) $("#auth-screen").hidden = true;
}

function enterWorkspace() {
  appState.workspaceVisible = true;
  setAuthVisibility();
  $("#main-content")?.focus();
}

function openAuth() {
  if (appState.phase === "authenticated" || appState.phase === "onboarding") return;
  $("#auth-screen").hidden = false;
  setTimeout(() => $("#account-auth-form input[name=email]")?.focus(), 0);
}

function closeAuth() {
  $("#auth-screen").hidden = true;
  $("#auth-message").textContent = "";
}

function renderProfile() {
  const summary = $("#profile-summary");
  const form = $("#profile-form");
  const trigger = $("#profile-login-trigger");
  const action = $("#profile-login-button");
  const edit = $("#profile-edit-button");
  if (!summary || !form || !trigger || !action || !edit) return;
  if (!appState.user) {
    summary.innerHTML = '<p class="empty-state">로그인 후 맞춤 프로필을 작성하세요.</p>';
    trigger.textContent = "로그인 필요";
    action.textContent = "로그인 / 회원가입";
    action.dataset.action = "login";
    edit.hidden = true;
    form.hidden = true;
    return;
  }
  trigger.textContent = appState.profile ? "로그인됨" : "프로필 필요";
  action.textContent = "로그아웃";
  action.dataset.action = "logout";
  if (!appState.profile) {
    summary.innerHTML = `<p class="empty-state">${escapeHTML(appState.user.email)}<br>맞춤 추천을 위해 프로필을 작성하세요.</p>`;
    form.hidden = false;
    edit.hidden = true;
    form.reset();
    return;
  }
  summary.innerHTML = `
    <div class="profile-item"><span class="meta-label">계정</span><span class="meta-value">${escapeHTML(appState.user.email)}</span></div>
    <div class="profile-item"><span class="meta-label">출생</span><span class="meta-value">${escapeHTML(appState.profile.birthYear)}년생</span></div>
    <div class="profile-item"><span class="meta-label">거주</span><span class="meta-value">${escapeHTML(appState.profile.residence)}</span></div>
    <div class="profile-item"><span class="meta-label">상태</span><span class="meta-value">${escapeHTML(appState.profile.status)}</span></div>
    <div class="profile-item"><span class="meta-label">학력</span><span class="meta-value">${escapeHTML(appState.profile.education || "미입력")}</span></div>
    <div class="profile-item"><span class="meta-label">학교</span><span class="meta-value">${escapeHTML(appState.profile.school || "미입력")}</span></div>
    <div class="profile-item"><span class="meta-label">전공</span><span class="meta-value">${escapeHTML(appState.profile.major || "미입력")}</span></div>
    <div class="profile-item"><span class="meta-label">목표</span><span class="meta-value">${escapeHTML(appState.profile.goal || "미입력")}</span></div>`;
  for (const [name, value] of Object.entries(appState.profile)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
  edit.hidden = false;
  edit.textContent = profileEditing ? "수정 취소" : "프로필 수정";
  form.hidden = !profileEditing;
}

function taskListFor(event) {
  if (!event) return [];
  if (event.type === "interview") return ["채용공고 저장", "면접확인서 요청", "미회신 후속 확인"];
  if (event.type === "exam") return ["결제영수증 보관", "접수확인 보관", "응시 사실 보존"];
  return ["일정 설명과 공식 공고 확인"];
}

function renderCalendar() {
  const root = $("#month-calendar");
  if (!root) return;
  const [year, month] = appState.currentMonth.split("-").map(Number);
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const dayCount = new Date(year, month, 0).getDate();
  const monthText = `${year}년 ${month}월 월간 달력`;
  const heading = $("#calendar-heading");
  if (heading) heading.textContent = monthText;
  root.setAttribute("aria-label", monthText);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: dayCount }, (_, index) => index + 1)];
  root.innerHTML = `<div class="month-weekdays" aria-hidden="true">${weekdays.map(day => `<span>${day}</span>`).join("")}</div><div class="month-grid">${cells.map(day => {
    if (!day) return '<span class="month-cell empty" aria-hidden="true"></span>';
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const events = appState.events.filter(event => event.date === date);
    return `<button type="button" class="month-cell ${events.some(event => event.id === appState.selectedEventId) ? "selected" : ""}" data-month-date="${date}"><strong>${day}</strong>${events.map(event => `<span class="month-event ${escapeHTML(event.type)}">${escapeHTML(typeLabel(event.type))} · ${escapeHTML(event.title)}</span>`).join("")}</button>`;
  }).join("")}</div><p class="calendar-caption">날짜를 누르면 그 날짜로 일정 추가 창이 열립니다. 등록된 일정을 누르면 연결 정책과 할 일을 확인합니다.</p>`;
}

function moveCalendarMonth(offset) {
  const [year, month] = appState.currentMonth.split("-").map(Number);
  const target = new Date(year, month - 1 + offset, 1);
  appState.currentMonth = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
  renderCalendar();
}

function renderEvents() {
  const root = $("#event-list");
  const empty = $("#event-empty");
  if (!root || !empty) return;
  empty.hidden = appState.events.length > 0;
  root.innerHTML = appState.events.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2).map(event => `
    <article class="event-card ${event.id === appState.selectedEventId ? "active" : ""}">
      <button type="button" class="event-select-button" data-event-id="${escapeHTML(event.id)}">
      <span class="event-header"><span><strong class="event-title">${escapeHTML(event.title)}</strong><span class="event-description">${escapeHTML(event.description || "설명 없음")}</span></span><span class="event-date">${escapeHTML(formatDate(event.date))}</span></span>
      <span class="event-footer"><span class="chip">${escapeHTML(typeLabel(event.type))}</span><span class="chip">${event.classificationSource === "ai" ? "AI 분류" : "안전 분류"}</span>${event.providerId ? '<span class="chip">Google Calendar</span>' : ""}<span class="chip">증빙 ${taskListFor(event).length}개</span></span>
      </button>
      <details class="event-task-details"><summary>증빙 행동 보기</summary><ul>${taskListFor(event).map(task => `<li>${escapeHTML(task)}</li>`).join("")}</ul></details>
      ${event.providerId ? "" : `<button type="button" class="event-delete-button" data-delete-event="${escapeHTML(event.id)}" aria-label="${escapeHTML(event.title)} 삭제">삭제</button>`}
    </article>`).join("");
}

function policyCard(policy, includeEvent = false) {
  const statusLabel = ({ open: "공고 확인", closed: "종료·이력 확인", review: "확인 필요" })[policy.status] || "확인 필요";
  const badgeClass = policy.status === "closed" ? "low" : policy.eligibility === "high" ? "high" : "medium";
  return `<details class="policy-card compact-policy policy-disclosure">
    <summary><span class="policy-summary-title"><strong class="policy-title">${escapeHTML(policy.title)}</strong><span class="policy-amount">${escapeHTML(policy.amount)}</span></span><span class="badge ${badgeClass}">${statusLabel}</span></summary>
    <div class="policy-disclosure-body">
      ${includeEvent ? `<p class="policy-summary">연결 일정: ${escapeHTML((policy.eventTitles || [policy.eventTitle]).filter(Boolean).join(", "))}</p>` : ""}
      <p class="policy-summary">${escapeHTML(policy.reason)}</p>
      <p class="policy-summary">확인 조건: ${escapeHTML(policy.condition)}</p>
      <p class="policy-summary">증빙 후보: ${escapeHTML((policy.evidence || []).join(", "))}</p>
      <p class="policy-checked">마지막 확인 ${escapeHTML(policy.checkedAt)}${policy.deadline ? ` · ${escapeHTML(policy.deadline)}` : ""}</p>
      <p class="policy-checked">출처 ${escapeHTML(policy.sourcePortal || "공식 운영기관")} · ${escapeHTML(policy.uncertainty || "세부 자격은 공식 공고에서 확인하세요.")}</p>
      <div class="cta-row"><a class="button-link" href="${escapeHTML(policy.url)}" target="_blank" rel="noopener noreferrer">공식 공고 확인</a></div>
    </div>
  </details>`;
}

function renderPoliciesAndTasks() {
  const profileRoot = $("#profile-policy-cards");
  const eventRoot = $("#event-policy-cards");
  if (!profileRoot || !eventRoot) return;
  const profilePolicies = appState.policyRecommendations.profileBased || [];
  const eventPolicies = appState.policyRecommendations.eventBased || [];
  const discoveryLinks = appState.policyRecommendations.discoveryLinks || [];
  const profilePanel = $("#profile-policy-panel");
  const eventPanel = $("#event-policy-panel");
  if (profilePanel) profilePanel.hidden = profilePolicies.length === 0;
  if (eventPanel) eventPanel.hidden = eventPolicies.length === 0;
  profileRoot.innerHTML = profilePolicies.map(policy => policyCard(policy)).join("");
  eventRoot.innerHTML = eventPolicies.map(policy => policyCard(policy, true)).join("");
  const sourcePanel = $("#policy-source-panel");
  const sourceRoot = $("#policy-source-links");
  if (sourcePanel) sourcePanel.hidden = !appState.profile || discoveryLinks.length === 0;
  if (sourceRoot) sourceRoot.innerHTML = discoveryLinks.map(link => `<a class="policy-source-link" href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHTML(link.title)}</strong><span>${link.destinationKind === "locator" ? "검색 locator" : "공식 포털"} · ${escapeHTML(link.coverage)}</span></a>`).join("");
}

function renderGoogle() {
  for (const button of document.querySelectorAll("[data-google-connect]")) {
    button.disabled = appState.google.state === "loading";
    button.textContent = appState.google.state === "synced" ? "Google Calendar 동기화" : appState.google.state === "configured" ? "Google Calendar 연결" : appState.google.state === "loading" ? "Google 상태 확인 중" : "Google Calendar 연결";
    button.title = !appState.user ? "로그인 후 Google Calendar를 연결할 수 있습니다." : appState.google.state === "not-configured" ? "서버에 Google OAuth 환경변수 설정이 필요합니다." : "";
  }
  const helper = $("#google-oauth-profile-status");
  if (helper) helper.textContent = appState.google.state === "synced" ? "Google Calendar가 연결되어 있습니다." : appState.google.state === "configured" ? "OAuth 서버 설정 완료 · 연결 버튼을 눌러 동의하세요." : "서버 설정 필요 · 아래 환경변수를 서버에만 등록하세요.";
  const disconnect = $("#google-disconnect-button");
  if (disconnect) disconnect.hidden = appState.google.state !== "synced";
  const status = $("#google-calendar-status");
  if (status) {
    const state = googleSyncInFlight ? "syncing" : appState.google.state;
    const presentation = {
      syncing: ["checking", "Google Calendar 동기화 중"],
      synced: ["live", "Google Calendar 연결됨"],
      configured: ["neutral", "Google Calendar 미연결"],
      "login-required": ["neutral", "Google Calendar 미연결"],
      "not-configured": ["error", "Google Calendar 설정 필요"],
      error: ["error", "Google Calendar 오류"],
      loading: ["checking", "Google Calendar 확인 중"],
    }[state] || ["neutral", "Google Calendar 미연결"];
    status.className = `api-status ${presentation[0]}`;
    status.innerHTML = `<span></span>${presentation[1]}`;
    status.title = appState.google.lastSyncAt ? `마지막 동기화: ${new Date(appState.google.lastSyncAt).toLocaleString("ko-KR")} · 열린 탭에서 5분마다 갱신` : "로그인 후 Google Calendar를 연결할 수 있습니다.";
  }
}

function render() {
  setAuthVisibility();
  renderProfile();
  renderCalendar();
  renderEvents();
  renderPoliciesAndTasks();
  renderGoogle();
}

async function loadPrivateState() {
  const [profile, events, google, recommendations] = await Promise.all([api("/api/profile"), api("/api/events"), api("/api/calendar/google/status"), api("/api/policies")]);
  appState.profile = profile.profile;
  appState.events = (events.events || []).map(event => ({ ...event, type: event.type || "general", classificationSource: event.classificationSource || "local" }));
  appState.selectedEventId = appState.events[0]?.id || null;
  appState.google = google;
  appState.policyRecommendations = recommendations;
  appState.phase = appState.profile ? "authenticated" : "onboarding";
}

async function reanalyzeLegacyEvents() {
  const targets = appState.events.filter(event => event.source !== "google" && (!event.policyDomains?.length || !event.intentTags?.length)).slice(0, 6);
  if (!targets.length) return;
  const updates = await Promise.allSettled(targets.map(async event => {
    return api(`/api/events/${encodeURIComponent(event.id)}`, { method: "PATCH", body: JSON.stringify({ title: event.title, description: event.description, date: event.date }) });
  }));
  if (!updates.some(update => update.status === "fulfilled")) return;
  await loadPrivateState();
  render();
  announce("기존 일정의 AI 의도 분석을 최신화했습니다.");
}

async function boot() {
  try {
    const session = await api("/api/auth/session");
    appState.user = session.user;
    appState.workspaceVisible = true;
    await loadPrivateState();
    const params = new URLSearchParams(location.search);
    if (params.get("google") === "connected") {
      await syncGoogleCalendar();
      history.replaceState({}, "", location.pathname);
    } else if (params.get("google") === "denied") announce("Google Calendar 권한이 거부되었습니다.", true);
    else if (params.get("google") === "error") announce("Google Calendar 연결을 완료하지 못했습니다.", true);
  } catch (error) {
    if (error.status !== 401) announce(`서버 상태를 불러오지 못했습니다. ${error.message}`, true);
    appState.phase = "anonymous";
    appState.user = null;
    appState.profile = null;
    appState.events = [];
    appState.google = { state: "login-required", lastSyncAt: null };
  }
  render();
  checkAiHealth();
  if (appState.user) reanalyzeLegacyEvents();
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitter = event.submitter;
  const action = submitter?.value || "login";
  const data = new FormData(form);
  const message = $("#auth-message");
  for (const button of form.querySelectorAll("button")) button.disabled = true;
  try {
    const result = await api(`/api/auth/${action}`, { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
    appState.user = result.user;
    await loadPrivateState();
    message.textContent = "";
    form.reset();
    closeAuth();
    render();
    reanalyzeLegacyEvents();
    if (!appState.profile) {
      $(".profile-panel")?.setAttribute("open", "");
      announce("계정이 준비되었습니다. 왼쪽에서 맞춤 프로필을 작성하세요.");
    } else announce("로그인했습니다.");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    for (const button of form.querySelectorAll("button")) button.disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  Object.assign(appState, { phase: "anonymous", workspaceVisible: true, user: null, profile: null, events: [], selectedEventId: null, policyRecommendations: { profileBased: [], eventBased: [] }, google: { state: "not-configured", lastSyncAt: null } });
  render();
  announce("로그아웃했습니다.");
}

async function saveProfile(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const result = await api("/api/profile", { method: "POST", body: JSON.stringify(Object.fromEntries(data)) });
    appState.profile = result.profile;
    profileEditing = false;
    appState.phase = "authenticated";
    appState.policyRecommendations = await api("/api/policies");
    render();
    announce("프로필을 저장하고 정책 후보를 다시 계산했습니다.");
  } catch (error) { announce(error.message, true); }
}

async function saveEvent(event) {
  event.preventDefault();
  if (!appState.user) return openAuth();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    const result = await api("/api/events", { method: "POST", body: JSON.stringify(data) });
    appState.events.push(result.event);
    appState.selectedEventId = result.event.id;
    appState.policyRecommendations = await api("/api/policies");
    form.reset();
    $("#event-modal")?.close();
    render();
    announce("일정을 저장하고 분석 결과를 반영했습니다.");
  } catch (error) { announce(error.message, true); }
}

function openDeleteEventModal(id) {
  const event = appState.events.find(item => item.id === id);
  if (!event) return;
  appState.pendingDeleteEventId = id;
  const title = $("#delete-event-name");
  if (title) title.textContent = event.title;
  const description = $("#delete-event-description");
  if (description) description.textContent = "일정이 달력과 연결 정책에서 제거됩니다.";
  $("#delete-event-modal")?.showModal();
}

async function confirmDeleteEvent() {
  const id = appState.pendingDeleteEventId;
  if (!id) return;
  try {
    await api(`/api/events/${encodeURIComponent(id)}`, { method: "DELETE" });
    appState.events = appState.events.filter(event => event.id !== id);
    appState.selectedEventId = appState.events[0]?.id || null;
    appState.policyRecommendations = await api("/api/policies");
    appState.pendingDeleteEventId = null;
    $("#delete-event-modal")?.close();
    render();
    announce("일정을 삭제했습니다.");
  } catch (error) { announce(error.message, true); }
}

function openEventModal(date = "") {
  if (!appState.user) return openAuth();
  const modal = $("#event-modal");
  if (date) $("#event-date").value = date;
  else if (!$("#event-date").value) $("#event-date").value = "2026-09-01";
  modal?.showModal();
  setTimeout(() => $("#event-title")?.focus(), 0);
}

async function startGoogleCalendar() {
  if (!appState.user) return openAuth();
  if (appState.google.state === "synced") return syncGoogleCalendar();
  try {
    const result = await api("/api/calendar/google/connect");
    const authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "accounts.google.com") throw new Error("안전하지 않은 OAuth URL입니다.");
    location.assign(authorizationUrl.href);
  } catch (error) { announce(error.message, true); }
}

async function syncGoogleCalendar({ silent = false } = {}) {
  if (googleSyncInFlight || !appState.user || appState.google.state !== "synced") return;
  googleSyncInFlight = true;
  renderGoogle();
  try {
    await api("/api/calendar/google/sync", { method: "POST" });
    await loadPrivateState();
    render();
    if (!silent) announce("Google Calendar 일정을 동기화했습니다.");
  } catch (error) {
    appState.google = { ...appState.google, state: "error" };
    renderGoogle();
    if (!silent) announce(error.message, true);
  } finally {
    googleSyncInFlight = false;
    renderGoogle();
  }
}

function syncGoogleIfStale() {
  if (document.visibilityState !== "visible" || appState.google.state !== "synced") return;
  const lastSync = Date.parse(appState.google.lastSyncAt || "") || 0;
  if (Date.now() - lastSync >= CALENDAR_SYNC_INTERVAL_MS) syncGoogleCalendar({ silent: true });
}

async function disconnectGoogleCalendar() {
  try {
    await api("/api/calendar/google/disconnect", { method: "POST" });
    await loadPrivateState();
    render();
    announce("Google Calendar 연결과 동기화된 일정 사본을 삭제했습니다.");
  } catch (error) { announce(error.message, true); }
}

async function startSocialAuth(provider) {
  try {
    const result = await api(`/api/auth/${provider}/start`);
    const authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.protocol !== "https:") throw new Error("안전하지 않은 로그인 URL입니다.");
    location.assign(authorizationUrl.href);
  } catch (error) { $("#auth-message").textContent = error.message; }
}

async function checkAiHealth() {
  const badge = $("#ai-api-status");
  if (!badge) return;
  badge.className = "api-status checking";
  badge.innerHTML = "<span></span>AI 확인 중";
  try {
    await api("/api/ai/health");
    badge.className = "api-status live";
    badge.innerHTML = "<span></span>AI 연결됨";
  } catch {
    badge.className = "api-status error";
    badge.innerHTML = "<span></span>AI 연결 필요";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#account-auth-form")?.addEventListener("submit", submitAuth);
  $("#profile-form")?.addEventListener("submit", saveProfile);
  $("#event-form")?.addEventListener("submit", saveEvent);
  $("#landing-start-button")?.addEventListener("click", enterWorkspace);
  $("#landing-demo-button")?.addEventListener("click", enterWorkspace);
  $("#profile-login-trigger")?.addEventListener("click", () => appState.user ? null : openAuth());
  $("#profile-login-button")?.addEventListener("click", event => event.currentTarget.dataset.action === "logout" ? logout() : openAuth());
  $("#profile-edit-button")?.addEventListener("click", () => {
    profileEditing = !profileEditing;
    renderProfile();
    if (profileEditing) setTimeout(() => $("#profile-form input")?.focus(), 0);
  });
  $("#calendar-add-button")?.addEventListener("click", () => openEventModal());
  $("#calendar-prev-month")?.addEventListener("click", () => moveCalendarMonth(-1));
  $("#calendar-next-month")?.addEventListener("click", () => moveCalendarMonth(1));
  $("#ai-api-status")?.addEventListener("click", checkAiHealth);
  $("#google-calendar-status")?.addEventListener("click", () => appState.google.state === "synced" ? syncGoogleCalendar() : startGoogleCalendar());
  $("#google-disconnect-button")?.addEventListener("click", disconnectGoogleCalendar);
  $("#sidebar-brand-logo")?.addEventListener("click", event => {
    event.preventDefault();
    appState.workspaceVisible = false;
    $("#landing-screen")?.classList.remove("is-hidden");
    scrollTo({ top: 0, behavior: "smooth" });
  });
  document.addEventListener("click", event => {
    const social = event.target.closest("[data-social-auth]");
    if (social) return startSocialAuth(social.dataset.socialAuth);
    if (event.target.closest("[data-google-connect]")) return startGoogleCalendar();
    if (event.target.closest("[data-close-event-modal]")) return $("#event-modal")?.close();
    if (event.target.closest("[data-close-delete-modal]")) {
      appState.pendingDeleteEventId = null;
      return $("#delete-event-modal")?.close();
    }
    if (event.target.closest("[data-confirm-delete-event]")) return confirmDeleteEvent();
    const deleteButton = event.target.closest("[data-delete-event]");
    if (deleteButton) return openDeleteEventModal(deleteButton.dataset.deleteEvent);
    const eventButton = event.target.closest("[data-event-id]");
    if (eventButton) {
      appState.selectedEventId = eventButton.dataset.eventId;
      return render();
    }
    const cell = event.target.closest("[data-month-date]");
    if (!cell) return;
    const dateEvent = appState.events.find(item => item.date === cell.dataset.monthDate);
    if (dateEvent) {
      appState.selectedEventId = dateEvent.id;
      render();
    } else openEventModal(cell.dataset.monthDate);
  });
  $("#auth-screen")?.addEventListener("click", event => {
    if (event.target === event.currentTarget) closeAuth();
  });
  setInterval(syncGoogleIfStale, CALENDAR_SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", syncGoogleIfStale);
  window.addEventListener("focus", syncGoogleIfStale);
  boot();
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  STORAGE_KEY, SCHEMA_VERSION, MAX_EVIDENCE_BYTES, PROFILE, SEED_POLICIES,
  inferEventType, classifyEvent, normalizePolicy, parseICS, matchPolicies,
  buildTasks, evaluateRecovery, seedState, validateState, loadState, saveState, resetState,
  setTaskCompletion, createEvent, updateEvent, deleteEvent, addEvidence,
  policyStatusLabel, safeUrl,
} = require('../app.js');
const store = (initial = {}) => { const data = new Map(Object.entries(initial)); return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data }; };
const throwingStore = () => ({ getItem: () => { throw new Error('security'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} });
const interviewFixture = { title: '가상핀테크 PM 면접', date: '2026-09-05', description: '판교 오프라인 면접' };
const examFixture = { title: '정보보안기사 필기', date: '2026-10-02', description: '응시료 영수증 보관' };
assert.match(fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8'), /data-email-draft/);

assert.equal(inferEventType('가상핀테크 PM 면접', '').type, 'interview');
assert.equal(inferEventType('interview', '').source, 'local');
assert.equal(inferEventType('정보보안기사 필기', '').type, 'exam');
assert.equal(inferEventType('모두의창업 데모데이', '').type, 'startup');
assert.equal(inferEventType('아무 약속', '').type, 'general');
assert.equal(inferEventType('아무 약속', '').confidence < .8, true);
assert.equal(classifyEvent('anything', '', { classify: () => ({ type: 'exam', confidence: .99, eligibility: 'high', status: 'open' }) }).source, 'ai');
assert.equal(classifyEvent('anything', '', { classify: () => ({ type: 'bogus', confidence: .99 }) }).source, 'local');
assert.match(classifyEvent('anything', '', { classify: () => { throw new Error('offline'); } }).fallbackReason, /AI 분류 실패/);
assert.equal(classifyEvent('anything', '', { classify: () => ({ type: 'exam', confidence: 4 }) }).type, 'general');

const initial = seedState();
const interview = createEvent(initial, interviewFixture);
const exam = createEvent(initial, examFixture);
assert.deepEqual(matchPolicies(interview, initial.policies, initial.profile).map(x => x.policy.id), ['interview-allowance']);
assert.equal(matchPolicies(interview, initial.policies, initial.profile)[0].eligibility, 'high');
assert.match(matchPolicies(interview, initial.policies, initial.profile)[0].reason, /경기도|미취업|면접/);
assert.deepEqual(matchPolicies(exam, initial.policies, initial.profile).map(x => x.policy.id), ['exam-support']);
assert.deepEqual(matchPolicies({ type: 'general', title: '동아리', description: '' }, initial.policies, PROFILE), []);
assert.equal(matchPolicies(interview, initial.policies, { ...PROFILE, residence: '서울' })[0].eligibility, 'low');
assert.equal(matchPolicies(exam, initial.policies, PROFILE)[0].policy.status, 'unknown');
assert.equal(normalizePolicy({ ...SEED_POLICIES[0], sourceUrl: '', officialUrl: '' }).status, 'unknown');
const provenance = normalizePolicy({ ...SEED_POLICIES[0], sourceUrl: 'https://www.gg.go.kr/policy', applicationUrl: 'https://apply.jobaba.net/start', officialUrl: 'https://youth.gg.go.kr/legacy' });
assert.equal(provenance.sourceUrl, 'https://www.gg.go.kr/policy');
assert.equal(provenance.applicationUrl, 'https://apply.jobaba.net/start');
assert.equal(provenance.officialUrl, 'https://apply.jobaba.net/start');
assert.equal(normalizePolicy({ ...SEED_POLICIES[0], sourceUrl: '', applicationUrl: 'https://apply.jobaba.net/start' }).status, 'unknown');
assert.equal(SEED_POLICIES.find(policy => policy.id === 'exam-support').amount, '최대 30만원');
assert.equal(safeUrl('javascript:alert(1)'), '');
assert.equal(policyStatusLabel('closed'), '마감');

const interviewTasks = buildTasks(interview);
assert.deepEqual(interviewTasks.slice(0, 3).map(task => task.due), ['2026-09-02', '2026-09-06', '2026-09-08']);
assert.equal(new Set(interviewTasks.map(task => task.id)).size, interviewTasks.length);
const datedPolicy = { ...SEED_POLICIES[0], applicationStart: '2026-09-01', applicationDeadline: '2026-09-20' };
const datedTasks = buildTasks(interview, [{ policy: datedPolicy }]);
assert.deepEqual(datedTasks.filter(t => t.policyId).map(t => t.title), ['접수 시작', '마감 임박']);
assert.equal(datedTasks.filter(t => t.policyId)[0].provenance.sourceUrl, datedPolicy.sourceUrl);
assert.equal(buildTasks(interview, [{ policy: datedPolicy }]).map(t => t.id).join(), datedTasks.map(t => t.id).join());
assert.ok(buildTasks(exam).some(task => task.kind === 'receipt'));
assert.ok(buildTasks(exam).some(task => task.kind === 'employment-status'));

assert.equal(evaluateRecovery(interview).status, 'incomplete');
assert.equal(evaluateRecovery(interview).missing.length, 5);
assert.deepEqual(evaluateRecovery(interview).safetyStatements.map(item => item.label), ['대체 신청 경로 있음', '추가 확인 필요', '최종 판단은 운영기관']);
assert.deepEqual(evaluateRecovery(interview).safetyStatements.map(item => item.active), [false, true, true]);
interview.recovery.alternatives = ['invite-email', 'job-post'];
assert.equal(evaluateRecovery(interview).status, 'alternative');
assert.deepEqual(evaluateRecovery(interview).safetyStatements.map(item => item.active), [true, false, true]);
assert.match(evaluateRecovery(interview).disclaimer, /운영기관/);
interview.recovery.hasPrimary = true;
assert.equal(evaluateRecovery(interview).status, 'sufficient');
assert.equal(evaluateRecovery(exam).missing.length, 4);

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260905\r\nSUMMARY:가상핀테크 PM 면접\r\nDESCRIPTION:대면 면접\\, 판교\r\nEND:VEVENT\r\nEND:VCALENDAR';
const imported = parseICS(ics);
assert.equal(imported.length, 1);
assert.equal(imported[0].date, '2026-09-05');
assert.equal(imported[0].description, '대면 면접, 판교');
const folded = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261002T090000Z\nSUMMARY:정보보안기사\nDESCRIPTION:응시\n 계속\nEND:VEVENT\nEND:VCALENDAR');
assert.equal(folded[0].description, '응시계속');
const tz = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=Asia/Seoul:20260905T090000\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR');
assert.equal(tz.warnings.length, 0);
const floating = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260905T090000\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR');
assert.equal(floating.warnings.length, 1);
const unknownTz = parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=Europe/Paris:20260905T090000\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR');
assert.equal(unknownTz.warnings.length, 1);
for (const bad of ['', 'BEGIN:VCALENDAR\nEND:VCALENDAR', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261399\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:A\nEND:VEVENT\nEND:VCALENDAR']) assert.throws(() => parseICS(bad), /ICS|VEVENT|DTSTART/);
assert.throws(() => parseICS('BEGIN:VEVENT\nDTSTART:20260905\nSUMMARY:A\nEND:VEVENT'), /VCALENDAR/);

const persistent = store();
saveState(initial, persistent);
assert.equal(JSON.parse(persistent.data.get(STORAGE_KEY)).schemaVersion, SCHEMA_VERSION);
const restored = loadState(persistent);
assert.equal(restored.events.length, initial.events.length);
setTaskCompletion(restored, interviewTasks[0].id, true, persistent);
assert.equal(loadState(persistent).taskCompletion[interviewTasks[0].id], true);
restored.policies[0].status = 'exhausted'; saveState(restored, persistent);
assert.equal(loadState(persistent).policies[0].status, 'exhausted');
assert.equal(loadState(store({ [STORAGE_KEY]: '{bad' })).error.includes('저장'), true);
assert.equal(loadState(store({ [STORAGE_KEY]: JSON.stringify({ schemaVersion: 9 }) })).events.length, 2);
assert.equal(loadState(throwingStore()).error.includes('저장'), true);
assert.throws(() => validateState({ ...seedState(), taskCompletion: null }), /호환/);
const safeProfile = validateState({ ...seedState(), profile: null, policies: [{ id: 'interview-allowance' }] });
assert.equal(safeProfile.profile.residence, PROFILE.residence);
assert.equal(safeProfile.policies[0].title, SEED_POLICIES[0].title);
assert.equal(safeProfile.policies[0].status, 'unknown');
const sanitized = validateState({ ...seedState(), evidenceFiles: [
  { id: 'ok', name: '<unsafe>', type: 'application/pdf', size: 12, lastModified: 3, eventId: 'event-interview', hints: ['a'.repeat(300), 4, 'valid'] },
  { id: 'too-big', name: 'bad.pdf', type: 'application/pdf', size: MAX_EVIDENCE_BYTES + 1, lastModified: 3 },
] });
assert.equal(sanitized.evidenceFiles.length, 1);
assert.equal(sanitized.evidenceFiles[0].hints.length, 2);
const reset = resetState(persistent);
assert.equal(reset.events.length, 2);
assert.equal(persistent.data.has(STORAGE_KEY), true);

const crud = seedState();
const created = createEvent(crud, { ...interviewFixture, type: 'auto' });
assert.equal(created.type, 'interview');
crud.taskCompletion[`${created.id}:before:2026-09-02`] = true;
updateEvent(crud, created.id, { title: '가상 시험 일정', description: '토익 시험' });
assert.equal(crud.events.find(event => event.id === created.id).type, 'exam');
assert.equal(Object.keys(crud.taskCompletion).some(key => key.startsWith(`${created.id}:`)), false);
updateEvent(crud, created.id, { type: 'interview' });
assert.equal(crud.events.find(event => event.id === created.id).type, 'interview');
assert.equal(crud.events.find(event => event.id === created.id).classificationSource, 'user');
updateEvent(crud, created.id, { type: 'auto' });
assert.equal(crud.events.find(event => event.id === created.id).classificationSource, 'local');
crud.taskCompletion[`${created.id}:task:2026-09-01`] = true;
addEvidence(crud, { name: '면접-2026-09-05.pdf', type: 'application/pdf', size: 2048, lastModified: 1 }, created.id);
assert.throws(() => addEvidence(crud, { name: 'x.exe', type: 'application/octet-stream', size: 1 }, created.id), /지원/);
assert.throws(() => addEvidence(crud, { name: 'huge.pdf', type: 'application/pdf', size: MAX_EVIDENCE_BYTES + 1 }, created.id), /10MiB/);
assert.equal(JSON.stringify(crud).includes('bytes'), false);
deleteEvent(crud, created.id);
assert.equal(crud.events.some(event => event.id === created.id), false);
assert.equal(crud.evidenceFiles.some(file => file.eventId === created.id), false);
assert.equal(Object.keys(crud.taskCompletion).some(key => key.startsWith(`${created.id}:`)), false);
assert.throws(() => createEvent(crud, { title: '', date: 'bad' }), /제목/);

assert.equal(SEED_POLICIES.find(policy => policy.id === 'exam-support').applicationUrl, 'https://apply.jobaba.net/');
assert.equal(safeUrl('https://apply.jobaba.net/'), 'https://apply.jobaba.net/');
assert.equal(safeUrl('https://evil.example/phish'), '');

console.log('app logic tests: 82 passed');

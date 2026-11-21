// 함께봇 서버 — 기업별 계정 + Claude 전문가 봇 + 텔레그램 중계 + 사람 전문가 + 상담 토큰
// 의존성 없음. Node.js 18 이상에서 `node server.js` 로 실행합니다.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- .env 읽기 ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* .env 없음 */ }

const PORT = +process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const SESSION_DAYS = 14;
const BOTS = require('./bots');
const DOC = require('./doc');
const botById = id => BOTS.find(b => b.id === id && !b.soon);

// ---------- 저장소 (data.json) ----------
// orgs:    기업 [{id,name,mission,product,target,tone,wallet}]
// users:   기업 계정 [{id,orgId,loginId,name,salt,hash}]
// rooms:   채팅방 [{id,orgId,name,bots,humans,msgs,tgChatId,tgTitle,linkCode}]
// experts: 사람 전문가 (모든 기업이 함께 씀) [{id,name,field,desc,color,regCode,tgChatId,balance}]
// ledger:  토큰 거래 기록, sessions: 로그인 세션, dmMap: 전문가 답장 라우팅
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let S;
try { S = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
S = S || {};
if (S.rooms && !S.orgs) {
  // 이전 버전(기업 하나) 데이터를 첫 기업으로 옮김. 계정은 관리자 페이지에서 만들어야 함.
  const o = S.org || {};
  S.orgs = [{ id: 'o1', name: o.name || '기존 기업', mission: o.mission || '', product: o.product || '', target: o.target || '', tone: o.tone || '', wallet: (S.wallet && S.wallet.balance) || 0 }];
  for (const r of S.rooms) r.orgId = 'o1';
  for (const l of S.ledger || []) l.orgId = 'o1';
  delete S.org; delete S.wallet;
  console.log('이전 데이터를 "' + S.orgs[0].name + '" 기업으로 옮겼어요. 관리자 페이지에서 이 기업의 계정을 만들어 주세요.');
}
for (const k of ['orgs', 'users', 'rooms', 'experts', 'ledger']) if (!Array.isArray(S[k])) S[k] = [];
if (!S.sessions) S.sessions = {};
if (!S.dmMap) S.dmMap = {};
if (!S.expertLogins) S.expertLogins = {}; // 전문가 웹 로그인용 1회용 코드
if (!S.expertGroups) S.expertGroups = {};
if (!S.botCosts) S.botCosts = {};           // 관리자가 바꾼 봇별 요청당 토큰 {botId: n}
// 요청당 토큰: 관리자 설정 > bots.js 기본값. 'summary'는 함께봇 문서 정리
const COST_ITEMS = () => [...BOTS.filter(b => !b.soon).map(b => ({ id: b.id, name: b.name, def: b.cost || 0 })), { id: 'summary', name: '함께봇 문서 정리', def: 1 }];
const costOf = id => { const v = S.botCosts[id]; if (Number.isInteger(v)) return v; const it = COST_ITEMS().find(x => x.id === id); return it ? it.def : 0; };
// 토큰 미리 잡기 → 성공하면 기록, 실패하면 돌려줌 (동시에 여러 요청이 와도 잔액을 넘지 않게)
function reserveTokens(org, n) { if (n <= 0) return true; if (org.wallet < n) return false; org.wallet -= n; save(); return true; }
function refundTokens(org, n) { if (n > 0) { org.wallet += n; save(); emit('room', {}, org.id); } }
function chargeRecord(org, n, info) { if (n > 0) record(org, { type: 'bot', amount: n, ...info }); }   // 전문가 팀방(텔레그램 그룹) {chatId: {title, members:[expertId], roomId, list:[roomId]}}
for (const e of S.experts) {
  if (typeof e.balance !== 'number') e.balance = 0;
  if (e.rate === undefined) e.rate = null;        // 시간당 토큰 (전문가가 직접 정함)
  if (e.available === undefined) e.available = true;
  for (const k of ['career', 'hours']) if (e[k] === undefined) e[k] = '';
}
const RATE_MAX = 1000;
// 상담 시간 × 시간당 단가 → 토큰 (올림, 최소 1개)
const suggestTokens = (minutes, rate) => rate ? Math.max(1, Math.ceil(rate * minutes / 60)) : null;

let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(S, null, 1), () => {}), 300); };
const newId = p => p + crypto.randomBytes(5).toString('hex');
const code6 = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const str = (v, n) => ('' + (v == null ? '' : v)).trim().slice(0, n);
const orgById = id => S.orgs.find(o => o.id === id);
const userById = id => S.users.find(u => u.id === id);
const roomById = id => S.rooms.find(r => r.id === id);
const roomByChat = chatId => S.rooms.find(r => r.tgChatId === chatId);
const expertById = id => S.experts.find(e => e.id === id);
const expertByChat = chatId => S.experts.find(e => e.tgChatId === chatId);
const roomsOfExpert = ex => S.rooms.filter(r => (r.humans || []).includes(ex.id));
const toAmount = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 1e7 ? n : null; };
const COLORS = ['#3a86ff', '#ef476f', '#06a77d', '#8338ec', '#fb8500', '#118ab2'];

// ---------- 비밀번호·세션 ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function setPw(u, pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt); }
function checkPw(u, pw) { const h = Buffer.from(hashPw(pw, u.salt), 'hex'); return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')); }
const pwError = pw => (typeof pw !== 'string' || pw.length < 8 || pw.length > 100) ? '비밀번호는 8자 이상으로 정해 주세요' : null;
const idError = id => /^[a-z0-9._-]{3,30}$/.test(id) ? null : '아이디는 영문 소문자·숫자·.-_ 3~30자로 정해 주세요';
function newSession(data) {
  const token = crypto.randomBytes(24).toString('hex');
  S.sessions[token] = { ...data, exp: Date.now() + SESSION_DAYS * 864e5 }; save();
  return token;
}
function getSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)hb_sid=([a-f0-9]+)/);
  const s = m && S.sessions[m[1]];
  if (!s) return null;
  if (s.exp < Date.now()) { delete S.sessions[m[1]]; save(); return null; }
  if (s.kind === 'user' && !userById(s.userId)) return null;
  if (s.kind === 'expert' && !expertById(s.expertId)) return null;
  return { ...s, token: m[1] };
}
const cookie = (token, maxAge) => `hb_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
// 로그인 실패 제한: IP당 10분에 10번
const fails = new Map();
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 6e5; }
function failed(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 6e5) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; }

// ---------- 실시간 알림 (SSE) ----------
// 각 연결은 자기 기업(orgId)의 소식만 받음. 관리자는 전부 받음.
const clients = new Map();
function emit(type, data, orgId) {
  const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, c] of clients) if (c.admin || orgId === '*' || c.orgId === orgId) res.write(s);
}

function addMsg(room, m, opt = {}) {
  m.id = newId('m'); m.at = Date.now();
  room.msgs.push(m);
  if (room.msgs.length > 500) room.msgs.splice(0, room.msgs.length - 500);
  save(); emit('room', { roomId: room.id }, room.orgId);
  // 전문가 팀방이 붙어 있으면 방의 새 메시지를 팀방에도 보여 줌 (팀방에서 보낸 것은 제외)
  if (room.xg && !opt.fromTeam) tgSend(room.xg, `${msgLabel(m)}\n${m.text}`);
  return m;
}
function msgLabel(m) {
  if (m.from === 'me') return '[기업 · 웹앱]';
  if (m.from === 'tg') return `[기업 · ${m.name}]`;
  if (m.from === 'hx') return `[${m.name} 전문가]`;
  if (m.from === 'sys') return '[알림]';
  return `[${(BOTS.find(b => b.id === m.from) || {}).name || '봇'}]`;
}
// 방의 대화를 전문가들에게 1:1로 전달. 이 방에 붙은 팀방의 멤버는 팀방에서 보므로 건너뜀
function forwardToExperts(room, text) {
  const g = room.xg && S.expertGroups[room.xg];
  for (const id of room.humans || []) {
    if (g && g.members.includes(id)) continue;
    const ex = expertById(id); if (ex) dmExpert(ex, room, text);
  }
}
function record(org, entry) {
  const e = { id: newId('t'), at: Date.now(), orgId: org.id, orgName: org.name, ...entry, walletAfter: org.wallet };
  S.ledger.push(e); save(); emit('room', {}, org.id);
  return e;
}

// ---------- 기업 정보 문서 (버전 관리) ----------
// org.doc = { seq, current, versions: [{ id, n, at, by:{kind,name,id}, note, status:'approved'|'pending'|'rejected', html, basedOn }] }
function ensureDoc(org) {
  if (!org.doc) {
    org.doc = { seq: 0, current: null, versions: [] };
    addVersion(org, { html: DOC.defaultDoc(org), by: { kind: 'system', name: '함께봇' }, note: '기업 기본 정보로 처음 만든 문서', status: 'approved' }, true);
  }
  return org.doc;
}
const docCurrent = org => { const d = ensureDoc(org); return d.versions.find(v => v.id === d.current); };
const docVersion = (org, id) => ensureDoc(org).versions.find(v => v.id === id);
function addVersion(org, { html, by, note, status, basedOn }, quiet) {
  const d = org.doc;
  const v = { id: newId('v'), n: ++d.seq, at: Date.now(), by, note: str(note, 200), status, html: DOC.sanitizeHtml(html), basedOn: basedOn || d.current || null };
  d.versions.push(v);
  if (status === 'approved') d.current = v.id;
  // 오래된 기록 정리: 승인본 50개, 거절본 20개까지 보관 (현재본·대기 중인 제안은 항상 보관)
  const keep = (st, n) => { const xs = d.versions.filter(x => x.status === st && x.id !== d.current); for (const x of xs.slice(0, Math.max(0, xs.length - n))) d.versions.splice(d.versions.indexOf(x), 1); };
  keep('approved', 50); keep('rejected', 20);
  save(); if (!quiet) emit('doc', { orgId: org.id }, org.id);
  return v;
}
const docMeta = v => ({ id: v.id, n: v.n, at: v.at, by: v.by, note: v.note, status: v.status, basedOn: v.basedOn, size: v.html.length });
const docFileName = (org, v) => `${(org.name || '기업').replace(/[\\/:*?"<>|\s]+/g, '_')}_정보_v${v.n}.html`;
const byLabel = by => by.kind === 'expert' ? `${by.name} 전문가` : by.kind === 'org' ? `${by.name} (기업)` : by.name;

// 함께봇이 기업의 모든 채팅방 대화를 읽고 문서 수정안을 만듦 (기업 승인 전까지 반영 안 됨)
async function generateDocProposal(org, user) {
  const cur = docCurrent(org);
  const rooms = S.rooms.filter(r => r.orgId === org.id);
  const lines = rooms.flatMap(r => r.msgs.filter(m => m.from !== 'sys').map(m => ({ at: m.at, t: `[${r.name}] ${m.from === 'me' ? '기업(웹)' : m.from === 'tg' ? m.name + '(텔레그램)' : m.from === 'hx' ? m.name + '(사람 전문가)' : (BOTS.find(b => b.id === m.from) || {}).name || '봇'}: ${m.text.slice(0, 600)}` })))
    .sort((a, b) => a.at - b.at).slice(-80).map(x => x.t);
  if (!lines.length) return { error: '정리할 대화가 아직 없어요.' };
  let html, note;
  if (ANTHROPIC_API_KEY) {
    const system = `당신은 한국 사회적기업의 '기업 정보 문서'를 관리하는 함께봇입니다. 현재 문서와 최근 대화를 읽고 문서 전체를 갱신한 HTML 조각을 만드세요.
규칙:
- 대화나 현재 문서에 실제로 나온 사실만 적으세요. 추측·과장·지어낸 수치/인증/수상은 금지. 모르는 것은 <mark>[확인 필요: 무엇]</mark>으로 표시.
- 현재 문서의 내용은 대화가 반박하지 않는 한 유지하세요. 상충하면 새 내용으로 바꾸고 <mark>(변경: 이전 내용)</mark>을 붙이세요.
- 구성: <h1>기업명</h1>, <h2>기업 개요</h2>, <h2>소셜미션</h2>, <h2>제품·서비스</h2>, <h2>주요 고객</h2>, <h2>현재 과제·요청사항</h2>, <h2>상담에서 정해진 것</h2>(날짜·전문가 이름 포함), <h2>확인이 필요한 정보</h2>.
- 쓸 수 있는 태그: h1 h2 h3 p ul ol li b strong em mark table thead tbody tr th td blockquote br. 속성·스타일·스크립트 없이.
- HTML 조각만 출력하세요. 설명 문장이나 \`\`\` 코드 블록은 붙이지 마세요.`;
    const userMsg = `[기업 기본 정보]\n${orgText(org)}\n\n[현재 문서 v${cur.n} HTML]\n${cur.html.slice(0, 20000)}\n\n[최근 대화 (오래된 순)]\n${lines.join('\n')}`;
    const r = await callClaude(system, userMsg, 4000);
    if (r.error) return { error: r.error };
    html = r.text.replace(/^\s*\`\`\`(?:html)?\s*/i, '').replace(/\s*\`\`\`\s*$/, '');
    if (r.cut) return { error: '문서가 길어 정리가 중간에 끊겼어요. 대화를 나눠 정리하거나 직접 편집해 주세요.' };
    note = `최근 대화 ${lines.length}개를 함께봇이 정리한 수정안`;
  } else {
    // AI 키가 없으면: 현재 문서 끝에 최근 대화 기록을 붙인 안
    html = `${cur.html}<h2>최근 대화 기록 (정리 전)</h2><ul>${lines.slice(-30).map(l => `<li>${DOC.escapeHtml(l)}</li>`).join('')}</ul>`;
    note = 'AI 키가 없어 최근 대화 30개를 그대로 붙인 안';
  }
  if (!DOC.sanitizeHtml(html)) return { error: '정리 결과가 비어 있어요. 다시 시도해 주세요.' };
  return { version: addVersion(org, { html, by: { kind: 'bot', name: '함께봇', id: user.id }, note, status: 'pending', basedOn: cur.id }) };
}

// ---------- Claude ----------
function orgText(o) {
  if (!o || !o.mission && !o.product) return `기업명: ${(o && o.name) || '-'}\n그 밖의 기업 정보는 아직 입력되지 않음. 필요한 정보는 [확인 필요]로 표시하거나 짧게 질문하세요.`;
  return `기업명: ${o.name}\n소셜미션: ${o.mission || '-'}\n주요 제품·서비스: ${o.product || '-'}\n주요 고객: ${o.target || '-'}\n원하는 말투: ${o.tone || '-'}`;
}
// Claude 호출 공통. 실패하면 { error } 를 돌려줌
async function callClaude(system, user, maxTokens = 2500) {
  if (!ANTHROPIC_API_KEY) return { error: '서버에 ANTHROPIC_API_KEY가 설정되지 않아 답할 수 없어요. 관리자에게 알려 주세요.' };
  try {
    const r = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    });
    const j = await r.json();
    if (!r.ok) { console.error('Claude API 오류', r.status, j); return { error: r.status === 429 ? '요청이 많아 잠시 쉬어야 해요. 1분 뒤 다시 시도해 주세요.' : '답변을 받지 못했어요. 다시 시도해 주세요.' }; }
    return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), cut: j.stop_reason === 'max_tokens' };
  } catch (e) { console.error(e); return { error: '답변을 받지 못했어요. 네트워크를 확인해 주세요.' }; }
}
// 봇·전문가 질문에 넣을 기업 정보: 입력한 기본 정보 + 승인된 기업 정보 문서
function orgContext(org) {
  const cur = org && docCurrent(org);
  const docText = cur ? DOC.htmlToText(cur.html).slice(0, 6000) : '';
  return `${orgText(org)}${docText ? `\n\n[기업 정보 문서 v${cur.n} — 기업이 승인한 내용]\n${docText}` : ''}`;
}
async function askClaude(bot, room, text) {
  if (!ANTHROPIC_API_KEY) return { error: '서버에 ANTHROPIC_API_KEY가 설정되지 않아 답할 수 없어요. 관리자에게 알려 주세요.' };
  const hist = room.msgs.slice(-14, -1).map(m => {
    const who = m.from === 'me' ? '사용자(웹)' : m.from === 'tg' ? `${m.name}(텔레그램)` : m.from === 'hx' ? `${m.name}(사람 전문가)` : m.from === 'sys' ? null : (BOTS.find(b => b.id === m.from) || {}).name;
    return who ? `${who}: ${m.text.slice(0, 1500)}` : null;
  }).filter(Boolean).join('\n\n');
  const system = `${bot.role}\n\n[우리 기업]\n${orgContext(orgById(room.orgId))}\n\n한국어로 답하세요. 서식은 굵게(**)와 줄바꿈만 쓰세요.`;
  const user = `[이 채팅방의 최근 대화]\n${hist || '(없음)'}\n\n[이번 요청]\n${text}`;
  const r = await callClaude(system, user);
  if (r.error) return { error: r.error };
  return { text: r.text + (r.cut ? '\n\n(답변이 길어 중간에 끊겼어요. "이어서"라고 보내 주세요.)' : '') };
}
// 봇 실행: 토큰을 먼저 잡고 → 답을 받으면 사용 기록, 실패하면 돌려줌
async function runBot(room, botId, text) {
  const bot = botById(botId);
  if (!bot) return;
  const org = orgById(room.orgId), cost = costOf(bot.id);
  const say = (t, extra = {}) => { addMsg(room, { from: bot.id, text: t, ...extra }); if (room.tgChatId) tgSend(room.tgChatId, `[${bot.name}]\n${extra.tgText || t}`); };
  if (!ANTHROPIC_API_KEY) return say('서버에 ANTHROPIC_API_KEY가 설정되지 않아 답할 수 없어요. 관리자에게 알려 주세요.');
  if (!reserveTokens(org, cost)) {
    addMsg(room, { from: 'sys', text: `${bot.name}은(는) 요청당 ${cost}토큰을 써요. 지금 잔액(${org.wallet}토큰)이 부족해서 요청하지 않았어요. 관리자에게 충전을 요청해 주세요.` });
    if (room.tgChatId) tgSend(room.tgChatId, `${bot.name}: 토큰 잔액이 부족해요 (필요 ${cost}, 잔액 ${org.wallet}).`);
    return;
  }
  emit('typing', { roomId: room.id, botId }, room.orgId);
  if (room.tgChatId) tg('sendChatAction', { chat_id: room.tgChatId, action: 'typing' });
  const r = bot.kind === 'site' ? await runSiteBot(bot, room, org, text) : await askClaude(bot, room, text);
  if (r.error) { refundTokens(org, cost); return say(`${r.error}${cost ? ' (토큰은 쓰지 않았어요)' : ''}`); }
  chargeRecord(org, cost, { botId: bot.id, botName: bot.name, roomId: room.id, roomName: room.name });
  say(r.text, { cost, ...(r.site ? { site: r.site, tgText: r.tgText } : {}) });
}

// ---------- 홈페이지 봇 · 랜딩페이지 ----------
// org.site = { slug, seq, published, versions: [{ id, n, at, html, note, by, request }] }
const RESERVED_SLUGS = new Set(['api', 'admin', 'expert', 's', 'site', 'static', 'public', 'login', 'logout', 'www', 'help', 'about', 'hamkkebot']);
const slugError = v => !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(v) ? '주소는 영문 소문자·숫자·하이픈 3~40자로 정해 주세요 (처음과 끝은 하이픈 불가)' : RESERVED_SLUGS.has(v) ? '쓸 수 없는 주소예요' : null;
const ensureSite = org => org.site || (org.site = { slug: null, seq: 0, published: null, versions: [] });
const siteVersion = (org, id) => ensureSite(org).versions.find(v => v.id === id);
const siteUrl = slug => `${PUBLIC_URL ? PUBLIC_URL.replace(/\/$/, '') : ''}/s/${slug}`;
const siteFileName = (org, v) => `${(org.name || '기업').replace(/[\\/:*?"<>|\s]+/g, '_')}_홈페이지_v${v.n}.html`;
// 공개·미리보기 페이지에 붙이는 보안 헤더: sandbox로 별도 출처 취급, 스크립트·외부 리소스 차단
const SITE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
};
async function runSiteBot(bot, room, org, text) {
  const site = ensureSite(org);
  const draft = site.versions[site.versions.length - 1];
  const docV = docCurrent(org);
  const user = `${draft ? `[지금까지 만든 페이지 v${draft.n} — 수정 요청이면 이것을 바탕으로]\n${draft.html.slice(0, 60000)}\n\n` : ''}[이번 요청]\n${text}`;
  const r = await callClaude(`${bot.role}\n\n[우리 기업]\n${orgContext(org)}`, user, 12000);
  if (r.error) return { error: r.error };
  if (r.cut) return { error: '페이지가 길어 만들다 끊겼어요. 섹션을 줄여 달라고 다시 요청해 주세요.' };
  const [rawHtml, memo = ''] = r.text.split(/^\s*-{3}\s*메모\s*-{3}\s*$/m);
  const html = DOC.sanitizePage(rawHtml.replace(/^\s*\`\`\`(?:html)?\s*/i, '').replace(/\s*\`\`\`\s*$/, ''));
  if (!html) return { error: '페이지를 만들지 못했어요 (완성된 HTML 문서가 오지 않았어요). 다시 요청해 주세요.' };
  const v = { id: newId('w'), n: ++site.seq, at: Date.now(), html, note: str(memo.trim(), 600), request: str(text, 200), docN: docV.n, by: bot.id };
  site.versions.push(v);
  if (site.versions.length > 20) site.versions.splice(0, site.versions.length - 20).forEach(x => { if (x.id === site.published) site.versions.unshift(x); });
  save();
  const title = DOC.pageTitle(html);
  return {
    text: `랜딩페이지 v${v.n}을 만들었어요${title ? ` — "${title}"` : ''}. (기업 정보 문서 v${docV.n} 기준)\n아래 "미리보기"로 확인하고, 괜찮으면 "게시하기"를 눌러야 공개돼요.${v.note ? `\n\n**확인할 것**\n${v.note}` : ''}`,
    site: { versionId: v.id, n: v.n },
    tgText: `랜딩페이지 v${v.n}을 만들었어요. 미리보기와 게시는 웹앱 채팅방에서 할 수 있어요.${v.note ? '\n확인할 것: ' + v.note : ''}`
  };
}
// 게시 직후 서버가 공개 주소에 직접 접속해 보는 '등록 확인'
function selfCheck(slug) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port: PORT, path: `/s/${encodeURIComponent(slug)}`, timeout: 5000 }, res => {
      let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.byteLength(d), ms: Date.now() - t0, title: DOC.pageTitle(d), csp: /sandbox/.test(res.headers['content-security-policy'] || ''), noScript: !/<script/i.test(d) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: '시간 초과' }); });
    req.on('error', e => resolve({ status: 0, error: e.message }));
  });
}

// ---------- 텔레그램 ----------
let tgUsername = '';
async function tg(method, body) {
  if (!TG_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const j = await r.json();
    if (!j.ok) console.error('Telegram 오류', method, j.description);
    return j;
  } catch (e) { console.error('Telegram 연결 실패', method, e.message); return null; }
}
async function tgSend(chatId, text) {
  const plain = text.replace(/\*\*(.+?)\*\*/g, '$1');
  for (let i = 0; i < plain.length; i += 4000) await tg('sendMessage', { chat_id: chatId, text: plain.slice(i, i + 4000) });
}

// 텔레그램으로 파일 보내기 (multipart). 성공하면 message_id
async function tgSendDoc(chatId, filename, content, caption) {
  if (!TG_TOKEN) return null;
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', caption.slice(0, 1000));
    fd.append('document', new Blob([content], { type: 'text/html' }), filename);
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!j.ok) { console.error('Telegram 오류 sendDocument', j.description); return null; }
    return j.result.message_id;
  } catch (e) { console.error('Telegram 파일 전송 실패', e.message); return null; }
}
// 텔레그램에 올라온 파일 내려받기 (최대 1MB)
async function tgDownload(fileId) {
  const j = await tg('getFile', { file_id: fileId });
  if (!j || !j.ok || !j.result.file_path) return { error: '파일을 받을 수 없어요. 다시 올려 주세요.' };
  if (j.result.file_size > 1024 * 1024) return { error: '파일이 너무 커요 (1MB까지).' };
  try {
    const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${j.result.file_path}`);
    if (!r.ok) return { error: '파일을 받을 수 없어요. 다시 올려 주세요.' };
    return { text: await r.text() };
  } catch (e) { return { error: '파일을 받을 수 없어요. 네트워크를 확인해 주세요.' }; }
}

// ---------- 전문가가 기업 정보 문서 보기·묻기·고쳐 올리기 ----------
// 상담 중인 기업의 문서만 다룰 수 있음. where: 답장할 대화(1:1 또는 팀방)의 chat id
function docTargetRoom(ex, msg, arg, teamRoom) {
  const active = roomsOfExpert(ex);
  const mapped = msg.reply_to_message && S.dmMap[`${msg.chat.id}:${msg.reply_to_message.message_id}`];
  const n = parseInt(arg, 10);
  const room = (mapped && roomById(mapped)) || (teamRoom && active.includes(teamRoom) ? teamRoom : null) || (n > 0 ? active[n - 1] : null) || (active.length === 1 ? active[0] : null);
  if (!room) return { error: active.length ? `상담이 ${active.length}개예요. /rooms 의 번호를 붙여 주세요 (예: /info 2), 또는 그 기업 메시지에 답장으로 보내 주세요.` : '진행 중인 상담이 없어요. 기업 정보 문서는 상담 중에만 볼 수 있어요.' };
  if (!active.includes(room)) return { error: '이미 종료된 상담이에요. 기업 정보 문서는 상담 중에만 다룰 수 있어요.' };
  return { room, org: orgById(room.orgId) };
}
async function sendDocToExpert(ex, msg, arg, teamRoom) {
  const t = docTargetRoom(ex, msg, arg, teamRoom); if (t.error) return tgSend(msg.chat.id, t.error);
  const cur = docCurrent(t.org);
  const caption = `${t.org.name} 기업 정보 문서 v${cur.n} (${new Date(cur.at).toLocaleDateString('ko-KR')} · ${byLabel(cur.by)})\n고칠 내용이 있으면 이 파일을 수정해서 이 대화에 다시 올려 주세요. 파일 설명(캡션)에 바꾼 이유를 적으면 기업에 함께 보여요. 기업이 확인하고 승인하면 반영돼요.`;
  const id = await tgSendDoc(msg.chat.id, docFileName(t.org, cur), DOC.wrapDocument(`${t.org.name} 기업 정보`, cur.html, `v${cur.n}`), caption);
  if (!id) return tgSend(msg.chat.id, '파일을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  S.dmMap[`${msg.chat.id}:${id}`] = t.room.id;
  (S.docSent = S.docSent || {})[`${msg.chat.id}:${id}`] = cur.id; save();
}
async function receiveDocFromExpert(ex, msg, teamRoom) {
  const d = msg.document;
  if (!/\.html?$/i.test(d.file_name || '') && d.mime_type !== 'text/html') return tgSend(msg.chat.id, 'HTML 파일(.html)만 올릴 수 있어요. /info 로 받은 파일을 고쳐서 올려 주세요.');
  const t = docTargetRoom(ex, msg, (msg.caption || '').match(/^\s*(\d+)\b/)?.[1], teamRoom); if (t.error) return tgSend(msg.chat.id, t.error);
  const f = await tgDownload(d.file_id); if (f.error) return tgSend(msg.chat.id, f.error);
  const html = DOC.sanitizeHtml(f.text);
  if (!html) return tgSend(msg.chat.id, '파일에서 문서 내용을 찾지 못했어요. 내용이 <body> 안에 있는지 확인해 주세요.');
  const cur = docCurrent(t.org);
  if (html === cur.html) return tgSend(msg.chat.id, '현재 문서와 내용이 같아요. 고친 부분이 없는 것 같아요.');
  const sentKey = msg.reply_to_message && `${msg.chat.id}:${msg.reply_to_message.message_id}`;
  const basedOn = (sentKey && S.docSent && S.docSent[sentKey]) || cur.id;
  const note = str((msg.caption || '').replace(/^\s*\d+\s*/, ''), 200);
  const v = addVersion(t.org, { html, by: { kind: 'expert', name: ex.name, id: ex.id }, note: note || '전문가 수정안', status: 'pending', basedOn });
  addMsg(t.room, { from: 'sys', text: `${ex.name} 전문가가 기업 정보 문서 수정안(v${v.n})을 올렸어요. "기업 정보 문서"에서 확인하고 승인하면 반영돼요.${note ? ' 메모: ' + note : ''}` });
  const stale = basedOn !== cur.id ? ` 참고: v${(docVersion(t.org, basedOn) || {}).n || '?'}를 바탕으로 고친 안인데, 그사이 문서가 v${cur.n}으로 바뀌었어요. 기업이 비교해서 판단해요.` : '';
  return tgSend(msg.chat.id, `"${roomLabel(t.room)}"에 기업 정보 문서 수정안 v${v.n}을 올렸어요. 기업이 승인하면 알려 드릴게요.${stale}`);
}
async function answerAboutOrg(ex, msg, arg, teamRoom) {
  const q = arg.replace(/^\d+\s*/, '').trim();
  if (!q) return tgSend(msg.chat.id, '물어볼 내용을 적어 주세요. 예: /ask 이 기업의 주요 고객은?');
  const t = docTargetRoom(ex, msg, arg, teamRoom); if (t.error) return tgSend(msg.chat.id, t.error);
  const system = `당신은 함께봇입니다. 사람 전문가가 상담 중인 기업에 대해 묻습니다. 아래 기업 정보와 이 상담방의 최근 대화에 있는 내용만으로 답하세요. 없는 내용은 "기업 정보 문서에 없어요"라고 말하고, 기업에 직접 물어보라고 권하세요. 추측하지 마세요. 짧게, 한국어로, 서식 없이.`;
  const hist = t.room.msgs.filter(m => m.from !== 'sys').slice(-20).map(m => `${m.from === 'me' ? '기업' : m.name || (BOTS.find(b => b.id === m.from) || {}).name || '봇'}: ${m.text.slice(0, 500)}`).join('\n');
  const r = await callClaude(system, `[기업 정보]\n${orgContext(t.org)}\n\n[상담방 최근 대화]\n${hist || '(없음)'}\n\n[전문가 질문]\n${q}`, 1200);
  return tgSend(msg.chat.id, r.error ? `${r.error}\n/info 로 기업 정보 문서를 받아 직접 볼 수 있어요.` : `[${t.org.name} 정보 · 함께봇]\n${r.text}`);
}

// ---------- 사람 전문가 ----------
// buttons: [[{text, callback_data}]] — 마지막 메시지 조각에 텔레그램 버튼을 붙임. 성공하면 마지막 message_id 반환
async function dmExpert(ex, room, text, buttons) {
  if (!ex.tgChatId) return false;
  const org = orgById(room.orgId) || {};
  const plain = `[${org.name || '기업'} · ${room.name}]\n${text}`.replace(/\*\*(.+?)\*\*/g, '$1');
  let ok = false;
  for (let i = 0; i < plain.length; i += 4000) {
    const last = i + 4000 >= plain.length;
    const j = await tg('sendMessage', { chat_id: ex.tgChatId, text: plain.slice(i, i + 4000), ...(last && buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
    if (j && j.ok) { ok = j.result.message_id; S.dmMap[`${ex.tgChatId}:${j.result.message_id}`] = room.id; }
  }
  const keys = Object.keys(S.dmMap); if (keys.length > 5000) for (const k of keys.slice(0, 2000)) delete S.dmMap[k];
  save();
  return ok;
}
async function callExpert(room, ex, question, opt = {}) {
  room.humans = room.humans || [];
  const fresh = !room.humans.includes(ex.id);
  if (fresh) {
    room.humans.push(ex.id);
    room.consults = room.consults || {};
    // 단가는 상담이 시작되는 순간 고정. 잔액 부족을 알고 수락한 상담은 '잔액 소진' 경고를 다시 보내지 않음
    room.consults[ex.id] = { startAt: Date.now(), rate: opt.rate || ex.rate, warned: !!opt.accepted };
    addMsg(room, { from: 'sys', text: opt.joined ? `승인에 따라 ${ex.name} 전문가가 상담에 참여했어요 (시간당 ${opt.rate}토큰)` : opt.accepted ? `${ex.name} 전문가가 잔액이 부족한 것을 확인하고 상담을 수락했어요 (시간당 ${opt.rate || ex.rate}토큰)` : `${ex.name} 전문가를 호출했어요 (시간당 ${ex.rate}토큰)` });
  }
  if (opt.joined) {
    const org = orgById(room.orgId) || {};
    const low = org.wallet < opt.rate ? `\n주의: 이 기업의 잔액은 ${org.wallet}토큰으로 1시간 단가보다 적어요 (약 ${fmtMin(coverMinutes(org.wallet, opt.rate))} 상담분).` : '';
    const text = `기업이 ${ex.name}님의 참여를 승인했어요. 지금부터 상담 시간이 계산돼요 (시간당 ${opt.rate}토큰).${low}\n팀방에서 /send 로 기업에 보낼 수 있어요. 마칠 때는 /end`;
    const g = room.xg && S.expertGroups[room.xg];
    if (g && g.members.includes(ex.id)) tgSend(room.xg, text); else dmExpert(ex, room, text);
    return;
  }
  if (opt.accepted) {
    const ok = await dmExpert(ex, room, `상담을 시작했어요. 위 요청 메시지나 이 메시지에 "답장"하면 기업 채팅방에 전달돼요. 상담을 마치려면 /end`);
    if (!ok) addMsg(room, { from: 'sys', text: `${ex.name} 전문가에게 텔레그램 메시지를 보내지 못했어요` });
    return;
  }
  if (question) addMsg(room, { from: 'me', text: question });
  const o = orgById(room.orgId) || {};
  const intro = fresh ? `상담 요청이 왔어요. (시간당 ${ex.rate}토큰)\n기업: ${o.name || '-'}${o.mission ? '\n소셜미션: ' + o.mission : ''}\n\n` : '';
  const ok = await dmExpert(ex, room, `${intro}${question || '상담을 요청했어요. 이 메시지에 답장해 주세요.'}\n\n— 이 메시지에 "답장"하면 기업 채팅방에 전달돼요. 상담을 마치려면 /end`);
  if (!ok) addMsg(room, { from: 'sys', text: `${ex.name} 전문가에게 텔레그램 메시지를 보내지 못했어요` });
}
// ---------- 잔액 부족 시: 전문가에게 먼저 묻기 ----------
// room.pending = [{id, expertId, at, rate, msgId}] — 전문가가 수락하면 상담 시작, 사양하면 기업에 알림
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ' ' + (m % 60) + '분' : ''}` : `${m}분`;
const coverMinutes = (wallet, rate) => rate ? Math.floor(wallet / rate * 60) : 0;
async function requestCall(room, ex, question) {
  room.pending = room.pending || [];
  if (room.pending.some(p => p.expertId === ex.id)) return '이미 이 전문가의 수락을 기다리고 있어요';
  const org = orgById(room.orgId) || {};
  const req = { id: newId('q'), expertId: ex.id, at: Date.now(), rate: ex.rate };
  room.pending.push(req);
  addMsg(room, { from: 'sys', text: `잔액(${org.wallet}토큰)이 ${ex.name} 전문가의 1시간 단가(${ex.rate}토큰)보다 적어서, 먼저 전문가에게 수락 여부를 물었어요` });
  if (question) addMsg(room, { from: 'me', text: question });
  const cover = coverMinutes(org.wallet, ex.rate);
  const msgId = await dmExpert(ex, room,
    `상담 요청 — 잔액 부족 주의\n` +
    `이 기업의 상담 토큰 잔액은 ${org.wallet}개로, 시간당 단가 ${ex.rate}토큰보다 적어요.` +
    (org.wallet > 0 ? ` 잔액으로는 약 ${fmtMin(cover)} 상담분만 보낼 수 있어요.` : ' 지금은 토큰을 받을 수 없어요.') +
    `\n상담이 끝난 뒤 토큰을 다 받지 못할 수 있어요. 기업이 충전한 뒤 나중에 보낼 수는 있어요.\n\n` +
    `기업: ${org.name || '-'}${org.mission ? '\n소셜미션: ' + org.mission : ''}\n\n${question || '(질문 없이 상담 요청)'}\n\n그래도 상담하시겠어요?`,
    [[{ text: '수락하고 상담하기', callback_data: 'a:' + req.id }, { text: '이번엔 사양', callback_data: 'd:' + req.id }]]);
  if (!msgId) { room.pending = room.pending.filter(p => p !== req); addMsg(room, { from: 'sys', text: `${ex.name} 전문가에게 텔레그램 메시지를 보내지 못했어요` }); return null; }
  req.msgId = msgId; save(); emit('room', { roomId: room.id }, room.orgId);
  return null;
}
function findRequest(reqId) {
  for (const r of S.rooms) { const q = (r.pending || []).find(p => p.id === reqId); if (q) return { room: r, req: q }; }
  return null;
}
async function answerRequest(ex, reqId, accept) {
  const f = findRequest(reqId);
  if (!f || f.req.expertId !== ex.id) return '이미 처리됐거나 취소된 요청이에요.';
  const { room, req } = f;
  room.pending = room.pending.filter(p => p !== req);
  if (req.msgId) tg('editMessageReplyMarkup', { chat_id: ex.tgChatId, message_id: req.msgId, reply_markup: { inline_keyboard: [] } });
  if (accept) { await callExpert(room, ex, '', { accepted: true, rate: req.rate }); return `"${roomLabel(room)}" 상담을 수락했어요.`; }
  addMsg(room, { from: 'sys', text: `${ex.name} 전문가가 이번 상담을 사양했어요. 토큰을 충전한 뒤 다시 호출하거나 다른 전문가를 찾아 주세요.` });
  return `"${roomLabel(room)}" 요청을 사양했어요.`;
}
async function handleCallback(cq) {
  const ex = expertByChat(cq.message && cq.message.chat.id);
  const [kind, id] = String(cq.data || '').split(':');
  let text = '처리할 수 없는 버튼이에요.';
  if (ex && (kind === 'a' || kind === 'd')) text = await answerRequest(ex, id, kind === 'a');
  else if (ex && kind === 'k') { // 잔액 소진 경고에서 '계속하기'
    const room = roomById(id); if (room && room.consults && room.consults[ex.id]) text = '계속 상담해요. 끝나면 /end';
    tg('editMessageReplyMarkup', { chat_id: ex.tgChatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  } else if (ex && kind === 'e') { // 잔액 소진 경고에서 '여기서 마치기'
    const room = roomById(id);
    tg('editMessageReplyMarkup', { chat_id: ex.tgChatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (room && (room.humans || []).includes(ex.id)) { await endConsult(room, ex, '전문가'); text = `"${roomLabel(room)}" 상담을 마쳤어요.`; }
    else text = '이미 종료된 상담이에요.';
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  if (cq.message) tgSend(cq.message.chat.id, text);
}
// 1분마다: 상담 중 '시간 × 단가'가 기업 잔액에 닿으면 전문가에게 한 번 알리고 계속할지 고르게 함
function checkBalances() {
  for (const room of S.rooms) for (const [exId, c] of Object.entries(room.consults || {})) {
    if (c.warned) continue;
    const org = orgById(room.orgId), ex = expertById(exId); if (!org || !ex) continue;
    const minutes = Math.round((Date.now() - c.startAt) / 60000);
    if (minutes < 1 || suggestTokens(minutes, c.rate) < org.wallet) continue;
    c.warned = true; save();
    addMsg(room, { from: 'sys', text: `상담 ${minutes}분이 지나 계산 토큰이 잔액(${org.wallet}개)에 닿았어요. ${ex.name} 전문가에게 알렸어요.` });
    dmExpert(ex, room, `알림: 상담 ${minutes}분이 지나 단가 기준 토큰이 이 기업의 잔액(${org.wallet}개)에 닿았어요. 이후 시간은 토큰을 받지 못할 수 있어요.\n계속할지 정해 주세요.`,
      [[{ text: '계속하기', callback_data: 'k:' + room.id }, { text: '여기서 마치기', callback_data: 'e:' + room.id }]]);
  }
}
setInterval(checkBalances, 60000).unref();
module.exports = { checkBalances }; // 테스트용

async function endConsult(room, ex, by) {
  room.humans = (room.humans || []).filter(id => id !== ex.id);
  const g = room.xg && S.expertGroups[room.xg];
  if (g && !room.humans.some(id => g.members.includes(id))) setTimeout(() => detachTeam(room, '팀방 전문가의 상담이 모두 끝나서'), 0);
  const c = (room.consults || {})[ex.id] || { startAt: Date.now(), rate: ex.rate };
  if (room.consults) delete room.consults[ex.id];
  const minutes = Math.max(1, Math.round((Date.now() - c.startAt) / 60000));
  const suggested = suggestTokens(minutes, c.rate);
  // pay: 이 메시지에 '토큰 보내기' 카드가 붙고, 한 번 처리하면 paid에 수량이 기록됨
  addMsg(room, { from: 'sys', text: `${ex.name} 전문가와의 상담이 종료됐어요${by ? ' (' + by + ')' : ''} · 상담 ${minutes}분`, pay: { expertId: ex.id, paid: null, minutes, rate: c.rate, suggested } });
  if (by !== '전문가') dmExpert(ex, room, `기업이 상담을 종료했어요. 상담 ${minutes}분 · 단가 기준 ${suggested}토큰. 기업이 토큰을 보내면 알려 드릴게요.`);
}
const roomLabel = r => `${(orgById(r.orgId) || {}).name || '기업'} · ${r.name}`;
async function handleExpertDM(ex, msg, cmd) {
  const active = roomsOfExpert(ex);
  const mapped = msg.reply_to_message && S.dmMap[`${msg.chat.id}:${msg.reply_to_message.message_id}`];
  const room = (mapped && roomById(mapped)) || (active.length === 1 ? active[0] : null);
  if (cmd === 'end') {
    if (!room) return tgSend(msg.chat.id, active.length ? '어느 상담을 마칠지 모르겠어요. 해당 기업 메시지에 답장으로 /end 를 보내 주세요.' : '진행 중인 상담이 없어요.');
    if (!active.includes(room)) return tgSend(msg.chat.id, '이미 종료된 상담이에요.');
    await endConsult(room, ex, '전문가');
    return tgSend(msg.chat.id, `"${roomLabel(room)}" 상담을 마쳤어요. 기업이 토큰을 보내면 알려 드릴게요.`);
  }
  if (cmd === 'balance') return tgSend(msg.chat.id, `받은 상담 토큰 잔액: ${ex.balance}개\n정산은 운영자에게 문의해 주세요.`);
  if (cmd === 'accept' || cmd === 'decline') {
    const mine = S.rooms.flatMap(r => (r.pending || []).filter(p => p.expertId === ex.id).map(p => ({ r, p })));
    const pick = (mapped && mine.find(x => x.r.id === mapped)) || (mine.length === 1 ? mine[0] : null);
    if (!pick) return tgSend(msg.chat.id, mine.length ? '여러 요청이 기다리고 있어요. 해당 요청 메시지의 버튼을 눌러 주세요.' : '기다리는 상담 요청이 없어요.');
    return tgSend(msg.chat.id, await answerRequest(ex, pick.p.id, cmd === 'accept'));
  }
  if (cmd === 'login') {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    for (const k in S.expertLogins) if (S.expertLogins[k].expertId === ex.id || S.expertLogins[k].exp < Date.now()) delete S.expertLogins[k];
    S.expertLogins[code] = { expertId: ex.id, exp: Date.now() + 10 * 60000 }; save();
    const link = PUBLIC_URL ? `\n${PUBLIC_URL.replace(/\/$/, '')}/expert?code=${code}` : '';
    return tgSend(msg.chat.id, `전문가 프로필 페이지 로그인 코드: ${code}\n10분 안에 웹의 /expert 페이지에 입력해 주세요.${link}\n(이 코드는 다른 사람에게 알려 주지 마세요)`);
  }
  if (cmd === 'rate') {
    const n = Number(msg.text.split(/\s+/)[1]);
    if (!Number.isInteger(n) || n < 1 || n > RATE_MAX) return tgSend(msg.chat.id, `시간당 토큰을 1~${RATE_MAX} 사이 정수로 적어 주세요. 예: /rate 5`);
    ex.rate = n; save(); emit('room', {}, '*');
    return tgSend(msg.chat.id, `시간당 ${n}토큰으로 정했어요. 진행 중인 상담은 호출 때 단가가 그대로 적용돼요.`);
  }
  if (cmd === 'off' || cmd === 'on') {
    ex.available = cmd === 'on'; save(); emit('room', {}, '*');
    return tgSend(msg.chat.id, ex.available ? '이제 기업이 호출할 수 있어요.' : '상담 받기를 잠시 껐어요. 기업 목록에 "지금은 상담 불가"로 보여요. 다시 켜려면 /on');
  }
  if (cmd === 'rooms') return tgSend(msg.chat.id, active.length ? '진행 중인 상담\n' + active.map((r, i) => `${i + 1}. ${roomLabel(r)}`).join('\n') + '\n\n/info 번호 로 그 기업의 정보 문서를 받을 수 있어요.' : '진행 중인 상담이 없어요.');
  if (cmd === 'info') return sendDocToExpert(ex, msg, msg.text.split(/\s+/)[1] || '');
  if (cmd === 'ask') return answerAboutOrg(ex, msg, msg.text.replace(/^\/ask(@\w+)?\s*/i, ''));
  if (!room) return tgSend(msg.chat.id, active.length ? `진행 중인 상담이 ${active.length}개예요. 답할 기업의 메시지를 길게 눌러 "답장"으로 보내 주세요.` : '진행 중인 상담이 없어요. 기업이 호출하면 여기로 메시지가 와요.');
  if (!active.includes(room)) {
    if ((room.pending || []).some(p => p.expertId === ex.id)) return tgSend(msg.chat.id, '아직 수락하지 않은 요청이에요. 요청 메시지의 "수락하고 상담하기" 버튼을 먼저 눌러 주세요.');
    return tgSend(msg.chat.id, '이미 종료된 상담이에요.');
  }
  addMsg(room, { from: 'hx', expertId: ex.id, name: ex.name, text: msg.text });
  if (room.tgChatId) tgSend(room.tgChatId, `[${ex.name} 전문가]\n${msg.text}`);
}

// ---------- 전문가 팀방 ----------
// 전문가 여럿이 들어 있는 텔레그램 그룹. 일반 대화는 전문가끼리만 보고(기업에 안 감), 명령으로 기업 방에 전달.
const TEAM_HELP = `전문가 팀방 사용법
이 방의 일반 대화는 전문가끼리만 보여요. 기업에는 아래 명령으로 보낸 내용만 전달돼요.
/rooms — 팀방 전문가들이 맡은 상담 목록
/use 번호 — 그 상담을 이 팀방에 연결 (기업 방의 새 메시지가 여기 보임)
/send 내용 — 연결된 상담의 기업에게 보내기 (/s 로 줄여 써도 돼요)
   다른 메시지에 "답장"으로 /send 를 보내면 그 메시지 내용을 보내요
/info — 연결된 기업의 정보 문서(HTML) 받기 · 고친 파일을 여기 올리면 기업이 확인 후 반영
/ask 질문 — 기업 정보 문서를 바탕으로 함께봇에게 묻기
/join 하고 싶은 말 — 호출되지 않은 상담에 참여 요청 (기업이 승인하면 참여)
   /join 번호 하고 싶은 말 — /rooms 목록의 다른 상담에 요청
/end — 내 상담 종료
/detach — 연결 해제
기업에 보낼 수 있는 사람은 그 상담에 호출됐거나 참여 승인을 받은 전문가뿐이에요.`;
const teamRooms = g => S.rooms.filter(r => (r.humans || []).some(id => g.members.includes(id)));
function detachTeam(room, why) {
  const gid = room.xg; if (!gid) return;
  room.xg = null;
  const g = S.expertGroups[gid]; if (g && g.roomId === room.id) g.roomId = null;
  save();
  addMsg(room, { from: 'sys', text: '전문가 팀방 연결이 해제됐어요' });
  tgSend(gid, `${why ? why + ' ' : ''}"${roomLabel(room)}" 연결을 해제했어요.`);
}
async function handleTeam(msg, ex, cmd, arg) {
  const chat = msg.chat;
  const g = S.expertGroups[chat.id] || (S.expertGroups[chat.id] = { title: chat.title || '전문가 팀방', members: [], roomId: null, list: [] });
  if (!ex) { if (cmd) tgSend(chat.id, '전문가 팀방이에요. 등록된 전문가만 명령을 쓸 수 있어요.'); return; }
  if (!g.members.includes(ex.id)) { g.members.push(ex.id); save(); }
  if (!cmd) return; // 전문가끼리의 대화는 기업에 보내지 않음
  const room = g.roomId && roomById(g.roomId);
  const active = r => r && (r.humans || []).includes(ex.id);

  if (cmd === 'team' || cmd === 'help' || cmd === 'start') return tgSend(chat.id, `${ex.name}님을 팀방 멤버로 등록했어요.\n\n${TEAM_HELP}`);
  if (cmd === 'rooms') {
    const list = teamRooms(g); g.list = list.map(r => r.id); save();
    if (!list.length) return tgSend(chat.id, '팀방 전문가들이 맡은 상담이 없어요. 기업이 전문가를 호출하면 여기에 보여요.');
    return tgSend(chat.id, '진행 중인 상담\n' + list.map((r, i) => `${i + 1}. ${roomLabel(r)} — ${(r.humans || []).map(id => (expertById(id) || {}).name).filter(Boolean).join(', ')}${r.id === g.roomId ? ' (연결됨)' : ''}`).join('\n') + '\n\n/use 번호 로 연결하세요.');
  }
  if (cmd === 'use') {
    const n = parseInt(arg, 10), target = roomById(g.list[n - 1]);
    if (!target) return tgSend(chat.id, '번호가 맞지 않아요. 먼저 /rooms 로 목록을 확인해 주세요.');
    if (!active(target)) return tgSend(chat.id, '내가 호출된 상담만 연결할 수 있어요.');
    if (target.tgChatId === chat.id) return tgSend(chat.id, '이 그룹은 기업 방과 연결된 그룹이라 팀방으로 쓸 수 없어요.');
    if (room && room !== target) detachTeam(room);
    if (target.xg && target.xg !== chat.id) detachTeam(target, '다른 팀방이 이 상담을 연결해서');
    target.xg = chat.id; g.roomId = target.id; save();
    addMsg(target, { from: 'sys', text: `전문가 팀방(텔레그램 "${g.title}")이 이 상담에 연결됐어요. 팀방의 전문가들이 이 방의 대화를 함께 보고 의논한 뒤 답해요.` }, { fromTeam: true });
    const recent = target.msgs.filter(m => m.from !== 'sys').slice(-5).map(m => `${msgLabel(m)} ${m.text.slice(0, 300)}`).join('\n\n');
    return tgSend(chat.id, `"${roomLabel(target)}" 상담을 연결했어요. 이제 기업 방의 새 메시지가 여기 보여요.\n\n최근 대화\n${recent || '(없음)'}\n\n기업에 보내려면 /send 내용`);
  }
  if (cmd === 'detach') { if (!room) return tgSend(chat.id, '연결된 상담이 없어요.'); return detachTeam(room); }
  if (cmd === 'info') return sendDocToExpert(ex, msg, arg, room);
  if (cmd === 'ask') return answerAboutOrg(ex, msg, arg, room);
  if (cmd === 'join') {
    // /join [번호] [하고 싶은 말] — 번호가 없으면 이 팀방에 연결된 상담
    const m = arg.match(/^(\d+)\s*([\s\S]*)$/);
    const target = m ? roomById(g.list[parseInt(m[1], 10) - 1]) : room;
    const note = str(m ? m[2] : arg, 300);
    if (!target) return tgSend(chat.id, m ? '번호가 맞지 않아요. 먼저 /rooms 로 목록을 확인해 주세요.' : '연결된 상담이 없어요. /rooms 로 번호를 확인한 뒤 /join 번호 로 요청해 주세요.');
    if (active(target)) return tgSend(chat.id, '이미 이 상담에 참여하고 있어요.');
    if (!ex.rate) return tgSend(chat.id, '시간당 토큰을 먼저 정해 주세요. 1:1 대화에서 /rate 숫자 또는 /login');
    if (!ex.available) return tgSend(chat.id, '상담 받기가 꺼져 있어요. 1:1 대화에서 /on 으로 켠 뒤 요청해 주세요.');
    if (target.msgs.some(x => x.join && x.join.expertId === ex.id && !x.join.status)) return tgSend(chat.id, '이미 참여 요청을 보냈어요. 기업의 답을 기다려 주세요.');
    addMsg(target, { from: 'sys', text: `${ex.name} 전문가(${ex.field})가 이 상담에 참여하고 싶어 해요. 승인하면 시간당 ${ex.rate}토큰으로 상담 시간이 따로 계산돼요.`,
      join: { expertId: ex.id, name: ex.name, field: ex.field, desc: ex.desc, career: ex.career, rate: ex.rate, note, status: null, teamId: chat.id } }, { fromTeam: true });
    return tgSend(chat.id, `"${roomLabel(target)}" 기업에 ${ex.name}님의 참여 요청을 보냈어요 (시간당 ${ex.rate}토큰). 기업이 승인하면 알려 드릴게요.`);
  }

  // 보낼 상담: 연결된 상담, 없으면 내가 맡은 상담이 하나일 때 그것
  const mine = S.rooms.filter(active);
  const target = room || (mine.length === 1 ? mine[0] : null);
  if (cmd === 'send' || cmd === 's') {
    if (!target) return tgSend(chat.id, mine.length ? '맡은 상담이 여러 개예요. /rooms 와 /use 번호 로 먼저 연결해 주세요.' : '내가 호출된 상담이 없어요.');
    if (!active(target)) return tgSend(chat.id, `${ex.name}님은 이 상담에 호출되지 않아서 보낼 수 없어요. 참여하고 싶다면 /join 으로 기업에 요청해 주세요.`);
    const rep = msg.reply_to_message;
    let text = arg, note = '';
    if (!text && rep && rep.text) {
      text = rep.text;
      const author = rep.from && expertByChat(rep.from.id);
      if (author && author !== ex) note = ` (${author.name} 전문가와 함께 정리)`;
    }
    if (!text) return tgSend(chat.id, '보낼 내용을 적어 주세요. 예: /send 서류는 통장사본과 급여대장이 필요해요');
    addMsg(target, { from: 'hx', expertId: ex.id, name: ex.name + note, text }, { fromTeam: true });
    if (target.tgChatId) tgSend(target.tgChatId, `[${ex.name} 전문가${note}]\n${text}`);
    for (const id of target.humans || []) { // 팀방에 없는 다른 담당 전문가에게도 알림
      if (id === ex.id || g.members.includes(id)) continue;
      const other = expertById(id); if (other) dmExpert(other, target, `${ex.name} 전문가: ${text}`);
    }
    return tgSend(chat.id, `"${roomLabel(target)}"에 보냈어요.`);
  }
  if (cmd === 'end') {
    if (!target || !active(target)) return tgSend(chat.id, '마칠 내 상담이 없어요.');
    await endConsult(target, ex, '전문가');
    return tgSend(chat.id, `${ex.name}님의 "${roomLabel(target)}" 상담을 마쳤어요. 기업이 토큰을 보내면 1:1 대화로 알려 드릴게요.`);
  }
  return tgSend(chat.id, `팀방에서 쓸 수 없는 명령이에요.\n\n${TEAM_HELP}`);
}

const EXPERT_CMDS = '/info 기업 정보 문서 받기 · /ask 질문 기업 정보 묻기 · 고친 HTML 파일을 올리면 기업이 승인 후 반영\n/login 프로필 편집 · /rate 숫자 시간당 토큰 · /on /off 상담 받기 켜기·끄기\n/rooms 진행 중인 상담 · /end 상담 종료 · /balance 받은 토큰';
const HELP = () => `함께봇 사용법
/link 연결코드 — 이 대화(그룹 또는 1:1)를 웹앱 채팅방과 연결
/unlink — 연결 해제
/bots — 부를 수 있는 전문가 봇 목록
${BOTS.filter(b => !b.soon).map(b => `/${b.id} 요청내용 — ${b.name}에게 요청`).join('\n')}
@${tgUsername} 요청내용 — 이 방의 기본 봇에게 요청
봇의 메시지에 답장해도 대화가 이어집니다.
연결코드는 웹앱 채팅방의 "텔레그램" 버튼에서 받을 수 있어요.`;

async function handleTelegram(msg) {
  if (!msg) return;
  if (msg.document) {
    // 전문가가 고친 기업 정보 문서(HTML)를 올린 경우: 1:1 대화 또는 전문가 팀방에서만
    const ex = expertByChat(msg.chat.type === 'private' ? msg.chat.id : msg.from.id);
    const g = msg.chat.type !== 'private' && S.expertGroups[msg.chat.id];
    if (ex && (msg.chat.type === 'private' || (g && g.members.includes(ex.id)))) return receiveDocFromExpert(ex, msg, g && g.roomId ? roomById(g.roomId) : null);
    if (msg.chat.type === 'private') return tgSend(msg.chat.id, '파일은 등록된 전문가만 올릴 수 있어요.');
    return;
  }
  if (!msg.text) return;
  const chat = msg.chat, isPrivate = chat.type === 'private';
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || '텔레그램 사용자';
  const text = msg.text.trim();

  let cmd = null, arg = text;
  const cm = text.match(/^\/([a-zA-Z0-9_]+)(?:@(\w+))?\s*([\s\S]*)$/);
  if (cm) {
    if (cm[2] && cm[2].toLowerCase() !== tgUsername.toLowerCase()) return; // 다른 봇에게 보낸 명령
    cmd = cm[1].toLowerCase(); arg = cm[3].trim();
  }

  if (cmd === 'expert') {
    if (!isPrivate) return tgSend(chat.id, '전문가 등록은 봇과의 1:1 대화에서 해 주세요.');
    const ex = S.experts.find(e => e.regCode && e.regCode === arg.toUpperCase());
    if (!ex) return tgSend(chat.id, '등록코드가 맞지 않아요. 운영자에게 코드를 다시 확인해 주세요.');
    for (const e of S.experts) if (e.tgChatId === chat.id && e !== ex) e.tgChatId = null;
    ex.tgChatId = chat.id; ex.regCode = null; save(); emit('room', {}, '*');
    return tgSend(chat.id, `${ex.name}님, 전문가로 등록됐어요 (${ex.field}).\n\n먼저 프로필과 시간당 토큰을 정해 주세요. 정하기 전에는 기업 목록에 보이지 않아요.\n· /login — 프로필 페이지 로그인 코드 받기\n· /rate 5 — 시간당 5토큰으로 바로 정하기\n\n기업이 호출하면 이 대화로 질문이 와요. 그 메시지에 "답장"하면 기업에 전달돼요.\n${EXPERT_CMDS}`);
  }
  // 기업 방과 연결되지 않은 그룹에서 전문가가 쓰면 '전문가 팀방'으로 동작
  if (!isPrivate && !roomByChat(chat.id)) {
    const sender = expertByChat(msg.from.id); // 텔레그램 1:1 chat id = 사용자 id
    const teamCmds = ['team', 'rooms', 'use', 'send', 's', 'end', 'detach', 'join', 'info', 'ask'];
    if (S.expertGroups[chat.id] && cmd !== 'link') return handleTeam(msg, sender, cmd, arg);
    if (sender && teamCmds.includes(cmd)) return handleTeam(msg, sender, cmd, arg);
  }
  if (cmd === 'link' && S.expertGroups[chat.id]) return tgSend(chat.id, '전문가 팀방은 기업 방과 연결할 수 없어요.');
  const ex = isPrivate && expertByChat(chat.id);
  if (ex && cmd !== 'start' && cmd !== 'help') return handleExpertDM(ex, msg, cmd);
  if (ex) return tgSend(chat.id, `${ex.name}님은 전문가로 등록돼 있어요 (시간당 ${ex.rate || '미설정'}토큰${ex.available ? '' : ' · 상담 꺼짐'}).\n기업 메시지에 "답장"하면 전달돼요.\n${EXPERT_CMDS}`);

  if (cmd === 'start' || cmd === 'help') return tgSend(chat.id, HELP());
  if (cmd === 'bots') return tgSend(chat.id, BOTS.map(b => `${b.soon ? '(준비 중) ' : '/' + b.id + ' '}${b.name} — ${b.tag}`).join('\n'));

  if (cmd === 'link') {
    const room = S.rooms.find(r => r.linkCode && r.linkCode === arg.toUpperCase());
    if (!room) return tgSend(chat.id, '연결코드가 맞지 않아요. 웹앱의 "텔레그램" 버튼에서 코드를 확인해 주세요.');
    for (const r of S.rooms) if (r.tgChatId === chat.id) { r.tgChatId = null; r.tgTitle = null; emit('room', { roomId: r.id }, r.orgId); }
    room.tgChatId = chat.id; room.tgTitle = chat.title || name; room.linkCode = null;
    addMsg(room, { from: 'sys', text: `텔레그램 "${room.tgTitle}"과(와) 연결됐어요` });
    return tgSend(chat.id, `웹앱 채팅방 "${roomLabel(room)}"과(와) 연결됐어요.\n${HELP()}`);
  }

  const room = roomByChat(chat.id);
  if (cmd === 'unlink') {
    if (!room) return tgSend(chat.id, '연결된 웹앱 채팅방이 없어요.');
    room.tgChatId = null; room.tgTitle = null;
    addMsg(room, { from: 'sys', text: '텔레그램 연결이 해제됐어요' });
    return tgSend(chat.id, '연결을 해제했어요.');
  }

  const mention = tgUsername && new RegExp('@' + tgUsername + '\\b', 'i');
  const replyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.username === tgUsername;
  let botId = null;
  if (cmd && botById(cmd)) botId = cmd;
  else if (cmd) return tgSend(chat.id, `"/${cmd}"는 없는 명령이에요.\n${HELP()}`);
  else if ((mention && mention.test(text)) || replyToBot || isPrivate) botId = (room && room.bots.find(id => botById(id))) || 'mkt';

  // 연결 안 된 대화: 어느 기업인지 알 수 없으므로 봇을 쓰지 않고 연결 방법만 안내
  if (!room) {
    if (botId) return tgSend(chat.id, `이 대화는 아직 웹앱 채팅방과 연결되지 않았어요.\n웹앱에 로그인 → 채팅방 → "텔레그램" 버튼에서 받은 코드로 /link 코드 를 보내 주세요.`);
    return;
  }

  const ask = (cmd ? arg : text.replace(mention || /$^/, '')).trim();
  addMsg(room, { from: 'tg', name, text });
  forwardToExperts(room, `${name}: ${text}`);
  if (botId) {
    if (!room.bots.includes(botId)) { room.bots.push(botId); addMsg(room, { from: 'sys', text: `${botById(botId).name}이(가) 텔레그램에서 호출돼 방에 들어왔어요` }); }
    runBot(room, botId, ask || '자기소개를 해 주세요');
  }
}

async function pollTelegram() {
  const me = await tg('getMe');
  if (!me || !me.ok) { console.log('텔레그램: 토큰이 없거나 잘못돼 중계를 끕니다.'); return; }
  tgUsername = me.result.username;
  await tg('deleteWebhook', {});
  await tg('setMyCommands', { commands: [
    { command: 'help', description: '사용법' }, { command: 'bots', description: '전문가 봇 목록' },
    { command: 'link', description: '웹앱 채팅방과 연결' }, { command: 'unlink', description: '연결 해제' },
    ...BOTS.filter(b => !b.soon).map(b => ({ command: b.id, description: b.name })),
    { command: 'team', description: '(전문가) 이 그룹을 전문가 팀방으로' }, { command: 'send', description: '(전문가 팀방) 기업에게 보내기' }, { command: 'use', description: '(전문가 팀방) 상담 연결' }, { command: 'join', description: '(전문가 팀방) 상담 참여 요청' }, { command: 'info', description: '(전문가) 기업 정보 문서 받기' }, { command: 'ask', description: '(전문가) 기업 정보 묻기' },
    { command: 'login', description: '(전문가) 프로필 페이지 로그인 코드' }, { command: 'rate', description: '(전문가) 시간당 토큰 정하기' }
  ] });
  console.log(`텔레그램: @${tgUsername} 으로 중계 시작`);
  let offset = S.tgOffset || 0;
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=50&offset=${offset}`);
      const j = await r.json();
      if (j.ok) for (const u of j.result) {
        offset = u.update_id + 1; S.tgOffset = offset; save();
        if (u.callback_query) handleCallback(u.callback_query).catch(e => console.error(e));
        else handleTelegram(u.message).catch(e => console.error(e));
      } else { console.error('getUpdates', j.description); await new Promise(r => setTimeout(r, 5000)); }
    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
  }
}

// ---------- HTTP 도우미 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, code, obj, headers) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(headers || {}) }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (_) { ok({}); } }); });
const publicBots = () => BOTS.map(({ role, ...b }) => ({ ...b, cost: b.soon ? null : costOf(b.id) }));
const publicExperts = () => S.experts.filter(e => e.tgChatId && e.rate).map(e => ({ id: e.id, name: e.name, field: e.field, desc: e.desc, career: e.career, hours: e.hours, rate: e.rate, available: e.available, color: e.color, linked: true }));
const expertProfile = e => ({ id: e.id, name: e.name, field: e.field, desc: e.desc, career: e.career, hours: e.hours, rate: e.rate, available: e.available, balance: e.balance });
const orgPublic = o => ({ id: o.id, name: o.name, mission: o.mission, product: o.product, target: o.target, tone: o.tone });
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const BAD = (res, error, code = 400) => json(res, code, { error });

// ---------- 관리자 API ----------
async function adminApi(req, res, p, sess) {
  const ip = ipOf(req);
  if (p === '/api/admin/login' && req.method === 'POST') {
    if (!ADMIN_PASSWORD) return BAD(res, '서버에 ADMIN_PASSWORD가 설정되지 않아 관리자 기능이 꺼져 있어요', 403);
    if (tooMany(ip)) return BAD(res, '로그인 시도가 너무 많아요. 10분 뒤 다시 시도해 주세요.', 429);
    const b = await body(req), given = '' + (b.password || '');
    const ok = given.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_PASSWORD));
    if (!ok) { failed(ip); return BAD(res, '관리자 비밀번호가 맞지 않아요', 401); }
    return json(res, 200, { ok: true }, { 'set-cookie': cookie(newSession({ kind: 'admin' }), SESSION_DAYS * 86400) });
  }
  if (!sess || sess.kind !== 'admin') return BAD(res, '관리자 로그인이 필요해요', 401);
  if (p === '/api/admin/logout') { delete S.sessions[sess.token]; save(); return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }); }
  if (p === '/api/admin/state') return json(res, 200, {
    telegram: { enabled: !!tgUsername, username: tgUsername },
    orgs: S.orgs.map(o => ({ ...orgPublic(o), wallet: o.wallet, site: o.site && o.site.published ? { url: siteUrl(o.site.slug), slug: o.site.slug } : null, rooms: S.rooms.filter(r => r.orgId === o.id).length, users: S.users.filter(u => u.orgId === o.id).map(u => ({ id: u.id, loginId: u.loginId, name: u.name })) })),
    experts: S.experts.map(e => ({ ...expertProfile(e), linked: !!e.tgChatId, regCode: e.regCode, active: roomsOfExpert(e).length })),
    costs: COST_ITEMS().map(c => ({ ...c, cost: costOf(c.id) })),
    ledger: S.ledger.slice(-500).reverse()
  });
  if (req.method !== 'POST') return json(res, 405, {});
  const b = await body(req);

  // 기업 + 첫 계정 만들기
  if (p === '/api/admin/orgs') {
    const name = str(b.name, 40), loginId = str(b.loginId, 30).toLowerCase();
    if (!name) return BAD(res, '기업명을 입력해 주세요');
    const e = idError(loginId) || pwError(b.password); if (e) return BAD(res, e);
    if (S.users.some(u => u.loginId === loginId)) return BAD(res, '이미 쓰는 아이디예요');
    const org = { id: newId('o'), name, mission: '', product: '', target: '', tone: '', wallet: 0 };
    const user = { id: newId('u'), orgId: org.id, loginId, name: str(b.userName, 30) || name };
    setPw(user, b.password);
    S.orgs.push(org); S.users.push(user);
    S.rooms.push({ id: newId('r'), orgId: org.id, name: '우리 팀 마케팅', bots: [], humans: [], msgs: [] });
    save(); emit('room', {}, org.id);
    return json(res, 200, { ok: true, orgId: org.id });
  }
  let m = p.match(/^\/api\/admin\/orgs\/(\w+)\/(users|charge|deduct|rename|delete|unpublish)$/);
  if (m) {
    const org = orgById(m[1]); if (!org) return BAD(res, '없는 기업이에요', 404);
    if (m[2] === 'unpublish') { if (!org.site || !org.site.published) return BAD(res, '게시된 페이지가 없어요'); org.site.published = null; save(); emit('room', {}, org.id); return json(res, 200, { ok: true }); }
    if (m[2] === 'users') {
      const loginId = str(b.loginId, 30).toLowerCase();
      const e = idError(loginId) || pwError(b.password); if (e) return BAD(res, e);
      if (S.users.some(u => u.loginId === loginId)) return BAD(res, '이미 쓰는 아이디예요');
      const user = { id: newId('u'), orgId: org.id, loginId, name: str(b.userName, 30) || loginId };
      setPw(user, b.password); S.users.push(user); save();
      return json(res, 200, { ok: true });
    }
    if (m[2] === 'rename') { const n = str(b.name, 40); if (!n) return BAD(res, '기업명을 입력해 주세요'); org.name = n; save(); emit('room', {}, org.id); return json(res, 200, { ok: true }); }
    if (m[2] === 'delete') {
      if (org.wallet > 0) return BAD(res, `잔액 ${org.wallet}개를 먼저 차감해 주세요`);
      const rooms = S.rooms.filter(r => r.orgId === org.id);
      if (rooms.some(r => (r.humans || []).length)) return BAD(res, '진행 중인 전문가 상담을 먼저 종료해 주세요');
      const userIds = new Set(S.users.filter(u => u.orgId === org.id).map(u => u.id));
      for (const t in S.sessions) if (userIds.has(S.sessions[t].userId)) delete S.sessions[t];
      S.users = S.users.filter(u => u.orgId !== org.id);
      S.rooms = S.rooms.filter(r => r.orgId !== org.id);
      S.orgs = S.orgs.filter(o => o !== org); save(); emit('room', {}, org.id);
      return json(res, 200, { ok: true });
    }
    const amt = toAmount(b.amount); if (!amt) return BAD(res, '1 이상의 정수로 입력해 주세요');
    if (m[2] === 'deduct' && amt > org.wallet) return BAD(res, `잔액(${org.wallet}개)보다 많이 차감할 수 없어요`);
    org.wallet += m[2] === 'charge' ? amt : -amt;
    record(org, { type: m[2], amount: amt, memo: str(b.memo, 100) });
    return json(res, 200, { ok: true, wallet: org.wallet });
  }
  m = p.match(/^\/api\/admin\/users\/(\w+)\/(password|delete)$/);
  if (m) {
    const u = userById(m[1]); if (!u) return BAD(res, '없는 계정이에요', 404);
    if (m[2] === 'password') { const e = pwError(b.password); if (e) return BAD(res, e); setPw(u, b.password); }
    else S.users = S.users.filter(x => x !== u);
    for (const t in S.sessions) if (S.sessions[t].userId === u.id) delete S.sessions[t]; // 기존 로그인 끊기
    save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/costs') {
    const next = {};
    for (const it of COST_ITEMS()) {
      if (b.costs == null || !(it.id in b.costs)) continue;
      const n = Number(b.costs[it.id]);
      if (!Number.isInteger(n) || n < 0 || n > 1000) return BAD(res, `${it.name}: 0~1000 사이 정수로 입력해 주세요`);
      next[it.id] = n;
    }
    Object.assign(S.botCosts, next); save(); emit('room', {}, '*');
    return json(res, 200, { ok: true, costs: COST_ITEMS().map(c => ({ ...c, cost: costOf(c.id) })) });
  }
  // 사람 전문가 (모든 기업이 함께 호출)
  if (p === '/api/admin/experts') {
    const name = str(b.name, 30), field = str(b.field, 40);
    if (!name || !field) return BAD(res, '이름과 분야를 입력해 주세요');
    const ex = { id: newId('x'), name, field, desc: str(b.desc, 200), color: COLORS[S.experts.length % COLORS.length], regCode: code6(), tgChatId: null, balance: 0, rate: null, available: true, career: '', hours: '' };
    S.experts.push(ex); save(); emit('room', {}, '*');
    return json(res, 200, { id: ex.id, regCode: ex.regCode, username: tgUsername });
  }
  m = p.match(/^\/api\/admin\/experts\/(\w+)\/(newcode|delete)$/);
  if (m) {
    const ex = expertById(m[1]); if (!ex) return BAD(res, '없는 전문가예요', 404);
    if (m[2] === 'newcode') { ex.regCode = code6(); save(); return json(res, 200, { regCode: ex.regCode, username: tgUsername }); }
    if (ex.balance > 0) return BAD(res, `받은 토큰 ${ex.balance}개를 먼저 정산해 주세요`);
    if (roomsOfExpert(ex).length) return BAD(res, '진행 중인 상담이 있어요');
    for (const r of S.rooms) if (r.pending) r.pending = r.pending.filter(q => q.expertId !== ex.id);
    S.experts = S.experts.filter(e => e !== ex); save(); emit('room', {}, '*');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/payout') {
    const ex = expertById(b.expertId); if (!ex) return BAD(res, '없는 전문가예요', 404);
    const amt = toAmount(b.amount); if (!amt) return BAD(res, '1 이상의 정수로 입력해 주세요');
    if (amt > ex.balance) return BAD(res, `전문가 잔액(${ex.balance}개)보다 많이 정산할 수 없어요`);
    ex.balance -= amt;
    S.ledger.push({ id: newId('t'), at: Date.now(), type: 'payout', amount: amt, expertId: ex.id, expertName: ex.name, expertAfter: ex.balance, memo: str(b.memo, 100) });
    save(); emit('room', {}, '*');
    if (ex.tgChatId) tgSend(ex.tgChatId, `운영자가 상담 토큰 ${amt}개를 정산 처리했어요. 남은 잔액: ${ex.balance}개`);
    return json(res, 200, { ok: true });
  }
  return BAD(res, '없는 기능이에요', 404);
}

// ---------- 전문가 API (프로필·단가) ----------
async function expertApi(req, res, p, sess) {
  if (p === '/api/expert/login' && req.method === 'POST') {
    const ip = ipOf(req);
    if (tooMany(ip)) return BAD(res, '시도가 너무 많아요. 10분 뒤 다시 시도해 주세요.', 429);
    const b = await body(req), code = str(b.code, 20).toUpperCase(), l = S.expertLogins[code];
    if (!l || l.exp < Date.now() || !expertById(l.expertId)) { failed(ip); return BAD(res, '코드가 맞지 않거나 만료됐어요. 텔레그램에서 /login 으로 새 코드를 받아 주세요.', 401); }
    delete S.expertLogins[code];
    return json(res, 200, { ok: true }, { 'set-cookie': cookie(newSession({ kind: 'expert', expertId: l.expertId }), SESSION_DAYS * 86400) });
  }
  const ex = sess && sess.kind === 'expert' && expertById(sess.expertId);
  if (!ex) return BAD(res, '로그인이 필요해요', 401);
  if (p === '/api/expert/logout') { delete S.sessions[sess.token]; save(); return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }); }
  if (p === '/api/expert/state') return json(res, 200, {
    profile: expertProfile(ex),
    active: roomsOfExpert(ex).map(r => ({ label: roomLabel(r), since: ((r.consults || {})[ex.id] || {}).startAt })),
    received: S.ledger.filter(l => l.expertId === ex.id).slice(-100).reverse().map(l => ({ at: l.at, type: l.type, amount: l.amount, orgName: l.type === 'pay' ? l.orgName : '', minutes: l.minutes, memo: l.memo })),
    rateMax: RATE_MAX
  });
  if (p === '/api/expert/profile' && req.method === 'POST') {
    const b = await body(req);
    const name = str(b.name, 30), field = str(b.field, 40), rate = Number(b.rate);
    if (!name || !field) return BAD(res, '이름과 분야를 입력해 주세요');
    if (!Number.isInteger(rate) || rate < 1 || rate > RATE_MAX) return BAD(res, `시간당 토큰은 1~${RATE_MAX} 사이 정수로 정해 주세요`);
    Object.assign(ex, { name, field, rate, desc: str(b.desc, 200), career: str(b.career, 1500), hours: str(b.hours, 200), available: !!b.available });
    save(); emit('room', {}, '*');
    return json(res, 200, { ok: true });
  }
  return BAD(res, '없는 기능이에요', 404);
}

// ---------- 기업 사용자 API ----------
async function userApi(req, res, p, sess) {
  const ip = ipOf(req);
  if (p === '/api/login' && req.method === 'POST') {
    if (tooMany(ip)) return BAD(res, '로그인 시도가 너무 많아요. 10분 뒤 다시 시도해 주세요.', 429);
    const b = await body(req);
    const u = S.users.find(x => x.loginId === str(b.loginId, 30).toLowerCase());
    if (!u || !checkPw(u, '' + (b.password || ''))) { failed(ip); return BAD(res, '아이디 또는 비밀번호가 맞지 않아요', 401); }
    return json(res, 200, { ok: true }, { 'set-cookie': cookie(newSession({ kind: 'user', userId: u.id }), SESSION_DAYS * 86400) });
  }
  const user = sess && sess.kind === 'user' && userById(sess.userId);
  const org = user && orgById(user.orgId);
  if (!org) return BAD(res, '로그인이 필요해요', 401);

  if (p === '/api/logout') { delete S.sessions[sess.token]; save(); return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }); }
  if (p === '/api/state' && req.method === 'GET')
    return json(res, 200, {
      me: { loginId: user.loginId, name: user.name }, org: orgPublic(org), wallet: org.wallet,
      rooms: S.rooms.filter(r => r.orgId === org.id), bots: publicBots(), experts: publicExperts(),
      telegram: { enabled: !!tgUsername, username: tgUsername }, ai: !!ANTHROPIC_API_KEY,
      site: org.site && org.site.published ? { url: siteUrl(org.site.slug), slug: org.site.slug, n: (siteVersion(org, org.site.published) || {}).n, published: org.site.published } : { slug: org.site && org.site.slug },
      costs: Object.fromEntries(COST_ITEMS().map(c => [c.id, costOf(c.id)]))
    });
  // ----- 랜딩페이지 -----
  if (p.startsWith('/api/site')) {
    const site = ensureSite(org), url = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      if (p === '/api/site') return json(res, 200, { slug: site.slug, published: site.published, url: site.slug ? siteUrl(site.slug) : null, versions: site.versions.slice().reverse().map(v => ({ id: v.id, n: v.n, at: v.at, note: v.note, request: v.request, title: DOC.pageTitle(v.html), docN: v.docN })) });
      const v = siteVersion(org, url.searchParams.get('id'));
      if (!v) return BAD(res, '없는 버전이에요', 404);
      if (p === '/api/site/preview') { res.writeHead(200, { ...SITE_HEADERS, 'cache-control': 'no-store' }); return res.end(v.html); }
      if (p === '/api/site/download') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(siteFileName(org, v))}` }); return res.end(v.html); }
      return BAD(res, '없는 기능이에요', 404);
    }
    if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
    const b = await body(req);
    if (p === '/api/site/publish') {
      const v = siteVersion(org, b.versionId); if (!v) return BAD(res, '없는 버전이에요', 404);
      const slug = str(b.slug || site.slug || '', 40).toLowerCase();
      const e = slugError(slug); if (e) return BAD(res, e);
      if (S.orgs.some(o => o !== org && o.site && o.site.slug === slug)) return BAD(res, '다른 기업이 이미 쓰는 주소예요');
      const oldSlug = site.slug;
      site.slug = slug; site.published = v.id; site.publishedAt = Date.now(); save();
      const check = await selfCheck(slug);
      const ok = check.status === 200 && check.title === DOC.pageTitle(v.html) && check.csp && check.noScript;
      const room = S.rooms.find(r => r.id === b.roomId && r.orgId === org.id);
      const line = ok ? `랜딩페이지 v${v.n}을 게시했어요: ${siteUrl(slug)}\n등록 확인: 공개 주소에 접속해 보니 정상이에요 (응답 200 · ${(check.bytes / 1024).toFixed(1)}KB · ${check.ms}ms · 제목 "${check.title}" · 스크립트 없음 · 보안 헤더 적용).${oldSlug && oldSlug !== slug ? `\n이전 주소 /s/${oldSlug}는 이제 열리지 않아요.` : ''}`
        : `랜딩페이지 v${v.n}을 게시했지만 등록 확인에 실패했어요 (응답 ${check.status || check.error}). 관리자에게 알려 주세요.`;
      if (room) addMsg(room, { from: 'sys', text: line }); else emit('room', {}, org.id);
      return json(res, ok ? 200 : 502, { ok, url: siteUrl(slug), check });
    }
    if (p === '/api/site/unpublish') {
      if (!site.published) return BAD(res, '게시된 페이지가 없어요');
      site.published = null; save(); emit('room', {}, org.id);
      return json(res, 200, { ok: true });
    }
    return BAD(res, '없는 기능이에요', 404);
  }

  // ----- 기업 정보 문서 -----
  if (p.startsWith('/api/doc')) {
    const d = ensureDoc(org), url = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      if (p === '/api/doc') {
        const cur = docCurrent(org);
        return json(res, 200, {
          current: { ...docMeta(cur), html: cur.html },
          pending: d.versions.filter(v => v.status === 'pending').map(v => ({ ...docMeta(v), html: v.html, base: (docVersion(org, v.basedOn) || {}).n })),
          history: d.versions.filter(v => v.status !== 'pending').slice().reverse().map(docMeta)
        });
      }
      const v = docVersion(org, url.searchParams.get('id') || d.current);
      if (!v) return BAD(res, '없는 버전이에요', 404);
      if (p === '/api/doc/version') return json(res, 200, { ...docMeta(v), html: v.html });
      if (p === '/api/doc/download') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(docFileName(org, v))}` });
        return res.end(DOC.wrapDocument(`${org.name} 기업 정보`, v.html, `v${v.n}`));
      }
      return BAD(res, '없는 기능이에요', 404);
    }
    if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
    const b = await body(req);
    const me = { kind: 'org', name: user.name, id: user.id };
    if (p === '/api/doc/save') {
      // 기업이 웹에서 고쳐 저장 → 바로 새 버전. 그사이 다른 버전이 승인됐으면 덮어쓰기 전에 알려 줌
      if (b.basedOn && b.basedOn !== d.current && !b.force) return BAD(res, `편집하는 동안 문서가 v${docCurrent(org).n}으로 바뀌었어요. 최신본을 확인한 뒤 다시 저장하거나, 그대로 덮어쓰려면 "그래도 저장"을 눌러 주세요.`, 409);
      const html = DOC.sanitizeHtml(b.html);
      if (!html) return BAD(res, '빈 문서는 저장할 수 없어요');
      if (html === docCurrent(org).html) return BAD(res, '바뀐 내용이 없어요');
      const v = addVersion(org, { html, by: me, note: b.note || '웹에서 직접 편집', status: 'approved', basedOn: b.basedOn });
      return json(res, 200, { ok: true, id: v.id, n: v.n, cleaned: html !== String(b.html || '').trim() });
    }
    if (p === '/api/doc/revert') {
      const old = docVersion(org, b.id);
      if (!old || old.status !== 'approved') return BAD(res, '되돌릴 수 있는 버전이 아니에요', 404);
      if (old.id === d.current) return BAD(res, '이미 현재 버전이에요');
      const v = addVersion(org, { html: old.html, by: me, note: `v${old.n}(으)로 되돌림`, status: 'approved', basedOn: d.current });
      return json(res, 200, { ok: true, n: v.n });
    }
    if (p === '/api/doc/generate') {
      if (d.versions.some(v => v.status === 'pending' && v.by.kind === 'bot')) return BAD(res, '함께봇 정리안이 이미 기다리고 있어요. 먼저 승인하거나 거절해 주세요.');
      const cost = ANTHROPIC_API_KEY ? costOf('summary') : 0; // AI 없이 붙이기만 하는 경우는 무료
      if (!reserveTokens(org, cost)) return BAD(res, `함께봇 문서 정리는 ${cost}토큰을 써요. 잔액(${org.wallet}토큰)이 부족해요.`);
      const r = await generateDocProposal(org, user);
      if (r.error) { refundTokens(org, cost); return BAD(res, r.error); }
      chargeRecord(org, cost, { botId: 'summary', botName: '함께봇 문서 정리' });
      return json(res, 200, { ok: true, id: r.version.id, n: r.version.n, cost });
    }
    if (p === '/api/doc/approve' || p === '/api/doc/reject') {
      const v = docVersion(org, b.id);
      if (!v || v.status !== 'pending') return BAD(res, '이미 처리됐거나 없는 수정안이에요', 404);
      const ex = v.by.kind === 'expert' && expertById(v.by.id);
      const notify = t => { if (ex && ex.tgChatId) tgSend(ex.tgChatId, t); };
      if (p === '/api/doc/reject') {
        v.status = 'rejected'; v.decidedBy = me; v.reason = str(b.reason, 200); save(); emit('doc', { orgId: org.id }, org.id);
        notify(`${org.name}이(가) 기업 정보 문서 수정안 v${v.n}을 반영하지 않기로 했어요.${v.reason ? ' 사유: ' + v.reason : ''}`);
        return json(res, 200, { ok: true });
      }
      // 기업이 수정안을 조금 고쳐서 승인할 수도 있음
      const edited = b.html != null ? DOC.sanitizeHtml(b.html) : null;
      if (edited === '') return BAD(res, '빈 문서는 승인할 수 없어요');
      const changed = !!edited && edited !== v.html;
      v.status = 'approved'; v.decidedBy = me;
      if (changed) { v.html = edited; v.note = `${v.note} (기업이 고쳐서 승인)`; }
      d.current = v.id; save(); emit('doc', { orgId: org.id }, org.id);
      notify(`${org.name}이(가) 기업 정보 문서 수정안 v${v.n}을 승인했어요. 이제 이 내용이 기업 정보로 쓰여요.${changed ? ' (기업이 일부 고쳐서 반영)' : ''}`);
      return json(res, 200, { ok: true, n: v.n });
    }
    return BAD(res, '없는 기능이에요', 404);
  }

  if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
  const b = await body(req);

  if (p === '/api/password') {
    if (!checkPw(user, '' + (b.current || ''))) return BAD(res, '현재 비밀번호가 맞지 않아요');
    const e = pwError(b.next); if (e) return BAD(res, e);
    setPw(user, b.next);
    for (const t in S.sessions) if (S.sessions[t].userId === user.id && t !== sess.token) delete S.sessions[t];
    save(); return json(res, 200, { ok: true });
  }
  if (p === '/api/org') {
    org.name = str(b.name, 40) || org.name;
    for (const k of ['mission', 'product', 'target', 'tone']) org[k] = str(b[k], 300);
    save(); emit('room', {}, org.id); return json(res, 200, { ok: true });
  }
  if (p === '/api/rooms') {
    const r = { id: newId('r'), orgId: org.id, name: str(b.name, 40) || '새 채팅방', bots: [], humans: [], msgs: [] };
    S.rooms.unshift(r); save(); emit('room', { roomId: r.id }, org.id); return json(res, 200, r);
  }
  const m = p.match(/^\/api\/rooms\/(\w+)\/(invite|kick|messages|link|unlink|rename|call|end|review|pay|cancelcall|join)$/);
  const room = m && roomById(m[1]);
  if (!room || room.orgId !== org.id) return BAD(res, '방이 없어요', 404); // 다른 기업의 방은 없는 것으로 취급
  const act = m[2];
  if (act === 'invite') {
    const bot = botById(b.botId); if (!bot) return BAD(res, '없는 봇이에요');
    if (!room.bots.includes(bot.id)) {
      room.bots.push(bot.id); addMsg(room, { from: 'sys', text: `${bot.name}을(를) 초대했어요` }); addMsg(room, { from: bot.id, text: bot.hello });
      if (room.tgChatId) tgSend(room.tgChatId, `[${bot.name}] 이 방에 초대됐어요. /${bot.id} 요청내용 으로 불러 주세요.`);
    }
    return json(res, 200, { ok: true });
  }
  if (act === 'kick') { room.bots = room.bots.filter(x => x !== b.botId); addMsg(room, { from: 'sys', text: `${(BOTS.find(x => x.id === b.botId) || {}).name || '봇'}이(가) 나갔어요` }); return json(res, 200, { ok: true }); }
  if (act === 'rename') { room.name = str(b.name, 40) || room.name; save(); emit('room', { roomId: room.id }, org.id); return json(res, 200, { ok: true }); }
  if (act === 'link') { room.linkCode = code6(); save(); return json(res, 200, { code: room.linkCode, username: tgUsername }); }
  if (act === 'unlink') { if (room.tgChatId) tgSend(room.tgChatId, '웹앱에서 연결을 해제했어요.'); room.tgChatId = null; room.tgTitle = null; addMsg(room, { from: 'sys', text: '텔레그램 연결이 해제됐어요' }); return json(res, 200, { ok: true }); }
  if (act === 'join') {
    // 팀방에서 온 참여 요청 승인·거절 (요청 메시지 하나당 한 번)
    const src = room.msgs.find(x => x.id === b.msgId);
    if (!src || !src.join) return BAD(res, '참여 요청이 없어요', 404);
    if (src.join.status) return BAD(res, '이미 처리된 요청이에요');
    const ex = expertById(src.join.expertId); if (!ex || !ex.tgChatId) return BAD(res, '전문가가 삭제됐어요', 404);
    const tell = t => { if (src.join.teamId) tgSend(src.join.teamId, t); else dmExpert(ex, room, t); };
    if (!b.approve) {
      src.join.status = 'declined'; save();
      addMsg(room, { from: 'sys', text: `${ex.name} 전문가의 참여 요청을 거절했어요` }, { fromTeam: true });
      tell(`"${roomLabel(room)}" 기업이 ${ex.name}님의 참여 요청을 이번에는 거절했어요.`);
      return json(res, 200, { ok: true });
    }
    if ((room.humans || []).includes(ex.id)) { src.join.status = 'approved'; save(); return json(res, 200, { ok: true }); }
    src.join.status = 'approved'; save();
    await callExpert(room, ex, '', { joined: true, rate: src.join.rate }); // 요청 때 보여 준 단가로 고정
    return json(res, 200, { ok: true });
  }
  if (act === 'cancelcall') {
    const req = (room.pending || []).find(p => p.expertId === b.expertId);
    if (!req) return BAD(res, '기다리는 요청이 없어요', 404);
    room.pending = room.pending.filter(p => p !== req);
    const ex = expertById(req.expertId);
    if (ex && ex.tgChatId) { if (req.msgId) tg('editMessageReplyMarkup', { chat_id: ex.tgChatId, message_id: req.msgId, reply_markup: { inline_keyboard: [] } }); dmExpert(ex, room, '기업이 상담 요청을 취소했어요.'); }
    addMsg(room, { from: 'sys', text: `${ex ? ex.name : '전문가'} 상담 요청을 취소했어요` });
    return json(res, 200, { ok: true });
  }
  if (act === 'pay') {
    const src = room.msgs.find(x => x.id === b.msgId);
    if (!src || !src.pay) return BAD(res, '상담 종료 기록이 없어요', 404);
    if (src.pay.paid != null) return BAD(res, '이미 처리된 상담이에요');
    const ex = expertById(src.pay.expertId); if (!ex) return BAD(res, '전문가가 삭제됐어요', 404);
    if (b.skip) { src.pay.paid = 0; save(); emit('room', { roomId: room.id }, org.id); return json(res, 200, { ok: true }); }
    const amt = toAmount(b.amount); if (!amt) return BAD(res, '1 이상의 정수로 입력해 주세요');
    if (amt > org.wallet) return BAD(res, `잔액이 부족해요 (현재 ${org.wallet}개). 관리자에게 충전을 요청해 주세요.`);
    org.wallet -= amt; ex.balance += amt; src.pay.paid = amt;
    const memo = str(b.memo, 200);
    record(org, { type: 'pay', amount: amt, expertId: ex.id, expertName: ex.name, expertAfter: ex.balance, roomId: room.id, roomName: room.name, memo, minutes: src.pay.minutes, rate: src.pay.rate, suggested: src.pay.suggested });
    addMsg(room, { from: 'sys', text: `${ex.name} 전문가에게 상담 토큰 ${amt}개를 보냈어요 (남은 잔액 ${org.wallet}개)` });
    if (ex.tgChatId) dmExpert(ex, room, `상담 토큰 ${amt}개를 받았어요.${memo ? '\n메시지: ' + memo : ''}\n현재 잔액: ${ex.balance}개`);
    return json(res, 200, { ok: true, wallet: org.wallet });
  }
  if (act === 'call' || act === 'end' || act === 'review') {
    const ex = expertById(b.expertId);
    if (!ex) return BAD(res, '없는 전문가예요', 404);
    if (!ex.tgChatId) return BAD(res, '아직 텔레그램 등록을 마치지 않은 전문가예요');
    if (act === 'end') { if (!(room.humans || []).includes(ex.id)) return BAD(res, '진행 중인 상담이 아니에요'); await endConsult(room, ex); return json(res, 200, { ok: true }); }
    const inRoom = (room.humans || []).includes(ex.id);
    if (!inRoom && !ex.rate) return BAD(res, '아직 시간당 토큰을 정하지 않은 전문가예요');
    if (!inRoom && !ex.available) return BAD(res, '이 전문가는 지금 상담을 받지 않아요');
    let question;
    if (act === 'call') question = str(b.text, 4000);
    else {
      const src = room.msgs.find(x => x.id === b.msgId);
      if (!src) return BAD(res, '없는 메시지예요', 404);
      const who = (BOTS.find(x => x.id === src.from) || {}).name || '봇';
      question = `아래 초안을 검토해 주세요. 사실과 다르거나 과장된 표현이 있는지 봐 주시면 좋아요.\n\n--- ${who} 초안 ---\n${src.text}`;
    }
    // 새 상담인데 잔액이 1시간 단가보다 적으면 바로 연결하지 않고 전문가에게 먼저 물음
    if (!inRoom && org.wallet < ex.rate) {
      const err = await requestCall(room, ex, question);
      return err ? BAD(res, err) : json(res, 200, { ok: true, requested: true });
    }
    await callExpert(room, ex, question);
    return json(res, 200, { ok: true });
  }
  if (act === 'messages') {
    const text = str(b.text, 4000);
    if (!text) return BAD(res, '빈 메시지예요');
    addMsg(room, { from: 'me', text, to: b.to || null });
    if (room.tgChatId) tgSend(room.tgChatId, `[웹앱] ${text}`);
    forwardToExperts(room, text);
    if (b.to && room.bots.includes(b.to)) runBot(room, b.to, text);
    return json(res, 200, { ok: true });
  }
}

// ---------- HTTP 서버 ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  const sess = getSession(req);
  try {
    if (p === '/api/events') {
      const user = sess && sess.kind === 'user' && userById(sess.userId);
      if (!user && !(sess && sess.kind === 'admin')) return BAD(res, '로그인이 필요해요', 401);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.set(res, { orgId: user ? user.orgId : null, admin: !user });
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      return req.on('close', () => { clearInterval(ping); clients.delete(res); });
    }
    if (p.startsWith('/api/admin/')) return await adminApi(req, res, p, sess);
    if (p.startsWith('/api/expert/')) return await expertApi(req, res, p, sess);
    if (p.startsWith('/api/')) return await userApi(req, res, p, sess);
  } catch (e) { console.error(e); return BAD(res, '서버 오류가 났어요', 500); }

  // 게시된 랜딩페이지 (로그인 없이 누구나)
  const sm = p.match(/^\/s\/([a-z0-9-]{3,40})\/?$/);
  if (sm) {
    const org = S.orgs.find(o => o.site && o.site.slug === sm[1] && o.site.published);
    const v = org && siteVersion(org, org.site.published);
    if (!v) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!DOCTYPE html><meta charset="utf-8"><title>없는 페이지</title><p style="font-family:sans-serif;padding:40px">게시된 페이지가 없어요.</p>'); }
    res.writeHead(200, { ...SITE_HEADERS, 'cache-control': 'public, max-age=60' });
    return res.end(v.html);
  }
  const file = path.join(__dirname, 'public', p === '/' ? 'index.html' : p === '/admin' ? 'admin.html' : p === '/expert' ? 'expert.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('없음'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(PORT, () => {
  console.log(`함께봇: http://localhost:${PORT}  ·  관리자: http://localhost:${PORT}/admin`);
  if (!ANTHROPIC_API_KEY) console.log('경고: ANTHROPIC_API_KEY가 없어 봇이 답하지 못합니다.');
  if (!ADMIN_PASSWORD) console.log('경고: ADMIN_PASSWORD가 없어 관리자 페이지에 들어갈 수 없습니다. 기업 계정을 만들려면 꼭 설정하세요.');
  if (TG_TOKEN) pollTelegram(); else console.log('텔레그램: TELEGRAM_BOT_TOKEN이 없어 중계를 끕니다.');
});
// 만료된 세션 정리 (하루 한 번)
setInterval(() => { const now = Date.now(); for (const t in S.sessions) if (S.sessions[t].exp < now) delete S.sessions[t]; save(); }, 864e5).unref();

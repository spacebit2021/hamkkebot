// 함께봇 서버 — 기업별 계정 + Claude 전문가 봇 + 텔레그램 중계 + 사람 전문가 + 상담 토큰
// Node.js 18 이상. 처음 한 번 `npm ci` 후 `node server.js` 로 실행합니다 (PPT용 pptxgenjs·jszip).
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
const DECK = require('./deck');
const SCHED = require('./sched');
const TODO = require('./todo');
const MARKET = require('./market');
// 기본 봇 + 기업이 직접 만든 봇(S.customBots). 직접 만든 봇은 승인된 정의(def)가 있을 때만 쓸 수 있음
const BUILTIN_ROLE = kind => (BOTS.find(b => b.kind === kind) || {}).role || '';
const COMMON_RULES = `\n\n[함께봇 공통 규칙]\n- 기업 정보와 대화에 있는 사실만 쓰세요. 수치·인증·수상·후기·연락처를 지어내지 말고, 모르면 [확인 필요]로 남기세요.\n- 한국어로 답하세요.`;
function customBotObj(c) {
  const d = c.def; if (!d) return null;
  const role = d.role + COMMON_RULES + (d.kind !== 'chat' ? `\n\n[이 종류 봇의 기본 규칙]\n${BUILTIN_ROLE(d.kind)}` : '');
  return { id: c.id, name: d.name, short: d.short, color: d.color, tag: d.tag, desc: d.desc, hello: d.hello, quick: d.quick, kind: d.kind === 'chat' ? undefined : d.kind, ppt: d.ppt, role, custom: true, ownerOrgId: c.orgId, pricing: c.pricing || {} };
}
const botById = id => BOTS.find(b => b.id === id && !b.soon) || (S.customBots && (c => c ? customBotObj(c) : null)(S.customBots.find(x => x.id === id)));
// 이 기업이 쓸 수 있는 봇인지: 기본 봇, 우리 기업이 만든(승인된) 봇, 관리자가 공개한 봇
const canUseBot = (org, id) => { if (BOTS.some(b => b.id === id && !b.soon)) return true; const c = (S.customBots || []).find(x => x.id === id); return !!(c && c.def && !c.discarded && (c.orgId === org.id || c.publicStatus === 'public')); };

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
if (!S.botCosts) S.botCosts = {};
if (!S.posts) S.posts = [];
if (!S.talents) S.talents = [];  // 인재 추천 [{id,orgId,by,at,status:'draft'|'open'|'closed',profile,private:{name,contact},consentBy,picks:[{orgId,at,amount}],hidden}]
if (S.qseq == null) S.qseq = 0;  // 질문 버튼 번호 (텔레그램 /answer 번호)     // 게시판 [{id,board:'qna'|'rec',orgId,by,at,title,body,secret,botId,rating,kind,likes:[orgId],replies:[],hidden,pinned}]
if (!S.claims) S.claims = [];   // 원작 기업의 복사 신고 [{id,at,orgId,origBotId,targetBotId,targetText,want,reason,status,note,decidedAt}]
if (!S.customBots) S.customBots = [];   // 봇 마켓: 기업이 직접 만든 봇           // 관리자가 바꾼 봇별 요청당 토큰 {botId: n}
// 요청당 토큰: 관리자 설정 > bots.js 기본값. 'summary'는 함께봇 문서 정리
const COST_ITEMS = () => [...BOTS.filter(b => !b.soon).flatMap(b => [{ id: b.id, name: b.name, def: b.cost || 0 }, ...(b.extraCosts || [])]), { id: 'summary', name: '함께봇 문서 정리', def: 1 }, { id: 'custom', name: '직접 만든 봇 (글 답변)', def: 1 }, { id: 'custom_ppt', name: '직접 만든 봇 PPT', def: 3 }, { id: 'royalty', name: '복사한 봇의 원작 기업 몫 (원작이 요청당 가격을 안 정했을 때, 요청당)', def: 1 }];
const PPT_RE = /ppt|피피티|파워\s*포인트|발표\s*자료|슬라이드|프레젠테이션|소개\s*자료|덱/i;
const costOf = id => { const v = S.botCosts[id]; if (Number.isInteger(v)) return v; const it = COST_ITEMS().find(x => x.id === id); return it ? it.def : 0; };
// 토큰 미리 잡기 → 성공하면 기록, 실패하면 돌려줌 (동시에 여러 요청이 와도 잔액을 넘지 않게)
// ---------- 기간제 무제한 토큰 (관리자 전용, 기업에는 보이지 않음) ----------
// org.unlimited = { until, refillTo, grantedAt, memo, refills, total }
// 기간 안에는 잔액이 모자라거나 0이 되면 refillTo만큼 다시 채운다. 기업 화면에는 평소처럼 잔액만 보이고,
// 채운 기록은 관리자 거래 기록에만 '무제한 자동 충전'으로 남는다.
const unlimitedActive = org => !!(org && org.unlimited && org.unlimited.until > Date.now());
function ensureFunds(org, need = 1) {
  if (!unlimitedActive(org) || (org.wallet >= need && org.wallet > 0)) return false;
  const u = org.unlimited, target = Math.max(u.refillTo, need), add = target - org.wallet;
  if (add <= 0) return false;
  org.wallet = target; u.refills = (u.refills || 0) + 1; u.total = (u.total || 0) + add;
  S.ledger.push({ id: newId('t'), at: Date.now(), orgId: org.id, orgName: org.name, type: 'refill', amount: add, memo: '무제한(기간제) 자동 충전', walletAfter: org.wallet });
  save(); emit('room', {}, org.id);
  return true;
}
const afterSpend = org => { if (org.wallet <= 0) ensureFunds(org, 1); }; // 다 쓰면 다시 채움
function reserveTokens(org, n) { if (n <= 0) return true; ensureFunds(org, n); if (org.wallet < n) return false; org.wallet -= n; save(); return true; }
function refundTokens(org, n) { if (n > 0) { org.wallet += n; save(); emit('room', {}, org.id); } }
function chargeRecord(org, n, info) { if (n > 0) { record(org, { type: 'bot', amount: n, ...info }); afterSpend(org); } }   // 전문가 팀방(텔레그램 그룹) {chatId: {title, members:[expertId], roomId, list:[roomId]}}
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

// ---------- 운영 기관 몫: 모든 소득(봇 이용 몫·원작 몫·이용권·인재 추천 보상·전문가 상담비)의 10% ----------
const feeRate = () => S.feeRate == null ? 0.1 : S.feeRate;
const feePct = () => Math.round(feeRate() * 100);
// 1토큰 미만은 받는 쪽마다 모아 두었다가 1토큰이 되면 뗌 (작은 금액도 정확히 10%가 되게)
function takeFee(key, amount) {
  S.feeCarry = S.feeCarry || {};
  const c = (S.feeCarry[key] || 0) + amount * feeRate();
  const fee = Math.min(amount, Math.floor(c + 1e-9)); S.feeCarry[key] = c - fee;
  S.platformFees = (S.platformFees || 0) + fee;
  return { fee, net: amount - fee };
}
// 기업이 소득을 받음: 지갑에는 운영 기관 몫을 뺀 만큼, 거래 기록에 받은 것과 운영 기관 몫을 따로
function creditOrg(org, amount, entry) {
  const { fee, net } = takeFee('o:' + org.id, amount);
  org.wallet += net;
  record(org, { ...entry, amount: net, gross: amount, fee });
  if (fee) record(org, { type: 'fee', amount: fee, source: entry.type, gross: amount, botName: entry.botName, talentTitle: entry.talentTitle });
  return { fee, net };
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
// 다른 기업이 만든 봇의 몫을 만든 기업에 보냄 (토큰은 이미 이용 기업 잔액에서 잡아 둔 상태)
// to가 있으면 복사한 봇: 몫은 원작 기업(to.orgId)으로 감
function payShare(fromOrg, c, amount, type, room, to = null) {
  const owner = orgById(to ? to.orgId : c.orgId); if (!owner || amount <= 0) return;
  const name = c.def ? c.def.name : '봇', extra = to ? { originName: to.name || '' } : {};
  record(fromOrg, { type, amount, botId: c.id, botName: name, toOrgName: owner.name, roomId: room && room.id, roomName: room && room.name, ...extra });
  afterSpend(fromOrg);
  const { fee, net } = creditOrg(owner, amount, { type: type + '_in', botId: c.id, botName: name, fromOrgName: fromOrg.name, ...extra });
  const st = to ? to.rec : c;
  if (st) { st.stats = st.stats || { uses: 0, earned: 0, byOrg: {} }; st.stats.earned += net; }
  save();
  return { fee, net, ownerId: owner.id };
}
// ---------- 무단 복사 찾기 · 원작 기업에 몫 보내기 ----------
// 기본 봇·공통 규칙·Claude 안내문에 있는 글은 누구나 쓸 수 있으므로 비교에서 뺌
let COPY_IGNORE = null;
const copyIgnore = () => COPY_IGNORE || (COPY_IGNORE = MARKET.grams([...BOTS.map(b => b.role || ''), COMMON_RULES, MARKET.CLAUDE_PROMPT].join('\n')));
// 이 기업이 올린 역할 지시문이 다른 기업이 먼저 만든 봇을 복사한 것인지 (가장 많이 겹치는 원작, 복사의 복사는 맨 처음 원작으로)
function findOrigin(org, role, self) {
  if (self && self.noAutoOrigin) return null; // 운영 기관이 복사가 아니라고 확인한 봇
  const before = self && self.createdAt ? self.createdAt : Date.now();
  // 겹치는 봇 중 가장 먼저 만든 봇이 원작 (원작을 베낀 글이면 원작이 더 먼저라 원작이 고름)
  const cands = S.customBots.filter(c => c !== self && c.orgId !== org.id && c.createdAt < before).sort((x, y) => x.createdAt - y.createdAt);
  for (const c of cands) {
    if (c.derivedFrom && rootOf(c).orgId === org.id) continue; // 우리 것을 베낀 봇과 겹치는 것은 우리 글
    const roles = [...new Set([...(c.versions || []).map(v => v.def.role), c.def && c.def.role].filter(Boolean))];
    const score = Math.max(0, ...roles.map(r => MARKET.overlap(role, r, copyIgnore()).score));
    if (!score) continue;
    const root = rootOf(c), oorg = orgById(root.orgId); if (!oorg) continue; // 복사본과 겹치면 그 원작으로
    return { botId: root.id, orgId: root.orgId, name: root.def ? root.def.name : '', orgName: oorg.name, score };
  }
  return null;
}
// 원작 연결 (운영 기관 결정)
function linkOrigin(c, root, why) {
  c.derivedFrom = { botId: root.id, orgId: root.orgId, name: root.def ? root.def.name : '', score: null, manual: true, at: Date.now() };
  c.noAutoOrigin = true;
  const roy = royaltyOf(originOf(c)), room = S.rooms.find(r => r.orgId === c.orgId), oroom = S.rooms.find(r => r.orgId === root.orgId);
  if (room) addMsg(room, { from: 'sys', text: `운영 기관이 "${c.def ? c.def.name : '봇'}"을(를) ${(orgById(root.orgId) || {}).name}의 봇을 복사한 것으로 확인했어요${why ? ` (${why})` : ''}. 이 봇을 쓸 때마다 요청당 ${roy}토큰이 원작 기업에 가요.` });
  if (oroom) addMsg(oroom, { from: 'sys', text: `운영 기관이 ${(orgById(c.orgId) || {}).name}의 "${c.def ? c.def.name : '봇'}"을(를) 우리 "${root.def ? root.def.name : '봇'}"의 복사로 연결했어요. 쓰일 때마다 요청당 ${roy}토큰을 받아요.` });
}
// 폐기: 목록·채팅방·공개에서 빼고 다시 쓰거나 고칠 수 없게 (기록은 남김)
function discardBot(c, reason, origin) {
  c.discarded = { at: Date.now(), reason, originBotId: origin ? origin.id : null };
  refundPasses(c, '운영 기관이 폐기');
  c.publicStatus = null; c.pending = null;
  for (const r of S.rooms) if (r.bots.includes(c.id)) { r.bots = r.bots.filter(x => x !== c.id); if (r.orgId !== c.orgId) addMsg(r, { from: 'sys', text: `"${c.def ? c.def.name : '봇'}"이(가) 운영 기관 결정으로 폐기돼 이 방에서 빠졌어요.` }); }
  const room = S.rooms.find(r => r.orgId === c.orgId);
  if (room) addMsg(room, { from: 'sys', text: `운영 기관이 "${c.def ? c.def.name : '봇'}"을(를) 폐기했어요${origin ? ` (${(orgById(origin.orgId) || {}).name}의 봇을 복사한 것으로 확인)` : ''}: ${reason}. 이 봇은 더 쓸 수 없고 업데이트도 할 수 없어요.` });
  if (origin) { const oroom = S.rooms.find(r => r.orgId === origin.orgId); if (oroom) addMsg(oroom, { from: 'sys', text: `운영 기관이 ${(orgById(c.orgId) || {}).name}의 "${c.def ? c.def.name : '봇'}"을(를) 우리 "${origin.def ? origin.def.name : '봇'}"의 복사로 확인하고 폐기했어요.` }); }
}
// 이용권 자동 환불: 봇을 더 쓸 수 없게 되면(폐기·삭제·공개 중단) 남은 기간만큼 날짜 비율로 돌려줌
// 돌려주는 토큰은 이용권 대금을 받았던 기업 지갑에서 빼고, 모자라면 운영 기관이 채움
function refundPasses(c, why) {
  const now = Date.now(), name = c.def ? c.def.name : '봇', done = [];
  const log = c.passLog || [];
  for (const buyerId of Object.keys(c.passes || {})) {
    if (!(c.passes[buyerId] > now)) continue;
    const buyer = orgById(buyerId); if (!buyer) continue;
    let parts = log.filter(p => p.orgId === buyerId && p.until > now && !p.refunded);
    if (!parts.length) { // 기록이 생기기 전에 산 이용권: 지금 가격으로 계산
      const pr = c.pricing || {}, o = originOf(c);
      if (pr.passPrice && pr.passDays) parts = [{ orgId: buyerId, paidTo: o && o.orgId !== buyerId ? o.orgId : c.orgId, amount: pr.passPrice, start: c.passes[buyerId] - pr.passDays * 864e5, until: c.passes[buyerId], estimated: true }];
    }
    let total = 0, days = 0;
    for (const p of parts) {
      const len = p.until - p.start, left = p.until - Math.max(now, p.start);
      const amt = len > 0 ? Math.round(p.amount * Math.min(1, left / len)) : 0;
      p.refunded = { at: now, amount: amt };
      days += Math.ceil(left / 864e5);
      if (amt <= 0) continue;
      total += amt;
      // 받은 기업은 실제로 받았던 몫(운영 기관 몫 제외)만큼, 운영 기관은 떼었던 몫만큼 돌려줌
      const feePart = p.amount ? Math.round(amt * (p.fee || 0) / p.amount) : 0, netPart = amt - feePart;
      if (feePart) { S.platformFees = (S.platformFees || 0) - feePart; record(buyer, { type: 'fee_refund', amount: feePart, botId: c.id, botName: name, reason: why }); }
      const recv = orgById(p.paidTo), fromRecv = recv ? Math.max(0, Math.min(recv.wallet, netPart)) : 0;
      if (recv && fromRecv) { recv.wallet -= fromRecv; record(recv, { type: 'pass_refund_out', amount: fromRecv, botId: c.id, botName: name, toOrgName: buyer.name, reason: why }); afterSpend(recv); }
      if (netPart - fromRecv > 0) record(buyer, { type: 'pass_refund_platform', amount: netPart - fromRecv, botId: c.id, botName: name, fromOrgName: recv ? recv.name : '', reason: why });
      buyer.wallet += amt;
      record(buyer, { type: 'pass_refund', amount: amt, botId: c.id, botName: name, fromOrgName: recv ? recv.name : '운영 기관', reason: why, ...(p.estimated ? { estimated: true } : {}) });
      if (recv && recv.id !== buyer.id) { const rr = S.rooms.find(r => r.orgId === recv.id); if (rr) addMsg(rr, { from: 'sys', text: `"${name}" 이용권 환불로 ${buyer.name}에 ${fromRecv}토큰을 돌려줬어요 (${why})${feePart ? ` (운영 기관 몫 ${feePart}토큰은 운영 기관이 돌려줌)` : ''}${netPart - fromRecv > 0 ? `. 잔액이 모자란 ${netPart - fromRecv}토큰은 운영 기관이 채웠어요` : ''}.` }); }
    }
    delete c.passes[buyerId];
    const br = S.rooms.find(r => r.orgId === buyer.id);
    if (br && total) addMsg(br, { from: 'sys', text: `"${name}" 봇을 더 쓸 수 없게 돼서 (${why}) 이용권 남은 ${days}일분 ${total}토큰을 자동으로 돌려받았어요.` });
    done.push({ orgId: buyer.id, amount: total });
  }
  if (done.length) save();
  return done;
}
// 관리자에게 보여 줄 겹침 비율 (복사 기준에 못 미쳐도 숫자로)
const rawOverlap = (a, b) => { if (!a || !b) return null; const o = MARKET.overlap(a.def.role, b.def.role, copyIgnore()); return Math.round(Math.max(o.cover, o.within) * 100); };
function rootOf(c) { let cur = c; for (let i = 0; i < 5 && cur.derivedFrom; i++) { const nx = S.customBots.find(x => x.id === cur.derivedFrom.botId); if (!nx) break; cur = nx; } return cur; }
const originOf = c => { if (!c.derivedFrom) return null; const rec = S.customBots.find(x => x.id === c.derivedFrom.botId); return { orgId: rec ? rec.orgId : c.derivedFrom.orgId, rec, name: rec && rec.def ? rec.def.name : c.derivedFrom.name }; };
const royaltyOf = o => { const pr = o.rec && o.rec.pricing; return pr && pr.perUse != null ? pr.perUse : costOf('royalty'); };
// 직접 만든 봇을 이 기업이 쓸 때 보낼 몫: 다른 기업 봇이면 만든 기업에, 복사한 봇이면 원작 기업에 (원작 요청당 가격, 없으면 관리자가 정한 기본 몫)
function shareFor(org, c) {
  const now = Date.now(), foreign = c.orgId !== org.id, pr = c.pricing || {}, pass = ((c.passes || {})[org.id] || 0) > now;
  let amount = 0, block = null;
  if (foreign && !pass) { if (pr.perUse == null && pr.passPrice != null) block = `${c.def.name}은(는) 기간 이용권으로만 쓸 수 있어요 (${pr.passDays}일 ${pr.passPrice}토큰). "전문가 초대" 목록에서 이용권을 사 주세요.`; else amount = pr.perUse || 0; }
  const o = originOf(c);
  if (o && orgById(o.orgId)) {
    if (o.orgId === org.id) return { amount: 0, block }; // 원작 기업은 자기 것을 쓰는 셈
    const origPass = o.rec && ((o.rec.passes || {})[org.id] || 0) > now;
    return { amount: Math.max(amount, pass || origPass ? 0 : royaltyOf(o)), type: 'royalty', origin: o, block };
  }
  return { amount, type: 'share', block };
}
// 봇 실행: 토큰을 먼저 잡고 → 답을 받으면 사용 기록, 실패하면 돌려줌
async function runBot(room, botId, text, ctx = {}) {
  const bot = botById(botId);
  if (!bot) return;
  const org = orgById(room.orgId);
  if (!canUseBot(org, bot.id)) { addMsg(room, { from: 'sys', text: `${bot.name}은(는) 지금 쓸 수 없는 봇이에요 (공개가 중단됐거나 승인 전이에요).` }); return; }
  // 봇 종류·요청에 따라 실행할 일과 토큰 항목을 정함 (직접 만든 봇은 종류별 기본 항목을 따름)
  let costId = bot.custom ? (bot.kind === 'site' ? 'site' : 'custom') : bot.id, run;
  const isDeck = !!bot.ppt && PPT_RE.test(text);
  if (bot.kind === 'site') run = () => runSiteBot(bot, room, org, text);
  else if (bot.kind === 'sched') { const mode = schedMode(text); costId = mode === 'detail' ? 'sched_detail' : mode === 'ppt' ? 'sched_ppt' : 'sched'; run = () => runSchedBot(bot, room, org, text, mode, ctx); }
  else if (bot.kind === 'todo') { const mode = ctx.auto ? 'review' : todoMode(text); costId = mode === 'review' ? 'todo_review' : mode === 'detail' ? 'todo_detail' : mode === 'ppt' ? 'todo_ppt' : 'todo'; run = () => runSchedBot(bot, room, org, text, mode, ctx, 'todo'); }
  else if (bot.kind === 'talent') run = () => runTalentBot(bot, room, org, text, ctx);
  else if (bot.kind === 'ir') { const mode = irMode(org, text); costId = mode === 'create' ? 'ir' : mode === 'vc' ? 'ir_vc' : 'ir_update'; run = () => runIrBot(bot, room, org, text, mode); }
  else if (isDeck) { costId = bot.custom ? 'custom_ppt' : `${bot.id}_ppt`; run = () => runDeckBot(bot, room, org, text); }
  else run = () => askClaude(bot, room, text);
  const cost = costOf(costId), costName = bot.custom ? bot.name : (COST_ITEMS().find(c => c.id === costId) || {}).name || bot.name;
  // 다른 기업이 만든 봇: 요청당 몫을 만든 기업에 보냄 (기간 이용권이 있으면 없음, 이용권 전용이면 이용권 필요)
  const cb = bot.custom ? S.customBots.find(x => x.id === bot.id) : null, sh = cb ? shareFor(org, cb) : { amount: 0 };
  if (sh.block) { addMsg(room, { from: 'sys', text: sh.block }); return; }
  const share = sh.amount, shareLabel = sh.type === 'royalty' ? '원작 기업 몫' : '만든 기업 몫';
  const say = (t, extra = {}) => { addMsg(room, { from: bot.id, text: t, ...extra }); if (room.tgChatId) tgSend(room.tgChatId, `[${bot.name}]\n${extra.tgText || t}`); };
  if (!ANTHROPIC_API_KEY) return say('서버에 ANTHROPIC_API_KEY가 설정되지 않아 답할 수 없어요. 관리자에게 알려 주세요.');
  if (!reserveTokens(org, cost + share)) {
    addMsg(room, { from: 'sys', text: `${costName}은(는) 요청당 ${cost + share}토큰을 써요${share ? ` (${shareLabel} ${share} 포함)` : ''}. 지금 잔액(${org.wallet}토큰)이 부족해서 요청하지 않았어요. 관리자에게 충전을 요청해 주세요.` });
    if (room.tgChatId) tgSend(room.tgChatId, `${bot.name}: 토큰 잔액이 부족해요 (필요 ${cost + share}, 잔액 ${org.wallet}).`);
    return;
  }
  if (!ctx.silent) { emit('typing', { roomId: room.id, botId }, room.orgId); if (room.tgChatId) tg('sendChatAction', { chat_id: room.tgChatId, action: 'typing' }); }
  const r = await run();
  if (r.silent) return refundTokens(org, cost + share); // 일정 이야기가 아니었음: 조용히 넘어감
  if (r.error) { refundTokens(org, cost + share); return say(`${r.error}${cost + share ? ' (토큰은 쓰지 않았어요)' : ''}`); }
  if (r.free) { org.botUse = org.botUse || {}; org.botUse[bot.id] = (org.botUse[bot.id] || 0) + 1; refundTokens(org, cost + share); return say(r.text, { ...(r.sched ? { sched: r.sched } : {}), ...(r.todo ? { todo: r.todo } : {}) }); } // 질문·링크 안내는 무료
  chargeRecord(org, cost, { botId: costId, botName: costName, roomId: room.id, roomName: room.name });
  org.botUse = org.botUse || {}; org.botUse[bot.id] = (org.botUse[bot.id] || 0) + 1; // 봇 추천 게시판: 써 본 봇만 추천
  if (bot.custom) { const c = S.customBots.find(x => x.id === bot.id); if (c) { c.stats = c.stats || { uses: 0, earned: 0, byOrg: {} }; c.stats.uses++; c.stats.byOrg[org.id] = (c.stats.byOrg[org.id] || 0) + 1; } }
  if (share) payShare(org, cb, share, sh.type, room, sh.type === 'royalty' ? sh.origin : null);
  say(r.text, { cost: cost + share, ...(r.site ? { site: r.site, tgText: r.tgText } : {}), ...(r.deck ? { deck: r.deck, tgText: r.tgText } : {}), ...(r.ir ? { ir: r.ir, tgText: r.tgText } : {}), ...(r.sched ? { sched: r.sched } : {}), ...(r.todo ? { todo: r.todo } : {}), ...(r.talent ? { talent: r.talent } : {}) });
  if (r.after) r.after();
  if (r.deck && room.tgChatId) { const d = deckById(org, r.deck.id); if (d) tgSendDoc(room.tgChatId, deckFileName(org, d), await DECK.buildDeck(d.outline, org.name), `${d.title} (PPT v${d.n})`, PPTX_MIME); }
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
// ---------- 마케팅 봇 PPT ----------
// org.decks = [{ id, n, at, title, request, outline, docN }] — 파일은 내려받을 때마다 개요로 새로 만든다
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const deckById = (org, id) => (org.decks || []).find(d => d.id === id);
const deckFileName = (org, d) => {
  const clean = t => String(t || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
  const title = clean(d.title || '발표자료').slice(0, 30), name = clean(org.name || '기업');
  return `${title.includes(name) ? title : `${name}_${title}`}_v${d.n}.pptx`; // 제목에 기업명이 있으면 한 번만
};
const DECK_SPEC = `
[PPT 만들기]
이번 요청은 발표자료(PPT)입니다. 아래 형식의 JSON 하나만 출력하세요. JSON 앞뒤에 다른 글이나 코드 블록 표시를 쓰지 마세요.
{"title": "발표자료 제목", "palette": "terracotta|forest|teal|berry|navy|sunflower 중 하나", "slides": [...], "checks": ["기업이 확인할 것", ...]}
- palette: 기업 분위기에 맞게. 먹거리·따뜻함 terracotta, 환경·농업 forest, 돌봄·건강·복지 teal, 문화·예술 berry, 공공·기관 대상 navy, 아동·교육 sunflower.
- 슬라이드 종류(kind)와 칸:
  title {title, subtitle} — 첫 장
  bullets {title, bullets: 2~5개, highlight: 이 장의 핵심 한마디}
  cards {title, items: 2~4개 [{head, text}]} — 제품·서비스, 강점 등 나란히 보여 줄 것
  steps {title, items: 3~5개 [{head, text}]} — 순서가 있는 과정
  message {title, message, caption} — 한 문장으로 강조할 메시지
  closing {title, message, caption} — 마지막 장 (함께하기·문의)
- 모든 슬라이드에 note(발표자 메모, 2~3문장)를 넣으세요.
- 글자 수 상한: title 24자, subtitle 45자, bullet 50자, head 12자, text 50자, highlight 18자, message 60자, caption 50자. 넘치면 잘려요.
- 5~10장. 첫 장은 title, 마지막 장은 closing. 같은 종류를 연달아 세 번 이상 쓰지 마세요.
- [우리 기업]에 있는 사실만 쓰세요. 수치·후기·수상·인증·연락처를 지어내지 말고, 필요한데 없는 정보는 슬라이드에서 빼고 checks에 적으세요(최대 3개).
- 이미 만든 PPT 개요가 있고 수정 요청이면 그 개요를 바탕으로 요청한 부분만 바꾸세요.`;
async function runDeckBot(bot, room, org, text) {
  org.decks = org.decks || [];
  const prev = org.decks[org.decks.length - 1];
  const docV = docCurrent(org);
  const user = `${prev ? `[직전 PPT 개요 v${prev.n} — 수정 요청이면 이것을 바탕으로]\n${JSON.stringify({ title: prev.outline.title, palette: prev.outline.palette, slides: prev.outline.slides })}\n\n` : ''}[이번 요청]\n${text}`;
  const r = await callClaude(`${bot.role}\n\n[우리 기업]\n${orgContext(org)}\n${DECK_SPEC}`, user, 6000);
  if (r.error) return { error: r.error };
  if (r.cut) return { error: 'PPT 개요가 길어 만들다 끊겼어요. 장 수를 줄여 다시 요청해 주세요.' };
  const n = DECK.normalizeOutline(r.text);
  if (n.error) return { error: `PPT를 만들지 못했어요 (${n.error}). 다시 요청해 주세요.` };
  try { await DECK.buildDeck(n.outline, org.name); } catch (e) { console.error('PPT 생성 오류', e); return { error: 'PPT 파일을 만들지 못했어요. 다시 요청해 주세요.' }; }
  const d = { id: newId('k'), n: (prev ? prev.n : 0) + 1, at: Date.now(), title: n.outline.title, request: str(text, 200), outline: n.outline, docN: docV.n };
  org.decks.push(d); if (org.decks.length > 20) org.decks.splice(0, org.decks.length - 20);
  save();
  const list = n.outline.slides.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  const checks = n.outline.checks.length ? `\n\n**확인할 것**\n${n.outline.checks.map(c => '· ' + c).join('\n')}` : '';
  return {
    text: `PPT v${d.n} "${d.title}" ${n.outline.slides.length}장을 만들었어요. (기업 정보 문서 v${docV.n} 기준, 발표자 메모 포함)\n\n${list}${checks}\n\n고칠 점을 말해 주면 이 PPT를 바탕으로 새 버전을 만들어요.`,
    deck: { id: d.id, n: d.n, title: d.title, count: n.outline.slides.length },
    tgText: `PPT v${d.n} "${d.title}" ${n.outline.slides.length}장을 만들었어요. 파일을 함께 보내요.${checks.replace(/\*\*/g, '')}`
  };
}

// ---------- 일정 봇 ----------
// org.sched = { items:[...], log:[...], v, token, updatedAt } — 일정표는 /g/토큰 링크로 로그인 없이 볼 수 있음
const ensureSched = org => org.sched || (org.sched = { items: [], log: [], v: 0, token: crypto.randomBytes(12).toString('hex'), updatedAt: null });
const schedUrl = org => `${PUBLIC_URL ? PUBLIC_URL.replace(/\/$/, '') : ''}/g/${ensureSched(org).token}`;
function schedMode(text) {
  if (PPT_RE.test(text) || /상부\s*보고|보고\s*용|보고서/.test(text)) return 'ppt';
  if (/상세|자세|세부|계획서|체크\s*리스트|준비물|할\s*일\s*목록/.test(text)) return 'detail';
  if (/링크|일정표\s*(보여|줘|어디|주소)|간트/.test(text) && !/추가|연기|미뤄|당겨|취소|변경|바꿔|완료/.test(text)) return 'link';
  return 'change';
}
const todayLine = () => { const t = SCHED.kstDate(); return `오늘은 ${t} (${SCHED.wd(t)}요일), 한국 시간입니다.`; };
const parseJson = t => { try { return JSON.parse(String(t).slice(String(t).indexOf('{'), String(t).lastIndexOf('}') + 1)); } catch (e) { return null; } };
// kind 'todo'이면 할 일 봇: 같은 기능(추가·변경·연기·취소·완료·상세 계획·보고 PPT)을 할 일표(org.todo)에 적용
async function runSchedBot(bot, room, org, text, mode, ctx, kind = 'sched') {
  const T = kind === 'todo';
  const sc = T ? ensureTodo(org) : ensureSched(org), url = T ? todoUrl(org) : schedUrl(org), who = ctx.author || '기업방', source = ctx.source || 'web';
  const W = T ? { box: '할 일표', it: '할 일', ev: 'todo' } : { box: '일정표', it: '일정', ev: 'sched' };
  const card = (u = url) => T ? { todo: { v: sc.v, url: u } } : { sched: { v: sc.v, url: u } };
  const linkNote = PUBLIC_URL ? '' : ' (서버에 PUBLIC_URL을 설정하면 전체 주소로 보여요)';
  if (mode === 'review') return runTodoReview(bot, room, org, text, ctx);
  if (mode === 'edit') return { free: true, text: `할 일표 편집 링크: ${todoEditUrl(org)}${linkNote}\n링크를 아는 사람은 누구나 고칠 수 있어요. 직원들끼리만 나눠 주세요. 기업방 웹앱의 "할 일표 링크 새로 만들기"로 바꿀 수 있어요.`, ...card() };
  if (mode === 'link') {
    if (T) { const t = todayKst(), nx = TODO.upcoming(sc, t); return { free: true, text: `할 일표: ${url}${linkNote}\n고치기: ${todoEditUrl(org)}\n진행 중 ${sc.items.filter(x => x.status === 'active').length}개 · 다음 ${sc.cycle.days}일 점검 ${SCHED.md(nx)} (${TODO.leftText(SCHED.diffDays(t, nx))})`, ...card() }; }
    return { free: true, text: `일정표 (간트차트): ${url}${linkNote}\n지금 일정 ${sc.items.filter(x => x.status === 'active').length}개 · 버전 ${sc.v}`, ...card() };
  }
  if (mode === 'change') {
    const system = `${bot.role}\n${todayLine()}\n\n[현재 ${W.it}]\n${SCHED.listForAi(sc)}\n
아래 메시지가 ${W.it} 추가·변경·연기·당김·취소·완료에 관한 것이면 변경 목록을 만드세요. ${W.it}과(와) 상관없는 대화면 ops를 비우세요.
JSON 하나만 출력: {"ops":[...], "ask":"날짜·대상이 모호할 때만 짧은 질문"}
- 추가: {"op":"add","title":"짧은 제목","start":"YYYY-MM-DD","end":"YYYY-MM-DD","owner":"말에 있을 때만","note":""}
- 날짜·기간·제목·담당 변경, 연기, 당김: {"op":"update","id":"기존 id","start":"YYYY-MM-DD","end":"YYYY-MM-DD","title":"","owner":""} (바뀌는 칸만)
- 취소: {"op":"cancel","id":"","reason":""} / 완료: {"op":"done","id":""} / 취소한 ${W.it} 다시 진행: {"op":"restore","id":""}
- "다음 주 화요일", "3일간" 같은 말은 오늘 기준으로 날짜를 계산하세요. 하루짜리면 start=end.${T ? `
[할 일 규칙] start는 시작일(말이 없으면 오늘), end는 마감일입니다. 마감을 알 수 없으면 ops를 비우고 ask로 마감을 물으세요. owner는 말에 다른 사람이 없으면 말한 사람 "${who}"입니다. "다 했어요", "끝냈어요"는 그 사람의 할 일 완료(done)입니다.` : ''}`;
    const r = await callClaude(system, `[${who}${source === 'telegram' ? ' · 텔레그램' : ' · 기업방'}] ${text}`, 1500);
    if (r.error) return ctx.silent ? { silent: true } : { error: r.error };
    const j = parseJson(r.text) || {};
    if (!Array.isArray(j.ops) || !j.ops.length) {
      if (j.ask) return { free: true, text: `${str(j.ask, 200)}` };
      return ctx.silent ? { silent: true } : { free: true, text: T ? `바꿀 할 일을 찾지 못했어요. "금요일까지 구청 보고서", "보고서 다 했어요", "견적서 다음 주 수요일로 미뤄 줘"처럼 말해 주세요.\n할 일표: ${url}` : `바꿀 일정을 찾지 못했어요. "12/3 구청 회의 추가", "납품 준비 다음 주 월요일로 연기"처럼 말해 주세요.\n일정표: ${url}` };
    }
    const res = SCHED.applyOps(sc, j.ops, who, source);
    if (!res.applied.length) return { free: true, text: `${W.it}을(를) 고치지 못했어요: ${res.errors.join(' / ')}` };
    save(); emit(W.ev, {}, org.id);
    return { text: `${W.box}를 고쳤어요 (버전 ${sc.v})\n${res.applied.map(a => '· ' + a.summary).join('\n')}${res.errors.length ? `\n(적용 못 한 것: ${res.errors.join(' / ')})` : ''}\n\n${W.box}: ${url}${linkNote}`, ...card() };
  }
  if (mode === 'detail') {
    const live = sc.items.filter(x => x.status !== 'cancelled');
    if (!live.length) return { free: true, text: `아직 ${W.it}이 없어요. 먼저 ${W.it}을 올려 주세요.` };
    const system = `${bot.role}\n${todayLine()}\n\n[우리 기업]\n${orgContext(org)}\n\n[현재 ${W.it}]\n${SCHED.listForAi(sc)}\n
요청에 맞는 ${W.it} 하나를 골라 실무자가 바로 쓸 수 있는 상세 계획을 HTML 조각으로 쓰세요.
JSON 하나만 출력: {"id":"${W.it} id","html":"<h4>목표</h4><p>…</p><h4>할 일</h4><table>…날짜·할 일·담당…</table><h4>준비물</h4><ul>…</ul><h4>확인할 것</h4><ul>…</ul>"}
- 쓸 수 있는 태그: h4 p ul ol li b table thead tbody tr th td mark. ${W.it} 기간 안의 날짜로 나누세요.
- ${W.it}·기업 정보에 없는 사실(업체명·금액·연락처)은 지어내지 말고 <mark>[확인 필요: 무엇]</mark>으로 남기세요.`;
    const r = await callClaude(system, text, 3000);
    if (r.error) return { error: r.error };
    const j = parseJson(r.text) || {}, it = sc.items.find(x => x.id === j.id);
    const html = DOC.sanitizeHtml(j.html || '');
    if (!it || !html) return { error: `어느 ${W.it}의 상세 계획인지 정하지 못했어요. 제목을 넣어 다시 요청해 주세요.` };
    it.detail = html;
    sc.v++; sc.updatedAt = Date.now();
    sc.log.unshift({ at: Date.now(), by: who, source, v: sc.v, changes: [`상세 계획 작성: "${it.title}"`] });
    it.history.push({ at: Date.now(), by: who, source, op: 'detail', summary: '상세 계획 작성' });
    save(); emit(W.ev, {}, org.id);
    return { text: `"${it.title}" (${SCHED.range(it)}) 상세 계획을 ${W.box}에 넣었어요 (버전 ${sc.v}).\n${W.box}: ${url}#d-${it.id}${linkNote}`, ...card(`${url}#d-${it.id}`) };
  }
  // 상부 보고용 PPT: 간트 슬라이드는 데이터로 직접 그리고, 나머지 보고 슬라이드는 봇이 씀
  const items = sc.items.slice().sort((a, b) => a.start.localeCompare(b.start));
  if (!items.length) return { free: true, text: `아직 ${W.it}이 없어요. 먼저 ${W.it}을 올려 주세요.` };
  const cnt = { active: items.filter(x => x.status === 'active').length, done: items.filter(x => x.status === 'done').length, cancelled: items.filter(x => x.status === 'cancelled').length };
  const changes = sc.log.slice(0, 15).map(l => `${new Date(l.at + 9 * 36e5).toISOString().slice(5, 10)} ${l.by}: ${l.changes.join('; ')}`).join('\n');
  const lastRv = T && sc.reviews[0] ? `\n\n[최근 ${sc.cycle.days}일 점검 ${sc.reviews[0].from}~${sc.reviews[0].to}]\n${sc.reviews[0].people.map(p => `${p.owner}: ${TODO.statLine(p)}${p.concern ? ' / 살펴볼 점: ' + p.concern : ''}`).join('\n')}` : '';
  const system = `${bot.role}\n${todayLine()}\n\n[우리 기업]\n${orgContext(org)}\n\n[${W.it} 현황] 진행 ${cnt.active} · 완료 ${cnt.done} · 취소 ${cnt.cancelled}\n${SCHED.listForAi(sc)}\n\n[최근 변경]\n${changes || '(없음)'}${lastRv}\n${DECK_SPEC.replace('[PPT 만들기]', '[보고 PPT 만들기]')}
- 상부 보고용입니다. 구성: 표지(title) → 현황 숫자(stats: 진행·완료·취소 — 위 숫자 그대로) → 주요 ${W.it}(table: ${W.it}·기간·담당·상태, 최대 6줄) → 최근 변경·연기 사유(bullets) → 위험·도움이 필요한 점(bullets) → 다음 단계(closing). 간트차트 장은 서버가 따로 넣으니 만들지 마세요. stats·table 종류도 쓸 수 있어요: stats {title, stats:[{value,label}]}, table {title, columns, rows}.`;
  const r = await callClaude(system, text, 5000);
  if (r.error) return { error: r.error };
  const n = DECK.normalizeOutline(r.text);
  if (n.error) return { error: `보고 PPT를 만들지 못했어요 (${n.error}). 다시 요청해 주세요.` };
  const ganttSlides = [];
  for (let i = 0; i < items.length; i += 10) ganttSlides.push({ kind: 'gantt', title: items.length > 10 ? `${W.it} 간트차트 (${i / 10 + 1})` : `${W.it} 간트차트`, items: items.slice(i, i + 10).map(x => ({ label: x.title, start: x.start, end: x.end, status: x.status, owner: x.owner })), today: SCHED.kstDate(), note: `간트차트는 ${W.box} 데이터로 그렸습니다.` });
  n.outline.slides.splice(1, 0, ...ganttSlides);
  try { await DECK.buildDeck(n.outline, org.name); } catch (e) { console.error(e); return { error: '보고 PPT 파일을 만들지 못했어요.' }; }
  org.decks = org.decks || [];
  const prev = org.decks[org.decks.length - 1];
  const d = { id: newId('k'), n: (prev ? prev.n : 0) + 1, at: Date.now(), title: n.outline.title, request: str(text, 200), outline: n.outline, docN: docCurrent(org).n, kind };
  org.decks.push(d); if (org.decks.length > 20) org.decks.splice(0, org.decks.length - 20); save();
  return { text: `상부 보고용 ${W.it} PPT "${d.title}" ${n.outline.slides.length}장을 만들었어요 (${W.box} 버전 ${sc.v} 기준, 간트차트 ${ganttSlides.length}장 포함).`, deck: { id: d.id, n: d.n, title: d.title, count: n.outline.slides.length }, tgText: `보고 PPT "${d.title}"를 만들었어요. 파일을 함께 보내요.` };
}

// ---------- 할 일 봇 ----------
// org.todo = 일정 봇과 같은 items·log·v + { token(보기), editToken(고치기), cycle:{start,days,hour,weekdays}, reviews:[], lastMorning, lastReview }
const nowMs = () => +process.env.HB_NOW || Date.now(); // 시험에서 시각을 바꿀 수 있게
const todayKst = () => SCHED.kstDate(nowMs());
const ensureTodo = org => org.todo || (org.todo = { items: [], log: [], v: 0, token: crypto.randomBytes(12).toString('hex'), editToken: crypto.randomBytes(16).toString('hex'), updatedAt: null, cycle: TODO.defaultCycle(todayKst()), reviews: [], lastMorning: null, lastReview: null });
const baseUrl = () => PUBLIC_URL ? PUBLIC_URL.replace(/\/$/, '') : '';
const todoUrl = org => `${baseUrl()}/t/${ensureTodo(org).token}`;
const todoEditUrl = org => `${baseUrl()}/te/${ensureTodo(org).editToken}`;
const REVIEW_RE = /(점검|피드백|리뷰|검사)\s*(해|좀|받|부탁|시작|돌려|줘)|^\s*(지금\s*)?(\d+\s*주\s*)?(할\s*일\s*)?(점검|피드백|리뷰|검사)\s*$/;
function todoMode(text) {
  if (/링크|보여|어디|주소/.test(text) && !/편집|고치는|수정|추가|연기|미뤄|당겨|취소|완료|바꿔|변경|까지/.test(text)) return 'link';
  if (REVIEW_RE.test(text) && !/추가|연기|미뤄|당겨|취소|완료|마감|까지/.test(text)) return 'review';
  if (/편집|고치는|수정/.test(text) && /링크|주소|페이지/.test(text)) return 'edit';
  if (PPT_RE.test(text) || /상부\s*보고|보고\s*용/.test(text)) return 'ppt';
  if (/상세|자세|세부|계획서|체크\s*리스트|준비물/.test(text) && !/까지|마감/.test(text)) return 'detail';
  return 'change';
}
async function runTodoReview(bot, room, org, text, ctx) {
  const td = ensureTodo(org), today = todayKst(), days = td.cycle.days;
  const from = addDaysK(today, -days), url = todoUrl(org);
  const stats = TODO.reviewStats(td, from, today);
  if (!stats.length) return { free: true, text: `점검할 할 일이 없어요 (${SCHED.md(from)}–${SCHED.md(today)}). 텔레그램에서 "/todo 금요일까지 구청 보고서"처럼 올려 주세요.` };
  const system = `${bot.role}\n${todayLine()}\n\n[점검 기간] ${from} ~ ${today} (${days}일)\n[사람별 할 일과 숫자 — 숫자는 서버가 계산한 것]\n${TODO.forAi(stats, today)}\n
사람별로 짧은 피드백을 쓰세요. JSON 하나만 출력: {"summary":"팀 전체 한두 문장","people":[{"owner":"위 이름 그대로","good":"잘한 점 한 문장","concern":"살펴볼 점 한 문장(마감 지남·잦은 연기·마감 없는 큰 일 등)","next":"다음 ${days}일 제안 한 문장"}]}
- 위 목록에 있는 사실만 쓰세요. 숫자를 새로 만들거나 바꾸지 마세요. 사람을 탓하는 말 대신 도울 방법을 쓰세요.
- 해당하는 내용이 없으면 그 칸은 빈 문자열로 두세요.`;
  const r = await callClaude(system, text, 2500);
  if (r.error) return { error: r.error };
  const j = parseJson(r.text) || {};
  const fb = new Map((Array.isArray(j.people) ? j.people : []).map(p => [String(p && p.owner || ''), p]));
  const people = stats.map(p => { const f = fb.get(p.owner) || {}; return { owner: p.owner, done: p.done, added: p.added, postponed: p.postponed, active: p.active, overdue: p.overdue, good: str(f.good, 200), concern: str(f.concern, 200), next: str(f.next, 200) }; });
  const rv = { id: newId('r'), at: Date.now(), from, to: today, days, next: TODO.nextReview(td.cycle, addDaysK(today, 1)), auto: !!ctx.auto, by: ctx.author || '기업방', summary: str(j.summary, 300), people };
  td.reviews.unshift(rv); td.reviews = td.reviews.slice(0, 30);
  td.lastReview = today; td.v++; td.updatedAt = Date.now();
  td.log.unshift({ at: Date.now(), by: rv.by, source: ctx.auto ? 'auto' : (ctx.source || 'web'), v: td.v, changes: [`${days}일 점검 (${SCHED.md(from)}–${SCHED.md(today)})`] });
  save(); emit('todo', {}, org.id);
  return { text: TODO.reviewText(rv, url), todo: { v: td.v, url: `${url}#rv` } };
}
const addDaysK = (d, n) => SCHED.addDays(d, n);
// 매분: 정한 시각이 지나면 하루 한 번 아침 알림, 점검일이면 점검 먼저
const todoRooms = org => S.rooms.filter(r => r.orgId === org.id && r.bots.includes('todo'));
async function todoTick() {
  const now = nowMs(), today = SCHED.kstDate(now), hour = new Date(now + 9 * 36e5).getUTCHours(), wdN = new Date(now + 9 * 36e5).getUTCDay();
  for (const org of S.orgs) {
    const td = org.todo, rooms = td ? todoRooms(org) : [];
    if (!td || !rooms.length || !td.items.length || hour < td.cycle.hour || td.lastMorning === today) continue;
    td.lastMorning = today; save();
    const reviewDay = TODO.nextReview(td.cycle, today) === today;
    if (td.cycle.weekdays && (wdN === 0 || wdN === 6) && !reviewDay) continue;
    const bot = botById('todo'), text = TODO.morningText(td, today, todoUrl(org));
    for (const room of rooms) { addMsg(room, { from: 'todo', text, todo: { v: td.v, url: todoUrl(org) } }); if (room.tgChatId) tgSend(room.tgChatId, `[${bot.name}]\n${text}`); }
    if (reviewDay && td.lastReview !== today) await runBot(rooms[0], 'todo', `${td.cycle.days}일 점검`, { auto: true, author: '할 일 봇 (자동)', source: 'auto' });
  }
}
setInterval(() => todoTick().catch(e => console.error(e)), +process.env.TODO_TICK_MS || 60000).unref();

// ---------- IR 봇 ----------
// org.ir = { versions:[{id,n,at,outline,note,request}], comments:[{id,versionN,slide,slideTitle,text,by,at,status,reply}], final:{id,n,at}|null, reviewers:[expertId], vcs:[{at,request,items,dropped,note}] }
const ensureIr = org => org.ir || (org.ir = { versions: [], comments: [], final: null, reviewers: [], vcs: [] });
const irLatest = org => { const v = ensureIr(org).versions; return v[v.length - 1]; };
const VC_RE = /\bvc\b|투자사|벤처\s*캐피|투자자|액셀러레이터|임팩트\s*투자|투자\s*기관/i;
function irMode(org, text) {
  if (VC_RE.test(text) && /찾|검색|추천|리스트|목록|알려/.test(text)) return 'vc';
  if (!irLatest(org) || /새로\s*만들|처음부터/.test(text)) return 'create';
  return 'update';
}
const IR_SPEC = `
[IR 자료 만들기]
투자자용 IR 자료(10~14장) 개요를 JSON 하나로만 출력하세요. JSON 앞뒤에 다른 글이나 코드 블록 표시를 쓰지 마세요.
{"title": "IR 자료 제목", "palette": "navy|teal|forest|terracotta|berry|sunflower", "slides": [...], "checks": ["기업이 확인할 것", ...], "resolved": [{"id": "코멘트 id", "reply": "어떻게 반영했는지 한 줄"}]}
- 권장 흐름: 표지(title) → 한 줄 요약(message) → 문제(bullets) → 해결·제품(cards) → 시장(stats 또는 bullets) → 비즈니스 모델(steps 또는 cards) → 성과·트랙션(stats) → 경쟁 비교(table) → 소셜 임팩트(cards 또는 stats) → 팀(cards) → 재무 계획(table) → 투자 유치 계획(bullets: 금액·용도·시기) → 마무리(closing). 정보가 전혀 없는 장은 빼도 됩니다.
- 슬라이드 종류(kind)와 칸:
  title {title, subtitle} / message {title, message, caption} / bullets {title, bullets: 2~5개, highlight}
  cards {title, items: 2~4개 [{head, text}]} / steps {title, items: 3~5개 [{head, text}]}
  stats {title, stats: 2~4개 [{value, label}], caption} — value는 짧은 숫자·단위 (예: "월 200개")
  table {title, columns: 2~5개, rows: 1~6줄 (각 줄은 columns 수만큼)} / closing {title, message, caption}
- 모든 슬라이드에 note(발표자 메모 2~3문장).
- 글자 수 상한: title 24자, subtitle 45자, bullet 50자, head 12자, text 50자, highlight 18자, message 60자, value 10자, label 22자, 표 칸 22자.
- 숫자(시장 규모, 매출, 고객 수, 성장률, 투자 금액, 기업가치)는 [우리 기업]이나 코멘트에 있는 것만 쓰세요. 없으면 그 자리에 "[확인 필요: 무엇]"을 그대로 쓰고 checks에도 적으세요(최대 3개). 시장 규모를 추정해서 만들지 마세요.
- [반영할 코멘트]가 있으면 반영하고, 반영한 것만 resolved에 id와 반영 내용을 한 줄로 적으세요. 사실 확인이 필요해 반영하지 못한 코멘트는 resolved에 넣지 마세요.
- [직전 IR 개요]가 있으면 그것을 바탕으로 요청·코멘트에 해당하는 부분만 바꾸세요.`;
const irAccess = (ex, org) => !!(ex && org && org.ir && (org.ir.reviewers.includes(ex.id) || S.rooms.some(r => r.orgId === org.id && (r.humans || []).includes(ex.id))));
const irOrgsFor = ex => S.orgs.filter(o => o.ir && o.ir.versions.length && irAccess(ex, o));
const emitIrx = org => { for (const e of S.experts) if (irAccess(e, org)) emit('irx', { orgId: org.id }, 'expert:' + e.id); };
const irRoom = org => S.rooms.find(r => r.orgId === org.id && r.bots.includes('ir')) || S.rooms.find(r => r.orgId === org.id);
// 전문가 페이지로 바로 들어가는 1회용 로그인 코드 (10분)
function expertLoginCode(ex) {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  S.expertLogins[code] = { expertId: ex.id, exp: Date.now() + 10 * 60000 }; save();
  return code;
}
const expertLink = (ex, hash) => { const code = expertLoginCode(ex); return PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/expert?code=${code}${hash ? '#' + hash : ''}` : `웹의 /expert 페이지에서 코드 ${code} 입력 (10분 안에)`; };
async function notifyIrExperts(org, text, only) {
  if (!org.ir) return;
  const exs = S.experts.filter(e => e.tgChatId && irAccess(e, org) && (!only || only.includes(e.id)));
  for (const e of exs) {
    const j = await tg('sendMessage', { chat_id: e.tgChatId, text: `[${org.name} IR]\n${text}\n\n보기·코멘트: ${expertLink(e, 'ir-' + org.id)}\n텔레그램에서 바로 코멘트: 이 메시지에 답장으로 /irc 장번호 내용` });
    if (j && j.ok) { (S.irMap = S.irMap || {})[`${e.tgChatId}:${j.result.message_id}`] = org.id; save(); }
  }
}
function addIrComment(org, slide, text, by) {
  const ir = ensureIr(org), v = irLatest(org);
  if (!v) return { error: '아직 IR 자료가 없어요' };
  const i = Number(slide);
  if (!Number.isInteger(i) || i < 0 || i >= v.outline.slides.length) return { error: `장 번호는 1~${v.outline.slides.length} 사이로 적어 주세요` };
  const t = str(text, 500); if (!t) return { error: '코멘트 내용을 적어 주세요' };
  const c = { id: newId('c'), versionN: v.n, slide: i, slideTitle: v.outline.slides[i].title, text: t, by, at: Date.now(), status: 'open', reply: '' };
  ir.comments.push(c); if (ir.comments.length > 500) ir.comments.splice(0, ir.comments.length - 500);
  save(); emit('ir', {}, org.id); emitIrx(org);
  const room = irRoom(org);
  if (room && by.kind === 'expert') addMsg(room, { from: 'sys', text: `${by.name} 전문가가 IR ${i + 1}장 "${c.slideTitle}"에 코멘트를 남겼어요. IR 봇에게 "코멘트 반영"을 요청하면 고쳐요.` });
  return { comment: c };
}
// 텔레그램: /ir — 볼 수 있는 IR 자료 링크, /irc 장번호 내용 — 코멘트
async function handleIrCmd(ex, msg, cmd, arg, teamOrg) {
  const orgs = irOrgsFor(ex);
  const mapped = msg.reply_to_message && S.irMap && S.irMap[`${msg.chat.id}:${msg.reply_to_message.message_id}`];
  const org = (mapped && orgs.find(o => o.id === mapped)) || (teamOrg && orgs.includes(teamOrg) ? teamOrg : null) || (orgs.length === 1 ? orgs[0] : null);
  if (cmd === 'ir') {
    if (!orgs.length) return tgSend(msg.chat.id, '볼 수 있는 IR 자료가 없어요. 기업이 검토 전문가로 초대하거나 상담 중일 때 볼 수 있어요.');
    for (const o of org ? [org] : orgs) {
      const v = irLatest(o);
      const j = await tg('sendMessage', { chat_id: msg.chat.id, text: `[${o.name} IR] v${v.n} "${v.outline.title}" ${v.outline.slides.length}장${o.ir.final ? ` · v${o.ir.final.n} 최종 확정됨` : ''}\n보기·코멘트: ${expertLink(ex, 'ir-' + o.id)}\n텔레그램에서 코멘트: 이 메시지에 답장으로 /irc 장번호 내용` });
      if (j && j.ok) { (S.irMap = S.irMap || {})[`${msg.chat.id}:${j.result.message_id}`] = o.id; save(); }
    }
    return;
  }
  if (!org) return tgSend(msg.chat.id, orgs.length ? '어느 기업의 IR인지 모르겠어요. /ir 로 받은 메시지에 답장으로 /irc 장번호 내용 을 보내 주세요.' : '코멘트를 남길 수 있는 IR 자료가 없어요.');
  const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
  if (!m) return tgSend(msg.chat.id, '형식: /irc 장번호 내용  (예: /irc 5 시장 규모 출처를 적어 주세요)');
  const r = addIrComment(org, Number(m[1]) - 1, m[2], { kind: 'expert', name: ex.name, id: ex.id });
  return tgSend(msg.chat.id, r.error || `${org.name} IR ${m[1]}장 "${r.comment.slideTitle}"에 코멘트를 남겼어요. 기업이 반영하면 알려 드릴게요.`);
}
async function runIrBot(bot, room, org, text, mode) {
  const ir = ensureIr(org);
  if (mode === 'vc') return runVcSearch(bot, org, text);
  const prev = mode === 'update' ? irLatest(org) : null;
  const open = prev ? ir.comments.filter(c => c.status === 'open') : [];
  const user = `${prev ? `[직전 IR 개요 v${prev.n}]\n${JSON.stringify({ title: prev.outline.title, palette: prev.outline.palette, slides: prev.outline.slides })}\n\n` : ''}${open.length ? `[반영할 코멘트]\n${open.map(c => `- id ${c.id} (v${c.versionN} ${c.slide + 1}장 "${c.slideTitle}", ${c.by.name}${c.by.kind === 'expert' ? ' 전문가' : ''}): ${c.text}`).join('\n')}\n\n` : ''}[이번 요청]\n${text}`;
  const r = await callClaude(`${bot.role}\n\n[우리 기업]\n${orgContext(org)}\n${IR_SPEC}`, user, 8000);
  if (r.error) return { error: r.error };
  if (r.cut) return { error: 'IR 개요가 길어 만들다 끊겼어요. 장 수를 줄여 다시 요청해 주세요.' };
  const nrm = DECK.normalizeOutline(r.text);
  if (nrm.error) return { error: `IR 자료를 만들지 못했어요 (${nrm.error}). 다시 요청해 주세요.` };
  let resolved = [];
  try { const raw = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); resolved = Array.isArray(raw.resolved) ? raw.resolved : []; } catch (e) {}
  const v = { id: newId('i'), n: ((irLatest(org) || {}).n || 0) + 1, at: Date.now(), outline: nrm.outline, request: str(text, 200), note: '' };
  const applied = [];
  for (const x of resolved) { const c = open.find(o => o.id === (x && x.id)); if (c) { c.status = 'applied'; c.reply = str(x.reply, 200); c.appliedIn = v.n; applied.push(c); } }
  v.note = applied.length ? `코멘트 ${applied.length}개 반영` : mode === 'create' ? '초안' : '수정';
  ir.versions.push(v); if (ir.versions.length > 30) ir.versions.splice(0, ir.versions.length - 30);
  save(); emit('ir', {}, org.id); emitIrx(org);
  const marks = nrm.outline.slides.reduce((a, s) => a + (JSON.stringify(s).match(/\[확인 필요/g) || []).length, 0);
  const left = ir.comments.filter(c => c.status === 'open').length;
  const checks = nrm.outline.checks.length ? `\n\n**확인할 것**\n${nrm.outline.checks.map(c => '· ' + c).join('\n')}` : '';
  const summary = `IR v${v.n} "${v.outline.title}" ${v.outline.slides.length}장을 ${mode === 'create' ? '만들었어요' : '고쳤어요'}.${applied.length ? ` 코멘트 ${applied.length}개를 반영했어요.` : ''}${left ? ` 반영하지 않은 코멘트 ${left}개는 그대로 남겨 뒀어요(사실 확인 필요 등).` : ''}${marks ? `\n[확인 필요] 표시 ${marks}곳이 있어요. 채워 넣어야 최종 확정할 때 경고가 사라져요.` : ''}`;
  return {
    text: `${summary}${checks}\n\n"IR 자료" 화면에서 웹 슬라이드로 보고, 검토 전문가를 초대해 장별 코멘트를 받을 수 있어요.`,
    ir: { n: v.n, title: v.outline.title, count: v.outline.slides.length, applied: applied.length },
    tgText: summary,
    after: () => notifyIrExperts(org, `IR v${v.n}이 올라왔어요${applied.length ? ` (코멘트 ${applied.length}개 반영: ${applied.map(c => c.by.name).filter((x, i, a) => a.indexOf(x) === i).join(', ')})` : ''}.`)
  };
}

// 웹 검색 도구를 쓰는 Claude 호출: 검색 결과 URL을 모아 두었다가, 답에 나온 출처가 실제 검색 결과인지 확인할 때 씀
async function callClaudeSearch(system, user, maxTokens = 4000) {
  if (!ANTHROPIC_API_KEY) return { error: '서버에 ANTHROPIC_API_KEY가 설정되지 않아 검색할 수 없어요.' };
  const messages = [{ role: 'user', content: user }], urls = new Set();
  let text = '';
  try {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' } }] })
      });
      const j = await r.json();
      if (!r.ok) { console.error('Claude 검색 오류', r.status, j); return { error: r.status === 429 ? '요청이 많아 잠시 쉬어야 해요. 1분 뒤 다시 시도해 주세요.' : '검색 답변을 받지 못했어요. 다시 시도해 주세요.' }; }
      for (const blk of j.content || []) {
        if (blk.type === 'web_search_tool_result' && Array.isArray(blk.content)) blk.content.forEach(x => x.url && urls.add(x.url));
        if (blk.type === 'text') { text += blk.text; (blk.citations || []).forEach(c => c.url && urls.add(c.url)); }
      }
      if (j.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: j.content }); continue; } // 긴 검색은 이어서 진행
      break;
    }
  } catch (e) { console.error(e); return { error: '검색 중 네트워크 오류가 났어요.' }; }
  return { text, urls };
}
const sameSource = (a, urls) => { if (!/^https?:\/\//.test(a || '')) return false; const n = u => u.replace(/[#?].*$/, '').replace(/\/$/, ''); return [...urls].some(u => n(u) === n(a) || n(a).startsWith(n(u)) || n(u).startsWith(n(a))); };
async function runVcSearch(bot, org, text) {
  const ir = ensureIr(org);
  const system = `${bot.role}

[VC 찾기]
웹 검색으로 이 기업에 맞는 투자사(VC·임팩트 투자사·액셀러레이터)를 찾으세요. 한국 투자사를 우선하세요.
- 검색 결과에서 실제로 확인한 곳만 쓰세요. 이름·투자 분야·단계는 출처 페이지에 나온 내용만. 연락처·담당자·투자 조건을 지어내지 마세요.
- 각 투자사마다 근거가 된 검색 결과 페이지 URL을 source에 그대로 넣으세요.
- 마지막에 JSON 하나만 출력하세요: {"vcs":[{"name":"","focus":"투자 분야 (출처 기준)","stage":"투자 단계 (출처에 없으면 빈칸)","why":"이 기업과 맞는 이유 한 줄","source":"URL"}], "note":"찾는 방법·주의할 점 한두 줄"}
- 5~8곳.`;
  const r = await callClaudeSearch(system, `[우리 기업]\n${orgContext(org)}\n\n[요청]\n${text}`);
  if (r.error) return { error: r.error };
  let raw;
  try { raw = JSON.parse(r.text.slice(r.text.lastIndexOf('{"vcs"') >= 0 ? r.text.lastIndexOf('{"vcs"') : r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch (e) { return { error: 'VC 목록을 읽지 못했어요. 다시 요청해 주세요.' }; }
  const all = (Array.isArray(raw.vcs) ? raw.vcs : []).slice(0, 10).map(x => ({ name: str(x.name, 60), focus: str(x.focus, 120), stage: str(x.stage, 60), why: str(x.why, 160), source: str(x.source, 400) })).filter(x => x.name);
  const items = all.filter(x => sameSource(x.source, r.urls)); // 출처가 실제 검색 결과에 없으면 뺌
  const dropped = all.length - items.length;
  if (!items.length) return { error: `출처를 확인할 수 있는 투자사를 찾지 못했어요${dropped ? ` (출처가 확인되지 않은 ${dropped}곳은 뺐어요)` : ''}. 조건을 바꿔 다시 요청해 주세요.` };
  ir.vcs.unshift({ at: Date.now(), request: str(text, 200), items, dropped, note: str(raw.note, 300), searched: r.urls.size });
  ir.vcs = ir.vcs.slice(0, 5); save(); emit('ir', {}, org.id);
  const list = items.map((x, i) => `${i + 1}. **${x.name}** — ${x.focus}${x.stage ? ` · ${x.stage}` : ''}\n   ${x.why}\n   출처: ${x.source}`).join('\n');
  return {
    text: `웹 검색으로 찾은 투자사 ${items.length}곳이에요.${dropped ? ` (출처가 검색 결과로 확인되지 않은 ${dropped}곳은 뺐어요)` : ''}\n\n${list}\n\n투자 분야·단계는 출처 페이지 기준이고 바뀌었을 수 있어요. 연락 전에 각 투자사 홈페이지에서 직접 확인해 주세요.${raw.note ? `\n${str(raw.note, 300)}` : ''}`,
    ir: { vc: true, count: items.length },
    tgText: `투자사 ${items.length}곳을 찾았어요. 목록과 출처는 웹앱 IR 화면에서 볼 수 있어요.`
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
async function tgSendDoc(chatId, filename, content, caption, mime = 'text/html') {
  if (!TG_TOKEN) return null;
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', caption.slice(0, 1000));
    fd.append('document', new Blob([content], { type: mime }), filename);
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
    ensureFunds(org, opt.rate);
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
    if (unlimitedActive(org)) { ensureFunds(org, suggestTokens(minutes, c.rate) + c.rate); continue; } // 무제한이면 경고 대신 조용히 채움
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
  if (cmd === 'ir' || cmd === 'irc') return handleIrCmd(ex, msg, cmd, msg.text.replace(/^\/\w+(@\w+)?\s*/, ''), null);
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
/ir · /irc 장번호 내용 — 연결된 기업의 IR 자료 보기·코멘트
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
  if (cmd === 'ir' || cmd === 'irc') return handleIrCmd(ex, msg, cmd, arg, room ? orgById(room.orgId) : null);
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

const EXPERT_CMDS = '/ir IR 자료 보기 · /irc 장번호 내용 IR 코멘트\n/info 기업 정보 문서 받기 · /ask 질문 기업 정보 묻기 · 고친 HTML 파일을 올리면 기업이 승인 후 반영\n/login 프로필 편집 · /rate 숫자 시간당 토큰 · /on /off 상담 받기 켜기·끄기\n/rooms 진행 중인 상담 · /end 상담 종료 · /balance 받은 토큰';
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

  // 관리자 답변 단톡 연결·처리
  if (cmd === 'adminlink') {
    const L = S.adminLink;
    if (isPrivate) return tgSend(chat.id, '관리자 답변 방은 그룹에서 연결해 주세요.');
    if (!L || L.code !== arg.toUpperCase() || L.exp < Date.now()) return tgSend(chat.id, '코드가 맞지 않거나 시간이 지났어요. 관리자 페이지에서 새 코드를 만들어 주세요.');
    if (roomByChat(chat.id) || S.expertGroups[chat.id]) return tgSend(chat.id, '기업 방이나 전문가 팀방으로 쓰는 그룹은 관리자 답변 방으로 쓸 수 없어요.');
    S.adminTg = { chatId: chat.id, title: chat.title || '', linkedAt: Date.now(), by: name }; S.adminLink = null; save(); emit('room', {}, '*');
    return tgSend(chat.id, `이 그룹을 관리자 답변 방으로 연결했어요. 기업이 질문 버튼으로 물으면 여기로 와요.\n${ADMIN_TG_HELP}`);
  }
  if (S.adminTg && chat.id === S.adminTg.chatId) return handleAdminGroup(msg, cmd, arg, name);
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
    const teamCmds = ['team', 'rooms', 'use', 'send', 's', 'end', 'detach', 'join', 'info', 'ask', 'ir', 'irc'];
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
  // 일정 봇이 있는 방: 일정 이야기로 보이는 메시지는 명령 없이도 알아서 반영 (아니면 조용히 넘어감)
  // 할 일 봇이 있는 방: 할 일로 보이는 말은 보낸 사람의 할 일로 반영 (일정 봇도 있으면 "할 일·todo"라고 쓴 것만)
  const todoWord = /할\s*일|할일|todo|투두/i.test(text);
  if (!botId && room.bots.includes('todo') && TODO.TODO_RE.test(text) && (todoWord || !room.bots.includes('sched'))) return runBot(room, 'todo', text, { author: name, source: 'telegram', silent: true });
  if (!botId && room.bots.includes('sched') && SCHED.SCHED_RE.test(text)) return runBot(room, 'sched', text, { author: name, source: 'telegram', silent: true });
  if (botId) {
    if (!room.bots.includes(botId)) { room.bots.push(botId); addMsg(room, { from: 'sys', text: `${botById(botId).name}이(가) 텔레그램에서 호출돼 방에 들어왔어요` }); }
    const kind = botById(botId).kind;
    runBot(room, botId, ask || (kind === 'sched' ? '일정표 링크 보여 줘' : kind === 'todo' ? '할 일표 링크 보여 줘' : '자기소개를 해 주세요'), { author: name, source: 'telegram' });
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
    { command: 'team', description: '(전문가) 이 그룹을 전문가 팀방으로' }, { command: 'send', description: '(전문가 팀방) 기업에게 보내기' }, { command: 'use', description: '(전문가 팀방) 상담 연결' }, { command: 'join', description: '(전문가 팀방) 상담 참여 요청' }, { command: 'info', description: '(전문가) 기업 정보 문서 받기' }, { command: 'ir', description: '(전문가) IR 자료 보기' }, { command: 'irc', description: '(전문가) IR 코멘트: 장번호 내용' }, { command: 'ask', description: '(전문가) 기업 정보 묻기' },
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
// ---------- 인재 추천 봇 ----------
// 다른 기업에는 경력·기술만 보여 주고, 이름·연락처는 그 인재를 고른 기업에만. 본인 동의를 확인해야 올라감
const SENSITIVE_RE = /\d{6}\s*-\s*[1-4]\d{6}|주민\s*(등록)?\s*번호|여권\s*번호|계좌\s*번호/;
const talentConsentUrl = t => `${baseUrl()}/c/${t.consentToken}`;
const cleanList = (a, n, len) => (Array.isArray(a) ? a : []).map(v => str(v, len)).filter(Boolean).slice(0, n);
function talentView(org, t) {
  const picked = t.picks.find(p => p.orgId === org.id), mine = t.orgId === org.id;
  return { id: t.id, at: t.at, status: t.status, hidden: !!t.hidden, orgName: (orgById(t.orgId) || {}).name || '', mine, profile: t.profile, picks: t.picks.length, picked: !!picked, fee: costOf('talent_pick'), ...(mine || picked ? { private: t.private } : {}), ...(mine ? { earned: t.picks.reduce((a, p) => a + p.amount, 0), pickedBy: t.picks.map(p => (orgById(p.orgId) || {}).name), consentAt: t.consentAt || null, ...(t.status === 'awaiting' ? { consentUrl: talentConsentUrl(t), consentExp: t.consentExp } : {}) } : {}) };
}
async function runTalentBot(bot, room, org, text, ctx) {
  if (SENSITIVE_RE.test(text)) return { error: '주민등록번호·여권번호·계좌번호 같은 정보는 받지 않아요. 그 부분을 빼고 다시 보내 주세요.' };
  const system = `${bot.role}

아래 메시지에서 추천하는 인재 한 명의 정보를 뽑으세요. JSON 하나만 출력:
{"ok":true,"profile":{"title":"한 줄 소개 (예: 패키지 디자이너 · 3년차)","field":"분야","years":"경력 (말에 있을 때만, 예: 3년)","skills":["기술·도구"],"summary":"어떤 일을 잘하는지 2~3문장","region":"일할 수 있는 지역 (말에 있을 때만)","workType":"정규직·계약직·프리랜서·파트타임 등 (말에 있을 때만)","strengths":["추천하는 기업이 본 강점"]},"private":{"name":"이름","contact":"전화·이메일 등 연락 방법"},"consent":true|false}
- consent: 추천하는 사람이 "본인 동의를 받았다"고 분명히 말했을 때만 true.
- 인재 정보가 부족하면 {"ok":false,"ask":"더 필요한 것 한 문장"}.
- 나이·생년·성별·결혼·가족·건강·종교·출신·사진·주민번호·주소 상세는 넣지 마세요. 말에 없는 경력·기술을 지어내지 마세요.`;
  const r = await callClaude(system, `[${ctx.author || '기업방'}] ${text}`, 1500);
  if (r.error) return { error: r.error };
  const j = parseJson(r.text) || {};
  if (!j.ok || !j.profile) return { free: true, text: j.ask ? str(j.ask, 200) : '추천할 인재의 분야·경력·잘하는 일·연락 방법을 알려 주세요. 예: "패키지 디자이너 박지은 추천, 3년차, 일러스트레이터 능숙, 010-1234-5678, 본인 동의 받았어요"' };
  const pf = j.profile, profile = { title: str(pf.title, 50), field: str(pf.field, 30), years: str(pf.years, 20), skills: cleanList(pf.skills, 8, 30), summary: str(pf.summary, 400), region: str(pf.region, 30), workType: str(pf.workType, 30), strengths: cleanList(pf.strengths, 4, 80) };
  if (!profile.title || !profile.summary) return { free: true, text: '인재 정보를 정리하지 못했어요. 분야·경력·잘하는 일을 조금 더 알려 주세요.' };
  const priv = { name: str(j.private && j.private.name, 30), contact: str(j.private && j.private.contact, 100) };
  const t = { id: newId('h'), orgId: org.id, by: ctx.author || '기업방', at: Date.now(), status: 'draft', profile, private: priv, consentSaid: !!j.consent, picks: [], roomId: room.id };
  S.talents.push(t); save();
  return { text: `인재 추천 초안을 만들었어요: ${profile.title}\n아래 카드에서 내용을 확인한 뒤 "본인 동의 링크 만들기"를 눌러 그 링크를 추천하는 분께 보내 주세요. 본인이 링크에서 직접 동의하면 인재 추천에 올라가요. 다른 기업에는 이름·연락처 없이 경력·기술만 보여요.${priv.contact ? '' : '\n(연락 방법이 없어요. 고른 기업이 연락할 수 있게 추천 기업이 직접 이어 주셔야 해요.)'}`, talent: { id: t.id, status: 'draft', profile, private: priv, consentSaid: t.consentSaid }, tgText: `인재 추천 초안 "${profile.title}"을 만들었어요. 웹앱 기업방에서 본인 동의 링크를 만들어 추천하는 분께 보내 주세요.` };
}

function talentCardSync(t) { for (const r of S.rooms.filter(r => r.orgId === t.orgId)) for (const m of r.msgs) if (m.talent && m.talent.id === t.id) { m.talent.status = t.status; m.talent.profile = t.profile; m.talent.private = ['deleted', 'declined', 'withdrawn'].includes(t.status) ? null : t.private; m.talent.consentUrl = t.status === 'awaiting' ? talentConsentUrl(t) : null; } }
// 인재 본인이 여는 동의 페이지 (로그인 없음, 스크립트 없음)
function consentPage(t, msg) {
  const e = DOC.escapeHtml, o = orgById(t.orgId), p = t.profile, fee = costOf('talent_pick');
  const live = t.status === 'open' || t.status === 'closed', expired = t.status === 'awaiting' && t.consentExp < Date.now();
  const body = t.status === 'awaiting' && !expired ? `<form method="post"><p class="q">이 내용으로 인재 추천에 올리는 데 동의하시나요?</p><button name="action" value="agree" class="ok">동의합니다</button><button name="action" value="decline" class="no">동의하지 않아요</button></form>`
    : live ? `<p class="st">동의하셨어요 (${new Date(t.consentAt + 9 * 36e5).toISOString().slice(0, 10)}). 지금 ${t.status === 'open' ? '인재 추천에 올라가 있어요' : '추천이 마감됐어요'} · 고른 기업 ${t.picks.length}곳</p><form method="post"><p class="q">언제든 동의를 거두면 추천이 내려가고 이름·연락처가 지워져요. 이미 연락처를 받은 기업에는 지워 달라고 알려요.</p><button name="action" value="withdraw" class="no">동의 철회하기</button></form>`
    : expired ? '<p class="st">링크 기간(7일)이 지났어요. 추천한 기업에 새 링크를 요청해 주세요.</p>' : '<p class="st">이 추천은 이제 없어요.</p>';
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>인재 추천 동의 · 함께봇</title>
<style>body{margin:0;font:16px/1.6 "Malgun Gothic","Noto Sans KR",system-ui,sans-serif;color:#17202b;background:#faf7fb}main{max-width:620px;margin:0 auto;padding:24px 18px 60px}h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:22px 0 6px}
.card{background:#fff;border:1.5px solid #e7d9e5;border-radius:14px;padding:14px 16px}.mute{color:#667085;font-size:14px}.sk span{display:inline-block;font-size:13px;padding:2px 8px;border-radius:8px;background:#f2eef3;margin:2px}
.priv{background:#fdf2fa;border-radius:12px;padding:10px 14px}ul{padding-left:20px}button{font:inherit;min-height:48px;border-radius:12px;border:0;padding:0 18px;margin:6px 6px 0 0;font-weight:700;cursor:pointer}.ok{background:#9E3D8F;color:#fff}.no{background:#fff;border:1.5px solid #d0d5dd;color:#17202b}
.q{font-weight:700;margin:18px 0 4px}.st{background:#ecfdf3;border-radius:12px;padding:10px 14px}.msg{background:#fffaeb;border-radius:12px;padding:10px 14px;margin-bottom:12px}</style></head><body><main>
${msg ? `<p class="msg">${e(msg)}</p>` : ''}<h1>${e(t.private.name || '')}님, ${t.status === 'awaiting' ? '인재 추천 동의를 부탁드려요' : '인재 추천 동의 내역이에요'}</h1>
<p class="mute"><b>${e(o ? o.name : '')}</b>이(가) 사회적기업 전문가 플랫폼 "함께봇"의 인재 추천에 ${e(t.private.name || '')}님을 추천하려고 해요. 동의하셔야 올라가요.</p>
<h2>함께봇의 다른 기업에 보이는 내용</h2><div class="card"><b>${e(p.title)}</b><div class="mute">${[p.field, p.years, p.region, p.workType].filter(Boolean).map(e).join(' · ')}</div>${p.skills.length ? `<div class="sk">${p.skills.map(x => `<span>${e(x)}</span>`).join('')}</div>` : ''}<p style="white-space:pre-wrap;margin:8px 0 0">${e(p.summary)}</p>${p.strengths.length ? `<ul>${p.strengths.map(x => `<li>${e(x)}</li>`).join('')}</ul>` : ''}</div>
<h2>추천을 보고 연락하겠다고 고른 기업에만 전해지는 내용</h2><div class="priv">이름: ${e(t.private.name || '-')}<br>연락처: ${e(t.private.contact || '(없음 — 추천한 기업이 이어 드려요)')}</div>
<h2>알아 두실 것</h2><ul><li>나이·성별·건강 같은 정보는 받지 않아요.</li><li>기업이 ${e(t.private.name || '')}님을 고르면, 추천한 ${e(o ? o.name : '')}이(가) 함께봇 토큰 ${fee}개(운영 기관 몫 ${feePct()}% 제외)를 추천 보상으로 받아요.</li><li>이 페이지에서 언제든 동의를 거둘 수 있어요. 이 링크는 다른 사람에게 보내지 마세요.</li></ul>
${body}</main></body></html>`;
}
const CONSENT_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
async function handleConsent(req, res, token) {
  const t = S.talents.find(x => x.consentToken && x.consentToken === token);
  if (!t) { res.writeHead(404, CONSENT_HEADERS); return res.end('<!DOCTYPE html><meta charset="utf-8"><title>없는 링크</title><p style="font-family:sans-serif;padding:40px">없는 링크이거나 이미 처리된 추천이에요.</p>'); }
  let msg = '';
  if (req.method === 'POST') {
    const raw = await new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); }); req.on('end', () => ok(d)); });
    const action = new URLSearchParams(raw).get('action'), rr = S.rooms.find(r => r.id === t.roomId) || S.rooms.find(r => r.orgId === t.orgId);
    if (action === 'agree' && t.status === 'awaiting' && t.consentExp >= Date.now()) {
      t.status = 'open'; t.consentAt = Date.now(); t.consentBy = '본인'; t.at = Date.now(); msg = '동의해 주셔서 고마워요. 인재 추천에 올라갔어요.';
      if (rr) addMsg(rr, { from: 'sys', text: `${t.private.name}님이 직접 동의해서 "${t.profile.title}"이(가) 인재 추천에 올라갔어요. 다른 기업이 고르면 ${costOf('talent_pick')}토큰(운영 기관 몫 ${feePct()}% 제외)을 받아요.` });
    } else if (action === 'decline' && t.status === 'awaiting') {
      t.status = 'declined'; t.private = { name: '', contact: '' }; msg = '동의하지 않으셨어요. 추천은 올라가지 않고, 이름·연락처를 지웠어요.';
      if (rr) addMsg(rr, { from: 'sys', text: `추천하려던 분이 "${t.profile.title}" 인재 추천에 동의하지 않았어요. 올리지 않고 이름·연락처를 지웠어요.` });
      S.talents = S.talents.filter(x => x !== t);
    } else if (action === 'withdraw' && (t.status === 'open' || t.status === 'closed')) {
      const name = t.private.name;
      for (const pk of t.picks) notifyOrg(pk.orgId, `"${t.profile.title}" 인재(${name}님)가 인재 추천 동의를 철회했어요. 받으신 이름·연락처는 지워 주세요.`);
      t.status = 'withdrawn'; t.private = { name: '', contact: '' }; msg = '동의를 철회했어요. 추천을 내리고 이름·연락처를 지웠어요. 연락처를 받은 기업에도 지워 달라고 알렸어요.';
      if (rr) addMsg(rr, { from: 'sys', text: `${name}님이 "${t.profile.title}" 인재 추천 동의를 철회했어요. 추천을 내리고 이름·연락처를 지웠어요.` });
      S.talents = S.talents.filter(x => x !== t);
    } else msg = '처리할 수 없는 요청이에요.';
    talentCardSync(t); save(); emit('board', { board: 'talent' }, '*');
  }
  res.writeHead(200, CONSENT_HEADERS);
  return res.end(consentPage(t, msg));
}

// ---------- 질문 버튼 → 관리자 텔레그램 답변 단톡 → /answer → Q&A 게시판 ----------
// S.adminTg = { chatId, title, linkedAt } (관리자가 만든 코드로 그룹에서 /adminlink)
async function askAdmin(org, user, text, secret) {
  const n = ++S.qseq;
  const x = { id: newId('p'), board: 'qna', orgId: org.id, by: user.name, at: Date.now(), title: str(text.split('\n')[0], 40) + (text.length > 40 ? '…' : ''), body: text, likes: [], replies: [], hidden: false, pinned: false, secret: secret !== false, quick: n };
  S.posts.push(x); save(); emit('board', { board: 'qna' }, '*');
  if (S.adminTg && TG_TOKEN) {
    const r = await tg('sendMessage', { chat_id: S.adminTg.chatId, text: `❓ 질문 #${n} · ${org.name} (${user.name})${x.secret ? ' · 비밀글' : ''}\n\n${text}\n\n답하려면 이 메시지에 답장으로 /answer 답변 내용\n또는 /answer ${n} 답변 내용` });
    if (r && r.ok) { x.tgMsgId = r.result.message_id; save(); }
  }
  return x;
}
function answerQuestion(x, text, by, via) {
  x.replies.push({ id: newId('r'), at: Date.now(), orgId: null, admin: true, by: '운영 기관', answeredBy: by, via, body: text });
  x.unreadAnswer = true; save();
  notifyOrg(x.orgId, `운영 기관이 질문${x.quick ? ` #${x.quick}` : ''} "${x.title}"에 답했어요: ${text.length > 120 ? text.slice(0, 120) + '…' : text}\n(Q&A 게시판에 ${x.secret ? '비밀글로 ' : ''}등록됐어요)`);
  emit('board', { board: 'qna', id: x.id, answer: true }, '*');
}
const ADMIN_TG_HELP = '관리자 답변 방이에요.\n· /answer 번호 답변 — 질문에 답하기 (질문 메시지에 답장하면 번호 없이 /answer 답변)\n· /questions — 답을 기다리는 질문 보기';
async function handleAdminGroup(msg, cmd, arg, name) {
  const chat = msg.chat;
  if (cmd === 'questions' || cmd === 'q') {
    const open = S.posts.filter(x => x.quick && !x.replies.some(r => r.admin) && !x.hidden).slice(-15);
    return tgSend(chat.id, open.length ? `답을 기다리는 질문 ${open.length}개\n\n${open.map(x => `#${x.quick} ${(orgById(x.orgId) || {}).name} — ${x.body.slice(0, 80)}`).join('\n')}` : '답을 기다리는 질문이 없어요.');
  }
  if (cmd === 'answer' || cmd === 'a') {
    let x = null, text = arg;
    const rep = msg.reply_to_message && msg.reply_to_message.message_id;
    if (rep) x = S.posts.find(p => p.quick && p.tgMsgId === rep);
    if (!x) { const m = arg.match(/^#?(\d+)\s+([\s\S]+)$/); if (m) { x = S.posts.find(p => p.quick === +m[1]); text = m[2]; } }
    text = String(text || '').trim().slice(0, 2000);
    if (!x) return tgSend(chat.id, '어느 질문인지 모르겠어요. 질문 메시지에 답장으로 /answer 답변, 또는 /answer 번호 답변 으로 보내 주세요.\n' + ADMIN_TG_HELP);
    if (text.length < 2) return tgSend(chat.id, `질문 #${x.quick}에 보낼 답변을 적어 주세요.`);
    const before = x.replies.some(r => r.admin);
    answerQuestion(x, text, name, 'telegram');
    return tgSend(chat.id, `#${x.quick} ${(orgById(x.orgId) || {}).name}에 답변을 보냈어요${before ? ' (추가 답변)' : ''} — ${name}. Q&A 게시판에 ${x.secret ? '비밀글로 ' : ''}등록됐어요.`);
  }
  if (cmd === 'start' || cmd === 'help') return tgSend(chat.id, ADMIN_TG_HELP);
}

// ---------- 게시판 (Q&A 비밀글 · 봇 추천) ----------
// Q&A 비밀글: 쓴 기업과 운영 기관만. 공개 Q&A·봇 추천: 모든 기업. 운영 기관이 숨긴 글은 쓴 기업에만 (숨김 표시)
const canSeePost = (org, p) => p.orgId === org.id || (!p.hidden && (p.board === 'rec' || !p.secret));
const canReply = (org, p) => !p.hidden && (p.orgId === org.id || p.board === 'rec' || !p.secret);
function botRecStats() {
  const m = {};
  for (const p of S.posts) if (p.board === 'rec' && p.kind === 'rec' && !p.hidden && p.botId) { const x = m[p.botId] || (m[p.botId] = { n: 0, sum: 0, likes: 0 }); x.n++; x.sum += p.rating; x.likes += p.likes.length; }
  for (const k in m) m[k].avg = Math.round(m[k].sum / m[k].n * 10) / 10;
  return m;
}
const botNameOf = id => { const b = botById(id); return b ? b.name : (((S.customBots.find(c => c.id === id) || {}).def) || {}).name || '없어진 봇'; };
function postView(org, p, full) {
  const o = orgById(p.orgId), mine = org && p.orgId === org.id;
  const v = { id: p.id, board: p.board, title: p.title, at: p.at, by: p.by, orgName: o ? o.name : '', mine: !!mine, secret: !!p.secret, hidden: !!p.hidden, pinned: !!p.pinned, kind: p.kind, botId: p.botId, botName: p.botId ? botNameOf(p.botId) : '', rating: p.rating, likes: p.likes.length, liked: !!(org && p.likes.includes(org.id)), replies: p.replies.length, answered: p.replies.some(r => r.admin), lastAt: p.replies.length ? p.replies[p.replies.length - 1].at : p.at };
  if (mine && p.hidden) v.hideReason = p.hideReason || '';
  if (full) { v.body = p.body; v.replyList = p.replies.map(r => ({ id: r.id, at: r.at, by: r.admin ? '운영 기관' : r.by, orgName: r.admin ? '운영 기관' : (orgById(r.orgId) || {}).name || '', admin: !!r.admin, mine: !!(org && r.orgId === org.id), body: r.body })); v.canReply = org ? canReply(org, p) : true; }
  return v;
}
const notifyOrg = (orgId, text) => { const r = S.rooms.find(x => x.orgId === orgId); if (r) addMsg(r, { from: 'sys', text }); };

const publicBots = org => [
  ...BOTS.map(({ role, ...b }) => ({ ...b, cost: b.soon ? null : costOf(b.id) })),
  ...(org ? S.customBots.filter(c => canUseBot(org, c.id)).map(c => {
    const o = customBotObj(c), mine = c.orgId === org.id, pass = (c.passes || {})[org.id];
    const base = o.kind === 'site' ? costOf('site') : o.kind === 'ir' ? costOf('ir') : o.kind === 'sched' ? costOf('sched') : o.kind === 'todo' ? costOf('todo') : costOf('custom');
    return { id: c.id, name: o.name, short: o.short, color: o.color, tag: o.tag, desc: o.desc, hello: o.hello, quick: o.quick, kind: o.kind, ppt: o.ppt, custom: true, mine, ownerName: (orgById(c.orgId) || {}).name, cost: base + shareFor(org, c).amount, origin: c.derivedFrom ? (o2 => o2 ? { orgName: (orgById(o2.orgId) || {}).name, name: o2.rec && o2.rec.publicStatus === 'public' ? o2.name : '', royalty: o2.orgId === org.id ? 0 : royaltyOf(o2) } : null)(originOf(c)) : null, pricing: mine ? c.pricing || {} : { perUse: (c.pricing || {}).perUse, passDays: (c.pricing || {}).passDays, passPrice: (c.pricing || {}).passPrice }, passUntil: pass && pass > Date.now() ? pass : null };
  }) : [])
].map((b, _, __, st = botRecStats()[b.id]) => st ? { ...b, rec: { n: st.n, avg: st.avg, likes: st.likes } } : b);
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
    orgs: S.orgs.map(o => ({ ...orgPublic(o), wallet: o.wallet, unlimited: o.unlimited ? { ...o.unlimited, active: unlimitedActive(o) } : null, site: o.site && o.site.published ? { url: siteUrl(o.site.slug), slug: o.site.slug } : null, rooms: S.rooms.filter(r => r.orgId === o.id).length, users: S.users.filter(u => u.orgId === o.id).map(u => ({ id: u.id, loginId: u.loginId, name: u.name })) })),
    experts: S.experts.map(e => ({ ...expertProfile(e), linked: !!e.tgChatId, regCode: e.regCode, active: roomsOfExpert(e).length })),
    costs: COST_ITEMS().map(c => ({ ...c, cost: costOf(c.id) })),
    feePct: feePct(), platformFees: S.platformFees || 0,
    adminTg: S.adminTg ? { title: S.adminTg.title, linkedAt: S.adminTg.linkedAt, by: S.adminTg.by } : null, tgReady: !!TG_TOKEN,
    talents: S.talents.filter(t => t.status !== 'draft').sort((a, b) => b.at - a.at).slice(0, 100).map(t => ({ id: t.id, at: t.at, status: t.status, hidden: !!t.hidden, orgName: (orgById(t.orgId) || {}).name, profile: t.profile, consentBy: t.consentBy, picks: t.picks.map(p => ({ orgName: (orgById(p.orgId) || {}).name, at: p.at, amount: p.amount })) })),
    posts: S.posts.slice().sort((a, b) => b.at - a.at).slice(0, 200).map(x => ({ ...postView(null, x, true), hideReason: x.hideReason || '', canReply: true })),
    claims: S.claims.slice().sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || y.at - x.at).slice(0, 50).map(cl => {
      const o = S.customBots.find(x => x.id === cl.origBotId), t = cl.targetBotId && S.customBots.find(x => x.id === cl.targetBotId);
      const bv = c => c && { id: c.id, name: c.def ? c.def.name : '', orgName: (orgById(c.orgId) || {}).name, role: c.def ? c.def.role : '', createdAt: c.createdAt, publicStatus: c.publicStatus, discarded: !!c.discarded, origin: c.derivedFrom ? { orgName: (orgById(c.derivedFrom.orgId) || {}).name, name: c.derivedFrom.name } : null };
      return { ...cl, orgName: (orgById(cl.orgId) || {}).name, orig: bv(o), target: bv(t), overlap: rawOverlap(t, o) };
    }),
    copies: S.customBots.filter(c => c.derivedFrom && !c.discarded).map(c => { const o = originOf(c); return { id: c.id, name: c.def ? c.def.name : '', orgName: (orgById(c.orgId) || {}).name, origin: { id: c.derivedFrom.botId, name: o ? o.name : '', orgName: (orgById(o ? o.orgId : c.derivedFrom.orgId) || {}).name }, score: c.derivedFrom.score, manual: !!c.derivedFrom.manual, royalty: o ? royaltyOf(o) : 0 }; }),
    allBots: S.customBots.filter(c => c.def && !c.discarded).map(c => ({ id: c.id, name: c.def.name, orgName: (orgById(c.orgId) || {}).name, role: c.def.role, createdAt: c.createdAt })),
    market: S.customBots.filter(c => c.publicStatus).map(c => ({ id: c.id, orgName: (orgById(c.orgId) || {}).name, def: c.def, version: (c.versions || []).length, pricing: c.pricing, publicStatus: c.publicStatus, publicReason: c.publicReason, publicReqAt: c.publicReqAt, stats: c.stats, sourceUrl: ((c.versions || []).slice(-1)[0] || {}).sourceUrl })),
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
  let m = p.match(/^\/api\/admin\/orgs\/(\w+)\/(users|charge|deduct|rename|delete|unpublish|unlimited|unlimited-off)$/);
  if (m) {
    const org = orgById(m[1]); if (!org) return BAD(res, '없는 기업이에요', 404);
    if (m[2] === 'unlimited') {
      // until: YYYY-MM-DD (그날 23:59:59 한국 시간까지)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.until || '')) return BAD(res, '끝나는 날짜를 정해 주세요');
      const until = Date.parse(`${b.until}T23:59:59+09:00`);
      if (!(until > Date.now())) return BAD(res, '끝나는 날짜는 오늘 이후여야 해요');
      if (until - Date.now() > 366 * 864e5) return BAD(res, '기간은 1년까지 정할 수 있어요');
      const refillTo = Number(b.refillTo);
      if (!Number.isInteger(refillTo) || refillTo < 1 || refillTo > 100000) return BAD(res, '채울 수량은 1~100000 사이 정수로 정해 주세요');
      const prev = org.unlimited && unlimitedActive(org) ? org.unlimited : null;
      org.unlimited = { until, untilDate: b.until, refillTo, grantedAt: prev ? prev.grantedAt : Date.now(), memo: str(b.memo, 100), refills: prev ? prev.refills : 0, total: prev ? prev.total : 0 };
      save();
      ensureFunds(org, refillTo); // 지금 잔액이 채울 수량보다 적으면 바로 채움
      return json(res, 200, { ok: true, wallet: org.wallet });
    }
    if (m[2] === 'unlimited-off') {
      if (!org.unlimited) return BAD(res, '무제한 설정이 없어요');
      org.unlimited.until = Math.min(org.unlimited.until, Date.now() - 1); org.unlimited.endedEarly = true; save();
      return json(res, 200, { ok: true });
    }
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
  if (p === '/api/admin/fee') { const v = Number(b.pct); if (!Number.isInteger(v) || v < 0 || v > 30) return BAD(res, '운영 기관 몫은 0~30% 사이 정수로 정해 주세요'); S.feeRate = v / 100; save(); emit('room', {}, '*'); return json(res, 200, { ok: true }); }
  if (p === '/api/admin/tg-admin/code') { S.adminLink = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), exp: Date.now() + 10 * 6e4 }; save(); return json(res, 200, { code: S.adminLink.code, bot: tgUsername || null }); }
  if (p === '/api/admin/tg-admin/unlink') { if (S.adminTg) tgSend(S.adminTg.chatId, '관리자 답변 방 연결을 해제했어요.'); S.adminTg = null; save(); return json(res, 200, { ok: true }); }
  const hm = p.match(/^\/api\/admin\/talent\/(\w+)\/(hide|delete)$/);
  if (hm) {
    const t = S.talents.find(x => x.id === hm[1]); if (!t) return BAD(res, '없는 추천이에요', 404);
    if (hm[2] === 'hide') { t.hidden = !!b.hidden; if (t.hidden) notifyOrg(t.orgId, `운영 기관이 인재 추천 "${t.profile.title}"을(를) 숨겼어요${b.reason ? `: ${str(b.reason, 100)}` : '.'}`); }
    else { S.talents = S.talents.filter(x => x !== t); notifyOrg(t.orgId, `운영 기관이 인재 추천 "${t.profile.title}"을(를) 지웠어요${b.reason ? `: ${str(b.reason, 100)}` : '.'}`); }
    save(); emit('board', { board: 'talent' }, '*'); return json(res, 200, { ok: true });
  }
  // 게시판 관리: 답변 · 숨기기 · 고정 · 삭제
  const pm = p.match(/^\/api\/admin\/board\/(\w+)\/(reply|hide|pin|delete)$/);
  if (pm) {
    const x = S.posts.find(y => y.id === pm[1]); if (!x) return BAD(res, '없는 글이에요', 404);
    if (pm[2] === 'reply') {
      const text = String(b.body == null ? '' : b.body).replace(/\r/g, '').trim().slice(0, 2000); if (text.length < 2) return BAD(res, '답변을 적어 주세요');
      if (x.quick) { answerQuestion(x, text, '관리자 웹', 'web'); if (S.adminTg && TG_TOKEN) tgSend(S.adminTg.chatId, `#${x.quick}에 관리자 웹에서 답변했어요: ${text.slice(0, 200)}`); }
      else {
        x.replies.push({ id: newId('r'), at: Date.now(), orgId: null, admin: true, by: '운영 기관', body: text }); x.unreadAnswer = true;
        notifyOrg(x.orgId, `운영 기관이 ${x.board === 'qna' ? `${x.secret ? '비밀글 ' : ''}질문` : '게시판 글'} "${x.title}"에 답했어요. "게시판"에서 확인하세요.`);
      }
    } else if (pm[2] === 'hide') { x.hidden = !!b.hidden; x.hideReason = x.hidden ? str(b.reason, 100) : ''; if (x.hidden) notifyOrg(x.orgId, `운영 기관이 게시판 글 "${x.title}"을(를) 숨겼어요${x.hideReason ? `: ${x.hideReason}` : '.'}`); }
    else if (pm[2] === 'pin') x.pinned = !!b.pinned;
    else S.posts = S.posts.filter(y => y !== x);
    save(); emit('board', { board: x.board }, '*'); return json(res, 200, { ok: true });
  }
  // 원작 기업의 요구 결정: 폐기(discard) · 원작으로 연결(link) · 기각(reject)
  const cm = p.match(/^\/api\/admin\/claims\/(\w+)$/);
  if (cm) {
    const cl = S.claims.find(x => x.id === cm[1]); if (!cl) return BAD(res, '없는 요구예요', 404);
    if (cl.status !== 'open') return BAD(res, '이미 결정한 요구예요');
    const orig = S.customBots.find(x => x.id === cl.origBotId), act = b.action, note = str(b.note, 200);
    const croom = S.rooms.find(r => r.orgId === cl.orgId);
    if (act === 'reject') {
      cl.status = 'rejected';
      if (croom) addMsg(croom, { from: 'sys', text: `원작 신고("${orig && orig.def ? orig.def.name : '봇'}")를 운영 기관이 받아들이지 않았어요${note ? `: ${note}` : '.'}` });
    } else if (act === 'discard' || act === 'link') {
      const t = S.customBots.find(x => x.id === (b.targetBotId || cl.targetBotId));
      if (!orig || !orig.def) return BAD(res, '원작 봇이 없어졌어요. 기각해 주세요');
      if (!t || !t.def || t.orgId === cl.orgId) return BAD(res, '복사한 봇을 골라 주세요 (신고한 기업의 봇이 아닌 것)');
      if (t.discarded) return BAD(res, '이미 폐기한 봇이에요');
      if (rootOf(orig) === t || t === orig) return BAD(res, '원작 봇이 오히려 이 봇에서 나온 것으로 연결돼 있어요. 먼저 원작 연결을 확인해 주세요');
      cl.targetBotId = t.id;
      if (act === 'discard') { discardBot(t, note || '원작 기업의 요구로 폐기', orig); cl.status = 'discarded'; }
      else { linkOrigin(t, orig, note); cl.status = 'linked'; }
    } else return BAD(res, '폐기·연결·기각 중 하나를 골라 주세요');
    cl.note = note; cl.decidedAt = Date.now();
    save(); emit('room', {}, '*'); return json(res, 200, { ok: true });
  }
  const dm = p.match(/^\/api\/admin\/bots\/(\w+)\/discard$/);
  if (dm) {
    const c = S.customBots.find(x => x.id === dm[1]); if (!c || !c.def) return BAD(res, '없는 봇이에요', 404);
    if (c.discarded) return BAD(res, '이미 폐기한 봇이에요');
    discardBot(c, str(b.reason, 200) || '운영 기관 결정', c.derivedFrom ? S.customBots.find(x => x.id === c.derivedFrom.botId) : null);
    save(); emit('room', {}, '*'); return json(res, 200, { ok: true });
  }
  // 원작 연결: 잘못 찾았으면 풀고(clear), 못 찾은 복사는 직접 연결(fromBotId)
  const om = p.match(/^\/api\/admin\/bots\/(\w+)\/origin$/);
  if (om) {
    const c = S.customBots.find(x => x.id === om[1]); if (!c) return BAD(res, '없는 봇이에요', 404);
    const room = S.rooms.find(r => r.orgId === c.orgId);
    if (b.clear) {
      if (!c.derivedFrom) return BAD(res, '원작과 연결된 봇이 아니에요');
      c.noAutoOrigin = true; // 다시 자동으로 붙지 않게 (필요하면 운영 기관이 직접 연결)
      const was = c.derivedFrom; c.derivedFrom = null;
      if (room) addMsg(room, { from: 'sys', text: `운영 기관이 "${c.def ? c.def.name : '봇'}"의 원작 연결을 풀었어요. 이제 원작 기업 몫이 나가지 않아요.` });
      const oroom = S.rooms.find(r => r.orgId === was.orgId);
      if (oroom) addMsg(oroom, { from: 'sys', text: `운영 기관이 확인한 결과 ${(orgById(c.orgId) || {}).name}의 "${c.def ? c.def.name : '봇'}"은(는) 우리 봇의 복사가 아니라서 원작 연결을 풀었어요.` });
    } else {
      const o = S.customBots.find(x => x.id === b.fromBotId);
      if (!o || o === c || o.orgId === c.orgId) return BAD(res, '원작은 다른 기업의 봇이어야 해요');
      const root = rootOf(o); if (root === c || root.orgId === c.orgId) return BAD(res, '서로 복사로 이어진 봇이라 연결할 수 없어요');
      linkOrigin(c, root, '');
    }
    save(); emit('room', {}, '*'); return json(res, 200, { ok: true });
  }
  const bm = p.match(/^\/api\/admin\/bots\/(\w+)\/(approve|reject|unpublish)$/);
  if (bm) {
    const c = S.customBots.find(x => x.id === bm[1]); if (!c) return BAD(res, '없는 봇이에요', 404);
    if (bm[2] === 'approve') { if (c.publicStatus !== 'pending') return BAD(res, '심사 중인 봇이 아니에요'); c.publicStatus = 'public'; c.publicAt = Date.now(); c.publicReason = null; }
    else if (bm[2] === 'reject') { c.publicStatus = 'rejected'; c.publicReason = str(b.reason, 200) || '운영 기관 검토 결과 공개하지 않기로 했어요'; }
    else { c.publicStatus = null; refundPasses(c, '운영 기관이 공개 중단'); }
    save(); emit('room', {}, '*');
    const room = S.rooms.find(r => r.orgId === c.orgId);
    if (room && c.def) addMsg(room, { from: 'sys', text: bm[2] === 'approve' ? `"${c.def.name}" 봇이 운영 기관 승인을 받아 다른 기업에도 공개됐어요.` : bm[2] === 'reject' ? `"${c.def.name}" 봇을 다른 기업에 공개하지 않기로 했어요: ${c.publicReason}` : `"${c.def.name}" 봇의 다른 기업 공개를 운영 기관이 중단했어요.` });
    return json(res, 200, { ok: true });
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
    profile: expertProfile(ex), feePct: feePct(),
    active: roomsOfExpert(ex).map(r => ({ label: roomLabel(r), since: ((r.consults || {})[ex.id] || {}).startAt })),
    received: S.ledger.filter(l => l.expertId === ex.id).slice(-100).reverse().map(l => ({ at: l.at, type: l.type, amount: l.amount, orgName: l.type === 'pay' ? l.orgName : '', minutes: l.minutes, memo: l.memo })),
    rateMax: RATE_MAX
  });
  if (p === '/api/expert/ir') return json(res, 200, { orgs: irOrgsFor(ex).map(o => { const v = irLatest(o); return { orgId: o.id, orgName: o.name, n: v.n, at: v.at, title: v.outline.title, final: o.ir.final && o.ir.final.n, open: o.ir.comments.filter(c => c.status === 'open').length }; }) });
  if (p === '/api/expert/ir/view') {
    const org = orgById(new URL(req.url, 'http://x').searchParams.get('org'));
    if (!org || !irAccess(ex, org) || !irLatest(org)) return BAD(res, '볼 수 있는 IR 자료가 아니에요', 404);
    const v = irLatest(org);
    return json(res, 200, { orgId: org.id, orgName: org.name, n: v.n, at: v.at, note: v.note, outline: v.outline, comments: org.ir.comments, final: org.ir.final && org.ir.final.n });
  }
  if (p === '/api/expert/ir/comment' && req.method === 'POST') {
    const b = await body(req), org = orgById(b.orgId);
    if (!org || !irAccess(ex, org)) return BAD(res, '코멘트를 남길 수 있는 IR 자료가 아니에요', 404);
    const r = addIrComment(org, b.slide, b.text, { kind: 'expert', name: ex.name, id: ex.id });
    return r.error ? BAD(res, r.error) : json(res, 200, { ok: true });
  }
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
      rooms: S.rooms.filter(r => r.orgId === org.id), bots: publicBots(org), experts: publicExperts(),
      telegram: { enabled: !!tgUsername, username: tgUsername }, ai: !!ANTHROPIC_API_KEY,
      site: org.site && org.site.published ? { url: siteUrl(org.site.slug), slug: org.site.slug, n: (siteVersion(org, org.site.published) || {}).n, published: org.site.published } : { slug: org.site && org.site.slug },
      costs: Object.fromEntries(COST_ITEMS().map(c => [c.id, costOf(c.id)])),
      sched: org.sched && org.sched.items.length ? { url: schedUrl(org), v: org.sched.v } : null,
      feePct: feePct(),
      boardUnread: S.posts.filter(x => x.orgId === org.id && x.unreadAnswer).length,
      todo: org.todo || todoRooms(org).length ? (() => { const td = ensureTodo(org), t = todayKst(), nx = TODO.upcoming(td, t); return { url: todoUrl(org), editUrl: todoEditUrl(org), v: td.v, next: nx, left: SCHED.diffDays(t, nx), days: td.cycle.days, count: td.items.filter(x => x.status === 'active').length }; })() : null
    });
  // ----- 인재 추천 -----
  if (p.startsWith('/api/talent')) {
    if (p === '/api/talent' && req.method === 'GET') {
      const list = S.talents.filter(t => (t.status === 'open' && !t.hidden) || (t.orgId === org.id && t.status !== 'draft') || t.picks.some(x => x.orgId === org.id)).sort((a, b) => b.at - a.at).slice(0, 200).map(t => talentView(org, t));
      return json(res, 200, { items: list, fee: costOf('talent_pick') });
    }
    if (p === '/api/talent/get' && req.method === 'GET') {
      const t = S.talents.find(x => x.id === new URL(req.url, 'http://x').searchParams.get('id') && x.orgId === org.id); if (!t) return BAD(res, '없는 추천이에요', 404);
      return json(res, 200, talentView(org, t));
    }
    if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
    const b = await body(req), t = S.talents.find(x => x.id === b.id);
    if (!t) return BAD(res, '없는 추천이에요', 404);
    const card = () => talentCardSync(t);
    if (p === '/api/talent/consent-link') {
      // 인재 본인이 직접 동의해야 올라감: 추천 기업은 내용을 정한 뒤 동의 링크를 인재에게 보냄
      if (t.orgId !== org.id || !['draft', 'awaiting'].includes(t.status)) return BAD(res, '동의 링크를 만들 수 있는 초안이 아니에요', 404);
      if (b.profile) {
        const pf = b.profile; t.profile = { ...t.profile, title: str(pf.title, 50) || t.profile.title, summary: str(pf.summary, 400) || t.profile.summary, skills: pf.skills != null ? cleanList(String(pf.skills).split(/[,·]/), 8, 30) : t.profile.skills };
        if (b.private) t.private = { name: str(b.private.name, 30), contact: str(b.private.contact, 100) };
        if (SENSITIVE_RE.test(JSON.stringify([t.profile, t.private]))) return BAD(res, '주민등록번호·계좌번호 같은 정보는 넣을 수 없어요');
      }
      if (!t.private.name) return BAD(res, '인재 이름을 적어 주세요 (동의 화면에 보여 드려요)');
      t.status = 'awaiting'; t.consentToken = crypto.randomBytes(16).toString('hex'); t.consentExp = Date.now() + 7 * 864e5; t.linkBy = user.name;
      card(); save(); emit('board', { board: 'talent' }, '*');
      return json(res, 200, { ...talentView(org, t), consentUrl: talentConsentUrl(t) });
    }
    if (p === '/api/talent/discard' || p === '/api/talent/close' || p === '/api/talent/delete') {
      if (t.orgId !== org.id) return BAD(res, '우리 기업이 추천한 인재가 아니에요', 403);
      if (p === '/api/talent/close') { if (t.status !== 'open') return BAD(res, '올라가 있는 추천이 아니에요'); t.status = 'closed'; }
      else if (p === '/api/talent/discard' && !['draft', 'awaiting', 'declined'].includes(t.status)) return BAD(res, '초안만 버릴 수 있어요. 올라간 추천은 지우기를 써 주세요');
      else { S.talents = S.talents.filter(x => x !== t); t.status = 'deleted'; t.private = { name: '', contact: '' }; } // 지우면 개인정보도 지움
      card(); save(); emit('board', { board: 'talent' }, '*'); return json(res, 200, { ok: true });
    }
    if (p === '/api/talent/pick') {
      if (t.status !== 'open' || t.hidden) return BAD(res, '지금 고를 수 없는 인재예요', 404);
      if (t.orgId === org.id) return BAD(res, '우리 기업이 추천한 인재는 고를 수 없어요');
      if (t.picks.some(x => x.orgId === org.id)) return BAD(res, '이미 고른 인재예요');
      const fee = costOf('talent_pick'), rec = orgById(t.orgId);
      if (!reserveTokens(org, fee)) return BAD(res, `인재를 고르려면 ${fee}토큰이 필요해요. 잔액(${org.wallet}토큰)이 부족해요.`);
      let got = { net: 0, fee: 0 };
      if (fee > 0) {
        record(org, { type: 'talent_pick', amount: fee, talentId: t.id, talentTitle: t.profile.title, toOrgName: rec ? rec.name : '' }); afterSpend(org);
        if (rec) got = creditOrg(rec, fee, { type: 'talent_pick_in', talentId: t.id, talentTitle: t.profile.title, fromOrgName: org.name });
      }
      t.picks.push({ orgId: org.id, at: Date.now(), amount: got.net, fee: got.fee, by: user.name });
      if (rec) notifyOrg(rec.id, `${org.name}이(가) 우리가 추천한 "${t.profile.title}"을(를) 골랐어요. ${got.net}토큰을 받았어요${got.fee ? ` (${fee}토큰 중 운영 기관 몫 ${got.fee} 제외)` : ''}. 연락처를 받은 ${org.name}이(가) 직접 연락할 거예요 — 추천한 분께도 알려 주세요.`);
      notifyOrg(org.id, `"${t.profile.title}" 인재를 골랐어요 (${fee}토큰). 이름·연락처: ${t.private.name || '-'} · ${t.private.contact || '추천 기업에 문의'} (추천: ${rec ? rec.name : '-'})`);
      save(); emit('board', { board: 'talent' }, '*');
      return json(res, 200, talentView(org, t));
    }
    return BAD(res, '없는 기능이에요', 404);
  }
  // ----- 질문 버튼 -----
  if (p === '/api/ask' && req.method === 'GET') {
    const mine = S.posts.filter(x => x.quick && x.orgId === org.id).slice(-30).map(x => ({ id: x.id, n: x.quick, at: x.at, by: x.by, body: x.body, secret: x.secret, answers: x.replies.filter(r => r.admin).map(r => ({ at: r.at, body: r.body })) }));
    return json(res, 200, { items: mine, live: !!(S.adminTg && TG_TOKEN) });
  }
  if (p === '/api/ask' && req.method === 'POST') {
    const b = await body(req), text = String(b.text == null ? '' : b.text).replace(/\r/g, '').trim().slice(0, 2000);
    if (text.length < 2) return BAD(res, '질문을 적어 주세요');
    if (S.posts.filter(x => x.quick && x.orgId === org.id && Date.now() - x.at < 36e5).length >= 10) return BAD(res, '한 시간에 10개까지 물을 수 있어요');
    const x = await askAdmin(org, user, text, b.secret);
    return json(res, 200, { ok: true, id: x.id, n: x.quick, sent: !!x.tgMsgId });
  }
  // ----- 게시판 -----
  if (p.startsWith('/api/board')) {
    const qs = new URL(req.url, 'http://x').searchParams;
    if (p === '/api/board' && req.method === 'GET') {
      const board = qs.get('board') === 'rec' ? 'rec' : 'qna';
      const list = S.posts.filter(x => x.board === board && canSeePost(org, x)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.at - a.at).slice(0, 200).map(x => postView(org, x));
      const used = Object.keys(org.botUse || {}).filter(id => canUseBot(org, id) && !(S.customBots.find(c => c.id === id && c.orgId === org.id)));
      return json(res, 200, { posts: list, recStats: board === 'rec' ? botRecStats() : undefined, recommendable: board === 'rec' ? used.map(id => ({ id, name: botNameOf(id) })) : undefined });
    }
    if (p === '/api/board/post' && req.method === 'GET') {
      const x = S.posts.find(y => y.id === qs.get('id'));
      if (!x || !canSeePost(org, x)) return BAD(res, '없는 글이거나 볼 수 없는 글이에요', 404);
      if (x.orgId === org.id && x.unreadAnswer) { x.unreadAnswer = false; save(); }
      return json(res, 200, postView(org, x, true));
    }
    if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
    const b = await body(req);
    const today = S.posts.filter(x => x.orgId === org.id && Date.now() - x.at < 864e5).length;
    if (p === '/api/board/post') {
      const board = b.board === 'rec' ? 'rec' : b.board === 'qna' ? 'qna' : null; if (!board) return BAD(res, '게시판을 골라 주세요');
      if (today >= 20) return BAD(res, '하루에 20개까지 쓸 수 있어요');
      const title = str(b.title, 60), text = String(b.body == null ? '' : b.body).replace(/\r/g, '').trim().slice(0, 2000);
      if (!title) return BAD(res, '제목을 적어 주세요');
      if (text.length < 5) return BAD(res, '내용을 5자 이상 적어 주세요');
      const x = { id: newId('p'), board, orgId: org.id, by: user.name, at: Date.now(), title, body: text, likes: [], replies: [], hidden: false, pinned: false };
      if (board === 'qna') x.secret = b.secret !== false;
      else {
        x.kind = b.kind === 'idea' ? 'idea' : 'rec';
        if (x.kind === 'rec') {
          const id = str(b.botId, 40);
          if (!canUseBot(org, id)) return BAD(res, '추천할 봇을 골라 주세요');
          if (S.customBots.some(c => c.id === id && c.orgId === org.id)) return BAD(res, '우리 기업이 만든 봇은 추천할 수 없어요');
          if (!((org.botUse || {})[id] > 0)) return BAD(res, '직접 써 본 봇만 추천할 수 있어요');
          const rating = Number(b.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) return BAD(res, '별점을 1~5로 골라 주세요');
          if (S.posts.some(y => y.board === 'rec' && y.kind === 'rec' && y.botId === id && y.orgId === org.id && !y.hidden)) return BAD(res, '이 봇은 이미 추천했어요. 쓴 글에 댓글로 더해 주세요');
          x.botId = id; x.rating = rating;
        }
      }
      S.posts.push(x); save(); emit('board', { board }, '*');
      return json(res, 200, { ok: true, id: x.id });
    }
    const x = S.posts.find(y => y.id === b.id);
    if (!x || !canSeePost(org, x)) return BAD(res, '없는 글이거나 볼 수 없는 글이에요', 404);
    if (p === '/api/board/reply') {
      if (!canReply(org, x)) return BAD(res, '이 글에는 댓글을 달 수 없어요', 403);
      const text = String(b.body == null ? '' : b.body).replace(/\r/g, '').trim().slice(0, 1000); if (text.length < 2) return BAD(res, '댓글을 적어 주세요');
      if (x.replies.length >= 200) return BAD(res, '댓글이 너무 많아요');
      x.replies.push({ id: newId('r'), at: Date.now(), orgId: org.id, by: user.name, body: text });
      if (x.orgId !== org.id) notifyOrg(x.orgId, `게시판 글 "${x.title}"에 ${org.name}이(가) 댓글을 달았어요.`);
      save(); emit('board', { board: x.board, id: x.id }, '*'); return json(res, 200, postView(org, x, true));
    }
    if (p === '/api/board/like') {
      if (x.board !== 'rec' || x.orgId === org.id) return BAD(res, '공감할 수 없는 글이에요');
      const i = x.likes.indexOf(org.id); if (i >= 0) x.likes.splice(i, 1); else x.likes.push(org.id);
      save(); emit('board', { board: x.board }, '*'); return json(res, 200, { likes: x.likes.length, liked: i < 0 });
    }
    if (p === '/api/board/delete') {
      if (x.orgId !== org.id) return BAD(res, '우리 기업이 쓴 글만 지울 수 있어요', 403);
      S.posts = S.posts.filter(y => y !== x); save(); emit('board', { board: x.board }, '*'); return json(res, 200, { ok: true });
    }
    return BAD(res, '없는 기능이에요', 404);
  }
  // ----- 봇 마켓 (직접 만든 봇) -----
  if (p.startsWith('/api/bots')) {
    // 올리는 기업에게 보여 줄 원작 정보 (원작 봇 이름은 공개된 봇일 때만)
    const originView = d => d ? { orgName: (orgById(d.orgId) || {}).name || d.orgName, name: (S.customBots.find(x => x.id === d.botId) || {}).publicStatus === 'public' ? d.name : '', score: d.score, royalty: royaltyOf({ rec: S.customBots.find(x => x.id === d.botId) }) } : null;
    const mineBot = id => S.customBots.find(c => c.id === id && c.orgId === org.id);
    const view = c => ({ id: c.id, def: c.def, pending: c.pending, version: (c.versions || []).length, pricing: c.pricing, publicStatus: c.publicStatus, publicReason: c.publicReason, stats: c.stats || { uses: 0, earned: 0, byOrg: {} }, createdBy: c.createdBy, passes: Object.keys(c.passes || {}).filter(k => c.passes[k] > Date.now()).length, origin: c.derivedFrom ? originView(c.derivedFrom) : null, copies: S.customBots.filter(x => x.derivedFrom && x.derivedFrom.botId === c.id && !x.discarded).length, copyList: S.customBots.filter(x => x.derivedFrom && x.derivedFrom.botId === c.id && !x.discarded && x.def).map(x => ({ id: x.id, name: x.def.name, orgName: (orgById(x.orgId) || {}).name })), discarded: c.discarded ? { at: c.discarded.at, reason: c.discarded.reason } : null });
    if (p === '/api/bots/mine' && req.method === 'GET') return json(res, 200, { bots: S.customBots.filter(c => c.orgId === org.id).map(view), claims: S.claims.filter(x => x.orgId === org.id).slice(-20).reverse().map(x => ({ id: x.id, at: x.at, origName: ((S.customBots.find(c => c.id === x.origBotId) || {}).def || {}).name || '', target: x.targetBotId ? `${x.targetOrgName} "${x.targetName}"` : x.targetText, want: x.want, status: x.status, note: x.note })), reportable: S.customBots.filter(c => c.orgId !== org.id && c.def && !c.discarded && c.publicStatus === 'public').map(c => ({ id: c.id, name: c.def.name, orgName: (orgById(c.orgId) || {}).name })), prompt: MARKET.CLAUDE_PROMPT, kinds: MARKET.KINDS });
    if (p === '/api/bots/export' && req.method === 'GET') {
      const qs = new URL(req.url, 'http://x').searchParams;
      // 기본 봇과 우리 기업이 만든 봇만 내보냄 (다른 기업의 봇은 역할 지시문을 볼 수 없음)
      const id = str(qs.get('id'), 40), bi = BOTS.find(x => x.id === id && !x.soon), c = !bi && mineBot(id);
      if (!bi && !(c && c.def)) return BAD(res, '내보낼 수 없는 봇이에요 (기본 봇과 우리 기업이 만든 봇만 내보낼 수 있어요)', 404);
      const def = bi ? { name: bi.name, short: bi.short, color: bi.color, tag: bi.tag, desc: bi.desc, hello: bi.hello, quick: bi.quick, kind: bi.kind || 'chat', ppt: !!bi.ppt, role: bi.role } : c.def;
      const meta = { from: bi ? '함께봇 기본 봇' : org.name, version: bi ? '' : String((c.versions || []).length), at: todayKst(), source: bi ? 'builtin' : 'custom' };
      const fname = `${def.name.replace(/[\\/:*?"<>|\s]+/g, '_')}.hamkkebot.${qs.get('format') === 'json' ? 'json' : 'html'}`;
      const out = qs.get('format') === 'json' ? JSON.stringify(MARKET.exportDef(def, meta), null, 2) : MARKET.exportHtml(def, meta);
      res.writeHead(200, { 'content-type': qs.get('format') === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}` });
      return res.end(out);
    }
    if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
    const b = await body(req);
    if (p === '/api/bots/fetch') {
      const f = await MARKET.fetchPublic(str(b.url, 500)); if (f.error) return BAD(res, f.error);
      const e = MARKET.extractDef(f.text); if (e.error) return BAD(res, e.error);
      const v = MARKET.validateDef(e.def); return v.error ? BAD(res, v.error) : json(res, 200, { def: v.def, sourceUrl: f.finalUrl, meta: MARKET.readMeta(e.def), origin: originView(findOrigin(org, v.def.role, null)) });
    }
    if (p === '/api/bots/parse') {
      const e = MARKET.extractDef(String(b.text || '').slice(0, 300000)); if (e.error) return BAD(res, e.error);
      const v = MARKET.validateDef(e.def); return v.error ? BAD(res, v.error) : json(res, 200, { def: v.def, meta: MARKET.readMeta(e.def), origin: originView(findOrigin(org, v.def.role, null)) });
    }
    if (p === '/api/bots/submit') {
      const v = MARKET.validateDef(b.def); if (v.error) return BAD(res, v.error);
      let c;
      if (b.botId) { c = mineBot(b.botId); if (!c) return BAD(res, '우리 기업이 만든 봇이 아니에요', 404); if (c.discarded) return BAD(res, '운영 기관이 폐기한 봇이라 업데이트할 수 없어요'); }
      else { c = { id: 'u' + crypto.randomBytes(4).toString('hex'), orgId: org.id, def: null, versions: [], pricing: { perUse: null, passDays: null, passPrice: null }, publicStatus: null, passes: {}, stats: { uses: 0, earned: 0, byOrg: {} }, createdBy: user.name, createdAt: Date.now() }; S.customBots.push(c); }
      const derived = findOrigin(org, v.def.role, c);
      // 운영 기관이 폐기한 봇을 그대로(또는 거의 그대로) 다시 올리는 것은 막음
      const again = S.customBots.find(x => x !== c && x.orgId === org.id && x.discarded && x.def && MARKET.overlap(v.def.role, x.def.role, copyIgnore()).score);
      if (again) { if (!c.def && !c.versions.length) S.customBots = S.customBots.filter(x => x !== c); return BAD(res, `운영 기관이 폐기한 "${again.def.name}"과(와) 거의 같아서 올릴 수 없어요. 운영 기관에 문의해 주세요.`); }
      // 운영 기관이 폐기한 복사본과 같은 원작을 다시 베껴 올리는 것은 막음
      if (derived && S.customBots.some(x => x.orgId === org.id && x.discarded && x.discarded.originBotId === derived.botId)) { if (!c.def && !c.versions.length) S.customBots = S.customBots.filter(x => x !== c); return BAD(res, `운영 기관이 복사로 확인해 폐기한 봇과 같은 원작(${derived.orgName})을 베낀 것으로 보여 올릴 수 없어요. 직접 만든 봇이라면 운영 기관에 문의해 주세요.`); }
      c.pending = { def: v.def, by: user.name, at: Date.now(), sourceUrl: str(b.sourceUrl, 500), kind: c.def ? 'update' : 'new', derived };
      const room = S.rooms.find(r => r.id === b.roomId && r.orgId === org.id) || S.rooms.find(r => r.orgId === org.id);
      if (room) addMsg(room, { from: 'sys', text: `${user.name}님이 ${c.def ? `"${c.def.name}" 봇 업데이트` : `새 봇 "${v.def.name}"`}를 올렸어요. 확인하고 승인하면 우리 기업 봇 목록에 ${c.def ? '반영돼요' : '올라가요'}.`, botReq: { botId: c.id, status: null, kind: c.pending.kind, def: v.def, by: user.name, sourceUrl: c.pending.sourceUrl, origin: c.derivedFrom ? originView(c.derivedFrom) : originView(c.pending.derived) } });
      save(); emit('room', {}, org.id);
      return json(res, 200, { ok: true, id: c.id });
    }
    if (p === '/api/bots/review') {
      const c = mineBot(b.botId); if (!c || !c.pending) return BAD(res, '승인할 봇이 없어요', 404);
      const room = S.rooms.find(r => r.orgId === org.id && r.msgs.some(m => m.id === b.msgId));
      const msg = room && room.msgs.find(m => m.id === b.msgId);
      if (msg && msg.botReq) msg.botReq.status = b.approve ? 'approved' : 'rejected';
      if (!b.approve) {
        const was = c.pending; c.pending = null;
        if (!c.def) S.customBots = S.customBots.filter(x => x !== c);
        if (room) addMsg(room, { from: 'sys', text: `"${was.def.name}" ${was.kind === 'update' ? '업데이트' : '봇'}를 승인하지 않았어요${b.reason ? ` (${str(b.reason, 100)})` : ''}.` });
        save(); emit('room', {}, org.id); return json(res, 200, { ok: true });
      }
      c.versions.push({ def: c.pending.def, at: Date.now(), by: c.pending.by, approvedBy: user.name, sourceUrl: c.pending.sourceUrl });
      if (c.versions.length > 20) c.versions.shift();
      const wasPublic = c.publicStatus === 'public', kind = c.pending.kind, found = c.pending.derived;
      c.def = c.pending.def; c.pending = null;
      // 복사로 찾으면 원작 연결 (한 번 연결되면 내용을 조금씩 바꿔도 유지, 운영 기관만 풀 수 있음)
      if (found && !c.derivedFrom) {
        c.derivedFrom = { botId: found.botId, orgId: found.orgId, name: found.name, score: found.score, at: Date.now() };
        const oroom = S.rooms.find(r => r.orgId === found.orgId), roy = royaltyOf(originOf(c));
        if (oroom) addMsg(oroom, { from: 'sys', text: `${org.name}이(가) 올린 "${c.def.name}"이(가) 우리 기업의 "${found.name}"과(와) ${found.score}% 같아요. 이 봇이 쓰일 때마다 요청당 ${roy}토큰을 우리 기업이 받아요. 잘못 찾은 것이면 운영 기관에 알려 주세요.` });
      }
      if (wasPublic && kind === 'update') { c.publicStatus = 'pending'; c.publicReqAt = Date.now(); } // 공개 중인 봇이 바뀌면 관리자가 다시 확인
      if (room && c.derivedFrom) addMsg(room, { from: 'sys', text: `"${c.def.name}"은(는) ${(orgById(c.derivedFrom.orgId) || {}).name || '다른 기업'}이(가) 먼저 만든 봇과 ${c.derivedFrom.score}% 같아서 원작 봇으로 연결했어요. 이 봇을 쓸 때마다 요청당 ${royaltyOf(originOf(c))}토큰이 원작 기업에 가요.` });
      if (room) addMsg(room, { from: 'sys', text: `"${c.def.name}" ${kind === 'update' ? `업데이트(버전 ${c.versions.length})를 반영했어요` : '봇을 우리 기업 봇 목록에 올렸어요. "전문가 초대"에서 초대할 수 있어요'}.${wasPublic && kind === 'update' ? ' 다른 기업에 공개 중이던 봇이라 관리자 확인이 끝날 때까지 다른 기업은 잠시 쓸 수 없어요.' : ''}` });
      save(); emit('room', {}, org.id); return json(res, 200, { ok: true });
    }
    if (p === '/api/bots/claim') {
      // 원작 기업이 "이 봇이 우리 봇을 복사했다"고 운영 기관에 요구 (폐기 또는 원작 연결)
      const o = mineBot(b.origBotId); if (!o || !o.def || o.discarded) return BAD(res, '우리 기업이 만든 봇을 원작으로 골라 주세요', 404);
      const want = b.want === 'discard' ? 'discard' : b.want === 'link' ? 'link' : null; if (!want) return BAD(res, '폐기 또는 원작 연결 중 하나를 골라 주세요');
      const reason = str(b.reason, 500); if (reason.length < 5) return BAD(res, '왜 복사라고 보는지 적어 주세요 (5자 이상)');
      let t = null, targetText = '';
      if (b.targetBotId) {
        t = S.customBots.find(x => x.id === b.targetBotId && x.def && !x.discarded && x.orgId !== org.id);
        // 우리가 볼 수 있는 봇만: 공개된 봇, 또는 우리 봇의 복사로 이미 연결된 봇
        if (!t || !(t.publicStatus === 'public' || (t.derivedFrom && t.derivedFrom.botId === o.id))) return BAD(res, '신고할 수 있는 봇이 아니에요. 목록에 없으면 기업·봇 이름을 적어 주세요', 404);
      } else { targetText = str(b.targetText, 200); if (targetText.length < 2) return BAD(res, '복사한 봇을 고르거나, 어느 기업의 어떤 봇인지 적어 주세요'); }
      if (S.claims.filter(x => x.orgId === org.id && x.status === 'open').length >= 10) return BAD(res, '처리 중인 신고가 10개예요. 운영 기관 결정을 기다려 주세요');
      if (t && S.claims.some(x => x.status === 'open' && x.targetBotId === t.id && x.orgId === org.id)) return BAD(res, '이미 신고한 봇이에요');
      const cl = { id: newId('q'), at: Date.now(), orgId: org.id, by: user.name, origBotId: o.id, targetBotId: t ? t.id : null, targetText, targetName: t ? t.def.name : '', targetOrgName: t ? (orgById(t.orgId) || {}).name : '', want, reason, status: 'open', note: '', decidedAt: null };
      S.claims.push(cl); save(); emit('room', {}, '*');
      const room = S.rooms.find(r => r.orgId === org.id);
      if (room) addMsg(room, { from: 'sys', text: `${user.name}님이 "${o.def.name}"의 복사로 보이는 봇(${t ? `${cl.targetOrgName} "${cl.targetName}"` : targetText})을 운영 기관에 신고했어요 (요구: ${want === 'discard' ? '폐기' : '원작으로 연결'}). 결정되면 알려 드려요.` });
      return json(res, 200, { ok: true, id: cl.id });
    }
    if (p === '/api/bots/pricing') {
      const c = mineBot(b.botId); if (!c) return BAD(res, '우리 기업이 만든 봇이 아니에요', 404);
      const int = (v, lo, hi) => v === '' || v == null ? null : (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : NaN);
      const perUse = int(b.perUse, 0, 1000), passDays = int(b.passDays, 1, 365), passPrice = int(b.passPrice, 1, 100000);
      if ([perUse, passDays, passPrice].some(Number.isNaN)) return BAD(res, '요청당 0~1000, 이용권 1~365일·1~100000토큰 사이 정수로 정해 주세요');
      if ((passDays == null) !== (passPrice == null)) return BAD(res, '기간 이용권은 기간과 토큰을 함께 정해 주세요');
      c.pricing = { perUse, passDays, passPrice }; save(); emit('room', {}, '*');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/bots/publish' || p === '/api/bots/unpublish' || p === '/api/bots/delete') {
      const c = mineBot(b.botId); if (!c) return BAD(res, '우리 기업이 만든 봇이 아니에요', 404);
      if (c.discarded) return BAD(res, '운영 기관이 폐기한 봇이에요');
      if (p === '/api/bots/delete') { refundPasses(c, '만든 기업이 삭제'); S.customBots = S.customBots.filter(x => x !== c); save(); emit('room', {}, '*'); return json(res, 200, { ok: true }); }
      if (p === '/api/bots/unpublish') { c.publicStatus = null; refundPasses(c, '만든 기업이 공개 중단'); save(); emit('room', {}, '*'); return json(res, 200, { ok: true }); }
      if (!c.def) return BAD(res, '먼저 기업방에서 승인해 주세요');
      const pr = c.pricing || {};
      if (pr.perUse == null && pr.passPrice == null) return BAD(res, '다른 기업이 쓸 때의 토큰(요청당 또는 기간 이용권)을 먼저 정해 주세요. 무료로 공개하려면 요청당 0으로 정하세요.');
      c.publicStatus = 'pending'; c.publicReqAt = Date.now(); c.publicReason = null; save(); emit('room', {}, org.id);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/bots/pass') {
      const c = S.customBots.find(x => x.id === b.botId && x.publicStatus === 'public' && x.orgId !== org.id);
      if (!c) return BAD(res, '이용권을 살 수 있는 봇이 아니에요', 404);
      const pr = c.pricing || {}; if (pr.passPrice == null) return BAD(res, '이 봇은 기간 이용권이 없어요');
      if (!reserveTokens(org, pr.passPrice)) return BAD(res, `이용권은 ${pr.passPrice}토큰이에요. 잔액(${org.wallet}토큰)이 부족해요.`);
      c.passes = c.passes || {};
      const start = Math.max(Date.now(), c.passes[org.id] || 0), until = start + pr.passDays * 864e5;
      c.passes[org.id] = until;
      const o = originOf(c), to = o && orgById(o.orgId) && o.orgId !== org.id ? o : null;
      // 환불할 때 누가 얼마를 받았는지 알 수 있게 구매마다 기록
      c.passLog = c.passLog || [];
      const pay = payShare(org, c, pr.passPrice, 'pass', null, to) || { fee: 0 };
      c.passLog.push({ orgId: org.id, paidTo: to ? to.orgId : c.orgId, amount: pr.passPrice, fee: pay.fee, start, until, at: Date.now() });
      emit('room', {}, org.id);
      return json(res, 200, { ok: true, until: c.passes[org.id] });
    }
    return BAD(res, '없는 기능이에요', 404);
  }

  // ----- 일정표 -----
  if (p === '/api/sched' && req.method === 'GET') { const sc = ensureSched(org); return json(res, 200, { url: schedUrl(org), v: sc.v, items: sc.items, log: sc.log.slice(0, 30) }); }
  if (p === '/api/todo/token' && req.method === 'POST') { const td = ensureTodo(org); td.token = crypto.randomBytes(12).toString('hex'); td.editToken = crypto.randomBytes(16).toString('hex'); save(); emit('todo', {}, org.id); return json(res, 200, { url: todoUrl(org), editUrl: todoEditUrl(org) }); }
  if (p === '/api/sched/token' && req.method === 'POST') { const sc = ensureSched(org); sc.token = crypto.randomBytes(12).toString('hex'); save(); emit('sched', {}, org.id); return json(res, 200, { url: schedUrl(org) }); }

  // ----- IR 자료 -----
  if (p.startsWith('/api/ir')) {
    const ir = ensureIr(org), url = new URL(req.url, 'http://x');
    const meta = v => ({ id: v.id, n: v.n, at: v.at, note: v.note, request: v.request, title: v.outline.title, count: v.outline.slides.length });
    if (req.method === 'GET') {
      if (p === '/api/ir') {
        const cur = irLatest(org);
        return json(res, 200, {
          current: cur ? { ...meta(cur), outline: cur.outline } : null, versions: ir.versions.slice().reverse().map(meta),
          comments: ir.comments, final: ir.final, vcs: ir.vcs, hasBot: S.rooms.some(r => r.orgId === org.id && r.bots.includes('ir')),
          reviewers: ir.reviewers.map(id => expertById(id)).filter(Boolean).map(e => ({ id: e.id, name: e.name, field: e.field })),
          experts: publicExperts().map(e => ({ id: e.id, name: e.name, field: e.field, inConsult: S.rooms.some(r => r.orgId === org.id && (r.humans || []).includes(e.id)) }))
        });
      }
      if (p === '/api/ir/version') { const v = ir.versions.find(x => x.id === url.searchParams.get('id')); return v ? json(res, 200, { ...meta(v), outline: v.outline }) : BAD(res, '없는 버전이에요', 404); }
      if (p === '/api/ir/pptx') {
        if (!ir.final) return BAD(res, '먼저 최종 확정해 주세요', 400);
        const v = ir.versions.find(x => x.id === ir.final.id); if (!v) return BAD(res, '확정한 버전을 찾을 수 없어요', 404);
        const buf = await DECK.buildDeck(v.outline, org.name);
        const fname = `${String(org.name || '기업').replace(/[\\/:*?"<>|\s]+/g, '_')}_IR_v${v.n}_최종.pptx`;
        res.writeHead(200, { 'content-type': PPTX_MIME, 'content-length': buf.length, 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}` });
        return res.end(buf);
      }
      return BAD(res, '없는 기능이에요', 404);
    }
    if (req.method !== 'POST') return BAD(res, '없는 기능이에요', 404);
    const b = await body(req);
    if (p === '/api/ir/comment') { const r = addIrComment(org, b.slide, b.text, { kind: 'org', name: user.name, id: user.id }); return r.error ? BAD(res, r.error) : json(res, 200, { ok: true, id: r.comment.id }); }
    if (p === '/api/ir/dismiss') { const c = ir.comments.find(x => x.id === b.id && x.status === 'open'); if (!c) return BAD(res, '없는 코멘트예요', 404); c.status = 'dismissed'; c.reply = str(b.reason, 200) || '기업이 반영하지 않기로 함'; save(); emit('ir', {}, org.id); emitIrx(org); return json(res, 200, { ok: true }); }
    if (p === '/api/ir/apply') {
      const room = S.rooms.find(r => r.orgId === org.id && r.bots.includes('ir'));
      if (!room) return BAD(res, '먼저 채팅방에 IR 봇을 초대해 주세요');
      const n = ir.comments.filter(c => c.status === 'open').length;
      if (!n) return BAD(res, '반영할 코멘트가 없어요');
      addMsg(room, { from: 'me', text: `전문가 코멘트 ${n}개를 반영해 주세요` });
      await runBot(room, 'ir', `전문가 코멘트 ${n}개를 반영해 주세요`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/ir/final') {
      const v = ir.versions.find(x => x.id === b.versionId); if (!v) return BAD(res, '없는 버전이에요', 404);
      const marks = JSON.stringify(v.outline.slides).match(/\[확인 필요/g) || [];
      const open = ir.comments.filter(c => c.status === 'open').length;
      if ((marks.length || open) && !b.force) return json(res, 409, { error: `아직 [확인 필요] ${marks.length}곳, 반영하지 않은 코멘트 ${open}개가 있어요. 그래도 확정할까요?`, marks: marks.length, open });
      ir.final = { id: v.id, n: v.n, at: Date.now(), by: user.name }; save(); emit('ir', {}, org.id);
      const room = irRoom(org); if (room) addMsg(room, { from: 'sys', text: `IR v${v.n}을 최종 확정했어요. "IR 자료" 화면에서 PPTX로 내려받을 수 있어요.` });
      notifyIrExperts(org, `IR v${v.n}이 최종 확정됐어요. 검토해 주셔서 감사합니다.`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/ir/unfinal') { ir.final = null; save(); emit('ir', {}, org.id); return json(res, 200, { ok: true }); }
    if (p === '/api/ir/reviewer') {
      const ex = expertById(b.expertId); if (!ex || !ex.tgChatId) return BAD(res, '없는 전문가예요', 404);
      if (b.add) { if (!ir.reviewers.includes(ex.id)) ir.reviewers.push(ex.id); }
      else ir.reviewers = ir.reviewers.filter(id => id !== ex.id);
      save(); emit('ir', {}, org.id); emitIrx(org);
      if (b.add && irLatest(org)) notifyIrExperts(org, `${org.name}이(가) IR 자료 검토를 부탁했어요 (현재 v${irLatest(org).n}). 장별로 코멘트를 남겨 주세요.`, [ex.id]);
      return json(res, 200, { ok: true });
    }
    return BAD(res, '없는 기능이에요', 404);
  }

  // ----- 마케팅 봇 PPT 내려받기 -----
  if (p === '/api/deck/download' && req.method === 'GET') {
    const d = deckById(org, new URL(req.url, 'http://x').searchParams.get('id'));
    if (!d) return BAD(res, '없는 PPT예요', 404);
    const buf = await DECK.buildDeck(d.outline, org.name);
    res.writeHead(200, { 'content-type': PPTX_MIME, 'content-length': buf.length, 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(deckFileName(org, d))}` });
    return res.end(buf);
  }

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
    const bot = botById(b.botId); if (!bot || !canUseBot(org, bot.id)) return BAD(res, '없는 봇이에요');
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
    ensureFunds(org, amt);
    if (amt > org.wallet) return BAD(res, `잔액이 부족해요 (현재 ${org.wallet}개). 관리자에게 충전을 요청해 주세요.`);
    const ef = takeFee('e:' + ex.id, amt);
    org.wallet -= amt; ex.balance += ef.net; src.pay.paid = amt;
    const memo = str(b.memo, 200);
    if (ef.fee) record(org, { type: 'fee', amount: ef.fee, source: 'pay', gross: amt, expertName: ex.name });
    record(org, { type: 'pay', amount: amt, expertNet: ef.net, fee: ef.fee, expertId: ex.id, expertName: ex.name, expertAfter: ex.balance, roomId: room.id, roomName: room.name, memo, minutes: src.pay.minutes, rate: src.pay.rate, suggested: src.pay.suggested });
    afterSpend(org);
    addMsg(room, { from: 'sys', text: `${ex.name} 전문가에게 상담 토큰 ${amt}개를 보냈어요 (남은 잔액 ${org.wallet}개)` });
    if (ex.tgChatId) dmExpert(ex, room, `상담 토큰 ${ef.net}개를 받았어요${ef.fee ? ` (기업이 보낸 ${amt}개 중 운영 기관 몫 ${ef.fee}개 제외)` : ''}.${memo ? '\n메시지: ' + memo : ''}\n현재 잔액: ${ex.balance}개`);
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
    if (!inRoom) ensureFunds(org, ex.rate);
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
    if (b.to && room.bots.includes(b.to)) runBot(room, b.to, text, { author: user.name, source: 'web' });
    return json(res, 200, { ok: true });
  }
}

// ---------- 할 일표 편집 링크 API (로그인 없이 편집 토큰으로) ----------
async function todoEditApi(req, res, p) {
  const m = p.match(/^\/api\/te\/([a-f0-9]{32})$/);
  const org = m && S.orgs.find(o => o.todo && o.todo.editToken === m[1]);
  if (!org) return BAD(res, '없는 편집 링크이거나 링크가 바뀌었어요', 404);
  const td = org.todo, today = todayKst();
  const view = () => ({ org: org.name, v: td.v, items: td.items, cycle: td.cycle, today, next: TODO.upcoming(td, today), viewUrl: todoUrl(org), log: td.log.slice(0, 20) });
  if (req.method === 'GET') return json(res, 200, view());
  if (req.method !== 'POST') return BAD(res, '잘못된 요청', 405);
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return BAD(res, '잘못된 요청', 415);
  const b = await body(req), who = str(b.name, 30) || '편집 링크';
  if (b.v != null && +b.v !== td.v) return json(res, 409, { error: '다른 사람이 먼저 고쳤어요. 새로 불러온 내용을 확인하고 다시 고쳐 주세요.', ...view() });
  if (b.cycle) {
    const c = b.cycle, days = +c.days, hour = +c.hour;
    if (!SCHED.isDate(c.start) || ![7, 14, 21, 28].includes(days) || !(hour >= 6 && hour <= 12)) return BAD(res, '점검 주기는 시작일·7/14/21/28일·알림 6~12시로 정해 주세요');
    const old = td.cycle;
    td.cycle = { start: c.start, days, hour, weekdays: !!c.weekdays };
    td.v++; td.updatedAt = Date.now();
    td.log.unshift({ at: Date.now(), by: who, source: 'edit', v: td.v, changes: [`점검 주기: ${old.days}일·${old.hour}시 → ${days}일·${hour}시${td.cycle.weekdays ? ' (평일 알림)' : ''}, 시작 ${c.start}`] });
    save(); emit('todo', {}, org.id);
    return json(res, 200, view());
  }
  const ops = (Array.isArray(b.ops) ? b.ops : []).slice(0, 20).filter(o => o && ['add', 'update', 'cancel', 'done', 'restore', 'delete'].includes(o.op));
  if (!ops.length) return BAD(res, '고칠 내용이 없어요');
  const r = SCHED.applyOps(td, ops, who, 'edit', { allowDelete: true, exact: true });
  if (!r.applied.length) return BAD(res, r.errors.join(' / ') || '고치지 못했어요');
  save(); emit('todo', {}, org.id);
  for (const room of todoRooms(org)) addMsg(room, { from: 'sys', text: `${who}님이 할 일표 편집 링크에서 고쳤어요 (버전 ${td.v})\n${r.applied.map(a => '· ' + a.summary).join('\n')}` });
  return json(res, 200, { ...view(), errors: r.errors });
}

// ---------- HTTP 서버 ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  const sess = getSession(req);
  try {
    if (p === '/api/events') {
      const user = sess && sess.kind === 'user' && userById(sess.userId);
      const exs = sess && sess.kind === 'expert' && expertById(sess.expertId);
      if (!user && !exs && !(sess && sess.kind === 'admin')) return BAD(res, '로그인이 필요해요', 401);
      if (exs) { // 전문가: IR 변경 알림만 받음 ('*'로 보내는 이벤트)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 3000\n\n'); clients.set(res, { orgId: 'expert:' + exs.id, admin: false });
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        return req.on('close', () => { clearInterval(ping); clients.delete(res); });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.set(res, { orgId: user ? user.orgId : null, admin: !user });
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      return req.on('close', () => { clearInterval(ping); clients.delete(res); });
    }
    if (p.startsWith('/api/te/')) return await todoEditApi(req, res, p);
    if (p.startsWith('/api/admin/')) return await adminApi(req, res, p, sess);
    if (p.startsWith('/api/expert/')) return await expertApi(req, res, p, sess);
    if (p.startsWith('/api/')) return await userApi(req, res, p, sess);
  } catch (e) { console.error(e); return BAD(res, '서버 오류가 났어요', 500); }

  // 일정표 간트차트 (링크를 아는 사람만, 로그인 없이)
  const gm = p.match(/^\/g\/([a-f0-9]{24})\/?$/);
  if (gm) {
    const org = S.orgs.find(o => o.sched && o.sched.token === gm[1]);
    if (!org) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!DOCTYPE html><meta charset="utf-8"><title>없는 일정표</title><p style="font-family:sans-serif;padding:40px">없는 일정표이거나 링크가 바뀌었어요.</p>'); }
    res.writeHead(200, { ...SITE_HEADERS, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    return res.end(SCHED.renderGantt(org, org.sched));
  }
  // 인재 본인 동의 페이지
  const cn = p.match(/^\/c\/([a-f0-9]{32})\/?$/);
  if (cn) return handleConsent(req, res, cn[1]);
  // 할 일표 (보기 링크) · 할 일표 고치기 (편집 링크)
  const tm = p.match(/^\/t\/([a-f0-9]{24})\/?$/);
  if (tm) {
    const org = S.orgs.find(o => o.todo && o.todo.token === tm[1]);
    if (!org) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!DOCTYPE html><meta charset="utf-8"><title>없는 할 일표</title><p style="font-family:sans-serif;padding:40px">없는 할 일표이거나 링크가 바뀌었어요.</p>'); }
    res.writeHead(200, { ...SITE_HEADERS, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
    return res.end(TODO.renderTodo(org, org.todo, todayKst()));
  }
  if (/^\/te\/[a-f0-9]{32}\/?$/.test(p)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'todo-edit.html')));
  }
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

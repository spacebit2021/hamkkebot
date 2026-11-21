// 보안 봇: 소유 인증한 사이트만, 겉에서 보는 점검 → 등급·발견한 점·고칠 방법, 매일 자동, 결과는 우리 기업만 보는 게시판, 점검마다 토큰 (가짜 사이트·Claude)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const SITE = 'https://93.184.216.34', T0 = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
const at = (d, hm) => String(Date.parse(`${d}T${hm}:00+09:00`)), next = d => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
// 가짜 사이트 상태 (점검 사이에 바꿈)
const W = { token: '', headers: { server: 'Apache/2.4.29', 'set-cookie': 'sid=abc; Path=/' }, body: '<html><img src="http://cdn.example.org/a.png"></html>', git: true, redirect: false };
let aiFail = false; const prompts = [];
const resp = (status, headers = {}, body = '') => ({ status, ok: status < 300, headers: { get: k => headers[k.toLowerCase()] == null ? null : headers[k.toLowerCase()], getSetCookie: () => headers['set-cookie'] ? [headers['set-cookie']] : [] }, text: async () => body });
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  if (u.includes('/v1/messages')) { prompts.push(JSON.parse(opt.body)); return aiFail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '요약: 인증서는 괜찮지만 보안 헤더가 빠져 있어요. 먼저 .git 폴더 접근을 막으세요.' }] }) }; }
  if (u === 'http://93.184.216.34/') return W.redirect ? resp(301, { location: 'https://93.184.216.34/' }) : resp(200, {}, 'plain');
  if (u === SITE + '/') return resp(200, W.headers, W.body);
  if (u === SITE + '/.well-known/hamkkebot-verify.txt') return W.token ? resp(200, {}, W.token) : resp(404);
  if (u === SITE + '/.git/HEAD') return W.git ? resp(200, {}, 'ref: refs/heads/main\n') : resp(404);
  if (u === SITE + '/.env') return resp(404);
  if (u === SITE + '/.well-known/security.txt') return resp(404);
  if (u.startsWith('https://93.184.216.35')) return resp(200, {}, '');
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3971', TELEGRAM_BOT_TOKEN: '', SEC_TICK_MS: '60', HB_NOW: at(T0, '05:00') });
const SEC = require(path.join(__dirname, '..', 'security.js'));
SEC.io.tlsInfo = async () => ({ validTo: Date.now() + 20 * 864e5, issuer: 'Test CA', protocol: 'TLSv1.3', authorized: true, error: null });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3971' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 30 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const Wl = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const say = async (k, text) => { await U[k](`/api/rooms/${room[k]}/messages`, { text, to: 'security' }); await sl(150); return (await msgs(k)).filter(m => m.from === 'security').pop().text; };
  await U.A(`/api/rooms/${room.A}/invite`, { botId: 'security' });
  chk('초대하면 「보안 점검 기록」 게시판 탭 (우리 기업만)', (await U.A('/api/state')).j.boardTabs.some(t => t.botId === 'security' && t.name === '보안 점검 기록' && t.visibility === 'own'));

  // 등록·인증
  let t = await say('A', `사이트 등록 ${SITE}`);
  const token = (t.match(/hb-verify-[0-9a-f]{16}/) || [])[0];
  chk('사이트 등록 → 소유 인증 방법 (파일·메타 태그), 무료', token && t.includes('/.well-known/hamkkebot-verify.txt') && t.includes('<meta name="hamkkebot-verify"') && await Wl('A') === 30);
  chk('내부망 주소는 등록 못 함', (await say('A', '사이트 등록 https://127.0.0.1')).includes('점검할 수 없는 주소'));
  chk('인증 전엔 점검 안 함', (await say('A', '지금 점검해 줘')).includes('소유 인증된 사이트가 없어요') && await Wl('A') === 30);
  chk('인증 값이 없으면 실패 안내', (await say('A', '사이트 인증 확인해 줘')).includes('인증 값을 찾지 못했어요'));
  W.token = token;
  chk('파일에 인증 값을 올리면 인증', (await say('A', '사이트 인증 확인해 줘')).includes('인증됐어요 (파일)'));

  // 직접 점검
  await U.A(`/api/rooms/${room.A}/messages`, { text: '지금 점검해 줘', to: 'security' }); await sl(400);
  t = (await msgs('A')).filter(m => m.from === 'security').pop();
  chk('점검 1번 = 3토큰', await Wl('A') === 27 && t.cost === 3);
  chk('결과: 등급·점수·먼저 고칠 것', /\[보안 점검\] https:\/\/93\.184\.216\.34\n[A-F]등급 \(\d+점\)/.test(t.text) && t.text.includes('Git 저장소(.git)가 밖에서 열려요') && t.text.includes('기본 점검이라 모든 취약점을 찾지는 못해요'));
  const bb = (await U.A('/api/bboard?bot=security')).j.posts;
  const v = bb[0] && bb[0].values;
  chk('게시판 「보안 점검 기록」에 저장', bb.length === 1 && v.site === SITE && v.day === T0 && v.summary.startsWith('요약:') && v.changes === '첫 점검이에요.');
  chk('발견한 점: HSTS·CSP·클릭재킹·버전 노출·쿠키·혼합 콘텐츠·http→https 이동·.git·인증서 만료 임박', ['HSTS', 'CSP', '클릭재킹', '버전이 보여요', 'Secure 설정이 없어요', '혼합 콘텐츠', 'https로 넘겨 주지 않아요', '.git', '20일 뒤 만료'].every(k => v.findings.includes(k)));
  chk('AI에는 점검 결과만, 지어내지 말라는 규칙', prompts[prompts.length - 1].system.includes('결과에 없는 내용은 쓰지 마세요') && prompts[prompts.length - 1].messages[0].content.includes('Git 저장소'));
  // 다른 기업·운영 기관은 결과를 못 봄
  await U.B(`/api/rooms/${room.B}/invite`, { botId: 'security' });
  chk('같은 봇을 쓰는 다른 기업도 우리 결과는 못 봄', (await U.B('/api/bboard?bot=security')).j.posts.length === 0);
  chk('운영 기관도 내용은 못 봄', (await Ad('/api/admin/state')).j.bposts.filter(p => p.botId === 'security').every(p => p.internal && !Object.keys(p.values).length));
  chk('다른 기업은 남의 사이트를 인증 없이 점검 못 함', (await say('B', `사이트 등록 ${SITE}`)).includes('소유 인증') && (await say('B', '지금 점검해 줘')).includes('소유 인증된 사이트가 없어요'));

  // 고친 뒤 자동 점검 (매일 6시)
  W.headers = { 'strict-transport-security': 'max-age=31536000', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'permissions-policy': 'camera=()', server: 'nginx', 'set-cookie': 'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax' };
  W.body = '<html><img src="https://cdn.example.org/a.png"></html>'; W.git = false; W.redirect = true;
  const w1 = await Wl('A');
  process.env.HB_NOW = at(next(T0), '06:03'); await sl(500);
  const auto = (await msgs('A')).filter(m => m.from === 'security').pop();
  chk('다음 날 6시 자동 점검 (3토큰)', auto.text.startsWith('[보안 점검 · 자동]') && await Wl('A') === w1 - 3);
  const v2 = (await U.A('/api/bboard?bot=security')).j.posts[0].values;
  chk('고친 뒤: 등급이 오르고 해결된 문제 표시', /→ [AB]등급/.test(v2.changes) && v2.changes.includes('해결된 문제') && v2.changes.includes('Git 저장소'));
  await sl(300);
  chk('하루에 한 번만 자동 점검', (await U.A('/api/bboard?bot=security')).j.posts.length === 2);
  // AI 실패 → 규칙 요약 / 하루 직접 점검 5번
  aiFail = true;
  await U.A(`/api/rooms/${room.A}/messages`, { text: '지금 점검해 줘', to: 'security' }); await sl(400); aiFail = false;
  chk('AI가 안 되면 규칙으로 요약해 저장', (await U.A('/api/bboard?bot=security')).j.posts[0].values.summary.includes('규칙으로 정리했어요'));
  for (let i = 0; i < 4; i++) { await U.A(`/api/rooms/${room.A}/messages`, { text: '지금 점검해 줘', to: 'security' }); await sl(250); }
  chk('직접 점검은 하루 5번까지', (await say('A', '지금 점검해 줘')).includes('내일 다시 할 수 있어요'));
  // 토큰 부족
  const oA = (await Ad('/api/admin/state')).j.orgs.find(o => o.name === '마을빵공방').id;
  await Ad(`/api/admin/orgs/${oA}/deduct`, { amount: await Wl('A') });
  const n0 = (await U.A('/api/bboard?bot=security')).j.posts.length;
  process.env.HB_NOW = at(next(next(T0)), '06:03'); await sl(500);
  chk('토큰이 모자라면 점검하지 않고 안내', (await U.A('/api/bboard?bot=security')).j.posts.length === n0 && (await msgs('A')).some(m => m.from === 'sys' && m.text.includes('보안 봇 사이트 점검')));
  // 시각 변경·목록·삭제
  chk('점검 시각 변경', (await say('A', '점검 시각 7시')).includes('매일 7시'));
  chk('사이트 목록: 인증 상태·지난 등급', (await say('A', '사이트 목록 보여 줘')).includes('인증됨 · 지난 점검'));
  chk('사이트 삭제', (await say('A', `${SITE} 삭제`)).includes('점검 목록에서 뺐어요') && (await say('A', '사이트 목록')).includes('등록된 사이트가 없어요'));
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

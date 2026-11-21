// 운영 기관 몫: 모든 소득(봇 이용 몫·원작 몫·이용권·인재 추천 보상·전문가 상담비)의 10%, 작은 금액은 모아서, 환불 땐 운영 기관 몫도 돌려줌
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
let OFF = 0; const realNow = Date.now; Date.now = () => realNow() + OFF;
const sent = [], queue = []; let waiter = null, mid = 100;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) { const msg = JSON.parse(opt.body).messages[0].content; const out = /박지은/.test(msg) ? { ok: true, profile: { title: '디자이너 · 3년차', summary: '패키지 디자인을 잘해요.', skills: ['일러스트레이터'] }, private: { name: '박지은', contact: '010-0000-0000' } } : null; return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: out ? JSON.stringify(out) : '답변입니다' }] }); }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; const b = JSON.parse(opt.body); sent.push([b.chat_id, b.text]); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3999', TELEGRAM_BOT_TOKEN: 'x' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3999' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const page = (u, action) => new Promise(r => { const q = http.request('http://localhost:3999' + u.replace(/^https?:\/\/[^/]*/, ''), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, res => { res.resume(); res.on('end', r); }); q.write('action=' + action); q.end(); });
const sl = ms => new Promise(r => setTimeout(r, ms));
const LINES = ['자료에서 날짜와 금액을 표로 정리하세요.', '마감이 가까운 일부터 알려 주세요.', '서류 이름은 정식 이름으로 적으세요.', '확인이 필요한 부분은 마지막에 모으세요.', '용어를 풀어 설명하세요.', '답의 끝에 다음 할 일을 적으세요.'];
const role = (t, i) => `당신은 ${t} 전용 도우미입니다 (번호 ${i}).\n` + LINES.map((l, k) => `${k + 1}. ${t} 기준 ${i}-${k}: ${LINES[(k + i) % LINES.length]}`).join('\n');
const D = (name, r) => ({ hamkkebot: 1, name, short: name[0], color: '#2D6A4F', tag: '점검', desc: name + ' 설명', hello: '안녕', quick: [], kind: 'chat', role: r });
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 300 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const W = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const attach = async (k, def) => { const s = await U[k]('/api/bots/submit', { def, roomId: room[k] }); const c = (await msgs(k)).filter(m => m.botReq).pop(); await U[k]('/api/bots/review', { botId: s.j.id, msgId: c.id, approve: true }); return s.j.id; };
  const publish = async (k, id, pr) => { await U[k]('/api/bots/pricing', { botId: id, ...pr }); await U[k]('/api/bots/publish', { botId: id }); await Ad(`/api/admin/bots/${id}/approve`, {}); };
  const use = async (k, id) => { await U[k](`/api/rooms/${room[k]}/invite`, { botId: id }); await U[k](`/api/rooms/${room[k]}/messages`, { text: '점검', to: id }); await sl(100); };
  const plat = async () => (await Ad('/api/admin/state')).j.platformFees;
  chk('기본 운영 기관 몫 10%', (await Ad('/api/admin/state')).j.feePct === 10 && (await U.A('/api/state')).j.feePct === 10);

  // 봇 이용 몫: 요청당 10 → 만든 기업 9, 운영 기관 1
  const bot = await attach('A', D('세무 봇', role('세무', 1)));
  await publish('A', bot, { perUse: 10 });
  let wa = await W('A'), wb = await W('B');
  await use('B', bot);
  chk('요청당 10토큰: 이용 기업은 그대로 11, 만든 기업은 9', await W('B') === wb - 11 && await W('A') === wa + 9 && await plat() === 1);
  const led = (await Ad('/api/admin/state')).j.ledger;
  chk('거래 기록: 받은 몫(9, 원래 10)과 운영 기관 몫(1)', led.some(l => l.type === 'share_in' && l.amount === 9 && l.gross === 10 && l.fee === 1) && led.some(l => l.type === 'fee' && l.amount === 1 && l.source === 'share_in'));
  // 작은 금액은 모아서: 요청당 2를 5번 = 10 중 1
  const b2 = await attach('A', D('노무 봇', role('노무', 2)));
  await publish('A', b2, { perUse: 2 });
  wa = await W('A'); const p0 = await plat();
  for (let i = 0; i < 5; i++) await use('C', b2);
  chk('요청당 2토큰 × 5번 = 10 → 만든 기업 9, 운영 기관 1 (작은 금액도 정확히 10%)', await W('A') === wa + 9 && await plat() === p0 + 1);

  // 원작 몫
  const copy = await attach('B', D('세무 비서', role('세무', 1) + ' 덧붙임.'));
  wa = await W('A');
  for (let i = 0; i < 10; i++) await use('B', copy);
  chk('복사본 원작 몫 10 × 10번 = 100 → 원작 기업 90', await W('A') === wa + 90);

  // 이용권과 환불: 30토큰 → 27, 4일 뒤 폐기 → 18 환불 (받은 기업 16 + 운영 기관 2)
  const b3 = await attach('A', D('홍보 봇', role('홍보', 3)));
  await publish('A', b3, { passDays: 10, passPrice: 30 });
  wa = await W('A');
  await U.C('/api/bots/pass', { botId: b3 });
  chk('이용권 30토큰 → 만든 기업 27', await W('A') === wa + 27);
  OFF += 4 * 864e5; await Ad('/api/admin/login', { password: 'adminpass' }); for (const k in U) await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' });
  const wc = await W('C'), wa2 = await W('A'), p1 = await plat();
  await Ad(`/api/admin/bots/${b3}/discard`, { reason: '시험' });
  chk('환불 18: 이용 기업 +18, 받은 기업은 받았던 만큼만 −16, 운영 기관 몫 2도 돌려줌', await W('C') === wc + 18 && await W('A') === wa2 - 16 && await plat() === p1 - 2);

  // 인재 추천 보상 10 → 9
  await Ad('/api/admin/fee', { pct: 10 });
  await U.A(`/api/rooms/${room.A}/invite`, { botId: 'talent' }); await U.B(`/api/rooms/${room.B}/invite`, { botId: 'talent' });
  await U.A(`/api/rooms/${room.A}/messages`, { text: '박지은 추천', to: 'talent' }); await sl(120);
  const tid = (await msgs('A')).filter(m => m.talent).pop().talent.id;
  const ln = await U.A('/api/talent/consent-link', { id: tid }); await page(ln.j.consentUrl, 'agree');
  wa = await W('A');
  await U.B('/api/talent/pick', { id: tid });
  chk('인재 고르기 10토큰 → 추천 기업 9, 알림에 운영 기관 몫 안내', await W('A') === wa + 9 && (await msgs('A')).some(m => m.text.includes('9토큰을 받았어요 (10토큰 중 운영 기관 몫 1 제외)')));

  // 전문가 상담비 20 → 18
  const ex = (await Ad('/api/admin/experts', { name: '김세무', field: '세무사' })).j;
  push({ update_id: 1, message: { chat: { id: 77, type: 'private' }, from: { first_name: '김' }, text: '/expert ' + ex.regCode } }); await sl(120);
  push({ update_id: 2, message: { chat: { id: 77, type: 'private' }, from: { first_name: '김' }, text: '/rate 10' } }); await sl(120);
  await U.A(`/api/rooms/${room.A}/call`, { expertId: ex.id, text: '질문' }); await sl(50);
  await U.A(`/api/rooms/${room.A}/end`, { expertId: ex.id });
  const pm = (await msgs('A')).filter(m => m.pay).pop();
  const wa3 = await W('A');
  await U.A(`/api/rooms/${room.A}/pay`, { msgId: pm.id, amount: 20 });
  const exs = (await Ad('/api/admin/state')).j.experts.find(e => e.id === ex.id);
  chk('전문가 상담비 20 → 기업 −20, 전문가 18', await W('A') === wa3 - 20 && exs.balance === 18);
  chk('전문가에게 운영 기관 몫 안내', sent.filter(s => s[0] === 77).some(s => s[1].includes('상담 토큰 18개를 받았어요 (기업이 보낸 20개 중 운영 기관 몫 2개 제외)')));

  // 비율 바꾸기
  chk('비율은 0~30%', (await Ad('/api/admin/fee', { pct: 50 })).s === 400);
  await Ad('/api/admin/fee', { pct: 0 });
  wa = await W('A'); await use('B', bot);
  chk('0%로 바꾸면 전액', await W('A') === wa + 10);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

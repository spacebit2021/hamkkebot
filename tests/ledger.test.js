// 모든 토큰 이동이 원장을 거치는지: 충전·차감·무제한 자동 충전·봇 사용·실패 환불·몫 나눔·이용권 환불·전문가 상담비·정산·기업 삭제
// 단계마다 "발행량 = 모든 지갑 잔액의 합", 운영 기관 지갑·운영 기관 몫 환전 (충전 페이지 운영자 화면)
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
const PDATA = path.join(os.tmpdir(), 'hb-portal-' + process.pid + '.json');
for (const f of [process.env.DATA_FILE, PDATA]) try { fs.unlinkSync(f); } catch (e) {}
process.on('exit', () => { for (const f of [process.env.DATA_FILE, PDATA]) try { fs.unlinkSync(f); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
let OFF = 0; const realNow = Date.now; Date.now = () => realNow() + OFF;
const realFetch = global.fetch, queue = [], sent = []; let waiter = null, fail = false;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) return fail ? { ok: false, status: 500, json: async () => ({}) } : ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] });
  if (u.includes('api.telegram.org')) {
    if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
    if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
    if (u.includes('/sendMessage')) { sent.push(JSON.parse(opt.body)); return ok({ ok: true, result: { message_id: 1 } }); }
    return ok({ ok: true, result: {} });
  }
  return realFetch(url, opt);
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3973', TELEGRAM_BOT_TOKEN: 'x', CHARGE_PORTAL_URL: 'http://localhost:3972', CHAIN_BLOCK_MS: '100' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk(port = 3973) { let ck = ''; return (p, b, form) => new Promise(r => { const raw = b == null ? '' : form ? new URLSearchParams(b).toString() : JSON.stringify(b); const q = http.request(`http://localhost:${port}` + p, { method: b == null ? 'GET' : 'POST', headers: { ...(ck ? { cookie: ck } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => { const sc = res.headers['set-cookie']; if (sc && !/Max-Age=0/.test(sc[0])) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, h: res.headers }); }); }); if (raw) q.write(raw); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {}, oid = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C'], ['카페', 'E']]) { const r = await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) oid[{ 마을빵공방: 'A', 꽃가게: 'B', 책방: 'C', 카페: 'E' }[o.name]] = o.id;
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const W = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const chain = async () => (await Ad('/api/admin/state')).j.chain;
  const ok = async label => { await sl(220); const c = await chain(); chk(`${label} → 발행량 = 잔액 합 (${c.supply.supply})`, c.supply.ok && c.txs.every(t => t.layer === 'chain' ? t.status === 'confirmed' && t.blockNumber : t.status === 'recorded' && !t.blockNumber)); return c; };
  const kinds = async () => (await chain()).txs.map(t => t.kind);

  for (const k of ['A', 'B', 'E']) await Ad(`/api/admin/orgs/${oid[k]}/charge`, { amount: 100 });
  let c = await ok('관리자 충전');
  chk('관리자 충전도 발행(mint) 거래', c.txs.filter(t => t.type === 'mint' && t.kind === 'admin_charge').length === 3);
  await Ad(`/api/admin/orgs/${oid.E}/deduct`, { amount: 30 });
  c = await ok('관리자 차감');
  chk('관리자 차감은 소각(burn) 거래', c.txs.some(t => t.type === 'burn' && t.kind === 'admin_deduct' && t.amount === 30));

  // 봇 사용 → 운영 기관 지갑, 실패 → 환불
  await U.A(`/api/rooms/${room.A}/invite`, { botId: 'mkt' });
  await U.A(`/api/rooms/${room.A}/messages`, { text: '인스타 글', to: 'mkt' }); await sl(120);
  c = await ok('봇 사용');
  chk('봇 사용료는 운영 기관 지갑으로 이동', c.treasury.wallet === 1 && c.txs.some(t => t.type === 'transfer' && t.kind === 'reserve' && t.fromName === '마을빵공방' && t.orgName === '운영 기관'));
  fail = true; await U.A(`/api/rooms/${room.A}/messages`, { text: '또', to: 'mkt' }); await sl(120); fail = false;
  c = await ok('AI 실패 환불');
  chk('실패하면 운영 기관 지갑에서 돌려줌', c.treasury.wallet === 1 && (await W('A')) === 99 && (await kinds()).includes('refund'));

  // 무제한 자동 충전
  await Ad(`/api/admin/orgs/${oid.C}/unlimited`, { until: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), refillTo: 20 });
  await U.C(`/api/rooms/${room.C}/invite`, { botId: 'mkt' });
  await U.C(`/api/rooms/${room.C}/messages`, { text: '글', to: 'mkt' }); await sl(120);
  c = await ok('무제한 자동 충전');
  chk('무제한 자동 충전은 발행(refill) 거래', c.txs.some(t => t.type === 'mint' && t.kind === 'refill'));

  // 몫 나눔 (10%) + 이용권 + 폐기 환불
  const d = { hamkkebot: 1, name: '세무 봇', short: '세', color: '#2D6A4F', tag: '세무', desc: '세무', hello: '안녕', quick: [], kind: 'chat', role: '당신은 사회적기업 세무 도우미입니다. 서류를 확인하고 모르는 것은 확인하라고 하세요.' };
  const sb = await U.A('/api/bots/submit', { def: d, roomId: room.A }); const card = (await msgs('A')).filter(m => m.botReq).pop(); await U.A('/api/bots/review', { botId: sb.j.id, msgId: card.id, approve: true });
  await U.A('/api/bots/pricing', { botId: sb.j.id, perUse: 10, passDays: 10, passPrice: 40 }); await U.A('/api/bots/publish', { botId: sb.j.id }); await Ad(`/api/admin/bots/${sb.j.id}/approve`, {});
  await U.B(`/api/rooms/${room.B}/invite`, { botId: sb.j.id }); await U.B(`/api/rooms/${room.B}/messages`, { text: '점검', to: sb.j.id }); await sl(120);
  c = await ok('봇 이용 몫');
  chk('몫 10 → 만든 기업 9 (운영 기관 지갑에 몫 1 + 사용료 1)', (await W('A')) === 99 + 9 && c.treasury.exchangeable === 1);
  await U.E('/api/bots/pass', { botId: sb.j.id });
  OFF += 5 * 864e5; await Ad('/api/admin/login', { password: 'adminpass' }); for (const k in U) await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' });
  await Ad(`/api/admin/bots/${sb.j.id}/discard`, { reason: '시험' });
  c = await ok('이용권 산 뒤 폐기 환불');
  chk('이용권 40 → 반 남음 → 20 환불 (받은 기업 18 + 운영 기관 2)', (await W('E')) === 70 - 40 + 20 && c.txs.some(t => t.kind === 'pass_refund'));

  // 전문가 상담비 + 정산
  const ex = (await Ad('/api/admin/experts', { name: '김세무', field: '세무사' })).j;
  push({ update_id: 1, message: { chat: { id: 77, type: 'private' }, from: { first_name: '김' }, text: '/expert ' + ex.regCode } }); await sl(120);
  push({ update_id: 2, message: { chat: { id: 77, type: 'private' }, from: { first_name: '김' }, text: '/rate 10' } }); await sl(120);
  await U.B(`/api/rooms/${room.B}/call`, { expertId: ex.id, text: '질문' }); await sl(50); await U.B(`/api/rooms/${room.B}/end`, { expertId: ex.id });
  const pm = (await msgs('B')).filter(m => m.pay).pop();
  await U.B(`/api/rooms/${room.B}/pay`, { msgId: pm.id, amount: 20 });
  c = await ok('전문가 상담비');
  chk('전문가 지갑 18, 운영 기관 몫 2', (await Ad('/api/admin/state')).j.experts.find(e => e.id === ex.id).balance === 18 && c.txs.some(t => t.kind === 'expert_pay' && t.orgName === '전문가 김세무'));
  await Ad('/api/admin/payout', { expertId: ex.id, amount: 18 });
  c = await ok('전문가 정산');
  chk('전문가 정산은 소각(expert_payout)', c.txs.some(t => t.type === 'burn' && t.kind === 'expert_payout' && t.amount === 18));

  // 기업 삭제 → 남은 토큰 소각
  chk('잔액이 남은 기업은 삭제 전에 차감 필요', (await Ad(`/api/admin/orgs/${oid.C}/delete`, {})).s === 400);
  await Ad(`/api/admin/orgs/${oid.C}/unlimited-off`, {});
  await Ad(`/api/admin/orgs/${oid.C}/deduct`, { amount: (await Ad('/api/admin/state')).j.orgs.find(o => o.id === oid.C).wallet });
  await Ad(`/api/admin/orgs/${oid.C}/delete`, {});
  c = await ok('차감 후 기업 삭제');
  chk('기업이 없어져도 장부가 맞음', !(await Ad('/api/admin/state')).j.orgs.some(o => o.id === oid.C));

  // 운영 기관 지갑 환전 (충전 페이지 운영자 화면)
  const K = (await Ad('/api/admin/chain/clients', { name: '충전 페이지' })).j;
  const KN = (await Ad('/api/admin/chain/clients', { name: '권한 없는 키', scopes: ['read', 'session', 'mint', 'burn'] })).j;
  const CH = require(path.join(__dirname, '..', 'chain.js'));
  const tre = (await chain()).treasury;
  const raw = JSON.stringify({ type: 'burn', address: tre.address, amount: 1, idempotencyKey: 'x1' });
  const noTre = await new Promise(r => { const q = http.request('http://localhost:3973/chain/v1/tx', { method: 'POST', headers: CH.signedHeaders(KN.keyId, KN.secret, 'POST', '/chain/v1/tx', raw) }, res => { let s = ''; res.on('data', x => s += x); res.on('end', () => r(res.statusCode)); }); q.write(raw); q.end(); });
  chk('treasury 권한 없는 키로는 운영 기관 지갑 못 건드림', noTre === 403);
  // 블록에는 충전·환전만: 지금까지 함께봇 안의 이동은 블록이 없음
  c = await chain();
  chk('함께봇 안의 이동은 내부 장부에만 (블록 0)', c.blockNumber === 0 && c.supply.chain.reserve === 0 && c.txs.every(t => t.layer === 'internal'));
  const sgn = async (key, body) => { const r = JSON.stringify(body); return new Promise(res => { const q = http.request('http://localhost:3973/chain/v1/tx', { method: 'POST', headers: CH.signedHeaders(key.keyId, key.secret, 'POST', '/chain/v1/tx', r) }, rs => { let s = ''; rs.on('data', x => s += x); rs.on('end', () => res({ s: rs.statusCode, j: JSON.parse(s) })); }); q.write(r); q.end(); }); };
  const no = await sgn(K, { type: 'burn', address: tre.address, amount: 1, idempotencyKey: 'pre1' });
  chk('체인 준비금이 0이면 환전 못 함 (함께봇 안에서만 생긴 토큰이 밖으로 새지 않게)', no.s === 400 && no.j.error.includes('체인 준비금'));
  const bAddr = (await U.B('/api/state')).j.address;
  await sgn(K, { type: 'mint', address: bAddr, amount: 50, ref: 'ord_t', idempotencyKey: 'ord_t' }); await sl(250);
  c = await chain();
  chk('충전 페이지 충전만 블록에 담김 → 준비금 50', c.blockNumber === 1 && c.supply.chain.reserve === 50 && c.txs.filter(t => t.layer === 'chain').length === 1);
  Object.assign(process.env, { HB_API: 'http://localhost:3973', HB_KEY: K.keyId, HB_SECRET: K.secret, PORTAL_PORT: '3972', PORTAL_ADMIN_PASSWORD: 'portalpw', PORTAL_DATA: PDATA });
  require(path.join(__dirname, '..', 'portal', 'server.js')); await sl(200);
  const OP = mk(3972); await OP('/admin', { password: 'portalpw' }, true);
  let adm = (await OP('/admin')).j;
  chk('운영자 화면: 운영 기관 지갑·환전 가능·발행량 일치', adm.includes('운영 기관 지갑') && adm.includes('일치') && adm.includes(`(최대 ${tre.exchangeable})`));
  chk('운영 기관 몫보다 많이는 환전 못 함', (await OP('/admin/treasury', { csrf: adm.match(/name="csrf" value="([a-f0-9]+)"/)[1], tokens: tre.exchangeable + 1, bank: '농협', holder: '운영 기관', account: '301-0000-1111' }, true)).h.location.includes(encodeURIComponent('환전하지 못했어요')));
  const before = (await chain()).treasury;
  await OP('/admin/treasury', { csrf: adm.match(/name="csrf" value="([a-f0-9]+)"/)[1], tokens: before.exchangeable, bank: '농협', holder: '운영 기관', account: '301-0000-1111' }, true);
  c = await ok('운영 기관 몫 환전');
  chk('운영 기관 몫 환전 → 소각, 지갑·환전 가능 줄어듦', c.treasury.wallet === before.wallet - before.exchangeable && c.treasury.exchangeable === 0);
  adm = (await OP('/admin')).j;
  chk('운영자 송금 목록에 운영 기관 환전', adm.includes('운영 기관 · 운영자') && adm.includes('301-0000-1111'));
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

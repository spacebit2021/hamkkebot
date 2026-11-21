// 토큰 API(블록체인형): 서명·재전송·중복 충전 막기·권한·한도, 블록 확정, 환전은 번 토큰만, 원격 충전·환전 페이지 끝까지
const path = require('path'), os = require('os'), fs = require('fs');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
const PDATA = path.join(os.tmpdir(), 'hb-portal-' + process.pid + '.json');
for (const f of [process.env.DATA_FILE, PDATA]) try { fs.unlinkSync(f); } catch (e) {}
process.on('exit', () => { for (const f of [process.env.DATA_FILE, PDATA]) try { fs.unlinkSync(f); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const realFetch = global.fetch;
global.fetch = async (url, opt) => String(url).includes('/v1/messages') ? { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] }) } : realFetch(url, opt);
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3977', TELEGRAM_BOT_TOKEN: '', CHARGE_PORTAL_URL: 'http://localhost:3976', CHAIN_BLOCK_MS: '120' });
require(path.join(__dirname, '..', 'server.js'));
const CHAIN = require(path.join(__dirname, '..', 'chain.js'));
const http = require('http');
function mk(port = 3977) { let ck = ''; return (p, b, form) => new Promise(r => { const raw = b == null ? '' : form ? new URLSearchParams(b).toString() : JSON.stringify(b); const q = http.request(`http://localhost:${port}` + p, { method: b == null ? 'GET' : 'POST', headers: { ...(ck ? { cookie: ck } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => { const sc = res.headers['set-cookie']; if (sc && !/Max-Age=0/.test(sc[0])) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, h: res.headers }); }); }); if (raw) q.write(raw); q.end(); }); }
// 서명한 토큰 API 요청 (원격 충전 페이지 서버가 하는 것과 같음)
function api(key, method, p, body, tweak = {}) { const raw = body ? JSON.stringify(body) : ''; const h = { ...CHAIN.signedHeaders(key.keyId, key.secret, method, p, raw), ...tweak }; return new Promise(r => { const q = http.request('http://localhost:3977' + p, { method, headers: h }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r({ s: res.statusCode, j: JSON.parse(d || '{}'), h })); }); if (raw) q.write(raw); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' }); await Ad('/api/admin/fee', { pct: 0 });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 50 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const st = async k => (await U[k]('/api/state')).j;

  const K = (await Ad('/api/admin/chain/clients', { name: '충전 페이지', mintLimit: 1000 })).j;
  const R = (await Ad('/api/admin/chain/clients', { name: '읽기 전용', scopes: ['read'] })).j;
  chk('API 키 발급 (비밀 키는 발급 때만)', /^hbk_/.test(K.keyId) && K.secret.length === 64 && !JSON.stringify((await Ad('/api/admin/state')).j.chain.clients).includes(K.secret));
  // 인증
  chk('서명 없으면 거절', (await mk()('/chain/v1/info')).s === 401);
  chk('서명이 틀리면 거절', (await api({ keyId: K.keyId, secret: 'x'.repeat(64) }, 'GET', '/chain/v1/info')).s === 401);
  chk('5분 넘은 요청 거절', (await api(K, 'GET', '/chain/v1/info', null, { 'x-hb-timestamp': String(Date.now() - 6 * 6e4) })).s === 401);
  const ok1 = await api(K, 'GET', '/chain/v1/info');
  chk('정상 서명 → 체인 정보', ok1.s === 200 && ok1.j.token.symbol === 'HBT' && ok1.j.adapter === 'internal');
  const replay = await new Promise(r => { const q = http.request('http://localhost:3977/chain/v1/info', { headers: ok1.h }, res => { res.resume(); r(res.statusCode); }); q.end(); });
  chk('같은 요청을 다시 보내면(재전송) 거절', replay === 401);
  // 웹앱 → 충전 페이지 넘기기
  const ho = (await U.A('/api/chain/handoff', {})).j;
  chk('「충전·환전」 → 충전 페이지 주소 + 일회용 코드', ho.url.startsWith('http://localhost:3976/?code='));
  const code = ho.url.split('code=')[1];
  chk('읽기 전용 키로는 코드 확인 못 함', (await api(R, 'POST', '/chain/v1/sessions', { code })).s === 403);
  const se = await api(K, 'POST', '/chain/v1/sessions', { code });
  const addr = se.j.address;
  chk('코드 → 지갑 주소·잔액', se.s === 200 && /^hb1[0-9a-f]{38}$/.test(addr) && se.j.name === '마을빵공방' && se.j.balance === 50 && addr === (await st('A')).address);
  chk('코드는 한 번만', (await api(K, 'POST', '/chain/v1/sessions', { code })).s === 400);
  // 충전(mint)
  chk('idempotencyKey 없으면 거절', (await api(K, 'POST', '/chain/v1/tx', { type: 'mint', address: addr, amount: 10 })).s === 400);
  chk('읽기 전용 키로는 충전 못 함', (await api(R, 'POST', '/chain/v1/tx', { type: 'mint', address: addr, amount: 10, idempotencyKey: 'x1' })).s === 403);
  const m1 = await api(K, 'POST', '/chain/v1/tx', { type: 'mint', address: addr, amount: 100, ref: 'ord_1', idempotencyKey: 'ord_1' });
  chk('충전 → 거래 해시, 대기 상태', m1.s === 202 && /^0x[0-9a-f]{64}$/.test(m1.j.hash) && m1.j.status === 'pending' && (await st('A')).wallet === 50);
  await sl(300);
  const t1 = (await api(K, 'GET', '/chain/v1/tx/' + m1.j.hash)).j;
  chk('블록에 담기면 확정 → 잔액 반영', t1.status === 'confirmed' && t1.blockNumber >= 1 && t1.confirmations >= 1 && (await st('A')).wallet === 150);
  chk('기업방에 충전 확정 알림', (await st('A')).rooms[0].msgs.some(m => m.text.includes('토큰 100개 충전이 확정됐어요')));
  const again = await api(K, 'POST', '/chain/v1/tx', { type: 'mint', address: addr, amount: 100, ref: 'ord_1', idempotencyKey: 'ord_1' });
  await sl(300);
  chk('같은 idempotencyKey로 다시 보내도 한 번만 충전', again.s === 200 && again.j.hash === m1.j.hash && (await st('A')).wallet === 150);
  chk('하루 충전 한도 (1000) 넘으면 거절', (await api(K, 'POST', '/chain/v1/tx', { type: 'mint', address: addr, amount: 950, idempotencyKey: 'ord_big' })).j.error.includes('한도'));
  chk('없는 주소 거절', (await api(K, 'POST', '/chain/v1/tx', { type: 'mint', address: 'hb1' + '0'.repeat(38), amount: 1, idempotencyKey: 'z' })).s === 400);
  // 환전(burn): 번 토큰만
  chk('충전한 토큰은 환전 못 함', (await api(K, 'POST', '/chain/v1/tx', { type: 'burn', address: addr, amount: 10, idempotencyKey: 'pay_0' })).j.error.includes('다른 기업에게서 번 토큰만'));
  const d = { hamkkebot: 1, name: '세무 봇', short: '세', color: '#2D6A4F', tag: '세무', desc: '세무 설명', hello: '안녕', quick: [], kind: 'chat', role: '당신은 사회적기업 세무 도우미입니다. 서류를 확인하고 모르는 것은 확인하라고 하세요.' };
  const sb = await U.A('/api/bots/submit', { def: d, roomId: room.A }); const card = (await st('A')).rooms[0].msgs.filter(m => m.botReq).pop(); await U.A('/api/bots/review', { botId: sb.j.id, msgId: card.id, approve: true });
  await U.A('/api/bots/pricing', { botId: sb.j.id, perUse: 20 }); await U.A('/api/bots/publish', { botId: sb.j.id }); await Ad(`/api/admin/bots/${sb.j.id}/approve`, {});
  await U.B(`/api/rooms/${room.B}/invite`, { botId: sb.j.id }); await U.B(`/api/rooms/${room.B}/messages`, { text: '점검', to: sb.j.id }); await sl(150);
  chk('다른 기업에게서 번 20토큰 → 환전 가능 20', (await st('A')).exchangeable === 20 && (await api(K, 'GET', '/chain/v1/accounts/' + addr)).j.exchangeable === 20);
  chk('환전 가능보다 많이는 못 함', (await api(K, 'POST', '/chain/v1/tx', { type: 'burn', address: addr, amount: 21, idempotencyKey: 'pay_1' })).s === 400);
  const w0 = (await st('A')).wallet;
  const b1 = await api(K, 'POST', '/chain/v1/tx', { type: 'burn', address: addr, amount: 15, ref: 'pay_1', idempotencyKey: 'pay_1' });
  chk('환전 신청 → 토큰 바로 잡힘', b1.s === 202 && (await st('A')).wallet === w0 - 15 && (await st('A')).exchangeable === 5);
  await sl(300);
  chk('환전 거래 확정', (await api(K, 'GET', '/chain/v1/tx/' + b1.j.hash)).j.status === 'confirmed');
  chk('주소별 거래 목록', (await api(K, 'GET', `/chain/v1/accounts/${addr}/txs`)).j.txs.length === 2);
  // 쓸 땐 번 토큰이 아닌 것부터: 지갑이 번 토큰보다 적어지면 환전 가능도 줄어듦
  const oA = (await Ad('/api/admin/state')).j.orgs.find(o => o.name === '마을빵공방').id;
  await Ad(`/api/admin/orgs/${oA}/deduct`, { amount: (await st('A')).wallet - 3 });
  chk('지갑이 3이 되면 환전 가능도 3', (await st('A')).exchangeable === 3);
  await Ad(`/api/admin/orgs/${oA}/charge`, { amount: 100 });
  chk('관리자가 준 토큰은 환전 가능에 안 더해짐', (await st('A')).exchangeable === 3);
  // 폐기한 키
  await Ad(`/api/admin/chain/clients/${R.id}/revoke`, {});
  chk('폐기한 키는 거절', (await api(R, 'GET', '/chain/v1/info')).s === 401);

  // ----- 원격 충전·환전 페이지 (다른 서버) -----
  Object.assign(process.env, { HB_API: 'http://localhost:3977', HB_KEY: K.keyId, HB_SECRET: K.secret, PORTAL_PORT: '3976', PORTAL_ADMIN_PASSWORD: 'portalpw', PORTAL_DATA: PDATA, TOKEN_PRICE_KRW: '1000' });
  require(path.join(__dirname, '..', 'portal', 'server.js'));
  await sl(200);
  const P = mk(3976), csrfOf = h => (h.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
  chk('코드 없이 들어오면 함께봇으로 안내', (await P('/')).j.includes('「충전·환전」 버튼으로 들어와'));
  const c2 = (await U.B('/api/chain/handoff', {})).j.url.split('code=')[1];
  const enter = await P('/?code=' + c2);
  chk('코드로 들어오면 세션 만들고 이동', enter.s === 303 && enter.h.location === '/home');
  let home = (await P('/home')).j;
  chk('충전 페이지: 기업 이름·잔액·환전 가능', home.includes('꽃가게 충전·환전') && /토큰 잔액<\/div><div class="big">\d+/.test(home) && home.includes('1토큰 = 1,000원 (임시 값'));
  chk('잘못된 csrf는 무시', (await P('/charge', { csrf: 'bad', tokens: 5, method: 'test' }, true)).s === 303 && !(await P('/home')).j.includes('5토큰 · 5,000원'));
  const wB = (await st('B')).wallet;
  const ch = await P('/charge', { csrf: csrfOf(home), tokens: 30, method: 'test' }, true);
  chk('테스트 결제 충전 → 거래 화면으로', ch.s === 303 && /^\/tx\/0x[0-9a-f]{64}$/.test(ch.h.location));
  await sl(350);
  const txp = (await P(ch.h.location)).j;
  chk('거래 화면: 확정·블록 번호', txp.includes('확정') && txp.includes('블록'));
  chk('함께봇 지갑에 충전 반영', (await st('B')).wallet === wB + 30);
  // 환전 (B는 번 토큰이 없음 → 막힘)
  home = (await P('/home')).j;
  const ex0 = await P('/exchange', { csrf: csrfOf(home), tokens: 5, bank: '국민', holder: '꽃가게', account: '123-456-789012' }, true);
  chk('번 토큰이 없으면 환전 신청 막힘 (안내)', ex0.s === 200 && ex0.j.includes('다른 기업에게서 번 토큰만'));
  // A로 들어가 환전 → 운영자 반려 → 토큰 돌려받음 → 다시 신청 → 송금 완료
  const PA = mk(3976); await PA('/?code=' + (await U.A('/api/chain/handoff', {})).j.url.split('code=')[1]);
  let ha = (await PA('/home')).j;
  const wa = (await st('A')).wallet;
  const ex1 = await PA('/exchange', { csrf: csrfOf(ha), tokens: 3, bank: '신한', holder: '마을빵공방', account: '110-222-333444' }, true);
  chk('환전 신청 → 토큰 소각', ex1.s === 303 && (await st('A')).wallet === wa - 3 && (await st('A')).exchangeable === 0);
  ha = (await PA('/home')).j;
  chk('계좌번호는 가려서 보여 줌', ha.includes('*********3444') && !ha.includes('110-222-333444'));
  const OP = mk(3976);
  chk('운영자 비밀번호 틀리면 거절', (await OP('/admin', { password: 'x' }, true)).s === 401);
  await OP('/admin', { password: 'portalpw' }, true);
  let adm = (await OP('/admin')).j;
  chk('운영자: 송금 기다리는 환전 (계좌 전체·원화)', adm.includes('송금 기다리는 환전 1건') && adm.includes('110-222-333444') && adm.includes('3,000원'));
  const pid = adm.match(/name="id" value="(pay_[a-f0-9]+)"/)[1];
  await OP('/admin/payout', { csrf: csrfOf(adm), id: pid, act: 'reject', note: '예금주 확인 필요' }, true);
  await sl(350);
  chk('반려 → 토큰 돌려받고 다시 환전 가능', (await st('A')).wallet === wa && (await st('A')).exchangeable === 3);
  ha = (await PA('/home')).j;
  await PA('/exchange', { csrf: csrfOf(ha), tokens: 3, bank: '신한', holder: '마을빵공방', account: '110-222-333444' }, true);
  adm = (await OP('/admin')).j;
  const pid2 = adm.match(/name="id" value="(pay_[a-f0-9]+)"/)[1];
  await OP('/admin/payout', { csrf: csrfOf(adm), id: pid2, act: 'paid' }, true);
  ha = (await PA('/home')).j;
  chk('송금 완료 표시', ha.includes('송금 완료') && ha.includes('반려'));
  chk('다른 기업 거래는 못 봄', (await P('/tx/' + ex1.h.location.slice(4))).s === 403);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

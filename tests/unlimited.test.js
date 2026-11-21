// 관리자 기간제 무제한 토큰: 다 쓰면 다시 채워지고, 기업 쪽에는 드러나지 않음 (가짜 Claude·텔레그램)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sent = [], queue = []; let waiter = null, mid = 100;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) return ok({ content: [{ type: 'text', text: '마케팅 초안' }], stop_reason: 'end_turn' });
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; sent.push({ to: JSON.parse(opt.body).chat_id, text: JSON.parse(opt.body).text }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = u => { queue.push(u); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const M = (id, text) => ({ update_id: uid++, message: { message_id: 100 + uid, chat: { id, type: 'private' }, from: { id }, text } });
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3985', TELEGRAM_BOT_TOKEN: 'x' });
const srv = require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3985' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, raw: d }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
const day = n => new Date(Date.now() + n * 864e5 + 9 * 36e5).toISOString().slice(0, 10);
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  const o = (await A('/api/admin/state')).j.orgs[0].id;
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'mkt' });
  await A('/api/admin/costs', { costs: { mkt: 4 } });

  chk('지난 날짜 거절', (await A(`/api/admin/orgs/${o}/unlimited`, { until: day(-1), refillTo: 10 })).s === 400);
  chk('1년 넘는 기간 거절', (await A(`/api/admin/orgs/${o}/unlimited`, { until: day(400), refillTo: 10 })).s === 400);
  chk('잘못된 수량 거절', (await A(`/api/admin/orgs/${o}/unlimited`, { until: day(7), refillTo: 0 })).s === 400);
  const g = await A(`/api/admin/orgs/${o}/unlimited`, { until: day(7), refillTo: 10, memo: '시범 운영' });
  chk('무제한 적용 → 잔액 0에서 바로 10으로', g.j.ok && g.j.wallet === 10);

  // 기업 쪽에 드러나는 것이 없는지
  const raw = (await U('/api/state')).raw;
  chk('기업 화면 데이터에 무제한 흔적 없음', !/unlimited|refill|무제한|until/i.test(raw) && JSON.parse(raw).wallet === 10);

  const ask = async () => { await U(`/api/rooms/${r}/messages`, { text: '인스타 글', to: 'mkt' }); await sl(120); return (await U('/api/state')).j; };
  let st = await ask(); chk('4토큰 사용 → 6', st.wallet === 6);
  st = await ask(); chk('4토큰 사용 → 2', st.wallet === 2);
  st = await ask(); chk('모자라면(2<4) 채워서 처리 → 10-4 = 6', st.wallet === 6 && !st.rooms[0].msgs.some(m => m.text.includes('부족')));
  await A('/api/admin/costs', { costs: { mkt: 6 } });
  st = await ask(); chk('딱 다 쓰면(6-6=0) 다시 10으로 채움', st.wallet === 10);
  await A('/api/admin/costs', { costs: { mkt: 25 } });
  st = await ask(); chk('채울 수량보다 큰 요청(25)도 처리 → 0이 되면 다시 10', st.wallet === 10);
  chk('기업 채팅방에 잔액 부족 안내 없음', !st.rooms[0].msgs.some(m => m.from === 'sys' && m.text.includes('부족')));

  // 사람 전문가: 단가가 잔액보다 커도 수락 요청 없이 바로 호출, 잔액 소진 경고도 없음
  const e = (await A('/api/admin/experts', { name: '김세무', field: '세무' })).j;
  push(M(71, '/expert ' + e.regCode)); await sl(60); push(M(71, '/rate 30')); await sl(60);
  const c = await U(`/api/rooms/${r}/call`, { expertId: e.id, text: '질문' }); await sl(80);
  st = (await U('/api/state')).j;
  chk('단가 30 > 잔액이어도 바로 호출 (잔액 부족 요청 아님)', !c.j.requested && st.rooms[0].humans.includes(e.id) && !sent.some(x => x.text.includes('잔액 부족')));
  const realNow = Date.now; Date.now = () => realNow() + 125 * 60000; srv.checkBalances(); await sl(60);
  chk('상담 2시간이 지나도 전문가에게 잔액 소진 경고 없음', !sent.some(x => x.text.includes('닿았어요')));
  await U(`/api/rooms/${r}/end`, { expertId: e.id }); Date.now = realNow;
  st = (await U('/api/state')).j; const pm = st.rooms[0].msgs.filter(m => m.pay).pop();
  const paid = await U(`/api/rooms/${r}/pay`, { msgId: pm.id, amount: pm.pay.suggested });
  const after = (await U('/api/state')).j;
  chk(`계산값(${pm.pay.suggested}토큰) 지급 성공, 잔액은 0보다 큼, 부족 안내 없음`, paid.s === 200 && after.wallet > 0 && !after.rooms[0].msgs.some(m => m.from === 'sys' && m.text.includes('부족')));

  // 관리자에게는 보임
  const ad = (await A('/api/admin/state')).j, ou = ad.orgs[0].unlimited;
  const refills = ad.ledger.filter(l => l.type === 'refill');
  chk('관리자: 사용 중·자동 충전 횟수·합계·메모', ou.active && ou.refills === refills.length && ou.total === refills.reduce((a, l) => a + l.amount, 0) && ou.memo === '시범 운영' && refills.length >= 5);

  // 끝나면 평소처럼
  await A(`/api/admin/orgs/${o}/unlimited-off`, {});
  await A('/api/admin/costs', { costs: { mkt: 4 } });
  const setWallet = async v => { const w = (await U('/api/state')).j.wallet; if (w > v) await A(`/api/admin/orgs/${o}/deduct`, { amount: w - v }); if (w < v) await A(`/api/admin/orgs/${o}/charge`, { amount: v - w }); };
  await setWallet(10);
  st = await ask(); st = await ask(); st = await ask();
  chk('끝낸 뒤: 10→6→2, 그다음은 잔액 부족으로 막힘 (자동 충전 없음)', st.wallet === 2 && st.rooms[0].msgs.some(m => m.from === 'sys' && m.text.includes('잔액(2토큰)이 부족')));
  chk('관리자: 지난 무제한으로 표시', !(await A('/api/admin/state')).j.orgs[0].unlimited.active);
  // 기간이 지나면 자동으로 멈춤
  await A(`/api/admin/orgs/${o}/unlimited`, { until: day(1), refillTo: 10 });
  await setWallet(10);
  Date.now = () => realNow() + 3 * 864e5; st = await ask(); Date.now = realNow;
  chk('끝나는 날이 지나면 자동 충전 멈춤', st.wallet === 6 && (await ask()).wallet === 2);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

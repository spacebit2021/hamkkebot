// 이용권 자동 환불: 폐기·삭제·공개 중단 때 남은 기간만큼 날짜 비율로, 대금을 받은 기업에서 (모자라면 운영 기관) (가짜 시계)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
let OFF = 0; const realNow = Date.now; Date.now = () => realNow() + OFF; const DAY = 864e5;
global.fetch = async (url) => String(url).includes('/v1/messages') ? { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] }) } : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3988', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3988' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
const LINES = ['고객이 보낸 자료에서 날짜와 금액을 뽑아 표로 정리하세요.', '마감이 가까운 일부터 순서대로 알려 주세요.', '서류 이름은 기관에서 쓰는 정식 이름으로 적으세요.', '확인이 필요한 부분은 따로 모아 마지막에 보여 주세요.', '같은 질문이 반복되면 앞의 답을 짧게 다시 요약하세요.', '숫자는 사용자가 준 것만 쓰고 계산 과정을 함께 보여 주세요.', '처음 쓰는 사람도 알 수 있게 용어를 풀어 설명하세요.', '답의 끝에는 다음에 할 일 한 가지를 적으세요.'];
let RI = 0; const role = t => { const i = RI++; return `당신은 ${t} 전용 도우미입니다 (번호 ${i}).\n` + LINES.map((l, k) => `${k + 1}. ${t} 업무 기준 ${i}-${k}: ${LINES[(k + i * 3) % LINES.length]}`).join('\n'); };
const D = (name, r) => ({ hamkkebot: 1, name, short: name[0], color: '#2D6A4F', tag: '점검', desc: name + ' 설명', hello: '안녕하세요', quick: [], kind: 'chat', role: r });
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' }); await Ad('/api/admin/fee', { pct: 0 }); // 이 시험은 분배 흐름만 봄 (운영 기관 몫은 fee.test.js)
  const U = {}, room = {}, oid = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C'], ['카페', 'E'], ['공방', 'F']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) { await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 200 }); oid[{ 마을빵공방: 'A', 꽃가게: 'B', 책방: 'C', 카페: 'E', 공방: 'F' }[o.name]] = o.id; }
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const relog = async () => { await Ad('/api/admin/login', { password: 'adminpass' }); for (const k in U) await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); }; // 시계를 며칠 넘기면 로그인이 끝남
  const W = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const attach = async (k, def) => { const s = await U[k]('/api/bots/submit', { def, roomId: room[k] }); const c = (await msgs(k)).filter(m => m.botReq).pop(); await U[k]('/api/bots/review', { botId: s.j.id, msgId: c.id, approve: true }); return s.j.id; };
  const publish = async (k, id, pr) => { await U[k]('/api/bots/pricing', { botId: id, ...pr }); await U[k]('/api/bots/publish', { botId: id }); await Ad(`/api/admin/bots/${id}/approve`, {}); };

  // 1) 10일 30토큰 이용권 → 4일 쓴 뒤 운영 기관이 폐기 → 남은 6일분 18토큰
  const a1 = await attach('A', D('세무 봇', role('세무')));
  await publish('A', a1, { passDays: 10, passPrice: 30 });
  await U.B('/api/bots/pass', { botId: a1 });
  chk('준비: 이용권 구매 (B −30, A +30)', await W('B') === 170 && await W('A') === 230);
  OFF += 4 * DAY; await relog();
  await Ad(`/api/admin/bots/${a1}/discard`, { reason: '시험' });
  chk('폐기 → 남은 6일분 18토큰 자동 환불', await W('B') === 188 && await W('A') === 212);
  chk('이용 기업에 알림', (await msgs('B')).some(m => m.text.includes('남은 6일분 18토큰을 자동으로 돌려받았어요')));
  chk('대금 받은 기업에도 알림', (await msgs('A')).some(m => m.text.includes('이용권 환불로 꽃가게에 18토큰')));
  const led = (await Ad('/api/admin/state')).j.ledger;
  chk('거래 기록: 환불 받음·돌려줌', led.some(l => l.type === 'pass_refund' && l.amount === 18 && l.reason === '운영 기관이 폐기') && led.some(l => l.type === 'pass_refund_out' && l.amount === 18 && l.toOrgName === '꽃가게'));

  // 2) 두 번 사서 20일 → 5일 뒤 만든 기업이 삭제 → 첫 구매 남은 5일(15) + 두 번째 전부(30)
  const a2 = await attach('A', D('노무 봇', role('노무')));
  await publish('A', a2, { passDays: 10, passPrice: 30 });
  await U.C('/api/bots/pass', { botId: a2 }); await U.C('/api/bots/pass', { botId: a2 });
  const wc = await W('C'), wa = await W('A');
  OFF += 5 * DAY; await relog();
  await U.A('/api/bots/delete', { botId: a2 });
  chk('연장한 이용권: 남은 기간 전부 (15+30=45)', await W('C') === wc + 45 && await W('A') === wa - 45);
  chk('알림에 남은 날 15일', (await msgs('C')).some(m => m.text.includes('남은 15일분 45토큰')));

  // 3) 대금 받은 기업 잔액이 모자라면 운영 기관이 채움
  const f1 = await attach('F', D('디자인 봇', role('디자인')));
  await publish('F', f1, { passDays: 30, passPrice: 60 });
  await U.E('/api/bots/pass', { botId: f1 });
  await Ad(`/api/admin/orgs/${oid.F}/deduct`, { amount: (await W('F')) - 5 });
  const we = await W('E');
  await Ad(`/api/admin/bots/${f1}/unpublish`, {});
  chk('운영 기관 공개 중단 → 전액 60 환불: 만든 기업 5 + 운영 기관 55', await W('E') === we + 60 && await W('F') === 0);
  chk('운영 기관 부담분 기록', (await Ad('/api/admin/state')).j.ledger.some(l => l.type === 'pass_refund_platform' && l.amount === 55));
  chk('만든 기업 알림에 운영 기관 부담 안내', (await msgs('F')).some(m => m.text.includes('55토큰은 운영 기관이 채웠어요')));
  // 다시 공개하면 새로 사야 함 (환불한 이용권은 없어짐)
  await U.F('/api/bots/publish', { botId: f1 }); await Ad(`/api/admin/bots/${f1}/approve`, {});
  chk('환불 뒤 다시 공개되면 이용권 없음', !(await U.E('/api/state')).j.bots.find(b => b.id === f1).passUntil);

  // 4) 복사본 이용권: 대금이 원작 기업으로 갔으므로 환불도 원작 기업에서
  const R = role('정산'); const orig = await attach('A', D('정산 봇', R));
  const copy = await attach('B', D('정산 비서', R + ' 추가 문장.'));
  chk('준비: 복사로 연결', (await U.B('/api/bots/mine')).j.bots.find(b => b.id === copy).origin);
  await publish('B', copy, { perUse: 1, passDays: 10, passPrice: 20 });
  await U.E('/api/bots/pass', { botId: copy });
  const we2 = await W('E'), wa2 = await W('A'), wb2 = await W('B');
  OFF += 5 * DAY; await relog();
  await Ad(`/api/admin/bots/${copy}/discard`, { reason: '복사' });
  chk('복사본 폐기 → 대금 받은 원작 기업에서 10 환불, 복사한 기업은 그대로', await W('E') === we2 + 10 && await W('A') === wa2 - 10 && await W('B') === wb2);

  // 5) 끝난 이용권은 환불 없음, 만든 기업 공개 중단도 환불
  const a5 = await attach('A', D('홍보 봇', role('홍보')));
  await publish('A', a5, { passDays: 1, passPrice: 5 });
  await U.C('/api/bots/pass', { botId: a5 });
  OFF += 2 * DAY; await relog();
  const wc5 = await W('C');
  await U.A('/api/bots/unpublish', { botId: a5 });
  chk('이미 끝난 이용권은 환불 없음', await W('C') === wc5);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// 봇 마켓: URL/붙여넣기 등록·내부망 차단·기업방 승인·업데이트·관리자 공개 심사·요청당/이용권 토큰 분배·실패 환불 (가짜 Claude·웹)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const DEF = (v = 1, kind = 'chat') => ({ hamkkebot: 1, name: '세무 체크 봇', short: '세', color: '#2D6A4F', tag: '인건비 정산 점검', desc: '인건비 지원금 정산 서류를 점검해요', hello: '안녕하세요!', quick: ['정산 서류 점검'], kind, role: `당신은 사회적기업 인건비 정산 점검 도우미입니다 (버전 ${v}). 서류 목록을 확인해 주세요.` });
const PAGES = {
  'http://93.184.216.34/mybot': { status: 200, body: `<html><body><h1>봇</h1><script type="application/json" id="hamkkebot-bot">${JSON.stringify(DEF(1))}</script></body></html>` },
  'http://93.184.216.34/v2': { status: 200, body: JSON.stringify(DEF(2)) },
  'http://93.184.216.34/redir': { status: 302, location: 'http://127.0.0.1/admin' },
  'http://93.184.216.34/private': { status: 403, body: 'login' },
  'http://93.184.216.34/nodef': { status: 200, body: '<p>그냥 페이지</p>' }
};
let fail = false; const prompts = [];
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  if (PAGES[u]) { const pg = PAGES[u]; return { ok: pg.status < 300, status: pg.status, headers: { get: k => k === 'location' ? pg.location : null }, text: async () => pg.body || '' }; }
  if (u.includes('/v1/messages')) { const b = JSON.parse(opt.body); prompts.push(b); if (fail) return { ok: false, status: 500, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '점검 결과입니다' }] }) }; }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3982', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3982' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const Ad = mk(), A = mk(), B = mk(), C = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  await Ad('/api/admin/login', { password: 'adminpass' }); await Ad('/api/admin/fee', { pct: 0 }); // 이 시험은 분배 흐름만 봄 (운영 기관 몫은 fee.test.js)
  for (const [n, id] of [['마을빵공방', 'bread'], ['꽃가게', 'flower'], ['책방', 'books']]) await Ad('/api/admin/orgs', { name: n, loginId: id, password: 'password1' });
  const orgs = (await Ad('/api/admin/state')).j.orgs, oid = n => orgs.find(o => o.name === n).id;
  for (const n of ['마을빵공방', '꽃가게', '책방']) await Ad(`/api/admin/orgs/${oid(n)}/charge`, { amount: 50 });
  await A('/api/login', { loginId: 'bread', password: 'password1' }); await B('/api/login', { loginId: 'flower', password: 'password1' }); await C('/api/login', { loginId: 'books', password: 'password1' });
  const rA = (await A('/api/state')).j.rooms[0].id, rB = (await B('/api/state')).j.rooms[0].id, rC = (await C('/api/state')).j.rooms[0].id;

  // 가져오기
  chk('내부망 주소 차단', (await A('/api/bots/fetch', { url: 'http://127.0.0.1/admin' })).j.error.includes('읽을 수 없어요'));
  chk('클라우드 메타데이터 주소 차단', (await A('/api/bots/fetch', { url: 'http://169.254.169.254/latest/meta-data/' })).j.error.includes('내부망'));
  chk('리다이렉트로 내부망 가는 것도 차단', (await A('/api/bots/fetch', { url: 'http://93.184.216.34/redir' })).j.error.includes('내부망'));
  chk('로그인 필요한 링크 → 붙여넣기 안내', (await A('/api/bots/fetch', { url: 'http://93.184.216.34/private' })).j.error.includes('붙여넣어'));
  chk('정의 없는 페이지', (await A('/api/bots/fetch', { url: 'http://93.184.216.34/nodef' })).j.error.includes('찾지 못했어요'));
  const f = await A('/api/bots/fetch', { url: 'http://93.184.216.34/mybot' });
  chk('아티팩트 HTML에서 정의 읽기', f.s === 200 && f.j.def.name === '세무 체크 봇' && f.j.sourceUrl === 'http://93.184.216.34/mybot');
  chk('붙여넣기 정의 확인', (await A('/api/bots/parse', { text: '```json\n' + JSON.stringify(DEF(1)) + '\n```' })).j.def.name === '세무 체크 봇');
  chk('잘못된 정의 거절', (await A('/api/bots/parse', { text: JSON.stringify({ hamkkebot: 1, name: 'x', role: '짧음' }) })).s === 400);

  // 기업방 승인
  const sub = await A('/api/bots/submit', { def: f.j.def, sourceUrl: f.j.sourceUrl, roomId: rA });
  const bid = sub.j.id;
  let st = (await A('/api/state')).j;
  const card = st.rooms[0].msgs.find(m => m.botReq);
  chk('올리면 기업방에 승인 카드, 아직 목록에 없음', card && card.botReq.def.name === '세무 체크 봇' && !st.bots.some(b => b.id === bid));
  chk('다른 기업은 승인 못 함', (await B('/api/bots/review', { botId: bid, msgId: card.id, approve: true })).s === 404);
  await A('/api/bots/review', { botId: bid, msgId: card.id, approve: true });
  st = (await A('/api/state')).j;
  chk('승인 → 우리 기업 봇 목록에', st.bots.some(b => b.id === bid && b.mine));
  chk('다른 기업에는 아직 안 보임', !(await B('/api/state')).j.bots.some(b => b.id === bid) && (await B(`/api/rooms/${rB}/invite`, { botId: bid })).s === 400);
  await A(`/api/rooms/${rA}/invite`, { botId: bid });
  await A(`/api/rooms/${rA}/messages`, { text: '정산 서류 점검', to: bid }); await sl(150);
  chk('우리 기업이 쓰면 기본 1토큰, 역할 지시문 + 공통 규칙으로 실행', (await A('/api/state')).j.wallet === 49 && prompts[0].system.includes('인건비 정산 점검 도우미') && prompts[0].system.includes('[함께봇 공통 규칙]'));

  // 공개 요청 → 관리자 승인
  chk('가격 없이 공개 요청하면 안내', (await A('/api/bots/publish', { botId: bid })).s === 400);
  chk('잘못된 가격 거절', (await A('/api/bots/pricing', { botId: bid, perUse: -1 })).s === 400 && (await A('/api/bots/pricing', { botId: bid, passDays: 30 })).s === 400);
  await A('/api/bots/pricing', { botId: bid, perUse: 2, passDays: 30, passPrice: 20 });
  await A('/api/bots/publish', { botId: bid });
  chk('심사 중엔 다른 기업에 안 보임, 관리자 심사 목록에 있음', !(await B('/api/state')).j.bots.some(b => b.id === bid) && (await Ad('/api/admin/state')).j.market.some(m => m.id === bid && m.publicStatus === 'pending'));
  await Ad(`/api/admin/bots/${bid}/approve`, {});
  const bb = (await B('/api/state')).j.bots.find(b => b.id === bid);
  chk('관리자 승인 → 다른 기업 목록에 (만든 기업·가격 표시)', bb && !bb.mine && bb.ownerName === '마을빵공방' && bb.pricing.perUse === 2 && bb.cost === 3);

  // 요청당 분배
  await B(`/api/rooms/${rB}/invite`, { botId: bid });
  await B(`/api/rooms/${rB}/messages`, { text: '정산 서류 점검', to: bid }); await sl(150);
  chk('다른 기업 사용: 기본 1 + 만든 기업 몫 2 = 3토큰', (await B('/api/state')).j.wallet === 47);
  chk('만든 기업이 2토큰 받음', (await A('/api/state')).j.wallet === 51);
  let led = (await Ad('/api/admin/state')).j.ledger;
  chk('거래 기록: 보냄·받음', led.some(l => l.type === 'share' && l.amount === 2 && l.toOrgName === '마을빵공방') && led.some(l => l.type === 'share_in' && l.amount === 2 && l.fromOrgName === '꽃가게'));
  // 실패 시 환불
  fail = true; await B(`/api/rooms/${rB}/messages`, { text: '또 점검', to: bid }); await sl(150); fail = false;
  chk('AI 실패 → 이용 기업 환불, 만든 기업 몫 없음', (await B('/api/state')).j.wallet === 47 && (await A('/api/state')).j.wallet === 51);

  // 기간 이용권
  const pass = await B('/api/bots/pass', { botId: bid });
  chk('이용권 구매: 20토큰 → 만든 기업에', pass.s === 200 && (await B('/api/state')).j.wallet === 27 && (await A('/api/state')).j.wallet === 71);
  await B(`/api/rooms/${rB}/messages`, { text: '정산 서류 점검', to: bid }); await sl(150);
  chk('이용권 기간에는 기본 1토큰만', (await B('/api/state')).j.wallet === 26 && (await A('/api/state')).j.wallet === 71);
  chk('만든 기업이 자기 봇 이용권은 못 삼', (await A('/api/bots/pass', { botId: bid })).s === 404);

  // 이용권 전용
  await A('/api/bots/pricing', { botId: bid, perUse: '', passDays: 7, passPrice: 10 });
  await C(`/api/rooms/${rC}/invite`, { botId: bid });
  await C(`/api/rooms/${rC}/messages`, { text: '점검', to: bid }); await sl(150);
  chk('이용권 전용 봇: 이용권 없으면 안내만, 토큰 안 씀', (await C('/api/state')).j.wallet === 50 && (await C('/api/state')).j.rooms[0].msgs.some(m => m.text.includes('기간 이용권으로만')));

  // 업데이트 → 다시 심사
  const f2 = await A('/api/bots/fetch', { url: 'http://93.184.216.34/v2' });
  await A('/api/bots/submit', { def: f2.j.def, sourceUrl: f2.j.sourceUrl, roomId: rA, botId: bid });
  const card2 = (await A('/api/state')).j.rooms[0].msgs.filter(m => m.botReq).pop();
  chk('업데이트 카드', card2.botReq.kind === 'update');
  await A('/api/bots/review', { botId: bid, msgId: card2.id, approve: true });
  const mine = (await A('/api/bots/mine')).j.bots.find(b => b.id === bid);
  chk('업데이트 승인 → 버전 2, 공개 봇은 다시 심사', mine.version === 2 && mine.publicStatus === 'pending' && mine.def.role.includes('버전 2'));
  await B(`/api/rooms/${rB}/messages`, { text: '점검', to: bid }); await sl(150);
  chk('재심사 중 다른 기업은 잠시 못 씀', (await B('/api/state')).j.rooms[0].msgs.some(m => m.text.includes('지금 쓸 수 없는')));
  await Ad(`/api/admin/bots/${bid}/reject`, { reason: '역할 지시문 보완 필요' });
  chk('관리자 거절 → 사유가 만든 기업에', (await A('/api/bots/mine')).j.bots[0].publicReason === '역할 지시문 보완 필요' && (await A('/api/state')).j.rooms[0].msgs.some(m => m.text.includes('보완 필요')));
  chk('우리 기업은 계속 사용 가능', (await A('/api/state')).j.bots.some(b => b.id === bid));

  // 종류: 홈페이지 봇으로 만든 봇은 기본 규칙이 붙음
  const sd = await A('/api/bots/parse', { text: JSON.stringify(DEF(1, 'site')) });
  const s2 = await A('/api/bots/submit', { def: sd.j.def, roomId: rA });
  const c3 = (await A('/api/state')).j.rooms[0].msgs.filter(m => m.botReq).pop();
  await A('/api/bots/review', { botId: s2.j.id, msgId: c3.id, approve: true });
  await A(`/api/rooms/${rA}/invite`, { botId: s2.j.id });
  const wA = (await A('/api/state')).j.wallet;
  await A(`/api/rooms/${rA}/messages`, { text: '랜딩페이지 만들어 줘', to: s2.j.id }); await sl(150);
  chk('홈페이지 종류로 만든 봇: 홈페이지 봇 기본 규칙 + 홈페이지 비용 기준', prompts[prompts.length - 1].system.includes('웹 디자이너 겸 카피라이터') && prompts[prompts.length - 1].system.includes('인건비 정산 점검 도우미'));
  chk('거절한 새 봇은 사라짐', await (async () => { const s3 = await A('/api/bots/submit', { def: f.j.def, roomId: rA }); const c4 = (await A('/api/state')).j.rooms[0].msgs.filter(m => m.botReq).pop(); await A('/api/bots/review', { botId: s3.j.id, msgId: c4.id, approve: false }); return !(await A('/api/bots/mine')).j.bots.some(b => b.id === s3.j.id); })());
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

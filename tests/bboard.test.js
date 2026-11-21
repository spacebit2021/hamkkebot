// 봇 게시판: 봇 정의의 board로 생기는 게시판 (초대한 기업에만), 비공개 항목·버튼 토큰·당사자 동의, 운영 기관 몫 실시간 변경 알림
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
global.fetch = async (url) => String(url).includes('/v1/messages') ? { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] }) } : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3979', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3979' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const page = (u, action) => new Promise(r => { const q = http.request('http://localhost:3979' + u.replace(/^https?:\/\/[^/]*/, ''), { method: action ? 'POST' : 'GET', headers: action ? { 'content-type': 'application/x-www-form-urlencoded' } : {} }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r({ s: res.statusCode, body: d })); }); if (action) q.write('action=' + action); q.end(); });
const sl = ms => new Promise(r => setTimeout(r, ms));
const BOARD = { name: '행사 협업 제안', desc: '함께할 행사를 올려요', visibility: 'shared', fields: [{ key: 'title', label: '행사 이름', type: 'text', required: true }, { key: 'day', label: '날짜', type: 'date' }, { key: 'kind', label: '분야', type: 'select', options: ['먹거리', '공예', '교육'] }, { key: 'detail', label: '내용', type: 'textarea' }, { key: 'person', label: '담당자', type: 'text', private: true }, { key: 'contact', label: '연락처', type: 'text', private: true }], action: { label: '함께하기', price: 10 }, consent: true, consentText: '행사 담당자로 이름과 연락처가 함께할 기업에 전해져요.' };
const DEF = { hamkkebot: 1, name: '행사 협업 봇', short: '행', color: '#B54708', tag: '행사 협업', desc: '사회적기업끼리 행사를 함께 기획해요', hello: '안녕하세요', quick: [], kind: 'chat', role: '당신은 사회적기업들의 공동 행사 기획을 돕는 도우미입니다. 행사 목적과 날짜, 필요한 협력을 정리하세요.', board: BOARD };
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 100 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const W = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs, st = async k => (await U[k]('/api/state')).j;

  // 정의 검사
  chk('잘못된 게시판 정의 거절 (선택지 1개)', (await U.A('/api/bots/parse', { text: JSON.stringify({ ...DEF, board: { ...BOARD, fields: [{ key: 'k', label: '분야', type: 'select', options: ['하나'] }] } }) })).s === 400);
  chk('다른 기업에 보일 항목이 없으면 거절', (await U.A('/api/bots/parse', { text: JSON.stringify({ ...DEF, board: { name: '비밀', fields: [{ key: 'a', label: '연락처', private: true }] } }) })).s === 400);
  const pv = await U.A('/api/bots/parse', { text: JSON.stringify(DEF) });
  chk('게시판 정의 읽힘', pv.j.def.board.name === '행사 협업 제안' && pv.j.def.board.action.price === 10 && pv.j.def.board.consent);
  const s1 = await U.A('/api/bots/submit', { def: pv.j.def, roomId: room.A }); const card = (await msgs('A')).filter(m => m.botReq).pop();
  chk('승인 카드에 게시판 정의 포함', card.botReq.def.board.fields.length === 6);
  await U.A('/api/bots/review', { botId: s1.j.id, msgId: card.id, approve: true });
  const bot = s1.j.id;
  chk('초대 전엔 게시판 탭 없음', !(await st('A')).boardTabs.length);
  await U.A(`/api/rooms/${room.A}/invite`, { botId: bot });
  chk('초대하면 게시판 탭 생김', (await st('A')).boardTabs.some(t => t.botId === bot && t.name === '행사 협업 제안'));
  await U.A('/api/bots/pricing', { botId: bot, perUse: 0 }); await U.A('/api/bots/publish', { botId: bot }); await Ad(`/api/admin/bots/${bot}/approve`, {});
  chk('다른 기업도 봇을 초대하지 않으면 게시판 못 씀', !(await st('B')).boardTabs.length && (await U.B('/api/bboard?bot=' + bot)).s === 404);
  await U.B(`/api/rooms/${room.B}/invite`, { botId: bot });
  chk('다른 기업도 초대하면 같은 게시판', (await st('B')).boardTabs.some(t => t.botId === bot));

  // 글쓰기 검사
  chk('필수 항목 없으면 거절', (await U.A('/api/bboard/post', { botId: bot, values: { detail: '내용' } })).j.error.includes('행사 이름'));
  chk('날짜·선택지 형식 검사', (await U.A('/api/bboard/post', { botId: bot, values: { title: '장터', day: '12월 5일', kind: '음악' } })).j.error.includes('날짜'));
  chk('주민번호 같은 정보 거절', (await U.A('/api/bboard/post', { botId: bot, values: { title: '장터', detail: '900101-1234567' } })).s === 400);
  const p1 = await U.A('/api/bboard/post', { botId: bot, values: { title: '연말 마을 장터', day: '2026-12-20', kind: '먹거리', detail: '빵·꽃·책을 함께 파는 장터' } });
  chk('비공개 항목이 없으면 바로 올라감', p1.j.status === 'open');
  const p2 = await U.A('/api/bboard/post', { botId: bot, values: { title: '어린이 베이킹 교실', kind: '교육', person: '이수진', contact: '010-2222-3333' } });
  chk('개인정보가 있으면 당사자 동의 대기 + 링크', p2.j.status === 'awaiting' && /\/c\/[a-f0-9]{32}$/.test(p2.j.consentUrl));
  let lb = (await U.B('/api/bboard?bot=' + bot)).j.posts;
  chk('동의 전엔 다른 기업에 안 보임', lb.length === 1 && lb[0].id === p1.j.id);
  const cp = await page(p2.j.consentUrl);
  chk('동의 페이지: 게시판·보일 내용·비공개 내용·보상 안내', cp.body.includes('행사 협업 제안') && cp.body.includes('어린이 베이킹 교실') && cp.body.includes('010-2222-3333') && cp.body.includes('토큰 10개') && cp.body.includes('행사 담당자로 이름과 연락처'));
  await page(p2.j.consentUrl, 'agree');
  lb = (await U.B('/api/bboard?bot=' + bot)).j.posts;
  const b2 = lb.find(x => x.id === p2.j.id);
  chk('동의 후 올라감, 다른 기업엔 비공개 항목 없음', b2 && b2.values.title === '어린이 베이킹 교실' && !b2.values.contact && !JSON.stringify(lb).includes('010-2222'));
  chk('쓴 기업에게 동의 알림', (await msgs('A')).some(m => m.text.includes('당사자가 직접 동의해서')));

  // 버튼(함께하기) → 토큰, 비공개 항목 공개
  chk('자기 글엔 버튼 못 누름', (await U.A('/api/bboard/action', { id: p2.j.id })).s === 400);
  const wa = await W('A'), wb = await W('B');
  const ac = await U.B('/api/bboard/action', { id: p2.j.id });
  chk('함께하기 10토큰: 누른 기업 −10, 쓴 기업 +9 (운영 기관 몫 10%)', await W('B') === wb - 10 && await W('A') === wa + 9);
  chk('누른 기업에 비공개 항목 공개 + 알림', ac.j.values.contact === '010-2222-3333' && (await msgs('B')).some(m => m.text.includes('연락처: 010-2222-3333')));
  chk('쓴 기업 알림', (await msgs('A')).some(m => m.text.includes('꽃가게이(가) 「행사 협업 제안」') && m.text.includes('9토큰을 받았어요')));
  chk('두 번 못 누름', (await U.B('/api/bboard/action', { id: p2.j.id })).s === 400);
  chk('봇을 안 쓰는 기업은 글을 못 봄', (await U.C('/api/bboard?bot=' + bot)).s === 404 && (await U.C('/api/bboard/action', { id: p2.j.id })).s === 404);
  const led = (await Ad('/api/admin/state')).j.ledger;
  chk('거래 기록', led.some(l => l.type === 'board_action' && l.amount === 10) && led.some(l => l.type === 'board_action_in' && l.amount === 9 && l.fee === 1));

  // 당사자 철회
  await page(p2.j.consentUrl, 'withdraw');
  chk('당사자가 철회하면 글 지우고, 내용을 받은 기업에 지워 달라고 알림', !(await U.B('/api/bboard?bot=' + bot)).j.posts.some(x => x.id === p2.j.id) && (await msgs('B')).some(m => m.text.includes('동의를 철회했어요') && m.text.includes('지워 주세요')));

  // 우리 기업 안에서만 보는 게시판
  const OWN = { ...DEF, name: '주간 회고 봇', role: '당신은 우리 팀의 주간 회고를 정리하는 도우미입니다. 잘된 점과 고칠 점을 묻고 정리하세요. 사실만 쓰세요.', board: { name: '주간 회고', visibility: 'own', fields: [{ key: 'title', label: '이번 주', required: true }, { key: 'note', label: '메모', type: 'textarea' }] } };
  const s2 = await U.A('/api/bots/submit', { def: (await U.A('/api/bots/parse', { text: JSON.stringify(OWN) })).j.def, roomId: room.A }); const c2 = (await msgs('A')).filter(m => m.botReq).pop(); await U.A('/api/bots/review', { botId: s2.j.id, msgId: c2.id, approve: true });
  await U.A(`/api/rooms/${room.A}/invite`, { botId: s2.j.id });
  await U.A('/api/bboard/post', { botId: s2.j.id, values: { title: '11월 4주', note: '장터 준비가 늦었음' } });
  await U.A('/api/bots/pricing', { botId: s2.j.id, perUse: 0 }); await U.A('/api/bots/publish', { botId: s2.j.id }); await Ad(`/api/admin/bots/${s2.j.id}/approve`, {});
  await U.B(`/api/rooms/${room.B}/invite`, { botId: s2.j.id });
  chk('"우리 기업 안에서만" 게시판: 같은 봇을 써도 다른 기업 글은 안 보임', (await U.B('/api/bboard?bot=' + s2.j.id)).j.posts.length === 0 && (await U.A('/api/bboard?bot=' + s2.j.id)).j.posts.length === 1);
  const adm = (await Ad('/api/admin/state')).j.bposts.find(x => x.botId === s2.j.id);
  chk('운영 기관도 그 내용은 못 봄', adm.internal && !Object.keys(adm.values).length);
  // 관리자 숨김
  await Ad(`/api/admin/bboard/${p1.j.id}/hide`, { hidden: true, reason: '확인 중' });
  chk('관리자가 숨기면 다른 기업 목록에서 빠짐', !(await U.B('/api/bboard?bot=' + bot)).j.posts.some(x => x.id === p1.j.id) && (await msgs('A')).some(m => m.text.includes('숨겼어요: 확인 중')));

  // 운영 기관 몫 바꾸기 → 실시간 적용 + 기업방 알림
  await Ad('/api/admin/fee', { pct: 8 });
  chk('비율 변경이 모든 기업방에 표시', (await msgs('C')).some(m => m.text.includes('운영 기관 몫이 10%에서 8%로 바뀌었어요')) && (await st('B')).feePct === 8);
  chk('관리자 화면에 변경 기록', (await Ad('/api/admin/state')).j.feeHistory[0].to === 8);
  const p3 = await U.A('/api/bboard/post', { botId: bot, values: { title: '봄 장터' } });
  for (let i = 0; i < 1; i++) { const wa2 = await W('A'); await U.B('/api/bboard/action', { id: p3.j.id }); chk('바뀐 비율이 바로 적용: 10토큰 중 8%(0.8)는 모아 두고 이번엔 10 그대로', await W('A') === wa2 + 10); }
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

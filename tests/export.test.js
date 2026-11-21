// 봇 내보내기: 기본 봇·우리 봇을 HTML/JSON으로 내보내고 → 파일 붙여넣기·링크로 다시 붙이면 같은 봇이 되는지 (가짜 Claude·웹)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const ROLE = '당신은 인건비 정산 점검 도우미입니다.\n- 서류 목록을 "따옴표"와 함께 확인하세요 & 빠진 것을 알려 주세요.\n- 이 줄은 </script><script>alert(1)</script> 가 들어가도 깨지면 안 돼요.';
const DEF = { hamkkebot: 1, name: '세무 <체크> 봇', short: '세', color: '#2D6A4F', tag: '인건비 정산 점검', desc: '인건비 지원금 정산 서류를 점검해요', hello: '안녕하세요!', quick: ['정산 서류 점검', '증빙 목록'], kind: 'chat', ppt: true, role: ROLE };
const PAGES = {}; const prompts = [];
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  if (PAGES[u] != null) return { ok: true, status: 200, headers: { get: () => null }, text: async () => PAGES[u] };
  if (u.includes('/v1/messages')) { prompts.push(JSON.parse(opt.body)); return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '점검 결과입니다' }] }) }; }
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3985', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3985' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, h: res.headers }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const Ad = mk(), A = mk(), B = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
const strip = d => JSON.stringify(d);
(async () => {
  await sl(300);
  await Ad('/api/admin/login', { password: 'adminpass' });
  for (const [n, id] of [['마을빵공방', 'bread'], ['꽃가게', 'flower']]) await Ad('/api/admin/orgs', { name: n, loginId: id, password: 'password1' });
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 50 });
  await A('/api/login', { loginId: 'bread', password: 'password1' }); await B('/api/login', { loginId: 'flower', password: 'password1' });
  const rA = (await A('/api/state')).j.rooms[0].id, rB = (await B('/api/state')).j.rooms[0].id;
  const attach = async (U, room, def, botId) => { const s = await U('/api/bots/submit', { def, roomId: room, botId }); const id = s.j.id || botId; const c = (await U('/api/state')).j.rooms.find(r => r.id === room).msgs.filter(m => m.botReq).pop(); await U('/api/bots/review', { botId: id, msgId: c.id, approve: true }); return id; };

  // 마을빵공방이 봇을 만들고 한 번 고침 (버전 2)
  const p1 = await A('/api/bots/parse', { text: JSON.stringify(DEF) });
  const bid = await attach(A, rA, p1.j.def);
  await attach(A, rA, { ...p1.j.def, hello: '안녕하세요! 정산 점검 봇이에요.' }, bid);
  const mine = (await A('/api/bots/mine')).j.bots.find(b => b.id === bid);
  chk('준비: 우리 봇 버전 2', mine.version === 2);

  // 내보내기
  const ex = await A('/api/bots/export?id=' + bid);
  chk('HTML 파일로 내려받기', ex.s === 200 && /text\/html/.test(ex.h['content-type']) && /attachment; filename\*=UTF-8''.+\.hamkkebot\.html/.test(ex.h['content-disposition']));
  chk('정의 스크립트 1개, 역할 지시문의 </script>가 페이지를 깨지 않음', (ex.j.match(/<\/script>/g) || []).length === 1 && ex.j.includes('id="hamkkebot-bot"') && !ex.j.includes('<script>alert'));
  chk('사람이 읽는 부분도 글자로만 (이름의 <체크>)', ex.j.includes('세무 &lt;체크&gt; 봇') && !ex.j.includes('<체크>'));
  chk('내보낸 곳·버전 표시', ex.j.includes('마을빵공방') && ex.j.includes('버전 2'));
  const exj = await A('/api/bots/export?id=' + bid + '&format=json');
  chk('JSON 파일로도 내려받기', exj.s === 200 && exj.j.hamkkebot === 1 && exj.j.role === ROLE && exj.j.exported.from === '마을빵공방');
  chk('다른 기업 봇은 내보낼 수 없음', (await B('/api/bots/export?id=' + bid)).s === 404);
  chk('준비 중 봇·없는 봇은 안 됨', (await A('/api/bots/export?id=fund')).s === 404 && (await A('/api/bots/export?id=nope')).s === 404);

  // 파일 붙여넣기로 다른 기업에 붙이기 (웹앱 「파일로 올리기」와 같은 경로)
  const pB = await B('/api/bots/parse', { text: ex.j });
  chk('내보낸 HTML을 그대로 읽음: 정의가 똑같음', pB.s === 200 && strip(pB.j.def) === strip(mine.def));
  chk('붙일 때 내보낸 곳·버전을 보여 줌', pB.j.meta && pB.j.meta.from === '마을빵공방' && pB.j.meta.version === '2');
  const bB = await attach(B, rB, pB.j.def);
  const sB = (await B('/api/state')).j.bots.find(b => b.id === bB);
  chk('꽃가게 봇 목록에 붙음 (꽃가게 소유, 버전 1)', sB && sB.mine && sB.name === '세무 <체크> 봇');
  await B(`/api/rooms/${rB}/invite`, { botId: bB });
  await B(`/api/rooms/${rB}/messages`, { text: '정산 서류 점검', to: bB }); await sl(150);
  chk('붙인 봇이 같은 역할 지시문으로 답함', prompts.length && prompts[prompts.length - 1].system.startsWith(ROLE) && (await B('/api/state')).j.rooms[0].msgs.some(m => m.from === bB && m.text === '점검 결과입니다'));
  await B(`/api/rooms/${rB}/messages`, { text: '정산 점검 PPT 만들어 줘', to: bB }); await sl(150);
  chk('PPT 기능 설정도 그대로', prompts[prompts.length - 1].system.includes('[PPT 만들기]') || prompts[prompts.length - 1].system.includes('슬라이드'));
  chk('토큰 가격·공개 상태는 따라오지 않음', (await B('/api/bots/mine')).j.bots.find(b => b.id === bB).publicStatus == null);

  // 링크로 붙이기
  PAGES['http://93.184.216.34/bots/tax.hamkkebot.html'] = ex.j;
  const fB = await B('/api/bots/fetch', { url: 'http://93.184.216.34/bots/tax.hamkkebot.html' });
  chk('내보낸 파일을 공개 링크로 올려도 읽힘', fB.s === 200 && strip(fB.j.def) === strip(mine.def));
  chk('JSON 파일도 붙여넣기로 읽힘', strip((await B('/api/bots/parse', { text: JSON.stringify(exj.j) })).j.def) === strip(mine.def));

  // 내보낸 파일로 우리 봇 업데이트 (되돌리기 용도)
  await attach(A, rA, (await A('/api/bots/parse', { text: ex.j })).j.def, bid);
  const m3 = (await A('/api/bots/mine')).j.bots.find(b => b.id === bid);
  chk('내보낸 파일로 업데이트 → 버전 3, 내용 같음', m3.version === 3 && strip(m3.def) === strip(mine.def));

  // 기본 봇 내보내기 → 고쳐서 우리 봇으로
  for (const id of ['mkt', 'site', 'ir', 'sched', 'todo']) {
    const e = await B('/api/bots/export?id=' + id), p = await B('/api/bots/parse', { text: e.j });
    chk(`기본 봇 ${id} 내보내기 → 그대로 읽힘`, e.s === 200 && p.s === 200 && p.j.meta.source === 'builtin');
  }
  const tdef = (await B('/api/bots/parse', { text: (await B('/api/bots/export?id=todo')).j })).j.def;
  chk('기본 봇 종류(할 일)·PPT 설정 유지', tdef.kind === 'todo' && (await B('/api/bots/parse', { text: (await B('/api/bots/export?id=mkt')).j })).j.def.ppt === true);
  const tId = await attach(B, rB, { ...tdef, name: '우리 할 일 봇', role: tdef.role + '\n- 우리 회사는 금요일 오후에 주간 정리를 해요.' });
  await B(`/api/rooms/${rB}/invite`, { botId: tId });
  await B(`/api/rooms/${rB}/messages`, { text: '할 일표 링크 보여 줘', to: tId }); await sl(150);
  const st = (await B('/api/state')).j;
  chk('고친 할 일 봇이 할 일표 기능으로 동작', st.rooms[0].msgs.filter(m => m.from === tId).pop().text.includes('할 일표:') && st.todo);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

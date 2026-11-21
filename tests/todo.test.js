// 할 일 봇: 텔레그램 개인 할 일 → 할 일표 HTML, 편집 링크, 매일 아침 기업방 알림(남은 점검일), 2주 점검 피드백 (가짜 Claude·텔레그램·시계)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const SCHED = require(path.join(__dirname, '..', 'sched.js'));
const T = SCHED.kstDate(), D = n => SCHED.addDays(T, n), at = (d, hm) => String(Date.parse(`${d}T${hm}:00+09:00`));
const wdOf = d => new Date(d + 'T00:00:00Z').getUTCDay();
const calls = [], sent = [], queue = []; let waiter = null, mid = 900;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) {
    const b = JSON.parse(opt.body), sys = b.system, msg = b.messages[0].content; calls.push({ sys, msg });
    const ids = [...sys.matchAll(/- id (g[0-9a-f]+) \| ([^|]+) \|/g)].map(m => ({ id: m[1], title: m[2].trim() }));
    const idOf = w => (ids.find(x => x.title.includes(w)) || {}).id, who = (msg.match(/^\[([^·\]]+?) ·/) || [])[1];
    let out = { ops: [] };
    if (sys.includes('변경 목록을 만드세요')) {
      if (/다 했어요/.test(msg)) out = { ops: [{ op: 'done', id: idOf('구청') }] };
      else if (/구청 보고서/.test(msg)) out = { ops: [{ op: 'add', title: '구청 보고서', start: T, end: D(4), owner: who }] };
      else if (/견적서/.test(msg)) out = { ops: [{ op: 'add', title: '견적서 발송', start: T, end: D(9), owner: who }] };
    } else if (sys.includes('사람별로 짧은 피드백')) out = { summary: '보고서는 끝났고 견적서가 남았어요.', people: [{ owner: '김민지', good: '구청 보고서를 마감 전에 끝냈어요', concern: '', next: '다음 보고서 초안을 미리 잡아 보세요' }, { owner: '박서준', good: '', concern: '견적서 발송이 마감을 넘겼어요', next: '거래처에 발송 날짜를 다시 알려 주세요' }, { owner: '없는사람', good: '지어낸 사람' }] };
    return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] });
  }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; const bb = JSON.parse(opt.body); sent.push({ to: bb.chat_id, text: bb.text }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const G = -901, gm = (from, name, text) => ({ update_id: uid++, message: { message_id: 10 + uid, chat: { id: G, type: 'group', title: '마을빵공방 할 일방' }, from: { id: from, first_name: name }, text } });
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3984', TELEGRAM_BOT_TOKEN: 'x', PUBLIC_URL: 'https://hb.example.org', TODO_TICK_MS: '40', HB_NOW: at(T, '08:00') });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function req(p, b, ck, ct = 'application/json') { return new Promise(r => { const q = http.request('http://localhost:3984' + p, { method: b ? 'POST' : 'GET', headers: { ...(ck && ck.v ? { cookie: ck.v } : {}), ...(b ? { 'content-type': ct } : {}) } }, res => { const sc = res.headers['set-cookie']; if (sc && ck) ck.v = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, h: res.headers }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const mk = () => { const ck = {}; return (p, b) => req(p, b, ck); };
const A = mk(), U = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
const toG = () => sent.filter(s => s.to === G);
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  const o = (await A('/api/admin/state')).j.orgs[0].id; await A(`/api/admin/orgs/${o}/charge`, { amount: 30 });
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'todo' });
  const code = (await U(`/api/rooms/${r}/link`, {})).j.code;
  push(gm(1, '김민지', '/link ' + code)); await sl(150);
  const state = async () => (await U('/api/state')).j;
  let st = await state();
  chk('할 일 봇 초대 → 할 일표·다음 점검 D-14', st.todo && st.todo.left === 14 && st.todo.days === 14 && /^https:\/\/hb\.example\.org\/t\/[a-f0-9]{24}$/.test(st.todo.url) && /\/te\/[a-f0-9]{32}$/.test(st.todo.editUrl));
  const tok = st.todo.url.split('/t/')[1], etok = st.todo.editUrl.split('/te/')[1];

  // 텔레그램 개인 할 일
  push(gm(1, '김민지', '/todo 금요일까지 구청 보고서')); await sl(250);
  let td = (await req('/api/te/' + etok)).j;
  chk('/todo → 보낸 사람(김민지)의 할 일, 1토큰', td.items.length === 1 && td.items[0].owner === '김민지' && td.items[0].end === D(4) && (await state()).wallet === 29);
  chk('AI에 "말한 사람" 규칙 전달', calls[calls.length - 1].sys.includes('말한 사람 "김민지"'));
  chk('텔레그램으로 할 일표 링크 회신', toG().pop().text.includes('할 일표를 고쳤어요') && toG().pop().text.includes('/t/' + tok));
  push(gm(2, '박서준', '다음 주 수요일까지 견적서 보내야 해')); await sl(250);
  td = (await req('/api/te/' + etok)).j;
  chk('명령 없이 쓴 할 일도 반영 (박서준)', td.items.length === 2 && td.items[1].owner === '박서준');
  const nCalls = calls.length;
  push(gm(2, '박서준', '점심 뭐 먹을까요')); await sl(200);
  chk('할 일과 상관없는 잡담은 AI에 안 보냄', calls.length === nCalls);
  push(gm(1, '김민지', '구청 보고서 다 했어요')); await sl(250);
  td = (await req('/api/te/' + etok)).j;
  chk('"다 했어요" → 완료', td.items.find(x => x.title === '구청 보고서').status === 'done');
  const w0 = (await state()).wallet;
  push(gm(1, '김민지', '/todo 편집 링크 줘')); await sl(200);
  chk('편집 링크 요청 → 무료로 알려 줌', toG().pop().text.includes('/te/' + etok) && (await state()).wallet === w0);
  await U(`/api/rooms/${r}/messages`, { text: '할 일표 링크 보여 줘', to: 'todo' }); await sl(150);
  st = await state();
  chk('기업방에서 링크 요청 → 무료, 할 일표 카드', st.wallet === w0 && st.rooms[0].msgs.filter(m => m.from === 'todo').pop().todo.url.includes('/t/'));

  // 할 일표 HTML
  let pg = await req('/t/' + tok);
  chk('할 일표 HTML: 사람별·간트·점검일', pg.s === 200 && pg.j.includes('마을빵공방 할 일표') && pg.j.includes('사람별 할 일') && pg.j.includes('김민지') && pg.j.includes('박서준') && pg.j.includes('class="gantt"') && pg.j.includes('D-14') && /sandbox/.test(pg.h['content-security-policy']));

  // 편집 링크
  const te = (b, ct) => req('/api/te/' + etok, b, null, ct);
  chk('편집 페이지: 스크립트는 같은 서버 것만', /script-src 'self'/.test((await req('/te/' + etok)).h['content-security-policy']));
  chk('틀린 편집 토큰 → 404', (await req('/api/te/' + 'a'.repeat(32))).s === 404);
  chk('JSON이 아닌 요청 거절', (await te({ ops: [] }, 'text/plain')).s === 415);
  const v0 = td.v;
  let e1 = await te({ v: v0, name: '이수진', ops: [{ op: 'add', title: '<b>후원자 감사 편지</b>', owner: '이수진', start: T, end: D(6) }] });
  chk('편집 링크에서 할 일 추가', e1.s === 200 && e1.j.items.some(x => x.owner === '이수진' && x.title === '<b>후원자 감사 편지</b>'));
  chk('기업방에 편집 내용이 남음', (await state()).rooms[0].msgs.some(m => m.from === 'sys' && m.text.includes('이수진님이 할 일표 편집 링크에서')));
  chk('옛 버전으로 고치면 409 + 최신 내용', (await te({ v: v0, ops: [{ op: 'add', title: 'x', start: T, end: T }] })).s === 409);
  const lid = e1.j.items.find(x => x.owner === '이수진').id;
  let e2 = await te({ v: e1.j.v, name: '이수진', ops: [{ op: 'update', id: lid, title: '후원자 감사 편지', owner: '이수진', start: T, end: D(7), note: '' }] });
  chk('편집: 제목·마감 변경', e2.j.items.find(x => x.id === lid).end === D(7) && e2.j.log[0].changes[0].includes('연기'));
  pg = await req('/t/' + tok);
  chk('할 일표에 입력한 HTML 태그는 글자로만', !pg.j.includes('<b><b>') && pg.j.includes('&lt;b&gt;후원자'));
  chk('잘못된 주기 거절', (await te({ v: e2.j.v, cycle: { start: T, days: 5, hour: 9 } })).s === 400);
  let e3 = await te({ v: e2.j.v, name: '이수진', ops: [{ op: 'delete', id: lid }] });
  chk('편집: 삭제', !e3.j.items.some(x => x.id === lid));

  // 아침 알림 (토큰 없음)
  const wd = [1, 2, 3, 4, 5, 6, 7].map(D).find(d => ![0, 6].includes(wdOf(d))), we = [1, 2, 3, 4, 5, 6, 7].map(D).find(d => [0, 6].includes(wdOf(d)));
  const morning = () => st.rooms[0].msgs.filter(m => m.from === 'todo' && m.text.startsWith('[할 일 점검 알림]'));
  await sl(150); st = await state();
  chk('알림 시각(9시) 전에는 안 보냄', morning().length === 0);
  process.env.HB_NOW = at(we, '09:05'); await sl(150); st = await state();
  chk('주말에는 안 보냄 (평일 알림)', morning().length === 0);
  const w1 = st.wallet;
  process.env.HB_NOW = at(wd, '09:05'); await sl(200); st = await state();
  const mm = morning();
  chk('평일 아침 기업방 알림: 남은 점검일 포함', mm.length === 1 && mm[0].text.includes(`다음 14일 점검: ${SCHED.md(D(14))} · ${SCHED.diffDays(wd, D(14))}일 남음`) && mm[0].text.includes('■ 박서준') && mm[0].text.includes('견적서 발송') && !mm[0].text.includes('구청 보고서'));
  chk('알림은 텔레그램 방에도, 토큰은 안 씀', toG().some(s => s.text.includes('[할 일 점검 알림]')) && st.wallet === w1);
  await sl(150); st = await state();
  chk('하루 한 번만', morning().length === 1);

  // 2주 점검일
  process.env.HB_NOW = at(D(14), '09:10'); await sl(400); st = await state();
  const rv = st.rooms[0].msgs.filter(m => m.from === 'todo' && m.text.startsWith('[14일 할 일 점검]')).pop();
  chk('점검일 아침: "오늘은 점검일" 알림', morning().pop().text.includes('오늘은 14일 점검일이에요'));
  chk('2주 점검 피드백: 사람별 숫자는 서버 계산 + AI 피드백', rv && rv.text.includes('■ 김민지 — 완료 1') && rv.text.includes('■ 박서준 — 완료 0 · 진행 1 (마감 지남 1)') && rv.text.includes('살펴볼 점: 견적서 발송이 마감을 넘겼어요') && !rv.text.includes('없는사람') && rv.cost === 3);
  chk('점검 결과도 텔레그램 방에', toG().some(s => s.text.includes('[14일 할 일 점검]')));
  chk('다음 점검일 안내', rv.text.includes(`다음 점검: ${SCHED.md(D(28))}`));
  pg = await req('/t/' + tok);
  chk('할 일표에 점검 기록', pg.j.includes('14일 점검 기록') && pg.j.includes('견적서 발송이 마감을 넘겼어요'));
  st = await state();
  chk('기업방 표시: 다음 점검 D-14로 넘어감', st.todo.left === 14);

  // 직접 점검 요청
  const w2 = st.wallet;
  await U(`/api/rooms/${r}/messages`, { text: '지금 2주 점검해 줘', to: 'todo' }); await sl(200);
  chk('기업방에서 점검 요청 → 점검 비용 3토큰', (await state()).wallet === w2 - 3);

  // 링크 새로 만들기
  await U('/api/todo/token', {});
  chk('링크를 바꾸면 옛 보기·편집 링크는 안 열림', (await req('/t/' + tok)).s === 404 && (await req('/api/te/' + etok)).s === 404);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

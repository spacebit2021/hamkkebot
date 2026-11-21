// 일정 봇: 텔레그램 일정방 대화 → 간트 일정표 → 링크 회신, 기업방과 동기화, 상세 계획, 보고 PPT (가짜 Claude·텔레그램)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const JSZip = require('jszip');
const SCHED = require(path.join(__dirname, '..', 'sched.js'));
const T = SCHED.kstDate(), D = n => SCHED.addDays(T, n);
const calls = []; const sent = [], docs = [], queue = []; let waiter = null, mid = 900;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) {
    const b = JSON.parse(opt.body), sys = b.system, msg = b.messages[0].content; calls.push({ sys, msg });
    const ids = [...sys.matchAll(/- id (g[0-9a-f]+) \| ([^|]+) \|/g)].map(m => ({ id: m[1], title: m[2].trim() }));
    const idOf = w => (ids.find(x => x.title.includes(w)) || {}).id;
    let out = { ops: [] };
    if (sys.includes('변경 목록을 만드세요')) {
      if (/납품 준비.*담당/.test(msg)) out = { ops: [{ op: 'add', title: '구청 납품 준비', start: D(3), end: D(5), owner: '이수진' }] };
      else if (/포장.*추가/.test(msg)) out = { ops: [{ op: 'add', title: '포장 상자 교체', start: D(1), end: D(1) }] };
      else if (/연기/.test(msg)) out = { ops: [{ op: 'update', id: idOf('납품'), start: D(10) }] };
      else if (/취소/.test(msg)) out = { ops: [{ op: 'cancel', id: idOf('포장'), reason: '업체 사정' }] };
      else if (/회의 잡아/.test(msg)) out = { ops: [], ask: '회의를 언제로 잡을까요?' };
    } else if (sys.includes('상세 계획을 HTML')) out = { id: idOf('납품'), html: '<h4>목표</h4><p>월 200개 납품 준비</p><script>alert(1)</script><table><tr><td>' + D(10) + '</td><td>재료 주문</td></tr></table>' };
    else if (sys.includes('[보고 PPT 만들기]')) out = { title: '12월 일정 보고', palette: 'teal', slides: [{ kind: 'title', title: '12월 일정 보고' }, { kind: 'stats', title: '현황', stats: [{ value: '1건', label: '진행' }, { value: '1건', label: '취소' }] }, { kind: 'closing', title: '다음 단계', message: '재료 주문' }] };
    return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] });
  }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; const bb = JSON.parse(opt.body); sent.push({ to: bb.chat_id, text: bb.text }); return ok({ ok: true, result: { message_id: mid } }); }
  if (u.includes('/sendDocument')) { docs.push({ to: opt.body.get('chat_id'), name: opt.body.get('document').name }); return ok({ ok: true, result: { message_id: 1 } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const G = -900, gm = (from, name, text) => ({ update_id: uid++, message: { message_id: 10 + uid, chat: { id: G, type: 'group', title: '마을빵공방 일정방' }, from: { id: from, first_name: name }, text } });
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3983', TELEGRAM_BOT_TOKEN: 'x', PUBLIC_URL: 'https://hb.example.org' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3983' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j; try { j = JSON.parse(buf); } catch (e) { j = buf.toString(); } r({ s: res.statusCode, j, h: res.headers, buf }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), X = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
const toG = () => sent.filter(s => s.to === G);
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  const o = (await A('/api/admin/state')).j.orgs[0].id; await A(`/api/admin/orgs/${o}/charge`, { amount: 20 });
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'sched' });
  const code = (await U(`/api/rooms/${r}/link`, {})).j.code;
  push(gm(1, '홍길동', '/link ' + code)); await sl(150);
  const state = async () => (await U('/api/state')).j;
  const lastBot = st => st.rooms[0].msgs.filter(m => m.from === 'sched').pop();

  push(gm(1, '홍길동', '다음 주 화요일부터 3일간 구청 납품 준비, 담당 이수진')); await sl(250);
  let st = await state(), lb = lastBot(st);
  const sc = (await U('/api/sched')).j;
  chk('텔레그램 일정방 글 → 일정 추가 (명령 없이), 1토큰', sc.items.length === 1 && sc.items[0].owner === '이수진' && sc.items[0].start === D(3) && st.wallet === 19);
  chk('텔레그램으로 일정표 링크 회신', toG().pop().text.includes('일정표를 고쳤어요') && toG().pop().text.includes('https://hb.example.org/g/' + sc.url.split('/g/')[1]));
  chk('기업방에도 원문과 같은 변경 내용이 남음 (+ 일정표 카드)', st.rooms[0].msgs.some(m => m.from === 'tg' && m.name === '홍길동') && lb.text.includes('추가: "구청 납품 준비"') && lb.sched && lb.sched.url);
  chk('봇이 오늘 날짜 기준으로 해석하도록 전달', calls[0].sys.includes(`오늘은 ${T}`) && calls[0].msg.includes('홍길동 · 텔레그램'));

  push(gm(2, '김민지', '포장 상자 교체 내일 추가해 주세요')); await sl(250);
  const nBefore = toG().length, wBefore = (await state()).wallet, cBefore = calls.length;
  push(gm(2, '김민지', '오늘 날씨 좋네요 ㅎㅎ')); await sl(250);
  chk('일정과 상관없는 말 → 조용히 넘어감 (회신·토큰 없음)', calls.length === cBefore + 1 && toG().length === nBefore && (await state()).wallet === wBefore);
  push(gm(3, '박팀장', '점심 메뉴 정해요')); await sl(150);
  chk('일정 단어가 없는 말은 AI도 안 부름', calls.length === cBefore + 1);

  push(gm(1, '홍길동', '납품 준비 일주일 연기해요')); await sl(250);
  const it = (await U('/api/sched')).j.items.find(x => x.title === '구청 납품 준비');
  chk('연기: 기간 유지한 채 날짜 이동', it.start === D(10) && it.end === D(12) && toG().pop().text.includes('연기'));

  // 기업방에서 취소 → 텔레그램 일정방에도 같은 내용
  await U(`/api/rooms/${r}/messages`, { text: '포장 상자 교체 취소해 줘', to: 'sched' }); await sl(250);
  const items = (await U('/api/sched')).j.items;
  chk('기업방에서 취소 → 상태 취소', items.find(x => x.title === '포장 상자 교체').status === 'cancelled');
  chk('기업방 변경도 텔레그램 일정방에 회신', toG().pop().text.includes('취소: "포장 상자 교체"'));
  const w1 = (await state()).wallet;
  await U(`/api/rooms/${r}/messages`, { text: '회의 잡아 줘', to: 'sched' }); await sl(200);
  chk('모호하면 되물음, 토큰 안 씀', lastBot(await state()).text.includes('언제로') && (await state()).wallet === w1);
  await U(`/api/rooms/${r}/messages`, { text: '일정표 링크 보여 줘', to: 'sched' }); await sl(150);
  chk('링크 안내는 무료', lastBot(await state()).text.includes('/g/') && (await state()).wallet === w1);

  // 간트 일정표 페이지
  const url = (await U('/api/sched')).j.url, gp = url.replace('https://hb.example.org', '');
  const page = await X(gp);
  chk('일정표: 로그인 없이 열림, sandbox, 간트·목록·변경 기록', page.s === 200 && /sandbox/.test(page.h['content-security-policy']) && page.j.includes('간트차트') && page.j.includes('class="bar active') && page.j.includes('class="bar cancelled') && page.j.includes('(텔레그램)') && page.j.includes('(기업방)'));

  // 상세 계획
  await U(`/api/rooms/${r}/messages`, { text: '구청 납품 준비 상세 계획 작성해 줘', to: 'sched' }); await sl(250);
  const page2 = (await X(gp)).j;
  chk('상세 계획 HTML이 일정표에 들어감 (스크립트 제거), 2토큰', page2.includes('상세 계획') && page2.includes('재료 주문') && !page2.includes('alert(1)') && (await state()).wallet === w1 - 2);
  chk('상세 계획 링크가 해당 위치로', lastBot(await state()).text.includes('#d-' + it.id));

  // 보고 PPT
  await U(`/api/rooms/${r}/messages`, { text: '상부 보고용 일정 PPT 만들어 줘', to: 'sched' }); await sl(400);
  const pm = (await state()).rooms[0].msgs.filter(m => m.deck).pop();
  const dl = await U('/api/deck/download?id=' + pm.deck.id);
  const zip = await JSZip.loadAsync(dl.buf);
  const xml = (await Promise.all(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map(n => zip.file(n).async('string')))).join('');
  chk('보고 PPT: 간트 장 포함(일정 데이터로 그림), 3토큰', pm.deck.count === 4 && xml.includes('일정 간트차트') && xml.includes('구청 납품 준비') && xml.includes('(취소)') && (await state()).wallet === w1 - 5);
  chk('보고 PPT 파일이 텔레그램 일정방에도 감', docs.some(d => String(d.to) === String(G) && d.name.endsWith('.pptx')));

  // 텔레그램 /sched 명령, 링크 바꾸기
  push(gm(1, '홍길동', '/sched')); await sl(150);
  chk('텔레그램 /sched → 일정표 링크', toG().pop().text.includes('/g/'));
  const nu = (await U('/api/sched/token', {})).j.url;
  chk('링크 바꾸면 예전 링크는 404', (await X(gp)).s === 404 && (await X(nu.replace('https://hb.example.org', ''))).s === 200);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

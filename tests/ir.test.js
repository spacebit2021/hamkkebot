// IR 봇: 작성·장별 코멘트(웹·텔레그램)·반영·검토 전문가 권한·VC 웹검색 출처 확인·최종 확정·PPTX (가짜 Claude·텔레그램)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const JSZip = require('jszip');
const outline = (n, extra = {}) => ({ title: `마을빵공방 IR v${n}`, palette: 'navy', checks: ['연 매출 확인 필요'], slides: [
  { kind: 'title', title: '마을빵공방 투자 제안', subtitle: '우리밀 단체 간식', note: 'n' },
  { kind: 'message', title: '한 줄 요약', message: '경력보유여성이 굽는 우리밀 단체 간식', note: 'n' },
  { kind: 'stats', title: '성과', stats: [{ value: '월 200개', label: '구청 납품' }, { value: n > 1 ? '1.2억' : '[확인 필요: 연 매출]', label: '연 매출' }], note: 'n' },
  { kind: 'table', title: '경쟁 비교', columns: ['구분', '우리', '경쟁사'], rows: [['원료', '우리밀', '[확인 필요]']], note: 'n' },
  { kind: 'closing', title: '함께해 주세요', message: '투자 문의', note: 'n' }], ...extra });
const calls = { ir: 0, search: 0 }, sent = [], queue = []; let waiter = null, mid = 500;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) {
    const b = JSON.parse(opt.body);
    if (b.tools && b.tools[0].type === 'web_search_20250305') {
      calls.search++;
      if (calls.search === 1) return ok({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '임팩트 투자 VC' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://impact-a.example.kr/portfolio', title: 'A' }] }] });
      const vcs = { vcs: [
        { name: '임팩트벤처스A', focus: '임팩트·푸드', stage: '시드', why: '먹거리 사회적기업 투자', source: 'https://impact-a.example.kr/portfolio' },
        { name: '로컬파트너스B', focus: '지역 소셜벤처', stage: '', why: '지역 기반', source: 'https://local-b.example.kr/' },
        { name: '지어낸투자사', focus: '모든 분야', stage: '시리즈A', why: '?', source: 'https://made-up.example.com/x' }], note: '임팩트 투자 협회 회원사 목록도 참고하세요' };
      return ok({ stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', tool_use_id: 's2', content: [{ type: 'web_search_result', url: 'https://local-b.example.kr', title: 'B' }] }, { type: 'text', text: '찾은 결과입니다.\n' + JSON.stringify(vcs), citations: [{ type: 'web_search_result_location', url: 'https://impact-a.example.kr/portfolio' }] }] });
    }
    if (b.system.includes('[IR 자료 만들기]')) {
      calls.ir++; const ids = [...b.messages[0].content.matchAll(/- id (c[0-9a-f]+)/g)].map(m => m[1]);
      return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(outline(calls.ir, ids.length ? { resolved: [{ id: ids[0], reply: '연 매출 1.2억으로 반영' }, { id: 'c_fake', reply: 'x' }] } : {})) }] });
    }
    return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: '일반 답변' }] });
  }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; const bb = JSON.parse(opt.body); sent.push({ to: bb.chat_id, id: mid, text: bb.text }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const M = (id, text, extra = {}) => ({ update_id: uid++, message: { message_id: 50 + uid, chat: { id, type: 'private' }, from: { id }, text, ...extra } });
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3984', TELEGRAM_BOT_TOKEN: 'x', PUBLIC_URL: 'https://hb.example.org' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3984' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j; try { j = JSON.parse(buf); } catch (e) { j = buf; } r({ s: res.statusCode, j, h: res.headers, buf }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), U2 = mk(), E = mk(), E2 = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
const last = id => (sent.filter(s => s.to === id).pop() || { text: '' });
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  await A('/api/admin/orgs', { name: '꽃가게', loginId: 'flower', password: 'password2' });
  const o = (await A('/api/admin/state')).j.orgs.find(x => x.name === '마을빵공방').id;
  await A(`/api/admin/orgs/${o}/charge`, { amount: 40 });
  await U('/api/login', { loginId: 'bread', password: 'password1' }); await U2('/api/login', { loginId: 'flower', password: 'password2' });
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'ir' });
  const ask = async q => { await U(`/api/rooms/${r}/messages`, { text: q, to: 'ir' }); await sl(250); return (await U('/api/state')).j; };

  let st = (await U('/api/state')).j;
  chk('IR 토큰 항목: 작성 10 · 수정 3 · VC 5', st.costs.ir === 10 && st.costs.ir_update === 3 && st.costs.ir_vc === 5);
  st = await ask('IR 자료 초안 만들기');
  const m1 = st.rooms[0].msgs.filter(m => m.ir).pop();
  chk('초안 v1, 10토큰', st.wallet === 30 && m1 && m1.ir.n === 1 && m1.ir.count === 5);
  let ir = (await U('/api/ir')).j;
  chk('IR 화면 데이터: 숫자·표 슬라이드 포함', ir.current.outline.slides.some(s => s.kind === 'stats') && ir.current.outline.slides.some(s => s.kind === 'table'));
  chk('다른 기업에는 안 보임', (await U2('/api/ir')).j.current === null);
  chk('기업 코멘트', (await U('/api/ir/comment', { slide: 2, text: '연 매출을 채워 주세요 (작년 1.2억)' })).s === 200);
  chk('장 번호 범위 검사', (await U('/api/ir/comment', { slide: 9, text: 'x' })).s === 400);

  // 검토 전문가
  const e = (await A('/api/admin/experts', { name: '김투자', field: '투자 자문' })).j, e2 = (await A('/api/admin/experts', { name: '이세무', field: '세무' })).j;
  push(M(81, '/expert ' + e.regCode)); await sl(60); push(M(81, '/rate 5')); await sl(60);
  push(M(82, '/expert ' + e2.regCode)); await sl(60); push(M(82, '/rate 5')); await sl(60);
  push(M(81, '/ir')); await sl(100);
  chk('초대 전에는 IR을 못 봄', last(81).text.includes('볼 수 있는 IR 자료가 없어요'));
  await U('/api/ir/reviewer', { expertId: e.id, add: true }); await sl(120);
  const note = last(81);
  chk('검토 부탁 → 텔레그램 알림에 바로가기 링크(1회용 코드)', note.text.includes('검토를 부탁') && /https:\/\/hb\.example\.org\/expert\?code=\w+#ir-/.test(note.text));
  const code = note.text.match(/code=(\w+)/)[1];
  chk('링크 코드로 전문가 로그인', (await E('/api/expert/login', { code })).s === 200);
  let ex = (await E('/api/expert/ir')).j;
  chk('전문가 IR 목록', ex.orgs.length === 1 && ex.orgs[0].n === 1);
  chk('전문가가 웹에서 슬라이드·코멘트 봄', (await E('/api/expert/ir/view?org=' + o)).j.comments.length === 1);
  chk('전문가 웹 코멘트', (await E('/api/expert/ir/comment', { orgId: o, slide: 3, text: '경쟁사 원료를 조사해 적어 주세요' })).s === 200);
  push(M(81, '/irc 2 한 줄 요약에 고용 인원을 넣어 주세요', { reply_to_message: { message_id: note.id } })); await sl(120);
  chk('텔레그램 /irc 코멘트 (알림에 답장)', last(81).text.includes('2장') && (await U('/api/ir')).j.comments.length === 3);
  chk('기업 채팅방에 전문가 코멘트 알림', (await U('/api/state')).j.rooms[0].msgs.some(m => m.from === 'sys' && m.text.includes('김투자 전문가가 IR')));
  // 다른 전문가는 못 봄 → 상담 중이면 봄
  const c2 = (await mk()('/api/expert/login', { code: 'x' })); // 무효
  push(M(82, '/login')); await sl(100); const code2 = last(82).text.match(/코드: (\w+)/)[1];
  await E2('/api/expert/login', { code: code2 });
  chk('검토자가 아닌 전문가는 404', (await E2('/api/expert/ir/view?org=' + o)).s === 404);
  await U(`/api/rooms/${r}/call`, { expertId: e2.id, text: '세무 질문' }); await sl(80);
  chk('상담 중인 전문가는 볼 수 있음', (await E2('/api/expert/ir/view?org=' + o)).s === 200);
  await U(`/api/rooms/${r}/end`, { expertId: e2.id });

  // 코멘트 반영
  const before = sent.filter(s => s.to === 81).length;
  const ap = await U('/api/ir/apply', {}); await sl(200);
  ir = (await U('/api/ir')).j;
  const applied = ir.comments.filter(c => c.status === 'applied');
  chk('코멘트 반영 → v2, 3토큰, 반영 1개(답글 포함)·나머지 2개 그대로', ap.s === 200 && ir.current.n === 2 && applied.length === 1 && applied[0].reply.includes('1.2억') && ir.comments.filter(c => c.status === 'open').length === 2 && (await U('/api/state')).j.wallet === 27);
  chk('없는 코멘트 id는 무시', !ir.comments.some(c => c.id === 'c_fake'));
  chk('검토 전문가에게 v2 알림', sent.filter(s => s.to === 81).length > before && last(81).text.includes('IR v2') && last(81).text.includes('반영'));
  const open1 = ir.comments.find(c => c.status === 'open');
  await U('/api/ir/dismiss', { id: open1.id });
  chk('기업이 "반영 안 함" 처리', (await U('/api/ir')).j.comments.find(c => c.id === open1.id).status === 'dismissed');

  // 최종 확정
  chk('확정 전 PPTX 불가', (await U('/api/ir/pptx')).s === 400);
  const f1 = await U('/api/ir/final', { versionId: ir.current.id });
  chk('[확인 필요]·열린 코멘트가 있으면 먼저 경고(409)', f1.s === 409 && f1.j.marks >= 1 && f1.j.open === 1);
  chk('그래도 확정', (await U('/api/ir/final', { versionId: ir.current.id, force: true })).s === 200);
  const px = await U('/api/ir/pptx');
  const zip = await JSZip.loadAsync(px.buf);
  chk('최종 PPTX: 5장, 파일 이름에 "최종"', px.s === 200 && Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length === 5 && decodeURIComponent(px.h['content-disposition']).includes('IR_v2_최종.pptx'));
  chk('확정 알림이 검토 전문가에게', last(81).text.includes('최종 확정'));

  // VC 찾기 (웹 검색)
  st = await ask('우리에게 맞는 VC 찾기');
  const vm = st.rooms[0].msgs.filter(m => m.from === 'ir').pop();
  ir = (await U('/api/ir')).j;
  chk('VC 찾기: 검색 일시정지(pause_turn) 이어서 처리', calls.search === 2);
  chk('출처가 검색 결과에 있는 2곳만, 지어낸 1곳 제외', ir.vcs[0].items.length === 2 && ir.vcs[0].dropped === 1 && !ir.vcs[0].items.some(x => x.name === '지어낸투자사'));
  chk('답에 출처 URL과 주의 문구, 5토큰', vm.text.includes('https://impact-a.example.kr/portfolio') && vm.text.includes('직접 확인') && st.wallet === 22);

  // 검토에서 빼면 접근 불가
  await U('/api/ir/reviewer', { expertId: e.id, add: false });
  chk('검토에서 빼면 볼 수 없음', (await E('/api/expert/ir/view?org=' + o)).s === 404);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// 마케팅 봇 PPT 만들기 (가짜 Claude 응답, 실제 API 호출 없음)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const JSZip = require('jszip');
const OUT = (title, extra = '') => '```json\n' + JSON.stringify({ title, palette: 'terracotta', checks: ['대표 연락처가 없어 마지막 장에 넣지 않았어요'], slides: [
  { kind: 'title', title, subtitle: '경력보유여성이 일하는 빵집', note: '인사' },
  { kind: 'cards', title: '제품', items: [{ head: '통밀빵', text: '우리밀 통밀빵' }, { head: '단체 간식', text: '행사용 간식' + 'ㅋ'.repeat(200) }], note: '제품 소개' },
  { kind: 'steps', title: '주문 과정', items: [{ head: '문의', text: '수량' }, { head: '제작', text: '굽기' }, { head: '전달', text: '배송' }], note: '과정' },
  { kind: 'unknown-kind', title: '알 수 없는 종류', bullets: ['가', '나'], note: '' },
  { kind: 'closing', title: '함께해요' + extra, message: '문의 주세요', note: '마무리' }] }) + '\n```';
let mode = 'ok'; const prompts = [], sentDocs = [], queue = []; let waiter = null;
const push = u => { queue.push(u); if (waiter) { const w = waiter; waiter = null; w(); } };
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) {
    const b = JSON.parse(opt.body); prompts.push(b);
    const isDeck = b.system.includes('[PPT 만들기]');
    const t = !isDeck ? '인스타그램 글 초안' : mode === 'bad' ? '죄송해요, 지금은 못 만들어요' : OUT(prompts.filter(p => p.system.includes('[PPT 만들기]')).length > 1 ? '마을빵공방 소개 (수정)' : '마을빵공방 소개');
    return ok({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
  }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendDocument')) { const f = opt.body.get('document'); sentDocs.push({ to: opt.body.get('chat_id'), name: f.name, type: f.type, size: f.size }); return ok({ ok: true, result: { message_id: 1 } }); }
  return ok({ ok: true, result: { message_id: 1 } });
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3986', TELEGRAM_BOT_TOKEN: 'x' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3986' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j; try { j = JSON.parse(buf); } catch (e) { j = buf; } r({ s: res.statusCode, j, h: res.headers, buf }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), U2 = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  await A('/api/admin/orgs', { name: '꽃가게', loginId: 'flower', password: 'password2' });
  const o = (await A('/api/admin/state')).j.orgs.find(x => x.name === '마을빵공방').id;
  await A(`/api/admin/orgs/${o}/charge`, { amount: 10 });
  await U('/api/login', { loginId: 'bread', password: 'password1' }); await U2('/api/login', { loginId: 'flower', password: 'password2' });
  await U('/api/org', { name: '마을빵공방', mission: '경력보유여성 고용' });
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'mkt' });
  const ask = async q => { await U(`/api/rooms/${r}/messages`, { text: q, to: 'mkt' }); await sl(250); return (await U('/api/state')).j; };

  let st = (await U('/api/state')).j;
  chk('PPT 별도 토큰 항목 (기본 3)', st.costs.mkt_ppt === 3 && st.costs.mkt === 1);
  st = await ask('인스타그램 글 하나');
  chk('일반 요청은 1토큰, PPT 아님', st.wallet === 9 && !st.rooms[0].msgs.some(m => m.deck));
  st = await ask('회사 소개 PPT 만들어 줘');
  const m1 = st.rooms[0].msgs.filter(m => m.deck).pop();
  chk('PPT 요청 → 3토큰, PPT 카드', st.wallet === 6 && m1 && m1.cost === 3 && m1.deck.n === 1 && m1.deck.count === 5);
  chk('봇이 기업 정보 문서와 PPT 형식 지시를 받음', /기업 정보 문서 v\d/.test(prompts[1].system) && prompts[1].system.includes('지어내지 말고'));
  chk('답에 슬라이드 목록과 확인할 것', m1.text.includes('1. 마을빵공방 소개') && m1.text.includes('대표 연락처가 없어'));
  const dl = await U('/api/deck/download?id=' + m1.deck.id);
  chk('PPT 내려받기: pptx 형식·파일 이름', dl.s === 200 && dl.h['content-type'].includes('presentationml') && dl.buf.slice(0, 2).toString() === 'PK' && decodeURIComponent(dl.h['content-disposition']).includes('.pptx'));
  const zip = await JSZip.loadAsync(dl.buf);
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const notes = Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  chk('슬라이드 5장(알 수 없는 종류는 목록형으로) + 발표자 메모', slides.length === 5 && notes.length >= 4);
  chk('zip에 빈 폴더 항목 없음', !Object.values(zip.files).some(f => f.dir));
  const all = (await Promise.all(slides.map(n => zip.file(n).async('string')))).join('');
  chk('긴 글은 잘림(…), 코드 블록 표시 제거', all.includes('…') && !all.includes('```'));
  chk('다른 기업은 못 내려받음', (await U2('/api/deck/download?id=' + m1.deck.id)).s === 404);

  st = await ask('3번 슬라이드를 더 짧게 고쳐 줘 PPT');
  const m2 = st.rooms[0].msgs.filter(m => m.deck).pop();
  chk('수정 요청 → 직전 개요를 바탕으로 v2', m2.deck.n === 2 && prompts[prompts.length - 1].messages[0].content.includes('직전 PPT 개요 v1') && st.wallet === 3);

  mode = 'bad'; st = await ask('발표자료 만들어 줘'); mode = 'ok';
  chk('개요가 안 오면 실패 안내 + 토큰 돌려줌', st.wallet === 3 && st.rooms[0].msgs.filter(m => m.from === 'mkt').pop().text.includes('토큰은 쓰지 않았어요'));

  await A('/api/admin/costs', { costs: { mkt_ppt: 0 } });
  chk('관리자가 PPT 비용 0으로 → 무료', (await ask('슬라이드 한 번 더')).wallet === 3);
  // 텔레그램 그룹이 연결된 방이면 PPT 파일도 그룹에 보냄
  const code = (await U(`/api/rooms/${r}/link`, {})).j.code;
  push({ update_id: 1, message: { message_id: 1, chat: { id: -700, type: 'group', title: '팀' }, from: { id: 5, first_name: '팀원' }, text: '/link ' + code } }); await sl(150);
  push({ update_id: 2, message: { message_id: 2, chat: { id: -700, type: 'group', title: '팀' }, from: { id: 5, first_name: '팀원' }, text: '/mkt 사업 소개 PPT 부탁해요' } }); await sl(400);
  const td = sentDocs.find(d => d.to === '-700');
  chk('텔레그램 그룹에서 /mkt PPT 요청 → .pptx 파일 전송', td && td.name.endsWith('.pptx') && td.type.includes('presentationml') && td.size > 10000);
  const led = (await A('/api/admin/state')).j.ledger.filter(l => l.type === 'bot');
  chk('거래 기록: "마케팅 매니저 봇 PPT" 3토큰 2건, 일반 1건', led.filter(l => l.botName === '마케팅 매니저 봇 PPT' && l.amount === 3).length === 2 && led.filter(l => l.botName === '마케팅 매니저 봇').length === 1);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

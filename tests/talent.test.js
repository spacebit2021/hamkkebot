// 인재추천 봇: 기업방 추천 → 동의 확인 후 목록 → 다른 기업이 고르면 추천 기업이 토큰, 개인정보는 고른 기업에만 (가짜 Claude)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const calls = [];
global.fetch = async (url, opt = {}) => {
  if (!String(url).includes('/v1/messages')) return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  const b = JSON.parse(opt.body), msg = b.messages[0].content; calls.push(b);
  let out;
  if (/박지은/.test(msg)) out = { ok: true, consent: /동의/.test(msg), profile: { title: '패키지 디자이너 · 3년차', field: '디자인', years: '3년', skills: ['일러스트레이터', '포토샵', '인쇄 감리'], summary: '식품 패키지와 라벨을 주로 만들었고, 인쇄소와 색 감리까지 직접 챙겨요.', region: '서울', workType: '프리랜서', strengths: ['마감을 잘 지켜요'] }, private: { name: '박지은', contact: '010-1234-5678' } };
  else out = { ok: false, ask: '어떤 분야의 인재인지, 경력과 연락 방법을 알려 주세요.' };
  return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }) };
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3997', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3997' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 50 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const W = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const list = async k => (await U[k]('/api/talent')).j;
  await U.A(`/api/rooms/${room.A}/invite`, { botId: 'talent' });

  chk('주민번호가 들어간 추천은 AI에 보내지도 않음', await (async () => { const n = calls.length; await U.A(`/api/rooms/${room.A}/messages`, { text: '박지은 900101-2345678 추천', to: 'talent' }); await sl(120); return calls.length === n && (await msgs('A')).pop().text.includes('주민등록번호'); })());
  await U.A(`/api/rooms/${room.A}/messages`, { text: '좋은 사람 있어요', to: 'talent' }); await sl(120);
  chk('정보가 부족하면 되묻고 토큰 안 씀', (await msgs('A')).pop().text.includes('어떤 분야') && await W('A') === 50);
  await U.A(`/api/rooms/${room.A}/messages`, { text: '패키지 디자이너 박지은 추천해요. 3년차, 일러스트레이터 잘해요, 010-1234-5678, 본인 동의 받았어요', to: 'talent' }); await sl(150);
  const card = (await msgs('A')).filter(m => m.talent).pop();
  chk('초안 카드 (1토큰), AI에 차별 정보 금지 규칙', card && card.talent.status === 'draft' && card.talent.private.name === '박지은' && await W('A') === 49 && calls[calls.length - 1].system.includes('나이·생년·성별'));
  const id = card.talent.id;
  chk('초안은 아직 목록에 없음', !(await list('B')).items.length);
  chk('동의 확인 없이는 못 올림', (await U.A('/api/talent/publish', { id, consent: false })).s === 400);
  chk('다른 기업은 남의 초안을 못 올림', (await U.B('/api/talent/publish', { id, consent: true })).s === 404);
  chk('고친 내용에 계좌번호 넣으면 거절', (await U.A('/api/talent/publish', { id, consent: true, profile: { title: '디자이너', summary: '계좌번호 123' } })).s === 400);
  const pub = await U.A('/api/talent/publish', { id, consent: true, profile: { title: '식품 패키지 디자이너 · 3년차', summary: card.talent.profile.summary, skills: '일러스트레이터, 포토샵, 인쇄 감리' }, private: { name: '박지은', contact: '010-1234-5678' } });
  chk('동의 확인 후 올림 (고친 제목 반영)', pub.s === 200 && pub.j.status === 'open' && pub.j.profile.title === '식품 패키지 디자이너 · 3년차');
  const lb = (await list('B')).items[0];
  chk('다른 기업 목록: 경력·기술만, 이름·연락처 없음', lb && lb.profile.skills.length === 3 && !lb.private && !JSON.stringify(lb).includes('010-1234') && !JSON.stringify(lb).includes('박지은'));
  chk('추천 기업 목록에는 개인정보 보임', (await list('A')).items[0].private.contact === '010-1234-5678');
  chk('추천한 기업은 자기 인재를 못 고름', (await U.A('/api/talent/pick', { id })).s === 400);

  // 고르기 → 토큰
  const wa = await W('A'), wb = await W('B');
  const pk = await U.B('/api/talent/pick', { id });
  chk('고르면 10토큰: 고른 기업 −10, 추천 기업 +10', pk.s === 200 && await W('B') === wb - 10 && await W('A') === wa + 10);
  chk('고른 기업에만 이름·연락처 공개', pk.j.private.name === '박지은' && (await msgs('B')).some(m => m.text.includes('010-1234-5678')) && !(await list('C')).items[0].private);
  chk('추천 기업에 알림', (await msgs('A')).some(m => m.text.includes('꽃가게이(가) 우리가 추천한') && m.text.includes('10토큰')));
  chk('같은 인재 두 번 못 고름', (await U.B('/api/talent/pick', { id })).s === 400);
  const led = (await Ad('/api/admin/state')).j.ledger;
  chk('거래 기록', led.some(l => l.type === 'talent_pick' && l.toOrgName === '마을빵공방') && led.some(l => l.type === 'talent_pick_in' && l.fromOrgName === '꽃가게'));
  await Ad('/api/admin/costs', { costs: { talent_pick: 15 } });
  const wa2 = await W('A'), wc = await W('C');
  await U.C('/api/talent/pick', { id });
  chk('관리자가 정한 금액(15)으로, 여러 기업이 고를 수 있음', await W('C') === wc - 15 && await W('A') === wa2 + 15);
  const mine = (await list('A')).items[0];
  chk('추천 기업: 받은 토큰·고른 기업 목록', mine.earned === 25 && mine.pickedBy.includes('꽃가게') && mine.pickedBy.includes('책방'));
  // 잔액 부족
  await Ad('/api/admin/orgs/' + (await Ad('/api/admin/state')).j.orgs.find(o => o.name === '책방').id + '/deduct', { amount: await W('C') });
  // 마감·숨김·삭제
  await U.A('/api/talent/close', { id });
  chk('마감하면 새 기업 목록엔 없고, 이미 고른 기업은 계속 봄', !(await list('C')).items.some(t => t.id === id && t.status === 'open' && !t.picked) && (await list('B')).items.some(t => t.id === id && t.private));
  chk('마감한 인재는 못 고름', (await Ad('/api/admin/state')).j.talents[0].status === 'closed');
  await U.A('/api/talent/delete', { id });
  chk('지우면 개인정보까지 사라짐 (고른 기업 목록에서도)', !(await list('B')).items.length && !JSON.stringify((await msgs('A')).filter(m => m.talent)).includes('010-1234'));
  // 관리자 숨김
  await U.A(`/api/rooms/${room.A}/messages`, { text: '박지은 다시 추천, 동의 받았어요', to: 'talent' }); await sl(150);
  const id2 = (await msgs('A')).filter(m => m.talent).pop().talent.id;
  await U.A('/api/talent/publish', { id: id2, consent: true });
  await Ad(`/api/admin/talent/${id2}/hide`, { hidden: true, reason: '확인 중' });
  chk('관리자가 숨기면 다른 기업 목록에서 빠지고 못 고름', !(await list('B')).items.some(t => t.id === id2) && (await U.B('/api/talent/pick', { id: id2 })).s === 404);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

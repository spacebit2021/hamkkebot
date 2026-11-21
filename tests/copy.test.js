// 무단 복사: 다른 기업 봇의 역할 지시문을 베껴 올리면 원작으로 연결 → 쓰일 때마다 원작 기업에 토큰 (가짜 Claude)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
global.fetch = async (url) => String(url).includes('/v1/messages') ? { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] }) } : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3986', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const BOTS = require(path.join(__dirname, '..', 'bots.js')).BOTS || require(path.join(__dirname, '..', 'bots.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3986' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
const ROLE = `당신은 마을빵공방이 오래 다듬어 온 인건비 지원금 정산 점검 도우미입니다.
1. 먼저 사업 연도와 지원 기관(고용노동부·지자체)을 묻고, 기관마다 다른 증빙 목록을 구분해 안내하세요.
2. 급여대장, 4대보험 납부확인서, 근로계약서, 출근부를 한 줄씩 대조해 빠진 달을 표로 보여 주세요.
3. 지원 대상자가 중도 퇴사한 경우 일할 계산 방식과 반납 금액 계산 순서를 단계별로 설명하세요.
4. 정산 마감 2주 전, 1주 전, 3일 전에 해야 할 일을 체크리스트로 정리하세요.
5. 금액은 사용자가 준 숫자로만 계산하고, 모르는 규정은 담당 기관에 확인하라고 말하세요.`;
const OTHER = `당신은 꽃가게 전용 꽃다발 추천 도우미입니다. 계절 꽃과 손님의 예산, 받는 사람과의 관계를 물어 세 가지 구성을 추천하고, 꽃말과 관리법을 짧게 덧붙이세요. 포장지 색과 리본 조합도 두 가지씩 제안하고, 배송이 필요하면 주문 마감 시각을 확인하라고 안내하세요.`;
const D = (name, role, kind = 'chat') => ({ hamkkebot: 1, name, short: name[0], color: '#2D6A4F', tag: '점검', desc: name + ' 설명', hello: '안녕하세요', quick: [], kind, role });
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C'], ['카페', 'E'], ['공방', 'F']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 100 });
  const room = {};
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const W = async k => (await U[k]('/api/state')).j.wallet;
  const msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const attach = async (k, def, botId) => { const s = await U[k]('/api/bots/submit', { def, roomId: room[k], botId }); const id = s.j.id || botId; const c = (await msgs(k)).filter(m => m.botReq).pop(); await U[k]('/api/bots/review', { botId: id, msgId: c.id, approve: true }); return { id, card: c }; };
  const use = async (k, id) => { await U[k](`/api/rooms/${room[k]}/invite`, { botId: id }); await U[k](`/api/rooms/${room[k]}/messages`, { text: '점검해 주세요', to: id }); await sl(120); };

  // 원작: 마을빵공방 (공개 안 함, 요청당 2토큰으로 정해 둠)
  const orig = (await attach('A', D('정산 점검 봇', ROLE))).id;
  await U.A('/api/bots/pricing', { botId: orig, perUse: 2 });
  await use('A', orig);
  chk('원작 기업은 자기 봇을 쓰면 기본 1토큰만', await W('A') === 99);

  // 꽃가게가 베껴서 이름을 바꾸고 한 줄 덧붙임
  const stolen = D('우리 정산 도우미', ROLE.replace('마을빵공방이', '우리 회사가') + '\n6. 답은 짧게 하세요.');
  const pv = await U.B('/api/bots/parse', { text: JSON.stringify(stolen) });
  chk('올리기 전 미리보기에서 복사라고 알려 줌 (비공개 원작은 이름 숨김)', pv.j.origin && pv.j.origin.orgName === '마을빵공방' && pv.j.origin.name === '' && pv.j.origin.score >= 85 && pv.j.origin.royalty === 2);
  const b1 = await attach('B', stolen);
  chk('기업방 승인 카드에도 원작 안내', b1.card.botReq.origin && b1.card.botReq.origin.orgName === '마을빵공방');
  chk('원작 기업에 알림', (await msgs('A')).some(m => m.from === 'sys' && m.text.includes('꽃가게') && m.text.includes('우리 기업의 "정산 점검 봇"') && m.text.includes('요청당 2토큰')));
  chk('복사한 기업에도 알림', (await msgs('B')).some(m => m.from === 'sys' && m.text.includes('원작 봇으로 연결')));
  const card = (await U.B('/api/state')).j.bots.find(b => b.id === b1.id);
  chk('봇 목록 가격에 원작 몫 포함 (1+2)', card.cost === 3 && card.origin.royalty === 2 && card.origin.orgName === '마을빵공방');
  const wa = await W('A'), wb = await W('B');
  await use('B', b1.id);
  chk('복사한 기업이 자기 봇을 써도 원작 몫 2토큰이 마을빵공방으로', await W('B') === wb - 3 && await W('A') === wa + 2);
  const led = (await Ad('/api/admin/state')).j.ledger;
  chk('거래 기록: 원작 몫 보냄·받음', led.some(l => l.type === 'royalty' && l.amount === 2 && l.toOrgName === '마을빵공방' && l.originName === '정산 점검 봇') && led.some(l => l.type === 'royalty_in' && l.fromOrgName === '꽃가게'));
  chk('원작 봇 쪽에 "복사로 찾은 봇 1개"', (await U.A('/api/bots/mine')).j.bots.find(b => b.id === orig).copies === 1);

  // 띄어쓰기·문장부호·줄바꿈만 바꾼 것, 절반만 잘라 간 것도
  const spaced = ROLE.replace(/\n/g, ' ').replace(/[.,·()]/g, ' ').replace(/ /g, '  ');
  chk('띄어쓰기·문장부호만 바꿔도 찾음', (await U.C('/api/bots/parse', { text: JSON.stringify(D('정산봇', spaced)) })).j.origin != null);
  const half = ROLE.split('\n').slice(1, 4).join('\n');
  chk('일부만 잘라 가도 찾음', (await U.C('/api/bots/parse', { text: JSON.stringify(D('정산봇', half)) })).j.origin != null);
  chk('내용이 다른 봇은 복사 아님', (await U.C('/api/bots/parse', { text: JSON.stringify(D('꽃다발 추천', OTHER)) })).j.origin === null);

  // 기본 봇 글은 누구나 쓸 수 있음: 둘 다 기본 할 일 봇을 고쳐 올려도 서로 복사가 아님
  const todoRole = BOTS.find(b => b.id === 'todo').role;
  await attach('A', D('우리 할 일', todoRole + '\n- 금요일 오후에 주간 정리를 해요.', 'todo'));
  chk('기본 봇 역할을 쓴 것끼리는 복사로 안 봄', (await U.C('/api/bots/parse', { text: JSON.stringify(D('할 일 비서', todoRole + '\n- 월요일 아침 회의 전에 할 일을 정리해요.', 'todo')) })).j.origin === null);

  // 복사의 복사 → 맨 처음 원작으로, 원작이 가격을 안 정했으면 기본 몫(1)
  const c1 = await attach('C', D('정산 비서', stolen.role + '\n7. 표는 마크다운으로.'));
  chk('복사의 복사도 맨 처음 원작(마을빵공방)으로', (await U.C('/api/bots/mine')).j.bots.find(b => b.id === c1.id).origin.orgName === '마을빵공방');
  const o2 = (await attach('E', D('꽃다발 추천 봇', OTHER))).id; // 가격 안 정한 원작
  const f1 = await attach('F', D('꽃 추천', OTHER + ' 이모지는 쓰지 마세요.'));
  const we = await W('E'), wf = await W('F');
  await use('F', f1.id);
  chk('원작이 요청당 가격을 안 정했으면 관리자 기본 몫 1토큰', await W('F') === wf - 2 && await W('E') === we + 1);

  // 복사한 봇을 공개하고 비싸게 팔아도 몫은 원작으로
  await U.B('/api/bots/pricing', { botId: b1.id, perUse: 5, passDays: 30, passPrice: 40 });
  await U.B('/api/bots/publish', { botId: b1.id });
  await Ad(`/api/admin/bots/${b1.id}/approve`, {});
  const wa2 = await W('A'), wb2 = await W('B'), wf2 = await W('F');
  await use('F', b1.id);
  chk('다른 기업이 공개된 복사본을 쓰면 몫 5토큰은 원작으로, 복사한 기업은 0', await W('F') === wf2 - 6 && await W('A') === wa2 + 5 && await W('B') === wb2);
  await U.F('/api/bots/pass', { botId: b1.id });
  chk('복사본 이용권 판매 대금도 원작 기업으로', await W('A') === wa2 + 45 && await W('B') === wb2);
  const wa3 = await W('A');
  await use('A', b1.id);
  chk('원작 기업이 복사본을 쓸 땐 몫 없음', await W('A') === wa3 - 1);

  // 업데이트로 내용을 다 바꿔도 연결 유지
  await attach('B', D('우리 정산 도우미', OTHER + ' 정산 서류도 봐 드려요.'), b1.id);
  chk('한 번 연결되면 내용을 바꿔도 유지', (await U.B('/api/bots/mine')).j.bots.find(b => b.id === b1.id).origin != null);
  // 원작 기업이 자기 봇을 고쳐도 꽃가게 것의 복사로 보지 않음 (먼저 만든 쪽이 원작)
  const up = await attach('A', D('정산 점검 봇', ROLE + '\n6. 답은 짧게 하세요.'), orig);
  chk('먼저 만든 쪽(원작)은 업데이트해도 복사로 안 봄', !up.card.botReq.origin && !(await U.A('/api/bots/mine')).j.bots.find(b => b.id === orig).origin);

  // 운영 기관: 잘못 찾은 연결 풀기 → 다시 안 붙음, 못 찾은 복사 직접 연결
  const adm = (await Ad('/api/admin/state')).j;
  chk('관리자 화면에 복사 목록', adm.copies.some(c => c.id === b1.id && c.origin.orgName === '마을빵공방') && adm.allBots.length >= 5);
  await Ad(`/api/admin/bots/${f1.id}/origin`, { clear: true });
  const wf3 = await W('F'), we3 = await W('E');
  await use('F', f1.id);
  chk('연결을 풀면 원작 몫 없음', await W('F') === wf3 - 1 && await W('E') === we3);
  await attach('F', D('꽃 추천', OTHER + ' 짧게 답하세요.'), f1.id);
  chk('푼 뒤 업데이트해도 다시 안 붙음', !(await U.F('/api/bots/mine')).j.bots.find(b => b.id === f1.id).origin);
  chk('자기 봇·같은 기업 봇으로는 연결 못 함', (await Ad(`/api/admin/bots/${f1.id}/origin`, { fromBotId: f1.id })).s === 400);
  await Ad(`/api/admin/bots/${f1.id}/origin`, { fromBotId: o2 });
  const wf4 = await W('F'), we4 = await W('E');
  await use('F', f1.id);
  chk('직접 연결하면 다시 원작 몫', await W('F') === wf4 - 2 && await W('E') === we4 + 1);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// 원작 기업의 복사 신고 → 관리자 결정 (원작으로 연결 · 폐기 · 기각) (가짜 Claude)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
global.fetch = async (url) => String(url).includes('/v1/messages') ? { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] }) } : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3987', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3987' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
const ROLE = `당신은 마을빵공방이 오래 다듬어 온 인건비 지원금 정산 점검 도우미입니다.
1. 먼저 사업 연도와 지원 기관(고용노동부·지자체)을 묻고, 기관마다 다른 증빙 목록을 구분해 안내하세요.
2. 급여대장, 4대보험 납부확인서, 근로계약서, 출근부를 한 줄씩 대조해 빠진 달을 표로 보여 주세요.
3. 지원 대상자가 중도 퇴사한 경우 일할 계산 방식과 반납 금액 계산 순서를 단계별로 설명하세요.
4. 정산 마감 2주 전, 1주 전, 3일 전에 해야 할 일을 체크리스트로 정리하세요.`;
// 같은 내용을 말만 바꾼 것 (자동 기준 아래)
const PARA = `너는 인건비 지원 사업 정산을 도와주는 비서야.
가장 처음에 몇 년도 사업인지, 고용노동부인지 지자체인지 확인하고 기관별 증빙 서류를 나눠서 알려 줘.
급여 대장·4대 보험 납부 확인서·근로 계약서·출근 기록을 서로 맞춰 보고 빠진 달이 있으면 표로 정리해.
지원받던 직원이 중간에 그만두면 날짜로 나누는 계산법과 돌려줄 돈 계산 방법을 차례로 알려 줘.
마감 14일 전·7일 전·3일 전 할 일을 목록으로 만들어 줘.`;
const D = (name, role) => ({ hamkkebot: 1, name, short: name[0], color: '#2D6A4F', tag: '점검', desc: name + ' 설명', hello: '안녕하세요', quick: [], kind: 'chat', role });
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C'], ['카페', 'E'], ['공방', 'F']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 100 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const W = async k => (await U[k]('/api/state')).j.wallet, msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;
  const attach = async (k, def, botId) => { const s = await U[k]('/api/bots/submit', { def, roomId: room[k], botId }); if (s.s !== 200) return { err: s.j.error }; const id = s.j.id || botId; const c = (await msgs(k)).filter(m => m.botReq).pop(); await U[k]('/api/bots/review', { botId: id, msgId: c.id, approve: true }); return { id }; };
  const use = async (k, id) => { await U[k](`/api/rooms/${room[k]}/invite`, { botId: id }); await U[k](`/api/rooms/${room[k]}/messages`, { text: '점검해 주세요', to: id }); await sl(120); };
  const mine = async k => (await U[k]('/api/bots/mine')).j;
  const claims = async () => (await Ad('/api/admin/state')).j.claims;

  const orig = (await attach('A', D('정산 점검 봇', ROLE))).id;
  await U.A('/api/bots/pricing', { botId: orig, perUse: 2 });

  // 1) 비공개로 말만 바꿔 복사 → 자동으로는 못 찾음 → 원작 기업이 이름으로 신고 → 관리자가 봇을 골라 연결
  const bB = (await attach('B', D('정산 비서', PARA))).id;
  chk('말만 바꾼 복사는 자동 연결 안 됨', !(await mine('B')).bots[0].origin);
  chk('보이지 않는 비공개 봇은 고를 수 없음', (await U.A('/api/bots/claim', { origBotId: orig, targetBotId: bB, want: 'link', reason: '내용이 같아요' })).s === 404);
  chk('사유가 너무 짧으면 거절', (await U.A('/api/bots/claim', { origBotId: orig, targetText: '꽃가게 정산 비서', want: 'link', reason: '같음' })).s === 400);
  chk('남의 봇을 원작으로 신고 못 함', (await U.C('/api/bots/claim', { origBotId: orig, targetText: '꽃가게 정산 비서', want: 'link', reason: '내용이 같아요' })).s === 404);
  const c1 = await U.A('/api/bots/claim', { origBotId: orig, targetText: '꽃가게 "정산 비서" — 직원이 사용하는 화면을 봤어요', want: 'link', reason: '역할 지시문 1~4번 순서와 내용이 그대로예요. 우리가 먼저 만들었어요.' });
  chk('이름으로 신고 접수 + 기업방 기록', c1.s === 200 && (await msgs('A')).some(m => m.text.includes('운영 기관에 신고했어요')));
  let cl = (await claims()).find(x => x.id === c1.j.id);
  chk('관리자 화면: 신고 내용·원작 정보·결정 대기', cl.status === 'open' && cl.orgName === '마을빵공방' && cl.orig.name === '정산 점검 봇' && cl.target === null && cl.targetText.includes('정산 비서'));
  chk('관리자가 신고 기업 자기 봇을 고르면 거절', (await Ad(`/api/admin/claims/${c1.j.id}`, { action: 'link', targetBotId: orig })).s === 400);
  await Ad(`/api/admin/claims/${c1.j.id}`, { action: 'link', targetBotId: bB, note: '내용 순서와 항목이 같아 복사로 판단' });
  cl = (await claims()).find(x => x.id === c1.j.id);
  chk('연결 결정 → 상태·겹침 비율 기록', cl.status === 'linked' && cl.target.name === '정산 비서' && typeof cl.overlap === 'number');
  chk('양쪽 기업방에 알림 (메모 포함)', (await msgs('B')).some(m => m.text.includes('복사한 것으로 확인했어요') && m.text.includes('복사로 판단')) && (await msgs('A')).some(m => m.text.includes('우리 "정산 점검 봇"의 복사로 연결')));
  const wa = await W('A'), wb = await W('B'); await use('B', bB);
  chk('이후 꽃가게가 쓰면 원작 몫 2토큰이 마을빵공방으로', await W('B') === wb - 3 && await W('A') === wa + 2);
  chk('이미 결정한 요구는 다시 결정 못 함', (await Ad(`/api/admin/claims/${c1.j.id}`, { action: 'discard' })).s === 400);
  chk('연결 후 B가 업데이트해도 유지', (await attach('B', D('정산 비서', PARA + '\n표는 짧게.'), bB)).id && (await mine('B')).bots[0].origin);

  // 2) 말만 바꿔 공개 → 원작 기업이 목록에서 골라 폐기 요구 → 폐기
  const bC = (await attach('C', D('정산 체크', PARA.replace('너는', '당신은'))));
  await U.C('/api/bots/pricing', { botId: bC.id, perUse: 3 }); await U.C('/api/bots/publish', { botId: bC.id }); await Ad(`/api/admin/bots/${bC.id}/approve`, {});
  await use('E', bC.id);
  chk('연결이 확정된 복사본을 또 베끼면 맨 처음 원작으로 자동 연결', (await mine('C')).bots[0].origin && (await mine('C')).bots[0].origin.orgName === '마을빵공방');
  chk('공개된 봇은 신고 목록에 보임', (await mine('A')).reportable.some(r => r.id === bC.id));
  const c2 = await U.A('/api/bots/claim', { origBotId: orig, targetBotId: bC.id, want: 'discard', reason: '공개해서 다른 기업에 팔고 있어요. 내용이 우리 봇과 같아요.' });
  chk('같은 봇 중복 신고 막음', (await U.A('/api/bots/claim', { origBotId: orig, targetBotId: bC.id, want: 'discard', reason: '또 신고합니다' })).s === 400);
  cl = (await claims()).find(x => x.id === c2.j.id);
  chk('관리자: 두 역할 지시문·만든 날짜 비교 가능', cl.target.role.includes('인건비') && cl.orig.role.includes('마을빵공방') && cl.orig.createdAt < cl.target.createdAt && cl.want === 'discard');
  await Ad(`/api/admin/claims/${c2.j.id}`, { action: 'discard', note: '원작을 말만 바꿔 공개 판매' });
  const sE = (await U.E('/api/state')).j;
  chk('폐기 → 다른 기업 목록·채팅방에서 빠지고 알림', !sE.bots.some(b => b.id === bC.id) && !sE.rooms[0].bots.includes(bC.id) && sE.rooms[0].msgs.some(m => m.text.includes('폐기돼 이 방에서 빠졌어요')));
  const sC = (await U.C('/api/state')).j, mC = (await mine('C')).bots.find(b => b.id === bC.id);
  chk('복사한 기업도 못 씀 · 폐기 사유 표시', !sC.bots.some(b => b.id === bC.id) && mC.discarded && mC.discarded.reason.includes('공개 판매'));
  chk('폐기한 봇은 업데이트·공개·삭제 못 함', (await U.C('/api/bots/submit', { def: D('정산 체크', PARA), roomId: room.C, botId: bC.id })).s === 400 && (await U.C('/api/bots/publish', { botId: bC.id })).s === 400);
  const again = await attach('C', D('새 정산 봇', PARA.replace('너는', '당신은') + ' 친절하게.'));
  chk('폐기된 봇을 새 봇으로 다시 올려도 막음', again.err && again.err.includes('폐기한'));
  chk('C의 원작 신고 알림', (await msgs('A')).some(m => m.text.includes('복사로 확인하고 폐기')));
  await U.E(`/api/rooms/${room.E}/messages`, { text: '점검', to: bC.id }); await sl(100);
  chk('폐기된 봇 호출해도 토큰 안 씀', (await W('E')) === 100 - 4);

  // 3) 자동으로 연결된 복사본 → 원작 기업이 "폐기 요청" (비공개라도 우리 복사본이면 고를 수 있음)
  const bF = (await attach('F', D('그대로 복사', ROLE + '\n5. 추가.'))).id;
  const ma = (await mine('A')).bots.find(b => b.id === orig);
  chk('원작 쪽에 연결된 복사본 목록', ma.copyList.some(x => x.id === bF && x.orgName === '공방'));
  const c3 = await U.A('/api/bots/claim', { origBotId: orig, targetBotId: bF, want: 'discard', reason: '토큰보다 아예 못 쓰게 해 주세요.' });
  chk('연결된 비공개 복사본은 신고 가능', c3.s === 200);
  // 4) 기각
  await Ad(`/api/admin/claims/${c3.j.id}`, { action: 'reject', note: '이미 원작 몫이 가고 있어 폐기까지는 하지 않아요' });
  chk('기각 → 원작 기업에 메모와 함께 알림, 봇은 그대로', (await msgs('A')).some(m => m.text.includes('받아들이지 않았어요') && m.text.includes('원작 몫이 가고')) && (await U.F('/api/state')).j.bots.some(b => b.id === bF));
  const hist = (await mine('A')).claims;
  chk('원작 기업의 신고 내역: 연결됨·폐기됨·받아들여지지 않음', ['linked', 'discarded', 'rejected'].every(s => hist.some(h => h.status === s)) && hist.find(h => h.status === 'rejected').note.includes('원작 몫'));
  // 관리자 복사 목록에서 바로 폐기
  await Ad(`/api/admin/bots/${bF}/discard`, { reason: '재검토 결과 폐기' });
  chk('복사 목록에서 바로 폐기', !(await U.F('/api/state')).j.bots.some(b => b.id === bF) && !(await Ad('/api/admin/state')).j.copies.some(c => c.id === bF));
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

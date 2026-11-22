// 출퇴근 봇: 운영 기관이 정한 IP에서만 출근·퇴근 기록 (웹앱 접속 IP, 텔레그램은 1:1 확인 링크), AI 키 없이도 동작
const path = require('path'), os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-att-'));
process.env.DATA_FILE = path.join(TMP, 'data.json');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const ATT = require(path.join(__dirname, '..', 'attend.js'));

// --- 단위 ---
let pr = ATT.parseIps('203.0.113.10\n198.51.100.0/24, ::ffff:192.0.2.5\n2001:db8::/32\n# 메모\n잘못된값\n10.0.0.0/99');
chk('IP 목록 읽기 (대역·IPv6·IPv4 매핑 정리, 잘못된 줄 표시)', pr.list.join() === '203.0.113.10,198.51.100.0/24,192.0.2.5,2001:db8::/32' && pr.errors.join() === '잘못된값,10.0.0.0/99');
const mt = ATT.matcher(pr.list);
chk('IP 확인: 대역 안·밖, IPv6, 매핑 주소', mt('198.51.100.77') && !mt('198.51.101.1') && mt('2001:db8:1::5') && mt('::ffff:203.0.113.10') && !mt('203.0.113.11') && !mt('garbage'));
chk('출근·퇴근 말 알아듣기', ATT.actionOf('출근') === 'in' && ATT.actionOf('퇴근합니다') === 'out' && ATT.actionOf(' 출근했어요!') === 'in' && ATT.actionOf('출근 시간 언제야') === null);
const a = { ips: ['10.0.0.0/8'], records: [], denied: [] }, me = { key: 'u:1', name: '김대표', kind: 'web' };
const T0 = Date.parse('2026-11-23T00:05:00Z'); // 한국 09:05
chk('IP가 정해지지 않으면 안내', ATT.act({}, me, 'in', '10.1.1.1', 'web', T0).code === 'unset');
chk('사무실 밖 → 거부 + 기록', ATT.act(a, me, 'in', '8.8.8.8', 'web', T0).code === 'ip' && a.denied.length === 1 && a.records.length === 0);
chk('퇴근 먼저 → 안내', ATT.act(a, me, 'out', '10.0.0.2', 'web', T0).code === 'noin');
let r = ATT.act(a, me, 'in', '10.0.0.2', 'web', T0);
chk('출근 기록 (한국 날짜·시각)', r.ok && r.rec.date === '2026-11-23' && /09:05/.test(r.msg));
chk('같은 날 두 번 출근 → 처음 시각 유지', ATT.act(a, me, 'in', '10.0.0.2', 'web', T0 + 36e5).already && a.records.length === 1);
r = ATT.act(a, me, 'out', '10.0.0.3', 'web', T0 + 9 * 36e5);
chk('퇴근 + 머문 시간', r.ok && /9시간 0분/.test(r.msg) && ATT.view(r.rec).minutes === 540);
r = ATT.act(a, me, 'out', '10.0.0.3', 'web', T0 + 10 * 36e5);
chk('퇴근 다시 → 마지막 시각으로', r.ok && r.rec.outEdits === 1 && ATT.view(r.rec).minutes === 600);
const b = { ips: ['10.0.0.0/8'], records: [] }, nw = { key: 'u:2', name: '야간', kind: 'web' }, N0 = Date.parse('2026-11-23T13:00:00Z'); // 22:00
ATT.act(b, nw, 'in', '10.0.0.9', 'web', N0); r = ATT.act(b, nw, 'out', '10.0.0.9', 'web', N0 + 9 * 36e5); // 다음날 07:00
chk('밤샘 근무: 다음날 퇴근은 전날 기록에 붙음', r.ok && b.records.length === 1 && b.records[0].date === '2026-11-23' && ATT.view(b.records[0]).minutes === 540);
const rep = ATT.monthReport(a, '2026-11', [me, { key: 'u:9', name: '없는사람', kind: 'web' }]);
chk('월별 사람별 합계', rep.people[0].days === 1 && rep.people[0].minutes === 600 && rep.people[1].days === 0);

// --- 통합 (AI 키 없음 · 접속 IP는 127.0.0.1) ---
const queue = [], sent = []; let waiter = null, mid = 100;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = x => ({ ok: true, status: 200, json: async () => x });
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(res => { const f = () => { if (queue.length) res(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { const bb = JSON.parse(opt.body); if (bb.chat_id === 777) return ok({ ok: false, description: 'Forbidden: bot can\'t initiate conversation with a user' }); mid++; sent.push({ to: bb.chat_id, text: bb.text, nopv: bb.disable_web_page_preview }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const G = -902, gm = (from, name, text) => ({ update_id: uid++, message: { message_id: 10 + uid, chat: { id: G, type: 'group', title: '마을빵공방 업무방' }, from: { id: from, first_name: name }, text } });
// 역할이 없던 예전 데이터: 기업마다 가장 먼저 만든 계정이 대표가 됨
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ orgs: [{ id: 'oold', name: '기존기업', wallet: 0 }], users: [{ id: 'uold1', orgId: 'oold', loginId: 'olda', name: '먼저' }, { id: 'uold2', orgId: 'oold', loginId: 'oldb', name: '나중' }] }));
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: '', PORT: '3996', TELEGRAM_BOT_TOKEN: 'x', PUBLIC_URL: 'http://localhost:3996', TRUST_PROXY: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, bd, hdr = {}, form) => new Promise(res => { const q = http.request('http://localhost:3996' + p, { method: bd || form ? 'POST' : 'GET', headers: { ...(ck ? { cookie: ck } : {}), ...hdr, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, rs => { const sc = rs.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; rs.on('data', c => ch.push(c)); rs.on('end', () => { const buf = Buffer.concat(ch).toString(); let j; try { j = JSON.parse(buf); } catch (e) { j = buf; } res({ s: rs.statusCode, j }); }); }); if (bd) q.write(JSON.stringify(bd)); if (form) q.write(form); q.end(); }); }
const A = mk(), U1 = mk(), U2 = mk(), X = mk(), W = mk(), sl = ms => new Promise(res => setTimeout(res, ms));
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1', userName: '김대표' });
  await A('/api/admin/orgs', { name: '다른기업', loginId: 'other', password: 'password1' });
  let ad = (await A('/api/admin/state')).j;
  const old = ad.orgs.find(x => x.name === '기존기업');
  chk('예전 데이터: 가장 먼저 만든 계정이 대표', old.users.find(u => u.name === '먼저').role === 'owner' && old.users.find(u => u.name === '나중').role === 'member');
  const o = ad.orgs.find(x => x.name === '마을빵공방').id;
  await A(`/api/admin/orgs/${o}/users`, { loginId: 'staff', password: 'password1', userName: '이수진' });
  ad = (await A('/api/admin/state')).j;
  const ou = ad.orgs.find(x => x.id === o).users, owner = ou.find(u => u.name === '김대표'), staff = ou.find(u => u.name === '이수진');
  chk('기업을 만들 때 첫 계정 = 대표, 추가 계정 = 구성원', owner.role === 'owner' && staff.role === 'member');
  chk('마지막 대표는 해제·삭제 못 함', (await A(`/api/admin/users/${owner.id}/role`, { role: 'member' })).j.error.includes('한 명은') && (await A(`/api/admin/users/${owner.id}/delete`, {})).j.error.includes('마지막'));
  await A(`/api/admin/users/${staff.id}/role`, { role: 'owner' });
  chk('다른 계정을 대표로 정한 뒤에는 해제 가능', (await A(`/api/admin/users/${owner.id}/role`, { role: 'member' })).j.role === 'member');
  await A(`/api/admin/users/${owner.id}/role`, { role: 'owner' }); await A(`/api/admin/users/${staff.id}/role`, { role: 'member' });
  await U1('/api/login', { loginId: 'bread', password: 'password1' }); await U2('/api/login', { loginId: 'staff', password: 'password1' }); await X('/api/login', { loginId: 'other', password: 'password1' });
  let st = (await U1('/api/state')).j; const r0 = st.rooms[0].id;
  chk('출퇴근 봇은 토큰을 쓰지 않음', st.costs.attend === 0 && st.att === null);
  chk('IP 미설정 → 출근 안 됨 (대표가 정하라고 안내)', (await U1('/api/att', { action: 'in' })).j.error.includes('기업 대표가 아직'));
  chk('내 역할 표시', (await U1('/api/state')).j.me.role === 'owner' && (await U2('/api/state')).j.me.role === 'member');
  let x = await U2('/api/att?set=ips', { ips: '127.0.0.1' });
  chk('구성원은 사무실 IP를 정할 수 없음 (403)', x.s === 403 && x.j.error.includes('대표'));
  chk('대표: 잘못된 IP는 저장 거부', (await U1('/api/att?set=ips', { ips: '10.0.0.0/8\n사무실' })).j.error.includes('사무실'));
  x = await U1('/api/att?set=ips', { ips: '10.0.0.0/8', memo: '본사' });
  let ga = (await U1('/api/att')).j, gb = (await U2('/api/att')).j;
  chk('대표가 사무실 IP 저장 → 대표만 목록을 봄, 누가 정했는지 표시', x.j.ok && ga.owner && ga.ips.join() === '10.0.0.0/8' && !gb.owner && gb.ips === undefined && gb.ipCount === 1 && gb.updatedBy === '김대표 (대표)');
  chk('관리자: 잘못된 IP는 저장 거부', (await A(`/api/admin/orgs/${o}/att`, { ips: '10.0.0.0/8\n사무실' })).j.error.includes('사무실'));
  x = await U1('/api/att', { action: 'in' });
  chk('사무실 밖 IP → 403 거부 (접속 IP 안내)', x.s === 403 && x.j.error.includes('127.0.0.1'));
  x = await U1('/api/att', { action: 'in' }, { 'x-forwarded-for': '10.1.2.3' });
  chk('X-Forwarded-For를 꾸며도 통과 못 함 (프록시 설정 없을 때)', x.s === 403);
  await U1('/api/att?set=ips', { ips: '127.0.0.1\n10.0.0.0/8', memo: '본사' });
  st = (await U1('/api/state')).j;
  chk('기업 상태: 사무실 네트워크 안', st.att && st.att.configured && st.att.here === true);
  x = await U1('/api/att', { action: 'in' });
  chk('웹앱 출근 기록', x.j.ok && x.j.msg.includes('김대표님 출근'));
  chk('두 번째 출근 → 이미 기록', (await U1('/api/att', { action: 'in' })).j.already === true);
  await U1(`/api/rooms/${r0}/invite`, { botId: 'attend' });
  await U2(`/api/rooms/${r0}/messages`, { text: '퇴근', to: 'attend' });
  await U2(`/api/rooms/${r0}/messages`, { text: '출근했어요', to: 'attend' });
  await U2(`/api/rooms/${r0}/messages`, { text: '오늘 현황', to: 'attend' });
  st = (await U1('/api/state')).j;
  const bm = st.rooms[0].msgs.filter(m => m.from === 'attend').map(m => m.text).slice(1); // 첫 줄은 초대 인사
  chk('기업방 출퇴근 봇: 출근 전 퇴근 안내 → 출근 기록 → 오늘 현황 (AI 키 없이)', bm[0].includes('출근 기록이 없어') && bm[1].includes('이수진님 출근') && bm[2].includes('김대표') && bm[2].includes('이수진'));
  await U1('/api/att', { action: 'out' });
  let at = (await U1('/api/att')).j;
  chk('오늘 표·월 합계·거부 기록', at.today.find(t => t.name === '김대표').out && at.today.find(t => t.name === '이수진').in && !at.today.find(t => t.name === '이수진').out && at.report.people.find(p => p.name === '김대표').days === 1 && at.denied.length === 2 && at.denied[0].ip === '127.0.0.1');
  const csv = (await U1(`/api/att.csv?month=${at.report.month}`)).j;
  chk('CSV 내려받기', typeof csv === 'string' && csv.includes('김대표') && csv.includes('이수진') && csv.includes('127.0.0.1'));
  chk('다른 기업은 우리 출퇴근이 안 보임', (await X('/api/att')).j.today.every(t => t.name !== '김대표') && !(await X('/api/att')).j.configured);
  // 텔레그램
  const code = (await U1(`/api/rooms/${r0}/link`, {})).j.code;
  push(gm(555, '박민호', '/link ' + code)); await sl(200);
  push(gm(555, '박민호', '출근')); await sl(250);
  const dm = sent.find(s => s.to === 555 && s.text.includes('/a/'));
  chk('텔레그램 "출근" → 본인에게 1:1 확인 링크 (미리보기 끔) + 단톡 안내', dm && dm.nopv === true && sent.some(s => s.to === G && s.text.includes('1:1 대화로 출근 확인 링크')));
  const tok = dm.text.match(/\/a\/([a-f0-9]{32})/)[1];
  let pg = await W(`/a/${tok}`);
  at = (await U1('/api/att')).j;
  chk('링크를 열기만 하면 기록 안 됨 (미리보기 수집 대비)', pg.s === 200 && pg.j.includes('출근 기록하기') && !at.today.some(t => t.name === '박민호' && t.in));
  pg = await W(`/a/${tok}`, null, {}, 'go=1');
  at = (await U1('/api/att')).j;
  st = (await U1('/api/state')).j;
  chk('사무실 네트워크에서 버튼 → 텔레그램 사람으로 출근 기록 + 기업방·단톡 알림', pg.s === 200 && pg.j.includes('박민호님 출근') && at.today.find(t => t.name === '박민호' && t.kind === 'telegram').in && st.rooms[0].msgs.some(m => m.from === 'attend' && m.text.includes('박민호님 출근')) && sent.some(s => s.to === G && s.text.includes('박민호님 출근')));
  chk('쓴 링크는 다시 못 씀', (await W(`/a/${tok}`)).s === 404);
  push(gm(555, '박민호', '/out')); await sl(250);
  const tok2 = sent.filter(s => s.to === 555).pop().text.match(/\/a\/([a-f0-9]{32})/)[1];
  await A(`/api/admin/orgs/${o}/att`, { ips: '10.0.0.0/8' }); // 운영 기관도 대신 정할 수 있음
  pg = await W(`/a/${tok2}`, null, {}, 'go=1');
  chk('사무실 밖에서 연 링크 → 거부, 링크는 남아 다시 시도 가능', pg.s === 403 && pg.j.includes('사무실 네트워크가 아니라서') && (await W(`/a/${tok2}`)).s === 200);
  push(gm(777, '최지원', '출근')); await sl(250);
  chk('1:1을 연 적 없는 사람 → /start 안내', sent.some(s => s.to === G && s.text.includes('최지원님에게 1:1 메시지를 보낼 수 없어요')));
  const ex = JSON.parse((await U1('/api/kb/export')).j === undefined ? '{}' : JSON.stringify((await U1('/api/kb/export')).j));
  chk('출퇴근·거부 기록도 영구 기록·내려받기에 포함', Array.isArray(ex.attendance) && ex.attendance.some(e => e.op === 'in' && e.name === '박민호') && ex.attendance.some(e => e.op === 'denied') && ex.attendance.some(e => e.op === 'ips'));
  console.log(FAILS ? `\n${FAILS}개 실패` : '\n전부 통과');
  process.exit(FAILS ? 1 : 0);
})();

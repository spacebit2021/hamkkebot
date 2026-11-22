// 텔레그램 구성원도 사람별로 AI 사용량이 잡히고, 메시지에 답장으로 /kb 를 보내면 지식베이스에 저장됨
const path = require('path'), os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-kbtg-'));
process.env.DATA_FILE = path.join(TMP, 'data.json');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const queue = [], sent = []; let waiter = null, mid = 100;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('/v1/messages')) return ok({ stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 50 }, content: [{ type: 'text', text: '납품은 매주 화요일이에요.' }] });
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; const bb = JSON.parse(opt.body); sent.push({ to: bb.chat_id, text: bb.text }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const G = -901;
const gm = (from, name, text, reply) => ({ update_id: uid++, message: { message_id: 10 + uid, chat: { id: G, type: 'group', title: '마을빵공방 업무방' }, from: { id: from, first_name: name }, text, ...(reply ? { reply_to_message: { message_id: 1, from: { username: 'hb' }, text: reply } } : {}) } });
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3994', TELEGRAM_BOT_TOKEN: 'x' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3994' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { let j; try { j = JSON.parse(Buffer.concat(ch)); } catch (e) { j = null; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  const o = (await A('/api/admin/state')).j.orgs[0].id;
  await A(`/api/admin/orgs/${o}/charge`, { amount: 30 });
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  const r = (await U('/api/state')).j.rooms[0].id;
  const code = (await U(`/api/rooms/${r}/link`, {})).j.code;
  push(gm(1, '홍길동', '/link ' + code)); await sl(200);
  push(gm(1, '홍길동', '/ai 납품 요일 알려 줘')); await sl(250);
  push(gm(2, '김민지', '/ai 납품 요일 다시')); await sl(250);
  push(gm(2, '김민지', '/ai 하나 더')); await sl(250);
  const us = (await U('/api/usage?days=1')).j;
  const h = us.members.find(m => m.name === '홍길동'), k = us.members.find(m => m.name === '김민지');
  chk('텔레그램 사람별 AI 사용량', h && k && h.kind === 'telegram' && h.calls === 1 && h.in === 200 && k.calls === 2 && k.out === 100 && k.hb === 2);
  push(gm(2, '김민지', '/kb 납품 요일', '[업무 AI]\n납품은 매주 화요일이에요.')); await sl(250);
  const kl = (await U('/api/kb')).j;
  chk('답장 + /kb → 지식 저장 (봇 이름 머리말 제거)', kl.items.length === 1 && kl.items[0].title === '납품 요일' && kl.items[0].body === '납품은 매주 화요일이에요.' && kl.items[0].by === '김민지' && kl.items[0].source.via === 'telegram');
  chk('저장 확인 답장', sent.some(s => s.to === G && s.text.includes('지식베이스에 저장했어요: #1')));
  push(gm(2, '김민지', '/kb')); await sl(200);
  chk('답장 없이 /kb → 사용법 안내', sent.some(s => s.to === G && s.text.includes('"답장"으로 /kb')));
  console.log(FAILS ? `\n${FAILS}개 실패` : '\n전부 통과');
  process.exit(FAILS ? 1 : 0);
})();

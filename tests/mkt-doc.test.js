// 마케팅 봇이 '승인된' 기업 정보 문서만 문맥으로 쓰는지 확인 (가짜 Claude 응답, 실제 API 호출 없음)
// VERBOSE=1 node tests/mkt-doc.test.js  → 봇에게 간 기업 정보 부분을 출력
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const prompts = [], docs = [], sent = [], queue = []; let waiter = null, mid = 100, upload = '';
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('api.anthropic.com')) { prompts.push(JSON.parse(opt.body)); return ok({ content: [{ type: 'text', text: '(가짜 응답) 초안입니다' }], stop_reason: 'end_turn' }); }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendDocument')) { mid++; docs.push({ id: mid, content: await opt.body.get('document').text() }); return ok({ ok: true, result: { message_id: mid } }); }
  if (u.includes('/getFile')) return ok({ ok: true, result: { file_path: 'd/f.html', file_size: 900 } });
  if (u.includes('/file/bot')) return { ok: true, status: 200, text: async () => upload };
  if (u.includes('/sendMessage')) { mid++; sent.push(JSON.parse(opt.body).text); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = u => { queue.push(u); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1;
const M = text => ({ update_id: uid++, message: { message_id: 9000 + uid, chat: { id: 71, type: 'private' }, from: { id: 71 }, text } });
const F = (caption, replyTo) => ({ update_id: uid++, message: { message_id: 9000 + uid, chat: { id: 71, type: 'private' }, from: { id: 71 }, caption, document: { file_id: 'f', file_name: 'doc.html', mime_type: 'text/html' }, reply_to_message: { message_id: replyTo } } });
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'x', ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3988' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3988' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
const docPart = p => (p.system.match(/\[기업 정보 문서 v\d+[\s\S]*$/) || [''])[0].replace(/\n\n한국어로 답하세요[\s\S]*$/, '');
const show = (title, p) => { if (process.env.VERBOSE) console.log(`\n----- ${title}: 마케팅 봇이 받은 기업 정보 -----\n${docPart(p)}\n`); };
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  const o = (await A('/api/admin/state')).j.orgs[0].id; await A(`/api/admin/orgs/${o}/charge`, { amount: 30 });
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  await U('/api/org', { name: '마을빵공방', mission: '경력보유여성 고용, 지역 우리밀 소비 확대', product: '우리밀 통밀빵' });
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'mkt' });
  const askMkt = async q => { const n = prompts.length; await U(`/api/rooms/${r}/messages`, { text: q, to: 'mkt' }); await sl(120); return prompts[n]; };

  // 1) 기업이 웹에서 문서에 납품 계획을 적음
  let d = (await U('/api/doc')).j;
  await U('/api/doc/save', { html: d.current.html.replace('<h2>현재 과제·요청사항</h2>', '<h2>현재 과제·요청사항</h2><p>12월부터 구청 행사 단체 간식 납품 (월 약 200개), 포장은 종이 상자로 전환</p>'), basedOn: d.current.id, note: '납품 계획' });
  let p = await askMkt('구청 납품 소식으로 인스타그램 게시물 써 줘');
  show('1) 기업이 v2 저장 후', p);
  chk('1) 마케팅 봇이 기업이 저장한 v2 내용을 받음', /기업 정보 문서 v2/.test(p.system) && p.system.includes('구청 행사 단체 간식 납품'));

  // 2) 전문가가 텔레그램으로 수정안을 올림 — 승인 전
  const e = (await A('/api/admin/experts', { name: '김마케팅', field: '마케팅' })).j;
  push(M('/expert ' + e.regCode)); await sl(60); push(M('/rate 5')); await sl(60);
  await U(`/api/rooms/${r}/call`, { expertId: e.id, text: '홍보 방향 봐 주세요' }); await sl(80);
  push(M('/info')); await sl(150);
  const got = docs.pop();
  upload = got.content.replace('</body>', '<h2>홍보 메시지</h2><p>"동네 엄마들이 굽는 우리밀 빵" — 고용 미션을 앞세움</p></body>');
  push(F('홍보 메시지 추가', got.id)); await sl(150);
  p = await askMkt('보도자료 초안 써 줘');
  show('2) 전문가 수정안 대기 중', p);
  chk('2) 승인 전: 마케팅 봇은 전문가 수정안을 아직 모름 (v2 그대로)', /기업 정보 문서 v2/.test(p.system) && !p.system.includes('동네 엄마들이 굽는'));

  // 3) 기업이 수정안 승인
  d = (await U('/api/doc')).j;
  await U('/api/doc/approve', { id: d.pending[0].id }); await sl(60);
  p = await askMkt('보도자료 초안 다시 써 줘');
  show('3) 기업 승인 후', p);
  chk('3) 승인 후: 마케팅 봇이 전문가가 넣은 홍보 메시지를 받음 (v3)', /기업 정보 문서 v3/.test(p.system) && p.system.includes('동네 엄마들이 굽는'));
  chk('   전문가에게 승인 알림', sent.some(t => t.includes('승인했어요')));

  // 4) 기업이 v2로 되돌림
  d = (await U('/api/doc')).j;
  await U('/api/doc/revert', { id: d.history.find(v => v.n === 2).id }); await sl(60);
  p = await askMkt('인스타그램 게시물 하나 더');
  show('4) v2로 되돌린 후', p);
  chk('4) 되돌린 후: 마케팅 봇은 홍보 메시지 없이 v2 내용(새 v4)을 받음', /기업 정보 문서 v4/.test(p.system) && !p.system.includes('동네 엄마들이 굽는') && p.system.includes('구청 행사 단체 간식 납품'));
  chk('   마케팅 봇 역할 지시(과장 금지·[확인 필요])도 함께 감', p.system.includes('[확인 필요') && p.system.includes('과장'));
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

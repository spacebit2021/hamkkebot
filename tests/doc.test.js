// 실행: npm test  (가짜 텔레그램·Claude 응답으로 서버 흐름을 시험합니다. 실제 API는 호출하지 않습니다)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

// ----- 정리기(sanitizer) 단위 시험 -----
const DOC = require(path.join(__dirname, '..', 'doc.js'));
const bad = ['<p onclick=alert(1)>x</p>', '<script>alert(1)</script>', '<a href="javascript:alert(1)">x</a>', '<a href=" jav&#x09;ascript:x">x</a>',
  '<img src=x onerror=alert(1)>', '<svg><script>x</script></svg>', '<iframe src=//e></iframe>', '<div style="background:url(javascript:x)">d</div>', '<scr<script>ipt>alert(1)</script>'];
for (const b of bad) { const o = DOC.sanitizeHtml(b); chk('sanitize blocks: ' + b.slice(0, 40), !/script|onerror|onclick|javascript|<img|<svg|<iframe|style=/i.test(o.replace(/&lt;scr/g, ''))); }
chk('sanitize keeps safe html', DOC.sanitizeHtml('<h2>제목</h2><table><tr><td colspan="2">a</td></tr></table><a href="https://x.org">링크</a>').includes('<td colspan="2">a</td>'));
chk('sanitize extracts body of full document', DOC.sanitizeHtml(DOC.wrapDocument('t', '<p>본문</p>')) === '<p>본문</p>');

// ----- 서버 흐름 -----
const sent = [], docs = [], queue = []; let waiter = null, mid = 100, uploadContent = '', claudeCalls = [];
global.fetch = async (url, opt = {}) => {
  const u = String(url); const ok = r => ({ ok: true, status: 200, json: async () => r, text: async () => r });
  if (u.includes('api.anthropic.com')) { const b = JSON.parse(opt.body); claudeCalls.push(b); return ok({ content: [{ type: 'text', text: b.system.includes('관리하는 함께봇') ? '```html\n<h1>빵공방</h1><h2>주요 고객</h2><p>공공기관 구매 담당자</p><script>x</script>\n```' : '주요 고객은 공공기관이에요' }], stop_reason: 'end_turn' }); }
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendDocument')) { mid++; const fd = opt.body; docs.push({ to: fd.get('chat_id'), id: mid, caption: fd.get('caption'), name: fd.get('document').name, content: await fd.get('document').text() }); return ok({ ok: true, result: { message_id: mid } }); }
  if (u.includes('/getFile')) return ok({ ok: true, result: { file_path: 'documents/f.html', file_size: 1000 } });
  if (u.includes('/file/bot')) return { ok: true, status: 200, text: async () => uploadContent };
  if (u.includes('/sendMessage')) { mid++; const b = JSON.parse(opt.body); sent.push({ to: b.chat_id, id: mid, text: b.text }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = (...us) => { queue.push(...us); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const M = (chatId, fromId, text, extra = {}) => ({ update_id: uid++, message: { message_id: 7000 + uid, chat: { id: chatId, type: chatId < 0 ? 'group' : 'private', title: chatId < 0 ? '팀' : undefined }, from: { id: fromId, first_name: 'u' + fromId }, text, ...extra } });
const F = (chatId, fromId, name, caption, extra = {}, mime = /\.html?$/.test(name) ? 'text/html' : 'application/pdf') => ({ update_id: uid++, message: { message_id: 7000 + uid, chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' }, from: { id: fromId }, document: { file_id: 'F' + uid, file_name: name, mime_type: mime }, caption, ...extra } });
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'x', ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3989' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3989' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, h: res.headers }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), U2 = mk(); const sl = ms => new Promise(r => setTimeout(r, ms));
const last = id => (sent.filter(s => s.to === id).pop() || { text: '' }).text;
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '빵공방', loginId: 'bread', password: 'password1' });
  await A('/api/admin/orgs', { name: '꽃가게', loginId: 'flower', password: 'password2' });
  const o = (await A('/api/admin/state')).j.orgs.find(x => x.name === '빵공방').id; await A(`/api/admin/orgs/${o}/charge`, { amount: 50 });
  await U('/api/login', { loginId: 'bread', password: 'password1' }); await U2('/api/login', { loginId: 'flower', password: 'password2' });
  await U('/api/org', { name: '빵공방', mission: '우리밀 소비 확대', product: '통밀빵' });

  let d = (await U('/api/doc')).j;
  chk('v1 created from profile', d.current.n === 1 && d.current.html.includes('우리밀 소비 확대') && d.current.html.includes('[확인 필요]'));
  chk('other org sees its own doc only', !(await U2('/api/doc')).j.current.html.includes('우리밀'));

  // 기업이 웹에서 편집
  const s1 = await U('/api/doc/save', { html: d.current.html + '<p onclick="x">대표 연락처 010-0000-0000</p><script>alert(1)</script>', note: '연락처 추가', basedOn: d.current.id });
  d = (await U('/api/doc')).j;
  chk('save → v2, script/handler stripped', s1.j.n === 2 && s1.j.cleaned && d.current.html.includes('대표 연락처') && !/script|onclick/.test(d.current.html));
  chk('stale save rejected (409)', (await U('/api/doc/save', { html: '<p>x</p>', basedOn: d.history[1].id })).s === 409);
  chk('same content rejected', (await U('/api/doc/save', { html: d.current.html, basedOn: d.current.id })).s === 400);

  // 다운로드
  const dl = await U('/api/doc/download?id=' + d.current.id);
  chk('download is full html file', dl.h['content-disposition'].includes('attachment') && dl.j.startsWith('<!DOCTYPE html>') && dl.j.includes('대표 연락처'));

  // 되돌리기
  const v1 = d.history.find(v => v.n === 1);
  const rv = await U('/api/doc/revert', { id: v1.id });
  d = (await U('/api/doc')).j;
  chk('revert creates v3 with v1 content, history kept', rv.j.n === 3 && !d.current.html.includes('010-0000-0000') && d.history.length === 3);

  // AI 봇이 문서 내용을 문맥으로 씀
  const r = (await U('/api/state')).j.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'mkt' });
  await U(`/api/rooms/${r}/messages`, { text: '우리 고객은 공공기관 구매 담당자예요. 홍보문구 부탁해요', to: 'mkt' }); await sl(100);
  chk('bot prompt includes doc', claudeCalls.some(c => c.system.includes('[기업 정보 문서 v3')));

  // 함께봇 대화 정리안 (승인 전 반영 안 됨)
  const g = await U('/api/doc/generate', {});
  d = (await U('/api/doc')).j;
  const gp = d.pending.find(p => p.id === g.j.id);
  chk('generate → pending proposal, fences+script removed', gp && gp.by.kind === 'bot' && gp.html.startsWith('<h1>') && !/```|script/.test(gp.html) && d.current.n === 3);
  chk('second generate blocked while pending', (await U('/api/doc/generate', {})).s === 400);
  chk('other org cannot approve', (await U2('/api/doc/approve', { id: g.j.id })).s === 404);
  await U('/api/doc/reject', { id: g.j.id, reason: '아직 이름' });
  chk('reject keeps current', (await U('/api/doc')).j.current.n === 3);

  // 전문가: /info, /ask, HTML 올리기
  const e = (await A('/api/admin/experts', { name: '김세무', field: '세무' })).j;
  push(M(71, 71, '/expert ' + e.regCode)); await sl(60); push(M(71, 71, '/rate 5')); await sl(60);
  push(M(71, 71, '/info')); await sl(100);
  chk('no consult → /info refused', last(71).includes('상담 중에만') && !docs.length);
  await U(`/api/rooms/${r}/call`, { expertId: e.id, text: '세무 질문' }); await sl(80);
  push(M(71, 71, '/info')); await sl(150);
  const sentDoc = docs.pop();
  chk('/info sends html file', sentDoc && sentDoc.name === '빵공방_정보_v3.html' && sentDoc.content.includes('<!DOCTYPE html>') && sentDoc.caption.includes('v3'));
  push(M(71, 71, '/ask 이 기업의 주요 고객은?')); await sl(150);
  chk('/ask answers from doc', last(71).includes('공공기관') && claudeCalls.some(c => c.user && false || c.messages[0].content.includes('[전문가 질문]')));
  // 다른 파일 형식 거절
  push(F(71, 71, 'memo.pdf', '')); await sl(80); chk('non-html rejected', last(71).includes('HTML 파일'));
  // 고친 파일 올리기 (보낸 파일에 답장)
  uploadContent = sentDoc.content.replace('</body>', '<h2>세무 메모</h2><p>인건비 지원금 정산은 분기별</p><img src=x onerror=alert(1)></body>');
  push(F(71, 71, '빵공방_정보_v3.html', '정산 주기 추가', { reply_to_message: { message_id: sentDoc.id } })); await sl(150);
  d = (await U('/api/doc')).j;
  const ep = d.pending.find(p => p.by.kind === 'expert');
  chk('upload → pending proposal by expert, sanitized', ep && ep.by.name === '김세무' && ep.html.includes('분기별') && !/onerror|<img/.test(ep.html) && ep.note === '정산 주기 추가');
  chk('company room notified', (await U('/api/state')).j.rooms[0].msgs.some(m => m.text.includes('수정안(v')));
  chk('expert told uploaded', last(71).includes('수정안 v'));
  uploadContent = sentDoc.content; push(F(71, 71, 'same.html', '')); await sl(120);
  chk('unchanged upload refused', last(71).includes('내용이 같아요'));
  // 기업이 고쳐서 승인
  const ap = await U('/api/doc/approve', { id: ep.id, html: ep.html + '<p>기업 확인 완료</p>' }); await sl(80);
  d = (await U('/api/doc')).j;
  chk('approve with edits → current', ap.s === 200 && d.current.id === ep.id && d.current.html.includes('기업 확인 완료') && d.current.note.includes('고쳐서 승인'));
  chk('expert notified of approval', last(71).includes('승인했어요') && last(71).includes('일부 고쳐서'));
  chk('approve twice blocked', (await U('/api/doc/approve', { id: ep.id })).s === 404);
  // 상담 종료 후에는 문서 접근 불가
  await U(`/api/rooms/${r}/end`, { expertId: e.id }); await sl(60);
  push(M(71, 71, '/info')); await sl(100); chk('after consult ends → /info refused', last(71).includes('상담 중에만'));
  uploadContent = '<p>몰래 수정</p>'; push(F(71, 71, 'x.html', '')); await sl(100);
  chk('after consult ends → upload refused', !(await U('/api/doc')).j.pending.some(p => p.html.includes('몰래')));
  // 전문가 팀방에서도 /info
  await U(`/api/rooms/${r}/call`, { expertId: e.id, text: '다시' }); await sl(60);
  push(M(-500, 71, '/team')); await sl(60); push(M(-500, 71, '/rooms')); await sl(60); push(M(-500, 71, '/use 1')); await sl(80);
  push(M(-500, 71, '/info')); await sl(150);
  chk('team room /info sends file to group', docs.some(x => String(x.to) === '-500'));
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

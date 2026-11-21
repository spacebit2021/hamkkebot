// 질문 버튼 → 관리자 텔레그램 답변 단톡 → /answer → 기업에 바로 + Q&A 게시판 (가짜 텔레그램)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sent = [], queue = []; let waiter = null, mid = 500;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.endsWith('/getMe')) return ok({ ok: true, result: { username: 'hb' } });
  if (u.includes('getUpdates')) return new Promise(r => { const f = () => { if (queue.length) r(ok({ ok: true, result: queue.splice(0) })); else waiter = f; }; f(); });
  if (u.includes('/sendMessage')) { mid++; const b = JSON.parse(opt.body); sent.push({ to: b.chat_id, text: b.text, id: mid }); return ok({ ok: true, result: { message_id: mid } }); }
  return ok({ ok: true, result: {} });
};
const push = x => { queue.push(x); if (waiter) { const w = waiter; waiter = null; w(); } };
let uid = 1; const G = -700, X = -701;
const gm = (chat, from, name, text, replyTo) => ({ update_id: uid++, message: { message_id: 50 + uid, chat: { id: chat, type: 'group', title: chat === G ? '함께봇 관리자 답변방' : '아무 그룹' }, from: { id: from, first_name: name }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3996', TELEGRAM_BOT_TOKEN: 'x' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3996' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
const toG = () => sent.filter(s => s.to === G);
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  await Ad('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  await Ad('/api/admin/orgs', { name: '꽃가게', loginId: 'flower', password: 'password1' });
  const A = mk(), B = mk(); await A('/api/login', { loginId: 'bread', password: 'password1' }); await B('/api/login', { loginId: 'flower', password: 'password1' });

  // 연결 전: 웹 게시판으로만
  const q0 = await A('/api/ask', { text: '텔레그램 연결 전에 묻는 질문이에요' });
  chk('답변 방 연결 전에도 질문은 저장 (텔레그램 전송 없음)', q0.s === 200 && q0.j.sent === false && !(await A('/api/ask')).j.live);
  // 관리자 답변 방 연결
  push(gm(G, 9, '김운영', '/adminlink WRONG')); await sl(100);
  chk('틀린 코드 거절', toG().pop().text.includes('코드가 맞지 않거나'));
  const code = (await Ad('/api/admin/tg-admin/code', {})).j.code;
  push(gm(G, 9, '김운영', '/adminlink ' + code)); await sl(150);
  chk('관리자 답변 방 연결', toG().pop().text.includes('관리자 답변 방으로 연결') && (await Ad('/api/admin/state')).j.adminTg.title === '함께봇 관리자 답변방');
  push(gm(X, 9, '누군가', '/adminlink ' + code)); await sl(100);
  chk('한 번 쓴 코드는 다시 못 씀', sent.filter(s => s.to === X).pop().text.includes('코드가 맞지 않거나'));

  // 질문 → 텔레그램
  const q1 = await A('/api/ask', { text: '토큰은 어떻게 충전하나요?\n이번 달 행사가 있어요.' });
  const tq = toG().pop();
  chk('질문이 관리자 텔레그램으로 바로', q1.j.sent && tq.text.includes(`질문 #${q1.j.n}`) && tq.text.includes('마을빵공방') && tq.text.includes('토큰은 어떻게 충전하나요'));
  chk('질문 버튼 질문이 Q&A 게시판에 비밀글로', (await A('/api/board?board=qna')).j.posts.some(p => p.id === q1.j.id && p.secret && !p.answered) && !(await B('/api/board?board=qna')).j.posts.length);
  // 답장으로 /answer
  push(gm(G, 10, '이답변', '/answer 관리자에게 충전을 요청하시면 당일 처리돼요. 행사 전이면 미리 알려 주세요.', tq.id)); await sl(150);
  let my = (await A('/api/ask')).j.items.find(x => x.id === q1.j.id);
  chk('답장 /answer → 기업 질문 창에 바로 답', my.answers.length === 1 && my.answers[0].body.includes('당일 처리'));
  chk('기업방 알림 + 게시판 배지', (await A('/api/state')).j.rooms[0].msgs.some(m => m.text.includes(`질문 #${q1.j.n}`) && m.text.includes('당일 처리')) && (await A('/api/state')).j.boardUnread === 1);
  const post = (await A('/api/board/post?id=' + q1.j.id)).j;
  chk('Q&A 게시판에 답변 등록 (운영 기관 이름)', post.replyList[0].admin && post.replyList[0].orgName === '운영 기관' && (await A('/api/board?board=qna')).j.posts.find(p => p.id === q1.j.id).answered);
  chk('답변 방에 확인 메시지 (답한 사람)', toG().pop().text.includes(`#${q1.j.n} 마을빵공방에 답변을 보냈어요`) && toG().pop().text.includes('이답변'));
  // 번호로 /answer
  const q2 = await B('/api/ask', { text: '사람 전문가는 어떻게 불러요?', secret: false });
  push(gm(G, 9, '김운영', `/answer ${q2.j.n} 채팅방 위 "전문가 초대"에서 사람 전문가를 고르시면 돼요.`)); await sl(150);
  chk('번호로 /answer', (await B('/api/ask')).j.items[0].answers[0].body.includes('전문가 초대'));
  chk('공개로 보낸 질문은 공개 Q&A로 (다른 기업도 봄)', (await A('/api/board?board=qna')).j.posts.some(p => p.id === q2.j.id && !p.secret && p.answered));
  // /questions, 잘못된 /answer
  const q3 = await A('/api/ask', { text: '세 번째 질문' });
  push(gm(G, 9, '김운영', '/questions')); await sl(120);
  chk('/questions: 답을 기다리는 질문만', toG().pop().text.includes(`#${q3.j.n}`) && !toG().pop().text.includes(`#${q1.j.n} `));
  push(gm(G, 9, '김운영', '/answer 번호 없이 보냄')); await sl(120);
  chk('어느 질문인지 모르면 안내', toG().pop().text.includes('어느 질문인지 모르겠어요'));
  // 다른 그룹에서 /answer는 무시
  push(gm(X, 9, '남', `/answer ${q3.j.n} 가짜 답변`)); await sl(120);
  chk('연결 안 된 그룹의 /answer는 무시', !(await A('/api/ask')).j.items.find(x => x.id === q3.j.id).answers.length);
  // 관리자 웹에서 답해도 같은 곳에 + 텔레그램에 알림
  await Ad(`/api/admin/board/${q3.j.id}/reply`, { body: '웹에서 답했어요' });
  chk('관리자 웹 답변도 질문 창에, 답변 방에 알림', (await A('/api/ask')).j.items.find(x => x.id === q3.j.id).answers[0].body === '웹에서 답했어요' && toG().pop().text.includes(`#${q3.j.n}에 관리자 웹에서 답변`));
  chk('빈 질문 거절', (await A('/api/ask', { text: ' ' })).s === 400);
  chk('다른 기업 질문은 내 질문 창에 없음', !(await A('/api/ask')).j.items.some(x => x.id === q2.j.id));
  await Ad('/api/admin/tg-admin/unlink', {});
  chk('연결 해제', !(await Ad('/api/admin/state')).j.adminTg);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

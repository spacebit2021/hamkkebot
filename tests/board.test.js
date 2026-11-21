// 게시판: Q&A 비밀글(쓴 기업·운영 기관만) · 공개 Q&A · 봇 추천(써 본 봇만, 우리 봇 금지, 별점·공감) · 관리자 답변·숨김·공지 (가짜 Claude)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
global.fetch = async (url) => String(url).includes('/v1/messages') ? { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '답변입니다' }] }) } : { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3989', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3989' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  const Ad = mk(); await Ad('/api/admin/login', { password: 'adminpass' });
  const U = {}, room = {};
  for (const [n, id] of [['마을빵공방', 'A'], ['꽃가게', 'B'], ['책방', 'C']]) { await Ad('/api/admin/orgs', { name: n, loginId: 'org' + id, password: 'password1' }); U[id] = mk(); }
  for (const o of (await Ad('/api/admin/state')).j.orgs) await Ad(`/api/admin/orgs/${o.id}/charge`, { amount: 50 });
  for (const k in U) { await U[k]('/api/login', { loginId: 'org' + k, password: 'password1' }); room[k] = (await U[k]('/api/state')).j.rooms[0].id; }
  const list = async (k, b) => (await U[k]('/api/board?board=' + b)).j;
  const msgs = async k => (await U[k]('/api/state')).j.rooms[0].msgs;

  // Q&A 비밀글
  const q1 = await U.A('/api/board/post', { board: 'qna', title: '인건비 지원금 정산 문의', body: '우리 기업 올해 지원금 4,200만 원인데 정산 서류를 함께봇으로 만들 수 있나요?' });
  chk('Q&A는 기본 비밀글', q1.s === 200 && (await list('A', 'qna')).posts[0].secret === true);
  chk('비밀글: 다른 기업 목록에 안 보임', (await list('B', 'qna')).posts.length === 0);
  chk('비밀글: 다른 기업이 주소로 열어도 안 됨', (await U.B('/api/board/post?id=' + q1.j.id)).s === 404 && (await U.B('/api/board/reply', { id: q1.j.id, body: '저도 궁금해요' })).s === 404);
  chk('관리자는 비밀글을 봄', (await Ad('/api/admin/state')).j.posts.some(p => p.id === q1.j.id && p.secret && p.body.includes('4,200만')));
  await Ad(`/api/admin/board/${q1.j.id}/reply`, { body: '네, 회계·세무 도우미 봇이 준비되면 바로 쓸 수 있어요. 지금은 마케팅 봇으로 서류 목록을 정리해 보세요.' });
  let st = (await U.A('/api/state')).j;
  chk('답변 → 기업방 알림 + 게시판 배지', st.boardUnread === 1 && st.rooms[0].msgs.some(m => m.text.includes('비밀글 질문 "인건비 지원금 정산 문의"에 답했어요')));
  const v = (await U.A('/api/board/post?id=' + q1.j.id)).j;
  chk('답변이 운영 기관 이름으로', v.replyList[0].admin && v.replyList[0].orgName === '운영 기관' && (await list('A', 'qna')).posts[0].answered);
  chk('글을 열면 배지 사라짐', (await U.A('/api/state')).j.boardUnread === 0);
  chk('쓴 기업은 이어서 질문 가능', (await U.A('/api/board/reply', { id: q1.j.id, body: '감사합니다. 언제쯤 나오나요?' })).s === 200);
  // 공개 Q&A
  const q2 = await U.B('/api/board/post', { board: 'qna', title: '텔레그램 연결이 안 돼요', body: '/link 코드를 보내도 답이 없어요.', secret: false });
  chk('공개 Q&A는 다른 기업도 보고 댓글 가능', (await list('C', 'qna')).posts.some(p => p.id === q2.j.id) && (await U.C('/api/board/reply', { id: q2.j.id, body: '봇을 그룹에 먼저 초대해야 돼요.' })).s === 200);
  chk('댓글 → 쓴 기업 알림', (await msgs('B')).some(m => m.text.includes('책방이(가) 댓글을 달았어요')));
  chk('빈 제목·짧은 내용 거절', (await U.A('/api/board/post', { board: 'qna', title: '', body: '내용입니다' })).s === 400 && (await U.A('/api/board/post', { board: 'qna', title: '제목', body: '짧' })).s === 400);
  chk('남의 글은 못 지움', (await U.C('/api/board/delete', { id: q2.j.id })).s === 403);

  // 봇 추천
  chk('안 써 본 봇은 추천 못 함', (await U.B('/api/board/post', { board: 'rec', title: '좋아요', body: '마케팅 봇 좋아요', botId: 'mkt', rating: 5 })).j.error.includes('써 본 봇'));
  chk('추천할 봇 목록 비어 있음', (await list('B', 'rec')).recommendable.length === 0);
  await U.B(`/api/rooms/${room.B}/invite`, { botId: 'mkt' }); await U.B(`/api/rooms/${room.B}/messages`, { text: '인스타 글 써 줘', to: 'mkt' }); await sl(150);
  chk('써 보면 추천할 봇 목록에', (await list('B', 'rec')).recommendable.some(b => b.id === 'mkt'));
  chk('별점은 1~5', (await U.B('/api/board/post', { board: 'rec', title: '좋아요', body: '마케팅 봇 좋아요', botId: 'mkt', rating: 7 })).s === 400);
  const r1 = await U.B('/api/board/post', { board: 'rec', title: '인스타 글이 10분이면 나와요', body: '꽃 사진 설명만 주면 해시태그까지 써 줘요. 가끔 길어서 줄여 달라고 해요.', botId: 'mkt', rating: 4 });
  chk('추천 글 올림', r1.s === 200);
  chk('같은 봇 두 번 추천 막음', (await U.B('/api/board/post', { board: 'rec', title: '또', body: '또 추천해요', botId: 'mkt', rating: 5 })).s === 400);
  // 우리 봇 추천 금지
  const d = { hamkkebot: 1, name: '꽃 봇', short: '꽃', color: '#2D6A4F', tag: '꽃', desc: '꽃 설명', hello: '안녕', quick: [], kind: 'chat', role: '당신은 꽃가게 전용 꽃다발 추천 도우미입니다. 예산과 계절을 물어 보세요.' };
  const s1 = await U.B('/api/bots/submit', { def: d, roomId: room.B }); const card = (await msgs('B')).filter(m => m.botReq).pop(); await U.B('/api/bots/review', { botId: s1.j.id, msgId: card.id, approve: true });
  await U.B(`/api/rooms/${room.B}/invite`, { botId: s1.j.id }); await U.B(`/api/rooms/${room.B}/messages`, { text: '추천', to: s1.j.id }); await sl(150);
  chk('우리 기업이 만든 봇은 추천 목록에 없고 추천 못 함', !(await list('B', 'rec')).recommendable.some(b => b.id === s1.j.id) && (await U.B('/api/board/post', { board: 'rec', title: '우리 봇 최고', body: '우리 봇 써 보세요', botId: s1.j.id, rating: 5 })).j.error.includes('우리 기업이 만든'));
  // 아이디어 글은 봇 없이
  chk('"이런 봇이 있었으면" 글은 봇 없이', (await U.C('/api/board/post', { board: 'rec', kind: 'idea', title: '지원사업 공고 알림 봇', body: '관심 분야 공고가 뜨면 알려 주면 좋겠어요' })).s === 200);
  // 공감·별점 집계
  chk('자기 글엔 공감 못 함', (await U.B('/api/board/like', { id: r1.j.id })).s === 400);
  await U.A('/api/board/like', { id: r1.j.id }); await U.C('/api/board/like', { id: r1.j.id });
  const lk = await U.C('/api/board/like', { id: r1.j.id });
  chk('공감 누르고 취소', lk.j.likes === 1 && lk.j.liked === false);
  const mkt = (await U.A('/api/state')).j.bots.find(b => b.id === 'mkt');
  chk('봇 목록에 별점·추천 수 표시', mkt.rec && mkt.rec.avg === 4 && mkt.rec.n === 1 && mkt.rec.likes === 1);
  chk('다른 기업도 추천 글과 댓글', (await list('A', 'rec')).posts.length === 2 && (await U.A('/api/board/reply', { id: r1.j.id, body: '저희도 써 볼게요' })).s === 200);
  // 관리자 숨김·공지·삭제
  await Ad(`/api/admin/board/${r1.j.id}/hide`, { hidden: true, reason: '광고성 내용 확인 중' });
  chk('숨긴 글: 다른 기업엔 안 보이고, 별점 집계에서 빠짐', !(await list('A', 'rec')).posts.some(p => p.id === r1.j.id) && !(await U.A('/api/state')).j.bots.find(b => b.id === 'mkt').rec);
  const own = (await list('B', 'rec')).posts.find(p => p.id === r1.j.id);
  chk('숨긴 글: 쓴 기업엔 숨김 표시와 이유', own && own.hidden && own.hideReason === '광고성 내용 확인 중' && (await msgs('B')).some(m => m.text.includes('숨겼어요: 광고성')));
  chk('숨긴 글엔 댓글 못 함', (await U.B('/api/board/reply', { id: r1.j.id, body: '왜요?' })).s === 403);
  await Ad(`/api/admin/board/${r1.j.id}/hide`, { hidden: false });
  await Ad(`/api/admin/board/${q2.j.id}/pin`, { pinned: true });
  await U.C('/api/board/post', { board: 'qna', title: '새 질문', body: '공개 질문입니다', secret: false });
  chk('공지로 고정한 글이 맨 위', (await list('A', 'qna')).posts[0].id === q2.j.id && (await list('A', 'qna')).posts[0].pinned);
  await Ad(`/api/admin/board/${q2.j.id}/delete`, {});
  chk('관리자 삭제', !(await list('C', 'qna')).posts.some(p => p.id === q2.j.id));
  chk('글 내용의 HTML은 글자 그대로 저장', (await U.A('/api/board/post', { board: 'qna', title: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' })).s === 200 && (await list('A', 'qna')).posts.some(p => p.title === '<img src=x onerror=alert(1)>'));
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

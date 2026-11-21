// 홈페이지 봇·봇 토큰 사용량·랜딩페이지 게시와 등록 확인 (가짜 Claude 응답, 실제 API 호출 없음)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const DOC = require(path.join(__dirname, '..', 'doc.js'));
// 정리기 단위 시험
const evil = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil"><title>t</title><link rel="stylesheet" href="https://evil.com/x.css"><style>@import url(https://evil.com/a.css);a>b{background:url(https://evil.com/x)}</style></head><body onload="x()"><a href="javascript:x">a</a><img src="https://evil.com/p.png"><form action="https://evil"><input></form><svg onload=x></svg><base href="https://evil"><script>x()</script><p>ok</p></body></html>';
const clean = DOC.sanitizePage(evil);
chk('page sanitizer removes scripts/handlers/external resources', !/evil|script|onload|javascript|http-equiv|@import|<form|<input|<svg|<base|<img/i.test(clean) && clean.includes('a>b{background:none}') && clean.includes('<p>ok</p>'));
chk('page sanitizer rejects non-documents', DOC.sanitizePage('<p>그냥 조각</p>') === '');

let claudeFail = false; const prompts = [];
const PAGE = n => `<!DOCTYPE html><html lang="ko"><head><title>마을빵공방 v${n}</title><meta name="description" content="우리밀 빵"><style>body{font-size:17px}.hero>h1{color:#123}</style></head><body><header class="hero"><h1>마을빵공방</h1><p>경력보유여성이 굽는 우리밀 빵</p><a href="#buy">단체 주문</a></header><img src="https://evil.com/x.png" onerror="alert(1)"><button onclick="alert(1)">x</button><script>document.title='HACKED'</script><section id="buy"><h2>함께하는 방법</h2></section></body></html>\n---메모---\n연락처가 없어 문의 섹션에 전화번호를 넣지 않았어요.`;
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.includes('api.anthropic.com')) {
    const b = JSON.parse(opt.body); prompts.push(b);
    if (claudeFail) return { ok: false, status: 500, json: async () => ({ error: 'x' }) };
    const isSite = b.system.includes('웹 디자이너 겸 카피라이터');
    return ok({ content: [{ type: 'text', text: isSite ? PAGE(prompts.filter(p => p.system.includes('웹 디자이너')).length) : b.system.includes('관리하는 함께봇') ? '<h1>정리</h1>' : '마케팅 초안' }], stop_reason: 'end_turn' });
  }
  return ok({ ok: false });
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3987', TELEGRAM_BOT_TOKEN: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3987' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch (e) { j = d; } r({ s: res.statusCode, j, h: res.headers }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), U2 = mk(), X = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  await A('/api/admin/orgs', { name: '꽃가게', loginId: 'flower', password: 'password2' });
  const orgs = (await A('/api/admin/state')).j.orgs, o1 = orgs.find(o => o.name === '마을빵공방').id, o2 = orgs.find(o => o.name === '꽃가게').id;
  await U('/api/login', { loginId: 'bread', password: 'password1' }); await U2('/api/login', { loginId: 'flower', password: 'password2' });
  await U('/api/org', { name: '마을빵공방', mission: '경력보유여성 고용', product: '우리밀 빵' });
  let st = (await U('/api/state')).j; const r = st.rooms[0].id;
  chk('default costs: 마케팅 1, 홈페이지 5, 문서 정리 1', st.costs.mkt === 1 && st.costs.site === 5 && st.costs.summary === 1 && st.bots.find(b => b.id === 'site').cost === 5);
  await U(`/api/rooms/${r}/invite`, { botId: 'site' });
  const ask = async (q, to = 'site') => { await U(`/api/rooms/${r}/messages`, { text: q, to }); await sl(150); return (await U('/api/state')).j; };

  await A(`/api/admin/orgs/${o1}/charge`, { amount: 3 });
  st = await ask('기업 정보 문서로 랜딩페이지 만들기');
  chk('잔액 부족(3<5) → 요청 안 함, 차감 없음', st.wallet === 3 && st.rooms[0].msgs.some(m => m.from === 'sys' && m.text.includes('잔액(3토큰)이 부족')) && !prompts.length);

  await A(`/api/admin/orgs/${o1}/charge`, { amount: 17 }); // 20
  st = await ask('기업 정보 문서로 랜딩페이지 만들기');
  const m1 = st.rooms[0].msgs.filter(m => m.from === 'site').pop();
  chk('랜딩페이지 v1 생성, 5토큰 차감', st.wallet === 15 && m1.site && m1.site.n === 1 && m1.cost === 5);
  chk('봇이 기업 정보 문서를 바탕으로 만듦', prompts[0].system.includes('[기업 정보 문서 v'));
  chk('메모(확인할 것)가 답에 포함', m1.text.includes('연락처가 없어'));
  const pv = await U('/api/site/preview?id=' + m1.site.versionId);
  chk('미리보기: 스크립트·외부 이미지·이벤트 제거 + CSP sandbox', pv.s === 200 && !/<script|HACKED|evil|onerror|onclick|<button/i.test(pv.j) && pv.j.includes('.hero>h1') && /sandbox/.test(pv.h['content-security-policy']) && /default-src 'none'/.test(pv.h['content-security-policy']));
  chk('미리보기는 로그인 필요 / 다른 기업은 못 봄', (await X('/api/site/preview?id=' + m1.site.versionId)).s === 401 && (await U2('/api/site/preview?id=' + m1.site.versionId)).s === 404);

  st = await ask('더 따뜻한 색감으로 바꿔 줘');
  const m2 = st.rooms[0].msgs.filter(m => m.from === 'site').pop();
  chk('수정 요청 → 이전 페이지를 바탕으로 v2, 5토큰 더', st.wallet === 10 && m2.site.n === 2 && prompts[prompts.length - 1].messages[0].content.includes('지금까지 만든 페이지 v1'));

  claudeFail = true; st = await ask('단체 주문 섹션 추가'); claudeFail = false;
  chk('AI 실패 → 토큰 돌려줌', st.wallet === 10 && st.rooms[0].msgs.filter(m => m.from === 'site').pop().text.includes('토큰은 쓰지 않았어요'));

  // 게시 + 등록 확인
  chk('잘못된 주소 거절', (await U('/api/site/publish', { versionId: m1.site.versionId, slug: 'A b', roomId: r })).s === 400);
  chk('예약된 주소 거절', (await U('/api/site/publish', { versionId: m1.site.versionId, slug: 'admin', roomId: r })).s === 400);
  const pub = await U('/api/site/publish', { versionId: m1.site.versionId, slug: 'maeul-bread', roomId: r });
  chk('게시 + 등록 확인 성공 (자기 접속 200, 제목 일치, 보안 헤더, 스크립트 없음)', pub.s === 200 && pub.j.ok && pub.j.check.status === 200 && pub.j.check.title === '마을빵공방 v1' && pub.j.check.csp && pub.j.check.noScript);
  st = (await U('/api/state')).j;
  chk('채팅방에 게시 주소와 등록 확인 결과 안내', st.rooms[0].msgs.some(m => m.text.includes('/s/maeul-bread') && m.text.includes('등록 확인')) && st.site.published && st.site.n === 1);
  const pubPage = await X('/s/maeul-bread');
  chk('공개 주소: 로그인 없이 열림, sandbox, 스크립트 없음', pubPage.s === 200 && pubPage.j.includes('<title>마을빵공방 v1</title>') && !/<script/i.test(pubPage.j) && /sandbox/.test(pubPage.h['content-security-policy']));
  // 다른 기업이 페이지를 만든 뒤 같은 주소 시도
  await A(`/api/admin/orgs/${o2}/charge`, { amount: 10 });
  const r2 = (await U2('/api/state')).j.rooms[0].id; await U2(`/api/rooms/${r2}/invite`, { botId: 'site' });
  await U2(`/api/rooms/${r2}/messages`, { text: '랜딩페이지 만들어 줘', to: 'site' }); await sl(150);
  const f1 = (await U2('/api/state')).j.rooms[0].msgs.filter(m => m.from === 'site').pop();
  chk('다른 기업이 이미 쓰는 주소 → 거절', (await U2('/api/site/publish', { versionId: f1.site.versionId, slug: 'maeul-bread' })).j.error === '다른 기업이 이미 쓰는 주소예요');
  await U('/api/site/publish', { versionId: m2.site.versionId, roomId: r });
  chk('v2로 다시 게시 → 공개 주소가 v2', (await X('/s/maeul-bread')).j.includes('마을빵공방 v2'));
  chk('HTML 내려받기', (await U('/api/site/download?id=' + m2.site.versionId)).h['content-disposition'].includes('attachment'));

  // 관리자: 사용량 설정
  chk('음수 사용량 거절', (await A('/api/admin/costs', { costs: { site: -1 } })).s === 400);
  await A('/api/admin/costs', { costs: { site: 0, mkt: 2 } });
  const before = (await U('/api/state')).j.wallet;
  st = await ask('글자 크게');
  chk('홈페이지 봇 0토큰으로 바꾸면 무료', st.wallet === before && st.costs.site === 0);
  await U(`/api/rooms/${r}/invite`, { botId: 'mkt' });
  st = await ask('인스타그램 글', 'mkt');
  chk('마케팅 봇 2토큰으로 바꾸면 2 차감', st.wallet === before - 2);
  const led = (await A('/api/admin/state')).j.ledger.filter(l => l.type === 'bot' && l.orgId === o1);
  chk('거래 기록에 봇 사용 (봇 이름·방)', led.length === 3 && led.some(l => l.botName === '홈페이지 봇' && l.amount === 5) && led.some(l => l.botName === '마케팅 매니저 봇' && l.amount === 2));
  // 문서 정리도 토큰 사용
  const g = await U('/api/doc/generate', {});
  chk('함께봇 문서 정리 1토큰', g.j.cost === 1 && (await U('/api/state')).j.wallet === before - 3);

  // 게시 중단
  chk('관리자 페이지에 게시 주소 보임', (await A('/api/admin/state')).j.orgs.find(o => o.id === o1).site.slug === 'maeul-bread');
  await A(`/api/admin/orgs/${o1}/unpublish`, {});
  chk('관리자 게시 중단 → 공개 주소 404', (await X('/s/maeul-bread')).s === 404);
  await U('/api/site/publish', { versionId: m2.site.versionId, roomId: r });
  await U('/api/site/unpublish', {});
  chk('기업 게시 중단 → 404', (await X('/s/maeul-bread')).s === 404);
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

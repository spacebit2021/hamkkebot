// 웹 검색 브릿지: 로컬 LLM(검색 도구 없음)이 서버가 대신 검색한 결과로 VC를 찾음 — Claude API 호출 없이 (가짜 SearXNG·추론 서버)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const SB = require(path.join(__dirname, '..', 'search.js'));

(async () => {
  // --- 단위 ---
  chk('기본은 브릿지 끔(Claude 검색)', !SB.create({}).enabled && SB.create({}).info().engine === 'claude');
  chk('searxng 주소 없으면 미설정', SB.create({ SEARCH_ENGINE: 'searxng' }).info().missing === 'SEARCH_BASE_URL');
  chk('brave 키 없으면 미설정', SB.create({ SEARCH_ENGINE: 'brave' }).info().missing === 'SEARCH_API_KEY');
  chk('사설·내부 IP 판별', SB.privateIp('10.1.2.3') && SB.privateIp('192.168.0.1') && SB.privateIp('127.0.0.1') && SB.privateIp('169.254.169.254') && SB.privateIp('::1') && SB.privateIp('::ffff:10.0.0.1') && !SB.privateIp('8.8.8.8'));
  chk('HTML → 글자 (스크립트 제거)', SB.htmlToText('<p>투자&amp;지원</p><script>x()</script><b>시드</b>') === '투자&지원\n 시드');
  const lookup = async h => h === 'inside.example.kr' ? [{ address: '10.0.0.5' }] : [{ address: '203.0.113.7' }];
  let fetched = [];
  const fakeFetch = async (u) => { fetched.push(u); const H = o => ({ get: k => o[k] });
    if (u.startsWith('https://jump.example.kr')) return { status: 302, ok: false, headers: H({ location: 'http://inside.example.kr/admin' }) };
    return { status: 200, ok: true, headers: H({ 'content-type': 'text/html; charset=utf-8' }), text: async () => '<html><nav>메뉴</nav><h1>임팩트벤처스</h1><p>소셜벤처 시드 투자</p></html>' }; };
  const s1 = SB.create({ SEARCH_ENGINE: 'searxng', SEARCH_BASE_URL: 'http://searx' }, { lookup, fetch: fakeFetch });
  chk('공개 페이지 본문 가져옴 (메뉴 제거)', (await s1._pageText('https://vc.example.kr/about')).includes('소셜벤처 시드 투자') && !(await s1._pageText('https://vc.example.kr/about')).includes('메뉴'));
  fetched = [];
  chk('내부망 주소는 접속 안 함', (await s1._pageText('http://inside.example.kr/')) === '' && (await s1._pageText('http://127.0.0.1/')) === '' && (await s1._pageText('http://localhost/')) === '' && fetched.length === 0);
  chk('리다이렉트로 내부망 가는 것도 차단', (await s1._pageText('https://jump.example.kr/')) === '' && fetched.length === 1);
  chk('http(s) 외 주소 차단', (await s1._pageText('file:///etc/passwd')) === '');

  let bh = null;
  const s2 = SB.create({ SEARCH_ENGINE: 'brave', SEARCH_API_KEY: 'bk', SEARCH_FETCH_PAGES: '0' }, { fetch: async (u, o) => { bh = { u, k: o.headers['x-subscription-token'] }; return { ok: true, status: 200, json: async () => ({ web: { results: [{ url: 'https://vc-d.example.kr/', title: 'D', description: '<strong>임팩트</strong> 투자' }] } }) }; } });
  const gen = async (sys, usr) => sys.includes('검색어를 정하는') ? { text: '{"queries":["임팩트 투자"]}' } : { text: usr.includes('https://vc-d.example.kr/') && usr.includes('요약: 임팩트 투자') ? 'OK' : 'NO' };
  const br = await s2.search(gen, '임무', '요청');
  chk('Brave: 키 헤더·한국 지역·결과 정리', bh.k === 'bk' && bh.u.includes('country=KR') && br.text === 'OK' && br.urls.has('https://vc-d.example.kr/'));
  // --- 통합: 로컬 LLM + SearXNG, Claude API 키 없음 ---
  const outline = { title: '마을빵공방 IR', palette: 'navy', checks: [], slides: [
    { kind: 'title', title: '마을빵공방 투자 제안', subtitle: '우리밀 간식', note: 'n' },
    { kind: 'message', title: '한 줄 요약', message: '우리밀 단체 간식', note: 'n' },
    { kind: 'closing', title: '함께해 주세요', message: '투자 문의', note: 'n' }] };
  const calls = { local: [], claude: 0, searx: [], searxDown: false };
  global.fetch = async (url, opt = {}) => {
    const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
    if (u.startsWith('http://searx.local:8080/search')) {
      const q = decodeURIComponent(u.match(/q=([^&]*)/)[1]); calls.searx.push(q);
      if (calls.searxDown) return { ok: false, status: 502, json: async () => ({}) };
      return ok({ results: q.includes('임팩트')
        ? [{ url: 'https://impact-a.example.kr/', title: '임팩트벤처스A', content: '소셜벤처 시드 투자' }, { url: 'https://impact-b.example.kr/portfolio', title: '임팩트파트너스B', content: '먹거리·지역 임팩트' }]
        : [{ url: 'https://impact-a.example.kr/', title: '중복', content: '' }, { url: 'https://acc-c.example.kr/', title: '액셀러레이터C', content: '사회적기업 육성' }] });
    }
    if (u.startsWith('http://gpu.local:8000/v1/chat/completions')) {
      const b = JSON.parse(opt.body), sys = b.messages[0].content, usr = b.messages[1].content; calls.local.push({ sys, usr });
      if (sys.includes('검색어를 정하는')) return ok({ choices: [{ finish_reason: 'stop', message: { content: '<think>…</think>{"queries":["임팩트 투자 VC 한국","소셜벤처 시드 액셀러레이터","임팩트 투자 VC 한국"]}' } }] });
      if (sys.includes('[검색 결과 사용 규칙]')) return ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ vcs: [
        { name: '임팩트벤처스A', focus: '소셜벤처', stage: '시드', why: '우리밀 먹거리', source: 'https://impact-a.example.kr/' },
        { name: '액셀러레이터C', focus: '사회적기업 육성', stage: '', why: '초기 지원', source: 'https://acc-c.example.kr/' },
        { name: '지어낸투자사', focus: '?', stage: '', why: '?', source: 'https://made-up.example.kr/' }], note: '홈페이지에서 확인' }) } }] });
      if (sys.includes('[IR 자료 만들기]')) return ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(outline) } }] });
      return ok({ choices: [{ finish_reason: 'stop', message: { content: '로컬 답변' } }] });
    }
    if (u.includes('/v1/messages')) { calls.claude++; return ok({ content: [] }); }
    return ok({ ok: true, result: {} });
  };
  Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: '', PORT: '3992', TELEGRAM_BOT_TOKEN: '',
    LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://gpu.local:8000', LLM_MODEL: 'local-model-a',
    SEARCH_ENGINE: 'searxng', SEARCH_BASE_URL: 'http://searx.local:8080/', SEARCH_FETCH_PAGES: '0' });
  require(path.join(__dirname, '..', 'server.js'));
  const http = require('http');
  function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3992' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j; try { j = JSON.parse(buf); } catch (e) { j = buf; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
  const A = mk(), U = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  const ad = (await A('/api/admin/state')).j;
  chk('관리자 화면: 검색 = SearXNG 브릿지, 사용 가능', ad.ai.search === true && ad.ai.searchVia.engine === 'searxng' && ad.ai.searchVia.label.includes('SearXNG'));
  await A(`/api/admin/orgs/${ad.orgs[0].id}/charge`, { amount: 40 });
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  let st = (await U('/api/state')).j;
  const r = st.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'ir' });
  const ask = async q => { await U(`/api/rooms/${r}/messages`, { text: q, to: 'ir' }); await sl(300); return (await U('/api/state')).j; };
  await ask('IR 자료 초안 만들기');
  const w0 = (await U('/api/state')).j.wallet;
  st = await ask('우리에게 맞는 VC 찾기');
  const ir = (await U('/api/ir')).j;
  const v = ir.vcs && ir.vcs[0];
  chk('검색어는 로컬 모델이 정하고 중복 제거', calls.searx.length === 2 && calls.searx[0] === '임팩트 투자 VC 한국');
  const fin = calls.local.find(x => x.sys.includes('[검색 결과 사용 규칙]'));
  chk('검색 결과 묶음(중복 URL 1번만)이 로컬 모델에 전달', fin && fin.usr.includes('https://impact-b.example.kr/portfolio') && fin.usr.split('https://impact-a.example.kr/').length === 2);
  chk('출처가 검색 결과에 있는 2곳만, 지어낸 1곳 제외', v && v.items.length === 2 && v.dropped === 1 && !v.items.some(x => x.name === '지어낸투자사'));
  chk('검색된 주소 수 기록', v && v.searched === 3);
  chk('VC 토큰 차감', st.wallet === w0 - st.costs.ir_vc);
  chk('Claude API 호출 0회 (생성·검색 모두 로컬)', calls.claude === 0);
  calls.searxDown = true;
  const w1 = st.wallet;
  st = await ask('VC 다시 찾기');
  chk('검색 엔진 장애 → 안내 + 토큰 환불', st.wallet === w1 && st.rooms[0].msgs.slice(-1)[0].text.includes('검색 엔진'));
  console.log(FAILS ? `\n${FAILS}개 실패` : '\n전부 통과');
  process.exit(FAILS ? 1 : 0);
})();

// 로컬 LLM 전환: 생성은 OpenAI 호환 추론 서버(/v1/chat/completions)로, 웹 검색(VC 찾기)은 Anthropic API 그대로 (가짜 서버)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const L = require(path.join(__dirname, '..', 'llm.js'));

// --- 단위: 설정 판단 ---
chk('기본은 Claude API', L.config({}).provider === 'anthropic' && L.config({}).model === 'claude-sonnet-5-5');
chk('Claude API 키 없으면 미설정', !L.create({}).ready() && L.create({}).info().missing === 'ANTHROPIC_API_KEY');
chk('openai: 주소·모델 없으면 미설정', L.create({ LLM_PROVIDER: 'openai' }).info().missing === 'LLM_BASE_URL' && L.create({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://x' }).info().missing === 'LLM_MODEL');
chk('openai: 키 없이도 로컬 서버면 준비됨', L.create({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://gpu:8000/v1/', LLM_MODEL: 'm' }).ready());
chk('주소 끝의 /v1 정리', L.config({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://gpu:8000/v1/' }).baseUrl === 'http://gpu:8000');
chk('생각 과정(<think>) 제거', L.stripThink('<think>고민</think>\n답') === '답' && L.stripThink('그냥 답') === '그냥 답');

// --- 통합: 서버를 로컬 LLM 모드로 ---
const outline = { title: '마을빵공방 IR', palette: 'navy', checks: [], slides: [
  { kind: 'title', title: '마을빵공방 투자 제안', subtitle: '우리밀 간식', note: 'n' },
  { kind: 'message', title: '한 줄 요약', message: '우리밀 단체 간식', note: 'n' },
  { kind: 'closing', title: '함께해 주세요', message: '투자 문의', note: 'n' }] };
const calls = { local: [], claude: 0, search: 0 };
global.fetch = async (url, opt = {}) => {
  const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
  if (u.startsWith('http://gpu.local:8000/v1/chat/completions')) {
    const b = JSON.parse(opt.body); calls.local.push({ b, auth: (opt.headers || {}).authorization });
    if (b.messages[1].content.includes('고장')) return { ok: false, status: 503, json: async () => ({ error: 'loading' }) };
    if (b.messages[0].content.includes('[IR 자료 만들기]')) return ok({ choices: [{ finish_reason: 'stop', message: { content: '<think>구성 고민</think>' + JSON.stringify(outline) } }] });
    return ok({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '<think>생각 중…</think>\n로컬 모델 답변입니다.' } }] });
  }
  if (u.includes('/v1/messages')) {
    const b = JSON.parse(opt.body);
    if (b.tools && b.tools[0].type === 'web_search_20250305') {
      calls.search++;
      return ok({ stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', tool_use_id: 's', content: [{ type: 'web_search_result', url: 'https://impact-a.example.kr/', title: 'A' }] },
        { type: 'text', text: JSON.stringify({ vcs: [{ name: '임팩트벤처스A', focus: '임팩트', stage: '시드', why: '먹거리', source: 'https://impact-a.example.kr/' }], note: '' }) }] });
    }
    calls.claude++;
    return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude 답변' }] });
  }
  return ok({ ok: true, result: {} });
};
Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3991', TELEGRAM_BOT_TOKEN: '',
  LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://gpu.local:8000', LLM_MODEL: 'local-model-a', LLM_API_KEY: '' });
require(path.join(__dirname, '..', 'server.js'));
const http = require('http');
function mk() { let ck = ''; return (p, b) => new Promise(r => { const q = http.request('http://localhost:3991' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j; try { j = JSON.parse(buf); } catch (e) { j = buf; } r({ s: res.statusCode, j }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
const A = mk(), U = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1' });
  let ad = (await A('/api/admin/state')).j;
  const o = ad.orgs[0].id;
  chk('관리자 화면: 로컬/OpenAI 호환 · 모델 · 검색 가능 표시', ad.ai.provider === 'openai' && ad.ai.model === 'local-model-a' && ad.ai.ready && ad.ai.search === true);
  await A(`/api/admin/orgs/${o}/charge`, { amount: 40 });
  await U('/api/login', { loginId: 'bread', password: 'password1' });
  let st = (await U('/api/state')).j;
  chk('기업 화면: AI 사용 가능', st.ai === true);
  const r = st.rooms[0].id;
  await U(`/api/rooms/${r}/invite`, { botId: 'mkt' }); await U(`/api/rooms/${r}/invite`, { botId: 'ir' });
  const ask = async (q, to) => { await U(`/api/rooms/${r}/messages`, { text: q, to }); await sl(250); return (await U('/api/state')).j; };

  const w0 = st.wallet;
  st = await ask('인스타 문구 하나 써 줘', 'mkt');
  const m = st.rooms[0].msgs.filter(x => x.from === 'mkt').pop();
  chk('마케팅 봇 답이 로컬 모델에서 옴 (생각 과정 제거)', m && m.text.includes('로컬 모델 답변') && !m.text.includes('생각 중'));
  chk('로컬 서버 형식: system+user 메시지 · 모델 이름 · 키 없으면 인증 헤더 없음', calls.local[0].b.model === 'local-model-a' && calls.local[0].b.messages[0].role === 'system' && calls.local[0].b.messages[1].role === 'user' && !calls.local[0].auth);
  chk('생성에 Claude API를 쓰지 않음', calls.claude === 0);
  chk('토큰은 평소처럼 차감', st.wallet === w0 - st.costs.mkt);

  const w1 = st.wallet;
  st = await ask('고장 테스트 문구', 'mkt');
  chk('추론 서버 오류(503) → 안내 + 토큰 환불', st.wallet === w1 && st.rooms[0].msgs.filter(x => x.from === 'sys' || x.from === 'mkt').pop().text.includes('쉬어야'));

  st = await ask('IR 자료 초안 만들기', 'ir');
  const ir = (await U('/api/ir')).j;
  chk('IR 초안(JSON)도 로컬 모델로 생성', ir.current && ir.current.outline.slides.length === 3);
  st = await ask('우리에게 맞는 VC 찾기', 'ir');
  const ir2 = (await U('/api/ir')).j;
  chk('VC 찾기(웹 검색)는 Claude API 그대로', calls.search === 1 && ir2.vcs && ir2.vcs[0].items.length === 1);
  chk('끝까지 생성은 로컬만', calls.claude === 0 && calls.local.length >= 3);
  console.log(FAILS ? `\n${FAILS}개 실패` : '\n전부 통과');
  process.exit(FAILS ? 1 : 0);
})();

// 봇 마켓: 직접 만든 봇 정의 읽기·검사
// 정의는 JSON 하나. 공개 URL(Claude 아티팩트 등)에서 읽거나 붙여넣기로 받는다.
'use strict';
const dns = require('dns').promises;
const net = require('net');

const KINDS = { chat: '글로 답하는 봇', site: '홈페이지(랜딩페이지) 봇', ir: 'IR 자료 봇', sched: '일정 봇', todo: '할 일 봇 (개인 할 일·정기 점검)' };

// ----- 서버가 사용자 URL을 읽을 때 내부망·클라우드 메타데이터 접근 차단 (SSRF 방지) -----
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return { error: 'URL 형식이 아니에요' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'http 또는 https 주소만 읽을 수 있어요' };
  if (u.username || u.password) return { error: '아이디·비밀번호가 들어간 주소는 쓸 수 없어요' };
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return { error: '이 포트의 주소는 읽을 수 없어요' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch (e) { return { error: '주소를 찾을 수 없어요' }; }
  if (!addrs.length || addrs.some(a => privateIp(a.address))) return { error: '내부망 주소는 읽을 수 없어요' };
  return { url: u };
}
// 리다이렉트마다 다시 검사, 300KB·8초 제한
async function fetchPublic(raw, fetchImpl = fetch) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const c = await checkUrl(url); if (c.error) return c;
    let r;
    try { r = await fetchImpl(c.url.href, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'hamkkebot-bot-market/1', accept: 'application/json,text/html,text/plain;q=0.9' } }); }
    catch (e) { return { error: '주소를 읽지 못했어요 (시간 초과 또는 접속 실패)' }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), c.url).href; continue; }
    if (r.status === 401 || r.status === 403) return { error: '로그인이 필요한 주소라 읽지 못했어요. 공개 링크로 바꾸거나 정의를 붙여넣어 주세요.' };
    if (!r.ok) return { error: `주소를 읽지 못했어요 (응답 ${r.status})` };
    const text = await r.text();
    if (text.length > 300 * 1024) return { error: '내용이 너무 커요 (300KB까지)' };
    return { text, finalUrl: c.url.href };
  }
  return { error: '리다이렉트가 너무 많아요' };
}

// ----- 텍스트(JSON·HTML·Markdown)에서 봇 정의 찾기 -----
const unescapeHtml = s => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function extractDef(text) {
  const tries = [];
  const t = String(text || '').trim();
  tries.push(t);
  const tag = t.match(/<script[^>]*id=["']hamkkebot-bot["'][^>]*>([\s\S]*?)<\/script>/i); if (tag) tries.unshift(tag[1]);
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) if (m[1].includes('hamkkebot')) tries.push(m[1]);
  const un = unescapeHtml(t);
  // "hamkkebot" 키가 있는 가장 바깥 { … } 를 찾음
  for (const src of [t, un]) {
    const i = src.indexOf('"hamkkebot"'); if (i < 0) continue;
    const start = src.lastIndexOf('{', i); if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let k = start; k < src.length; k++) {
      const ch = src[k];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (!depth) { tries.push(src.slice(start, k + 1)); break; } }
    }
  }
  for (const c of tries) { try { const o = JSON.parse(c); if (o && typeof o === 'object' && (o.hamkkebot || o.role)) return { def: o }; } catch (e) {} }
  return { error: '봇 정의(JSON)를 찾지 못했어요. "hamkkebot": 1 이 들어간 JSON이 있는지 확인해 주세요.' };
}

// ----- 정의 검사·정리 -----
const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function validateDef(o) {
  if (!o || typeof o !== 'object') return { error: '봇 정의가 비어 있어요' };
  const def = {
    name: s(o.name, 20), short: s(o.short || o.name, 2), color: /^#?[0-9a-f]{6}$/i.test(o.color || '') ? '#' + String(o.color).replace('#', '').toUpperCase() : '#5B6474',
    tag: s(o.tag, 40), desc: s(o.desc, 200), hello: s(o.hello, 300),
    quick: (Array.isArray(o.quick) ? o.quick : []).map(q => s(q, 40)).filter(Boolean).slice(0, 6),
    kind: KINDS[o.kind] ? o.kind : 'chat', ppt: o.kind === 'chat' || !o.kind ? !!o.ppt : false,
    role: String(o.role == null ? '' : o.role).replace(/\r/g, '').trim().slice(0, 4000)
  };
  const errs = [];
  if (!def.name) errs.push('name(봇 이름)이 없어요');
  if (def.role.length < 20) errs.push('role(봇 역할 지시문)이 너무 짧아요 (20자 이상)');
  if (!def.desc) errs.push('desc(설명)가 없어요');
  if (errs.length) return { error: errs.join(' · ') };
  if (!def.hello) def.hello = `안녕하세요, ${def.name}이에요.`;
  return { def };
}

// ----- 복사 찾기: 역할 지시문을 6글자 조각으로 나눠 겹치는 비율을 봄 (띄어쓰기·문장부호·줄바꿈 무시) -----
const K = 6, MIN = 40;
const normText = t => String(t || '').normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
function grams(t, ignore) { const n = normText(t), g = new Set(); for (let i = 0; i + K <= n.length; i++) { const x = n.slice(i, i + K); if (!ignore || !ignore.has(x)) g.add(x); } return g; }
// cover: 원작 조각 중 새 봇에 들어 있는 비율 (원작에 덧붙여도 높음), within: 새 봇 조각 중 원작에서 온 비율 (일부만 잘라 가도 높음)
function overlap(newRole, origRole, ignore) {
  const A = grams(newRole, ignore), B = grams(origRole, ignore);
  if (B.size < MIN || A.size < MIN) return { score: 0, cover: 0, within: 0 };
  let n = 0; for (const x of B) if (A.has(x)) n++;
  const cover = n / B.size, within = n / A.size;
  const copied = cover >= 0.6 || (within >= 0.8 && n >= MIN);
  return { score: copied ? Math.round(Math.max(cover, within) * 100) : 0, cover, within };
}

// ----- 내보내기: 다시 올릴 수 있는 HTML 한 장 (Claude 아티팩트와 같은 형식) -----
const escH = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function exportDef(def, meta) {
  return { hamkkebot: 1, name: def.name, short: def.short, color: def.color, tag: def.tag, desc: def.desc, hello: def.hello, quick: def.quick || [], kind: def.kind || 'chat', ppt: !!def.ppt, role: def.role, exported: meta };
}
function exportHtml(def, meta) {
  const o = exportDef(def, meta), pretty = JSON.stringify(o, null, 2);
  const inScript = JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escH(o.name)} · 함께봇 봇 정의</title>
<style>body{margin:0;font:15px/1.6 "Malgun Gothic","Noto Sans KR",system-ui,sans-serif;color:#17202b;background:#fff}main{max-width:760px;margin:0 auto;padding:28px 18px 60px}
.av{display:inline-flex;width:44px;height:44px;border-radius:50%;align-items:center;justify-content:center;color:#fff;font-weight:700;vertical-align:middle;margin-right:10px}
h1{font-size:26px;margin:0;display:flex;align-items:center}h2{font-size:17px;margin:28px 0 8px}.mute{color:#667085;font-size:14px}
pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border-radius:10px;padding:12px 14px;font-size:13px}ol{padding-left:20px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:14px 0}dt{color:#667085}dd{margin:0}</style></head>
<body><main>
<h1><span class="av" style="background:${escH(o.color)}">${escH(o.short)}</span>${escH(o.name)}</h1>
<p>${escH(o.desc)}</p>
<dl><dt>종류</dt><dd>${escH(KINDS[o.kind] || o.kind)}${o.ppt ? ' + PPT' : ''}</dd><dt>한 줄 소개</dt><dd>${escH(o.tag)}</dd>${meta.from ? `<dt>내보낸 곳</dt><dd>${escH(meta.from)}${meta.version ? ` · 버전 ${escH(meta.version)}` : ''}</dd>` : ''}<dt>내보낸 날</dt><dd>${escH(meta.at)}</dd>${o.quick.length ? `<dt>빠른 요청</dt><dd>${o.quick.map(escH).join(' · ')}</dd>` : ''}</dl>
<h2>함께봇에 붙이는 법</h2>
<ol><li>함께봇 웹앱 → 전문가 초대 → <b>+ 봇 만들기·올리기</b></li><li>「파일로 올리기」에서 이 파일을 고르거나, 이 파일을 공개 링크로 올린 뒤 링크를 넣거나, 아래 정의(JSON)를 붙여넣으세요.</li><li>기업방에서 승인하면 우리 기업 봇 목록에 올라가요. 토큰 가격·공개 여부는 붙인 기업이 새로 정해요.</li></ol>
<h2>첫 인사</h2><p>${escH(o.hello)}</p>
<h2>역할 지시문</h2><pre>${escH(o.role)}</pre>
<h2>정의 (JSON)</h2><pre>${escH(pretty)}</pre>
<p class="mute">함께봇 봇 정의 파일 · hamkkebot 1</p>
<script type="application/json" id="hamkkebot-bot">${inScript}</script>
</main></body></html>
`;
}
// 올린 정의의 내보내기 정보 (보여 주기만 함)
const readMeta = o => o && o.exported && typeof o.exported === 'object' ? { from: s(o.exported.from, 40), version: s(o.exported.version, 10), at: s(o.exported.at, 20), source: s(o.exported.source, 10) } : null;

// 직원이 Claude에게 붙여 넣어 쓰는 안내문 (Claude가 정의를 만들어 아티팩트로 공개하게)
const CLAUDE_PROMPT = `함께봇(사회적기업용 전문가 봇 플랫폼)에 올릴 봇을 만들고 싶어요. 아래 형식의 JSON 하나로 봇 정의를 만들어 주세요.
만든 뒤에는 그 JSON을 화면에 보여 주는 HTML 페이지(아티팩트)로 만들고, 페이지 안에 <script type="application/json" id="hamkkebot-bot">정의 JSON</script> 를 꼭 넣어 주세요.

{
  "hamkkebot": 1,
  "name": "봇 이름 (20자 이내)",
  "short": "목록에 보일 1~2글자",
  "color": "#2D6A4F",
  "tag": "한 줄 분야 (40자 이내)",
  "desc": "무엇을 해 주는 봇인지 (200자 이내)",
  "hello": "처음 초대됐을 때 인사말",
  "quick": ["빠른 요청 버튼 1", "버튼 2", "버튼 3"],
  "kind": "chat",
  "ppt": false,
  "role": "봇의 역할 지시문 (4000자 이내). 누구를 위해 무엇을 어떻게 하는지, 지켜야 할 규칙"
}

- kind: chat(글로 답함) · site(랜딩페이지 제작) · ir(IR 자료) · sched(일정 관리) · todo(개인 할 일·2주 점검) 중 하나
- ppt: chat 봇이 "PPT 만들어 줘" 요청에 발표자료(.pptx)도 만들게 하려면 true
- role에는 사실만 쓰고 수치·인증·후기를 지어내지 말라는 규칙을 넣어 주세요.

제가 만들고 싶은 봇: `;

module.exports = { overlap, grams, exportHtml, exportDef, readMeta, checkUrl, fetchPublic, extractDef, validateDef, privateIp, KINDS, CLAUDE_PROMPT };

// 웹 검색 브릿지 — 웹 검색 도구가 없는 로컬 LLM도 "검색 → 근거 기반 답"을 할 수 있게 서버가 중간에서 검색을 대신함.
//
//   1) LLM이 검색어를 정함  2) 서버가 검색 엔진에 질의  3) (선택) 상위 페이지 본문 일부를 가져옴
//   4) 검색 결과 묶음을 근거로 LLM이 답함  → 반환 형식은 Claude web_search 호출과 같음 { text, urls }
//   urls(실제 검색 결과 주소)는 서버가 답의 출처를 검증할 때 씀 — 모델이 지어낸 주소는 걸러짐.
//
// SEARCH_ENGINE
//   (비움)   브릿지를 쓰지 않음 → 기존처럼 Claude API web_search
//   searxng  자체 호스팅 메타 검색 (SEARCH_BASE_URL 필수, settings.yml의 search.formats에 json 허용 필요)
//   brave    Brave Search API (SEARCH_API_KEY 필수)
// SEARCH_FETCH_PAGES  본문을 가져올 상위 페이지 수 (기본 5, 0이면 검색 요약만 사용)
'use strict';
const dns = require('dns');
const net = require('net');

function config(env = process.env) {
  const engine = (env.SEARCH_ENGINE || '').trim().toLowerCase();
  return {
    engine,
    baseUrl: (env.SEARCH_BASE_URL || (engine === 'brave' ? 'https://api.search.brave.com' : '')).replace(/\/$/, ''),
    apiKey: env.SEARCH_API_KEY || '',
    fetchPages: env.SEARCH_FETCH_PAGES === undefined || env.SEARCH_FETCH_PAGES === '' ? 5 : Math.max(0, Math.min(10, +env.SEARCH_FETCH_PAGES || 0)),
    perQuery: 8, maxQueries: 5, maxResults: 20,
  };
}
function missing(c) {
  if (!c.engine) return '';
  if (c.engine === 'searxng') return c.baseUrl ? '' : 'SEARCH_BASE_URL';
  if (c.engine === 'brave') return c.apiKey ? '' : 'SEARCH_API_KEY';
  return 'SEARCH_ENGINE(searxng|brave)';
}

// ---- 페이지 본문 가져오기: 사설·내부 주소 차단 (검색 결과가 내부망을 가리키는 경우 대비) ----
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
const htmlToText = h => String(h || '')
  .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const norm = u => String(u || '').replace(/#.*$/, '').replace(/\/$/, '');

function create(env = process.env, opts = {}) {
  const c = config(env);
  const miss = missing(c);
  const lookup = opts.lookup || ((host) => dns.promises.lookup(host, { all: true }));
  const fetchFn = (...a) => (opts.fetch || global.fetch)(...a);

  async function safeHost(u) {
    let url; try { url = new URL(u); } catch (e) { return false; }
    if (!/^https?:$/.test(url.protocol)) return false;
    const h = url.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$/i.test(h) || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (net.isIP(h)) return !privateIp(h);
    try { const a = await lookup(h); return a.length > 0 && a.every(x => !privateIp(x.address)); } catch (e) { return false; }
  }
  async function pageText(u, depth = 0) {
    if (!(await safeHost(u))) return '';
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetchFn(u, { method: 'GET', redirect: 'manual', signal: ac.signal, headers: { 'user-agent': 'hamkkebot-search-bridge/1', accept: 'text/html,text/plain' } });
      if (r.status >= 300 && r.status < 400 && depth < 2) { const loc = r.headers && r.headers.get && r.headers.get('location'); return loc ? pageText(new URL(loc, u).href, depth + 1) : ''; }
      if (!r.ok) return '';
      const ct = (r.headers && r.headers.get && r.headers.get('content-type')) || 'text/html';
      if (!/text\/(html|plain)/i.test(ct)) return '';
      const body = (await r.text()).slice(0, 300000);
      return htmlToText(body).slice(0, 1500);
    } catch (e) { return ''; } finally { clearTimeout(t); }
  }

  async function searchOnce(q) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 15000);
    try {
      if (c.engine === 'searxng') {
        const r = await fetchFn(`${c.baseUrl}/search?q=${encodeURIComponent(q)}&format=json&language=ko-KR&safesearch=1`, { signal: ac.signal, headers: { accept: 'application/json' } });
        if (!r.ok) { console.error('SearXNG 오류', r.status); return null; }
        const j = await r.json();
        return (j.results || []).slice(0, c.perQuery).map(x => ({ url: x.url, title: x.title || '', snippet: x.content || '' }));
      }
      const r = await fetchFn(`${c.baseUrl}/res/v1/web/search?q=${encodeURIComponent(q)}&country=KR&search_lang=ko&count=${c.perQuery}`, { signal: ac.signal, headers: { accept: 'application/json', 'x-subscription-token': c.apiKey } });
      if (!r.ok) { console.error('Brave 검색 오류', r.status); return null; }
      const j = await r.json();
      return ((j.web && j.web.results) || []).slice(0, c.perQuery).map(x => ({ url: x.url, title: x.title || '', snippet: htmlToText(x.description || '') }));
    } catch (e) { console.error('검색 엔진 연결 실패', e.message); return null; } finally { clearTimeout(t); }
  }

  // generate: llm.js의 generate(system, user, maxTokens)
  async function search(generate, system, user, maxTokens = 4000) {
    if (miss) return { error: `서버에 ${miss}이(가) 설정되지 않아 검색할 수 없어요.` };
    // 1) 검색어 정하기
    const plan = await generate(`당신은 웹 검색어를 정하는 도우미입니다. 아래 [임무]를 위해 검색 엔진에 넣을 검색어를 정하세요.
- 한국어 위주 3~5개, 각 2~8단어. 서로 다른 관점(분야·투자 단계·지역·기관 유형)으로.
- JSON 하나만 출력: {"queries":["…","…"]}

[임무]
${system}`, user, 400, { purpose: 'search_plan' });
    if (plan.error) return { error: plan.error };
    let queries = [];
    try { const t = plan.text; queries = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).queries; } catch (e) {}
    queries = (Array.isArray(queries) ? queries : []).map(q => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean);
    queries = [...new Set(queries)].slice(0, c.maxQueries);
    if (!queries.length) return { error: '검색어를 정하지 못했어요. 다시 시도해 주세요.' };
    // 2) 검색
    const results = [], seen = new Set();
    let okCount = 0;
    for (const q of queries) {
      const rs = await searchOnce(q);
      if (!rs) continue;
      okCount++;
      for (const x of rs) {
        if (!/^https?:\/\//.test(x.url || '') || seen.has(norm(x.url))) continue;
        seen.add(norm(x.url)); results.push({ ...x, title: String(x.title).slice(0, 200), snippet: String(x.snippet).slice(0, 400) });
        if (results.length >= c.maxResults) break;
      }
      if (results.length >= c.maxResults) break;
    }
    if (!okCount) return { error: '검색 엔진에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' };
    if (!results.length) return { error: '검색 결과가 없어요. 조건을 바꿔 다시 요청해 주세요.' };
    // 3) 상위 페이지 본문 일부
    for (const x of results.slice(0, c.fetchPages)) x.page = await pageText(x.url);
    // 4) 근거 묶음으로 답하기
    const evidence = results.map((x, i) => `[${i + 1}] ${x.title}\nURL: ${x.url}\n요약: ${x.snippet}${x.page ? `\n본문 일부: ${x.page}` : ''}`).join('\n\n');
    const ans = await generate(`${system}

[검색 결과 사용 규칙]
당신은 직접 검색할 수 없습니다. 서버가 대신 검색한 아래 [검색 결과]만 근거로 쓰세요.
- 검색 결과에 나오지 않는 사실(이름·분야·단계·연락처)을 쓰지 마세요.
- 출처(source)에는 근거가 된 검색 결과의 URL을 그대로 복사하세요. URL을 만들거나 고치지 마세요.
- 근거가 부족하면 개수를 줄이세요.`, `${user}

[검색 결과] (검색어: ${queries.join(' / ')})
${evidence}`, maxTokens, { purpose: 'search_answer' });
    if (ans.error) return { error: ans.error };
    return { text: ans.text, urls: new Set(results.map(x => x.url)), queries, via: c.engine };
  }

  const label = c.engine === 'searxng' ? 'SearXNG + AI 생성 브릿지' : c.engine === 'brave' ? 'Brave Search + AI 생성 브릿지' : '';
  return {
    enabled: !!c.engine, ready: () => !!c.engine && !miss, search,
    info: () => ({ engine: c.engine || 'claude', label: label || 'Claude API web_search', ready: c.engine ? !miss : undefined, missing: miss || undefined, fetchPages: c.engine ? c.fetchPages : undefined }),
    _pageText: pageText, _safeHost: safeHost,
  };
}

module.exports = { create, config, htmlToText, privateIp };

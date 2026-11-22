// AI 생성 호출 어댑터 — 봇 답변·문서·IR·보고 PPT 등 "생성"만 담당.
// 웹 검색(IR 봇의 VC 찾기)은 여기서 다루지 않고 서버가 Anthropic API를 그대로 씀.
//
// LLM_PROVIDER
//   anthropic (기본) : Anthropic Messages API (/v1/messages)
//   openai           : OpenAI 호환 Chat Completions (/v1/chat/completions)
//                      — vLLM·Ollama·llama.cpp server·LM Studio 등 로컬 추론 서버가 이 형식을 제공
// 설정
//   LLM_BASE_URL  추론 서버 주소 (openai 필수. 예: http://localhost:8000, http://localhost:11434)
//   LLM_MODEL     모델 이름 (openai 필수. anthropic은 CLAUDE_MODEL 또는 기본값)
//   LLM_API_KEY   필요할 때만 (로컬 서버는 보통 비워 둠)
//   LLM_TIMEOUT_MS 응답 대기 한도 (기본 180000 — 로컬 모델은 느릴 수 있음)
'use strict';

function config(env = process.env) {
  const provider = (env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  if (provider === 'openai') {
    return {
      provider, label: '로컬/OpenAI 호환',
      baseUrl: (env.LLM_BASE_URL || '').replace(/\/$/, '').replace(/\/v1$/, ''),
      model: env.LLM_MODEL || '', apiKey: env.LLM_API_KEY || '',
      timeoutMs: +env.LLM_TIMEOUT_MS || 180000,
    };
  }
  return {
    provider: 'anthropic', label: 'Claude API',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    model: env.LLM_MODEL || env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    apiKey: env.ANTHROPIC_API_KEY || '',
    timeoutMs: +env.LLM_TIMEOUT_MS || 180000,
  };
}

// 설정이 갖춰졌는지. 빠진 것이 있으면 이유 문자열
function missing(c) {
  if (c.provider === 'anthropic') return c.apiKey ? '' : 'ANTHROPIC_API_KEY';
  if (!c.baseUrl) return 'LLM_BASE_URL';
  if (!c.model) return 'LLM_MODEL';
  return '';
}

// 추론형 로컬 모델이 내보내는 생각 과정(<think>…</think>)은 답에서 뺌
const stripThink = t => String(t || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').replace(/^[\s\S]*?<\/think>\s*/i, '');

const busyMsg = '요청이 많아 잠시 쉬어야 해요. 1분 뒤 다시 시도해 주세요.';
const failMsg = '답변을 받지 못했어요. 다시 시도해 주세요.';

function withTimeout(ms) {
  if (typeof AbortController === 'undefined') return { signal: undefined, done() {} };
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done() { clearTimeout(t); } };
}

// generate(system, user, maxTokens) → { text, cut } 또는 { error }
// 토큰 수를 주지 않는 추론 서버용 어림값 (한국어는 대략 2글자당 1토큰) — est:true로 표시
const estTokens = t => Math.ceil(String(t || '').length / 2);

// opts.onUsage({ provider, model, in, out, est, ms, ok, purpose }) — 호출마다 사용량 기록용
function create(env = process.env, opts = {}) {
  const c = config(env);
  const miss = missing(c);
  const report = u => { try { opts.onUsage && opts.onUsage({ provider: c.provider, model: c.model, ...u }); } catch (e) { console.error('사용량 기록 실패', e.message); } };
  async function generate(system, user, maxTokens = 2500, meta = {}) {
    if (miss) return { error: `서버에 ${miss}이(가) 설정되지 않아 답할 수 없어요. 관리자에게 알려 주세요.` };
    const t0 = Date.now(), purpose = meta.purpose || 'generate';
    const r = await call(system, user, maxTokens);
    const u = r.usage || { in: estTokens(system) + estTokens(user), out: estTokens(r.text), est: true };
    report({ in: u.in, out: r.error ? 0 : u.out, est: !!u.est, ms: Date.now() - t0, ok: !r.error, purpose });
    delete r.usage;
    return r;
  }
  async function call(system, user, maxTokens) {
    const to = withTimeout(c.timeoutMs);
    try {
      if (c.provider === 'anthropic') {
        const r = await fetch(`${c.baseUrl}/v1/messages`, {
          method: 'POST', signal: to.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
        });
        const j = await r.json();
        if (!r.ok) { console.error('Claude API 오류', r.status, j); return { error: r.status === 429 ? busyMsg : failMsg }; }
        const usage = j.usage && Number.isFinite(j.usage.input_tokens) ? { in: j.usage.input_tokens + (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), out: j.usage.output_tokens || 0 } : null;
        return { text: (j.content || []).filter(x => x.type === 'text').map(x => x.text).join(''), cut: j.stop_reason === 'max_tokens', usage };
      }
      const headers = { 'content-type': 'application/json' };
      if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
      const r = await fetch(`${c.baseUrl}/v1/chat/completions`, {
        method: 'POST', signal: to.signal, headers,
        body: JSON.stringify({ model: c.model, max_tokens: maxTokens, stream: false,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('로컬 LLM 오류', r.status, j); return { error: r.status === 429 || r.status === 503 ? busyMsg : failMsg }; }
      const ch = (j.choices || [])[0] || {};
      const text = stripThink(ch.message && ch.message.content);
      const usage = j.usage && Number.isFinite(j.usage.prompt_tokens) ? { in: j.usage.prompt_tokens, out: j.usage.completion_tokens || 0 } : null;
      if (!text.trim()) { console.error('로컬 LLM 빈 응답', j); return { error: failMsg, usage }; }
      return { text, cut: ch.finish_reason === 'length', usage };
    } catch (e) {
      console.error(e);
      return { error: e && e.name === 'AbortError' ? '답변이 너무 오래 걸려 중단했어요. 다시 시도해 주세요.' : '답변을 받지 못했어요. 네트워크를 확인해 주세요.' };
    } finally { to.done(); }
  }
  return {
    generate,
    ready: () => !miss,
    info: () => ({ provider: c.provider, label: c.label, model: c.model, baseUrl: c.provider === 'openai' ? c.baseUrl : undefined, ready: !miss, missing: miss || undefined }),
  };
}

module.exports = { create, config, stripThink, estTokens };

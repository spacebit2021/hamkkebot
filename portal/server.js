// 함께봇 충전·환전 페이지 (원격, 함께봇과 따로 실행)
// 함께봇 토큰 API(/chain/v1)에 서명한 요청으로 충전(mint)·환전(burn)을 합니다.
// 지금 결제는 "테스트 결제"(실제 돈이 오가지 않음)이고, 환전 송금은 운영자가 직접 한 뒤 「송금 완료」로 표시합니다.
// 환경변수: PORT(4100) HB_API(함께봇 주소) HB_KEY HB_SECRET TOKEN_PRICE_KRW(1000, 임시 값) PORTAL_ADMIN_PASSWORD PORTAL_DATA HB_APP_URL
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const CHAIN = require('../chain'); // 서명 방식만 같이 씀

const PORT = +process.env.PORTAL_PORT || +process.env.PORT || 4100;
const HB_API = (process.env.HB_API || 'http://localhost:3000').replace(/\/$/, '');
const HB_KEY = process.env.HB_KEY || '', HB_SECRET = process.env.HB_SECRET || '';
const PRICE = +process.env.TOKEN_PRICE_KRW || 1000; // 1토큰 원화 값 — 정해지지 않은 임시 값
const ADMIN_PW = process.env.PORTAL_ADMIN_PASSWORD || '';
const HB_APP = (process.env.HB_APP_URL || HB_API).replace(/\/$/, '');
const DATA = process.env.PORTAL_DATA || path.join(__dirname, 'portal-data.json');

let D = { orders: [], payouts: [] };
try { D = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
const save = () => { try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(D)); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { console.error(e); } };
const sessions = new Map(); // sid → { address, name, by, csrf, exp, admin }
const id = p => p + crypto.randomBytes(6).toString('hex');
const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const won = n => n.toLocaleString('ko-KR') + '원';
const mask = a => a.length <= 4 ? '****' : '*'.repeat(Math.max(0, a.length - 4)) + a.slice(-4);

// ----- 함께봇 토큰 API 호출 (요청마다 서명) -----
async function hb(method, p, body) {
  const raw = body ? JSON.stringify(body) : '';
  try {
    const r = await fetch(HB_API + p, { method, headers: CHAIN.signedHeaders(HB_KEY, HB_SECRET, method, p, raw), body: raw || undefined });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error || `토큰 API 오류 (${r.status})` };
  } catch (err) { return { error: '함께봇 토큰 API에 연결하지 못했어요' }; }
}

// ----- 화면 -----
const HEAD = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
function page(title, body, refresh) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${e(title)} · 함께봇 충전·환전</title>
<style>:root{color-scheme:light dark;--bg:light-dark(#f6f7fb,#0f1117);--card:light-dark(#fff,#171a23);--ink:light-dark(#16171d,#eef0f6);--mute:light-dark(#5d6170,#a3a8b8);--line:light-dark(#e2e4ec,#2a2e3b);--pri:light-dark(#2d45e8,#7d8dff);--pri-ink:light-dark(#fff,#0f1117);--ok:light-dark(#067647,#6fdc8c);--bad:light-dark(#b42318,#ff8a80)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "Malgun Gothic","Noto Sans KR",system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:22px 16px 70px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:0 0 10px}.mute{color:var(--mute);font-size:14px}.card{background:var(--card);border:1.5px solid var(--line);border-radius:16px;padding:16px;margin-top:14px}
.big{font-size:30px;font-weight:800}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--mute)}
input,select{font:inherit;color:inherit;min-height:46px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);padding:8px 10px;width:100%}button,.btn{font:inherit;min-height:46px;border-radius:12px;border:0;background:var(--pri);color:var(--pri-ink);font-weight:700;padding:0 18px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.ghost{background:transparent;color:var(--ink);border:1.5px solid var(--line)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}code{font-size:12px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:7px 4px;text-align:left;vertical-align:top}.ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.note{background:light-dark(#fffaeb,#2a2410);border-radius:12px;padding:10px 12px;font-size:14px;margin-top:10px}
@media(max-width:520px){.grid{grid-template-columns:1fr}}</style></head><body><main>${body}</main></body></html>`;
}
const send = (res, code, html, extra = {}) => { res.writeHead(code, { ...HEAD, ...extra }); res.end(html); };
const go = (res, to, extra = {}) => { res.writeHead(303, { location: to, ...extra }); res.end(); };
const cookieOf = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)hbp=([a-f0-9]{48})/) || [])[1];
const sess = req => { const s = sessions.get(cookieOf(req)); if (s && s.exp > Date.now()) return s; return null; };
const newSess = data => { const sid = crypto.randomBytes(24).toString('hex'); sessions.set(sid, { ...data, csrf: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 30 * 6e4 }); return `hbp=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800${HB_API.startsWith('https') ? '; Secure' : ''}`; };
const form = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); }); req.on('end', () => ok(Object.fromEntries(new URLSearchParams(d)))); });
const msgBox = m => m ? `<p class="note">${e(m)}</p>` : '';
const statusKo = t => t.status === 'confirmed' ? `<span class="ok">확정</span> · 블록 ${t.blockNumber} · 확인 ${t.confirmations}` : t.status === 'pending' ? '블록 기다리는 중' : `<span class="bad">실패</span> ${e(t.error || '')}`;

async function home(res, s, msg) {
  const a = await hb('GET', `/chain/v1/accounts/${s.address}`), tx = await hb('GET', `/chain/v1/accounts/${s.address}/txs`);
  if (a.error) return send(res, 502, page('오류', `<h1>충전·환전</h1>${msgBox(a.error)}`));
  const orders = D.orders.filter(o => o.address === s.address).slice(-10).reverse(), pays = D.payouts.filter(o => o.address === s.address).slice(-10).reverse();
  send(res, 200, page('충전·환전', `<h1>${e(a.name)} 충전·환전</h1><div class="mute">${e(s.by)}님 · 지갑 주소 <code>${e(s.address)}</code></div>${msgBox(msg)}
<div class="card"><div class="grid"><div><div class="mute">토큰 잔액</div><div class="big">${a.balance.toLocaleString()}</div></div><div><div class="mute">환전할 수 있는 토큰</div><div class="big">${a.exchangeable.toLocaleString()}</div><div class="mute">다른 기업에게서 번 토큰만 환전할 수 있어요</div></div></div>${a.pendingMint ? `<p class="mute">확정 기다리는 충전 ${a.pendingMint}토큰</p>` : ''}</div>
<div class="card"><h2>충전</h2><form method="post" action="/charge"><input type="hidden" name="csrf" value="${s.csrf}"><div class="grid"><label>충전할 토큰<input name="tokens" type="number" min="1" max="100000" required inputmode="numeric"></label><label>결제 방법<select name="method"><option value="test">테스트 결제 (실제 돈이 오가지 않아요)</option></select></label></div>
<p class="mute">1토큰 = ${won(PRICE)} (임시 값, 확정 전) · 실제 결제는 아직 연결되지 않았어요.</p><div class="row"><button>충전하기</button></div></form></div>
<div class="card"><h2>환전</h2><form method="post" action="/exchange"><input type="hidden" name="csrf" value="${s.csrf}"><div class="grid"><label>환전할 토큰 (최대 ${a.exchangeable})<input name="tokens" type="number" min="1" max="${a.exchangeable}" required inputmode="numeric"></label><label>은행<input name="bank" maxlength="20" required></label><label>예금주<input name="holder" maxlength="30" required></label><label>계좌번호<input name="account" maxlength="30" inputmode="numeric" required></label></div>
<p class="mute">신청하면 토큰이 바로 빠지고(소각), 운영자가 확인 후 송금해요. 반려되면 토큰을 돌려드려요.</p><div class="row"><button>환전 신청</button></div></form></div>
<div class="card"><h2>충전 내역</h2><table><tbody>${orders.map(o => `<tr><td>${new Date(o.at).toLocaleString('ko-KR')}</td><td>${o.tokens}토큰 · ${won(o.krw)}</td><td>${o.method === 'test' ? '테스트 결제' : e(o.method)}</td><td>${o.txHash ? `<a href="/tx/${o.txHash}">거래 보기</a>` : e(o.error || '')}</td></tr>`).join('') || '<tr><td class="mute">없음</td></tr>'}</tbody></table></div>
<div class="card"><h2>환전 신청</h2><table><tbody>${pays.map(o => `<tr><td>${new Date(o.at).toLocaleString('ko-KR')}</td><td>${o.tokens}토큰 · ${won(o.krw)}</td><td>${e(o.bank)} ${e(mask(o.account))}</td><td>${o.status === 'paid' ? '<span class="ok">송금 완료</span>' : o.status === 'rejected' ? `<span class="bad">반려</span> ${e(o.note || '')} (토큰 돌려줌)` : '송금 기다리는 중'}</td></tr>`).join('') || '<tr><td class="mute">없음</td></tr>'}</tbody></table></div>
<div class="card"><h2>토큰 거래 (블록)</h2><table><tbody>${(tx.txs || []).slice(0, 15).map(t => `<tr><td><a href="/tx/${t.hash}"><code>${t.hash.slice(0, 14)}…</code></a></td><td>${t.type === 'mint' ? '충전' : '환전'} ${t.amount}</td><td>${statusKo(t)}</td></tr>`).join('') || '<tr><td class="mute">없음</td></tr>'}</tbody></table></div>
<div class="row"><a class="btn ghost" href="${e(HB_APP)}">함께봇으로 돌아가기</a><form method="post" action="/logout"><input type="hidden" name="csrf" value="${s.csrf}"><button class="ghost">나가기</button></form></div>`));
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (!HB_KEY || !HB_SECRET) return send(res, 500, page('설정 필요', '<h1>충전·환전 페이지 설정이 필요해요</h1><p>함께봇 관리자 화면 「토큰 API」에서 API 키를 발급해 HB_KEY · HB_SECRET 환경변수로 넣어 주세요.</p>'));
  // 함께봇 웹앱에서 넘어옴: 일회용 코드 → 토큰 API로 확인
  if (p === '/' && u.searchParams.get('code')) {
    const r = await hb('POST', '/chain/v1/sessions', { code: u.searchParams.get('code') });
    if (r.error) return send(res, 400, page('다시 시도', `<h1>충전·환전</h1>${msgBox(r.error)}<p><a class="btn ghost" href="${e(HB_APP)}">함께봇으로</a></p>`));
    return go(res, '/home', { 'set-cookie': newSess({ address: r.address, name: r.name, by: r.by }) });
  }
  if (p === '/' || p === '/home') { const s = sess(req); if (!s || s.admin) return send(res, 200, page('충전·환전', `<h1>함께봇 충전·환전</h1><p>함께봇 웹앱 왼쪽의 「충전·환전」 버튼으로 들어와 주세요.</p><p><a class="btn" href="${e(HB_APP)}">함께봇 열기</a> <a class="btn ghost" href="/admin">운영자</a></p>`)); return home(res, s, u.searchParams.get('m')); }
  if (p.startsWith('/tx/')) {
    const s = sess(req); if (!s) return go(res, '/');
    const t = await hb('GET', `/chain/v1/tx/${p.slice(4)}`);
    if (t.error) return send(res, 404, page('거래', `<h1>거래</h1>${msgBox(t.error)}<a class="btn ghost" href="/home">돌아가기</a>`));
    if (!s.admin && t.address !== s.address) return send(res, 403, page('거래', '<h1>볼 수 없는 거래예요</h1>'));
    return send(res, 200, page('거래', `<h1>${t.type === 'mint' ? '충전' : '환전'} 거래</h1><div class="card"><div class="mute">거래 해시</div><code>${e(t.hash)}</code><p class="big">${t.amount.toLocaleString()}토큰</p><p>${statusKo(t)}</p><p class="mute">참조 ${e(t.ref)} · ${new Date(t.createdAt).toLocaleString('ko-KR')}</p></div>${t.status === 'pending' ? '<p class="mute">블록에 담기면 자동으로 새로 고쳐져요…</p>' : ''}<div class="row"><a class="btn" href="${s.admin ? '/admin' : '/home'}">돌아가기</a></div>`, t.status === 'pending' ? 1 : 0));
  }
  if (req.method === 'POST' && (p === '/charge' || p === '/exchange' || p === '/logout')) {
    const s = sess(req), f = await form(req);
    if (!s || s.admin || f.csrf !== s.csrf) return go(res, '/');
    if (p === '/logout') { sessions.delete(cookieOf(req)); return go(res, '/', { 'set-cookie': 'hbp=; Max-Age=0; Path=/' }); }
    const tokens = Number(f.tokens);
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 100000) return home(res, s, '토큰은 1~100,000 사이 정수로 적어 주세요');
    if (p === '/charge') {
      // 결제: 지금은 테스트 결제만 (실제 결제 대행 연결 전). 결제가 확인되면 토큰 API에 충전(mint)을 보냄
      const o = { id: id('ord_'), at: Date.now(), address: s.address, name: s.name, by: s.by, tokens, krw: tokens * PRICE, method: 'test', paid: true, txHash: null };
      D.orders.push(o); save();
      const t = await hb('POST', '/chain/v1/tx', { type: 'mint', address: s.address, amount: tokens, ref: o.id, memo: `테스트 결제 ${won(o.krw)}`, idempotencyKey: o.id });
      if (t.error) { o.error = t.error; save(); return home(res, s, `충전하지 못했어요: ${t.error}`); }
      o.txHash = t.hash; save();
      return go(res, `/tx/${t.hash}`);
    }
    const bank = String(f.bank || '').trim().slice(0, 20), holder = String(f.holder || '').trim().slice(0, 30), account = String(f.account || '').replace(/[^0-9-]/g, '').slice(0, 30);
    if (!bank || !holder || account.replace(/-/g, '').length < 6) return home(res, s, '은행·예금주·계좌번호를 확인해 주세요');
    const o = { id: id('pay_'), at: Date.now(), address: s.address, name: s.name, by: s.by, tokens, krw: tokens * PRICE, bank, holder, account, status: 'requested', txHash: null };
    const t = await hb('POST', '/chain/v1/tx', { type: 'burn', address: s.address, amount: tokens, ref: o.id, memo: `환전 ${won(o.krw)} · ${bank}`, idempotencyKey: o.id });
    if (t.error) return home(res, s, `환전 신청을 하지 못했어요: ${t.error}`);
    o.txHash = t.hash; D.payouts.push(o); save();
    return go(res, `/tx/${t.hash}`);
  }
  // ----- 운영자: 충전 내역 · 환전 송금 처리 -----
  if (p === '/admin') {
    const s = sess(req);
    if (req.method === 'POST' && !s) {
      const f = await form(req);
      if (!ADMIN_PW || f.password !== ADMIN_PW) return send(res, 401, page('운영자', `<h1>운영자</h1>${msgBox(ADMIN_PW ? '비밀번호가 맞지 않아요' : 'PORTAL_ADMIN_PASSWORD가 설정되지 않았어요')}<a class="btn ghost" href="/admin">다시</a>`));
      return go(res, '/admin', { 'set-cookie': newSess({ admin: true }) });
    }
    if (!s || !s.admin) return send(res, 200, page('운영자', `<h1>충전·환전 운영자</h1><form method="post" action="/admin" class="card"><label>비밀번호<input type="password" name="password" autocomplete="current-password"></label><div class="row"><button>들어가기</button></div></form>`));
    const info = await hb('GET', '/chain/v1/info'), wait = D.payouts.filter(x => x.status === 'requested');
    return send(res, 200, page('운영자', `<h1>충전·환전 운영자</h1><div class="mute">${info.error ? e(info.error) : `${e(info.chain)} · 블록 ${info.blockNumber} · 키 ${e(info.client.name)} (${info.client.scopes.join(', ')})`}</div>${msgBox(u.searchParams.get('m'))}
<div class="card"><h2>송금 기다리는 환전 ${wait.length}건</h2><table><tbody>${wait.map(o => `<tr><td>${new Date(o.at).toLocaleString('ko-KR')}<br>${e(o.name)} · ${e(o.by)}</td><td>${o.tokens}토큰<br><b>${won(o.krw)}</b></td><td>${e(o.bank)}<br>${e(o.holder)}<br><code>${e(o.account)}</code></td><td><a href="/tx/${o.txHash}">소각 거래</a></td><td><form method="post" action="/admin/payout"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="id" value="${o.id}"><button name="act" value="paid">송금 완료</button><input name="note" placeholder="반려 사유" maxlength="80"><button class="ghost" name="act" value="reject">반려 (토큰 돌려줌)</button></form></td></tr>`).join('') || '<tr><td class="mute">없음</td></tr>'}</tbody></table></div>
<div class="card"><h2>최근 충전</h2><table><tbody>${D.orders.slice(-20).reverse().map(o => `<tr><td>${new Date(o.at).toLocaleString('ko-KR')}</td><td>${e(o.name)}</td><td>${o.tokens}토큰 · ${won(o.krw)}</td><td>${o.method === 'test' ? '테스트 결제' : e(o.method)}</td><td>${o.txHash ? `<a href="/tx/${o.txHash}">거래</a>` : e(o.error || '')}</td></tr>`).join('') || '<tr><td class="mute">없음</td></tr>'}</tbody></table></div>
<div class="card"><h2>처리한 환전</h2><table><tbody>${D.payouts.filter(x => x.status !== 'requested').slice(-20).reverse().map(o => `<tr><td>${new Date(o.doneAt || o.at).toLocaleString('ko-KR')}</td><td>${e(o.name)}</td><td>${o.tokens}토큰 · ${won(o.krw)}</td><td>${o.status === 'paid' ? '송금 완료' : `반려 · ${e(o.note || '')}`}</td></tr>`).join('') || '<tr><td class="mute">없음</td></tr>'}</tbody></table></div>`));
  }
  if (p === '/admin/payout' && req.method === 'POST') {
    const s = sess(req), f = await form(req);
    if (!s || !s.admin || f.csrf !== s.csrf) return go(res, '/admin');
    const o = D.payouts.find(x => x.id === f.id && x.status === 'requested'); if (!o) return go(res, '/admin?m=' + encodeURIComponent('이미 처리했거나 없는 신청이에요'));
    if (f.act === 'paid') { o.status = 'paid'; o.doneAt = Date.now(); save(); return go(res, '/admin?m=' + encodeURIComponent(`${o.name} ${won(o.krw)} 송금 완료로 표시했어요`)); }
    // 반려: 소각한 토큰을 같은 주소로 다시 충전(mint)해 돌려줌 (같은 신청은 한 번만)
    const t = await hb('POST', '/chain/v1/tx', { type: 'mint', address: o.address, amount: o.tokens, ref: 'refund-' + o.id, memo: `환전 반려: ${String(f.note || '').slice(0, 80)}`, idempotencyKey: 'refund-' + o.id });
    if (t.error) return go(res, '/admin?m=' + encodeURIComponent('반려하지 못했어요: ' + t.error));
    o.status = 'rejected'; o.note = String(f.note || '').slice(0, 80); o.refundTx = t.hash; o.doneAt = Date.now(); save();
    return go(res, '/admin?m=' + encodeURIComponent(`반려하고 토큰 ${o.tokens}개를 돌려줬어요`));
  }
  send(res, 404, page('없음', '<h1>없는 페이지예요</h1>'));
}

const server = http.createServer((req, res) => handle(req, res).catch(err => { console.error(err); send(res, 500, page('오류', '<h1>오류가 났어요</h1>')); }));
server.listen(PORT, () => console.log(`함께봇 충전·환전 페이지: http://localhost:${PORT}  (토큰 API ${HB_API})`));
setInterval(() => { const n = Date.now(); for (const [k, v] of sessions) if (v.exp < n) sessions.delete(k); }, 6e4).unref();
module.exports = server;

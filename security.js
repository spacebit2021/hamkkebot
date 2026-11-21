// 보안 봇 점검기: 기업이 소유를 인증한 사이트만, 공격 없이 겉에서 보는 점검 (HTTPS·인증서·보안 헤더·쿠키·노출 정보·혼합 콘텐츠·민감 파일)
'use strict';
const tls = require('tls');
const MARKET = require('./market');

const UA = 'HamkkebotSecurityCheck/1.0 (+사이트 소유자가 요청한 점검)';
const LEVEL = { high: '높음', mid: '중간', low: '낮음', info: '참고' };
const PENALTY = { high: 25, mid: 10, low: 3, info: 0 };

// 주소 정리: https://host[:port] 만 (경로는 점검하지 않음)
function normSite(input) {
  let u; try { u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

// 공개 주소만 (내부망·사설 IP 막기, 리다이렉트도 매번 확인)
async function get(url, opt = {}) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    const c = await MARKET.checkUrl(cur); if (c.error) return { error: c.error };
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), opt.timeout || 10000);
    let r;
    try { r = await fetch(cur, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': UA, accept: 'text/html,*/*' } }); }
    catch (e) { clearTimeout(t); return { error: e.name === 'AbortError' ? '응답이 10초 넘게 없어요' : '접속하지 못했어요' }; }
    clearTimeout(t);
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc && opt.follow !== false) { cur = new URL(loc, cur).href; continue; }
    let body = ''; if (opt.body !== false) { try { body = (await r.text()).slice(0, 500 * 1024); } catch (e) {} }
    return { status: r.status, headers: r.headers, body, url: cur, location: loc };
  }
  return { error: '리다이렉트가 너무 많아요' };
}

// 인증서 정보 (테스트에서 바꿔 끼울 수 있게 내보냄)
const io = {
  get,
  tlsInfo: (host, port = 443) => new Promise(ok => {
    const s = tls.connect({ host, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate(); const proto = s.getProtocol(); const authorized = s.authorized; const err = s.authorizationError;
      s.end(); ok({ validTo: c && c.valid_to ? Date.parse(c.valid_to) : null, issuer: c && c.issuer ? (c.issuer.O || c.issuer.CN || '') : '', protocol: proto, authorized, error: authorized ? null : String(err || '') });
    });
    s.on('error', e => ok({ error: e.code || '연결 실패' })); s.on('timeout', () => { s.destroy(); ok({ error: '시간 초과' }); });
  })
};

const hasVer = v => /\d/.test(v || '');
async function scan(site, verified) {
  const F = [], add = (id, level, title, detail, fix) => F.push({ id, level, title, detail, fix });
  const u = new URL(site), https = u.protocol === 'https:';
  const r = { site, at: Date.now(), https, findings: F };
  const ck = await MARKET.checkUrl(site + '/'); // 내부망 주소는 점검하지 않음 (인증서 확인 전에)
  if (ck.error) { add('blocked', 'high', '점검할 수 없는 주소예요', ck.error, '공개된 사이트 주소인지 확인해 주세요.'); return finish(r); }
  if (https) {
    const tlsI = await io.tlsInfo(u.hostname, +u.port || 443);
    r.tls = tlsI;
    if (tlsI.error && !tlsI.validTo) add('tls_fail', 'high', 'HTTPS로 접속되지 않아요', tlsI.error, '웹 호스팅에서 HTTPS(SSL 인증서)를 켜 주세요.');
    else {
      const days = tlsI.validTo ? Math.floor((tlsI.validTo - Date.now()) / 864e5) : null; r.tls.daysLeft = days;
      if (days != null && days < 0) add('cert_expired', 'high', '인증서가 만료됐어요', `${-days}일 전에 만료`, '인증서를 바로 갱신해 주세요.');
      else if (days != null && days < 14) add('cert_soon', 'high', `인증서가 ${days}일 뒤 만료돼요`, '', '자동 갱신이 되는지 확인하고 지금 갱신해 주세요.');
      else if (days != null && days < 30) add('cert_soon', 'mid', `인증서가 ${days}일 뒤 만료돼요`, '', '갱신 일정을 확인해 주세요.');
      if (tlsI.error && !/expired/i.test(tlsI.error)) add('cert_invalid', 'high', '인증서를 믿을 수 없어요', tlsI.error, '도메인에 맞는 정식 인증서로 바꿔 주세요.');
      if (tlsI.protocol && /TLSv1(\.[01])?$/.test(tlsI.protocol)) add('tls_old', 'high', `오래된 암호화 방식(${tlsI.protocol})을 써요`, '', 'TLS 1.2 이상만 쓰도록 서버 설정을 바꿔 주세요.');
    }
  }
  const home = await io.get(site + '/');
  if (home.error) { add('down', 'high', '사이트에 접속되지 않아요', home.error, '서버와 도메인 설정을 확인해 주세요.'); return finish(r); }
  r.status = home.status; r.finalUrl = home.url;
  if (!https) add('no_https', 'high', 'HTTPS를 쓰지 않아요', '주고받는 내용이 암호화되지 않아요', 'SSL 인증서를 설치하고 https:// 주소로 바꿔 주세요.');
  else {
    const plain = await io.get(`http://${u.host}/`, { follow: false, body: false });
    if (!plain.error && !(plain.status >= 300 && plain.status < 400 && /^https:/i.test(plain.location || ''))) add('no_redirect', 'mid', 'http:// 로 들어오면 https로 넘겨 주지 않아요', '', 'http 접속을 https로 자동 이동(301)하게 설정해 주세요.');
  }
  const h = n => home.headers.get(n) || '';
  if (https && !h('strict-transport-security')) add('hsts', 'mid', 'HSTS 헤더가 없어요', '브라우저가 항상 https로 접속하게 하는 설정', 'Strict-Transport-Security: max-age=31536000 헤더를 넣어 주세요.');
  const csp = h('content-security-policy');
  if (!csp) add('csp', 'mid', 'CSP(콘텐츠 보안 정책) 헤더가 없어요', '다른 곳의 스크립트가 끼어드는 공격(XSS)을 줄여 주는 설정', '쓰는 스크립트·글꼴 출처만 허용하는 Content-Security-Policy를 넣어 주세요.');
  if (!h('x-frame-options') && !/frame-ancestors/i.test(csp)) add('frame', 'mid', '다른 사이트가 우리 페이지를 몰래 품을 수 있어요 (클릭재킹)', '', "X-Frame-Options: DENY 또는 CSP frame-ancestors 'none'을 넣어 주세요.");
  if (!/nosniff/i.test(h('x-content-type-options'))) add('nosniff', 'low', 'X-Content-Type-Options 헤더가 없어요', '', 'X-Content-Type-Options: nosniff 를 넣어 주세요.');
  if (!h('referrer-policy')) add('referrer', 'low', 'Referrer-Policy 헤더가 없어요', '다른 사이트로 넘어갈 때 주소가 그대로 전해질 수 있어요', 'Referrer-Policy: strict-origin-when-cross-origin 을 넣어 주세요.');
  if (!h('permissions-policy')) add('perm', 'info', 'Permissions-Policy 헤더가 없어요', '', '카메라·위치 등 안 쓰는 기능은 꺼 두면 좋아요.');
  for (const n of ['server', 'x-powered-by']) if (hasVer(h(n))) add('version_' + n, 'low', `서버 프로그램 버전이 보여요 (${n}: ${h(n).slice(0, 40)})`, '알려진 약점을 찾는 데 쓰일 수 있어요', '버전 표시를 끄도록 서버 설정을 바꿔 주세요.');
  const cookies = typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : (h('set-cookie') ? [h('set-cookie')] : []);
  for (const c of cookies.slice(0, 10)) {
    const name = c.split('=')[0].trim().slice(0, 30);
    if (https && !/;\s*secure/i.test(c)) add('cookie_secure_' + name, 'mid', `쿠키 "${name}"에 Secure 설정이 없어요`, '', '쿠키에 Secure를 붙여 https에서만 보내게 해 주세요.');
    if (!/;\s*httponly/i.test(c)) add('cookie_http_' + name, 'low', `쿠키 "${name}"에 HttpOnly 설정이 없어요`, '스크립트가 쿠키를 읽을 수 있어요', '로그인 쿠키라면 HttpOnly를 붙여 주세요.');
    if (!/;\s*samesite/i.test(c)) add('cookie_ss_' + name, 'low', `쿠키 "${name}"에 SameSite 설정이 없어요`, '', 'SameSite=Lax 이상을 붙여 주세요.');
  }
  if (https) {
    const mixed = [...String(home.body).matchAll(/<(?:script|img|iframe|link|source|video|audio)\b[^>]*\b(?:src|href)\s*=\s*["']http:\/\/[^"']+/gi)].length;
    if (mixed) add('mixed', 'mid', `https 페이지에서 http:// 자료 ${mixed}개를 불러와요 (혼합 콘텐츠)`, '', '이미지·스크립트 주소를 https:// 로 바꿔 주세요.');
  }
  const sec = await io.get(site + '/.well-known/security.txt', { follow: false });
  if (sec.error || sec.status !== 200 || !/contact:/i.test(sec.body)) add('securitytxt', 'info', 'security.txt가 없어요', '보안 문제를 알릴 연락처를 적어 두는 파일', '/.well-known/security.txt 에 Contact: 이메일을 적어 두면 좋아요.');
  // 소유를 인증한 사이트만: 밖에서 열리면 안 되는 파일
  if (verified) {
    const probe = [['/.git/HEAD', b => /^ref:\s/m.test(b), 'Git 저장소(.git)가 밖에서 열려요', '소스 코드와 비밀 정보가 새어 나갈 수 있어요', '웹 서버에서 .git 폴더 접근을 막고, 비밀번호·키를 바꿔 주세요.'],
      ['/.env', b => /^[A-Z0-9_]+=.+/m.test(b), '.env 설정 파일이 밖에서 열려요', 'DB 비밀번호·API 키가 보일 수 있어요', '파일 접근을 막고, 그 안의 비밀번호·키를 모두 바꿔 주세요.']];
    for (const [p, test, title, detail, fix] of probe) { const x = await io.get(site + p, { follow: false }); if (!x.error && x.status === 200 && test(x.body)) add('exposed_' + p.replace(/\W/g, ''), 'high', title, detail, fix); }
  }
  return finish(r);
}
function finish(r) {
  const score = Math.max(0, 100 - r.findings.reduce((a, f) => a + PENALTY[f.level], 0));
  r.score = score; r.grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  if (r.findings.some(f => f.id === 'down' || f.id === 'blocked')) { r.grade = '접속 안 됨'; r.score = 0; } // 접속이 안 되면 등급을 매기지 않음
  r.counts = { high: 0, mid: 0, low: 0, info: 0 }; for (const f of r.findings) r.counts[f.level]++;
  r.findings.sort((a, b) => PENALTY[b.level] - PENALTY[a.level]);
  return r;
}
const findingsText = r => r.findings.map(f => `[${LEVEL[f.level]}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}\n  → ${f.fix}`).join('\n') || '발견한 문제가 없어요.';
const countLine = r => `높음 ${r.counts.high} · 중간 ${r.counts.mid} · 낮음 ${r.counts.low}${r.counts.info ? ` · 참고 ${r.counts.info}` : ''}`;

// 소유 인증: /.well-known/hamkkebot-verify.txt 에 토큰, 또는 첫 페이지에 <meta name="hamkkebot-verify" content="토큰">
async function verify(site, token) {
  const f = await io.get(site + '/.well-known/hamkkebot-verify.txt', { follow: false });
  if (!f.error && f.status === 200 && f.body.includes(token)) return { ok: true, how: 'file' };
  const h = await io.get(site + '/');
  if (!h.error && new RegExp(`<meta[^>]+name=["']hamkkebot-verify["'][^>]+content=["']${token}["']`, 'i').test(h.body)) return { ok: true, how: 'meta' };
  return { ok: false, error: h.error || f.error || null };
}

module.exports = { normSite, scan, verify, io, LEVEL, findingsText, countLine };

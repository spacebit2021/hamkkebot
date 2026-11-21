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
    try { r = await fetch(cur, { method: opt.method || 'GET', redirect: 'manual', signal: ac.signal, headers: { 'user-agent': UA, accept: 'text/html,*/*', ...(opt.headers || {}) } }); }
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
  // 오래된 암호화 프로토콜(TLS 1.0/1.1)을 아직 받아들이는지 — 핸드셰이크만 하고 바로 끊음
  weakTls: async (host, port = 443) => {
    const one = ver => new Promise(ok => {
      let s; try { s = tls.connect({ host, port, servername: host, minVersion: ver, maxVersion: ver, timeout: 6000, rejectUnauthorized: false }, () => { s.end(); ok(true); }); }
      catch (e) { return ok(false); }
      s.on('error', () => ok(false)); s.on('timeout', () => { s.destroy(); ok(false); });
    });
    const out = []; for (const v of ['TLSv1', 'TLSv1.1']) { try { if (await one(v)) out.push(v); } catch (e) {} }
    return out;
  },
  tlsInfo: (host, port = 443) => new Promise(ok => {
    const s = tls.connect({ host, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate(); const proto = s.getProtocol(); const authorized = s.authorized; const err = s.authorizationError;
      s.end(); ok({ validTo: c && c.valid_to ? Date.parse(c.valid_to) : null, issuer: c && c.issuer ? (c.issuer.O || c.issuer.CN || '') : '', protocol: proto, authorized, error: authorized ? null : String(err || '') });
    });
    s.on('error', e => ok({ error: e.code || '연결 실패' })); s.on('timeout', () => { s.destroy(); ok({ error: '시간 초과' }); });
  })
};

const hasVer = v => /\d/.test(v || '');
async function scan(site, verified, opt = {}) {
  const F = [], add = (id, level, title, detail, fix) => F.push({ id, level, title, detail, fix });
  const u = new URL(site), https = u.protocol === 'https:';
  const r = { site, at: Date.now(), https, deep: !!opt.deep, findings: F };
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
  // 심화(긴급) 점검: 겉을 더 깊이 보는 능동 점검. 공격 페이로드·로그인 시도·부하는 하지 않음 (GET·OPTIONS만)
  if (opt.deep && verified) await deepProbe(site, add, home, https, u);
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

// 심화 점검용: 밖에서 열리면 안 되는 민감 파일·백업 (GET으로 존재와 내용 특징만 확인)
const DEEP_FILES = [
  ['/.env.bak', b => /^[A-Z0-9_]+=.+/m.test(b), 'high', '.env 백업 파일이 열려요'],
  ['/.env.save', b => /^[A-Z0-9_]+=.+/m.test(b), 'high', '.env 백업 파일이 열려요'],
  ['/wp-config.php.bak', b => /DB_(PASSWORD|NAME|USER)/.test(b), 'high', 'wp-config 백업이 열려요'],
  ['/config.php.bak', b => /password|db|secret/i.test(b), 'high', '설정 파일 백업이 열려요'],
  ['/.svn/entries', b => /svn|dir|\d+/.test(b) && b.length < 2000, 'high', 'SVN 저장소(.svn)가 열려요'],
  ['/.DS_Store', b => b.includes('Bud1') || /\u0000/.test(b), 'low', '.DS_Store 파일이 열려요 (폴더·파일 이름이 샐 수 있어요)'],
  ['/server-status', b => /Apache Server Status|Server uptime/i.test(b), 'mid', 'server-status 페이지가 열려요 (접속 정보가 보여요)'],
  ['/phpinfo.php', b => /phpinfo\(\)|PHP Version/i.test(b), 'high', 'phpinfo 페이지가 열려요 (서버 설정이 전부 보여요)'],
  ['/.htaccess', b => /RewriteEngine|Order |Deny /i.test(b), 'mid', '.htaccess 파일이 열려요'],
  ['/backup.sql', b => /INSERT INTO|CREATE TABLE/i.test(b), 'high', 'DB 백업(backup.sql)이 열려요']
];
const PANELS = [['/wp-admin/', /wp-login|wordpress/i], ['/administrator/', /joomla|administrator/i], ['/admin/', /login|password|관리/i], ['/phpmyadmin/', /phpmyadmin/i]];
// 오래된 것으로 보이는 라이브러리 (단정하지 않고 확인 요청). 알려진 보안 이슈가 있는 경계값만.
function versionFindings(home, add) {
  const body = String(home.body || '');
  const jq = body.match(/jquery[/.-]?(\d+)\.(\d+)\.(\d+)/i);
  if (jq && (+jq[1] < 3 || (+jq[1] === 3 && +jq[2] < 5))) add('old_jquery', 'mid', `오래된 jQuery ${jq[1]}.${jq[2]}.${jq[3]}을(를) 써요`, 'jQuery 3.5 아래에는 알려진 보안 문제(XSS)가 있어요', 'jQuery를 최신(3.7 이상)으로 올려 주세요.');
  const bs = body.match(/bootstrap[/.-]?(\d+)\.(\d+)\.(\d+)/i);
  if (bs) { const [a1, b1, c1] = [+bs[1], +bs[2], +bs[3]]; if ((a1 === 3 && (b1 < 4 || (b1 === 4 && c1 < 1))) || (a1 === 4 && (b1 < 3 || (b1 === 4 && c1 === 0)))) add('old_bootstrap', 'low', `오래된 Bootstrap ${bs[1]}.${bs[2]}.${bs[3]}을(를) 써요`, '', 'Bootstrap을 최신으로 올려 주세요.'); }
  const gen = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{2,50})["']/i);
  if (gen && /\d/.test(gen[1])) add('generator', 'low', `쓰는 프로그램·버전이 페이지에 보여요 (${gen[1].replace(/"/g, '')})`, '오래된 버전이면 알려진 약점을 찾는 단서가 돼요', '꼭 필요하지 않으면 generator 표시를 지우고, 버전을 최신으로 유지하세요.');
}
const LEFTOVER = [
  ['/wp-admin/install.php', b => /wordpress|install|설치/i.test(b), 'high', 'WordPress 설치 페이지가 열려 있어요', '지금 바로 접근을 막으세요. 열려 있으면 사이트를 통째로 빼앗길 수 있어요.'],
  ['/install.php', b => /install|설치|setup|데이터베이스/i.test(b), 'mid', '설치 페이지(install.php)가 남아 있어요', '설치가 끝났으면 지우거나 접근을 막으세요.'],
  ['/setup.php', b => /setup|install|설치/i.test(b), 'mid', '설치 페이지(setup.php)가 남아 있어요', '설치가 끝났으면 지우세요.'],
  ['/wp-content/debug.log', b => /PHP|Warning|Error|Stack|Deprecated/i.test(b), 'mid', 'debug.log 파일이 열려요', '디버그 로그 접근을 막고, 운영에서는 로그를 끄세요.'],
  ['/readme.html', b => /wordpress|version|버전/i.test(b), 'low', 'readme 파일로 프로그램·버전이 보여요', 'readme 파일을 지우세요.']
];
async function deepProbe(site, add, home, https, u) {
  for (const [p, test, level, title] of DEEP_FILES) { const x = await io.get(site + p, { follow: false }); if (!x.error && x.status === 200 && test(String(x.body))) add('deep_' + p.replace(/\W/g, ''), level, title, '', '웹 서버에서 이 파일 접근을 막고, 안에 있던 비밀번호·키를 모두 바꿔 주세요.'); }
  // 디렉터리 목록이 열려 있는지
  for (const d of ['/uploads/', '/images/', '/files/', '/backup/']) { const x = await io.get(site + d, { follow: false }); if (!x.error && x.status === 200 && /<title>Index of|Directory listing for/i.test(String(x.body))) add('dirlist_' + d.replace(/\W/g, ''), 'mid', `폴더 목록이 열려 있어요 (${d})`, '안에 있는 파일 이름이 모두 보여요', '웹 서버에서 디렉터리 목록(autoindex)을 꺼 주세요.'); }
  // 위험한 HTTP 메서드 (OPTIONS로 확인만)
  const o = await io.get(site + '/', { method: 'OPTIONS', body: false, follow: false });
  if (!o.error && o.headers) { const allow = (o.headers.get('allow') || '').toUpperCase(); const bad = ['PUT', 'DELETE', 'TRACE', 'CONNECT'].filter(m => allow.includes(m)); if (bad.length) add('methods', 'mid', `위험할 수 있는 HTTP 메서드가 켜져 있어요 (${bad.join(', ')})`, '', '쓰지 않는 메서드(PUT·DELETE·TRACE)는 서버에서 막아 주세요.'); }
  // 관리자·로그인 페이지 노출 (있는지만 확인, 로그인 시도 안 함)
  for (const [p, sig] of PANELS) { const x = await io.get(site + p, { follow: false }); if (!x.error && x.status === 200 && sig.test(String(x.body))) { add('panel_' + p.replace(/\W/g, ''), 'info', `관리자·로그인 페이지가 열려 있어요 (${p})`, '', '접근 IP 제한이나 2단계 인증을 두면 좋아요.'); break; } }
  // 오류 페이지에 내부 정보가 새는지 (없는 주소를 요청해 확인)
  const err = await io.get(site + '/hb-check-' + Math.random().toString(36).slice(2, 10), { follow: false });
  if (!err.error && /Traceback \(most recent|Exception|Fatal error|Warning:|SQLSTATE|at java\.|ORA-\d|stack trace|DEBUG = True/i.test(String(err.body).slice(0, 20000))) add('error_leak', 'mid', '오류 페이지에 서버 내부 정보가 보여요', '코드·경로·DB 오류가 공격 단서가 될 수 있어요', '오류 화면을 간단한 안내로 바꾸고, 운영에서는 디버그 모드를 꺼 주세요.');
  // 쓰는 프로그램·버전 (오래된 것으로 보이면 알림)
  if (home) versionFindings(home, add);
  // 남아 있는 설치·디버그 파일
  for (const [p, test, level, title, fix] of LEFTOVER) { const x = await io.get(site + p, { follow: false }); if (!x.error && x.status === 200 && test(String(x.body))) add('left_' + p.replace(/\W/g, ''), level, title, '', fix); }
  // 오픈 리다이렉트: 주소를 바꿔 다른 사이트로 넘기는지 (넘어가는지 확인만)
  for (const pr of ['next', 'url', 'redirect', 'return', 'returnUrl', 'dest', 'continue', 'u']) {
    const x = await io.get(`${site}/?${pr}=https://hb-redirect-test.example/`, { follow: false, body: false });
    if (!x.error && x.status >= 300 && x.status < 400 && /^https?:\/\/hb-redirect-test\.example/i.test(x.location || '')) { add('open_redirect', 'mid', `주소를 바꿔 다른 사이트로 넘길 수 있어요 (오픈 리다이렉트, ?${pr}=)`, '가짜 사이트로 유도하는 피싱에 쓰일 수 있어요', '넘기는 주소를 우리 사이트 안으로만 허용하세요.'); break; }
  }
  // 오래된 암호화 프로토콜을 아직 받아들이는지
  if (https) { const weak = await io.weakTls(u.hostname, +u.port || 443); if (weak && weak.length) add('weak_tls', 'mid', `오래된 암호화 프로토콜을 아직 받아들여요 (${weak.join(', ')})`, '', 'TLS 1.2 이상만 허용하도록 서버를 설정하세요.'); }
  // CORS 설정이 위험한지
  const cors = await io.get(site + '/', { headers: { origin: 'https://hb-cors-test.example' }, body: false, follow: false });
  if (!cors.error && cors.headers) { const acao = cors.headers.get('access-control-allow-origin'), cred = /true/i.test(cors.headers.get('access-control-allow-credentials') || ''); if (acao === 'https://hb-cors-test.example' && cred) add('cors', 'high', '아무 사이트나 우리 API를 쓸 수 있게 열려 있어요 (CORS)', '다른 사이트가 로그인된 사용자 정보를 가져갈 수 있어요', '허용할 출처만 지정하고, credentials를 함께 허용하지 마세요.'); else if (acao === '*') add('cors_any', 'low', 'CORS가 모든 출처에 열려 있어요 (*)', '', '공개 API가 아니면 허용 출처를 좁혀 주세요.'); }
}

module.exports = { normSite, scan, verify, io, LEVEL, findingsText, countLine };

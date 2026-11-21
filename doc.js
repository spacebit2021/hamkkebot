// 기업 정보 문서(HTML) 도우미 — 외부 패키지 없음
// 전문가가 올린 HTML이나 AI가 만든 HTML을 그대로 화면에 넣으면 스크립트가 실행될 수 있으므로,
// 허용 목록에 있는 태그·속성만 남기고 나머지는 지운다. (스크립트·스타일·이벤트 속성·javascript: 링크 제거)
'use strict';

const MAX_HTML = 300 * 1024;
const ALLOWED = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 's',
  'mark', 'small', 'sub', 'sup', 'code', 'pre', 'blockquote', 'a', 'span', 'div', 'section', 'article', 'header', 'footer',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'dl', 'dt', 'dd']);
const VOID = new Set(['br', 'hr']);
// 내용째 지울 태그
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|noscript|svg|math|head|title|textarea|select|button|form|frameset|frame|applet|video|audio|canvas)\b[\s\S]*?<\/\1\s*>/gi;
const ATTRS = { a: ['href', 'title'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], ol: ['start'] };

const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeHref(v) {
  const t = String(v).replace(/[\u0000- \u007f-\u009f]/g, '');
  return /^(https?:\/\/|mailto:|#)/i.test(t) ? t : null;
}

function sanitizeHtml(input) {
  let s = String(input || '');
  if (s.length > MAX_HTML) s = s.slice(0, MAX_HTML);
  const body = s.match(/<body\b[^>]*>([\s\S]*?)(<\/body\s*>|$)/i);
  if (body) s = body[1];
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  let prev; do { prev = s; s = s.replace(DROP_WITH_CONTENT, ''); } while (s !== prev);

  const out = [], open = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|<|>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    out.push(s.slice(last, m.index)); last = re.lastIndex;
    if (m[0] === '<') { out.push('&lt;'); continue; }
    if (m[0] === '>') { out.push('&gt;'); continue; }
    const tag = m[1].toLowerCase(), closing = m[0][1] === '/';
    if (!ALLOWED.has(tag)) continue; // 모르는 태그는 태그만 지우고 안의 글은 남김
    if (closing) {
      const i = open.lastIndexOf(tag);
      if (i === -1) continue;
      while (open.length > i) out.push(`</${open.pop()}>`);
      continue;
    }
    const keep = [];
    const allow = ATTRS[tag] || [];
    const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let a;
    while ((a = ar.exec(m[2]))) {
      const name = a[1].toLowerCase();
      if (!allow.includes(name) || a[2] === undefined) continue;
      let v = a[2].replace(/^["']|["']$/g, '');
      v = v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      if (name === 'href') { v = safeHref(v); if (!v) continue; }
      if (['colspan', 'rowspan', 'start'].includes(name) && !/^\d{1,3}$/.test(v)) continue;
      if (name === 'scope' && !/^(row|col|rowgroup|colgroup)$/.test(v)) continue;
      keep.push(`${name}="${escapeHtml(v)}"`);
    }
    if (tag === 'a' && keep.some(k => k.startsWith('href='))) keep.push('rel="noopener noreferrer"', 'target="_blank"');
    out.push(`<${tag}${keep.length ? ' ' + keep.join(' ') : ''}>`);
    if (!VOID.has(tag)) open.push(tag);
  }
  out.push(s.slice(last));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('').trim();
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-4]|li|tr|section|article|header|footer|blockquote|pre|dt|dd)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 내려받는 파일용 완성 문서. 다시 올릴 때는 <body> 안쪽만 읽는다.
const DOC_CSS = `body{max-width:820px;margin:32px auto;padding:0 20px;font:16px/1.65 "Noto Sans KR",system-ui,sans-serif;color:#16171d}
h1{font-size:30px;margin:0 0 6px}h2{font-size:21px;margin:30px 0 10px;padding-top:14px;border-top:1px solid #e2e4ec}h3{font-size:17px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e4ec;padding:6px 10px;text-align:left;vertical-align:top}
blockquote{margin:0;padding:8px 14px;border-left:3px solid #2d45e8;background:#f3f4f8}mark{background:#fff1b8}`;
function wrapDocument(title, fragment, meta) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
<!-- 함께봇 기업 정보 문서${meta ? ' · ' + escapeHtml(meta) : ''}. 이 파일을 고친 뒤 텔레그램 함께봇 대화에 다시 올리면 기업이 확인 후 반영합니다. 스크립트·스타일은 반영되지 않아요. -->
${fragment}
</body>
</html>
`;
}

function defaultDoc(org) {
  const f = (label, v) => `<p><b>${label}</b> ${v ? escapeHtml(v) : '<mark>[확인 필요]</mark>'}</p>`;
  return sanitizeHtml(`<h1>${escapeHtml(org.name || '우리 기업')}</h1>
<h2>기업 개요</h2>${f('소셜미션:', org.mission)}${f('주요 제품·서비스:', org.product)}${f('주요 고객:', org.target)}${f('원하는 말투:', org.tone)}
<h2>현재 과제·요청사항</h2><p><mark>[확인 필요]</mark></p>
<h2>상담에서 정해진 것</h2><ul><li>아직 없음</li></ul>
<h2>확인이 필요한 정보</h2><ul><li>대표 연락처, 인증·수상 내역 등은 사실 확인 후 적어 주세요.</li></ul>`);
}

// ---------- 랜딩페이지(완성 HTML 문서) 정리기 ----------
// 홈페이지 봇이 만든 페이지는 공개 주소로 나가므로, 스크립트·외부 리소스를 모두 뺀다.
// (서버는 추가로 CSP sandbox 헤더를 붙여서, 혹시 남은 것이 있어도 실행되지 않게 한다)
const MAX_PAGE = 400 * 1024;
const PAGE_TAGS = new Set([...ALLOWED, 'html', 'head', 'body', 'meta', 'title', 'link', 'nav', 'main', 'aside', 'figure', 'figcaption',
  'h5', 'h6', 'img', 'address', 'time', 'abbr', 'cite', 'q', 'del', 'ins', 'kbd', 'samp', 'var', 'wbr', 'picture', 'details', 'summary']);
const PAGE_VOID = new Set(['br', 'hr', 'meta', 'link', 'img', 'wbr']);
const PAGE_DROP = /<(script|iframe|object|embed|template|noscript|svg|math|textarea|select|form|frameset|frame|applet|video|audio|canvas|base|portal)\b[\s\S]*?<\/\1\s*>/gi;
const PAGE_DROP_OPEN = /<\/?(script|iframe|object|embed|template|noscript|svg|math|textarea|select|form|input|button|frameset|frame|applet|video|audio|canvas|base|portal|source|track)\b[^>]*>/gi;
const GLOBAL_ATTRS = ['class', 'id', 'title', 'role', 'lang', 'dir', 'style'];
const PAGE_ATTRS = { a: ['href'], img: ['src', 'alt', 'width', 'height', 'loading'], meta: ['name', 'content', 'charset', 'property'],
  link: ['rel', 'href'], html: ['lang'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], ol: ['start'], time: ['datetime'], details: ['open'] };

function cleanCss(css) {
  return String(css)
    .replace(/<\/?/g, '')                              // </style> 탈출 방지
    .replace(/@import[^;]*;?/gi, '')                    // 외부 CSS 끌어오기 금지
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/(java|vb)script\s*:/gi, '')
    .replace(/behavior\s*:/gi, 'x:').replace(/-moz-binding/gi, 'x')
    .replace(/url\s*\(\s*(?!["']?data:image\/(png|jpe?g|gif|webp);)[^)]*\)/gi, 'none'); // data:image 외 url() 금지
}
function pageAttr(tag, name, v) {
  if (name === 'style') return /expression\s*\(|javascript:|url\s*\(|@import|behavior\s*:/i.test(v) ? null : v;
  if (name === 'href' && tag === 'a') { const t = String(v).replace(/[\u0000- \u007f-\u009f]/g, ''); return /^(https?:\/\/|mailto:|tel:|#)/i.test(t) ? t : null; }
  if (name === 'href' && tag === 'link') return /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(v) ? v : null;
  if (name === 'rel') return /^(stylesheet|preconnect)$/i.test(v) ? v : null;
  if (name === 'src') return /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v) ? v : null;
  if (['width', 'height', 'colspan', 'rowspan', 'start'].includes(name)) return /^\d{1,4}$/.test(v) ? v : null;
  if (name === 'loading') return /^(lazy|eager)$/.test(v) ? v : null;
  if (name === 'scope') return /^(row|col|rowgroup|colgroup)$/.test(v) ? v : null;
  if (name === 'charset') return /^utf-?8$/i.test(v) ? v : null;
  if (tag === 'meta' && name === 'name' && /^http-equiv$/i.test(v)) return null;
  return v;
}
function sanitizePage(input) {
  let s = String(input || '').replace(/\u0000/g, '');
  if (s.length > MAX_PAGE) return '';
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  let prev; do { prev = s; s = s.replace(PAGE_DROP, ''); } while (s !== prev);
  s = s.replace(PAGE_DROP_OPEN, '');
  // <style> 내용은 따로 꺼내 정리 후 다시 넣음 (CSS의 > 기호가 깨지지 않게)
  const styles = [];
  s = s.replace(/<style\b[^>]*>([\s\S]*?)(<\/style\s*>|$)/gi, (_, css) => { styles.push(cleanCss(css)); return `\u0000S${styles.length - 1}\u0000`; });
  const out = [], open = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|<|>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    out.push(s.slice(last, m.index)); last = re.lastIndex;
    if (m[0] === '<') { out.push('&lt;'); continue; }
    if (m[0] === '>') { out.push('&gt;'); continue; }
    const tag = m[1].toLowerCase(), closing = m[0][1] === '/';
    if (!PAGE_TAGS.has(tag)) continue;
    if (closing) { const i = open.lastIndexOf(tag); if (i === -1) continue; while (open.length > i) out.push(`</${open.pop()}>`); continue; }
    const keep = [], allow = [...GLOBAL_ATTRS, ...(PAGE_ATTRS[tag] || [])];
    const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let a;
    while ((a = ar.exec(m[2]))) {
      const name = a[1].toLowerCase();
      if (a[2] === undefined) { if (name === 'open' && tag === 'details') keep.push('open'); continue; }
      if (!allow.includes(name) && !/^aria-[a-z]+$/.test(name)) continue;
      let v = a[2].replace(/^["']|["']$/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      v = pageAttr(tag, name, v); if (v == null) continue;
      keep.push(`${name}="${escapeHtml(v)}"`);
    }
    if (tag === 'a' && keep.some(k => /^href="https?:/.test(k))) keep.push('rel="noopener noreferrer"', 'target="_blank"');
    if (tag === 'link' && !(keep.some(k => k.startsWith('href=')) && keep.some(k => k.startsWith('rel=')))) continue;
    if (tag === 'meta' && !keep.some(k => /^(name|charset|property)=/.test(k))) continue;
    if (tag === 'img' && !keep.some(k => k.startsWith('src='))) continue;
    out.push(`<${tag}${keep.length ? ' ' + keep.join(' ') : ''}>`);
    if (!PAGE_VOID.has(tag)) open.push(tag);
  }
  out.push(s.slice(last));
  while (open.length) out.push(`</${open.pop()}>`);
  let html = out.join('').replace(/\u0000S(\d+)\u0000/g, (_, i) => `<style>${styles[+i]}</style>`).trim();
  if (!/<body[\s>]/i.test(html) || !/<\/body>/i.test(html)) return '';
  if (!/name="viewport"/i.test(html)) html = html.replace(/<head[^>]*>/i, h => `${h}<meta name="viewport" content="width=device-width, initial-scale=1">`);
  if (!/<meta charset/i.test(html)) html = html.replace(/<head[^>]*>/i, h => `${h}<meta charset="utf-8">`);
  return '<!DOCTYPE html>\n' + html + '\n';
}
const pageTitle = html => ((String(html).match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();

module.exports = { sanitizeHtml, htmlToText, wrapDocument, defaultDoc, escapeHtml, MAX_HTML, sanitizePage, pageTitle };

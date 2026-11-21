// IR 자료 HTML 슬라이드 (기업 화면·전문가 페이지 공용)
// deck.js(PPTX)와 같은 좌표(13.333 x 7.5인치)를 %로 바꿔 그려서, 웹에서 본 것과 최종 PPTX가 같은 모양이 되게 한다.
(function () {
  const PAL = {
    terracotta: { dark: '7A3328', accent: 'C8613F', tint: 'F7ECE8', ink: '2B1D19', soft: 'E9C2B4' },
    forest: { dark: '23472A', accent: '4E8A3E', tint: 'EAF3E6', ink: '1C2A1E', soft: 'BFD9B2' },
    teal: { dark: '0B4F57', accent: '138A82', tint: 'E4F4F2', ink: '14292B', soft: 'A9DCD6' },
    berry: { dark: '5B2440', accent: 'A8466B', tint: 'F6E8EE', ink: '2A1520', soft: 'E2B5C6' },
    navy: { dark: '1E2761', accent: '3F58C4', tint: 'E8ECFA', ink: '161B33', soft: 'BCC7F2' },
    sunflower: { dark: '4A3A0A', accent: 'B7860B', tint: 'FBF3DC', ink: '2A220A', soft: 'EED89A' }
  };
  const W = 13.333, H = 7.5, M = 0.7;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // [확인 필요...] 표시는 노란 형광으로
  const t = s => esc(s).replace(/\[확인 필요[^\]]*\]/g, m => `<mark>${m}</mark>`);
  const pt = n => `${(n * 0.1042).toFixed(3)}cqw`;
  const box = (x, y, w, h, extra = '') => `left:${(x / W * 100).toFixed(2)}%;top:${(y / H * 100).toFixed(2)}%;width:${(w / W * 100).toFixed(2)}%;height:${(h / H * 100).toFixed(2)}%;${extra}`;
  const txt = (x, y, w, h, size, html, extra = '') => `<div class="irs-t" style="${box(x, y, w, h)}font-size:${pt(size)};${extra}">${html}</div>`;
  const circle = (x, y, d, fill, label) => `<div class="irs-c" style="${box(x, y, d, d)}background:#${fill};font-size:${pt(d * 30)}">${esc(label)}</div>`;
  const rrect = (x, y, w, h, fill) => `<div class="irs-r" style="${box(x, y, w, h)}background:#${fill}"></div>`;

  function slide(s, i, P, org, total) {
    const title = `<div class="irs-t irs-title" style="${box(M, 0.45, W - 2 * M, 0.95)}font-size:${pt(32)};color:#${P.ink};font-weight:800;display:flex;align-items:center">${t(s.title)}</div>`;
    const foot = `<div class="irs-t" style="${box(M, H - 0.55, 6, 0.3)}font-size:${pt(10)};color:#8a8a8a">${esc(org)}</div><div class="irs-t" style="${box(W - M - 0.6, H - 0.55, 0.6, 0.3)}font-size:${pt(10)};color:#8a8a8a;text-align:right">${i + 1}</div>`;
    let bg = 'FFFFFF', body = '';
    if (s.kind === 'title' || s.kind === 'closing') {
      bg = P.dark;
      body += `<div class="irs-o" style="${box(W - 4.2, -1.6, 5.6, 5.6)}background:#${P.accent};opacity:.65"></div><div class="irs-o" style="${box(W - 2.3, 3.6, 2.6, 2.6)}background:#${P.soft};opacity:.45"></div>`;
      if (s.kind === 'title') {
        body += txt(M, 1.1, 7.5, 0.45, 16, esc(org), `color:#${P.soft};font-weight:700`);
        body += txt(M, 2.2, 7.9, 2.0, 44, t(s.title), 'color:#fff;font-weight:800');
        if (s.subtitle) body += txt(M, 4.45, 7.9, 1.1, 20, t(s.subtitle), 'color:#f2f2f2');
      } else {
        body += txt(M, 2.0, 7.9, 1.4, 40, t(s.title), 'color:#fff;font-weight:800');
        if (s.message) body += txt(M, 3.6, 7.9, 1.3, 20, t(s.message), 'color:#f2f2f2');
        if (s.caption) body += txt(M, 5.3, 7.9, 0.6, 14, t(s.caption), `color:#${P.soft}`);
      }
      return { bg, html: body };
    }
    if (s.kind === 'message') {
      bg = P.tint;
      body += circle(W / 2 - 0.45, 1.2, 0.9, P.accent, '“');
      body += txt(M + 1, 2.35, W - 2 * M - 2, 0.6, 18, t(s.title), `color:#${P.accent};font-weight:700;text-align:center`);
      body += txt(M + 1, 3.05, W - 2 * M - 2, 2.2, 32, t(s.message || s.title), `color:#${P.dark};font-weight:800;text-align:center;display:flex;align-items:center;justify-content:center`);
      if (s.caption) body += txt(M + 1, 5.4, W - 2 * M - 2, 0.6, 14, t(s.caption), 'color:#6b6b6b;text-align:center');
      return { bg, html: body + `<div class="irs-t" style="${box(W - M - 0.6, H - 0.55, 0.6, 0.3)}font-size:${pt(10)};color:#8a8a8a;text-align:right">${i + 1}</div>` };
    }
    body += title + foot;
    if (s.kind === 'bullets') {
      body += txt(M, 1.85, 7.4, 4.5, s.bullets.length > 3 ? 18 : 20, `<ul>${s.bullets.map(b => `<li>${t(b)}</li>`).join('')}</ul>`, `color:#${P.ink}`);
      body += rrect(8.75, 1.75, 3.88, 4.3, P.tint) + circle(9.15, 2.15, 0.8, P.accent, '“');
      body += txt(9.15, 3.2, 3.1, 2.5, 22, t(s.highlight || s.bullets[0]), `color:#${P.dark};font-weight:700`);
    } else if (s.kind === 'cards') {
      const n = s.items.length, gap = 0.35, cw = (W - 2 * M - gap * (n - 1)) / n;
      s.items.forEach((it, k) => {
        const x = M + k * (cw + gap);
        body += rrect(x, 1.85, cw, 4.4, P.tint) + circle(x + 0.35, 2.2, 0.75, P.accent, k + 1);
        body += txt(x + 0.35, 3.2, cw - 0.7, 0.9, 20, t(it.head), `color:#${P.dark};font-weight:700`);
        body += txt(x + 0.35, 4.1, cw - 0.7, 1.95, n === 4 ? 14 : 16, t(it.text), `color:#${P.ink}`);
      });
    } else if (s.kind === 'steps') {
      const n = s.items.length, gap = 0.3, cw = (W - 2 * M - gap * (n - 1)) / n, d = 0.85, cy = 2.05;
      body += `<div class="irs-l" style="${box(M + cw / 2, cy + d / 2 - 0.02, (n - 1) * (cw + gap), 0.04)}background:#${P.soft}"></div>`;
      s.items.forEach((it, k) => {
        const x = M + k * (cw + gap);
        body += circle(x + cw / 2 - d / 2, cy, d, k === n - 1 ? P.dark : P.accent, k + 1);
        body += txt(x, 3.15, cw, 0.8, 18, t(it.head), `color:#${P.dark};font-weight:700;text-align:center`);
        body += txt(x + 0.1, 3.95, cw - 0.2, 2.2, n === 5 ? 14 : 15, t(it.text), `color:#${P.ink}`);
      });
    } else if (s.kind === 'stats') {
      const n = s.stats.length, gap = 0.35, cw = (W - 2 * M - gap * (n - 1)) / n;
      s.stats.forEach((st, k) => {
        const x = M + k * (cw + gap), len = [...st.value].length;
        const size = Math.max(20, Math.min(n === 4 ? 40 : 48, Math.floor(((cw - 0.6) / Math.max(len, 1)) / 0.0139 * 0.92)));
        body += rrect(x, 2.0, cw, 3.2, P.tint);
        body += txt(x + 0.3, 2.45, cw - 0.6, 1.3, size, t(st.value), `color:#${P.accent};font-weight:800;display:flex;align-items:center`);
        body += txt(x + 0.3, 3.85, cw - 0.6, 1.1, 16, t(st.label), `color:#${P.ink}`);
      });
      if (s.caption) body += txt(M, 5.6, W - 2 * M, 0.5, 13, t(s.caption), 'color:#6b6b6b');
    } else if (s.kind === 'table') {
      body += `<div class="irs-t" style="${box(M, 1.8, W - 2 * M, 4.8)}font-size:${pt(s.rows.length > 4 ? 14 : 16)}"><table><thead><tr>${s.columns.map(c => `<th style="background:#${P.accent}">${t(c)}</th>`).join('')}</tr></thead><tbody>${s.rows.map((r, ri) => `<tr>${r.map(c => `<td style="background:#${ri % 2 ? 'fff' : P.tint};color:#${P.ink}">${t(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return { bg, html: body };
  }

  const CSS = `.irs-deck{display:flex;flex-direction:column;gap:18px}
.irs-wrap{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start}
.irs{position:relative;aspect-ratio:16/9;container-type:inline-size;overflow:hidden;border-radius:10px;box-shadow:0 6px 22px -14px rgba(0,0,0,.45);border:1px solid rgba(0,0,0,.08);font-family:"Malgun Gothic","Noto Sans KR",system-ui,sans-serif}
.irs>div{position:absolute;box-sizing:border-box}
.irs-t{line-height:1.3;overflow:hidden;overflow-wrap:anywhere;word-break:keep-all}
.irs-t ul{margin:0;padding-left:1.1em}.irs-t li{margin:0 0 .8em}
.irs-t table{width:100%;border-collapse:collapse}.irs-t th{color:#fff;text-align:left;padding:.45em .5em;border:1px solid #fff}.irs-t td{padding:.45em .5em;border:1px solid #fff}
.irs-c{border-radius:50%;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center}
.irs-r{border-radius:2.2cqw}.irs-o{border-radius:50%}
.irs mark{background:#fff1b8;color:#3a2a00;border-radius:3px}
.irs-cm{border:1.5px solid var(--line,#e2e4ec);border-radius:12px;padding:10px 12px;font-size:14px;background:var(--card,#fff)}
.irs-cm h5{margin:0 0 6px;font-size:13px;color:var(--mute,#5d6170)}
.irs-cm ul{list-style:none;margin:0 0 8px;padding:0;max-height:220px;overflow:auto}.irs-cm li{padding:6px 0;border-bottom:1px solid var(--line,#e2e4ec)}
.irs-cm li.done{opacity:.6}.irs-cm .who{font-size:12px;color:var(--mute,#5d6170)}.irs-cm .rep{font-size:12px;color:#06784f}
.irs-cm textarea{width:100%;min-height:54px;border-radius:10px;border:1.5px solid var(--line,#e2e4ec);padding:8px;font:inherit;background:var(--bg,#fff);color:inherit;resize:vertical}
.irs-cm .irs-dis{background:none;color:var(--mute,#5d6170);border:1.5px solid var(--line,#e2e4ec);min-height:30px;font-weight:500;font-size:12px}
.irs-cm button{margin-top:6px;min-height:38px;border-radius:19px;border:0;background:var(--pri,#2d45e8);color:var(--pri-ink,#fff);font-weight:700;padding:0 14px;cursor:pointer}
@media(max-width:900px){.irs-wrap{grid-template-columns:minmax(0,1fr)}}`;
  function injectCss() { if (document.getElementById('irs-css')) return; const st = document.createElement('style'); st.id = 'irs-css'; st.textContent = CSS; document.head.appendChild(st); }

  // outline: {title, palette, slides}, opts: { org, comments:[{id,slide,text,by,status,reply,versionN}], commenting: true }
  function render(outline, opts = {}) {
    injectCss();
    const P = PAL[outline.palette] || PAL.teal, cms = opts.comments || [];
    return `<div class="irs-deck">${outline.slides.map((s, i) => {
      const r = slide(s, i, P, opts.org || '', outline.slides.length);
      const mine = cms.filter(c => c.slide === i);
      const panel = opts.commenting === false ? '' : `<div class="irs-cm"><h5>${i + 1}장 코멘트 ${mine.filter(c => c.status === 'open').length ? `· 반영 전 ${mine.filter(c => c.status === 'open').length}개` : ''}</h5><ul>${mine.map(c => `<li class="${c.status === 'open' ? '' : 'done'}"><div class="who">${esc(c.by.name)}${c.by.kind === 'expert' ? ' 전문가' : ''} · v${c.versionN}${c.status === 'applied' ? ' · 반영됨' : c.status === 'dismissed' ? ' · 반영 안 함' : ''}</div>${esc(c.text)}${c.reply ? `<div class="rep">↳ ${esc(c.reply)}</div>` : ''}${opts.dismiss && c.status === 'open' ? `<div><button type="button" class="irs-dis" data-irc-dismiss="${esc(c.id)}">반영 안 함</button></div>` : ''}</li>`).join('') || '<li class="done">아직 코멘트가 없어요</li>'}</ul><textarea data-irc-text="${i}" maxlength="500" placeholder="이 장에 대한 의견"></textarea><button type="button" data-irc-send="${i}">코멘트 남기기</button></div>`;
      return `<section class="irs-wrap" id="irs-${i}"><div class="irs" style="background:#${r.bg}">${r.html}</div>${panel}</section>`;
    }).join('')}</div>`;
  }
  window.IRView = { render, PAL };
})();

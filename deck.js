// 마케팅 봇 PPT: Claude가 만든 '개요(JSON)'를 받아 .pptx 파일을 만든다.
// 개요는 정해진 슬라이드 종류만 쓰고 글자 수를 제한해서, 어떤 내용이 와도 슬라이드 밖으로 넘치지 않게 한다.
'use strict';
const PptxGenJS = require('pptxgenjs');

// 기업 분위기에 맞춰 봇이 고르는 색 조합 (dark: 제목·마무리 배경, accent: 번호 원·강조, tint: 카드 바탕, ink: 본문 글자)
const PALETTES = {
  terracotta: { dark: '7A3328', accent: 'C8613F', tint: 'F7ECE8', ink: '2B1D19', soft: 'E9C2B4' },
  forest: { dark: '23472A', accent: '4E8A3E', tint: 'EAF3E6', ink: '1C2A1E', soft: 'BFD9B2' },
  teal: { dark: '0B4F57', accent: '138A82', tint: 'E4F4F2', ink: '14292B', soft: 'A9DCD6' },
  berry: { dark: '5B2440', accent: 'A8466B', tint: 'F6E8EE', ink: '2A1520', soft: 'E2B5C6' },
  navy: { dark: '1E2761', accent: '3F58C4', tint: 'E8ECFA', ink: '161B33', soft: 'BCC7F2' },
  sunflower: { dark: '4A3A0A', accent: 'B7860B', tint: 'FBF3DC', ink: '2A220A', soft: 'EED89A' }
};
const FONT = 'Malgun Gothic'; // 한국어 Windows 기본 글꼴 (Mac PowerPoint는 비슷한 한글 글꼴로 바꿔 보여 줌)
const KINDS = ['title', 'bullets', 'cards', 'steps', 'message', 'closing', 'stats', 'table'];
// 슬라이드 종류별 글자 수 상한 (넘치면 자르고 … 표시)
const LIM = { title: 28, subtitle: 50, bullet: 60, head: 16, text: 64, highlight: 22, message: 70, caption: 60, note: 600, value: 12, label: 26, col: 14, cell: 26 };

const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

// Claude가 준 JSON을 검사·정리. 잘못되면 { error }
function normalizeOutline(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    const t = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return { error: '개요(JSON)를 찾지 못했어요' };
    try { o = JSON.parse(t.slice(a, b + 1)); } catch (e) { return { error: '개요(JSON)를 읽지 못했어요' }; }
  }
  if (!o || !Array.isArray(o.slides)) return { error: '슬라이드 목록이 없어요' };
  const slides = [];
  for (const s of o.slides.slice(0, 14)) {
    const kind = KINDS.includes(s.kind) ? s.kind : 'bullets';
    const x = { kind, title: cut(s.title, LIM.title), note: cut(s.note, LIM.note) };
    if (!x.title) continue;
    if (kind === 'title') x.subtitle = cut(s.subtitle, LIM.subtitle);
    if (kind === 'bullets') {
      x.bullets = (Array.isArray(s.bullets) ? s.bullets : []).map(b => cut(b, LIM.bullet)).filter(Boolean).slice(0, 5);
      x.highlight = cut(s.highlight, LIM.highlight);
      if (x.bullets.length < 2) continue;
    }
    if (kind === 'cards' || kind === 'steps') {
      x.items = (Array.isArray(s.items) ? s.items : []).map(i => ({ head: cut(i && i.head, LIM.head), text: cut(i && i.text, LIM.text) })).filter(i => i.head).slice(0, kind === 'cards' ? 4 : 5);
      if (x.items.length < 2) continue;
    }
    if (kind === 'message' || kind === 'closing') { x.message = cut(s.message, LIM.message); x.caption = cut(s.caption, LIM.caption); }
    if (kind === 'stats') { // 큰 숫자 2~4개 (숫자는 기업 자료에 있는 것만 쓰도록 봇에 지시)
      x.stats = (Array.isArray(s.stats) ? s.stats : []).map(t => ({ value: cut(t && t.value, LIM.value), label: cut(t && t.label, LIM.label) })).filter(t => t.value).slice(0, 4);
      x.caption = cut(s.caption, LIM.caption);
      if (x.stats.length < 2) continue;
    }
    if (kind === 'table') { // 표: 열 2~5개, 행 1~6개
      x.columns = (Array.isArray(s.columns) ? s.columns : []).map(c => cut(c, LIM.col)).slice(0, 5);
      x.rows = (Array.isArray(s.rows) ? s.rows : []).filter(Array.isArray).slice(0, 6).map(r => x.columns.map((_, i) => cut(r[i], LIM.cell)));
      if (x.columns.length < 2 || !x.rows.length) continue;
    }
    slides.push(x);
  }
  if (slides.length < 3) return { error: '슬라이드가 너무 적어요 (3장 이상 필요)' };
  if (slides[0].kind !== 'title') slides.unshift({ kind: 'title', title: cut(o.title || slides[0].title, LIM.title), subtitle: cut(o.subtitle, LIM.subtitle), note: '' });
  const checks = (Array.isArray(o.checks) ? o.checks : []).map(c => cut(c, 120)).filter(Boolean).slice(0, 3);
  return { outline: { title: cut(o.title || slides[0].title, 40), palette: PALETTES[o.palette] ? o.palette : 'teal', slides, checks } };
}

// 개요 → .pptx Buffer
async function buildDeck(outline, orgName) {
  const P = PALETTES[outline.palette] || PALETTES.teal;
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };
  pres.title = outline.title;
  pres.author = '함께봇 마케팅 매니저 봇';
  const W = 13.333, H = 7.5, M = 0.7;
  const footer = cut(orgName || '', 30);

  pres.defineSlideMaster({ title: 'HB_DARK', background: { color: P.dark }, objects: [], slideNumber: undefined });
  pres.defineSlideMaster({
    title: 'HB_CONTENT', background: { color: 'FFFFFF' },
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.45, w: W - 2 * M, h: 0.95, fontFace: FONT, fontSize: 32, bold: true, color: P.ink, align: 'left', valign: 'middle', margin: 0 }, text: '' } },
      { text: { text: footer, options: { x: M, y: H - 0.55, w: 6, h: 0.3, fontFace: FONT, fontSize: 10, color: '8A8A8A', margin: 0 } } }
    ],
    slideNumber: { x: W - M - 0.6, y: H - 0.55, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: '8A8A8A', align: 'right' }
  });
  pres.defineSlideMaster({ title: 'HB_TINT', background: { color: P.tint }, objects: [], slideNumber: { x: W - M - 0.6, y: H - 0.55, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: '8A8A8A', align: 'right' } });

  // 번호 원 (이 덱의 시각 모티프)
  const numCircle = (slide, n, x, y, d, fill, color) => {
    slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: n === '“' ? '인용 표시' : `번호 ${n}` });
    slide.addText(String(n), { x, y, w: d, h: d, align: 'center', valign: 'middle', fontFace: FONT, fontSize: Math.round(d * 30), bold: true, color, margin: 0, isTextBox: true });
  };
  const content = s => { const sl = pres.addSlide({ masterName: 'HB_CONTENT' }); sl.addText(s.title, { placeholder: 'title' }); return sl; };

  outline.slides.forEach((s, idx) => {
    let sl;
    if (s.kind === 'title' || s.kind === 'closing') {
      sl = pres.addSlide({ masterName: 'HB_DARK' });
      // 오른쪽 위로 걸친 큰 원 두 개 (장식)
      sl.addShape(pres.shapes.OVAL, { x: W - 4.2, y: -1.6, w: 5.6, h: 5.6, fill: { color: P.accent, transparency: 35 }, line: { color: P.accent, transparency: 35 }, objectName: '장식 원 큰' });
      sl.addShape(pres.shapes.OVAL, { x: W - 2.3, y: 3.6, w: 2.6, h: 2.6, fill: { color: P.soft, transparency: 55 }, line: { color: P.soft, transparency: 55 }, objectName: '장식 원 작은' });
      if (s.kind === 'title') {
        sl.addText(footer, { x: M, y: 1.1, w: 7.5, h: 0.45, fontFace: FONT, fontSize: 16, bold: true, color: P.soft, margin: 0, isTextBox: true });
        sl.addText(s.title, { x: M, y: 2.2, w: 7.9, h: 2.0, fontFace: FONT, fontSize: 44, bold: true, color: 'FFFFFF', valign: 'top', margin: 0, isTextBox: true });
        if (s.subtitle) sl.addText(s.subtitle, { x: M, y: 4.45, w: 7.9, h: 1.1, fontFace: FONT, fontSize: 20, color: 'F2F2F2', valign: 'top', margin: 0, isTextBox: true });
      } else {
        sl.addText(s.title, { x: M, y: 2.0, w: 7.9, h: 1.4, fontFace: FONT, fontSize: 40, bold: true, color: 'FFFFFF', valign: 'top', margin: 0, isTextBox: true });
        if (s.message) sl.addText(s.message, { x: M, y: 3.6, w: 7.9, h: 1.3, fontFace: FONT, fontSize: 20, color: 'F2F2F2', valign: 'top', margin: 0, isTextBox: true });
        if (s.caption) sl.addText(s.caption, { x: M, y: 5.3, w: 7.9, h: 0.6, fontFace: FONT, fontSize: 14, color: P.soft, margin: 0, isTextBox: true });
      }
    } else if (s.kind === 'bullets') {
      sl = content(s);
      const items = s.bullets.map((b, i) => ({ text: b, options: { bullet: { indent: 20 }, breakLine: i < s.bullets.length - 1, paraSpaceAfter: 16 } }));
      sl.addText(items, { x: M, y: 1.85, w: 7.4, h: 4.5, fontFace: FONT, fontSize: s.bullets.length > 3 ? 18 : 20, color: P.ink, valign: 'top', margin: 0, isTextBox: true });
      // 오른쪽: 핵심 한마디 카드
      sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 8.75, y: 1.75, w: 3.88, h: 4.3, fill: { color: P.tint }, line: { color: P.tint }, rectRadius: 0.2, objectName: '핵심 카드' });
      numCircle(sl, '“', 9.15, 2.15, 0.8, P.accent, 'FFFFFF');
      sl.addText(s.highlight || s.bullets[0], { x: 9.15, y: 3.2, w: 3.1, h: 2.5, fontFace: FONT, fontSize: 22, bold: true, color: P.dark, valign: 'top', margin: 0, isTextBox: true });
    } else if (s.kind === 'cards') {
      sl = content(s);
      const n = s.items.length, gap = 0.35, cw = (W - 2 * M - gap * (n - 1)) / n;
      s.items.forEach((it, i) => {
        const x = M + i * (cw + gap);
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.85, w: cw, h: 4.4, fill: { color: P.tint }, line: { color: P.tint }, rectRadius: 0.18, objectName: `카드 ${i + 1}` });
        numCircle(sl, i + 1, x + 0.35, 2.2, 0.75, P.accent, 'FFFFFF');
        sl.addText(it.head, { x: x + 0.35, y: 3.2, w: cw - 0.7, h: 0.9, fontFace: FONT, fontSize: 20, bold: true, color: P.dark, valign: 'top', margin: 0, isTextBox: true });
        sl.addText(it.text, { x: x + 0.35, y: 4.1, w: cw - 0.7, h: 1.95, fontFace: FONT, fontSize: n === 4 ? 14 : 16, color: P.ink, valign: 'top', margin: 0, isTextBox: true });
      });
    } else if (s.kind === 'steps') {
      sl = content(s);
      const n = s.items.length, gap = 0.3, cw = (W - 2 * M - gap * (n - 1)) / n, d = 0.85, cy = 2.05;
      // 단계를 잇는 선 (원 중심 높이)
      sl.addShape(pres.shapes.LINE, { x: M + cw / 2, y: cy + d / 2, w: (n - 1) * (cw + gap), h: 0, line: { color: P.soft, width: 3 }, objectName: '단계 연결선' });
      s.items.forEach((it, i) => {
        const x = M + i * (cw + gap);
        numCircle(sl, i + 1, x + cw / 2 - d / 2, cy, d, i === n - 1 ? P.dark : P.accent, 'FFFFFF');
        sl.addText(it.head, { x, y: 3.15, w: cw, h: 0.8, fontFace: FONT, fontSize: 18, bold: true, color: P.dark, align: 'center', valign: 'top', margin: 0, isTextBox: true });
        sl.addText(it.text, { x: x + 0.1, y: 3.95, w: cw - 0.2, h: 2.2, fontFace: FONT, fontSize: n === 5 ? 14 : 15, color: P.ink, valign: 'top', margin: 0, isTextBox: true });
      });
    } else if (s.kind === 'stats') {
      sl = content(s);
      const n = s.stats.length, gap = 0.35, cw = (W - 2 * M - gap * (n - 1)) / n;
      s.stats.forEach((t, i) => {
        const x = M + i * (cw + gap);
        sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 2.0, w: cw, h: 3.2, fill: { color: P.tint }, line: { color: P.tint }, rectRadius: 0.18, objectName: `숫자 카드 ${i + 1}` });
        // 글자 수와 카드 폭으로 크기를 정함 (한글 한 글자 ≈ 글자 크기 1pt당 0.0139in)
        const len = [...t.value].length, maxByWidth = Math.floor(((cw - 0.6) / Math.max(len, 1)) / 0.0139 * 0.92);
        sl.addText(t.value, { x: x + 0.3, y: 2.45, w: cw - 0.6, h: 1.3, fontFace: FONT, fontSize: Math.max(20, Math.min(n === 4 ? 40 : 48, maxByWidth)), bold: true, color: P.accent, valign: 'middle', margin: 0, isTextBox: true });
        sl.addText(t.label, { x: x + 0.3, y: 3.85, w: cw - 0.6, h: 1.1, fontFace: FONT, fontSize: 16, color: P.ink, valign: 'top', margin: 0, isTextBox: true });
      });
      if (s.caption) sl.addText(s.caption, { x: M, y: 5.6, w: W - 2 * M, h: 0.5, fontFace: FONT, fontSize: 13, color: '6B6B6B', margin: 0, isTextBox: true });
    } else if (s.kind === 'table') {
      sl = content(s);
      const head = s.columns.map(c => ({ text: c, options: { bold: true, color: 'FFFFFF', fill: { color: P.accent } } }));
      const body = s.rows.map((r, ri) => r.map(c => ({ text: c, options: { color: P.ink, fill: { color: ri % 2 ? 'FFFFFF' : P.tint } } })));
      sl.addTable([head, ...body], { x: M, y: 1.8, w: W - 2 * M, colW: Array(s.columns.length).fill((W - 2 * M) / s.columns.length), fontFace: FONT, fontSize: s.rows.length > 4 ? 14 : 16, border: { type: 'solid', pt: 1, color: 'FFFFFF' }, valign: 'middle', margin: 0.08, rowH: 0.62 });
    } else if (s.kind === 'message') {
      sl = pres.addSlide({ masterName: 'HB_TINT' });
      numCircle(sl, '“', W / 2 - 0.45, 1.2, 0.9, P.accent, 'FFFFFF');
      sl.addText(s.title, { x: M + 1, y: 2.35, w: W - 2 * M - 2, h: 0.6, fontFace: FONT, fontSize: 18, bold: true, color: P.accent, align: 'center', margin: 0, isTextBox: true });
      sl.addText(s.message || s.title, { x: M + 1, y: 3.05, w: W - 2 * M - 2, h: 2.2, fontFace: FONT, fontSize: 32, bold: true, color: P.dark, align: 'center', valign: 'middle', margin: 0, isTextBox: true });
      if (s.caption) sl.addText(s.caption, { x: M + 1, y: 5.4, w: W - 2 * M - 2, h: 0.6, fontFace: FONT, fontSize: 14, color: '6B6B6B', align: 'center', margin: 0, isTextBox: true });
    }
    if (s.note) sl.addNotes(s.note);
  });
  const buf = await pres.write({ outputType: 'nodebuffer' });
  // 빈 폴더 항목은 일부 클라우드 드라이브에서 열기 오류를 일으켜서 지운다
  const JSZip = require('jszip');
  // (zip.remove()로 폴더를 지우면 안의 파일까지 지워지므로, 파일만 새 압축본에 옮겨 담는다)
  const src = await JSZip.loadAsync(buf), out = new JSZip();
  for (const name of Object.keys(src.files)) {
    const f = src.files[name];
    if (!f.dir) out.file(name, await f.async('uint8array'), { createFolders: false, date: f.date });
  }
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

module.exports = { normalizeOutline, buildDeck, PALETTES, KINDS, LIM };

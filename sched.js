// 일정 봇 도우미: 날짜 계산, 변경 적용, 간트차트 일정표 HTML (외부 패키지 없음)
'use strict';
const DOC = require('./doc');
const esc = DOC.escapeHtml;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const DAY = 864e5;

// 한국 시간 기준 날짜 (YYYY-MM-DD)
const kstDate = (t = Date.now()) => new Date(t + 9 * 36e5).toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z'));
const toMs = s => Date.parse(s + 'T00:00:00Z');
const addDays = (s, n) => new Date(toMs(s) + n * DAY).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
const wd = s => WD[new Date(toMs(s)).getUTCDay()];
const md = s => `${+s.slice(5, 7)}/${+s.slice(8, 10)}(${wd(s)})`;
const range = it => it.start === it.end ? md(it.start) : `${md(it.start)}–${md(it.end)}`;

// 텔레그램 그룹의 모든 메시지를 AI에 보내지 않도록, 일정 이야기로 보이는 것만 거른다
const SCHED_RE = /(\d{1,2}\s*[/.월]\s*\d{1,2}|\d{1,2}\s*일|오늘|내일|모레|글피|다음\s*주|이번\s*주|다다음\s*주|다음\s*달|이번\s*달|[월화수목금토일]요일|부터|까지|마감|연기|미뤄|미루|미룸|당겨|앞당|취소|일정|회의|미팅|납품|행사|출장|교육|완료|끝났|마쳤|데드라인|기한)/;

const STATUS = { active: '진행', done: '완료', cancelled: '취소' };

// ops: Claude가 만든 변경 목록 → 검사 후 적용. 잘못된 것은 errors로
function applyOps(sched, ops, by, source, opt = {}) {
  const applied = [], errors = [];
  const find = id => sched.items.find(x => x.id === id);
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  for (const o of Array.isArray(ops) ? ops.slice(0, 10) : []) {
    const op = o && o.op;
    if (op === 'add') {
      const title = clean(o.title).slice(0, 60), start = o.start, end = o.end || o.start;
      if (!title || !isDate(start) || !isDate(end) || end < start || diffDays(start, end) > 366) { errors.push(`추가할 일정의 제목·날짜를 알 수 없어요${title ? ` ("${title}")` : ''}`); continue; }
      const it = { id: 'g' + Math.random().toString(16).slice(2, 10), title, start, end, owner: clean(o.owner).slice(0, 30), note: clean(o.note).slice(0, 200), status: 'active', detail: '', createdAt: Date.now(), history: [] };
      sched.items.push(it);
      applied.push(push(it, 'add', `추가: "${it.title}" ${range(it)}${it.owner ? ` · 담당 ${it.owner}` : ''}`));
      continue;
    }
    const it = find(o && o.id);
    if (!it) { errors.push('바꿀 일정을 찾지 못했어요'); continue; }
    if (op === 'delete' && opt.allowDelete) {
      sched.items.splice(sched.items.indexOf(it), 1);
      applied.push({ id: it.id, op, summary: `삭제: "${it.title}" ${range(it)}` });
      continue;
    }
    if (op === 'cancel') {
      if (it.status === 'cancelled') { errors.push(`"${it.title}"은(는) 이미 취소됐어요`); continue; }
      it.status = 'cancelled';
      applied.push(push(it, 'cancel', `취소: "${it.title}" ${range(it)}${clean(o.reason) ? ` · 사유: ${clean(o.reason).slice(0, 80)}` : ''}`));
    } else if (op === 'done') {
      it.status = 'done';
      applied.push(push(it, 'done', `완료: "${it.title}"`));
    } else if (op === 'restore') {
      it.status = 'active';
      applied.push(push(it, 'restore', `다시 진행: "${it.title}" ${range(it)}`));
    } else if (op === 'update' || op === 'postpone') {
      const before = { ...it }, ch = [];
      let start = isDate(o.start) ? o.start : it.start, end = isDate(o.end) ? o.end : null;
      if (!end) end = isDate(o.start) ? addDays(start, diffDays(it.start, it.end)) : it.end; // 시작만 바뀌면 기간 유지
      if (end < start || diffDays(start, end) > 366) { errors.push(`"${it.title}"의 날짜가 맞지 않아요`); continue; }
      if (start !== it.start || end !== it.end) {
        const kind = toMs(start) > toMs(it.start) ? '연기' : toMs(start) < toMs(it.start) ? '당김' : end > it.end ? '마감 연기' : '마감 당김';
        it.start = start; it.end = end;
        ch.push(`${kind} ${range(before)} → ${range(it)}`);
      }
      if (clean(o.title) && clean(o.title) !== it.title) { it.title = clean(o.title).slice(0, 60); ch.push(`제목 "${before.title}" → "${it.title}"`); }
      if (o.owner != null && clean(o.owner) !== it.owner) { it.owner = clean(o.owner).slice(0, 30); ch.push(`담당 ${before.owner || '없음'} → ${it.owner || '없음'}`); }
      if (o.note != null && (clean(o.note) || opt.exact) && clean(o.note).slice(0, 200) !== it.note) { it.note = clean(o.note).slice(0, 200); ch.push('메모 변경'); }
      if (it.status === 'cancelled' && ch.length) { it.status = 'active'; ch.push('다시 진행'); }
      if (!ch.length) { errors.push(`"${it.title}"에 바뀐 내용이 없어요`); continue; }
      applied.push(push(it, op, `"${before.title}" ${ch.join(', ')}`));
    } else errors.push('알 수 없는 변경이에요');
  }
  function push(it, op, summary) { const h = { at: Date.now(), by, source, op, summary }; it.history.push(h); if (it.history.length > 50) it.history.shift(); return { id: it.id, op, summary }; }
  if (applied.length) {
    sched.v = (sched.v || 0) + 1;
    sched.log.unshift({ at: Date.now(), by, source, v: sched.v, changes: applied.map(a => a.summary) });
    sched.log = sched.log.slice(0, 200);
    sched.updatedAt = Date.now();
  }
  return { applied, errors };
}

// AI에게 주는 현재 일정 목록 (취소된 것도 다시 살릴 수 있게 포함)
const listForAi = sched => sched.items.map(x => `- id ${x.id} | ${x.title} | ${x.start} ~ ${x.end} | 담당 ${x.owner || '-'} | ${STATUS[x.status]}${x.note ? ' | ' + x.note : ''}`).join('\n') || '(아직 일정 없음)';

// ---------- 간트차트 일정표 HTML ----------
function renderGantt(org, sched, opt = {}) {
  const L = { title: '일정표', item: '일정', by: '함께봇 일정 봇', empty: '아직 일정이 없어요. 텔레그램 일정방에 일정을 올리면 여기에 그려져요.', ...opt };
  const today = kstDate();
  const items = sched.items.slice().sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const shown = items.filter(x => x.status !== 'cancelled' || diffDays(x.end, today) < 30);
  let from = shown.length ? shown.reduce((m, x) => x.start < m ? x.start : m, shown[0].start) : today;
  let to = shown.length ? shown.reduce((m, x) => x.end > m ? x.end : m, shown[0].end) : addDays(today, 30);
  if (today < from) from = today; if (today > to) to = today;
  from = addDays(from, -2); to = addDays(to, 3);
  let clipped = false;
  if (diffDays(from, to) > 120) { from = addDays(today, -21); to = addDays(today, 99); clipped = true; }
  const N = diffDays(from, to) + 1, CW = 26;
  const days = Array.from({ length: N }, (_, i) => addDays(from, i));
  const months = [];
  days.forEach((d, i) => { const k = d.slice(0, 7); if (!months.length || months[months.length - 1].k !== k) months.push({ k, i, n: 1 }); else months[months.length - 1].n++; });
  const todayX = diffDays(from, today) * CW;
  const bar = it => {
    let s = diffDays(from, it.start), e = diffDays(from, it.end);
    if (e < 0 || s > N - 1) return '';
    const cutL = s < 0, cutR = e > N - 1; s = Math.max(0, s); e = Math.min(N - 1, e);
    const w = (e - s + 1) * CW;
    return `<span class="bar ${it.status}${cutL ? ' cl' : ''}${cutR ? ' cr' : ''}" style="left:${s * CW}px;width:${w}px" title="${esc(it.title)} ${esc(range(it))}">${w > 90 ? `<em>${esc(it.title)}</em>` : ''}</span>${w <= 90 ? `<span class="side" style="left:${(e + 1) * CW + 6}px">${esc(it.title)}</span>` : ''}`;
  };
  const rows = shown.map(it => `<div class="row ${it.status}"><a class="lab" href="#${esc(it.id)}"><b>${esc(it.title)}</b><small>${esc(range(it))}${it.owner ? ' · ' + esc(it.owner) : ''}${it.status !== 'active' ? ' · ' + STATUS[it.status] : ''}</small></a><div class="track" style="width:${N * CW}px">${todayX >= 0 && todayX < N * CW ? `<i class="today" style="left:${todayX + CW / 2}px"></i>` : ''}${bar(it)}</div></div>`).join('');
  const head = `<div class="row head"><div class="lab"></div><div class="track" style="width:${N * CW}px"><div class="months">${months.map(m => `<span style="left:${m.i * CW}px;width:${m.n * CW}px">${+m.k.slice(0, 4)}년 ${+m.k.slice(5)}월</span>`).join('')}</div><div class="days">${days.map(d => { const w = new Date(toMs(d)).getUTCDay(); return `<span class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}${d === today ? ' now' : ''}">${+d.slice(8)}</span>`; }).join('')}</div></div></div>`;
  const list = items.map(it => `<tr id="${esc(it.id)}" class="${it.status}"><td>${esc(it.title)}${it.note ? `<div class="muted">${esc(it.note)}</div>` : ''}</td><td class="nw">${esc(range(it))}</td><td>${esc(it.owner || '-')}</td><td class="nw">${STATUS[it.status]}</td><td>${it.history.slice(-1).map(h => `<span class="muted">${esc(h.summary)}</span>`).join('')}</td></tr>`).join('');
  const details = items.filter(it => it.detail).map(it => `<section class="detail" id="d-${esc(it.id)}"><h3>${esc(it.title)} <small>${esc(range(it))}</small></h3>${it.detail}</section>`).join('');
  const log = sched.log.slice(0, 40).map(l => `<li><span class="muted nw">${new Date(l.at + 9 * 36e5).toISOString().slice(5, 16).replace('T', ' ')} · ${esc(l.by)}${l.source === 'telegram' ? ' (텔레그램)' : l.source === 'web' ? ' (기업방)' : l.source === 'edit' ? ' (편집 링크)' : l.source === 'auto' ? ' (자동)' : ''}</span><br>${l.changes.map(esc).join('<br>')}</li>`).join('');
  const updated = sched.updatedAt ? new Date(sched.updatedAt + 9 * 36e5).toISOString().slice(0, 16).replace('T', ' ') : '-';
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(org.name)} ${L.title}</title>
<style>
:root{--ink:#17202b;--mute:#667085;--line:#e4e7ec;--acc:#0e7c86;--accl:#d7f0f1;--done:#98a2b3;--bg:#fff;--soft:#f6f8fa}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 "Malgun Gothic","Noto Sans KR",system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:1280px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:28px;margin:0}h2{font-size:19px;margin:34px 0 10px}h3{font-size:17px;margin:0 0 8px}h3 small{color:var(--mute);font-weight:400;font-size:14px}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}.muted{color:var(--mute);font-size:13px}.nw{white-space:nowrap}
.legend{display:flex;gap:14px;font-size:13px;color:var(--mute);margin-top:8px;flex-wrap:wrap}.legend i{display:inline-block;width:22px;height:10px;border-radius:5px;vertical-align:middle;margin-right:5px}
.gantt{overflow-x:auto;border:1px solid var(--line);border-radius:12px;margin-top:12px}
.row{display:flex;border-bottom:1px solid var(--line);min-height:44px}.row:last-child{border-bottom:0}
.lab{flex:none;width:220px;padding:7px 12px;position:sticky;left:0;background:var(--bg);z-index:2;border-right:1px solid var(--line);color:inherit;text-decoration:none}
.lab b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lab small{color:var(--mute);font-size:12px}
.track{position:relative;flex:none;background-image:linear-gradient(to right,var(--line) 1px,transparent 1px);background-size:${CW}px 100%}
.head .track{height:48px}.months span{position:absolute;top:4px;font-size:12px;font-weight:700;padding-left:4px;border-left:1px solid var(--line);height:18px;white-space:nowrap;overflow:hidden}
.days{position:absolute;top:24px;left:0;display:flex}.days span{width:${CW}px;text-align:center;font-size:11px;color:var(--mute)}.days .sun{color:#d92d20}.days .sat{color:#2e66d6}.days .now{background:var(--acc);color:#fff;border-radius:4px}
.bar{position:absolute;top:11px;height:22px;border-radius:6px;background:var(--acc);overflow:hidden}.bar em{font-style:normal;color:#fff;font-size:12px;padding:0 8px;line-height:22px;white-space:nowrap}
.bar.done{background:var(--done)}.bar.cancelled{background:repeating-linear-gradient(45deg,#d0d5dd 0 6px,#eaecf0 6px 12px)}.bar.cancelled em{color:#475467;text-decoration:line-through}
.bar.cl{border-top-left-radius:0;border-bottom-left-radius:0}.bar.cr{border-top-right-radius:0;border-bottom-right-radius:0}
.side{position:absolute;top:13px;font-size:12px;white-space:nowrap;color:var(--ink)}.row.cancelled .side,.row.cancelled .lab b{text-decoration:line-through;color:var(--mute)}
.today{position:absolute;top:0;bottom:0;width:2px;background:#f04438;opacity:.7;z-index:1}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--mute);font-weight:500;border-bottom:1.5px solid var(--line);padding:8px}td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top}
tr.cancelled td:first-child{text-decoration:line-through;color:var(--mute)}tr:target{background:#fff8db}
.detail{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:12px}.detail:target{outline:2px solid var(--acc)}
.detail table{font-size:13px}.detail mark{background:#fff1b8}
ol.log{list-style:none;padding:0;margin:0}ol.log li{padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
${L.css || ''}
@media(max-width:640px){.lab{width:140px}h1{font-size:23px}table{font-size:13px}}
@media print{.gantt{overflow:visible}}
</style></head><body><div class="wrap">
<div class="top"><div><h1>${esc(org.name)} ${L.title}</h1><div class="muted">마지막 수정 ${updated} · 버전 ${sched.v || 0} · ${L.by}</div></div>
<div class="legend"><span><i style="background:var(--acc)"></i>진행</span><span><i style="background:var(--done)"></i>완료</span><span><i style="background:repeating-linear-gradient(45deg,#d0d5dd 0 4px,#eaecf0 4px 8px)"></i>취소</span><span><i style="background:#f04438;width:3px"></i>오늘</span></div></div>
${L.top || ''}<h2>간트차트</h2>${clipped ? '<p class="muted">기간이 길어 오늘 앞뒤 넉 달만 보여요. 전체는 아래 목록에 있어요.</p>' : ''}
${shown.length ? `<div class="gantt">${head}${rows}</div>` : `<p class="muted">${L.empty}</p>`}
<h2>${L.item} 목록</h2><table><thead><tr><th>${L.item}</th><th>${L.period || '기간'}</th><th>담당</th><th>상태</th><th>최근 변경</th></tr></thead><tbody>${list || '<tr><td colspan="5" class="muted">없음</td></tr>'}</tbody></table>
${details ? `<h2>상세 계획</h2>${details}` : ''}
${L.bottom || ''}<h2>변경 기록</h2><ol class="log">${log || '<li class="muted">없음</li>'}</ol>
</div></body></html>`;
}

module.exports = { kstDate, isDate, addDays, diffDays, md, range, wd, SCHED_RE, applyOps, listForAi, renderGantt, STATUS };

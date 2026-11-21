// 할 일 봇 도우미: 2주 점검 주기, 아침 알림 글, 점검 통계, 할 일표 HTML (일정 봇의 간트차트를 그대로 씀)
'use strict';
const SCHED = require('./sched');
const DOC = require('./doc');
const esc = DOC.escapeHtml;
const { addDays, diffDays, md, range, kstDate } = SCHED;

// 텔레그램에서 명령 없이 보낸 말 중 할 일로 보이는 것만 AI에 보냄
const TODO_RE = /(할\s*일|할일|todo|to-do|투두|해야\s*(해|함|돼|된다|할)|하기로|끝냈|끝났|다\s*했|완료|마감|까지)/i;

const defaultCycle = today => ({ start: today, days: 14, hour: 9, weekdays: true });
// 다음 점검일: 시작일에서 주기(일)만큼씩. 오늘이 점검일이면 오늘
function nextReview(cycle, today) {
  const d = diffDays(cycle.start, today);
  const k = Math.max(1, Math.ceil(d / cycle.days));
  return addDays(cycle.start, k * cycle.days);
}
const dleft = (today, date) => diffDays(today, date);
// 오늘 점검을 이미 했으면 그다음 점검일
const upcoming = (todo, today) => todo.lastReview === today ? nextReview(todo.cycle, addDays(today, 1)) : nextReview(todo.cycle, today);
const leftText = n => n === 0 ? '오늘' : n > 0 ? `${n}일 남음` : `${-n}일 지남`;

// 사람별로 묶기 (담당 없음은 "담당 미정")
function byOwner(items) {
  const m = new Map();
  for (const it of items) { const k = it.owner || '담당 미정'; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return [...m.entries()].sort((a, b) => a[0] === '담당 미정' ? 1 : b[0] === '담당 미정' ? -1 : a[0].localeCompare(b[0], 'ko'));
}

// 매일 아침 기업방에 보내는 알림 (AI를 쓰지 않으므로 토큰 없음)
function morningText(todo, today, url) {
  const review = nextReview(todo.cycle, today), n = dleft(today, review);
  const live = todo.items.filter(x => x.status === 'active');
  const over = live.filter(x => x.end < today), soon = live.filter(x => x.end >= today && x.end <= review);
  const lines = [`[할 일 점검 알림] ${md(today)}`,
    n === 0 ? `오늘은 ${todo.cycle.days}일 점검일이에요. 점검 결과를 함께 보내요.` : `다음 ${todo.cycle.days}일 점검: ${md(review)} · ${leftText(n)}`,
    `점검할 할 일 ${over.length + soon.length}개 (마감 지남 ${over.length} · 점검일까지 마감 ${soon.length}) · 진행 중 전체 ${live.length}개`];
  const pick = [...over, ...soon];
  for (const [owner, list] of byOwner(pick)) {
    lines.push(`\n■ ${owner}`);
    for (const it of list.sort((a, b) => a.end.localeCompare(b.end)).slice(0, 6)) lines.push(`· ${it.title} — ${md(it.end)} 마감 (${leftText(dleft(today, it.end))})`);
    if (list.length > 6) lines.push(`· 외 ${list.length - 6}개`);
  }
  if (!pick.length) lines.push('\n점검일 전에 마감인 할 일은 없어요.');
  lines.push(`\n할 일표: ${url}`);
  return lines.join('\n');
}

// 점검 기간(from~to) 동안의 사람별 숫자 — 코드가 계산하고, AI는 이것을 보고 말로 피드백만 씀
function reviewStats(todo, from, to) {
  const t0 = Date.parse(from + 'T00:00:00+09:00'), t1 = Date.parse(addDays(to, 1) + 'T00:00:00+09:00');
  const inP = h => h.at >= t0 && h.at < t1;
  return byOwner(todo.items).map(([owner, list]) => {
    const live = list.filter(x => x.status === 'active');
    return {
      owner,
      done: list.filter(x => x.status === 'done' && x.history.some(h => h.op === 'done' && inP(h))).length,
      added: list.filter(x => x.createdAt >= t0 && x.createdAt < t1).length,
      postponed: list.filter(x => x.history.some(h => inP(h) && /연기/.test(h.summary))).length,
      active: live.length,
      overdue: live.filter(x => x.end < to).length,
      items: list
    };
  }).filter(p => p.active || p.done || p.added);
}
const statLine = p => `완료 ${p.done} · 진행 ${p.active} (마감 지남 ${p.overdue}) · 새로 ${p.added} · 연기 ${p.postponed}`;

function forAi(stats, to) {
  return stats.map(p => `■ ${p.owner}: ${statLine(p)}\n${p.items.filter(x => x.status !== 'cancelled').map(x => `  - ${x.title} | 마감 ${x.end} | ${SCHED.STATUS[x.status]}${x.status === 'active' && x.end < to ? ' (마감 지남)' : ''}${x.note ? ' | ' + x.note : ''}${x.history.length > 1 ? ' | 최근: ' + x.history.slice(-2).map(h => h.summary).join('; ') : ''}`).join('\n')}`).join('\n\n');
}

function reviewText(rv, url) {
  const L = [`[${rv.days}일 할 일 점검] ${md(rv.from)}–${md(rv.to)}`, rv.summary ? rv.summary : ''];
  for (const p of rv.people) {
    L.push(`\n■ ${p.owner} — ${statLine(p)}`);
    if (p.good) L.push(`잘한 점: ${p.good}`);
    if (p.concern) L.push(`살펴볼 점: ${p.concern}`);
    if (p.next) L.push(`다음 ${rv.days}일: ${p.next}`);
  }
  L.push(`\n다음 점검: ${md(rv.next)} · 할 일표: ${url}`);
  return L.filter(x => x !== '').join('\n');
}

// ---------- 할 일표 HTML ----------
function renderTodo(org, todo, today = kstDate()) {
  const review = upcoming(todo, today), n = dleft(today, review);
  const live = todo.items.filter(x => x.status === 'active');
  const board = byOwner(todo.items.filter(x => x.status !== 'cancelled')).map(([owner, list]) => {
    const act = list.filter(x => x.status === 'active').sort((a, b) => a.end.localeCompare(b.end));
    const done = list.filter(x => x.status === 'done');
    return `<div class="pcard"><h3>${esc(owner)} <small>진행 ${act.length} · 완료 ${done.length}</small></h3><ul>${act.map(x => { const d = dleft(today, x.end); return `<li class="${d < 0 ? 'over' : x.end <= review ? 'soon' : ''}"><a href="#${esc(x.id)}">${esc(x.title)}</a><span>${md(x.end)} · ${leftText(d)}</span></li>`; }).join('')}${done.slice(-3).map(x => `<li class="dn"><a href="#${esc(x.id)}">${esc(x.title)}</a><span>완료</span></li>`).join('')}</ul></div>`;
  }).join('');
  const top = `<div class="rv"><b>다음 ${todo.cycle.days}일 점검 ${md(review)}</b> <span class="dd">${n === 0 ? '오늘' : n > 0 ? `D-${n}` : ''}</span><span class="muted">매일 ${todo.cycle.hour}시${todo.cycle.weekdays ? ' (평일)' : ''} 기업방에 점검할 할 일을 알려요 · 진행 중 ${live.length}개 · 마감 지남 ${live.filter(x => x.end < today).length}개</span></div>
<h2>사람별 할 일</h2>${board ? `<div class="board">${board}</div>` : '<p class="muted">아직 할 일이 없어요.</p>'}`;
  const reviews = (todo.reviews || []).slice(0, 12).map(r => `<section class="detail"><h3>${md(r.from)}–${md(r.to)} 점검 <small>${r.auto ? '자동' : '요청'} · ${esc(r.by || '')}</small></h3>${r.summary ? `<p>${esc(r.summary)}</p>` : ''}<table><thead><tr><th>사람</th><th>숫자</th><th>피드백</th></tr></thead><tbody>${r.people.map(p => `<tr><td class="nw">${esc(p.owner)}</td><td class="nw muted">${esc(statLine(p))}</td><td>${p.good ? `<div><b>잘한 점</b> ${esc(p.good)}</div>` : ''}${p.concern ? `<div><b>살펴볼 점</b> ${esc(p.concern)}</div>` : ''}${p.next ? `<div><b>다음 ${r.days}일</b> ${esc(p.next)}</div>` : ''}</td></tr>`).join('')}</tbody></table></section>`).join('');
  const css = `.rv{margin-top:16px;padding:14px 16px;border-radius:12px;background:#fff4ec;display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}.rv .dd{background:#c2410c;color:#fff;border-radius:8px;padding:1px 9px;font-weight:700}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.pcard{border:1px solid var(--line);border-radius:12px;padding:12px 14px}.pcard ul{list-style:none;margin:0;padding:0}
.pcard li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:14px}.pcard li a{color:inherit;text-decoration:none}.pcard li span{color:var(--mute);font-size:12px;white-space:nowrap}
.pcard li.over span{color:#d92d20;font-weight:700}.pcard li.soon span{color:#c2410c}.pcard li.dn a{color:var(--mute);text-decoration:line-through}`;
  return SCHED.renderGantt(org, todo, { title: '할 일표', item: '할 일', period: '시작–마감', by: '함께봇 할 일 봇', empty: '아직 할 일이 없어요. 텔레그램에서 "/todo 금요일까지 구청 보고서"처럼 올리면 여기에 그려져요.', top, bottom: reviews ? `<h2>${todo.cycle.days}일 점검 기록</h2>${reviews}` : '', css });
}

module.exports = { TODO_RE, defaultCycle, nextReview, upcoming, morningText, reviewStats, reviewText, forAi, renderTodo, byOwner, statLine, leftText };

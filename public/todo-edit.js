// 할 일표 고치기: 편집 링크(/te/토큰)로 로그인 없이 할 일·점검 주기를 고침
'use strict';
const TOKEN = location.pathname.split('/')[2];
const API = '/api/te/' + TOKEN;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const md = s => { const d = new Date(s + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };
const diff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const left = n => n === 0 ? '오늘' : n > 0 ? `${n}일 남음` : `${-n}일 지남`;
const ST = { active: '진행', done: '완료', cancelled: '취소' };
let D = null, filt = { owner: '', st: 'open' };
let myName = ''; try { myName = localStorage.getItem('hb.todo.name') || ''; } catch (e) {}

function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600); }
async function load() {
  const r = await fetch(API, { cache: 'no-store' });
  const j = await r.json().catch(() => ({ error: '불러오지 못했어요' }));
  if (!r.ok) { $('app').innerHTML = `<h1>할 일표 고치기</h1><p class="msg err">${esc(j.error)}</p>`; return; }
  D = j; render();
}
async function send(payload, box) {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, v: D.v, name: myName }) });
  const j = await r.json().catch(() => ({ error: '저장하지 못했어요' }));
  if (r.status === 409) { D = j; render(); toast(j.error); return false; }
  if (!r.ok) { if (box) box.querySelector('.msg').textContent = j.error; else toast(j.error); return false; }
  D = j; render(); toast(j.errors && j.errors.length ? '일부만 고쳤어요: ' + j.errors.join(' / ') : '저장했어요');
  return true;
}
function itemHtml(x) {
  const n = diff(D.today, x.end), over = x.status === 'active' && n < 0;
  return `<div class="item ${x.status}${over ? ' over' : ''}" data-id="${esc(x.id)}">
  <div class="head"><span><span class="st">${ST[x.status]}</span> ${x.status === 'active' ? `<span class="st${over ? ' over' : ''}">${md(x.end)} 마감 · ${left(n)}</span>` : ''}</span><span class="mute">${x.history.length ? esc(x.history[x.history.length - 1].summary).slice(0, 60) : ''}</span></div>
  <div class="grid"><label class="wide">할 일<input class="field" data-f="title" value="${esc(x.title)}" maxlength="60"></label>
  <label>담당<input class="field" data-f="owner" value="${esc(x.owner)}" maxlength="30"></label>
  <label>시작<input class="field" type="date" data-f="start" value="${esc(x.start)}"></label>
  <label>마감<input class="field" type="date" data-f="end" value="${esc(x.end)}"></label>
  <label class="wide">메모<input class="field" data-f="note" value="${esc(x.note)}" maxlength="200"></label></div>
  <div class="acts"><button class="btn sm" type="button" data-a="save">저장</button>${x.status === 'active' ? '<button class="btn ghost sm" type="button" data-a="done">완료</button><button class="btn ghost sm" type="button" data-a="cancel">취소</button>' : '<button class="btn ghost sm" type="button" data-a="restore">다시 진행</button>'}<button class="btn ghost sm" type="button" data-a="delete">삭제</button></div>
  <div class="msg err"></div></div>`;
}
function render() {
  const owners = [...new Set(D.items.map(x => x.owner || '담당 미정'))].sort((a, b) => a.localeCompare(b, 'ko'));
  if (filt.owner && !owners.includes(filt.owner)) filt.owner = '';
  const shown = D.items.filter(x => (!filt.owner || (x.owner || '담당 미정') === filt.owner) && (filt.st === 'all' || (filt.st === 'open' ? x.status === 'active' : x.status !== 'active')));
  const groups = new Map();
  for (const x of shown.sort((a, b) => a.end.localeCompare(b.end))) { const k = x.owner || '담당 미정'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const n = diff(D.today, D.next), c = D.cycle;
  $('app').innerHTML = `<div class="top"><div><h1>${esc(D.org)} 할 일표 고치기</h1><div class="mute">버전 ${D.v} · 고친 내용은 할 일표와 기업방에 바로 반영되고 기록에 남아요</div></div><a class="btn ghost" href="${esc(D.viewUrl)}" target="_blank" rel="noopener">할 일표 보기 ↗</a></div>
  <div class="box" style="margin-top:16px"><div class="rv"><b>다음 ${c.days}일 점검 ${md(D.next)}</b><span class="dd">${n === 0 ? '오늘' : 'D-' + n}</span><span class="mute">매일 ${c.hour}시${c.weekdays ? ' (평일)' : ''} 기업방에 알림</span></div>
   <details style="margin-top:8px"><summary style="cursor:pointer;min-height:36px">점검 주기 바꾸기</summary>
   <div class="grid"><label>주기 시작일<input class="field" type="date" id="cStart" value="${esc(c.start)}"></label>
   <label>점검 주기<select class="field" id="cDays">${[7, 14, 21, 28].map(d => `<option value="${d}"${d === c.days ? ' selected' : ''}>${d}일마다</option>`).join('')}</select></label>
   <label>아침 알림 시각<select class="field" id="cHour">${[6, 7, 8, 9, 10, 11, 12].map(h => `<option value="${h}"${h === c.hour ? ' selected' : ''}>${h}시</option>`).join('')}</select></label>
   <label style="flex-direction:row;align-items:center;gap:8px;color:var(--ink)"><input type="checkbox" id="cWd"${c.weekdays ? ' checked' : ''} style="width:20px;height:20px">평일에만 알림</label></div>
   <div class="acts"><button class="btn sm" type="button" id="cSave">주기 저장</button></div></details></div>
  <h2>할 일 추가</h2>
  <div class="box" id="addBox"><div class="grid"><label class="wide">할 일<input class="field" id="aTitle" maxlength="60" placeholder="예: 구청 보고서 제출"></label>
   <label>담당<input class="field" id="aOwner" maxlength="30" value="${esc(myName)}" list="owners"></label>
   <label>시작<input class="field" type="date" id="aStart" value="${esc(D.today)}"></label>
   <label>마감<input class="field" type="date" id="aEnd"></label>
   <label class="wide">메모<input class="field" id="aNote" maxlength="200"></label></div>
   <datalist id="owners">${owners.map(o => `<option value="${esc(o)}">`).join('')}</datalist>
   <div class="acts"><button class="btn" type="button" id="aAdd">추가</button></div><div class="msg err"></div></div>
  <h2>할 일 목록</h2>
  <div class="filters"><select class="field" id="fOwner" aria-label="사람"><option value="">모든 사람</option>${owners.map(o => `<option${o === filt.owner ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
   <select class="field" id="fSt" aria-label="상태"><option value="open"${filt.st === 'open' ? ' selected' : ''}>진행 중</option><option value="closed"${filt.st === 'closed' ? ' selected' : ''}>완료·취소</option><option value="all"${filt.st === 'all' ? ' selected' : ''}>전체</option></select>
   <label style="flex-direction:row;align-items:center;gap:6px">내 이름<input class="field" id="me" value="${esc(myName)}" maxlength="30" placeholder="기록에 남아요" style="width:140px"></label></div>
  <div id="list">${[...groups].map(([o, l]) => `<h3 class="owner">${esc(o)} <span class="mute">${l.length}개</span></h3>${l.map(itemHtml).join('')}`).join('') || '<p class="mute">해당하는 할 일이 없어요.</p>'}</div>
  <h2>최근 변경</h2><ol class="log">${D.log.map(l => `<li><span class="mute">${new Date(l.at + 9 * 36e5).toISOString().slice(5, 16).replace('T', ' ')} · ${esc(l.by)}</span><br>${l.changes.map(esc).join('<br>')}</li>`).join('') || '<li class="mute">없음</li>'}</ol>`;
}
document.addEventListener('change', e => {
  if (e.target.id === 'fOwner') { filt.owner = e.target.value; render(); }
  if (e.target.id === 'fSt') { filt.st = e.target.value; render(); }
  if (e.target.id === 'me') { myName = e.target.value.trim(); try { localStorage.setItem('hb.todo.name', myName); } catch (err) {} }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'aAdd') {
    const box = $('addBox'), v = id => $(id).value.trim();
    if (!v('aTitle') || !v('aEnd')) { box.querySelector('.msg').textContent = '할 일과 마감을 넣어 주세요'; return; }
    let start = v('aStart') || D.today; if (start > v('aEnd')) start = v('aEnd'); // 이미 지난 마감도 넣을 수 있게
    b.disabled = true; if (!(await send({ ops: [{ op: 'add', title: v('aTitle'), owner: v('aOwner'), start, end: v('aEnd'), note: v('aNote') }] }, box))) b.disabled = false; return;
  }
  if (b.id === 'cSave') { b.disabled = true; if (!(await send({ cycle: { start: $('cStart').value, days: +$('cDays').value, hour: +$('cHour').value, weekdays: $('cWd').checked } }))) b.disabled = false; return; }
  const box = b.closest('.item'); if (!box) return;
  const id = box.dataset.id, a = b.dataset.a, f = k => box.querySelector(`[data-f="${k}"]`).value.trim();
  if (a === 'delete' && b.textContent !== '정말 삭제할까요?') { b.textContent = '정말 삭제할까요?'; return; }
  b.disabled = true;
  const op = a === 'save' ? { op: 'update', id, title: f('title'), owner: f('owner'), start: f('start'), end: f('end'), note: f('note') } : { op: a, id };
  if (!(await send({ ops: [op] }, box))) b.disabled = false;
});
// 다른 사람이 고친 내용: 입력 중이 아닐 때 30초마다 새로 불러옴
setInterval(() => { const a = document.activeElement; if (!a || !/INPUT|SELECT/.test(a.tagName)) load().catch(() => {}); }, 30000);
load().catch(() => { $('app').innerHTML = '<p class="msg err">불러오지 못했어요. 인터넷 연결을 확인해 주세요.</p>'; });

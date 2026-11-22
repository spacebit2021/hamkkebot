// 출퇴근 확인: 운영 기관 관리자가 기업별로 정한 IP(사무실 네트워크)에서 접속했을 때만 출근·퇴근을 기록
// org.att = { ips: ['203.0.113.0/24', ...], memo, updatedAt, updatedBy, records: [...], denied: [...] }
//   record = { id, date:'YYYY-MM-DD'(한국 날짜, 출근 기준), key, name, kind:'web'|'telegram', in:{at,ip,via}, out:{at,ip,via}|null, outEdits }
'use strict';
const net = require('net');

const pad = n => String(n).padStart(2, '0');
const kstParts = t => { const d = new Date(t + 9 * 36e5); return { y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()) }; };
const dayK = t => { const k = kstParts(t); return `${k.y}-${k.m}-${k.d}`; };
const hm = t => { const k = kstParts(t); return `${k.H}:${k.M}`; };
const normIp = ip => { const s = String(ip || '').trim().replace(/^\[|\]$/g, ''); return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s) ? s.slice(7) : s; };

// 관리자가 입력한 글(줄바꿈·쉼표 구분)을 IP·대역 목록으로. 잘못된 줄은 errors로
function parseIps(text) {
  const list = [], errors = [];
  for (const raw of String(text || '').split(/[\n,]+/)) {
    const v = raw.replace(/#.*$/, '').trim(); if (!v) continue;
    const m = v.match(/^([^/\s]+)(?:\/(\d{1,3}))?$/);
    const ip = m && normIp(m[1]), fam = ip && net.isIP(ip), bits = m && m[2] !== undefined ? +m[2] : null;
    if (!fam || (bits !== null && (bits < (fam === 4 ? 8 : 16) || bits > (fam === 4 ? 32 : 128)))) { errors.push(v); continue; }
    const s = bits === null || bits === (fam === 4 ? 32 : 128) ? ip : `${ip}/${bits}`;
    if (!list.includes(s)) list.push(s);
  }
  if (list.length > 50) errors.push('IP·대역은 50개까지');
  return { list: list.slice(0, 50), errors };
}
function matcher(list) {
  const bl = new net.BlockList();
  for (const s of list || []) {
    const [ip, bits] = s.split('/'), fam = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (bits) bl.addSubnet(ip, +bits, fam); else bl.addAddress(ip, fam);
  }
  return ip => { const v = normIp(ip), f = net.isIP(v); if (!f) return false; try { return bl.check(v, f === 6 ? 'ipv6' : 'ipv4'); } catch (e) { return false; } };
}

// who: { key, name, kind }  action: 'in'|'out'
function act(att, who, action, ip, via, now = Date.now()) {
  if (!att || !att.ips || !att.ips.length) return { ok: false, code: 'unset', msg: '운영 기관이 아직 이 기업의 출퇴근 IP를 정하지 않았어요. 관리자에게 요청해 주세요.' };
  const ipn = normIp(ip);
  if (!matcher(att.ips)(ipn)) {
    att.denied = att.denied || []; att.denied.push({ at: now, key: who.key, name: who.name, action, ip: ipn, via });
    if (att.denied.length > 300) att.denied.splice(0, att.denied.length - 300);
    return { ok: false, code: 'ip', ip: ipn, msg: `정해진 사무실 네트워크가 아니라서 ${action === 'in' ? '출근' : '퇴근'}을 기록하지 않았어요 (지금 접속 IP ${ipn}). 사무실 와이파이·유선에 연결한 뒤 다시 해 주세요.` };
  }
  att.records = att.records || [];
  const today = dayK(now), mine = att.records.filter(r => r.key === who.key);
  const todayRec = mine.find(r => r.date === today);
  if (action === 'in') {
    if (todayRec) return { ok: true, already: true, rec: todayRec, msg: `오늘은 이미 ${hm(todayRec.in.at)}에 출근을 기록했어요.` };
    const rec = { id: 'a' + now.toString(36) + Math.random().toString(36).slice(2, 6), date: today, key: who.key, name: who.name, kind: who.kind, in: { at: now, ip: ipn, via }, out: null, outEdits: 0 };
    att.records.push(rec);
    if (att.records.length > 50000) att.records.splice(0, att.records.length - 50000);
    return { ok: true, rec, msg: `${who.name}님 출근 ${hm(now)} 기록했어요.` };
  }
  // 퇴근: 오늘 기록, 없으면 18시간 안의 퇴근 안 한 어제 기록(밤샘 근무)에 붙임
  let rec = todayRec || mine.filter(r => !r.out && now - r.in.at < 18 * 36e5).sort((a, b) => b.in.at - a.in.at)[0];
  if (!rec) return { ok: false, code: 'noin', msg: '오늘 출근 기록이 없어 퇴근을 기록할 수 없어요. 먼저 출근을 눌러 주세요 (늦게 눌렀다면 운영 기관에 정정을 요청해 주세요).' };
  const again = !!rec.out;
  rec.out = { at: now, ip: ipn, via }; if (again) rec.outEdits = (rec.outEdits || 0) + 1;
  rec.name = who.name;
  const min = Math.round((now - rec.in.at) / 6e4);
  return { ok: true, rec, msg: `${who.name}님 퇴근 ${hm(now)} ${again ? '(퇴근 시각을 다시 기록)' : ''} — 출근 ${hm(rec.in.at)}, 머문 시간 ${Math.floor(min / 60)}시간 ${min % 60}분.`.replace('  ', ' ') };
}
const minutes = r => r.out ? Math.round((r.out.at - r.in.at) / 6e4) : null;
const view = r => ({ id: r.id, date: r.date, key: r.key, name: r.name, kind: r.kind, in: r.in.at, out: r.out ? r.out.at : null, minutes: minutes(r), outEdits: r.outEdits || 0, via: r.in.via });

function monthReport(att, month, people) {
  const recs = (att && att.records || []).filter(r => r.date.startsWith(month)).sort((a, b) => a.in.at - b.in.at);
  const byKey = {};
  for (const p of people) byKey[p.key] = { key: p.key, name: p.name, kind: p.kind, days: 0, minutes: 0, noOut: 0 };
  for (const r of recs) {
    const x = byKey[r.key] || (byKey[r.key] = { key: r.key, name: r.name, kind: r.kind, days: 0, minutes: 0, noOut: 0 });
    x.name = r.name; x.days++; if (r.out) x.minutes += minutes(r); else x.noOut++;
  }
  return { month, people: Object.values(byKey), records: recs.map(view) };
}
function csv(att, month) {
  const q = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; };
  const rows = (att && att.records || []).filter(r => r.date.startsWith(month)).sort((a, b) => a.in.at - b.in.at);
  const head = ['날짜', '이름', '경로', '출근', '퇴근', '머문 시간(분)', '출근 IP', '퇴근 IP', '퇴근 다시 기록'];
  return '﻿' + [head.join(','), ...rows.map(r => [r.date, r.name, r.kind === 'telegram' ? '텔레그램 링크' : '웹앱', hm(r.in.at), r.out ? `${dayK(r.out.at) !== r.date ? dayK(r.out.at) + ' ' : ''}${hm(r.out.at)}` : '', minutes(r) == null ? '' : minutes(r), r.in.ip, r.out ? r.out.ip : '', r.outEdits || ''].map(q).join(','))].join('\r\n');
}

const IN_RE = /^\s*(출근|ㅊㄱ|check\s*-?in|in)\s*(했어요|했습니다|합니다|함|요|!|\.)*\s*$/i;
const OUT_RE = /^\s*(퇴근|ㅌㄱ|check\s*-?out|out)\s*(했어요|했습니다|합니다|함|요|!|\.)*\s*$/i;
const actionOf = t => IN_RE.test(t || '') ? 'in' : OUT_RE.test(t || '') ? 'out' : null;

module.exports = { parseIps, matcher, act, monthReport, csv, view, dayK, hm, normIp, actionOf };

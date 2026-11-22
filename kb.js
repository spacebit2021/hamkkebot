// 기업 지식베이스 보존: 대화·사용 내역 영구 기록(append-only) + 서버 전체 백업(스냅샷·무결성 확인·보관 주기·외부 복사 훅)
//
// 보관 위치
//   ARCHIVE_DIR  기업별 영구 기록. <기업ID>/msgs-YYYY-MM.jsonl (채팅방 메시지 전부 — 화면용 최근 500개 제한과 무관),
//                <기업ID>/usage-YYYY-MM.jsonl (LLM 사용 내역), <기업ID>/kb.jsonl (지식 항목 변경 이력)
//   BACKUP_DIR   스냅샷. hb-YYYYMMDD-HHMMSS/ 에 data.json + archive/ 사본 + manifest.json(파일별 sha256)
// 보관 주기: 최근 BACKUP_KEEP_DAILY개(기본 14) + 달마다 첫 백업 BACKUP_KEEP_MONTHLY개(기본 12)
// BACKUP_HOOK: 백업 뒤 실행할 명령 (예: rclone copy "$BACKUP_PATH" remote:hamkkebot/) — 운영자가 서버 환경변수로만 설정
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const pad = n => String(n).padStart(2, '0');
// 한국 시간 기준 날짜 문자열
const kst = (t = Date.now()) => { const d = new Date(t + 9 * 36e5); return { y: d.getUTCFullYear(), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), H: pad(d.getUTCHours()), M: pad(d.getUTCMinutes()), S: pad(d.getUTCSeconds()) }; };
const month = t => { const k = kst(t); return `${k.y}-${k.m}`; };
const safeId = id => String(id || '').replace(/[^\w-]/g, '');

// 파일을 반쯤 쓴 채로 남기지 않게: 임시 파일에 쓰고 디스크 반영 후 이름 바꾸기
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

function create(opt) {
  const archiveDir = opt.archiveDir, backupDir = opt.backupDir;
  const keepDaily = opt.keepDaily || 14, keepMonthly = opt.keepMonthly === undefined ? 12 : opt.keepMonthly;
  const hook = opt.hook || '';
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  // ---- 영구 기록 ----
  function append(orgId, kind, obj) {
    if (!orgId) return;
    try {
      const dir = path.join(archiveDir, safeId(orgId));
      fs.mkdirSync(dir, { recursive: true });
      const file = kind === 'kb' ? path.join(dir, 'kb.jsonl') : path.join(dir, `${kind}-${month(obj.at || Date.now())}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    } catch (e) { console.error('영구 기록 실패', orgId, kind, e.message); opt.onError && opt.onError(e); }
  }
  // since(시각)를 주면 그 달 이전 파일은 읽지 않음
  function read(orgId, kind, since) {
    const dir = path.join(archiveDir, safeId(orgId));
    if (!fs.existsSync(dir)) return [];
    const from = since ? `${kind}-${month(since)}.jsonl` : '';
    const files = fs.readdirSync(dir).filter(f => kind === 'kb' ? f === 'kb.jsonl' : f.startsWith(kind + '-') && f.endsWith('.jsonl') && (!from || f >= from)).sort();
    const out = [];
    for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch (e) { /* 끊긴 줄은 건너뜀 */ } }
    return out;
  }
  function stats(orgId) {
    const dir = path.join(archiveDir, safeId(orgId));
    const r = { files: 0, bytes: 0, msgs: 0, usage: 0, kbEvents: 0, since: null };
    if (!fs.existsSync(dir)) return r;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f), st = fs.statSync(p);
      r.files++; r.bytes += st.size;
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
      if (f.startsWith('msgs-')) { r.msgs += lines; const mth = f.slice(5, 12); if (!r.since || mth < r.since) r.since = mth; }
      else if (f.startsWith('usage-')) r.usage += lines; else if (f === 'kb.jsonl') r.kbEvents += lines;
    }
    return r;
  }

  // ---- 백업 ----
  function verifyDir(dir) {
    const mfile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mfile)) return { ok: false, problem: 'manifest.json 없음' };
    let man; try { man = JSON.parse(fs.readFileSync(mfile, 'utf8')); } catch (e) { return { ok: false, problem: 'manifest.json 손상' }; }
    for (const f of man.files) {
      const p = path.join(dir, f.path);
      if (!fs.existsSync(p)) return { ok: false, problem: `파일 없음: ${f.path}` };
      const buf = fs.readFileSync(p);
      if (buf.length !== f.bytes || sha256(buf) !== f.sha256) return { ok: false, problem: `내용 불일치: ${f.path}` };
    }
    try { JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')); } catch (e) { return { ok: false, problem: 'data.json을 읽을 수 없음' }; }
    return { ok: true, files: man.files.length, bytes: man.files.reduce((a, f) => a + f.bytes, 0) };
  }
  function list() {
    return fs.readdirSync(backupDir).filter(n => /^hb-\d{8}-\d{6}(-\d+)?$/.test(n)).sort().reverse().map(name => {
      let man = null; try { man = JSON.parse(fs.readFileSync(path.join(backupDir, name, 'manifest.json'), 'utf8')); } catch (e) {}
      return { name, at: man ? man.at : null, reason: man ? man.reason : '', files: man ? man.files.length : 0, bytes: man ? man.files.reduce((a, f) => a + f.bytes, 0) : 0, counts: man ? man.counts : null };
    });
  }
  function rotate() {
    const all = list(); // 최신순
    const keep = new Set(all.slice(0, keepDaily).map(b => b.name));
    const firstOfMonth = {};
    for (const b of [...all].reverse()) { const mth = b.name.slice(3, 9); if (!firstOfMonth[mth]) firstOfMonth[mth] = b.name; }
    Object.keys(firstOfMonth).sort().reverse().slice(0, keepMonthly).forEach(mth => keep.add(firstOfMonth[mth]));
    const removed = [];
    for (const b of all) if (!keep.has(b.name)) { fs.rmSync(path.join(backupDir, b.name), { recursive: true, force: true }); removed.push(b.name); }
    return removed;
  }
  function runHook(dir) {
    if (!hook) return Promise.resolve(null);
    return new Promise(resolve => {
      execFile('/bin/sh', ['-c', hook], { env: { ...process.env, BACKUP_PATH: dir, BACKUP_NAME: path.basename(dir) }, timeout: 30 * 6e4 }, (err, so, se) => {
        resolve({ ok: !err, code: err ? (err.code === undefined ? -1 : err.code) : 0, out: String(se || so || '').slice(-300) });
      });
    });
  }
  // state: 지금 메모리의 전체 데이터(저장 대기 중인 변경도 포함되도록 파일이 아니라 이것을 씀)
  async function run(state, reason = 'manual', counts = null) {
    const k = kst();
    let name = `hb-${k.y}${k.m}${k.d}-${k.H}${k.M}${k.S}`, i = 1;
    while (fs.existsSync(path.join(backupDir, name))) name = `hb-${k.y}${k.m}${k.d}-${k.H}${k.M}${k.S}-${i++}`;
    const dir = path.join(backupDir, name);
    const t0 = Date.now();
    try {
      fs.mkdirSync(dir);
      const files = [];
      const put = (rel, buf) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); writeAtomic(p, buf); files.push({ path: rel, bytes: buf.length, sha256: sha256(buf) }); };
      put('data.json', Buffer.from(JSON.stringify(state)));
      for (const rel of walk(archiveDir)) put(path.join('archive', rel), fs.readFileSync(path.join(archiveDir, rel)));
      writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify({ at: Date.now(), reason, files, counts }, null, 1));
      const v = verifyDir(dir);
      const removed = rotate();
      const h = v.ok ? await runHook(dir) : null;
      return { name, at: Date.now(), reason, ok: v.ok && (!h || h.ok), verified: v.ok, problem: v.problem || (h && !h.ok ? `외부 복사 실패(${h.code}) ${h.out}` : ''), files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), ms: Date.now() - t0, removed, hook: h ? { ok: h.ok, code: h.code } : null };
    } catch (e) {
      console.error('백업 실패', e);
      return { name, at: Date.now(), reason, ok: false, verified: false, problem: e.message, files: 0, bytes: 0, ms: Date.now() - t0 };
    }
  }
  function verify(name) {
    if (!/^hb-\d{8}-\d{6}(-\d+)?$/.test(name || '')) return { ok: false, problem: '없는 백업' };
    const dir = path.join(backupDir, name);
    return fs.existsSync(dir) ? verifyDir(dir) : { ok: false, problem: '없는 백업' };
  }
  return { append, read, stats, run, list, verify, rotate, archiveDir, backupDir, hook: !!hook, keepDaily, keepMonthly };
}

// ---- 지식 검색 (간단한 2글자 묶음 겹침 점수) ----
const normText = t => String(t || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function grams(t) { const s = normText(t).replace(/\s+/g, ''), g = new Set(); for (let i = 0; i + 2 <= s.length; i++) g.add(s.slice(i, i + 2)); return g; }
function rank(items, query, n = 5) {
  const q = grams(query); if (!q.size) return [];
  return items.map(it => { const g = grams(`${it.title} ${it.title} ${(it.tags || []).join(' ')} ${it.body}`); let hit = 0; for (const x of q) if (g.has(x)) hit++; return { it, score: hit / q.size }; })
    .filter(x => x.score >= 0.25).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.it);
}

module.exports = { create, writeAtomic, rank, month, kst, sha256 };

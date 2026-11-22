// 구성원별 AI 사용량 + 기업 지식베이스(업무 AI 근거) + 영구 기록(500개 넘는 대화) + 백업(무결성·보관 주기·외부 복사 훅·자동)
const path = require('path'), os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-kbt-'));
process.env.DATA_FILE = path.join(TMP, 'data.json');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
let FAILS = 0;
const chk = (n, c) => { if (!c) FAILS++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const KBM = require(path.join(__dirname, '..', 'kb.js'));
const LLMM = require(path.join(__dirname, '..', 'llm.js'));

(async () => {
  // --- 단위: 영구 기록·백업 ---
  const K = KBM.create({ archiveDir: path.join(TMP, 'u-arch'), backupDir: path.join(TMP, 'u-bk'), keepDaily: 2, keepMonthly: 0, hook: `echo "$BACKUP_NAME" >> "${path.join(TMP, 'hook.txt')}"` });
  K.append('o1', 'msgs', { at: Date.now(), text: '첫 대화' }); K.append('o1', 'msgs', { at: Date.now(), text: '둘째' }); K.append('o1', 'kb', { at: Date.now(), op: 'create' });
  chk('영구 기록: 기업별·종류별로 읽기', K.read('o1', 'msgs').length === 2 && K.read('o1', 'kb').length === 1 && K.read('o2', 'msgs').length === 0);
  chk('영구 기록 통계', K.stats('o1').msgs === 2 && K.stats('o1').kbEvents === 1);
  const b1 = await K.run({ hello: 1 }, 'manual');
  chk('백업: 파일 무결성 확인 + 외부 복사 훅 실행', b1.ok && b1.verified && b1.files === 3 && fs.readFileSync(path.join(TMP, 'hook.txt'), 'utf8').includes(b1.name));
  fs.appendFileSync(path.join(TMP, 'u-bk', b1.name, 'archive', 'o1', fs.readdirSync(path.join(TMP, 'u-bk', b1.name, 'archive', 'o1')).find(f => f.startsWith('msgs'))), 'x');
  chk('백업 파일이 바뀌면 무결성 확인 실패', !K.verify(b1.name).ok && /불일치/.test(K.verify(b1.name).problem));
  await K.run({}, 'manual'); await K.run({}, 'manual');
  chk('보관 주기: 최근 2개만 남김', K.list().length === 2 && !K.list().some(x => x.name === b1.name));
  chk('이상한 백업 이름 거부', !K.verify('../etc').ok);
  const K2 = KBM.create({ archiveDir: path.join(TMP, 'u2-arch'), backupDir: path.join(TMP, 'u2-bk'), hook: 'exit 3' });
  const b2 = await K2.run({}, 'manual');
  chk('외부 복사 실패는 백업 문제로 표시', !b2.ok && b2.verified && /외부 복사 실패/.test(b2.problem));
  const items = [{ title: '거래처 행복마트 납품 조건', body: '월 2회 화요일 납품, 결제는 말일', tags: ['거래처'] }, { title: '휴가 규칙', body: '연차는 2주 전 신청', tags: [] }];
  chk('지식 찾기: 관련 항목 우선', KBM.rank(items, '행복마트 납품 언제야')[0] === items[0] && KBM.rank(items, '전혀관계없는질문').length === 0);
  let rep = null;
  const L = LLMM.create({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'http://gpu', LLM_MODEL: 'm' }, { onUsage: u => { rep = u; } });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '가나다라마바' } }] }) });
  await L.generate('시스템', '질문입니다', 100);
  chk('토큰 수를 안 주는 추론 서버 → 글자 수로 추정 표시', rep && rep.est === true && rep.out === 3 && rep.provider === 'openai' && rep.ok);
  global.fetch = realFetch;

  // --- 통합 ---
  const seen = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url), ok = r => ({ ok: true, status: 200, json: async () => r });
    if (u.includes('/v1/messages')) {
      const b = JSON.parse(opt.body); seen.push(b);
      const kbHit = b.system.includes('[지식 #1]');
      return ok({ stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 40 }, content: [{ type: 'text', text: kbHit ? '행복마트는 월 2회 화요일 납품이에요 (지식 #1).' : '정리해 드릴게요. 행복마트 납품: 월 2회 화요일, 결제는 말일.' }] });
    }
    return ok({ ok: true, result: {} });
  };
  Object.assign(process.env, { ADMIN_PASSWORD: 'adminpass', ANTHROPIC_API_KEY: 'k', PORT: '3993', TELEGRAM_BOT_TOKEN: '', BACKUP_HOUR: '0', BACKUP_TICK_MS: '300', BACKUP_KEEP_DAILY: '5', ARCHIVE_DIR: '', BACKUP_DIR: '' });
  delete process.env.ARCHIVE_DIR; delete process.env.BACKUP_DIR;
  require(path.join(__dirname, '..', 'server.js'));
  const http = require('http');
  function mk() { let ck = ''; return (p, b, raw) => new Promise(r => { const q = http.request('http://localhost:3993' + p, { method: b ? 'POST' : 'GET', headers: ck ? { cookie: ck } : {} }, res => { const sc = res.headers['set-cookie']; if (sc) ck = sc[0].split(';')[0]; const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const buf = Buffer.concat(ch); let j; try { j = raw ? buf.toString() : JSON.parse(buf); } catch (e) { j = buf.toString(); } r({ s: res.statusCode, j, h: res.headers }); }); }); if (b) q.write(JSON.stringify(b)); q.end(); }); }
  const A = mk(), U1 = mk(), U2 = mk(), X = mk(), sl = ms => new Promise(r => setTimeout(r, ms));
  await sl(300);
  await A('/api/admin/login', { password: 'adminpass' });
  await A('/api/admin/orgs', { name: '마을빵공방', loginId: 'bread', password: 'password1', userName: '김대표' });
  await A('/api/admin/orgs', { name: '다른기업', loginId: 'other', password: 'password1' });
  let ad = (await A('/api/admin/state')).j;
  const o = ad.orgs.find(x => x.name === '마을빵공방').id;
  await A(`/api/admin/orgs/${o}/users`, { loginId: 'staff', password: 'password1', userName: '=SUM(1)' });
  await A(`/api/admin/orgs/${o}/charge`, { amount: 50 });
  await U1('/api/login', { loginId: 'bread', password: 'password1' });
  await U2('/api/login', { loginId: 'staff', password: 'password1' });
  await X('/api/login', { loginId: 'other', password: 'password1' });
  let st = (await U1('/api/state')).j;
  const r = st.rooms[0].id;
  chk('업무 AI 봇이 디렉터리에 있음', st.bots.some(b => b.id === 'ai' && !b.soon));
  await U1(`/api/rooms/${r}/invite`, { botId: 'ai' });
  const ask = async (U, q) => { await U(`/api/rooms/${r}/messages`, { text: q, to: 'ai' }); await sl(250); return (await U('/api/state')).j; };
  st = await ask(U1, '행복마트 납품 조건 정리해 줘');
  st = await ask(U2, '오늘 회의 요약해 줘');
  st = await ask(U2, '메일 초안 하나');
  const meMsgs = st.rooms[0].msgs.filter(m => m.from === 'me');
  chk('웹 메시지에 보낸 구성원 이름 기록', meMsgs[0].by === '김대표' && meMsgs[1].by === '=SUM(1)' && st.members === 2);

  const us = (await U1('/api/usage?days=7')).j;
  const m1 = us.members.find(m => m.name === '김대표'), m2 = us.members.find(m => m.name === '=SUM(1)');
  chk('구성원별 AI 호출·토큰(엔진이 준 실제 값)', m1.calls === 1 && m1.in === 120 && m1.out === 40 && m2.calls === 2 && m2.in === 240 && !m1.est);
  chk('구성원별 함께봇 토큰 차감', m1.hb === st.costs.ai && m2.hb === 2 * st.costs.ai && us.totals.hb === 3 * st.costs.ai);
  chk('봇별·날짜별·최근 내역', us.bots[0].name === '업무 AI' && us.bots[0].calls === 3 && us.daily.length === 7 && us.daily[6].calls === 3 && us.recent.length === 6);
  const csv = await U1('/api/usage.csv?days=7', null, true);
  chk('CSV 내려받기 (엑셀 수식 주입 막음)', csv.h['content-type'].startsWith('text/csv') && csv.j.includes('김대표') && csv.j.includes("\"'=SUM(1)\"") && !/,=SUM/.test(csv.j));
  chk('다른 기업은 우리 사용량이 안 보임', (await X('/api/usage?days=7')).j.members.every(m => m.calls === 0));

  // 지식베이스
  const botMsg = st.rooms[0].msgs.find(m => m.from === 'ai' && m.text.includes('행복마트'));
  let k = (await U1('/api/kb', { roomId: r, msgId: botMsg.id, title: '거래처 행복마트 납품 조건', tags: '거래처, 납품' })).j;
  chk('채팅 답변을 지식으로 저장 (출처 방·봇 기록)', k.ok && k.item.n === 1 && k.item.source.botName === '업무 AI' && k.item.tags.join() === '거래처,납품');
  st = await ask(U2, '행복마트 납품은 언제야?');
  const last = st.rooms[0].msgs.filter(m => m.from === 'ai').pop();
  chk('업무 AI가 관련 지식을 근거로 받고, 쓴 지식을 표시', seen[seen.length - 1].system.includes('[지식 #1] 거래처 행복마트 납품 조건') && last.kbRefs && last.kbRefs[0].n === 1);
  await U2(`/api/kb/${k.item.id}`, { title: '거래처 행복마트 납품 조건', body: '월 2회 화요일 납품, 결제는 말일. 담당: 박과장', tags: '거래처' });
  let kl = (await U1('/api/kb?q=' + encodeURIComponent('행복마트 담당'))).j;
  chk('고치기 → 이력 남김 · 찾기', kl.items[0].edits === 1 && kl.items[0].by === '=SUM(1)' && kl.items[0].body.includes('박과장'));
  chk('다른 기업은 지식 항목에 접근 못 함', (await X(`/api/kb/${k.item.id}`, { body: '해킹' })).s === 404 && (await X('/api/kb')).j.items.length === 0);
  await U1(`/api/kb/${k.item.id}/delete`, {});
  kl = (await U1('/api/kb')).j;
  chk('휴지통으로 → 목록에서 빠지고 휴지통에 있음', kl.items.length === 0 && kl.trash.length === 1);
  await U1(`/api/kb/${k.item.id}/restore`, {});
  chk('되살리기', (await U1('/api/kb')).j.items.length === 1);

  // 화면 제한(500개)을 넘는 대화도 전부 보관
  for (let i = 0; i < 505; i++) await U1(`/api/rooms/${r}/messages`, { text: `기록 ${i}` });
  st = (await U1('/api/state')).j;
  kl = (await U1('/api/kb')).j;
  chk('화면은 최근 500개, 서버 기록은 전부', st.rooms[0].msgs.length === 500 && kl.status.archive.msgs >= 505 + 8);
  const ex = (await U1('/api/kb/export', null, true));
  const exj = JSON.parse(ex.j);
  chk('지식베이스 전체 내려받기(JSON): 지식·대화 전부·문서·사용 내역', exj.format === 'hamkkebot-kb/1' && exj.kb.length === 1 && exj.kb[0].history.length === 1 && exj.messages.length >= 513 && exj.messages.some(m => m.text === '기록 0') && exj.usage.length >= 8 && exj.doc.length >= 1);
  const md = (await U1('/api/kb/export?format=md', null, true)).j;
  chk('지식만 문서로(MD)', md.includes('## #1 거래처 행복마트 납품 조건') && md.includes('박과장'));

  // 백업
  await sl(700);
  ad = (await A('/api/admin/state')).j;
  chk('매일 정해진 시각 이후 자동 백업 1회', ad.backup.history.filter(x => x.reason === 'daily').length === 1 && ad.backup.last.ok);
  const bk = (await A('/api/admin/backup/run', {})).j;
  chk('관리자 지금 백업 → 무결성 확인', bk.ok && bk.backup.verified && bk.backup.files >= 4);
  const snap = JSON.parse(fs.readFileSync(path.join(TMP, 'data-backups', bk.backup.name, 'data.json'), 'utf8'));
  chk('백업에 지식 항목·사용 내역 포함', snap.orgs.find(x => x.id === o).kb.items[0].body.includes('박과장') && fs.readdirSync(path.join(TMP, 'data-backups', bk.backup.name, 'archive', o)).some(f => f.startsWith('usage-')));
  chk('백업 다시 확인', (await A('/api/admin/backup/verify', { name: bk.backup.name })).j.ok === true);
  chk('관리자: 기업별 이번 달 AI 사용', ad.usageMonth[o] && ad.usageMonth[o].calls === 4 && ad.usageMonth[o].in === 480);
  kl = (await U1('/api/kb')).j;
  chk('기업 화면: 마지막 백업 시각·무결성 표시', kl.status.backup.lastOkAt && kl.status.backup.verified === true && kl.status.backup.hour === 0);
  chk('data.json은 임시 파일 거쳐 저장 (남은 임시 파일 없음)', fs.existsSync(process.env.DATA_FILE) && !fs.readdirSync(TMP).some(f => f.endsWith('.tmp')));
  console.log(FAILS ? `\n${FAILS}개 실패` : '\n전부 통과');
  process.exit(FAILS ? 1 : 0);
})();

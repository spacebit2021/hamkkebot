// 모든 *.test.js를 따로 실행하고, 하나라도 실패하면 종료 코드 1
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
let failed = 0;
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', ADMIN_PASSWORD: '' } });
  const out = (r.stdout + r.stderr).split('\n').filter(l => /^(PASS|FAIL)|Error/.test(l));
  console.log(out.join('\n'));
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n실패한 파일 ${failed}개` : '\n모두 통과');
process.exit(failed ? 1 : 0);

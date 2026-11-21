// 실행: npm test  (가짜 텔레그램·Claude 응답으로 서버 흐름을 시험합니다. 실제 API는 호출하지 않습니다)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
require('fs').writeFileSync(process.env.DATA_FILE,JSON.stringify({org:{name:'옛기업',mission:'m'},wallet:{balance:7},rooms:[{id:'r1',name:'방',bots:[],msgs:[]}],experts:[],ledger:[{type:'charge',amount:7}]}));
Object.assign(process.env,{ADMIN_PASSWORD:'adminpass',PORT:'3994'});
require(path.join(__dirname, '..', 'server.js'));
const http=require('http');
function mk(){let ck='';return (p,b)=>new Promise(r=>{const q=http.request('http://localhost:3994'+p,{method:b?'POST':'GET',headers:ck?{cookie:ck}:{}},res=>{const sc=res.headers['set-cookie'];if(sc)ck=sc[0].split(';')[0];let d='';res.on('data',c=>d+=c);res.on('end',()=>r(JSON.parse(d)))});if(b)q.write(JSON.stringify(b));q.end()})}
const A=mk(),U1=mk(),U2=mk();
const chk=(n,c)=>{if(!c)FAILS++;console.log((c?'PASS ':'FAIL ')+n)};
(async()=>{await A('/api/admin/login',{password:'adminpass'});
 const st=await A('/api/admin/state');chk('migrated old data into one org',st.orgs.length===1&&st.orgs[0].name==='옛기업'&&st.orgs[0].wallet===7&&st.orgs[0].rooms===1);
 await A('/api/admin/orgs/o1/users',{loginId:'old',password:'password1'});
 await A('/api/admin/orgs',{name:'신규',loginId:'new1',password:'password1'});
 await U1('/api/login',{loginId:'old',password:'password1'});await U2('/api/login',{loginId:'new1',password:'password1'});
 // SSE isolation: listen as U1
 const ck1=await new Promise(r=>{const q=http.request('http://localhost:3994/api/login',{method:'POST'},res=>r(res.headers['set-cookie'][0].split(';')[0]));q.write(JSON.stringify({loginId:'old',password:'password1'}));q.end()});
 const got=[];http.get('http://localhost:3994/api/events',{headers:{cookie:ck1}},res=>res.on('data',c=>got.push(String(c))));
 await new Promise(r=>setTimeout(r,200));
 const r2=(await U2('/api/state')).rooms[0].id;
 await U2(`/api/rooms/${r2}/messages`,{text:'비밀'});
 await U1(`/api/rooms/r1/messages`,{text:'내것'});
 await new Promise(r=>setTimeout(r,200));
 const ev=got.join('');chk('live events: own org received',ev.includes('"roomId":"r1"'));chk('live events: other org not received',!ev.includes(r2));
 process.exit(FAILS?1:0)})();

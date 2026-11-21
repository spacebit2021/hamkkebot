// 실행: npm test  (가짜 텔레그램·Claude 응답으로 서버 흐름을 시험합니다. 실제 API는 호출하지 않습니다)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const sent=[];const queue=[];let waiter=null;let mid=100;
const realFetch=global.fetch;
global.fetch=async(url,opt={})=>{const u=String(url);const body=opt.body?JSON.parse(opt.body):{};
 const ok=r=>({ok:true,status:200,json:async()=>r});
 if(u.includes('api.anthropic.com'))return ok({content:[{type:'text',text:'초안 for '+(body.system.match(/기업명: (.*)/)||[])[1]}],stop_reason:'end_turn'});
 if(u.endsWith('/getMe'))return ok({ok:true,result:{username:'hb'}});
 if(u.includes('getUpdates'))return new Promise(r=>{const f=()=>{if(queue.length)r(ok({ok:true,result:queue.splice(0)}));else waiter=f};f()});
 if(u.includes('/sendMessage')){mid++;sent.push([body.chat_id,mid,body.text.slice(0,60).replace(/\n/g,' | ')]);return ok({ok:true,result:{message_id:mid}})}
 return ok({ok:true,result:{}})};
const push=(...us)=>{queue.push(...us);if(waiter){const w=waiter;waiter=null;w()}};
const P=(id,text,type='private',extra={})=>({update_id:Math.floor(Math.random()*1e9),message:{chat:{id,type,title:type==='group'?'그룹':undefined},from:{first_name:'홍'},text,...extra}});
Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'x',ANTHROPIC_API_KEY:'k',ADMIN_PASSWORD:'adminpass',PORT:'3995'});
require(path.join(__dirname, '..', 'server.js'));
const http=require('http');
function mk(){let ck='';return (p,b)=>new Promise(r=>{const q=http.request('http://localhost:3995'+p,{method:b?'POST':'GET',headers:ck?{cookie:ck}:{}},res=>{const sc=res.headers['set-cookie'];if(sc)ck=sc[0].split(';')[0];let d='';res.on('data',c=>d+=c);res.on('end',()=>{let j;try{j=JSON.parse(d)}catch(e){j=d}r({s:res.statusCode,j})})});if(b)q.write(JSON.stringify(b));q.end()})}
const A=mk(),U1=mk(),U2=mk(),X=mk();const sl=ms=>new Promise(r=>setTimeout(r,ms));
const chk=(n,c)=>{if(!c)FAILS++;console.log((c?'PASS ':'FAIL ')+n)};
(async()=>{await sl(300);
 chk('admin state needs login',(await A('/api/admin/state')).s===401);
 chk('bad admin pw',(await A('/api/admin/login',{password:'nope'})).s===401);
 chk('admin login',(await A('/api/admin/login',{password:'adminpass'})).s===200);
 chk('create org1',(await A('/api/admin/orgs',{name:'빵공방',loginId:'bread',password:'password1'})).s===200);
 chk('create org2',(await A('/api/admin/orgs',{name:'꽃가게',loginId:'flower',password:'password2'})).s===200);
 chk('dup loginId',(await A('/api/admin/orgs',{name:'x',loginId:'bread',password:'password1'})).s===400);
 chk('short pw',(await A('/api/admin/orgs',{name:'x',loginId:'xx1',password:'123'})).s===400);
 chk('user state needs login',(await U1('/api/state')).s===401);
 chk('wrong pw',(await U1('/api/login',{loginId:'bread',password:'bad'})).s===401);
 chk('u1 login',(await U1('/api/login',{loginId:'bread',password:'password1'})).s===200);
 chk('u2 login',(await U2('/api/login',{loginId:'FLOWER',password:'password2'})).s===200);
 const s1=(await U1('/api/state')).j, s2=(await U2('/api/state')).j;
 chk('u1 sees only own rooms',s1.rooms.length===1&&s1.org.name==='빵공방');
 const r1=s1.rooms[0].id, r2=s2.rooms[0].id;
 chk('u2 cannot post in u1 room',(await U2(`/api/rooms/${r1}/messages`,{text:'hack'})).s===404);
 chk('user cannot call admin api',(await U1('/api/admin/state')).s===401);
 chk('admin session cannot call user api',(await A('/api/state')).s===401);
 { const oo=(await A('/api/admin/state')).j.orgs.find(o=>o.name==='빵공방').id; await A(`/api/admin/orgs/${oo}/charge`,{amount:1}); }
 await U1(`/api/rooms/${r1}/invite`,{botId:'mkt'});
 await U1('/api/org',{name:'빵공방',mission:'우리밀'});
 await U1(`/api/rooms/${r1}/messages`,{text:'홍보',to:'mkt'});await sl(100);
 const m1=(await U1('/api/state')).j.rooms[0].msgs;chk('bot used org1 info',m1.some(m=>m.from==='mkt'&&m.text.includes('빵공방')));
 // tokens
 const orgs=(await A('/api/admin/state')).j.orgs;const o1=orgs.find(o=>o.name==='빵공방').id;
 await A(`/api/admin/orgs/${o1}/charge`,{amount:10,memo:'배정'});
 chk('wallet separated',(await U1('/api/state')).j.wallet===10&&(await U2('/api/state')).j.wallet===0);
 // expert
 const ex=(await A('/api/admin/experts',{name:'김세무',field:'세무사'})).j;
 chk('user cannot create expert',(await U1('/api/admin/experts',{name:'a',field:'b'})).s===401);
 chk('unlinked expert hidden from users',(await U1('/api/state')).j.experts.length===0);
 push(P(77,'/expert '+ex.regCode));await sl(200);push(P(77,'/rate 5'));await sl(150);
 chk('linked expert visible',(await U2('/api/state')).j.experts.length===1);
 const o2=orgs.find(o=>o.name==='꽃가게').id; await A(`/api/admin/orgs/${o2}/charge`,{amount:10});
 await U1(`/api/rooms/${r1}/call`,{expertId:ex.id,text:'세무 질문'});
 await U2(`/api/rooms/${r2}/call`,{expertId:ex.id,text:'꽃집 질문'});await sl(100);
 const callToU2=sent.filter(s=>s[0]===77).pop()[1];
 push(P(77,'꽃집 답변',undefined,{reply_to_message:{message_id:callToU2}}));await sl(200);
 const st1=(await U1('/api/state')).j.rooms[0].msgs, st2=(await U2('/api/state')).j.rooms[0].msgs;
 chk('reply routed to org2 only',st2.some(m=>m.text==='꽃집 답변')&&!st1.some(m=>m.text==='꽃집 답변'));
 await U1(`/api/rooms/${r1}/end`,{expertId:ex.id});
 const pm=(await U1('/api/state')).j.rooms[0].msgs.find(m=>m.pay);
 chk('u2 cannot pay via u1 msg',(await U2(`/api/rooms/${r2}/pay`,{msgId:pm.id,amount:1})).s===404);
 chk('u1 pays 4',(await U1(`/api/rooms/${r1}/pay`,{msgId:pm.id,amount:4})).j.wallet===6);
 chk('admin delete org with balance blocked',(await A(`/api/admin/orgs/${o1}/delete`,{})).s===400);
 chk('payout',(await A('/api/admin/payout',{expertId:ex.id,amount:4})).s===200);
 // telegram link per org
 const code=(await U2(`/api/rooms/${r2}/link`,{})).j.code;
 push(P(-5,'/link '+code,'group'));await sl(200);
 push(P(-5,'@hb 꽃 홍보문구','group'));await sl(300);
 const st2b=(await U2('/api/state')).j.rooms[0];chk('group linked to org2',st2b.tgChatId===-5&&st2b.msgs.some(m=>m.from==='mkt'&&m.text.includes('꽃가게')));
 push(P(-9,'@hb 아무거나','group'));await sl(200);
 chk('unlinked group gets instructions, no AI',sent.filter(s=>s[0]===-9).every(s=>s[2].includes('연결되지')));
 // password change / reset kills session
 const u=(await A('/api/admin/state')).j.orgs.find(o=>o.name==='빵공방').users[0];
 await A(`/api/admin/users/${u.id}/password`,{password:'newpassword'});
 chk('reset kills old session',(await U1('/api/state')).s===401);
 chk('login new pw',(await U1('/api/login',{loginId:'bread',password:'newpassword'})).s===200);
 chk('change pw wrong current',(await U1('/api/password',{current:'x',next:'abcdefgh'})).s===400);
 chk('change pw ok',(await U1('/api/password',{current:'newpassword',next:'abcdefgh1'})).s===200);
 chk('static index',(await X('/')).s===200&&(await X('/admin')).s===200);
 chk('events need login',(await X('/api/events')).s===401);
 process.exit(FAILS?1:0)})().catch(e=>{console.error(e);process.exit(1)});

// 실행: npm test  (가짜 텔레그램·Claude 응답으로 서버 흐름을 시험합니다. 실제 API는 호출하지 않습니다)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const sent=[];const queue=[];let waiter=null;let mid=100;
global.fetch=async(url,opt={})=>{const u=String(url);const body=opt.body?JSON.parse(opt.body):{};
 const ok=r=>({ok:true,status:200,json:async()=>r});
 if(u.endsWith('/getMe'))return ok({ok:true,result:{username:'hb'}});
 if(u.includes('getUpdates'))return new Promise(r=>{const f=()=>{if(queue.length)r(ok({ok:true,result:queue.splice(0)}));else waiter=f};f()});
 if(u.includes('/sendMessage')){mid++;sent.push({to:body.chat_id,id:mid,text:body.text});return ok({ok:true,result:{message_id:mid}})}
 return ok({ok:true,result:{}})};
const push=(...us)=>{queue.push(...us);if(waiter){const w=waiter;waiter=null;w()}};
let uid=1;const M=(chatId,fromId,text,type='private',extra={})=>({update_id:uid++,message:{message_id:5000+uid,chat:{id:chatId,type,title:type==='group'?'세무노무 팀':undefined},from:{id:fromId,first_name:'u'+fromId},text,...extra}});
Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'x',ADMIN_PASSWORD:'adminpass',PORT:'3990'});
require(path.join(__dirname, '..', 'server.js'));
const http=require('http');
function mk(){let ck='';return (p,b)=>new Promise(r=>{const q=http.request('http://localhost:3990'+p,{method:b?'POST':'GET',headers:ck?{cookie:ck}:{}},res=>{const sc=res.headers['set-cookie'];if(sc)ck=sc[0].split(';')[0];let d='';res.on('data',c=>d+=c);res.on('end',()=>{let j;try{j=JSON.parse(d)}catch(e){j=d}r({s:res.statusCode,j})})});if(b)q.write(JSON.stringify(b));q.end()})}
const A=mk(),U=mk();const sl=ms=>new Promise(r=>setTimeout(r,ms));
const chk=(n,c)=>{if(!c)FAILS++;console.log((c?'PASS ':'FAIL ')+n)};
const last=id=>(sent.filter(s=>s.to===id).pop()||{text:''}).text;
const G=-300;
(async()=>{await sl(300);
 await A('/api/admin/login',{password:'adminpass'});
 await A('/api/admin/orgs',{name:'빵공방',loginId:'bread',password:'password1'});
 const o=(await A('/api/admin/state')).j.orgs[0].id; await A(`/api/admin/orgs/${o}/charge`,{amount:100});
 await U('/api/login',{loginId:'bread',password:'password1'});
 const e1=(await A('/api/admin/experts',{name:'김세무',field:'세무'})).j, e2=(await A('/api/admin/experts',{name:'이노무',field:'노무'})).j, e3=(await A('/api/admin/experts',{name:'박디자인',field:'디자인'})).j;
 for(const [id,e] of [[71,e1],[72,e2],[73,e3]]){push(M(id,id,'/expert '+e.regCode));await sl(60);push(M(id,id,'/rate 5'));await sl(60);}
 const r=(await U('/api/state')).j.rooms[0].id;
 await U(`/api/rooms/${r}/call`,{expertId:e1.id,text:'인건비 지원금 정산과 근로계약서가 궁금해요'});
 await U(`/api/rooms/${r}/call`,{expertId:e2.id,text:''});await sl(100);
 push(M(G,71,'/team','group'));await sl(60);push(M(G,73,'/team','group'));await sl(60);
 push(M(G,71,'/rooms','group'));await sl(60);push(M(G,71,'/use 1','group'));await sl(100);
 // uncalled 박디자인 asks to join
 push(M(G,73,'/send 저도 의견 있어요','group'));await sl(80);chk('uncalled send hints /join',last(G).includes('/join'));
 push(M(G,73,'/join 홍보물 디자인 관점에서 함께 보고 싶어요','group'));await sl(100);
 let st=(await U('/api/state')).j.rooms[0];const jm=st.msgs.find(m=>m.join);
 chk('join card in company room',jm&&jm.join.name==='박디자인'&&jm.join.rate===5&&jm.join.note.includes('홍보물')&&!jm.join.status);
 chk('expert told request sent',last(G).includes('참여 요청을 보냈어요'));
 push(M(G,73,'/join 다시','group'));await sl(80);chk('duplicate join blocked',last(G).includes('이미 참여 요청'));
 chk('still not active',!st.humans.includes(e3.id));
 // other org cannot approve
 await A('/api/admin/orgs',{name:'꽃가게',loginId:'flower',password:'password2'});const U2=mk();await U2('/api/login',{loginId:'flower',password:'password2'});
 chk('other org cannot approve',(await U2(`/api/rooms/${r}/join`,{msgId:jm.id,approve:true})).s===404);
 // expert raises rate after request; approval uses requested rate
 push(M(73,73,'/rate 9'));await sl(80);
 chk('approve',(await U(`/api/rooms/${r}/join`,{msgId:jm.id,approve:true})).s===200);await sl(80);
 st=(await U('/api/state')).j.rooms[0];
 chk('joined, rate locked at request (5)',st.humans.includes(e3.id)&&st.consults[e3.id].rate===5);
 chk('team told approved',sent.filter(s=>s.to===G).some(s=>s.text.includes('참여를 승인')));
 chk('approve twice blocked',(await U(`/api/rooms/${r}/join`,{msgId:jm.id,approve:true})).s===400);
 push(M(G,73,'/send 포스터 문구는 짧게 가요','group'));await sl(100);
 st=(await U('/api/state')).j.rooms[0];chk('joined expert can send',st.msgs.some(m=>m.from==='hx'&&m.name==='박디자인'&&m.text.includes('포스터')));
 push(M(G,73,'/end','group'));await sl(100);
 st=(await U('/api/state')).j.rooms[0];const pm=st.msgs.filter(m=>m.pay&&m.pay.expertId===e3.id).pop();
 chk('joined expert gets own pay card',pm&&pm.pay.rate===5);
 // decline path
 push(M(G,73,'/join 한 번 더','group'));await sl(100);
 const jm2=(await U('/api/state')).j.rooms[0].msgs.filter(m=>m.join).pop();
 chk('decline',(await U(`/api/rooms/${r}/join`,{msgId:jm2.id,approve:false})).s===200);await sl(60);
 st=(await U('/api/state')).j.rooms[0];chk('declined: not active, team told',!st.humans.includes(e3.id)&&last(G).includes('거절'));
 // unavailable expert cannot request
 push(M(73,73,'/off'));await sl(60);push(M(G,73,'/join','group'));await sl(80);chk('unavailable cannot join',last(G).includes('꺼져'));
 process.exit(FAILS?1:0)})().catch(e=>{console.error(e);process.exit(1)});

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
Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'x',ADMIN_PASSWORD:'adminpass',PORT:'3991'});
require(path.join(__dirname, '..', 'server.js'));
const http=require('http');
function mk(){let ck='';return (p,b)=>new Promise(r=>{const q=http.request('http://localhost:3991'+p,{method:b?'POST':'GET',headers:ck?{cookie:ck}:{}},res=>{const sc=res.headers['set-cookie'];if(sc)ck=sc[0].split(';')[0];let d='';res.on('data',c=>d+=c);res.on('end',()=>{let j;try{j=JSON.parse(d)}catch(e){j=d}r({s:res.statusCode,j})})});if(b)q.write(JSON.stringify(b));q.end()})}
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
 // team room
 push(M(G,71,'/team','group'));await sl(80);chk('team registered',last(G).includes('팀방 멤버로 등록'));
 push(M(G,999,'/rooms','group'));await sl(80);chk('non-expert blocked',last(G).includes('등록된 전문가만'));
 push(M(G,72,'안녕하세요 김세무님, 계약서는 제가 볼게요','group'));await sl(80);
 chk('chit-chat not sent to company',!(await U('/api/state')).j.rooms[0].msgs.some(m=>m.text.includes('계약서는 제가')));
 push(M(G,71,'/rooms','group'));await sl(80);chk('rooms lists consult with both',last(G).includes('1. 빵공방')&&last(G).includes('김세무, 이노무'));
 push(M(G,71,'/use 1','group'));await sl(100);
 let st=(await U('/api/state')).j.rooms[0];chk('attached + company informed',st.xg===G&&st.msgs.some(m=>m.text.includes('전문가 팀방')));
 const dmBefore=sent.filter(s=>s.to===71||s.to===72).length;
 await U(`/api/rooms/${r}/messages`,{text:'서류 목록 부탁드려요'});await sl(100);
 chk('company msg mirrored to team',last(G).includes('[기업 · 웹앱]')&&last(G).includes('서류 목록'));
 chk('members not double-DMed',sent.filter(s=>s.to===71||s.to===72).length===dmBefore);
 push(M(G,71,'/send 통장사본과 급여대장이 필요해요','group'));await sl(100);
 st=(await U('/api/state')).j.rooms[0];chk('send → web app as 김세무',st.msgs.some(m=>m.from==='hx'&&m.name==='김세무'&&m.text.includes('통장사본')));
 chk('own send not echoed back to team',!sent.filter(s=>s.to===G).some(s=>s.text.startsWith('[김세무 전문가]')));
 // reply-send of colleague's message
 const draft=M(G,72,'근로계약서는 표준양식으로 쓰시면 됩니다','group');push(draft);await sl(60);
 push(M(G,72,'/s','group',{reply_to_message:{message_id:draft.message.message_id,text:draft.message.text,from:{id:72}}}));await sl(100);
 push(M(G,71,'/s','group',{reply_to_message:{message_id:draft.message.message_id,text:draft.message.text,from:{id:72}}}));await sl(100);
 st=(await U('/api/state')).j.rooms[0];
 chk('reply /s sends colleague text',st.msgs.some(m=>m.name==='이노무'&&m.text.includes('표준양식')));
 chk('co-authored note',st.msgs.some(m=>m.name&&m.name.includes('김세무 (이노무 전문가와 함께 정리)')));
 // 3rd expert in group but not called
 push(M(G,73,'/send 저도 한마디','group'));await sl(100);
 chk('uncalled expert cannot send',last(G).includes('호출되지 않아서')||last(G).includes('호출된 상담이 없어요'));
 chk('/link blocked in team room',(push(M(G,71,'/link ABC','group')),await sl(80),last(G).includes('팀방은 기업 방과 연결할 수 없어요')));
 // end both → auto detach
 push(M(G,71,'/end','group'));await sl(100);
 st=(await U('/api/state')).j.rooms[0];chk('e1 ended, still attached (e2 active)',!st.humans.includes(e1.id)&&st.xg===G&&st.msgs.some(m=>m.pay&&m.pay.expertId===e1.id));
 push(M(G,72,'/end','group'));await sl(150);
 st=(await U('/api/state')).j.rooms[0];chk('auto-detached after last member ended',!st.xg&&last(G).includes('연결을 해제'));
 await U(`/api/rooms/${r}/messages`,{text:'감사합니다'});await sl(80);
 chk('no mirror after detach',!last(G).includes('감사합니다'));
 // company group still works as before
 const code=(await U(`/api/rooms/${r}/link`,{})).j.code;push(M(-400,9,'/link '+code,'group'));await sl(100);
 chk('company group link still works',(await U('/api/state')).j.rooms[0].tgChatId===-400);
 process.exit(FAILS?1:0)})().catch(e=>{console.error(e);process.exit(1)});

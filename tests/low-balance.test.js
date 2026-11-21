// 실행: npm test  (가짜 텔레그램·Claude 응답으로 서버 흐름을 시험합니다. 실제 API는 호출하지 않습니다)
const path = require('path'), os = require('os');
process.env.DATA_FILE = path.join(os.tmpdir(), 'hb-test-' + process.pid + '.json');
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
process.on('exit', () => { try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {} });
let FAILS = 0;
const sent=[];const queue=[];let waiter=null;let mid=100;const edits=[];
global.fetch=async(url,opt={})=>{const u=String(url);const body=opt.body?JSON.parse(opt.body):{};
 const ok=r=>({ok:true,status:200,json:async()=>r});
 if(u.endsWith('/getMe'))return ok({ok:true,result:{username:'hb'}});
 if(u.includes('getUpdates'))return new Promise(r=>{const f=()=>{if(queue.length)r(ok({ok:true,result:queue.splice(0)}));else waiter=f};f()});
 if(u.includes('/sendMessage')){mid++;sent.push({to:body.chat_id,id:mid,text:body.text,btn:body.reply_markup});return ok({ok:true,result:{message_id:mid}})}
 if(u.includes('editMessageReplyMarkup'))edits.push(body.message_id);
 return ok({ok:true,result:{}})};
const push=(...us)=>{queue.push(...us);if(waiter){const w=waiter;waiter=null;w()}};
const P=(id,text)=>({update_id:Math.floor(Math.random()*1e9),message:{chat:{id,type:'private'},from:{first_name:'김'},text}});
const CB=(id,data,msgId)=>({update_id:Math.floor(Math.random()*1e9),callback_query:{id:'cb'+Math.random(),data,from:{id},message:{chat:{id},message_id:msgId}}});
Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'x',ADMIN_PASSWORD:'adminpass',PORT:'3992'});
const srv=require(path.join(__dirname, '..', 'server.js'));
const http=require('http');
function mk(){let ck='';return (p,b)=>new Promise(r=>{const q=http.request('http://localhost:3992'+p,{method:b?'POST':'GET',headers:ck?{cookie:ck}:{}},res=>{const sc=res.headers['set-cookie'];if(sc)ck=sc[0].split(';')[0];let d='';res.on('data',c=>d+=c);res.on('end',()=>{let j;try{j=JSON.parse(d)}catch(e){j=d}r({s:res.statusCode,j})})});if(b)q.write(JSON.stringify(b));q.end()})}
const A=mk(),U=mk();const sl=ms=>new Promise(r=>setTimeout(r,ms));
const chk=(n,c)=>{if(!c)FAILS++;console.log((c?'PASS ':'FAIL ')+n)};
const last=id=>sent.filter(s=>s.to===id).pop();
(async()=>{await sl(300);
 await A('/api/admin/login',{password:'adminpass'});
 await A('/api/admin/orgs',{name:'빵공방',loginId:'bread',password:'password1'});
 const o=(await A('/api/admin/state')).j.orgs[0].id; await A(`/api/admin/orgs/${o}/charge`,{amount:2});
 await U('/api/login',{loginId:'bread',password:'password1'});
 const ex=(await A('/api/admin/experts',{name:'김세무',field:'세무사'})).j;
 push(P(77,'/expert '+ex.regCode));await sl(100);push(P(77,'/rate 6'));await sl(100);
 const room=()=>U('/api/state').then(x=>x.j.rooms[0]);const r=(await room()).id;
 // 1) low balance → request with buttons
 const c1=await U(`/api/rooms/${r}/call`,{expertId:ex.id,text:'질문1'});
 chk('low balance → requested',c1.j.requested===true);
 let m=last(77);chk('expert gets warning + buttons',m.text.includes('잔액 부족')&&m.text.includes('약 20분')&&m.btn.inline_keyboard[0].length===2);
 chk('not yet in consult',(await room()).humans.length===0&&(await room()).pending.length===1);
 chk('duplicate request blocked',(await U(`/api/rooms/${r}/call`,{expertId:ex.id,text:'x'})).s===400);
 push(P(77,'아직 수락 안 했는데 답장',)); await sl(100);
 // reply before accept should not reach room
 const reqMsg=m.id;
 push({update_id:1e9+1,message:{chat:{id:77,type:'private'},from:{first_name:'김'},text:'답장 먼저',reply_to_message:{message_id:reqMsg}}});await sl(100);
 chk('reply before accept not routed',!(await room()).msgs.some(x=>x.text==='답장 먼저')&&last(77).text.includes('수락'));
 // 2) accept via button
 const qid=m.btn.inline_keyboard[0][0].callback_data;
 push(CB(77,qid,reqMsg));await sl(150);
 let rm=await room();chk('accepted → consult started, buttons removed',rm.humans.includes(ex.id)&&rm.pending.length===0&&edits.includes(reqMsg));
 chk('accept noted in room',rm.msgs.some(x=>x.text.includes('수락했어요')));
 push(CB(77,qid,reqMsg));await sl(100);chk('double click handled',last(77).text.includes('이미 처리'));
 // reply to request msg now routes
 push({update_id:1e9+2,message:{chat:{id:77,type:'private'},from:{first_name:'김'},text:'이제 답변',reply_to_message:{message_id:reqMsg}}});await sl(100);
 chk('reply after accept routed',(await room()).msgs.some(x=>x.from==='hx'&&x.text==='이제 답변'));
 await U(`/api/rooms/${r}/end`,{expertId:ex.id});
 // 3) decline via /decline text
 await U(`/api/rooms/${r}/call`,{expertId:ex.id,text:'질문2'});await sl(50);
 push(P(77,'/decline'));await sl(150);
 rm=await room();chk('decline → room notified, no consult',rm.pending.length===0&&!rm.humans.includes(ex.id)&&rm.msgs.some(x=>x.text.includes('사양')));
 // 4) cancel by org
 await U(`/api/rooms/${r}/call`,{expertId:ex.id,text:'질문3'});await sl(50);
 chk('org cancels',(await U(`/api/rooms/${r}/cancelcall`,{expertId:ex.id})).s===200&&last(77).text.includes('취소'));
 // 5) enough balance → direct; then exhaustion warning
 await A(`/api/admin/orgs/${o}/charge`,{amount:4}); // wallet 6 (=rate)
 const c5=await U(`/api/rooms/${r}/call`,{expertId:ex.id,text:'질문4'});chk('enough balance → direct call',!c5.j.requested&&(await room()).humans.includes(ex.id));
 const realNow=Date.now;Date.now=()=>realNow()+30*60000; srv.checkBalances(); await sl(100);
 chk('no warning at 30min (3 < 6)',!last(77).btn);
 Date.now=()=>realNow()+61*60000; srv.checkBalances(); await sl(100);
 m=last(77);chk('warning at 61min with buttons',m.text.includes('잔액(6개)에 닿았어요')&&m.btn.inline_keyboard[0][1].callback_data==='e:'+r);
 srv.checkBalances(); await sl(50);chk('warned only once',sent.filter(s=>s.to===77&&s.text.includes('닿았어요')).length===1);
 push(CB(77,'e:'+r,m.id));await sl(150);
 rm=await room();const pm=rm.msgs.filter(x=>x.pay).pop();Date.now=realNow;
 chk('end from warning → pay card computed',!rm.humans.includes(ex.id)&&pm.pay.suggested===7);
 chk('pay more than wallet blocked',(await U(`/api/rooms/${r}/pay`,{msgId:pm.id,amount:7})).s===400);
 chk('pay wallet amount ok',(await U(`/api/rooms/${r}/pay`,{msgId:pm.id,amount:6})).j.wallet===0);
 process.exit(FAILS?1:0)})().catch(e=>{console.error(e);process.exit(1)});

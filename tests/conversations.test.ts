import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Store,validateBackup} from '../core/store';
import {recordConversation,markUnsubscribe} from '../core/inbox';
import {interpretationHistory,saveHumanInterpretation} from '../core/interpretations';
import {emptyInterpretation} from '../core/interpretation-input';
import {replySetup,reserveReply,finishReply} from '../core/reply-analysis';
import {defaultConversationRules,saveConversationRules,conversationState,conversationPreview,saveConversationCase,applyConversationRules,tickConversations,exportConversations} from '../core/conversations';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-conversations-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
 const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id;
 let brief=s.addSource(a,{kind:'manual',url:'',title:'Synthetic',text:'Synthetic product'},0);brief=s.reviewSource(a,brief.content.sources[0].id,brief.revision,true);Object.assign(brief.content.rules,{offer:'CSV',targets:'Companies',personas:'IT',claims:'CSV'});brief.content.routes.analysis.model='test';brief.content.routes.writing.model='test';brief=s.saveRules(a,{...brief.content,revision:brief.revision});s.approveBrief(a,brief.revision,1);
 const mailboxId=randomUUID(),mail=s.reserveMailTest(a,{id:randomUUID(),clientVersion:1,mailboxId,sender:'sender@example.com',recipient:'lead@example.com',subject:'Original',body:'Synthetic'});s.finishMailTest(a,mail.id,'sent','sent123','OK');
 function reply(excerpt='Kein Interesse.',receivedAt='2026-10-01T12:00:00.000Z'){const providerId=randomUUID();recordConversation(s,a,mail.id,{clientVersion:s.client(a).version,mailboxId,rows:[{providerId,threadId:'thread123',sender:'lead@example.com',subject:'Antwort',excerpt,receivedAt,kind:'reply',evidence:'{}'}]});return String(s.db.prepare("SELECT id FROM evidence_events WHERE source='incoming' AND providerId=?").get(providerId)!.id);}
 function human(id:string,patch:any={}){const h=interpretationHistory(s,a,id);return saveHumanInterpretation(s,a,id,{expectedRevision:h.revision,expectedBasisHash:h.basisHash,reviewer:'Operator',content:{...emptyInterpretation(),replyType:'rejection',technicalQuestion:'no',materialRequest:'no',meetingIntent:'no',requiresHumanReview:false,rationale:'Human assessment',...patch}});}
 function configure(patch:any={}){const p=conversationState(s,a).policy;return saveConversationRules(s,a,{expectedId:p.current?.id||null,clientVersion:p.clientVersion,briefRevision:p.briefRevision,rules:{...defaultConversationRules(),enabled:true,...patch},actor:'Operator',reason:'Synthetic test',confirmed:true});}
 function decide(status:string,dueDate:string|null=null){const p=conversationPreview(s,a,mail.recipient);return saveConversationCase(s,a,{recipient:mail.recipient,expectedId:p.current?.id||null,basisHash:p.basisHash,status,dueDate,actor:'Operator',reason:'Explicit decision',confirmed:true});}
 function model(id:string,patch:any={}){const setup=replySetup(s,a,id),r=reserveReply(s,a,id,{basisHash:setup.basisHash,confirmed:true});const value={replyType:'rejection',technicalQuestion:'no',materialRequest:'no',meetingIntent:'no',confidence:'high',unsubscribe:'no',privacyRequest:'no',rejectionScope:'contact',returnDate:null,dateQuote:'',quotes:[setup.context.transport.excerpt],rationale:'Synthetic assessment',...patch};return finishReply(s,a,r.id,{status:'completed',text:JSON.stringify(value),usage:{}});}
 return {get s(){return s;},a,b,dir,file,backups,mail,reply,human,configure,decide,model,reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}};
}
test('rules are opt-in, versioned, bound to customer and brief approval, and do not mutate send records',()=>{
 const f=fixture();try{const id=f.reply();f.human(id);const before=f.s.exportBackup().data;assert.equal(applyConversationRules(f.s,f.a).applied,0);const p=f.configure();assert.equal(p.active,true);assert.equal(applyConversationRules(f.s,f.a).applied,1);const c=conversationState(f.s,f.a).cases[0].current!;assert.equal(c.status,'cooldown_until');assert.equal(c.dueDate,'2026-12-30');assert.equal(applyConversationRules(f.s,f.a).applied,0);const after=f.s.exportBackup().data;for(const k of ['incoming','mailTests','leads','queueRuns','queueItems','evidenceEvents','interpretations'] as const)assert.deepEqual(before[k],after[k]);
 f.configure({cooldownDays:30});assert.equal(applyConversationRules(f.s,f.a).applied,0);assert.equal(conversationState(f.s,f.a).cases[0].current!.dueDate,'2026-12-30');
 const b=f.s.brief(f.a);f.s.saveRules(f.a,{...b.content,revision:b.revision});assert.equal(conversationState(f.s,f.a).policy.active,false);assert.equal(applyConversationRules(f.s,f.a).applied,0);assert.throws(()=>f.configure(),/Kundenrahmen/);f.configure({enabled:false});
 }finally{f.close();}
});
test('model absence produces a fixed due task only after explicit model-use permission',()=>{
 const f=fixture();try{f.model(f.reply('Ich bin ab 8.10.2026 wieder erreichbar.'),{replyType:'out_of_office',rejectionScope:'none',returnDate:'2026-10-08',dateQuote:'8.10.2026'});f.configure({allowModel:true,absenceDelayDays:2});applyConversationRules(f.s,f.a);const early=conversationState(f.s,f.a,0,new Date('2026-10-09T23:59:00Z'));assert.equal(early.cases[0].current!.dueDate,'2026-10-10');assert.equal(early.dueCount,0);assert.equal(conversationState(f.s,f.a,0,new Date('2026-10-10T00:00:00Z')).dueCount,1);assert.equal(f.s.exportBackup().data.incoming![0].disposition,'open');assert.throws(()=>f.s.reserveMailTest(f.a,{id:randomUUID(),clientVersion:1,mailboxId:f.mail.mailboxId,sender:'sender@example.com',recipient:f.mail.recipient,subject:'No',body:'No'}),/angehalten/);
 }finally{f.close();}
});
test('uncertain, privacy, account rejection and unapproved model outputs become human cases',()=>{
 for(const patch of [{confidence:'low'},{privacyRequest:'yes'},{unsubscribe:'yes'},{rejectionScope:'account'},{technicalQuestion:'unknown'},{}]){const f=fixture();try{f.model(f.reply(),patch);f.configure({allowModel:Object.keys(patch).length>0});applyConversationRules(f.s,f.a);assert.equal(conversationState(f.s,f.a).cases[0].current!.status,'needs_review');assert.equal(f.s.exportBackup().data.incoming![0].disposition,'open');}finally{f.close();}}
});
test('missing, withdrawn, ambiguous or manually uncertain assessments never create a cooldown',()=>{
 for(const kind of ['missing','withdrawn','ambiguous','review']){const f=fixture();try{const id=f.reply();if(kind!=='missing')f.human(id,{withdrawn:kind==='withdrawn',requiresHumanReview:kind==='review'});if(kind==='ambiguous')f.reply('Neue Frage');f.configure();applyConversationRules(f.s,f.a);assert.equal(conversationState(f.s,f.a).cases[0].current!.status,'needs_review');}finally{f.close();}}
});
test('new incoming invalidates an old due task and automatic processing creates a new version',()=>{
 const f=fixture();try{f.human(f.reply());f.configure({cooldownDays:1});applyConversationRules(f.s,f.a);f.reply('Doch Interesse','2026-10-02T12:00:00.000Z');const stale=conversationState(f.s,f.a,0,new Date('2027-01-01'));assert.equal(stale.cases[0].stale,true);assert.equal(stale.dueCount,0);applyConversationRules(f.s,f.a);const state=conversationState(f.s,f.a);assert.equal(state.cases[0].current!.revision,2);assert.equal(state.cases[0].current!.status,'needs_review');assert.equal(state.cases[0].history.length,2);
 }finally{f.close();}
});
test('human decisions are not overwritten by later assessments of the same incoming',()=>{
 const f=fixture();try{const id=f.reply();f.human(id);f.configure();applyConversationRules(f.s,f.a);f.decide('closed');f.human(id,{replyType:'interest'});assert.equal(applyConversationRules(f.s,f.a).applied,0);assert.equal(conversationState(f.s,f.a).cases[0].current!.status,'closed');f.reply('New question','2026-10-02T12:00:00.000Z');assert.equal(applyConversationRules(f.s,f.a).applied,1);assert.equal(conversationState(f.s,f.a).cases[0].current!.status,'needs_review');
 }finally{f.close();}
});
test('manual permanent suppression is atomic, sticky and retained across an older restore',()=>{
 const f=fixture();try{f.reply();const old=f.s.exportBackup();f.configure();f.decide('permanent_suppression');assert.equal(f.s.exportBackup().data.incoming![0].disposition,'unsubscribe');assert.throws(()=>f.decide('closed'),/Kontaktverbot/);f.s.restore(old);assert.equal(conversationState(f.s,f.a).cases[0].current!.status,'permanent_suppression');assert.equal(f.s.exportBackup().data.incoming![0].disposition,'unsubscribe');assert.equal(conversationState(f.s,f.a).policy.active,false);validateBackup(f.s.exportBackup());
 }finally{f.close();}
});
test('storage failure rolls back both new permanent suppression and its case record',()=>{
 const f=fixture();try{f.reply();f.s.db.exec("CREATE TRIGGER synthetic_case_failure BEFORE INSERT ON events WHEN NEW.type='CONVERSATION_CASE_SAVED' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");assert.throws(()=>f.decide('permanent_suppression'));assert.equal(f.s.exportBackup().data.incoming![0].disposition,'open');assert.equal(conversationState(f.s,f.a).cases[0].current,null);assert.equal(f.s.exportBackup().data.events.filter(e=>e.type==='UNSUBSCRIBE_CONFIRMED').length,0);f.s.db.exec('DROP TRIGGER synthetic_case_failure');f.decide('permanent_suppression');
 }finally{f.close();}
});
test('stale preview, foreign customer, invalid dates and missing explicit consent are rejected',()=>{
 const f=fixture();try{f.reply();const p=conversationPreview(f.s,f.a,f.mail.recipient),input={recipient:f.mail.recipient,expectedId:null,basisHash:p.basisHash,status:'closed',dueDate:null,actor:'Tester',reason:'Test',confirmed:true};assert.throws(()=>saveConversationCase(f.s,f.b,input));assert.throws(()=>saveConversationCase(f.s,f.a,{...input,confirmed:false}));assert.throws(()=>saveConversationCase(f.s,f.a,{...input,extra:'send'}));assert.throws(()=>f.decide('absence_until','2026-02-30'));assert.throws(()=>f.decide('absence_until','2020-01-01'));f.configure();assert.throws(()=>saveConversationCase(f.s,f.a,input),/geändert/);f.decide('closed');assert.throws(()=>saveConversationCase(f.s,f.a,input),/geändert/);
 }finally{f.close();}
});
test('rule limits and approvals cannot be changed using stale or incomplete settings',()=>{
 const f=fixture();try{const p=conversationState(f.s,f.a).policy,input={expectedId:null,clientVersion:p.clientVersion,briefRevision:p.briefRevision,rules:defaultConversationRules(),actor:'Operator',reason:'Test',confirmed:true};for(const value of [{cooldownDays:0},{cooldownDays:366},{absenceDelayDays:31},{allowModel:'yes'}])assert.throws(()=>saveConversationRules(f.s,f.a,{...input,rules:{...input.rules,...value}}));assert.throws(()=>saveConversationRules(f.s,f.a,{...input,confirmed:false}));f.configure();assert.throws(()=>saveConversationRules(f.s,f.a,input),/geändert/);
 }finally{f.close();}
});
test('policy processing is bounded and restarting cannot duplicate a decision',()=>{
 const f=fixture();try{for(let i=0;i<3;i++){const m=f.s.reserveMailTest(f.a,{id:randomUUID(),clientVersion:1,mailboxId:f.mail.mailboxId,sender:'sender@example.com',recipient:`p${i}@example.com`,subject:'Synthetic',body:'Synthetic'});f.s.finishMailTest(f.a,m.id,'sent','provider'+i,'OK');recordConversation(f.s,f.a,m.id,{clientVersion:1,mailboxId:m.mailboxId,rows:[{providerId:'reply'+i,threadId:'t'+i,sender:m.recipient,subject:'Re',excerpt:'Question',receivedAt:'2026-10-01T12:00:00Z',kind:'reply',evidence:'{}'}]});}f.configure();assert.equal(applyConversationRules(f.s,f.a,2).applied,2);f.reopen();assert.equal(applyConversationRules(f.s,f.a,2).applied,1);assert.equal(tickConversations(f.s).applied,0);assert.equal(conversationState(f.s,f.a).cases.length,3);
 }finally{f.close();}
});
test('backup rejects forged case basis, rules, derivation and broken history; export retains all versions',()=>{
 const f=fixture();try{f.human(f.reply());f.configure();applyConversationRules(f.s,f.a);f.decide('closed');const backup=f.s.exportBackup();validateBackup(backup);for(const mutate of [(b:any)=>b.version=21,(b:any)=>{b.data.events=b.data.events.filter((e:any)=>e.type!=='CONVERSATION_RULES_SAVED');},(b:any)=>{const e=b.data.events.find((e:any)=>e.type==='CONVERSATION_CASE_SAVED'),v=JSON.parse(e.text);v.dueDate='2099-01-01';e.text=JSON.stringify(v);},(b:any)=>{const e=b.data.events.find((e:any)=>e.type==='CONVERSATION_CASE_SAVED'),v=JSON.parse(e.text);v.basis.source.excerpt='forged';e.text=JSON.stringify(v);},(b:any)=>{const e=b.data.events.find((e:any)=>e.type==='CONVERSATION_CASE_SAVED'),v=JSON.parse(e.text);v.previousId=randomUUID();e.text=JSON.stringify(v);}]){const b=structuredClone(backup);mutate(b);assert.throws(()=>validateBackup(resign(b)));}assert.equal(exportConversations(f.s,f.a).events.length,3);assert.equal(exportConversations(f.s,f.b).events.length,0);
 }finally{f.close();}
});
test('model-linked decisions survive checkpoint, restore rehearsal and retained older history',()=>{
 const f=fixture();try{f.model(f.reply());const old=f.s.exportBackup();f.configure({allowModel:true});applyConversationRules(f.s,f.a);const backup=f.s.exportBackup();assert.equal(rehearseRestore(backup).schema,34);f.s.restore(old);assert.equal(conversationState(f.s,f.a).cases[0].current!.status,'cooldown_until');const cp=saveCheckpoint(join(f.dir,'checkpoint'),f.dir);assert.equal(validateBackup(JSON.parse(readFileSync(cp.filename,'utf8'))).version,34);
 }finally{f.close();}
});
test('schema21 migration preserves mail and prior data and writes a version21 recovery backup',()=>{
 const f=fixture();try{f.reply();const before=f.s.exportBackup().data;f.s.db.exec('PRAGMA user_version=21');f.reopen();assert.equal(f.s.snapshot().database.schema,34);assert.deepEqual(f.s.exportBackup().data,before);const file=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!;assert.equal(validateBackup(JSON.parse(readFileSync(join(f.backups,file),'utf8'))).version,21);
 }finally{f.close();}
});
test('conversation API requires authentication and isolates customer histories',async()=>{
 const f=fixture(),token='t'.repeat(64),server=await startServer(f.s,token,600000);try{f.reply();f.configure();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},base=server.url+`/api/clients/${f.a}`;assert.equal((await fetch(base+'/conversation-state')).status,401);assert.equal((await fetch(base+'/conversation-process',{method:'POST',headers,body:'{}'})).status,200);const page:any=await(await fetch(base+'/conversation-state',{headers})).json();assert.equal(page.cases.length,1);const foreign:any=await(await fetch(server.url+`/api/clients/${f.b}/conversation-state`,{headers})).json();assert.equal(foreign.cases.length,0);assert.equal((await fetch(base+'/conversation-state?offset=-1',{headers})).status,400);
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
test('incoming order and cooldown dates use instants and UTC instead of lexical timezone strings',()=>{
 const f=fixture();try{f.human(f.reply('First','2026-10-01T00:30:00+02:00'));const later=f.reply('Later','2026-09-30T23:00:00Z');f.human(later);f.configure({cooldownDays:1});applyConversationRules(f.s,f.a);const c=conversationState(f.s,f.a).cases[0].current!;assert.equal(c.basis.eventId,later);assert.equal(c.dueDate,'2026-10-01');
 }finally{f.close();}
});
test('the actual local server tick processes enabled rules without a renderer request',async()=>{
 const f=fixture();f.human(f.reply());f.configure();const server=await startServer(f.s,'t'.repeat(64),10);const original=Date.now,clock=original();
 try{Date.now=()=>clock+31000;for(let i=0;i<60&&!conversationState(f.s,f.a).cases[0].current;i++)await new Promise(r=>setTimeout(r,10));assert.equal(conversationState(f.s,f.a).cases[0].current!.origin,'rule');assert.equal(conversationState(f.s,f.a).cases[0].history.length,1);}
 finally{Date.now=original;await server.close();rmSync(f.dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

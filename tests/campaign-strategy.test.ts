import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {saveProduct} from '../core/catalog';
import {knowledgeState,saveKnowledge} from '../core/knowledge';
import {campaignStrategy} from '../core/campaign-strategy';
import {campaignMessaging} from '../core/campaign-messaging';
import {writingSetup,writingRuns,reserveWriting,finishWriting,adoptWriting} from '../core/campaign-writing';
import {startServer} from '../core/server';
import {saveStrategy,strategyState} from '../core/strategy';
import {createRequire} from 'node:module';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
import {validateCampaign,type CampaignContent} from '../core/campaign';
import {prepareQueue,controlQueue,queueState,activateLiveQueue,claimOutbound,authorizeOutbound} from '../core/outbox';
import {rehearseRestore} from '../core/recovery';
const product={name:'Synthetic',description:'CSV export',website:'',bookingUrl:'',archived:false};
const source={title:'Synthetic source',locator:'Test document',capturedAt:'2026-09-01T12:00:00.000Z',text:'The product exports CSV.',withdrawn:false};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-campaign-knowledge-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
 const client=s.createClient({name:'A',website:'',email:'',notes:''}),foreign=s.createClient({name:'B',website:'',email:'',notes:''});
 let b=s.addSource(client.id,{kind:'manual',url:'',title:'Brief',text:'Synthetic offer'},0);b=s.reviewSource(client.id,b.content.sources[0].id,b.revision,true);Object.assign(b.content.rules,{offer:'CSV',targets:'Companies',personas:'IT',claims:'CSV'});b.content.routes.analysis.model='test';b.content.routes.writing.model='test';b=s.saveRules(client.id,{...b.content,revision:b.revision});s.approveBrief(client.id,b.revision,client.version);
 const csv={csv:'email;company\nlead@example.com;Synthetic',delimiter:';',filename:'test.csv',mapping:{email:0,company:1,firstName:-1,lastName:-1,role:-1}};s.importLeads(client.id,{...csv,fingerprint:s.previewLeads(client.id,csv).fingerprint});
 const p=saveProduct(s,client.id,null,product,0),ref={productId:p.productId,revision:1};
 const form:CampaignContent={name:'Pilot',leadIds:[s.leads(client.id).rows[0].id],dailyLimit:1,startDate:'2026-10-01',startHour:0,endHour:24,weekdays:[0,1,2,3,4,5,6],timezone:'UTC',steps:[{subject:'Synthetic',body:'CSV export',gapDays:0}],productRef:ref};
 function write(kind:string,content:any,entityId:string|null=null,action='save'){
   const state=knowledgeState(s,client.id,p.productId),old=state.items.find(r=>r.entityId===entityId);
   return saveKnowledge(s,client.id,p.productId,{kind,content,entityId,expectedRevision:old?.revision||0,productRevision:state.productRevision,action,actor:'Tester',reason:'Synthetic evidence'});
 }
 const src=write('source',source),draft=write('claim',{category:'feature',text:'CSV export is available.',sourceId:src.id,quote:source.text});
 function review(action='approve',entityId=draft.entityId){const row=knowledgeState(s,client.id,p.productId).items.find(r=>r.entityId===entityId)!;return write('claim',row.content,entityId,action);}
 const claim=review();
 function approved(bound=true){const c=s.saveCampaign(client.id,{content:{...form,...(bound?{knowledgeIds:[claim.id]}:{})}}),preview=s.campaignPreview(client.id,c.id);s.approveCampaign(client.id,c.id,{confirmed:true,fingerprint:preview.fingerprint});return {c,preview};}
 const personaContent={code:'IT_LEADERSHIP',name:'IT-Leitung',responsibility:'Systeme und Integrationen',titles:['Head of IT','IT Director']};
 function strategy(kind:string,content:any,entityId:string|null=null,action='save'){
  const state=strategyState(s,client.id,p.productId),old=state.items.find(r=>r.entityId===entityId);
  return saveStrategy(s,client.id,p.productId,{kind,content,entityId,expectedRevision:old?.revision||0,productRevision:state.productRevision,action,actor:'Tester',reason:'Synthetic hypothesis test'});
 }
 function strategyReview(entityId:string,action='approve'){const r=strategyState(s,client.id,p.productId).items.find(r=>r.entityId===entityId)!;return strategy(r.kind,r.content,entityId,action);}
 const pd=strategy('persona',personaContent),pa=strategyReview(pd.entityId);
 const hypContent={name:'CSV for IT',personaId:pa.id,segment:'Manufacturers',pain:'Manual transfer',angle:'Interoperability',benefit:'Test process improvement',cta:'Compare CSV process',style:'Direct; no invented ROI',knowledgeIds:[claim.id]};
 const hd=strategy('hypothesis',hypContent),ha=strategyReview(hd.entityId);
 function bound(){const c=s.saveCampaign(client.id,{content:{...form,knowledgeIds:[claim.id],hypothesisId:ha.id}}),preview=s.campaignPreview(client.id,c.id);s.approveCampaign(client.id,c.id,{confirmed:true,fingerprint:preview.fingerprint});return {c,preview};}
 return {pd,pa,hd,ha,hypContent,personaContent,strategy,strategyReview,bound,get s(){return s;},a:client.id,b:foreign.id,dir,backups,form,ref,src,draft,claim,write,review,approved,reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};

test('hypothesis binding requires fixed UUID, product, approved hypothesis and complete facts',()=>{
 const f=fixture();try{
  const content={...f.form,knowledgeIds:[f.claim.id],hypothesisId:f.ha.id};
  for(const patch of [{hypothesisId:''},{hypothesisId:null},{hypothesisId:'bad'},{knowledgeIds:undefined},{productRef:undefined}])assert.throws(()=>validateCampaign({...content,...patch}));
  for(const id of [f.pd.id,f.pa.id,f.hd.id,randomUUID()])assert.throws(()=>f.s.saveCampaign(f.a,{content:{...content,hypothesisId:id}}));
  assert.throws(()=>f.s.saveCampaign(f.a,{content:{...content,knowledgeIds:[f.draft.id]}}));
  const other=saveProduct(f.s,f.a,null,product,0);assert.throws(()=>f.s.saveCampaign(f.a,{content:{...content,productRef:{productId:other.productId,revision:1}}}));
  assert.throws(()=>f.s.saveCampaign(f.b,{content}));assert.equal(f.s.campaigns(f.a).length,0);
  const extra=f.write('claim',{category:'benefit',text:'Another fact',sourceId:f.src.id,quote:source.text}),fact=f.review('approve',extra.entityId);
  assert.throws(()=>f.s.saveCampaign(f.a,{content:{...content,knowledgeIds:[fact.id]}}),/Produktfakten/);
  const c=f.s.saveCampaign(f.a,{content:{...content,knowledgeIds:[fact.id,f.claim.id]}});assert.equal(f.s.campaignPreview(f.a,c.id).problemCount,0);
 }finally{f.close();}
});

test('fixed hypothesis, persona, angle and facts survive history and queue preparation without changing texts',()=>{
 const f=fixture();try{
  const {c,preview}=f.bound(),run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  assert.deepEqual(preview.hypothesis?.content,f.hypContent);assert.equal(preview.hypothesis?.persona.id,f.pa.id);assert.equal(preview.hypothesis?.revision,2);
  assert.equal(run.snapshot.content.hypothesisId,f.ha.id);assert.deepEqual(run.snapshot.content.steps,f.form.steps);
  f.strategyReview(f.hd.entityId,'withdraw');const historical=f.s.campaignHistory(f.a,c.id).find(r=>r.action==='approved')!;
  assert.equal(historical.hypothesis?.id,f.ha.id);assert.equal(historical.hypothesis?.content.angle,'Interoperability');assert.equal(historical.hypothesis?.usable,false);
  f.reopen();assert.equal(f.s.campaignHistory(f.a,c.id)[0].hypothesis?.persona.content.code,'IT_LEADERSHIP');
 }finally{f.close();}
});

test('hypothesis, persona, facts, source and product changes invalidate approval and prepared run',()=>{
 for(const mode of ['withdraw','hypothesis','persona','personaWithdraw','fact','source','product','archive']){const f=fixture();try{
  const {c,preview}=f.bound(),run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  if(mode==='withdraw')f.strategyReview(f.hd.entityId,'withdraw');
  if(mode==='hypothesis')f.strategy('hypothesis',{...f.hypContent,angle:'Different angle'},f.hd.entityId);
  if(mode==='persona')f.strategy('persona',{...f.personaContent,name:'Changed'},f.pd.entityId);
  if(mode==='personaWithdraw')f.strategyReview(f.pd.entityId,'withdraw');
  if(mode==='fact')f.review('withdraw');
  if(mode==='source')f.write('source',{...source,title:'Changed'},f.src.entityId);
  if(mode==='product'||mode==='archive')saveProduct(f.s,f.a,f.ref.productId,{...product,name:'Changed',archived:mode==='archive'},1);
  const p=f.s.campaignPreview(f.a,c.id);assert.equal(p.approved,false,mode);assert.notEqual(p.fingerprint,preview.fingerprint,mode);assert.equal(p.hypothesis?.usable,false,mode);
  assert.throws(()=>controlQueue(f.s,f.a,run.id,{action:'start',revision:run.revision,confirmed:true}),/geändert/);
  assert.throws(()=>f.s.approveCampaign(f.a,c.id,{fingerprint:p.fingerprint,confirmed:true}),/Prüfhinweise/);
  assert.throws(()=>f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content:JSON.parse(c.content)}));
  assert.equal(queueState(f.s,f.a)[0].snapshot.content.hypothesisId,f.ha.id);
 }finally{f.close();}}
});

test('unrelated strategy changes do not invalidate bound or existing unbound campaigns',()=>{
 const f=fixture();try{
  const bound=f.bound(),unbound=f.approved();
  const other=f.strategy('hypothesis',{...f.hypContent,name:'Other angle'});f.strategyReview(other.entityId);
  assert.equal(f.s.campaignPreview(f.a,bound.c.id).fingerprint,bound.preview.fingerprint);
  f.strategyReview(f.hd.entityId,'withdraw');assert.equal(f.s.campaignPreview(f.a,unbound.c.id).fingerprint,unbound.preview.fingerprint);assert.equal(f.s.campaignPreview(f.a,unbound.c.id).approved,true);
  assert.equal(campaignStrategy(f.s,f.a,f.form),null);
 }finally{f.close();}
});

test('a withdrawn hypothesis after reservation blocks the final provider authorization',()=>{
 const f=fixture();try{
  const {c,preview}=f.bound();let run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  const mailboxId=randomUUID(),sender='sender@example.com',mail=f.s.reserveMailTest(f.a,{id:randomUUID(),mailboxId,clientVersion:1,sender,recipient:'owner@example.com',subject:'Test',body:'Test'});f.s.finishMailTest(f.a,mail.id,'sent','synthetic','OK');
  f.s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+f.a,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:mail.id,mailboxId,clientVersion:1,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
  run=activateLiveQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN',mailboxId,sender})[0];run=controlQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,action:'start'})[0];
  const at=new Date('2026-10-05T12:00:00Z'),q=claimOutbound(f.s,f.a,run.id,{mailboxId,sender},at)!;assert.ok(q);
  f.strategyReview(f.hd.entityId,'withdraw');assert.throws(()=>authorizeOutbound(f.s,f.a,run.id,q.id,{revision:q.runRevision,mailboxId,sender},at),/geändert/);
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='QUEUE_SEND_AUTHORIZED'").get()!.n,0);
 }finally{f.close();}
});

test('removing a hypothesis explicitly saves a new draft and cannot reuse the old approval',()=>{
 const f=fixture();try{
  const {c,preview}=f.bound();f.strategyReview(f.hd.entityId,'withdraw');
  const next=f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content:{...f.form,knowledgeIds:[f.claim.id]}});
  assert.equal(next.approvedHash,null);assert.equal(JSON.parse(next.content).hypothesisId,undefined);assert.throws(()=>f.s.approveCampaign(f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint}));
  assert.ok(f.s.campaignHistory(f.a,c.id).some(h=>h.hypothesis?.id===f.ha.id));
 }finally{f.close();}
});

test('backup rejects missing, swapped, stripped and downgraded hypothesis bindings while preserving history',()=>{
 const f=fixture();try{
  const {c,preview}=f.bound();prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint});
  const other=f.strategy('hypothesis',{...f.hypContent,name:'Other'}),otherApproved=f.strategyReview(other.entityId);
  f.strategyReview(f.hd.entityId,'withdraw');const original=f.s.exportBackup();assert.equal(rehearseRestore(original).restartVerified,true);
  for(const table of ['campaigns','campaignHistory','queueRuns'] as const){const b=structuredClone(original),r=b.data[table]![0] as any,key=table==='queueRuns'?'snapshot':'content',d=JSON.parse(r[key]);(table==='queueRuns'?d.content:d).hypothesisId=randomUUID();r[key]=JSON.stringify(d);assert.throws(()=>validateBackup(resign(b)),/Hypothesenbezug/);}
  for(const id of [undefined,otherApproved.id]){const b=structuredClone(original),d=JSON.parse(b.data.queueRuns![0].snapshot);d.content.hypothesisId=id;b.data.queueRuns![0].snapshot=JSON.stringify(d);assert.throws(()=>validateBackup(resign(b)),/Hypothesenbezug/);}
  const downgraded=structuredClone(original);downgraded.version=15;assert.throws(()=>validateBackup(downgraded),/Hypothesenbezug/);
  const stripped=structuredClone(original);stripped.data.campaignHistory=stripped.data.campaignHistory!.map(h=>{const d=JSON.parse(h.content);delete d.hypothesisId;return {...h,content:JSON.stringify(d)};});
  assert.throws(()=>f.s.restore(resign(stripped)),/Hypothesenbezug|Produktzuordnung/);
  f.s.restore(original);assert.equal(JSON.parse(f.s.campaign(f.a,c.id).content).hypothesisId,f.ha.id);assert.equal(f.s.campaignPreview(f.a,c.id).approved,false);
  const checkpoint=saveCheckpoint(join(f.dir,'checkpoint'),f.dir),saved=validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8')));assert.equal(saved.version,34);assert.equal(JSON.parse(saved.data.campaigns![0].content).hypothesisId,f.ha.id);
 }finally{f.close();}
});

test('schema15 migration backs up strategy and retains legacy approval and history exactly',()=>{
 const f=fixture();try{
  const {c,preview}=f.approved(),before=f.s.exportBackup().data.strategies;
  f.s.db.exec('DROP TABLE experiment_versions; PRAGMA user_version=15');f.reopen();assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.s.campaignPreview(f.a,c.id).fingerprint,preview.fingerprint);assert.equal(f.s.campaignPreview(f.a,c.id).approved,true);
  const file=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,backup=validateBackup(JSON.parse(readFileSync(join(f.backups,file),'utf8')));assert.equal(backup.version,15);assert.deepEqual(backup.data.strategies,JSON.parse(JSON.stringify(before)));
 }finally{f.close();}
});

function styled(f:ReturnType<typeof fixture>):CampaignContent{return {...f.form,knowledgeIds:[f.claim.id],hypothesisId:f.ha.id,sequence:{name:'Direct plus proof',style:'Short and factual'},steps:[{...f.form.steps[0],variant:{name:'Direct',style:''}},{subject:'Follow-up',body:'Compare your current process?',gapDays:7,variant:{name:'Process question',style:'One clear question'}}]};}
function approveStyled(f:ReturnType<typeof fixture>){const c=f.s.saveCampaign(f.a,{content:styled(f)}),p=f.s.campaignPreview(f.a,c.id);assert.equal(p.problemCount,0);f.s.approveCampaign(f.a,c.id,{fingerprint:p.fingerprint,confirmed:true});return {c,p};}

test('message metadata is bounded, complete, strict and requires a fixed approved hypothesis',()=>{
 const f=fixture();try{
  const c=styled(f);assert.deepEqual(validateCampaign(c),c);
  for(const bad of [null,{},[],{name:'',style:''},{name:'x'.repeat(101),style:''},{name:'x',style:'x'.repeat(1001)},{name:'x\n',style:''},{name:'x',style:'bad\0'},{name:'x',style:'ok',id:randomUUID()}]){
   assert.throws(()=>validateCampaign({...c,sequence:bad}));assert.throws(()=>validateCampaign({...c,steps:c.steps.map(s=>({...s,variant:bad}))}));
  }
  for(const patch of [{sequence:undefined},{hypothesisId:undefined},{steps:[{subject:'X',body:'Y',gapDays:0}]}])assert.throws(()=>validateCampaign({...c,...patch}));
  assert.throws(()=>f.s.saveCampaign(f.a,{content:{...c,hypothesisId:f.hd.id}}));assert.throws(()=>f.s.saveCampaign(f.b,{content:c}));
  assert.equal(campaignMessaging(f.a,f.form),null);
  const normalized=validateCampaign({...c,sequence:{name:' Sequence ',style:'  \n '}});assert.deepEqual(normalized.sequence,{name:'Sequence',style:''});
 }finally{f.close();}
});

test('variant identities follow normalized content and fixed scope; timing only changes sequence identity',()=>{
 const f=fixture();try{
  const c=styled(f),m=campaignMessaging(f.a,c)!;assert.match(m.sequenceId,/^sq1_[a-f0-9]{64}$/);assert.match(m.variants[0].variantId,/^mv1_[a-f0-9]{64}$/);assert.equal(m.variants[0].styleSource,'sequence');assert.equal(m.variants[1].styleSource,'variant');
  assert.deepEqual(campaignMessaging(f.a,{...c,name:'Campaign rename',leadIds:[],dailyLimit:2,startDate:'2026-11-01'}),m);
  const gap=campaignMessaging(f.a,{...c,steps:c.steps.map((s,i)=>({...s,gapDays:i?9:0}))})!;assert.notEqual(gap.sequenceId,m.sequenceId);assert.deepEqual(gap.variants.map(v=>v.variantId),m.variants.map(v=>v.variantId));
  for(const patch of [{body:'Different text'},{subject:'Different subject'},{variant:{name:'New label',style:''}},{variant:{name:'Direct',style:'Detailed'}}]){
   const next=campaignMessaging(f.a,{...c,steps:[{...c.steps[0],...patch},c.steps[1]]})!;assert.notEqual(next.variants[0].variantId,m.variants[0].variantId);assert.equal(next.variants[1].variantId,m.variants[1].variantId);assert.notEqual(next.sequenceId,m.sequenceId);
  }
  const changedStyle=campaignMessaging(f.a,{...c,sequence:{...c.sequence!,style:'Formal'}})!;assert.notEqual(changedStyle.variants[0].variantId,m.variants[0].variantId);assert.equal(changedStyle.variants[1].variantId,m.variants[1].variantId);
  const explicit=campaignMessaging(f.a,{...c,steps:c.steps.map((s,i)=>i?s:{...s,variant:{...s.variant!,style:c.sequence!.style}})})!;assert.notEqual(explicit.sequenceId,m.sequenceId,'explicit override and inheritance remain distinct versions');
  for(const patch of [{productRef:{...c.productRef!,revision:2}},{hypothesisId:randomUUID()},{knowledgeIds:[randomUUID()]}])assert.notEqual(campaignMessaging(f.a,{...c,...patch})!.variants[0].variantId,m.variants[0].variantId);
  assert.notEqual(campaignMessaging(f.b,c)!.sequenceId,m.sequenceId);
  assert.equal(campaignMessaging(f.a,{...c,steps:c.steps.map(s=>({...s,body:' '+s.body+' '}))})!.sequenceId,m.sequenceId);
  const inherit=campaignMessaging(f.a,{...c,sequence:{name:'Inherit',style:''}})!;assert.equal(inherit.variants[0].styleSource,'hypothesis');assert.equal(inherit.variants[0].effectiveStyle,'');
 }finally{f.close();}
});

test('sequence versions survive history, queue and restart without rewriting messages',()=>{
 const f=fixture();try{
  const {c,p}=approveStyled(f),run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint})[0],before=p.messaging;
  assert.deepEqual(campaignMessaging(f.a,run.snapshot.content),before);assert.equal(run.items[0].body,f.form.steps[0].body);
  const content=JSON.parse(c.content);content.steps[0].variant.style='More direct';const next=f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content});assert.equal(next.approvedHash,null);
  assert.notEqual(f.s.campaignPreview(f.a,c.id).messaging!.sequenceId,before!.sequenceId);
  assert.deepEqual(f.s.campaignHistory(f.a,c.id).find(h=>h.action==='approved')!.messaging,before);
  assert.throws(()=>controlQueue(f.s,f.a,run.id,{action:'start',confirmed:true,revision:run.revision}),/geändert/);
  assert.throws(()=>f.s.approveCampaign(f.a,c.id,{fingerprint:p.fingerprint,confirmed:true}),/geändert/);
  f.reopen();assert.deepEqual(f.s.campaignHistory(f.a,c.id).find(h=>h.action==='approved')!.messaging,before);
 }finally{f.close();}
});

test('message, style, timing and metadata removal after reservation block final provider authorization',()=>{
 for(const change of ['message','style','timing','remove']){const f=fixture();try{
  const {c,p}=approveStyled(f);let run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint})[0];
  const mailboxId=randomUUID(),sender='sender@example.com',mail=f.s.reserveMailTest(f.a,{id:randomUUID(),mailboxId,clientVersion:1,sender,recipient:'owner@example.com',subject:'Test',body:'Test'});f.s.finishMailTest(f.a,mail.id,'sent','synthetic','OK');
  f.s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+f.a,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:mail.id,mailboxId,clientVersion:1,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
  run=activateLiveQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN',mailboxId,sender})[0];run=controlQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,action:'start'})[0];
  const at=new Date('2026-10-05T12:00:00Z'),q=claimOutbound(f.s,f.a,run.id,{mailboxId,sender},at)!;assert.ok(q);
  const content=JSON.parse(c.content);if(change==='message')content.steps[0].body='New text';if(change==='style')content.sequence.style='New style';if(change==='timing')content.steps[1].gapDays=8;if(change==='remove'){delete content.sequence;for(const step of content.steps)delete step.variant;}
  f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content});assert.throws(()=>authorizeOutbound(f.s,f.a,run.id,q.id,{revision:q.runRevision,mailboxId,sender},at),/geändert/);
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='QUEUE_SEND_AUTHORIZED'").get()!.n,0);
 }finally{f.close();}}
});

test('message snapshots reject altered/stripped queue metadata and downgraded backups',()=>{
 const f=fixture();try{
  const {c,p}=approveStyled(f);prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint});const original=f.s.exportBackup();assert.equal(original.version,34);assert.equal(rehearseRestore(original).restartVerified,true);
  for(const change of ['name','style','remove','gap','body']){const b=structuredClone(original),r=b.data.queueRuns![0],snap=JSON.parse(r.snapshot);if(change==='name')snap.content.steps[0].variant.name='Altered';if(change==='style')snap.content.sequence.style='Altered';if(change==='gap')snap.content.steps[1].gapDays=8;if(change==='body')snap.content.steps[0].body='Altered';if(change==='remove'){delete snap.content.sequence;for(const step of snap.content.steps)delete step.variant;}r.snapshot=JSON.stringify(snap);assert.throws(()=>validateBackup(resign(b)),/Nachrichtenfassung/);}
  const downgraded=structuredClone(original);downgraded.version=18;assert.throws(()=>validateBackup(downgraded),/Sicherungsformat 19/);
  const contradictory=structuredClone(original),approved=contradictory.data.campaignHistory!.find(h=>h.action==='approved')!,otherContent=JSON.parse(approved.content);otherContent.sequence.name='Conflicting';contradictory.data.campaignHistory!.push({...approved,id:randomUUID(),content:JSON.stringify(otherContent)});assert.throws(()=>validateBackup(resign(contradictory)),/Widersprüchliche Nachrichtenfassungen/);
  const alteredHistory=structuredClone(original);for(const h of alteredHistory.data.campaignHistory!){const content=JSON.parse(h.content);content.sequence.name='Rewritten history';h.content=JSON.stringify(content);}assert.throws(()=>f.s.restore(resign(alteredHistory)));
  f.s.restore(original);f.reopen();assert.deepEqual(f.s.campaignPreview(f.a,c.id).messaging,p.messaging);assert.equal(f.s.campaignPreview(f.a,c.id).approved,false);
  const checkpoint=saveCheckpoint(join(f.dir,'message-checkpoint'),f.dir),saved=validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8')));assert.equal(saved.version,34);assert.deepEqual(JSON.parse(saved.data.campaigns![0].content).sequence,styled(f).sequence);
 }finally{f.close();}
});

test('schema18 migration preserves legacy fingerprint, history and approval with pre-upgrade backup',()=>{
 const f=fixture();try{
  const {c,preview}=f.bound(),history=f.s.campaignHistory(f.a,c.id);f.s.db.exec('PRAGMA user_version=18');f.reopen();
  assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.s.campaignPreview(f.a,c.id).fingerprint,preview.fingerprint);assert.equal(f.s.campaignPreview(f.a,c.id).approved,true);assert.equal(f.s.campaignPreview(f.a,c.id).messaging,null);assert.deepEqual(f.s.campaignHistory(f.a,c.id),history);
  const file=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,b=validateBackup(JSON.parse(readFileSync(join(f.backups,file),'utf8')));assert.equal(b.version,18);assert.equal(JSON.parse(b.data.campaigns![0].content).sequence,undefined);
 }finally{f.close();}
});


function writingFixture(){const f=fixture(),{c,p}=approveStyled(f);const setup=()=>writingSetup(f.s,f.a,c.id),reserve=(patch:any={})=>reserveWriting(f.s,f.a,c.id,{basisHash:setup().basisHash,confirmed:true,...patch}),steps=()=>styled(f).steps.map((_,i)=>({subject:'CSV process '+(i+1),body:'How do you use CSV at {{unternehmen}}?',factIds:[f.claim.id]}));
 const finish=(id:string,value:any={steps:steps()},status='completed')=>finishWriting(f.s,f.a,c.id,id,{status,text:typeof value==='string'?value:JSON.stringify(value),usage:{inputTokens:30,outputTokens:50}});
 const adopt=(id:string,patch:any={})=>adoptWriting(f.s,f.a,c.id,id,{steps:steps(),actor:'Reviewer',reason:'Facts and text checked',confirmed:true,...patch});
 return {f,c,p,setup,reserve,steps,finish,adopt};}

test('writing context excludes contact data and uses fixed product facts, hypothesis and step styles',()=>{
 const x=writingFixture(),{f}=x;try{const before=f.s.exportBackup().data,setup=x.setup(),run=x.reserve();assert.deepEqual(x.setup(),setup);assert.equal(run.purpose,'campaign-writing');const sent=JSON.parse(run.prompt.user);assert.equal(sent.facts[0].id,f.claim.id);assert.deepEqual(sent.steps,styled(f).steps);assert.equal(sent.hypothesis.id,f.ha.id);assert.equal(sent.rules.forbidden,f.s.brief(f.a).content.rules.forbidden);assert.doesNotMatch(run.prompt.user,/lead@example.com|leadIds|clientId|campaignFingerprint/);assert.ok(!run.prompt.user.includes(f.form.leadIds[0]));assert.equal(f.s.campaign(f.a,x.c.id).content,before.campaigns![0].content);
 assert.throws(()=>x.reserve(),/bereits/);assert.throws(()=>f.s.finishAI(f.a,run.id,'completed','fake',{}));assert.equal(f.s.briefState(f.a).runs.some((r:any)=>r.id===run.id),false);
 }finally{f.close();}
});

test('writing result is editable, adopted once as draft and preserves all non-text fields and provenance',()=>{
 const x=writingFixture(),{f}=x;try{const run=x.reserve();x.finish(run.id);const edits=x.steps();edits[0].body='Edited process question for {{unternehmen}}.';const saved=x.adopt(run.id,{steps:edits});assert.equal(saved.approvedHash,null);const content=JSON.parse(saved.content),old=JSON.parse(x.c.content);assert.deepEqual(content,{...old,steps:old.steps.map((step:any,i:number)=>({...step,subject:edits[i].subject,body:edits[i].body}))});assert.equal(f.s.mailTests(f.a).length,0);assert.equal(f.s.campaignHistory(f.a,x.c.id).filter(h=>h.action==='approved').length,1);assert.throws(()=>x.adopt(run.id),/erneut/);assert.throws(()=>f.s.reviewAI(f.a,run.id,'reviewed'));
 const event=f.s.exportBackup().data.events.find(e=>e.type==='CAMPAIGN_WRITING_ADOPTED')!;assert.equal(JSON.parse(event.text).runId,run.id);assert.equal(JSON.parse(event.text).campaignRevision,saved.revision);f.reopen();assert.equal(writingRuns(f.s,f.a,x.c.id)[0].adopted,true);
 const backup=f.s.exportBackup();validateBackup(backup);assert.equal(rehearseRestore(backup).restartVerified,true);f.s.restore(backup);assert.equal(writingRuns(f.s,f.a,x.c.id)[0].adopted,true);assert.equal(f.s.campaignPreview(f.a,x.c.id).approved,false);
 }finally{f.close();}
});

test('writing rejects stale transfer, foreign scope, unknown fields and missing consent before reserving',()=>{
 const x=writingFixture(),{f}=x;try{for(const patch of [{confirmed:false},{basisHash:'old'},{provider:'forged'}])assert.throws(()=>x.reserve(patch));assert.throws(()=>writingSetup(f.s,f.b,x.c.id));assert.throws(()=>reserveWriting(f.s,f.b,x.c.id,{basisHash:x.setup().basisHash,confirmed:true}));const legacy=f.bound();assert.throws(()=>writingSetup(f.s,f.a,legacy.c.id),/benannte/);assert.equal(f.s.exportBackup().data.aiRuns!.length,0);
 const stale=x.setup().basisHash;f.s.saveCampaign(f.a,{id:x.c.id,revision:x.c.revision,content:{...JSON.parse(x.c.content),name:'Changed'}});assert.throws(()=>x.reserve({basisHash:stale}),/veraltet/);
 }finally{f.close();}
});

test('writing rejects invalid structure, invented references, placeholders and strategy fields without raw-response leakage',()=>{
 const x=writingFixture(),{f}=x;try{const bad=['SECRET_RAW', {steps:[]},{steps:[...x.steps(),x.steps()[0]]},{steps:x.steps().map(s=>({...s,factIds:[randomUUID()]}))},{steps:x.steps().map(s=>({...s,body:'{{invented}}'}))},{steps:x.steps().map(s=>({...s,dailyLimit:999}))},{steps:x.steps().map(s=>({...s,subject:'Bad\nheader'}))}];for(const output of bad){const run=x.reserve(),r=x.finish(run.id,output).find(r=>r.id===run.id)!;assert.equal(r.status,'failed');assert.equal(r.steps.length,0);assert.doesNotMatch(r.message,/SECRET_RAW/);assert.throws(()=>x.finish(run.id),/abgeschlossen/);assert.throws(()=>x.adopt(run.id));}assert.equal(f.s.campaign(f.a,x.c.id).revision,x.c.revision);validateBackup(f.s.exportBackup());
 }finally{f.close();}
});

test('changed campaign, facts, hypothesis, operating frame and pause block adoption while preserving completed result',()=>{
 for(const mode of ['campaign','source','fact','hypothesis','brief','client']){const x=writingFixture(),{f}=x;try{const run=x.reserve();if(mode==='campaign')f.s.saveCampaign(f.a,{id:x.c.id,revision:x.c.revision,content:{...JSON.parse(x.c.content),name:'Changed'}});if(mode==='source')f.write('source',{...source,title:'Changed'},f.src.entityId);if(mode==='fact')f.review('withdraw');if(mode==='hypothesis')f.strategyReview(f.hd.entityId,'withdraw');if(mode==='brief'){const b=f.s.brief(f.a);f.s.saveRules(f.a,{...b.content,revision:b.revision});}if(mode==='client'){const c=f.s.client(f.a);f.s.updateClient(f.a,{...c,status:'paused'},c.version);}const r=x.finish(run.id).find(r=>r.id===run.id)!;assert.equal(r.status,'completed');assert.ok(r.stale,mode);assert.throws(()=>x.adopt(run.id));assert.equal(f.s.exportBackup().data.events.filter(e=>e.type==='CAMPAIGN_WRITING_ADOPTED').length,0);validateBackup(f.s.exportBackup());}finally{f.close();}}
});

test('writing shares daily budget and recovers interrupted requests without resubmission',()=>{
 const x=writingFixture(),{f}=x;try{let b=f.s.brief(f.a);b=f.s.saveRules(f.a,{...b.content,rules:{...b.content.rules,aiDailyLimit:1},revision:b.revision});f.s.approveBrief(f.a,b.revision,1);const run=x.reserve();f.reopen();assert.equal(writingRuns(f.s,f.a,x.c.id)[0].status,'unknown');assert.throws(()=>x.reserve(),/Tageslimit/);assert.throws(()=>x.finish(run.id),/abgeschlossen/);validateBackup(f.s.exportBackup());}finally{f.close();}
});

test('writing backup validates fixed inputs, results and adoption lineage, and retains known completed runs',()=>{
 const x=writingFixture(),{f}=x;try{const old=f.s.exportBackup(),run=x.reserve();x.finish(run.id);const complete=f.s.exportBackup();assert.equal(complete.version,34);for(const mutate of [(b:any)=>{b.version=19;},(b:any)=>{const r=b.data.aiRuns.find((r:any)=>r.id===run.id),d=JSON.parse(r.context);d.transport.facts[0].text='Forged';r.context=JSON.stringify(d);},(b:any)=>{b.data.aiRuns.find((r:any)=>r.id===run.id).result='{}';}]){const b=structuredClone(complete);mutate(b);assert.throws(()=>validateBackup(resign(b)));}
 f.s.restore(old);assert.equal(writingRuns(f.s,f.a,x.c.id)[0].status,'completed');assert.ok(writingRuns(f.s,f.a,x.c.id)[0].stale);assert.throws(()=>x.adopt(run.id));
 }finally{f.close();}
 const y=writingFixture();try{const run=y.reserve();y.finish(run.id);y.adopt(run.id);const good=y.f.s.exportBackup();for(const mode of ['event','review','campaign']){const b=structuredClone(good);if(mode==='event')b.data.events=b.data.events.filter(e=>e.type!=='CAMPAIGN_WRITING_ADOPTED');if(mode==='review')b.data.aiRuns!.find(r=>r.id===run.id)!.review='unreviewed';if(mode==='campaign'){const h=b.data.campaignHistory!.find(h=>h.action==='saved'&&h.revision===2)!;const c=JSON.parse(h.content);c.dailyLimit=2;h.content=JSON.stringify(c);}assert.throws(()=>validateBackup(resign(b)));}}finally{y.f.close();}
});

test('writing API requires native proof for reservation and finish; renderer cannot forge provider results',async()=>{
 const x=writingFixture(),{f}=x,token='l'.repeat(64),workerToken='w'.repeat(64),server=await startServer(f.s,token,100000,workerToken);try{const path=`/api/clients/${f.a}/campaigns/${x.c.id}`,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 assert.equal((await fetch(server.url+path+'/writing-context')).status,401);assert.equal((await fetch(server.url+path.replace(f.a,f.b)+'/writing-context',{headers})).status,404);
 const payload={basisHash:x.setup().basisHash,confirmed:true};assert.equal((await fetch(server.url+path+'/writing-runs/reserve',{method:'POST',headers,body:JSON.stringify(payload)})).status,403);
 const response=await fetch(server.url+path+'/writing-runs/reserve',{method:'POST',headers:{...headers,'X-EiZ-Worker':workerToken},body:JSON.stringify(payload)});assert.equal(response.status,200);const r=await response.json();assert.equal((await fetch(server.url+path+`/writing-runs/${r.id}/finish`,{method:'POST',headers,body:JSON.stringify({status:'completed',text:JSON.stringify({steps:x.steps()}),usage:{}})})).status,403);
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});


test('writing adoption and provenance are atomic if the evidence insert fails',()=>{
 const x=writingFixture(),{f}=x;try{const run=x.reserve();x.finish(run.id);const before=f.s.exportBackup().data;f.s.db.exec("CREATE TEMP TRIGGER fail_writing_evidence BEFORE INSERT ON events WHEN NEW.type='CAMPAIGN_WRITING_ADOPTED' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");assert.throws(()=>x.adopt(run.id));assert.deepEqual(f.s.exportBackup().data,before);f.s.db.exec('DROP TRIGGER fail_writing_evidence');x.adopt(run.id);assert.equal(writingRuns(f.s,f.a,x.c.id)[0].adopted,true);}finally{f.close();}
});

test('writing uses existing OpenAI and Gemini structured adapters without tools, contact data or automatic retries',async()=>{
 const {callModel}=createRequire(import.meta.url)('../electron/models.cjs');const x=writingFixture(),{f}=x;try{const run=x.reserve();for(const provider of ['openai','gemini']){let calls=0;const result=await callModel({...run,provider,key:'synthetic-key'},async(url:string,init:any)=>{calls++;const b=JSON.parse(init.body);assert.equal(b.tools,undefined);assert.doesNotMatch(init.body,/lead@example.com|synthetic-key/);assert.equal(init.redirect,'error');if(provider==='openai'){assert.equal(b.input,run.prompt.user);assert.equal(b.text.format.type,'json_object');return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({steps:x.steps()})}]}]}));}assert.equal(b.generationConfig.responseMimeType,'application/json');assert.equal(b.store,undefined);return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({steps:x.steps()})}]}}]}));});assert.equal(calls,1);assert.equal(JSON.parse(result.text).steps.length,2);}
 x.finish(run.id);validateBackup(f.s.exportBackup());const checkpoint=saveCheckpoint(join(f.dir,'writing-checkpoint'),f.dir);assert.equal(validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8'))).data.aiRuns![0].purpose,'campaign-writing');
 }finally{f.close();}
});

test('schema19 upgrade keeps campaign message identities and approval with complete pre-upgrade backup',()=>{
 const x=writingFixture(),{f}=x;try{f.s.db.exec('PRAGMA user_version=19');f.reopen();assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.s.campaignPreview(f.a,x.c.id).fingerprint,x.p.fingerprint);assert.equal(f.s.campaignPreview(f.a,x.c.id).approved,true);assert.deepEqual(f.s.campaignPreview(f.a,x.c.id).messaging,x.p.messaging);const file=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,b=validateBackup(JSON.parse(readFileSync(join(f.backups,file),'utf8')));assert.equal(b.version,19);assert.deepEqual(JSON.parse(b.data.campaigns![0].content).sequence,styled(f).sequence);}finally{f.close();}
});


test('writing history capacity blocks a new paid reservation before the result list would overflow',()=>{
 const x=writingFixture(),{f}=x;try{const r=x.reserve();x.finish(r.id,'invalid');const row=f.s.exportBackup().data.aiRuns![0];const insert=f.s.db.prepare('INSERT INTO ai_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');f.s.transaction(()=>{for(let i=0;i<199;i++)insert.run(randomUUID(),row.clientId,row.purpose,row.provider,row.model,row.revision,row.clientVersion,row.status,row.context,row.result,row.usage,row.createdAt,row.review);});assert.equal(writingRuns(f.s,f.a,x.c.id).length,200);assert.throws(()=>x.reserve(),/200 Textaufträge/);assert.equal(f.s.exportBackup().data.aiRuns!.length,200);}finally{f.close();}
});

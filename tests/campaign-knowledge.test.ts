import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {saveProduct} from '../core/catalog';
import {knowledgeState,saveKnowledge} from '../core/knowledge';
import {campaignKnowledge} from '../core/campaign-knowledge';
import {validateCampaign,type CampaignContent} from '../core/campaign';
import {prepareQueue,controlQueue,queueState,activateLiveQueue,claimOutbound,authorizeOutbound} from '../core/outbox';
import {rehearseRestore} from '../core/recovery';
const product={name:'Synthetic',description:'CSV export',website:'',bookingUrl:'',archived:false};
const source={title:'Synthetic source',locator:'Test document',capturedAt:'2026-09-01T12:00:00.000Z',text:'The product exports CSV.',withdrawn:false};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-campaign-knowledge-')),file=join(dir,'db'),backups=join(dir,'backups');let s=new Store(file,backups,false);
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
 return {get s(){return s;},a:client.id,b:foreign.id,dir,backups,form,ref,src,draft,claim,write,review,approved,reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};

test('knowledge selections require a product, strict UUIDs, uniqueness and a bounded nonempty list',()=>{
 const f=fixture();try{
  for(const ids of [[],null,[f.claim.id,f.claim.id],['bad'],Array.from({length:21},()=>randomUUID())])assert.throws(()=>validateCampaign({...f.form,knowledgeIds:ids}));
  assert.throws(()=>validateCampaign({...f.form,productRef:undefined,knowledgeIds:[f.claim.id]}));
  assert.deepEqual(validateCampaign(f.form),f.form);
 }finally{f.close();}
});
test('drafts, sources, unknown or foreign facts and strategic hypotheses cannot be bound',()=>{
 const f=fixture();try{
  const hypothesis=f.write('claim',{category:'hypothesis',text:'IT may be a fit.',sourceId:f.src.id,quote:source.text});const hyp=f.review('approve',hypothesis.entityId);
  const before=f.s.exportBackup().data;
  for(const id of [f.draft.id,f.src.id,randomUUID(),hyp.id])assert.throws(()=>f.s.saveCampaign(f.a,{content:{...f.form,knowledgeIds:[id]}}));
  const q=saveProduct(f.s,f.a,null,product,0);assert.throws(()=>f.s.saveCampaign(f.a,{content:{...f.form,productRef:{productId:q.productId,revision:1},knowledgeIds:[f.claim.id]}}));
  assert.throws(()=>f.s.saveCampaign(f.b,{content:{...f.form,knowledgeIds:[f.claim.id]}}));
  assert.equal(f.s.campaigns(f.a).length,0);assert.equal(f.s.exportBackup().data.campaignHistory!.length,before.campaignHistory!.length);
 }finally{f.close();}
});
test('unselected facts leave bound approval stable, while legacy fingerprints remain unchanged',()=>{
 const f=fixture();try{
  const bound=f.approved(),legacy=f.approved(false);const d=f.write('claim',{category:'benefit',text:'Other statement',sourceId:f.src.id,quote:source.text});f.review('approve',d.entityId);
  assert.equal(f.s.campaignPreview(f.a,bound.c.id).fingerprint,bound.preview.fingerprint);
  f.review('withdraw');assert.equal(f.s.campaignPreview(f.a,legacy.c.id).fingerprint,legacy.preview.fingerprint);assert.equal(f.s.campaignPreview(f.a,legacy.c.id).approved,true);
 }finally{f.close();}
});
test('withdrawal invalidates approval and prepared runs without rewriting historical knowledge',()=>{
 const f=fixture();try{
  const {c,preview}=f.approved(),run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  f.review('withdraw');const p=f.s.campaignPreview(f.a,c.id);assert.equal(p.approved,false);assert.notEqual(p.fingerprint,preview.fingerprint);assert.match(p.problems.join(' '),/Aussage/);
  assert.throws(()=>f.s.approveCampaign(f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint}));
  assert.throws(()=>controlQueue(f.s,f.a,run.id,{confirmed:true,action:'start',revision:run.revision}),/geändert/);
  assert.throws(()=>prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint}));
  assert.deepEqual(queueState(f.s,f.a)[0].snapshot.content.knowledgeIds,[f.claim.id]);assert.equal(p.knowledge[0].text,'CSV export is available.');assert.equal(p.knowledge[0].quote,source.text);
  assert.ok(f.s.campaignHistory(f.a,c.id).some(r=>JSON.parse(r.content).knowledgeIds.includes(f.claim.id)));
 }finally{f.close();}
});
test('source edits, source withdrawal, claim edits, product edits and archives block bound campaigns',()=>{
 for(const mode of ['source','withdrawSource','claim','product','archive']){const f=fixture();try{
  const {c,preview}=f.approved();
  if(mode==='source'||mode==='withdrawSource')f.write('source',{...source,title:'Changed',withdrawn:mode==='withdrawSource'},f.src.entityId);
  if(mode==='claim')f.write('claim',{category:'feature',text:'Changed claim',sourceId:f.src.id,quote:source.text},f.draft.entityId);
  if(mode==='product'||mode==='archive')saveProduct(f.s,f.a,f.ref.productId,{...product,name:'Changed',archived:mode==='archive'},1);
  const p=f.s.campaignPreview(f.a,c.id);assert.equal(p.approved,false,mode);assert.notEqual(p.fingerprint,preview.fingerprint,mode);assert.ok(p.problemCount>0,mode);
  assert.throws(()=>f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content:{...f.form,knowledgeIds:[f.claim.id]}}));
 }finally{f.close();}}
});
test('withdrawal after live reservation blocks the final handoff to the provider',()=>{
 const f=fixture();try{
  const {c,preview}=f.approved();let run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  const mailboxId=randomUUID(),sender='sender@example.com',mail=f.s.reserveMailTest(f.a,{id:randomUUID(),mailboxId,clientVersion:1,sender,recipient:'owner@example.com',subject:'Test',body:'Test'});f.s.finishMailTest(f.a,mail.id,'sent','synthetic','OK');
  f.s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+f.a,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:mail.id,mailboxId,clientVersion:1,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
  run=activateLiveQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN',mailboxId,sender})[0];run=controlQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,action:'start'})[0];
  const at=new Date('2026-10-05T12:00:00Z'),q=claimOutbound(f.s,f.a,run.id,{mailboxId,sender},at)!;assert.ok(q);
  f.review('withdraw');assert.throws(()=>authorizeOutbound(f.s,f.a,run.id,q.id,{revision:q.runRevision,mailboxId,sender},at),/geändert/);
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='QUEUE_SEND_AUTHORIZED'").get()!.n,0);
 }finally{f.close();}
});
test('backup and restore preserve historical bindings and reject missing, mismatched or downgraded knowledge',()=>{
 const f=fixture();try{
  const before=f.s.exportBackup(),{c,preview}=f.approved();prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint});f.review('withdraw');
  const original=f.s.exportBackup();assert.equal(rehearseRestore(original).restartVerified,true);
  for(const where of ['campaigns','campaignHistory','queueRuns'] as const){const b=structuredClone(original),row=b.data[where]![0] as any,key=where==='queueRuns'?'snapshot':'content',content=JSON.parse(row[key]);(where==='queueRuns'?content.content:content).knowledgeIds=[randomUUID()];row[key]=JSON.stringify(content);assert.throws(()=>validateBackup(resign(b)),/Wissensbezug/);}
  const b=structuredClone(original);b.version=13;assert.throws(()=>validateBackup(b),/Wissensbezug/);
  const stripped=structuredClone(original),snap=JSON.parse(stripped.data.queueRuns![0].snapshot);delete snap.content.knowledgeIds;stripped.data.queueRuns![0].snapshot=JSON.stringify(snap);assert.throws(()=>validateBackup(resign(stripped)),/Wissensbezug/);
  assert.throws(()=>f.s.restore(before),/Produktzuordnung/);
  f.s.restore(original);assert.deepEqual(JSON.parse(f.s.campaign(f.a,c.id).content).knowledgeIds,[f.claim.id]);assert.equal(f.s.campaignPreview(f.a,c.id).approved,false);
 }finally{f.close();}
});
test('schema13 upgrade saves knowledge and preserves legacy campaign approval',()=>{
 const f=fixture();try{
  const {c,preview}=f.approved(false),before=f.s.exportBackup().data.knowledge;f.s.db.exec('DROP TABLE experiment_versions; DROP TABLE strategy_versions; PRAGMA user_version=13');f.reopen();
  assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.s.campaignPreview(f.a,c.id).fingerprint,preview.fingerprint);assert.equal(f.s.campaignPreview(f.a,c.id).approved,true);
  const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,backup=validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8')));assert.equal(backup.version,13);assert.deepEqual(backup.data.knowledge,JSON.parse(JSON.stringify(before)));
 }finally{f.close();}
});

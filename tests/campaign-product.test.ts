import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {saveProduct} from '../core/catalog';
import {validateCampaign,type CampaignContent} from '../core/campaign';
import {prepareQueue,queueState,controlQueue} from '../core/outbox';
import {rehearseRestore} from '../core/recovery';

const product={name:'Originalprodukt',description:'Ursprüngliches Angebot',website:'',bookingUrl:'',archived:false};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-product-campaign-')),file=join(dir,'db.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
 const a=s.createClient({name:'A',website:'',email:'',notes:''}),b=s.createClient({name:'B',website:'',email:'',notes:''});
 let brief=s.addSource(a.id,{kind:'manual',url:'',title:'Quelle',text:'Ein synthetisches Angebot.'},0);brief=s.reviewSource(a.id,brief.content.sources[0].id,brief.revision,true);
 Object.assign(brief.content.rules,{offer:'Angebot',targets:'Firmen',personas:'IT',claims:'Software'});brief.content.routes.analysis.model='test';brief.content.routes.writing.model='test';
 brief=s.saveRules(a.id,{...brief.content,revision:brief.revision});s.approveBrief(a.id,brief.revision,a.version);
 const csv={csv:'email;company\nlead@example.com;Firma',delimiter:';',filename:'test.csv',mapping:{email:0,company:1,firstName:-1,lastName:-1,role:-1}};s.importLeads(a.id,{...csv,fingerprint:s.previewLeads(a.id,csv).fingerprint});
 const form:CampaignContent={name:'Pilot',leadIds:[s.leads(a.id).rows[0].id],dailyLimit:1,startDate:'2099-01-01',startHour:9,endHour:17,weekdays:[1,2,3,4,5],timezone:'UTC',steps:[{subject:'Hallo',body:'Synthetischer Test',gapDays:0}]};
 const p=saveProduct(s,a.id,null,product,0),ref={productId:p.productId,revision:p.revision};
 return {get s(){return s;},a:a.id,b:b.id,form,ref,dir,backups,reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
function approved(f:ReturnType<typeof fixture>,content:CampaignContent){const c=f.s.saveCampaign(f.a,{content}),preview=f.s.campaignPreview(f.a,c.id);f.s.approveCampaign(f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint});return {c,preview};}
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};

test('optional product references preserve legacy content and reject malformed shapes',()=>{
 const f=fixture();try{
  assert.deepEqual(validateCampaign(f.form),f.form);
  for(const ref of [null,{},[],{productId:randomUUID(),revision:0},{productId:randomUUID(),revision:'1'},{...f.ref,clientId:f.b}])assert.throws(()=>validateCampaign({...f.form,productRef:ref}));
  const input=Object.freeze({...f.form,productRef:Object.freeze({...f.ref})});assert.deepEqual(validateCampaign(input).productRef,f.ref);
 }finally{f.close();}
});

test('campaign product selection validates tenant, version and archive status without writes on error',()=>{
 const f=fixture();try{
  const foreign=saveProduct(f.s,f.b,null,product,0),before=f.s.exportBackup().data;
  for(const ref of [{productId:foreign.productId,revision:1},{productId:randomUUID(),revision:1},{...f.ref,revision:22}])assert.throws(()=>f.s.saveCampaign(f.a,{content:{...f.form,productRef:ref}}));
  assert.deepEqual(f.s.exportBackup().data,before);
  const c=f.s.saveCampaign(f.a,{content:{...f.form,productRef:f.ref}});
  saveProduct(f.s,f.a,f.ref.productId,{...product,archived:true},1);
  assert.throws(()=>f.s.saveCampaign(f.a,{content:{...f.form,productRef:f.ref}}),/Archivierte/);
  assert.doesNotThrow(()=>f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content:{...f.form,name:'Bestand',productRef:f.ref}}));
 }finally{f.close();}
});

test('product edits never silently change approved campaign or frozen queue context',()=>{
 const f=fixture();try{
  const {c,preview}=approved(f,{...f.form,productRef:f.ref});
  const run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  saveProduct(f.s,f.a,f.ref.productId,{...product,name:'Neuer Produktname',description:'Neues Angebot'},1);
  const p=f.s.campaignPreview(f.a,c.id);assert.equal(p.product?.name,'Originalprodukt');assert.equal(p.product?.revision,1);assert.equal(p.approved,true);assert.equal(p.fingerprint,preview.fingerprint);
  assert.equal(f.s.campaignHistory(f.a,c.id)[0].product?.name,'Originalprodukt');
  assert.deepEqual(run.snapshot.content.productRef,f.ref);f.reopen();assert.deepEqual(queueState(f.s,f.a)[0].snapshot.content.productRef,f.ref);
  assert.equal(f.s.mailTests(f.a).length,0);
 }finally{f.close();}
});

test('explicit product switch revokes approval while retaining the old queue binding and history',()=>{
 const f=fixture();try{
  const {c,preview}=approved(f,{...f.form,productRef:f.ref});const run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint})[0];
  saveProduct(f.s,f.a,f.ref.productId,{...product,description:'Version2'},1);
  f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content:{...f.form,productRef:{...f.ref,revision:2}}});
  const p=f.s.campaignPreview(f.a,c.id);assert.equal(p.approved,false);assert.notEqual(p.fingerprint,preview.fingerprint);
  assert.throws(()=>f.s.approveCampaign(f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint}),/geändert/);
  assert.throws(()=>controlQueue(f.s,f.a,run.id,{revision:run.revision,action:'start',confirmed:true}));
  assert.deepEqual(queueState(f.s,f.a)[0].snapshot.content.productRef,f.ref);
  assert.ok(f.s.campaignHistory(f.a,c.id).some(h=>JSON.parse(String(h.content)).productRef.revision===1));
 }finally{f.close();}
});

test('previously unassigned queue never receives a retrospective product attribution',()=>{
 const f=fixture();try{
  const {c,preview}=approved(f,f.form);prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint});
  f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content:{...f.form,productRef:f.ref}});
  assert.equal(queueState(f.s,f.a)[0].snapshot.content.productRef,undefined);
 }finally{f.close();}
});

test('backup validates references in all three locations and preserves them through restore',()=>{
 const f=fixture();try{
  const {c,preview}=approved(f,{...f.form,productRef:f.ref});prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:preview.fingerprint});
  saveProduct(f.s,f.a,f.ref.productId,{...product,name:'Zweite Version'},1);
  const original=f.s.exportBackup();assert.equal(original.version,34);assert.equal(rehearseRestore(original).restartVerified,true);
  for(const target of ['campaigns','campaignHistory','queueRuns'] as const){
   const b=structuredClone(original);const row=b.data[target]![0] as any;
   const key=target==='queueRuns'?'snapshot':'content',value=JSON.parse(row[key]);
   (target==='queueRuns'?value.content:value).productRef={productId:randomUUID(),revision:1};row[key]=JSON.stringify(value);
   assert.throws(()=>validateBackup(resign(b)),/Produkt/);
  }
  const mismatched=structuredClone(original),snapshot=JSON.parse(mismatched.data.queueRuns![0].snapshot);snapshot.content.productRef.revision=2;mismatched.data.queueRuns![0].snapshot=JSON.stringify(snapshot);
  assert.throws(()=>validateBackup(resign(mismatched)),/freigegebenen/);
  const wrongVersion=structuredClone(original);wrongVersion.version=9;assert.throws(()=>validateBackup(resign(wrongVersion)),/Produkt/);
  f.s.restore(original);assert.deepEqual(queueState(f.s,f.a)[0].snapshot.content.productRef,f.ref);assert.equal(f.s.campaign(f.a,c.id).approvedHash,null);
 }finally{f.close();}
});

test('restore cannot remove or alter an already recorded product binding',()=>{
 const f=fixture();try{
  const before=f.s.exportBackup();approved(f,{...f.form,productRef:f.ref});const after=f.s.exportBackup();
  assert.throws(()=>f.s.restore(before),/Produktzuordnung/);
  const corrupt=structuredClone(after);corrupt.data.campaignHistory!.splice(0,1);resign(corrupt);assert.throws(()=>f.s.restore(corrupt),/Produktzuordnung/);
  assert.deepEqual(f.s.exportBackup().data,after.data);
 }finally{f.close();}
});

test('upgrade9 saves the catalog and preserves unassigned campaign fingerprints and approval',()=>{
 const f=fixture();try{
  const {c,preview}=approved(f,f.form);f.s.db.exec('DROP TRIGGER evidence_mail_insert; DROP TRIGGER evidence_mail_update; DROP TRIGGER evidence_incoming_insert; DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; DROP TABLE interpretations; DROP TABLE evidence_events; PRAGMA user_version=9');f.reopen();
  assert.equal(f.s.snapshot().database.schema,34);const p=f.s.campaignPreview(f.a,c.id);assert.equal(p.fingerprint,preview.fingerprint);assert.equal(p.approved,true);assert.equal(p.product,null);
  const previous=validateBackup(JSON.parse(readFileSync(join(f.backups,readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!),'utf8')));
  assert.equal(previous.version,9);assert.equal(previous.data.productRevisions?.length,1);assert.equal(previous.data.campaigns?.length,1);
 }finally{f.close();}
});

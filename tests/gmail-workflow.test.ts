import {saveContactPermission} from '../core/contact-permission';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {saveSenderProfile,mailPresentation} from '../core/mail-presentation';
import {prepareQueue,controlQueue,queueState,activateLiveQueue,claimOutbound,authorizeOutbound,finishOutbound,dueOutbound} from '../core/outbox';
import {recordConversation} from '../core/inbox';
import {previewContactDeletion,applyContactDeletion} from '../core/data-retention';
function fixture(count=1){
 const dir=mkdtempSync(join(tmpdir(),'public-gmail-'));const s=new Store(join(dir,'db'),join(dir,'backups'),false);s.publicMode=true;
 const c=s.createClient({name:'Synthetic',website:'',email:'',notes:''}),mailboxId=randomUUID(),sender='owner@example.com';
 saveSenderProfile(s,{clientId:c.id,connectionId:mailboxId,revision:1,displayName:'Example Owner',signatureText:'Example Owner\nExample Company'}, {providerKind:'gmail',connectionId:mailboxId,email:sender,checkedAt:new Date().toISOString()});
 let b=s.addSource(c.id,{kind:'manual',url:'',title:'Synthetic',text:'Example product'},0);b=s.reviewSource(c.id,b.content.sources[0].id,b.revision,true);
 Object.assign(b.content.rules,{offer:'Software',targets:'Companies',personas:'Buyer',claims:'Example product'});
 b=s.saveRules(c.id,{...b.content,revision:b.revision});s.approveBrief(c.id,b.revision,c.version);
 const csv={csv:'email;company\none@example.com;One\ntwo@example.org;Two',delimiter:';',filename:'test.csv',mapping:{email:0,company:1,firstName:-1,lastName:-1,role:-1}};
 s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});
 for(const lead of s.campaignLeads(c.id))saveContactPermission(s,c.id,lead.id,{source:'Synthetic fixture',reason:'Explicit simulated test',status:'reviewed',expectedRevision:0});
 const t={id:randomUUID(),mailboxId,clientVersion:c.version,sender,recipient:'self@example.com',subject:'Synthetic',body:'Own test'};
 const test=s.reserveMailTest(c.id,{...t,presentationHash:mailPresentation(s,c.id,{to:t.recipient,subject:t.subject,bodyText:t.body})!.hash});
 s.finishMailTest(c.id,test.id,'sent','synthetic-test','accepted');
 s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+c.id,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:test.id,mailboxId,clientVersion:c.version,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
 const campaign=s.saveCampaign(c.id,{content:{name:'Example',leadIds:s.campaignLeads(c.id).slice(0,count).map(l=>l.id),dailyLimit:10,startDate:'2026-10-05',startHour:9,endHour:17,weekdays:[1,2,3,4,5],timezone:'UTC',steps:[{subject:'Hello',body:'Example message',gapDays:0},{subject:'Follow-up',body:'Additional example',gapDays:3}]}});
 const preview=s.campaignPreview(c.id,campaign.id);s.approveCampaign(c.id,campaign.id,{fingerprint:preview.fingerprint,confirmed:true});
 const run=prepareQueue(s,c.id,campaign.id,{fingerprint:preview.fingerprint,confirmed:true})[0];
 activateLiveQueue(s,c.id,run.id,{revision:run.revision,mailboxId,sender,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});
 const r=queueState(s,c.id)[0];controlQueue(s,c.id,r.id,{revision:r.revision,action:'start',confirmed:true});
 return {s,c,run,mailboxId,sender,close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('public Gmail exact signature survives reservation; reply before dispatch stops without any model',()=>{
 const f=fixture();try{
  const at=new Date('2026-10-05T09:00Z'),claim=claimOutbound(f.s,f.c.id,f.run.id,f,at)!;
  assert.ok(claim.presentation?.text.endsWith('Example Owner\nExample Company'));
  // Accepted initial mail, then reserve a different contact. A reply races its final check.
  finishOutbound(f.s,f.c.id,f.run.id,claim.id,{status:'sent',providerId:'synthetic-one',result:'accepted'},at);
  assert.throws(()=>claimOutbound(f.s,f.c.id,f.run.id,f,at),/Rückläuferprüfung/);
  const proof=JSON.parse(String(f.s.db.prepare('SELECT value FROM meta WHERE key=?').get('delivery-progress:'+f.c.id)!.value));
  proof.mailSet=f.s.mailTests(f.c.id).filter(m=>m.status==='sent').map(m=>m.id).sort().join(',');
  f.s.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(proof),'delivery-progress:'+f.c.id);
  at.setUTCDate(8);const second=claimOutbound(f.s,f.c.id,f.run.id,f,at)!;
  recordConversation(f.s,f.c.id,claim.id,{clientVersion:f.c.version,mailboxId:f.mailboxId,rows:[{providerId:'synthetic-reply',threadId:'thread',sender:second.recipient,subject:'Reply',excerpt:'Please stop',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}]});
  let providerCalls=0;
  assert.throws(()=>{authorizeOutbound(f.s,f.c.id,f.run.id,second.id,{mailboxId:f.mailboxId,sender:f.sender,revision:second.runRevision},at);providerCalls++;});
  assert.equal(providerCalls,0);assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM ai_runs').get()!.n,0);
  assert.ok(queueState(f.s,f.c.id)[0].items.filter(i=>i.recipient===second.recipient&&Number(i.step)>0).every(i=>i.status!=='sent'));
 }finally{f.close();}
});
test('two-contact campaign stops the respondent and follows up only the unanswered contact',()=>{
 const f=fixture(2);
 try{
  const at=new Date('2026-10-05T09:00Z'),sent:any[]=[];
  const fresh=()=>{
   const key='delivery-progress:'+f.c.id;
   const proof=JSON.parse(String(f.s.db.prepare('SELECT value FROM meta WHERE key=?').get(key)!.value));
   proof.mailSet=f.s.mailTests(f.c.id).filter(m=>m.status==='sent').map(m=>m.id).sort().join(',');
   f.s.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(proof),key);
  };
  for(let i=0;i<2;i++){
   fresh();const mail=claimOutbound(f.s,f.c.id,f.run.id,f,at)!;assert.ok(mail);
   authorizeOutbound(f.s,f.c.id,f.run.id,mail.id,{mailboxId:f.mailboxId,sender:f.sender,revision:mail.runRevision},at);
   finishOutbound(f.s,f.c.id,f.run.id,mail.id,{status:'sent',providerId:'synthetic-'+i,result:'accepted'},at);sent.push(mail);
   at.setUTCMinutes(at.getUTCMinutes()+20);
  }
  recordConversation(f.s,f.c.id,sent[0].id,{clientVersion:f.c.version,mailboxId:f.mailboxId,rows:[{providerId:'reply',threadId:'thread',sender:sent[0].recipient,subject:'Re',excerpt:'Please contact me next month',receivedAt:at.toISOString(),kind:'reply',evidence:'{}'}]});
  fresh();at.setUTCDate(8);
  // A scheduler tick may first place the respondent's next item on hold.
  let follow=claimOutbound(f.s,f.c.id,f.run.id,f,at);
  if(!follow)follow=claimOutbound(f.s,f.c.id,f.run.id,f,at);
  assert.ok(follow);
  assert.equal(follow.recipient,sent[1].recipient);
  assert.ok(follow.presentation?.text.endsWith('Example Owner\nExample Company'));
  assert.notEqual(follow.recipient,sent[0].recipient);
 }finally{f.close();}
});
test('public uncertain Gmail handoff stays unknown on restore without another provider call',()=>{
 const f=fixture();try{
  const claim=claimOutbound(f.s,f.c.id,f.run.id,f,new Date('2026-10-05T09:00Z'))!;
  finishOutbound(f.s,f.c.id,f.run.id,claim.id,{status:'unknown',providerId:'',result:'lost response'});
  const backup=f.s.exportBackup();validateBackup(backup);f.s.restore(backup);
  assert.equal(dueOutbound(f.s).length,0);assert.equal(f.s.mailTests(f.c.id).find(m=>m.id===claim.id)!.status,'unknown');
 }finally{f.close();}
});
test('customer privacy purge includes prepared queue children and all personal snapshots',()=>{
 const f=fixture(2);
 try{
  const lead=f.s.campaignLeads(f.c.id)[0],preview=previewContactDeletion(f.s,f.c.id,lead.id,'customer');
  assert.equal(preview.counts.queueItems,4);
  assert.equal(applyContactDeletion(f.s,preview.hash).deleted,true);
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM queue_items').get()!.n,0);
  const backup=f.s.exportBackup();validateBackup(backup);
  assert.ok(!JSON.stringify(backup).includes('one@example.com'));
  assert.deepEqual(f.s.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{f.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {previewContactDeletion,applyContactDeletion,isDeletedAddress} from '../core/data-retention';

test('unrelated test mail does not prevent deletion of an unused contact',()=>{
 const dir=mkdtempSync(join(tmpdir(),'retention-')),s=new Store(join(dir,'db'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'Synthetic',email:'',website:'',notes:''}),csv={csv:'email\nunused@example.com\nmailed@example.com',delimiter:';',filename:'synthetic.csv',mapping:{email:0,firstName:-1,lastName:-1,company:-1,role:-1}};
  s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});
  const mail=s.reserveMailTest(c.id,{id:randomUUID(),mailboxId:randomUUID(),clientVersion:c.version,sender:'owner@example.com',recipient:'mailed@example.com',subject:'Synthetic',body:'Test'});
  s.finishMailTest(c.id,mail.id,'sent','synthetic','accepted');
  const leads=s.campaignLeads(c.id),unused=leads.find(l=>l.email==='unused@example.com')!,mailed=leads.find(l=>l.email==='mailed@example.com')!;
  const preview=previewContactDeletion(s,c.id,unused.id);assert.equal(preview.requiresCustomerDeletion,false);applyContactDeletion(s,preview.hash);
  assert.equal(previewContactDeletion(s,c.id,mailed.id).requiresCustomerDeletion,true);
  assert.ok(s.db.prepare('SELECT id FROM mail_tests WHERE id=?').get(mail.id));
  assert.equal(isDeletedAddress(s,'unused@example.com'),true);validateBackup(s.exportBackup());
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('deleted unused contact stays suppressed after reimport and old restore',()=>{
 const dir=mkdtempSync(join(tmpdir(),'retention-')),s=new Store(join(dir,'db'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'Synthetic',email:'',website:'',notes:''}),csv={csv:'email;first\nperson@example.com;Private',delimiter:';',filename:'synthetic.csv',mapping:{email:0,firstName:1,lastName:-1,company:-1,role:-1}};
  s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});
  const backup=s.exportBackup(),lead=s.campaignLeads(c.id)[0],preview=previewContactDeletion(s,c.id,lead.id);
  applyContactDeletion(s,preview.hash);
  assert.equal(isDeletedAddress(s,'person@example.com'),true);
  assert.equal(s.previewLeads(c.id,csv).blocked,1);
  assert.throws(()=>s.restore(backup),/gelöscht|Lösch/i);
  const after=s.exportBackup();assert.ok(!JSON.stringify(after).includes('person@example.com'));assert.ok(!JSON.stringify(after).includes('Private'));validateBackup(after);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('deletion preview expires on changes; linked history demands explicit broader scope',()=>{
 const dir=mkdtempSync(join(tmpdir(),'retention-')),s=new Store(join(dir,'db'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'Synthetic',email:'',website:'',notes:''}),csv={csv:'email\nperson@example.com',delimiter:';',filename:'synthetic.csv',mapping:{email:0,firstName:-1,lastName:-1,company:-1,role:-1}};
  s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});const id=s.campaignLeads(c.id)[0].id;
  const p=previewContactDeletion(s,c.id,id);s.blockLead(c.id,id,true,'explicit private note');
  assert.throws(()=>applyContactDeletion(s,p.hash),/geändert/);
  const linked=previewContactDeletion(s,c.id,id);assert.equal(linked.requiresCustomerDeletion,true);assert.throws(()=>applyContactDeletion(s,linked.hash),/Kundenbestand/);
  const broad=previewContactDeletion(s,c.id,id,'customer');applyContactDeletion(s,broad.hash);
  const backup=s.exportBackup();validateBackup(backup);assert.ok(!JSON.stringify(backup).includes('explicit private note'));assert.equal(s.client(c.id).status,'paused');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

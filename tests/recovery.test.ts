import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Store } from '../core/store';
import { rehearseRestore } from '../core/recovery';
import {saveContactPermission} from '../core/contact-permission';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
test('Sicherungsprobe erhält Wissen, Kontakte und Kampagnen ohne den aktiven Bestand zu ändern',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-recovery-test-'));const s=new Store(join(dir,'revenue.sqlite'),join(dir,'backups'),false);
 try {
  const c=s.createClient({name:'Prüfkunde',website:'',email:'',notes:'Bleibt erhalten'});
  s.addSource(c.id,{kind:'manual',url:'',title:'Produkt',text:'Geprüftes Kundenwissen'},0);
  const csv={csv:'email;company\na@example.com;Firma',filename:'leads.csv',delimiter:';',mapping:{email:0,company:1,firstName:-1,lastName:-1,role:-1}};
  s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});
  saveContactPermission(s,c.id,s.leads(c.id).rows[0].id,{source:'Synthetic source',reason:'Own test recipient',status:'reviewed',expectedRevision:0});
  s.saveCampaign(c.id,{content:{name:'Pilot',leadIds:[s.leads(c.id).rows[0].id],dailyLimit:10,startDate:'2026-10-01',startHour:9,endHour:17,timezone:'Europe/Berlin',weekdays:[1],steps:[{subject:'Hallo',body:'Produktinformation',gapDays:0}]}});
  const before=s.exportBackup();const result=rehearseRestore(before);
  assert.equal(result.restartVerified,true);assert.equal(result.counts.campaigns,1);assert.equal(result.counts.briefs,1);assert.equal(result.counts.leads,1);
  assert.deepEqual(s.exportBackup().data,before.data);
  const checkpoint=saveCheckpoint(join(dir,'checkpoint'),dir);
  assert.equal(checkpoint.secretsIncluded,false);assert.equal(checkpoint.version,34);
  assert.equal(rehearseRestore(JSON.parse(readFileSync(checkpoint.filename,'utf8'))).counts.campaigns,1);
  assert.notEqual(saveCheckpoint(join(dir,'checkpoint'),dir).filename,checkpoint.filename);
 }finally{s.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
test('Probe lehnt Prüfsummenfehler und verwaiste Kundenbezüge ab',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-recovery-bad-'));const s=new Store(join(dir,'revenue.sqlite'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'Test',website:'',email:'',notes:''});s.enqueueDiagnostic(c.id,0);
  const backup=s.exportBackup();backup.data.clients[0].name='Manipuliert';assert.throws(()=>rehearseRestore(backup));
  const invalid=s.exportBackup();invalid.data.clients=[];invalid.checksum=createHash('sha256').update(JSON.stringify(invalid.data)).digest('hex');assert.throws(()=>rehearseRestore(invalid));assert.equal(s.client(c.id).name,'Test');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

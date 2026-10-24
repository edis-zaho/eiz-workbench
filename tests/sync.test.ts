import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
import {claimSync,configureSync,dueSyncs,finishSync,syncState} from '../core/sync';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'eiz-sync-'));const store=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);const client=store.createClient({name:'Sync-Kunde',website:'',email:'',notes:''});return {dir,store,client,close(){store.close();rmSync(dir,{recursive:true,force:true});}};}

test('Synchronisation wird bewusst aktiviert, beansprucht und nach Erfolg geplant',()=>{
 const f=fixture(),mailboxId=randomUUID();
 try{
  assert.equal(syncState(f.store,f.client.id).enabled,false);
  configureSync(f.store,f.client.id,{mailboxId,clientVersion:f.client.version,enabled:true});
  const due=dueSyncs(f.store) as any[];assert.equal(due.length,1);assert.equal(due[0].clientId,f.client.id);assert.equal(due[0].mailboxId,mailboxId);
  const mail=f.store.reserveMailTest(f.client.id,{id:randomUUID(),clientVersion:f.client.version,mailboxId,sender:'from@example.com',recipient:'to@example.com',subject:'Test',body:'Text'});
  f.store.finishMailTest(f.client.id,mail.id,'sent','provider-1','OK');
  const claim=claimSync(f.store,f.client.id,{mailboxId});assert.equal(claim.messages.length,1);assert.equal(claim.messages[0].id,mail.id);
  assert.equal(dueSyncs(f.store).length,0);assert.throws(()=>claimSync(f.store,f.client.id,{mailboxId,force:true}),/läuft bereits/);
  const done=finishSync(f.store,f.client.id,{mailboxId,leaseId:claim.leaseId,success:true,checked:1,added:1});assert.equal(done.status,'idle');assert.ok(done.lastSuccessAt);assert.equal(done.consecutiveFailures,0);assert.equal(done.stale,false);
  assert.equal(dueSyncs(f.store).length,0);assert.throws(()=>claimSync(f.store,f.client.id,{mailboxId}),/noch nicht fällig/);
 }finally{f.close();}
});

test('Fehler erhalten Diagnose, warten kontrolliert und Sicherungen starten deaktiviert',()=>{
 const f=fixture(),mailboxId=randomUUID();
 try{
  configureSync(f.store,f.client.id,{mailboxId,clientVersion:f.client.version,enabled:true});
  const claim=claimSync(f.store,f.client.id,{mailboxId,force:true});
  const failed=finishSync(f.store,f.client.id,{mailboxId,leaseId:claim.leaseId,success:false,error:'Google vorübergehend nicht erreichbar'});assert.equal(failed.status,'failed');assert.equal(failed.consecutiveFailures,1);assert.match(failed.lastError,/Google/);assert.ok(failed.nextAttemptAt&&Date.parse(failed.nextAttemptAt)>Date.now());
  assert.equal(dueSyncs(f.store).length,0);assert.throws(()=>claimSync(f.store,f.client.id,{mailboxId}),/noch nicht fällig/);
  const retry=claimSync(f.store,f.client.id,{mailboxId,force:true});finishSync(f.store,f.client.id,{mailboxId,leaseId:retry.leaseId,success:false,error:'Erneut fehlgeschlagen'});
  assert.equal(syncState(f.store,f.client.id).consecutiveFailures,2);
  const backup=f.store.exportBackup();assert.equal(backup.version,34);assert.equal(backup.data.mailSync?.[0].enabled,1);
  f.store.restore(backup);const restored=syncState(f.store,f.client.id);assert.equal(restored.enabled,false);assert.equal(restored.status,'idle');assert.match(restored.lastError,/Wiederherstellung deaktiviert/);
 }finally{f.close();}
});

test('Pause, falsches Postfach und veralteter Kundenstand blockieren Läufe',()=>{
 const f=fixture(),mailboxId=randomUUID();
 try{
  assert.throws(()=>configureSync(f.store,f.client.id,{mailboxId,clientVersion:99,enabled:true}),/Kundenstand geändert/);
  configureSync(f.store,f.client.id,{mailboxId,clientVersion:f.client.version,enabled:true});
  assert.throws(()=>claimSync(f.store,f.client.id,{mailboxId:randomUUID(),force:true}),/nicht aktiviert/);
  f.store.pauseClient(f.client.id,true,f.client.version);assert.equal(dueSyncs(f.store).length,0);assert.throws(()=>claimSync(f.store,f.client.id,{mailboxId,force:true}),/pausiert/);
 }finally{f.close();}
});

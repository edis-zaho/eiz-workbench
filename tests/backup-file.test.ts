import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,appendFileSync,openSync,ftruncateSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../core/store';
import {startServer} from '../core/server';
import {readBackupFile} from '../core/backup-file';
import {BACKUP_IMPORT_LIMIT} from '../core/storage';
test('native file import checks and restores a real backup above 50 MiB without changing the normal request limit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-large-backup-')),s=new Store(join(dir,'db'),join(dir,'backups'),false),token='t'.repeat(64),worker='w'.repeat(64),file=join(dir,'large.json');let server:Awaited<ReturnType<typeof startServer>>|undefined;
 try{
  const c=s.createClient({name:'Synthetic large history',website:'',email:'',notes:''});
  s.transaction(()=>{for(let i=0;i<5000;i++)s.event(c.id,null,'CLIENT_UPDATED','Synthetic '+i+' '+ 'x'.repeat(11000));});
  const backup=s.exportBackup();writeFileSync(file,JSON.stringify(backup));const count=backup.data.events.length;
  const selected=await readBackupFile({path:file});assert.ok(selected.bytes>50*1024*1024);assert.ok(selected.bytes<BACKUP_IMPORT_LIMIT);
  server=await startServer(s,token,600000,worker);
  const call=(path:string,data:any,native=true)=>fetch(server!.url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(native?{'X-EiZ-Worker':worker}:{})},body:JSON.stringify(data)});
  assert.equal((await call('/api/backup-file/check',{path:file},false)).status,403);
  const check=await call('/api/backup-file/check',{path:file});assert.equal(check.status,200);const proof=await check.json();assert.equal(proof.report.restartVerified,true);assert.equal(proof.report.counts.events,count+1);assert.equal(s.client(c.id).status,'setup');
  appendFileSync(file,' ');const changed=await call('/api/backup-file/restore',{path:file,fileDigest:proof.fileDigest});assert.equal(changed.status,409);assert.equal(s.client(c.id).status,'setup');
  writeFileSync(file,JSON.stringify(backup));const restored=await call('/api/backup-file/restore',{path:file,fileDigest:proof.fileDigest});assert.equal(restored.status,200);assert.equal(s.client(c.id).status,'paused');assert.ok(s.exportBackup().data.events.length>=count);
  // Legacy JSON routes keep their bounded transport; use a real oversized body.
  const legacy=await call('/api/backup-check',backup);assert.equal(legacy.status,413);
 }finally{if(server)await server.close();else s.close();rmSync(dir,{recursive:true,force:true});}
});
test('file path, size, syntax and checked digest are validated before restore',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-file-limit-')),file=join(dir,'test.json');
 try{
  await assert.rejects(()=>readBackupFile({path:'relative.json'}),/Sicherungsdatei/);
  writeFileSync(file,'broken');await assert.rejects(()=>readBackupFile({path:file}),/JSON/);
  writeFileSync(file,'{}');await assert.rejects(()=>readBackupFile({path:file},true),/Dateistand/);await assert.rejects(()=>readBackupFile({path:file,fileDigest:'a'.repeat(64)},true),/geändert/);
  const fd=openSync(file,'w');ftruncateSync(fd,BACKUP_IMPORT_LIMIT+1);closeSync(fd);await assert.rejects(()=>readBackupFile({path:file}),/256 MiB/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

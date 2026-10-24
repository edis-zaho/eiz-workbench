import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store,validateBackup} from '../core/store';
import {recordConversation,incomingState} from '../core/inbox';
import {bindGmailReference,withGmailReference} from '../core/gmail-reference';
import {mailReferences} from '../core/mail-references';
import {rehearseRestore} from '../core/recovery';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-pilot-stress-'));
 let s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);
 const c=s.createClient({name:'Synthetic audit',website:'',email:'',notes:''}),mailboxId=randomUUID();
 function mail(recipient='own@example.net'){
  const m=s.reserveMailTest(c.id,{id:randomUUID(),clientVersion:c.version,mailboxId,sender:'sender@example.com',recipient,subject:'Synthetic audit',body:'Never transported'});
  s.finishMailTest(c.id,m.id,'sent','gmail_'+m.id,'Synthetic receipt');
  return s.mailTests(c.id).find(x=>x.id===m.id)!;
 }
 return {get s(){return s;},c,mailboxId,dir,mail,reopen(){s.close();s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);},close(){s.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}};
}
function reply(m:any,mailboxId:string){return {clientVersion:1,mailboxId,sourceReference:{mailId:m.id,mailboxId,providerId:m.providerId,threadId:'thread_'+m.id,messageId:`<canonical_${m.id}@mail.gmail.com>`},rows:[{providerId:'reply_'+m.id,threadId:'thread_'+m.id,sender:m.recipient,subject:'Synthetic stop',excerpt:'Stop',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}]};}

test('response write failure rolls back alias, inbox, evidence and scan invalidation together',()=>{
 const f=fixture();try{
  const m=f.mail(),input=reply(m,f.mailboxId);
  f.s.db.prepare('INSERT INTO meta VALUES (?,?)').run('delivery-progress:'+f.c.id,'synthetic-marker');
  const before=f.s.exportBackup();
  f.s.db.exec("CREATE TRIGGER synthetic_reply_disk_error BEFORE INSERT ON incoming BEGIN SELECT RAISE(ABORT,'Synthetic disk write failure'); END;");
  assert.throws(()=>recordConversation(f.s,f.c.id,m.id,input),/Synthetic disk write failure/);
  assert.deepEqual(f.s.exportBackup().data,before.data);
  assert.equal(f.s.db.prepare('SELECT value FROM meta WHERE key=?').get('delivery-progress:'+f.c.id)?.value,'synthetic-marker');
  assert.equal(withGmailReference(f.s,m).providerMessageId,undefined);
  f.s.db.exec('DROP TRIGGER synthetic_reply_disk_error');
  assert.equal(recordConversation(f.s,f.c.id,m.id,input).added,1);
  for(let i=0;i<100;i++)assert.equal(recordConversation(f.s,f.c.id,m.id,input).added,0);
  assert.equal(incomingState(f.s,f.c.id).length,1);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE type='INCOMING_HOLD'").get()!.n,1);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE type='GMAIL_MESSAGE_ID_BOUND'").get()!.n,1);
  validateBackup(f.s.exportBackup());
 }finally{f.close();}
});

test('foreign customer, mailbox and invalid reply batch cannot partially bind or record a response',()=>{
 const f=fixture();try{
  const m=f.mail(),other=f.s.createClient({name:'Other',website:'',email:'',notes:''}),input=reply(m,f.mailboxId),before=f.s.exportBackup().data;
  assert.throws(()=>recordConversation(f.s,other.id,m.id,input));
  assert.throws(()=>recordConversation(f.s,f.c.id,m.id,{...input,mailboxId:randomUUID()}));
  assert.throws(()=>recordConversation(f.s,f.c.id,m.id,{...input,rows:[...input.rows,{...input.rows[0],providerId:'second',receivedAt:'invalid'}]}));
  assert.deepEqual(f.s.exportBackup().data,before);
  assert.equal(withGmailReference(f.s,m).providerMessageId,undefined);
  recordConversation(f.s,f.c.id,m.id,input);f.reopen();
  assert.equal(incomingState(f.s,other.id).length,0);
  assert.throws(()=>f.s.reserveMailTest(f.c.id,{id:randomUUID(),clientVersion:1,mailboxId:f.mailboxId,sender:m.sender,recipient:m.recipient,subject:'Forbidden',body:'No send'}),/angehalten/);
 }finally{f.close();}
});

test('abrupt process death preserves committed stop and reference, rolls back unfinished transaction, marks pending send unknown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-pilot-crash-'));let s:Store|undefined;
 try{
  const marker=join(dir,'marker.json'),child=join(dir,'crash.cjs');
  writeFileSync(child,`
const {Store}=require(${JSON.stringify(resolve('core/store.ts'))});
const {recordConversation}=require(${JSON.stringify(resolve('core/inbox.ts'))});
const {randomUUID}=require('node:crypto');const {writeFileSync}=require('node:fs');
const s=new Store(${JSON.stringify(join(dir,'db.sqlite'))},${JSON.stringify(join(dir,'backups'))},false);
const c=s.createClient({name:'Crash audit',website:'',email:'',notes:''}),box=randomUUID();
const reserve=recipient=>s.reserveMailTest(c.id,{id:randomUUID(),clientVersion:1,mailboxId:box,sender:'sender@example.com',recipient,subject:'Synthetic',body:'Never transported'});
const sent=reserve('stopped@example.net');s.finishMailTest(c.id,sent.id,'sent','receipt','Synthetic');
recordConversation(s,c.id,sent.id,{clientVersion:1,mailboxId:box,sourceReference:{mailId:sent.id,mailboxId:box,providerId:'receipt',threadId:'thread',messageId:'<crash@mail.gmail.com>'},rows:[{providerId:'reply',threadId:'thread',sender:sent.recipient,subject:'Stop',excerpt:'Stop',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}]});
const pending=reserve('pending@example.net');
writeFileSync(${JSON.stringify(marker)},JSON.stringify({clientId:c.id,box,sentId:sent.id,pendingId:pending.id}),{flush:true});
s.db.exec('BEGIN IMMEDIATE');s.db.prepare('UPDATE clients SET name=? WHERE id=?').run('Uncommitted damage',c.id);
process.kill(process.pid,'SIGKILL');
`);
  const result=spawnSync(process.execPath,['--import','tsx',child],{cwd:resolve('.'),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.ifError(result.error);assert.notEqual(result.status,0,'child must terminate without Store.close');
  const ids=JSON.parse(readFileSync(marker,'utf8'));
  s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);
  assert.equal(s.client(ids.clientId).name,'Crash audit');
  assert.equal(s.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const mails=s.mailTests(ids.clientId);assert.equal(mails.find(m=>m.id===ids.pendingId)?.status,'unknown');
  const sent=mails.find(m=>m.id===ids.sentId)!;
  assert.equal(withGmailReference(s,sent).providerMessageId,'<crash@mail.gmail.com>');
  assert.equal(incomingState(s,ids.clientId).length,1);
  assert.throws(()=>s!.reserveMailTest(ids.clientId,{id:randomUUID(),clientVersion:1,mailboxId:ids.box,sender:sent.sender,recipient:sent.recipient,subject:'Forbidden',body:'No send'}));
  validateBackup(s.exportBackup());
 }finally{s?.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('ten customers retain 1000 accepted synthetic messages each, canonical references, isolated stops and restorable evidence',t=>{
 const f=fixture();try{
  const start=performance.now(),customers:{id:string;box:string;first:any;last:any}[]=[];
  // Seed provider-confirmed history only. This is a data-volume test, not a live-send load claim.
  f.s.transaction(()=>{
   const insert=f.s.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
   for(let n=0;n<10;n++){
    const id=randomUUID(),at=new Date(Date.now()-86400000).toISOString(),box=randomUUID();
    f.s.db.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?)').run(id,'Synthetic customer '+n,'','','','setup',1,at,at);
    let first:any,last:any;
    for(let i=0;i<1000;i++){
     const mailId=randomUUID(),providerId='synthetic_'+n+'_'+i;
     insert.run(mailId,id,box,'sender'+n+'@example.com','person'+i+'@example.net','Synthetic','Never transported',`<${mailId}@workbench.local>`,'sent',providerId,'Synthetic receipt',at,at);
     const m=f.s.db.prepare('SELECT * FROM mail_tests WHERE id=?').get(mailId)!;
     if(i%10===0||i===999)bindGmailReference(f.s,id,m,{mailId,mailboxId:box,providerId,threadId:'thread_'+mailId,messageId:`<canonical_${mailId}@mail.gmail.com>`});
     if(i===0)first=m;if(i===999)last=m;
    }
    customers.push({id,box,first,last});
   }
  });
  const seedMs=performance.now()-start,readStart=performance.now();
  for(const c of customers){
   const rows=mailReferences(f.s,c.id,c.box);assert.equal(rows.length,1000);
   assert.ok(rows.every(m=>m.clientId===c.id&&!('body'in m)));
   assert.equal(rows.find(m=>m.id===c.first.id)?.providerMessageId,`<canonical_${c.first.id}@mail.gmail.com>`);
   assert.equal(rows.find(m=>m.id===c.last.id)?.providerMessageId,`<canonical_${c.last.id}@mail.gmail.com>`);
   assert.equal(mailReferences(f.s,c.id,customers[(customers.indexOf(c)+1)%10].box).length,0);
   const input=reply(c.first,c.box);assert.equal(recordConversation(f.s,c.id,c.first.id,input).added,1);assert.equal(recordConversation(f.s,c.id,c.first.id,input).added,0);
  }
  const readMs=performance.now()-readStart,backupStart=performance.now(),backup=f.s.exportBackup();
  assert.equal(backup.data.mailTests!.length,10000);assert.equal(backup.data.incoming!.length,10);validateBackup(backup);
  const restored=rehearseRestore(backup);assert.equal(restored.restartVerified,true);
  f.reopen();assert.equal(f.s.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM mail_tests').get()!.n,10000);
  for(const c of customers){assert.equal(incomingState(f.s,c.id).length,1);assert.equal(mailReferences(f.s,c.id,c.box).length,1000);assert.throws(()=>f.s.reserveMailTest(c.id,{id:randomUUID(),clientVersion:1,mailboxId:c.box,sender:c.first.sender,recipient:c.first.recipient,subject:'Forbidden',body:'No send'}),/angehalten/);}
  t.diagnostic(JSON.stringify({customers:10,acceptedSyntheticMessages:10000,canonicalBindings:1010,seedMs:Math.round(seedMs),referenceAndReplyMs:Math.round(readMs),backupRestoreRestartMs:Math.round(performance.now()-backupStart),backupBytes:Buffer.byteLength(JSON.stringify(backup)),liveProviderCalls:0}));
 }finally{f.close();}
});

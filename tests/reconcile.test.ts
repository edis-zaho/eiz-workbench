import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
const {findSent,READ_SCOPE}=createRequire(import.meta.url)('../electron/reconcile.cjs');
const {startOAuth,SEND_SCOPE}=createRequire(import.meta.url)('../electron/google.cjs');
const mailbox={id:randomUUID(),email:'from@example.com',accessToken:'private',scopes:[READ_SCOPE]};
const mail={mailboxId:mailbox.id,sender:mailbox.email,recipient:'to@example.com',messageId:`<${randomUUID()}@workbench.local>`};
const detail={id:'abc123',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:mail.messageId},{name:'From',value:mail.sender},{name:'To',value:mail.recipient}]}};
test('Lesender OAuth-Zugriff muss ausdrücklich angefordert und tatsächlich erteilt sein',async()=>{
 for(const granted of [false,true]){
  const auth=await startOAuth({clientId:'123-test.apps.googleusercontent.com',clientSecret:'test'},async(href:string)=>{const u=new URL(href);assert.ok(u.searchParams.get('scope')!.split(' ').includes(READ_SCOPE));await fetch(u.searchParams.get('redirect_uri')+'/?code=test&state='+u.searchParams.get('state'));},{readAccess:true,fetcher:async(url:string)=>new Response(JSON.stringify(url.endsWith('/token')?{access_token:'a',refresh_token:'r',token_type:'Bearer',expires_in:3600,scope:SEND_SCOPE+(granted?' '+READ_SCOPE:'')}:{sub:'identity',email:'from@example.com',email_verified:true}))});
  if(granted)assert.ok((await auth.result).scopes.includes(READ_SCOPE));else await assert.rejects(auth.result,/nicht erteilt/);
 }
});
test('Gmail-Abgleich liest nur und bestätigt genau passende Metadaten',async()=>{
 const calls:string[]=[];const r=await findSent(mail,mailbox,async(url:string,options:any)=>{calls.push(url);assert.equal(options.method,undefined);if(calls.length===1){const u=new URL(url);assert.equal(u.searchParams.get('q'),`rfc822msgid:${mail.messageId}`);assert.equal(u.searchParams.get('labelIds'),'SENT');return {messages:[{id:'abc123'}]};}return detail;});
 assert.equal(r.outcome,'found');assert.equal(r.providerId,'abc123');assert.equal(calls.length,2);
});
test('Fehlender, mehrfacher oder widersprüchlicher Treffer bleibt unklar',async()=>{
 assert.equal((await findSent(mail,mailbox,async()=>({}))).outcome,'not_found');
 assert.equal((await findSent(mail,mailbox,async()=>({messages:[{id:'a'},{id:'b'}]}))).outcome,'ambiguous');
 for(const invalid of [{...detail,labelIds:['INBOX']},{...detail,payload:{headers:detail.payload.headers.map(h=>h.name==='To'?{...h,value:'other@example.com'}:h)}},{...detail,payload:{headers:[...detail.payload.headers,detail.payload.headers[0]]}}]){
  let calls=0;assert.equal((await findSent(mail,mailbox,async()=>++calls===1?{messages:[{id:'abc123'}]}:invalid)).outcome,'mismatch');
 }
 await assert.rejects(()=>findSent(mail,{...mailbox,scopes:[]},async()=>{throw Error('Must not request');}),/freigeben/);
 await assert.rejects(()=>findSent(mail,{...mailbox,id:randomUUID()},async()=>{}),/anderen/);
});
test('Abgleich bewahrt Kundentrennung, protokolliert Evidenz und erzeugt keine Wiederholung',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-reconcile-'));const s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'A',website:'',email:'',notes:''});const other=s.createClient({name:'B',website:'',email:'',notes:''});
  const run=s.reserveMailTest(c.id,{id:randomUUID(),clientVersion:c.version,mailboxId:mailbox.id,sender:mail.sender,recipient:mail.recipient,subject:'Test',body:'Test'});
  s.finishMailTest(c.id,run.id,'unknown','','Unklar');const proof={mailboxId:run.mailboxId,messageId:run.messageId,clientVersion:c.version,outcome:'not_found',providerId:''};
  assert.throws(()=>s.reconcileMail(other.id,run.id,proof));s.reconcileMail(c.id,run.id,proof);assert.equal(s.mailTests(c.id)[0].status,'unknown');
  assert.throws(()=>s.reconcileMail(c.id,run.id,{...proof,clientVersion:99}));
  s.reconcileMail(c.id,run.id,{...proof,outcome:'found',providerId:'abc123'});assert.equal(s.mailTests(c.id)[0].status,'sent');assert.equal(s.mailTests(c.id).length,1);
  assert.throws(()=>s.reconcileMail(c.id,run.id,{...proof,outcome:'found',providerId:'abc123'}));
  const backup=s.exportBackup();assert.equal(backup.data.events.filter(e=>e.type==='MAIL_RECONCILED').length,2);assert.equal(backup.data.jobs.length,0);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,validateBackup} from '../core/store';
import {recordConversation,incomingState,recordDeliveryScan} from '../core/inbox';
import {mailReferences} from '../core/mail-references';
import {withGmailReference,bindGmailReference} from '../core/gmail-reference';
import {threadContextSetup,saveThreadContext} from '../core/thread-context';
import {startServer} from '../core/server';
const req=createRequire(import.meta.url),{readConversation}=req('../electron/inbox.cjs'),{readThreadContext}=req('../electron/thread-context.cjs'),{matchReply}=req('../electron/reply-match.cjs'),{deliveryReport}=req('../electron/delivery.cjs');
const canonical='<synthetic-google-id@mail.gmail.com>';
const headers=(v:Record<string,string>)=>Object.entries(v).map(([name,value])=>({name,value}));
function fixture(){const dir=mkdtempSync(join(tmpdir(),'eiz-gmail-reference-'));let s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);const c=s.createClient({name:'Synthetic',website:'',email:'',notes:''}),other=s.createClient({name:'Other',website:'',email:'',notes:''}),mailbox={id:randomUUID(),email:'sender@example.com',accessToken:'synthetic',scopes:['https://www.googleapis.com/auth/gmail.readonly']};const empty=s.exportBackup();const reserved=s.reserveMailTest(c.id,{id:randomUUID(),clientVersion:c.version,mailboxId:mailbox.id,sender:mailbox.email,recipient:'own@example.net',subject:'Pilot',body:'Synthetic'});s.finishMailTest(c.id,reserved.id,'sent','gmail1','Synthetic');const mail=s.mailTests(c.id)[0];const at=Date.parse(mail.createdAt)+1000;
 const source={id:mail.providerId,threadId:'thread1',labelIds:['SENT'],internalDate:String(at),payload:{mimeType:'text/plain',headers:headers({'Message-ID':canonical,From:mail.sender,To:mail.recipient,Subject:'Pilot'}),body:{data:Buffer.from('Synthetic').toString('base64url'),size:9}}};
 const reply={id:'reply1',threadId:'thread1',labelIds:['INBOX'],internalDate:String(at+1000),snippet:'Synthetic stop',payload:{mimeType:'text/plain',headers:headers({'Message-ID':'<reply@example.net>','In-Reply-To':canonical,From:mail.recipient,To:mail.sender,Subject:'Re: Pilot'}),body:{data:Buffer.from('Stop').toString('base64url'),size:4}}};
 async function read(m:any=mail,origin:any=source){return readConversation(m,mailbox,async(url:string)=>url.includes('/messages/')?origin:{id:'thread1',messages:[origin,reply]});}
 async function save(){const result=await read(withGmailReference(s,mail));recordConversation(s,c.id,mail.id,{...result,mailboxId:mailbox.id,clientVersion:c.version});return result;}
 return {get s(){return s;},c,other,mailbox,mail,source,reply,empty,read,save,reopen(){s.close();s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);},close(alreadyClosed=false){if(!alreadyClosed)s.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}};}
test('Gmail-rewritten RFC id binds to exact accepted receipt, stops recipient and survives restart/old restore',async()=>{const f=fixture();try{
 f.s.db.prepare('INSERT INTO meta VALUES (?,?)').run('delivery-progress:'+f.c.id,'{}');const result=await f.save();assert.equal(result.rows[0].kind,'reply');assert.equal(result.sourceReference.messageId,canonical);
 assert.equal(f.s.db.prepare('SELECT value FROM meta WHERE key=?').get('delivery-progress:'+f.c.id),undefined);
 await f.save();assert.equal(incomingState(f.s,f.c.id).length,1);assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE type='GMAIL_MESSAGE_ID_BOUND'").get()!.n,1);
 const reserve=()=>f.s.reserveMailTest(f.c.id,{id:randomUUID(),clientVersion:f.s.client(f.c.id).version,mailboxId:f.mailbox.id,sender:f.mail.sender,recipient:f.mail.recipient,subject:'No send',body:'Not sent'});
 assert.throws(reserve,/angehalten/);f.reopen();assert.equal(mailReferences(f.s,f.c.id,f.mailbox.id)[0].providerMessageId,canonical);validateBackup(f.s.exportBackup());
 f.s.restore(f.empty);assert.equal(withGmailReference(f.s,f.mail).providerMessageId,canonical);assert.equal(incomingState(f.s,f.c.id).length,1);validateBackup(f.s.exportBackup());
 f.s.pauseClient(f.c.id,false,f.s.client(f.c.id).version);assert.throws(reserve,/angehalten/);
 }finally{f.close();}});
test('rewriting never accepts foreign receipts, mailbox, participants, old messages, drafts or changed bindings',async()=>{const f=fixture();try{
 for(const patch of [{id:'foreign'},{threadId:''},{labelIds:['SENT','DRAFT']},{internalDate:'1'},{payload:{headers:headers({'Message-ID':canonical,From:'foreign@example.org',To:f.mail.recipient})}},{payload:{headers:[...f.source.payload.headers,{name:'Message-ID',value:canonical}]}}])await assert.rejects(()=>f.read(f.mail,{...f.source,...patch}));
 await assert.rejects(()=>f.read({...f.mail,status:'unknown'}));await assert.rejects(()=>f.read({...f.mail,mailboxId:randomUUID()}));
 await f.save();await assert.rejects(()=>f.read(withGmailReference(f.s,f.mail),{...f.source,payload:{headers:headers({'Message-ID':'<changed@mail.gmail.com>',From:f.mail.sender,To:f.mail.recipient})}}));
 const ref=(await f.read()).sourceReference;assert.throws(()=>bindGmailReference(f.s,f.other.id,f.mail,ref));assert.throws(()=>bindGmailReference(f.s,f.c.id,f.mail,{...ref,messageId:'<changed@mail.gmail.com>'}));
 }finally{f.close();}});
test('independent replies and delivery reports use the bound canonical id but preserve original evidence id',async()=>{const f=fixture();try{await f.save();const refs=mailReferences(f.s,f.c.id,f.mailbox.id),outside={...f.reply,id:'outside1',threadId:'outsideThread'};const match=matchReply(outside,refs,f.mailbox).match;assert.ok(match);assert.equal(JSON.parse(match.row.evidence).linkedMessageId,f.mail.messageId);
 assert.equal(recordDeliveryScan(f.s,f.c.id,{mailboxId:f.mailbox.id,clientVersion:1,extended:true,matches:[match],truncated:false,query:'synthetic',checked:1,unmatched:0,skipped:0}).added,1);
 const part=(mimeType:string,text:string)=>({mimeType,body:{data:Buffer.from(text).toString('base64url')}});const payload={mimeType:'multipart/report',parts:[part('text/rfc822-headers','Message-ID: '+canonical),part('message/delivery-status',`Final-Recipient: rfc822; ${f.mail.recipient}\r\nAction: failed\r\nStatus: 5.1.1`)]};const report=deliveryReport(payload,refs[0]);assert.equal(report.type,'failed');assert.equal(report.messageId,f.mail.messageId);assert.equal(deliveryReport(payload,f.mail).type,'review');
 }finally{f.close();}});
test('full thread context validates canonical id, retains it through backup, and rejects changed source',async()=>{const f=fixture();try{await f.save();const incoming=incomingState(f.s,f.c.id)[0] as any,setup=threadContextSetup(f.s,f.c.id,incoming.id);const capture=await readThreadContext(setup.mail,incoming,f.mailbox,async(url:string)=>url.includes('/messages/')?f.source:{id:'thread1',messages:[f.source,f.reply]});assert.equal(capture.messages[0].messageId,canonical);assert.deepEqual(capture.messages[1].issues,[]);saveThreadContext(f.s,f.c.id,incoming.id,{basisHash:setup.basisHash,expectedId:setup.expectedId,capture});validateBackup(f.s.exportBackup());
 await assert.rejects(()=>readThreadContext(f.mail,incoming,f.mailbox,async()=>f.source));
 }finally{f.close();}});
test('backup refuses conflicting, duplicate or foreign canonical bindings',async()=>{const f=fixture();try{await f.save();const backup=f.s.exportBackup();for(const mutate of [(b:any)=>{const e=b.data.events.find((e:any)=>e.type==='GMAIL_MESSAGE_ID_BOUND');const r=JSON.parse(e.text);r.providerId='foreign';e.text=JSON.stringify(r);},(b:any)=>{const e=b.data.events.find((e:any)=>e.type==='GMAIL_MESSAGE_ID_BOUND');b.data.events.push({...e,id:randomUUID()});},(b:any)=>{b.data.events.find((e:any)=>e.type==='GMAIL_MESSAGE_ID_BOUND').clientId=f.other.id;}]){const changed=structuredClone(backup);mutate(changed);changed.checksum=createHash('sha256').update(JSON.stringify(changed.data)).digest('hex');assert.throws(()=>validateBackup(changed));}
 }finally{f.close();}});
test('renderer cannot create a canonical Gmail binding through conversation endpoint',async()=>{const f=fixture(),token='t'.repeat(48),server=await startServer(f.s,token,60000,'x'.repeat(32));try{const result=await f.read();const res=await fetch(server.url+`/api/clients/${f.c.id}/mail-tests/${f.mail.id}/conversation`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({...result,mailboxId:f.mailbox.id,clientVersion:1})});assert.equal(res.status,403);assert.equal(incomingState(f.s,f.c.id).length,0);}finally{await server.close();f.close(true);}});

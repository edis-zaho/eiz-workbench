import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
import {recordConversation,incomingState,markUnsubscribe} from '../core/inbox';
const {readConversation}=createRequire(import.meta.url)('../electron/inbox.cjs');
const mailbox={id:randomUUID(),email:'from@example.com',accessToken:'a',scopes:['https://www.googleapis.com/auth/gmail.readonly']};
const mail={id:randomUUID(),mailboxId:mailbox.id,sender:mailbox.email,recipient:'to@example.com',providerId:'sent123',messageId:`<${randomUUID()}@workbench.local>`,createdAt:'2026-01-01T00:00:00Z'};
const source={id:'sent123',threadId:'thread123',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:mail.messageId},{name:'From',value:mail.sender},{name:'To',value:mail.recipient}]}};
const reply={id:'reply123',threadId:'thread123',labelIds:['INBOX'],internalDate:String(Date.parse('2026-02-01T00:00:00Z')),snippet:'Bitte nicht weiter kontaktieren.',payload:{headers:[{name:'From',value:mail.recipient},{name:'In-Reply-To',value:mail.messageId},{name:'Subject',value:'Re: Test'}]}};
test('Gesprächsabruf unterscheidet Antwort, Automatik und unklare Zuordnung',async()=>{
 for(const [message,kind] of [[reply,'reply'],[{...reply,payload:{headers:[...reply.payload.headers,{name:'Auto-Submitted',value:'auto-replied'}]}},'automatic'],[{...reply,payload:{headers:reply.payload.headers.filter(h=>h.name!=='In-Reply-To')}},'review']] as const){
  let calls=0;const result=await readConversation(mail,mailbox,async(url:string)=>{assert.ok(url.includes('format=metadata'));return ++calls===1?source:{id:'thread123',messages:[source,message]};});assert.equal(result.rows.length,1);assert.equal(result.rows[0].kind,kind);
 }
 await assert.rejects(()=>readConversation(mail,{...mailbox,id:randomUUID()},async()=>{}));
 await assert.rejects(()=>readConversation(mail,mailbox,async()=>({...source,payload:{headers:[]}})));
});
test('Eingänge werden dedupliziert, stoppen Empfänger und bleiben nach Wiederherstellung erhalten',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-inbox-'));const s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'A',website:'',email:'',notes:''});const other=s.createClient({name:'B',website:'',email:'',notes:''});
  const input={id:randomUUID(),clientVersion:c.version,mailboxId:mailbox.id,sender:mail.sender,recipient:mail.recipient,subject:'Test',body:'Test'};
  const oldBackup=s.exportBackup();
  const run=s.reserveMailTest(c.id,input);s.finishMailTest(c.id,run.id,'sent','sent123','OK');
  const observation={mailboxId:mailbox.id,clientVersion:c.version,rows:[{providerId:'reply123',threadId:'thread123',sender:mail.recipient,subject:'Re',excerpt:'Stop',receivedAt:'2026-09-24T00:00:00Z',kind:'reply',evidence:'{}'}]};
  assert.throws(()=>recordConversation(s,other.id,run.id,observation));
  assert.equal(recordConversation(s,c.id,run.id,observation).added,1);assert.equal(recordConversation(s,c.id,run.id,observation).added,0);
  assert.throws(()=>s.reserveMailTest(c.id,{...input,id:randomUUID()}),/angehalten/);
  const rows=incomingState(s,c.id) as any[];assert.equal(rows.length,1);markUnsubscribe(s,c.id,rows[0].id);assert.throws(()=>markUnsubscribe(s,other.id,rows[0].id));
  const backup=s.exportBackup();s.restore(backup);assert.equal((incomingState(s,c.id)[0] as any).disposition,'unsubscribe');
  s.restore(oldBackup);assert.equal((incomingState(s,c.id)[0] as any).disposition,'unsubscribe');
  const paused=s.client(c.id);s.pauseClient(c.id,false,paused.version);assert.throws(()=>s.reserveMailTest(c.id,{...input,id:randomUUID(),clientVersion:s.client(c.id).version}),/angehalten/);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('Ausgangsprüfung benennt Abweichungen ohne Headerwerte und liest kein fremdes Gespräch',async()=>{
 const cases:[any,string][]=[
  [{...source,id:'other'},'Gmail-Kennung'],
  [{...source,threadId:''},'Gesprächskennung'],
  [{...source,labelIds:[]},'Gesendet-Markierung'],
  ...(['Message-ID','From','To'] as const).map((name,index)=>[
   {...source,payload:{headers:source.payload.headers.map(h=>h.name===name?{...h,value:'private-value@example.net'}:h)}},
   ['Message-ID','Absender','Empfänger'][index],
  ] as [any,string]),
 ];
 for(const [metadata,field] of cases){let calls=0;
  await assert.rejects(()=>readConversation(mail,mailbox,async()=>{calls++;return metadata;}),(error:Error)=>{
   assert.ok(error.message.includes(`(${field})`));assert.ok(!error.message.includes('private-value'));return true;
  });assert.equal(calls,1);
 }
 const duplicate={...source,payload:{headers:[...source.payload.headers,{name:'Message-ID',value:mail.messageId}]}};
 await assert.rejects(()=>readConversation(mail,mailbox,async()=>duplicate),/\(Message-ID\)/);
});

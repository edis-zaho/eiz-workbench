import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,validateBackup} from '../core/store';
import {deliveryMails,recordDeliveryScan,recordConversation} from '../core/inbox';
import {claimDeliveryPage,finishDeliveryPage,assertDeliveryFresh} from '../core/delivery-progress';
import {configureSync,claimSync,finishSync,syncState} from '../core/sync';
const {scanDeliveries}=createRequire(import.meta.url)('../electron/delivery-scan.cjs');
const {runMailSync}=createRequire(import.meta.url)('../electron/mail-sync.cjs');
function fixture(count=1101){
 const dir=mkdtempSync(join(tmpdir(),'eiz-capacity-'));let s=new Store(join(dir,'db'),join(dir,'backup'),false);
 const c=s.createClient({name:'Capacity',website:'',email:'',notes:''}),other=s.createClient({name:'Other',website:'',email:'',notes:''}),mailbox={id:randomUUID(),email:'me@example.com',scopes:['https://www.googleapis.com/auth/gmail.readonly'],readAccess:true,accessToken:'synthetic'};
 const add=(client=c.id,box=mailbox.id)=>{const id=randomUUID(),at=new Date(Date.now()-86400000).toISOString();s.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,client,box,mailbox.email,id+'@example.org','Synthetic','Not transported',`<${id}@workbench.local>`,'sent','sent_'+id,'Synthetic',at,at);return id;};
 s.transaction(()=>{for(let i=0;i<count;i++)add();add(other.id);add(c.id,randomUUID());});
 return {get s(){return s;},dir,c,other,mailbox,add,input:{mailboxId:mailbox.id,clientVersion:c.version},reopen(){s.close();s=new Store(join(dir,'db'),join(dir,'backup'),false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('more than 1000 send references retain the oldest reply and the full safety scan',async()=>{
 const f=fixture();try{
  const mails=deliveryMails(f.s,f.c.id,f.mailbox.id);assert.equal(mails.length,1101);assert.ok(mails.every(m=>m.clientId===f.c.id&&!('body'in m)&&!('subject'in m)));
  const first=mails[0],message={id:'reply_oldest',threadId:'independent',internalDate:String(Date.now()),labelIds:['INBOX'],snippet:'Stop',payload:{headers:[{name:'From',value:first.recipient},{name:'In-Reply-To',value:first.messageId}]}};
  let claim=claimDeliveryPage(f.s,f.c.id,f.input);
  const result=await scanDeliveries(claim.mails,f.mailbox,async(url:string)=>url.endsWith('/profile')?{emailAddress:f.mailbox.email,historyId:'100'}:url.includes('?maxResults=')?{messages:[{id:message.id}]}:message,claim);
  assert.equal(result.matches[0].mailId,first.id);finishDeliveryPage(f.s,f.c.id,{...result,...f.input,runId:claim.runId,leaseId:claim.leaseId});assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailbox.id));
  const saved={...result,...f.input,extended:true};assert.equal(recordDeliveryScan(f.s,f.c.id,saved).added,0);assert.throws(()=>recordDeliveryScan(f.s,f.other.id,saved));
  claim=claimDeliveryPage(f.s,f.c.id,f.input);finishDeliveryPage(f.s,f.c.id,{...claim,nextPageToken:'',matches:[],checked:0,unmatched:0,skipped:0,historyId:'101',unresolved:[]});assertDeliveryFresh(f.s,f.c.id,f.mailbox.id);
  assert.throws(()=>f.s.reserveMailTest(f.c.id,{...f.input,id:randomUUID(),sender:f.mailbox.email,recipient:first.recipient,subject:'Again',body:'Again'}),/angehalten/);
  f.add();assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailbox.id));validateBackup(f.s.exportBackup());
 }finally{f.close();}
});
test('conversation pages cover every snapshot record across failure and restart without false completion',()=>{
 const f=fixture();try{
  configureSync(f.s,f.c.id,{...f.input,enabled:true});let claim=claimSync(f.s,f.c.id,{...f.input,force:true});assert.equal(claim.messages.length,50);assert.equal(claim.total,1101);
  finishSync(f.s,f.c.id,{...f.input,leaseId:claim.leaseId,success:true,checked:25,added:0});assert.equal(syncState(f.s,f.c.id).lastSuccessAt,null);assert.equal(syncState(f.s,f.c.id).progress?.checked,25);
  const seen=new Set(claim.messages.slice(0,25).map(m=>String(m.id)));claim=claimSync(f.s,f.c.id,{...f.input,force:true});const retryIds=claim.messages.map(m=>m.id);
  finishSync(f.s,f.c.id,{...f.input,leaseId:claim.leaseId,success:false,error:'Synthetic offline'});f.reopen();claim=claimSync(f.s,f.c.id,{...f.input,force:true});assert.deepEqual(claim.messages.map(m=>m.id),retryIds);
  while(true){for(const m of claim.messages){assert.ok(!seen.has(String(m.id)));seen.add(String(m.id));}const done=finishSync(f.s,f.c.id,{...f.input,leaseId:claim.leaseId,success:true,checked:claim.messages.length,added:0});if(!done.progress)break;assert.equal(done.lastSuccessAt,null);claim=claimSync(f.s,f.c.id,{...f.input,force:true});}
  assert.equal(seen.size,1101);assert.ok(syncState(f.s,f.c.id).lastSuccessAt);assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE type='MAIL_SYNC_SUCCEEDED'").get()!.n,1);
  claim=claimSync(f.s,f.c.id,{...f.input,force:true});f.reopen();const restarted=claimSync(f.s,f.c.id,{...f.input,force:true});assert.deepEqual(restarted.messages.map(m=>m.id),claim.messages.map(m=>m.id));assert.throws(()=>finishSync(f.s,f.c.id,{...f.input,leaseId:claim.leaseId,success:true,checked:50,added:0}),/nicht mehr aktiv/);
  f.s.restore(f.s.exportBackup());assert.equal(syncState(f.s,f.c.id).progress,null);assert.equal(syncState(f.s,f.c.id).enabled,false);
 }finally{f.close();}
});
test('old claims, client changes and impossible page completion cannot certify a sync',()=>{
 const f=fixture(51);try{
  configureSync(f.s,f.c.id,{...f.input,enabled:true});const old=claimSync(f.s,f.c.id,{...f.input,force:true});
  assert.throws(()=>finishSync(f.s,f.c.id,{...f.input,leaseId:old.leaseId,success:true,checked:51,added:0}),/Seitenabschluss/);
  configureSync(f.s,f.c.id,{...f.input,enabled:false});configureSync(f.s,f.c.id,{...f.input,enabled:true});const next=claimSync(f.s,f.c.id,{...f.input,force:true});assert.throws(()=>finishSync(f.s,f.c.id,{...f.input,leaseId:old.leaseId,success:true,checked:50,added:0}));
  f.s.pauseClient(f.c.id,true,f.c.version);assert.throws(()=>finishSync(f.s,f.c.id,{...f.input,leaseId:next.leaseId,success:true,checked:50,added:0}),/Kundenstand/);assert.equal(syncState(f.s,f.c.id).lastSuccessAt,null);
 }finally{f.close();}
});
test('native sync saves a bounded prefix and failed reads are safely repeated',async()=>{
 const f=fixture(60);try{
  configureSync(f.s,f.c.id,{...f.input,enabled:true});let reads=0,fail=false;
  const request=async(path:string,input:any={})=>path.endsWith('/claim')?claimSync(f.s,f.c.id,input):path.endsWith('/finish')?finishSync(f.s,f.c.id,input):path.endsWith('/conversation')?recordConversation(f.s,f.c.id,path.split('/').at(-2)!,input):syncState(f.s,f.c.id);
  const google={status:()=>({mailbox:f.mailbox}),withMailbox:async(_id:string,fn:any)=>fn(f.mailbox),readConversation:async()=>{reads++;if(fail)throw Error('Synthetic offline');return {rows:[]};}};
  const r=await runMailSync({clientId:f.c.id,force:true,google,request,stopping:()=>reads===3});assert.equal(r.progress.checked,3);assert.equal(r.lastSuccessAt,null);
  fail=true;await assert.rejects(()=>runMailSync({clientId:f.c.id,force:true,google,request}),/offline/);assert.equal(syncState(f.s,f.c.id).progress?.checked,3);fail=false;
  await runMailSync({clientId:f.c.id,force:true,google,request});assert.equal(syncState(f.s,f.c.id).progress?.checked,53);await runMailSync({clientId:f.c.id,force:true,google,request});assert.equal(syncState(f.s,f.c.id).progress,null);assert.ok(syncState(f.s,f.c.id).lastSuccessAt);
 }finally{f.close();}
});
test('new send references added during a conversation cycle are checked before completion',()=>{
 const f=fixture(1);try{
  configureSync(f.s,f.c.id,{...f.input,enabled:true});const first=claimSync(f.s,f.c.id,{...f.input,force:true}),extra=f.add();
  const partial=finishSync(f.s,f.c.id,{...f.input,leaseId:first.leaseId,success:true,checked:1,added:0});assert.equal(partial.progress?.total,2);assert.equal(partial.lastSuccessAt,null);
  const next=claimSync(f.s,f.c.id,{...f.input,force:true});assert.equal(next.messages.length,1);assert.equal(next.messages[0].id,extra);finishSync(f.s,f.c.id,{...f.input,leaseId:next.leaseId,success:true,checked:1,added:0});assert.ok(syncState(f.s,f.c.id).lastSuccessAt);
 }finally{f.close();}
});

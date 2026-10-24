import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../core/store';
import {startServer} from '../core/server';
import {assertDeliveryFresh,deliveryProgress} from '../core/delivery-progress';

async function fixture(worker='w'.repeat(64)){
 const dir=mkdtempSync(join(tmpdir(),'eiz-mailbox-authority-')),s=new Store(join(dir,'db'),join(dir,'backups'),false);
 const c=s.createClient({name:'Synthetic',website:'',email:'',notes:''}),mailboxId=randomUUID(),token='t'.repeat(64);
 const mail=s.reserveMailTest(c.id,{id:randomUUID(),mailboxId,clientVersion:c.version,sender:'sender@example.com',recipient:'recipient@example.org',subject:'Synthetic',body:'Synthetic'});
 s.finishMailTest(c.id,mail.id,'sent','syntheticSent','OK');
 const server=await startServer(s,token,600000,worker),base=`/api/clients/${c.id}`,input={mailboxId,clientVersion:c.version};
 const request=(path:string,data:any={},proof?:string,method='POST')=>fetch(server.url+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(proof===undefined?{}:{'X-EiZ-Worker':proof})},...(method==='GET'?{}:{body:JSON.stringify(data)})});
 return {s,c,mail,base,input,worker,request,async close(){await server.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}};
}
const page=(claim:any)=>({...claim,baselineHistoryId:'1',historyId:'1',matches:[],unresolved:[],checked:0,unmatched:0,skipped:0,nextPageToken:''});

test('renderer cannot claim or forge completion of a native mailbox scan, even with the exposed lease',async()=>{
 const f=await fixture();try{
  const path=f.base+'/delivery-progress';
  assert.equal((await f.request(path+'/claim',f.input)).status,403);
  assert.equal(deliveryProgress(f.s,f.c.id).status,'never');
  for(const phase of ['full','history']){
   const response=await f.request(path+'/claim',f.input,f.worker);assert.equal(response.status,200);
   const claim=await response.json();assert.equal(claim.phase,phase);
   const visible=await(await f.request(path,{},undefined,'GET')).json();assert.equal(visible.leaseId,claim.leaseId);
   const before=f.s.exportBackup().checksum;
   for(const proof of [undefined,'wrong','x'.repeat(64)]){
    assert.equal((await f.request(path+'/finish',page(visible),proof)).status,403);
    assert.equal(deliveryProgress(f.s,f.c.id).status,'running');assert.equal(f.s.exportBackup().checksum,before);
    assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.input.mailboxId));
   }
   assert.equal((await f.request(path+'/finish',page(claim),f.worker)).status,200);
   if(phase==='full')assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.input.mailboxId));
  }
  assertDeliveryFresh(f.s,f.c.id,f.input.mailboxId);
  const backup=f.s.exportBackup();f.s.restore(backup);
  assert.equal(deliveryProgress(f.s,f.c.id).status,'never');assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.input.mailboxId));
 }finally{await f.close();}
});

test('all mailbox observation mutations reject renderer proof before changing state, including route aliases',async()=>{
 const f=await fixture();try{
  const paths=['delivery-progress/configure','delivery-progress/claim','delivery-progress/finish','delivery-progress/fail','delivery-progress/start-failed','mail-sync/configure','mail-sync/claim','mail-sync/finish','delivery-scan',`mail-tests/${f.mail.id}/conversation`];
  const before=f.s.exportBackup().checksum;
  for(const suffix of paths)for(const proof of [undefined,'x'.repeat(64)])for(const path of [f.base+'/'+suffix,f.base+'//'+suffix+'/?attempt=1']){
   const response=await f.request(path,{...f.input,enabled:true,rows:[],sourceReference:undefined},proof);
   assert.equal(response.status,403,path);assert.equal(f.s.exportBackup().checksum,before,path);
  }
  assert.equal((await f.request(f.base+`/mail-tests/${f.mail.id}/conversation`,{...f.input,rows:[],sourceReference:{} })).status,403);
  for(const path of ['delivery-progress','mail-sync','incoming',`mail-tests/${f.mail.id}/conversation`])assert.equal((await f.request(f.base+'/'+path,{},undefined,'GET')).status,200);
 }finally{await f.close();}
});

test('native conversation import, sync completion and separate delivery scan retain normal behavior',async()=>{
 const f=await fixture();try{
  const post=async(path:string,data:any)=>{const r=await f.request(f.base+path,data,f.worker),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
  await post('/mail-sync/configure',{...f.input,enabled:true});
  const claim=await post('/mail-sync/claim',f.input);assert.equal(claim.messages.length,1);
  const row={providerId:'syntheticReply',threadId:'syntheticThread',sender:'recipient@example.org',subject:'Reply',excerpt:'Please stop',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'};
  const data={...f.input,rows:[row]};
  assert.equal((await post(`/mail-tests/${f.mail.id}/conversation`,data)).added,1);
  assert.equal((await post(`/mail-tests/${f.mail.id}/conversation`,data)).added,0);
  const complete=await post('/mail-sync/finish',{...f.input,leaseId:claim.leaseId,success:true,checked:1,added:1});assert.ok(complete.lastSuccessAt);assert.equal(complete.status,'idle');
  const scan=await post('/delivery-scan',{...f.input,checked:0,matches:[],unmatched:0,unresolved:[],skipped:0,query:'synthetic',truncated:false});assert.equal(scan.checked,0);
  assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM incoming').get()!.n,1);
  assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.input.mailboxId),'legacy scan and sync cannot replace full/history freshness');
 }finally{await f.close();}
});

test('mailbox mutations fail closed when the service has no valid worker credential',async()=>{
 const f=await fixture('');try{
  for(const path of ['delivery-progress/claim','mail-sync/configure','delivery-scan',`mail-tests/${f.mail.id}/conversation`])assert.equal((await f.request(f.base+'/'+path,{...f.input,enabled:true,rows:[]},'w'.repeat(64))).status,403);
  assert.equal(deliveryProgress(f.s,f.c.id).status,'never');
 }finally{await f.close();}
});

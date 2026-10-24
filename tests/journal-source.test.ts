import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,AppError} from '../core/store';
import {exportClientJournal} from '../core/journal-source';
import {recordConversation} from '../core/inbox';
import {startServer} from '../core/server';
import {saveProduct} from '../core/catalog';
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'eiz-journal-export-')),store=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);
  const a=store.createClient({name:'A',website:'',email:'',notes:''}).id,b=store.createClient({name:'B',website:'',email:'',notes:''}).id;
  const mailboxId=randomUUID();
  const mail=(clientId=a)=>store.reserveMailTest(clientId,{id:randomUUID(),clientVersion:store.client(clientId).version,mailboxId,sender:'sender@example.com',recipient:'private@example.com',subject:'Private subject',body:'Private body'});
  return {store,a,b,dir,mailboxId,mail,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('journal export preserves status observations without leaking source payloads or modifying the database',()=>{
  const f=fixture();try{
    const m=f.mail(),foreign=f.mail(f.b);f.store.finishMailTest(f.a,m.id,'unknown','','Private failure');
    f.store.reconcileMail(f.a,m.id,{mailboxId:f.mailboxId,clientVersion:1,messageId:m.messageId,outcome:'found',providerId:'private-provider'});
    recordConversation(f.store,f.a,m.id,{mailboxId:f.mailboxId,clientVersion:1,rows:[{providerId:'private-reply',threadId:'private-thread',sender:m.recipient,subject:'Private subject',excerpt:'Private text',receivedAt:'2026-09-01T00:00:00.000Z',kind:'reply',evidence:'{"private":"source"}'}]});
    const before=f.store.exportBackup().data,result=exportClientJournal(f.store,f.a,{});
    assert.equal(result.rowCount,4);assert.equal(result.filename,'ereignishistorie.csv');
    for(const state of ['sending','unknown','sent'])assert.ok(result.csv.includes(state));
    for(const sensitive of ['private-', 'Private ',m.recipient,foreign.id,f.mailboxId,'messageId','threadId','providerId'])assert.ok(!result.csv.includes(sensitive),sensitive);
    assert.equal(exportClientJournal(f.store,f.a,{source:'incoming'}).rowCount,1);
    assert.equal(exportClientJournal(f.store,f.a,{source:'incoming',timeBasis:'occurredAt',fromInclusive:'2026-09-01T00:00:00Z',toExclusive:'2026-09-02T00:00:00Z'}).rowCount,1);
    assert.deepEqual(f.store.exportBackup().data,before);
  }finally{f.close();}
});
test('journal filters are validated before empty exports and customer overrides are rejected',()=>{
  const f=fixture();try{
    for(const value of [null,[],{clientId:f.b},{source:'sent'},{timeBasis:'local'},{fromInclusive:'2026-02-30T00:00:00Z'},{fromInclusive:12},{unknown:true}])assert.throws(()=>exportClientJournal(f.store,f.a,value),AppError);
    assert.throws(()=>exportClientJournal(f.store,randomUUID(),{}),(e:any)=>e.status===404);
    assert.equal(exportClientJournal(f.store,f.a,{}).rowCount,0);
  }finally{f.close();}
});

test('journal export rejects corrupt stored observations without exposing their content or changing data',()=>{
  const f=fixture();try{
    const m=f.mail();
    // Valid JSON can still violate the event contract. Insert a synthetic damaged
    // observation without disabling the production append-only trigger.
    f.store.db.prepare(`INSERT INTO evidence_events SELECT ?,clientId,source,sourceId,2,eventType,origin,occurredAt,recordedAt,timeBasis,mailboxId,providerId,?,context FROM evidence_events WHERE sourceId=?`).run(randomUUID(),JSON.stringify({status:'private-invalid-state',messageId:m.messageId,result:'private failure'}),m.id);
    const before=f.store.exportBackup().data;
    assert.throws(()=>exportClientJournal(f.store,f.a,{}),(error:any)=>error instanceof AppError&&!error.message.includes('private'));
    assert.deepEqual(f.store.exportBackup().data,before);
    // A malformed observation belonging to A must not invalidate B's export.
    assert.equal(exportClientJournal(f.store,f.b,{}).rowCount,0);
  }finally{f.close();}
});

test('journal source limit is per customer and rejects overflow even when filters would hide it',()=>{
  const f=fixture();try{
    const m=f.mail();
    const template=f.store.db.prepare('SELECT id FROM evidence_events WHERE clientId=? AND sourceId=? AND sourceRevision=1').get(f.a,m.id)!.id;
    const insert=f.store.db.prepare(`INSERT INTO evidence_events SELECT ?,clientId,source,sourceId,?,eventType,origin,occurredAt,recordedAt,timeBasis,mailboxId,providerId,payload,context FROM evidence_events WHERE id=?`);
    f.store.transaction(()=>{for(let revision=2;revision<=50000;revision++)insert.run(randomUUID(),revision,template);});
    assert.equal(exportClientJournal(f.store,f.a,{}).rowCount,50000);
    insert.run(randomUUID(),50001,template);
    const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.throws(()=>exportClientJournal(f.store,f.a,{source:'incoming',fromInclusive:'2099-01-01T00:00:00Z'}),/50000/);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
    assert.equal(exportClientJournal(f.store,f.b,{}).rowCount,0);
  }finally{f.close();}
});

test('existing foreign customer references cannot leak through a damaged historical context',()=>{
  const f=fixture();try{
    const m=f.mail(),product=saveProduct(f.store,f.b,null,{name:'Private product',description:'',website:'',bookingUrl:'',archived:false},0);
    const row=f.store.db.prepare('SELECT context FROM evidence_events WHERE sourceId=?').get(m.id)!;
    const context={...JSON.parse(String(row.context)),runId:randomUUID(),campaignId:randomUUID(),contactId:randomUUID(),campaignFingerprint:'a'.repeat(64),productId:product.productId,productRevision:1};
    f.store.db.prepare(`INSERT INTO evidence_events SELECT ?,clientId,source,sourceId,2,eventType,origin,occurredAt,recordedAt,timeBasis,mailboxId,providerId,payload,? FROM evidence_events WHERE sourceId=?`).run(randomUUID(),JSON.stringify(context),m.id);
    assert.throws(()=>exportClientJournal(f.store,f.a,{}),(error:any)=>error instanceof AppError&&!error.message.includes(product.productId));
    assert.equal(exportClientJournal(f.store,f.b,{}).rowCount,0);
  }finally{f.close();}
});
test('journal export API requires authorization and cannot cross customer boundaries through input',async()=>{
  const f=fixture(),token='j'.repeat(64);f.mail();const server=await startServer(f.store,token,600000);
  const post=(client:string,input:unknown,auth=true)=>fetch(server.url+`/api/clients/${client}/journal-export`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(input)});
  try{
    assert.equal((await post(f.a,{},false)).status,401);assert.equal((await post(f.a,{clientId:f.b})).status,400);
    const crossOrigin=await fetch(server.url+`/api/clients/${f.a}/journal-export`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});
    assert.equal(crossOrigin.status,403);
    const response=await post(f.a,{});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const a=await response.json(),b=await(await post(f.b,{})).json();assert.equal(a.rowCount,1);assert.equal(b.rowCount,0);assert.ok(!b.csv.includes(f.a));
  }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});

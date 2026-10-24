import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Store,validateBackup,AppError} from '../core/store';
import {saveProduct} from '../core/catalog';
import {knowledgeState,saveKnowledge,exportKnowledge,exportProductKnowledge} from '../core/knowledge';
import {sourceContent,claimContent} from '../core/knowledge-input';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
import {recordConversation} from '../core/inbox';
import {saveHumanInterpretation,interpretationHistory} from '../core/interpretations';
import {emptyInterpretation} from '../core/interpretation-input';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
const productInput={name:'Synthetic product',description:'Synthetic only',website:'',bookingUrl:'',archived:false};
const sourceInput={title:'Approved synthetic document',locator:'https://example.com/product',capturedAt:'2026-09-01T12:00:00.000Z',text:'The product exports CSV. No automatic integration is promised.',withdrawn:false};
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'eiz-knowledge-')),filename=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(filename,backups,false);
  const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id;
  const p=saveProduct(s,a,null,productInput,0).productId,q=saveProduct(s,a,null,{...productInput,name:'Second'},0).productId;
  const state=()=>knowledgeState(s,a,p);
  function input(kind='source',content:any=sourceInput,entityId:string|null=null,action='save') {const old=state().items.find(r=>r.entityId===entityId);return {entityId,expectedRevision:old?.revision||0,productRevision:state().productRevision,kind,action,content,actor:'Synthetic reviewer',reason:'Checked synthetic basis'};}
  function source(content=sourceInput,entityId:string|null=null){return saveKnowledge(s,a,p,input('source',content,entityId));}
  function claim(sourceId:string){return saveKnowledge(s,a,p,input('claim',{category:'feature',text:'CSV export available.',sourceId,quote:'The product exports CSV.'}));}
  function review(entityId:string,action='approve'){const row=state().items.find(r=>r.entityId===entityId)!;return saveKnowledge(s,a,p,input('claim',row.content,entityId,action));}
  return {get s(){return s;},a,b,p,q,dir,backups,input,state,source,claim,review,reopen(){s.close();s=new Store(filename,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('knowledge inputs reject unknown fields, executable locators and invented source identifiers',()=>{
  for(const patch of [{locator:'javascript:alert(1)'},{locator:'file:///secret'},{locator:'https://user:pass@example.com'},{capturedAt:'yesterday'},{withdrawn:0},{text:' '},{text:'x'.repeat(20001)},{actor:'forged'},{title:'bad\0text'}])assert.throws(()=>sourceContent({...sourceInput,...patch}));
  assert.throws(()=>claimContent({category:'truth',text:'x',sourceId:randomUUID(),quote:'x'}));
  assert.equal(sourceContent({...sourceInput,locator:'Product datasheet, page 2'}).locator,'Product datasheet, page 2');
});
test('source, draft, approval and withdrawal remain separate durable versions without changing delivery data',()=>{
  const f=fixture();try{
    const before=f.s.exportBackup().data,source=f.source(),claim=f.claim(source.id);
    assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.usable,false);
    f.review(claim.entityId);assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.usable,true);
    f.review(claim.entityId,'withdraw');assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.usable,false);
    assert.equal(f.state().rows.length,4);assert.deepEqual({...f.s.exportBackup().data,knowledge:[]},before);
    assert.throws(()=>f.s.db.prepare("UPDATE knowledge_versions SET actor='x'").run(),/overwritten/);
    f.reopen();assert.equal(f.state().rows.length,4);assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.state,'withdrawn');
  }finally{f.close();}
});
test('approval requires the exact saved draft; content editing resets approval',()=>{
  const f=fixture();try{
    const source=f.source(),claim=f.claim(source.id),row=f.state().items.find(r=>r.entityId===claim.entityId)!;
    assert.throws(()=>saveKnowledge(f.s,f.a,f.p,f.input('claim',{...row.content,text:'Changed during approval'},claim.entityId,'approve')),/Entwurf/);
    assert.throws(()=>saveKnowledge(f.s,f.a,f.p,f.input('claim',row.content,null,'approve')),/Entwurf/);
    f.review(claim.entityId);assert.throws(()=>f.review(claim.entityId),/Entwurf/);
    saveKnowledge(f.s,f.a,f.p,f.input('claim',{...row.content,text:'Reworded CSV statement'},claim.entityId));
    assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.state,'draft');
    f.review(claim.entityId);assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.usable,true);
  }finally{f.close();}
});
test('source change invalidates old approvals and requires an explicit draft tied to the new source',()=>{
  const f=fixture();try{
    const source=f.source(),claim=f.claim(source.id);f.review(claim.entityId);
    const next=f.source({...sourceInput,text:sourceInput.text+' Updated document.'},source.entityId);
    assert.match(f.state().items.find(r=>r.entityId===claim.entityId)!.inactiveReason,/Quelle inzwischen/);
    assert.throws(()=>f.claim(source.id),/aktuelle/);
    f.review(claim.entityId,'withdraw');
    const content=f.state().items.find(r=>r.entityId===claim.entityId)!.content;
    saveKnowledge(f.s,f.a,f.p,f.input('claim',{...content,sourceId:next.id},claim.entityId));f.review(claim.entityId);
    assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.usable,true);
    f.source({...sourceInput,withdrawn:true},source.entityId);assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.usable,false);
    assert.equal(f.state().rows.filter(r=>r.kind==='source').length,3);
  }finally{f.close();}
});
test('product changes never carry approvals automatically and archived products cannot be edited',()=>{
  const f=fixture();try{
    const source=f.source(),claim=f.claim(source.id);f.review(claim.entityId);const stale=f.input();
    saveProduct(f.s,f.a,f.p,{...productInput,description:'Version two'},1);
    assert.match(f.state().items.find(r=>r.entityId===claim.entityId)!.inactiveReason,/Produktstand/);
    assert.throws(()=>saveKnowledge(f.s,f.a,f.p,stale),(e:any)=>e.status===409);
    assert.throws(()=>f.claim(source.id),/aktuelle/);
    f.review(claim.entityId,'withdraw');validateBackup(f.s.exportBackup());
    const updated=f.source(sourceInput,source.entityId),c=f.claim(updated.id);f.review(c.entityId);
    assert.equal(f.state().items.find(r=>r.entityId===c.entityId)!.usable,true);
    saveProduct(f.s,f.a,f.p,{...productInput,archived:true},2);assert.throws(()=>f.source(),/Archivierte/);
    assert.ok(f.state().items.every(r=>!r.usable));
  }finally{f.close();}
});
test('source ownership, customer isolation and exact quotes cannot be bypassed',()=>{
  const f=fixture();try{
    const source=f.source();
    const content={category:'feature',text:'Invented integration',sourceId:source.id,quote:'The product integrates with everything.'};
    assert.throws(()=>saveKnowledge(f.s,f.a,f.p,f.input('claim',content)),/Beleg/);
    assert.throws(()=>saveKnowledge(f.s,f.a,f.q,{...f.input('claim',{...content,quote:'The product exports CSV.'})}),/Beleg/);
    assert.throws(()=>knowledgeState(f.s,f.b,f.p),(e:any)=>e.status===404);
    assert.throws(()=>exportProductKnowledge(f.s,f.b,f.p),(e:any)=>e.status===404);
    assert.throws(()=>saveKnowledge(f.s,f.b,f.p,f.input()),(e:any)=>e.status===404);
    assert.throws(()=>saveKnowledge(f.s,f.a,f.q,f.input('source',sourceInput,source.entityId)),(e:any)=>e.status===404);
    for(const extra of [{origin:'model'},{model:'forged'},{clientId:f.b}])assert.throws(()=>saveKnowledge(f.s,f.a,f.p,{...f.input(),...extra}),AppError);
  }finally{f.close();}
});
test('competing writes and storage errors leave no partial knowledge or changed source',()=>{
  const f=fixture();try{
    const source=f.source(),old=f.input('source',sourceInput,source.entityId);f.source(sourceInput,source.entityId);
    assert.throws(()=>saveKnowledge(f.s,f.a,f.p,old),(e:any)=>e.status===409);
    const before=f.s.exportBackup().data;
    f.s.db.exec("CREATE TRIGGER synthetic_knowledge_failure BEFORE INSERT ON knowledge_versions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.throws(()=>f.source(),AppError);assert.deepEqual(f.s.exportBackup().data,before);
    f.s.db.exec('DROP TRIGGER synthetic_knowledge_failure');f.source();
  }finally{f.close();}
});
test('historical restore cannot resurrect a revoked statement; checkpoints and isolated restore retain all content',()=>{
  const f=fixture();try{
    const source=f.source(),claim=f.claim(source.id);f.review(claim.entityId);const old=f.s.exportBackup();f.review(claim.entityId,'withdraw');
    const known=exportKnowledge(f.s);f.s.restore(old);assert.deepEqual(exportKnowledge(f.s),known);assert.equal(f.state().items.find(r=>r.entityId===claim.entityId)!.state,'withdrawn');
    const backup=f.s.exportBackup();assert.equal(rehearseRestore(backup).counts.knowledge,4);
    const checkpoint=saveCheckpoint(join(f.dir,'checkpoints'),f.dir),saved=validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8')));
    assert.deepEqual(saved.data.knowledge,JSON.parse(JSON.stringify(known)));
    assert.equal(exportProductKnowledge(f.s,f.a,f.q).rows.length,0);
  }finally{f.close();}
});
test('backup validation rejects forged approvals, missing history, foreign references and wrong source text',()=>{
  const f=fixture();try{
    const src=f.source(),claim=f.claim(src.id);f.review(claim.entityId);const backup=f.s.exportBackup();
    for(const change of [
      (b:any)=>delete b.data.knowledge,
      (b:any)=>b.data.knowledge[0].clientId=f.b,
      (b:any)=>b.data.knowledge[0].productRevision=99,
      (b:any)=>b.data.knowledge[0].actor='',
      (b:any)=>b.data.knowledge.find((r:any)=>r.kind==='claim'&&r.revision===1).state='approved',
      (b:any)=>b.data.knowledge=b.data.knowledge.filter((r:any)=>r.state!=='draft'),
      (b:any)=>b.data.knowledge.find((r:any)=>r.state==='approved').previousId=randomUUID(),
      (b:any)=>{const r=b.data.knowledge.find((r:any)=>r.kind==='source');r.content=JSON.stringify({...JSON.parse(r.content),text:'Different source'});},
      (b:any)=>{const r=b.data.knowledge.find((r:any)=>r.state==='approved');r.content=JSON.stringify({...JSON.parse(r.content),text:'Changed approved claim'});},
      (b:any)=>b.version=12
    ]){const changed=structuredClone(backup);change(changed);assert.throws(()=>validateBackup(resign(changed)),/Produktwissen/);}
    const changed=structuredClone(backup);changed.data.knowledge![0].reason='changed known record';assert.throws(()=>f.s.restore(resign(changed)),/bekanntem Produktwissen/);
    const fork=structuredClone(backup);fork.data.knowledge!.find(r=>r.state==='approved')!.id=randomUUID();assert.throws(()=>f.s.restore(resign(fork)),/Produktwissen/);
    assert.deepEqual(f.s.exportBackup().data,backup.data);
  }finally{f.close();}
});
test('schema12 migration saves existing interpretation history before adding an empty knowledge table',()=>{
  const f=fixture();try{
    const mailboxId=randomUUID(),mail=f.s.reserveMailTest(f.a,{id:randomUUID(),clientVersion:1,mailboxId,sender:'sender@example.com',recipient:'lead@example.com',subject:'Synthetic',body:'Synthetic'});
    f.s.finishMailTest(f.a,mail.id,'sent','synthetic','OK');
    recordConversation(f.s,f.a,mail.id,{mailboxId,clientVersion:f.s.client(f.a).version,rows:[{providerId:'synthetic-reply',threadId:'synthetic-thread',sender:'lead@example.com',subject:'Question',excerpt:'Synthetic question',receivedAt:'2026-09-01T12:00:00.000Z',kind:'reply',evidence:'{}'}]});
    const eventId=String(f.s.db.prepare("SELECT id FROM evidence_events WHERE source='incoming'").get()!.id),basis=interpretationHistory(f.s,f.a,eventId);
    saveHumanInterpretation(f.s,f.a,eventId,{expectedRevision:0,expectedBasisHash:basis.basisHash,reviewer:'Synthetic reviewer',content:{...emptyInterpretation(),rationale:'Preserve during migration'}});
    const before=f.s.exportBackup();assert.equal(before.data.interpretations!.length,1);f.s.db.exec('DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; PRAGMA user_version=12');f.reopen();
    assert.equal(f.s.snapshot().database.schema,34);assert.deepEqual(exportKnowledge(f.s),[]);
    const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!;
    const backup=validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8')));
    assert.equal(backup.version,12);assert.deepEqual(backup.data.interpretations,JSON.parse(JSON.stringify(before.data.interpretations)));assert.equal(backup.data.knowledge,undefined);
    assert.deepEqual(backup.data.productRevisions,JSON.parse(JSON.stringify(before.data.productRevisions)));
  }finally{f.close();}
});
test('escaped source text survives export and restore without truncation',()=>{
  const f=fixture();try{
    const text='start'+('\t\n"'.repeat(6600))+'end';f.source({...sourceInput,text});
    const backup=validateBackup(f.s.exportBackup());assert.equal(rehearseRestore(backup).counts.knowledge,1);
    assert.equal(JSON.parse(exportKnowledge(f.s)[0].content).text,text);
  }finally{f.close();}
});
test('knowledge revision limit fails explicitly without overwriting history',()=>{
  const f=fixture();try{
    const src=f.source();for(let n=1;n<100;n++)f.source(sourceInput,src.entityId);
    assert.throws(()=>f.source(sourceInput,src.entityId),/Produktwissen/);assert.equal(f.state().rows.length,100);validateBackup(f.s.exportBackup());
  }finally{f.close();}
});
test('knowledge API enforces authentication, origin, ownership and stale revisions',async()=>{
  const f=fixture(),token='k'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/products/${f.p}/knowledge`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  try{
    assert.equal((await fetch(server.url+path)).status,401);
    assert.equal((await fetch(server.url+path,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify(f.input())})).status,403);
    const first=await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(f.input())});assert.equal(first.status,200);const saved=await first.json();
    const input=f.input('source',sourceInput,saved.entityId);assert.equal((await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(input)})).status,200);
    assert.equal((await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(input)})).status,409);
    assert.equal((await fetch(server.url+path.replace(f.a,f.b),{headers})).status,404);
    assert.equal((await(await fetch(server.url+path+'-export',{headers})).json()).rows.length,2);
  }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});

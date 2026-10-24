import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Store,validateBackup} from '../core/store';
import {saveProduct} from '../core/catalog';
import {knowledgeState,saveKnowledge} from '../core/knowledge';
import {reserveKnowledgeRun,finishKnowledgeRun,knowledgeRuns,adoptKnowledgeSuggestion} from '../core/knowledge-runs';
import {startServer} from '../core/server';
const {callModel}=createRequire(import.meta.url)('../electron/models.cjs');
const product={name:'Synthetic',description:'Only test data',website:'',bookingUrl:'',archived:false};
const source={title:'Synthetic manual',locator:'Test page 1',capturedAt:'2026-09-30T12:00:00.000Z',text:'The product exports CSV.',withdrawn:false};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'eiz-knowledge-run-')),file=join(dir,'db.sqlite');let s=new Store(file,join(dir,'backups'),false);
  const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id;
  const p=saveProduct(s,a,null,product,0).productId,q=saveProduct(s,a,null,product,0).productId;
  const brief=s.brief(a);s.saveRules(a,{...brief.content,routes:{analysis:{provider:'openai',model:'synthetic-model'},writing:{provider:'openai',model:''}},revision:brief.revision});
  const row=saveKnowledge(s,a,p,{entityId:null,expectedRevision:0,productRevision:1,kind:'source',action:'save',content:source,actor:'Test',reason:'Synthetic'});
  const input=()=>({productRevision:1,sourceIds:[row.id],briefRevision:s.brief(a).revision,confirmed:true});
  const suggestion={category:'feature',text:'Exports CSV.',sourceId:row.id,quote:'The product exports CSV.'};
  const finish=(id:string,text=JSON.stringify({suggestions:[suggestion]}))=>finishKnowledgeRun(s,a,p,id,{status:'completed',text,usage:{inputTokens:40,outputTokens:20}});
  return {get s(){return s;},a,b,p,q,row,input,suggestion,finish,reopen(){s.close();s=new Store(file,join(dir,'backups'),false);},close(alreadyClosed=false){if(!alreadyClosed)s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('product-bound request, verified preview, edited draft and separate approval survive restart',()=>{
  const f=fixture();try{
    const run=reserveKnowledgeRun(f.s,f.a,f.p,f.input());assert.equal(run.purpose,'knowledge');assert.ok(run.prompt.user.includes(f.row.id));
    assert.throws(()=>reserveKnowledgeRun(f.s,f.a,f.p,f.input()),/bereits/);
    const r=f.finish(run.id)[0];assert.equal(r.usage.costStatus,'unpriced');assert.equal(r.suggestions.length,1);assert.equal(knowledgeState(f.s,f.a,f.p).rows.length,1);
    const saved=adoptKnowledgeSuggestion(f.s,f.a,f.p,run.id,{index:0,content:{...f.suggestion,text:'CSV export.'},actor:'Reviewer',reason:'Checked quote and edited wording.'});
    const row=knowledgeState(f.s,f.a,f.p).items.find(x=>x.entityId===saved.entityId)!;assert.equal(row.state,'draft');assert.equal(row.usable,false);assert.match(row.reason,new RegExp(run.id));
    assert.throws(()=>adoptKnowledgeSuggestion(f.s,f.a,f.p,run.id,{index:0,content:f.suggestion,actor:'Again',reason:'Again'}),/bereits/);
    f.reopen();assert.equal(knowledgeRuns(f.s,f.a,f.p)[0].suggestions[0].entityId,saved.entityId);validateBackup(f.s.exportBackup());
    assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM mail_tests').get()!.n,0);
  }finally{f.close();}
});
test('foreign customer/product/source, stale route, duplicate selection and extra fields rejected before reservation',()=>{
  const f=fixture();try{
    for(const [client,productId,patch] of [[f.b,f.p,{}],[f.a,f.q,{}],[f.a,f.p,{sourceIds:[f.row.id,f.row.id]}],[f.a,f.p,{briefRevision:0}],[f.a,f.p,{confirmed:false}],[f.a,f.p,{provider:'forged'}],[f.a,f.p,{sourceIds:[]}] ] as const)assert.throws(()=>reserveKnowledgeRun(f.s,client,productId,{...f.input(),...patch}));
    assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM ai_runs').get()!.n,0);
    const r=reserveKnowledgeRun(f.s,f.a,f.p,f.input());assert.throws(()=>finishKnowledgeRun(f.s,f.b,f.p,r.id,{status:'completed',text:'{}',usage:{}}));assert.throws(()=>finishKnowledgeRun(f.s,f.a,f.q,r.id,{status:'completed',text:'{}',usage:{}}));
    assert.throws(()=>f.s.finishAI(f.a,r.id,'completed','forged',{}));
  }finally{f.close();}
});
test('changed, withdrawn or archived context cannot be adopted; stale result remains readable',()=>{
  for(const kind of ['source','withdraw','product','archive','client']){const f=fixture();try{
    const r=reserveKnowledgeRun(f.s,f.a,f.p,f.input());
    if(kind==='source'||kind==='withdraw')saveKnowledge(f.s,f.a,f.p,{entityId:f.row.entityId,expectedRevision:1,productRevision:1,kind:'source',action:'save',content:{...source,withdrawn:kind==='withdraw'},actor:'Test',reason:'Changed'});
    if(kind==='product'||kind==='archive')saveProduct(f.s,f.a,f.p,{...product,archived:kind==='archive'},1);
    if(kind==='client'){const c=f.s.client(f.a);f.s.updateClient(f.a,{...c,status:'paused'},c.version);}
    assert.ok(f.finish(r.id)[0].stale);
    assert.throws(()=>adoptKnowledgeSuggestion(f.s,f.a,f.p,r.id,{index:0,content:f.suggestion,actor:'Test',reason:'No'}));
    assert.equal(knowledgeState(f.s,f.a,f.p).rows.filter(r=>r.kind==='claim').length,0);
  }finally{f.close();}}
});
test('invalid output is terminal, has no raw-response leak and does not create any claim',()=>{
  for(const text of ['```json\n{}\n```','secret raw response',JSON.stringify({suggestions:[{category:'feature',text:'False',quote:'Invented',sourceId:'00000000-0000-0000-0000-000000000000'}]})]){
    const f=fixture();try{const r=reserveKnowledgeRun(f.s,f.a,f.p,f.input());const result=f.finish(r.id,text)[0];assert.equal(result.status,'failed');assert.equal(result.suggestions.length,0);assert.ok(!result.message.includes('secret'));assert.throws(()=>f.finish(r.id),/abgeschlossen/);validateBackup(f.s.exportBackup());}finally{f.close();}
  }
});
test('edited quote/source injection and forced approval cannot bypass draft adoption',()=>{
  const f=fixture();try{const r=reserveKnowledgeRun(f.s,f.a,f.p,f.input());f.finish(r.id);
    for(const patch of [{content:{...f.suggestion,quote:'Invented'}},{content:{...f.suggestion,sourceId:f.q}},{index:20},{approved:true},{actor:''}])assert.throws(()=>adoptKnowledgeSuggestion(f.s,f.a,f.p,r.id,{index:0,content:f.suggestion,actor:'Test',reason:'Checked',...patch}));
    assert.equal(knowledgeState(f.s,f.a,f.p).rows.length,1);
    f.s.db.exec("CREATE TRIGGER fail_draft BEFORE INSERT ON knowledge_versions BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.throws(()=>adoptKnowledgeSuggestion(f.s,f.a,f.p,r.id,{index:0,content:f.suggestion,actor:'Test',reason:'Checked'}));assert.equal(knowledgeRuns(f.s,f.a,f.p)[0].suggestions[0].entityId,null);
  }finally{f.close();}
});
test('shared daily budget counts failed attempts and interrupted runs never retry',()=>{
  const f=fixture();try{
    const b=f.s.brief(f.a);f.s.saveRules(f.a,{...b.content,rules:{...b.content.rules,aiDailyLimit:1},revision:b.revision});
    const r=reserveKnowledgeRun(f.s,f.a,f.p,f.input());f.reopen();assert.equal(knowledgeRuns(f.s,f.a,f.p)[0].status,'unknown');
    assert.throws(()=>reserveKnowledgeRun(f.s,f.a,f.p,f.input()),/Tageslimit/);assert.throws(()=>f.finish(r.id),/abgeschlossen/);
  }finally{f.close();}
});
test('backup binds source snapshots and preserves known completed runs when an older backup is restored',()=>{
  const f=fixture();try{
    const before=f.s.exportBackup(),r=reserveKnowledgeRun(f.s,f.a,f.p,f.input());f.finish(r.id);
    const saved=adoptKnowledgeSuggestion(f.s,f.a,f.p,r.id,{index:0,content:f.suggestion,actor:'Test',reason:'Checked'}),backup=f.s.exportBackup();validateBackup(backup);
    for(const change of [(b:any)=>b.data.aiRuns[0].clientId=f.b,(b:any)=>b.data.aiRuns[0].result='{}',(b:any)=>{const c=JSON.parse(b.data.aiRuns[0].context);c.sources[0].text='forged';b.data.aiRuns[0].context=JSON.stringify(c);}]){const b=structuredClone(backup);change(b);b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');assert.throws(()=>validateBackup(b));}
    f.s.restore(before);f.reopen();const restored=knowledgeRuns(f.s,f.a,f.p)[0];assert.equal(restored.id,r.id);assert.equal(restored.suggestions[0].entityId,saved.entityId);assert.ok(restored.stale);validateBackup(f.s.exportBackup());
  }finally{f.close();}
});
test('native proof required to reserve/finish, reader cannot forge completion through old endpoint',async()=>{
  const f=fixture(),token='x'.repeat(64),worker='w'.repeat(64),server=await startServer(f.s,token,600000,worker),base=`/api/clients/${f.a}/products/${f.p}/knowledge-runs`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'},post=(path:string,value:any,native=false)=>fetch(server.url+path,{method:'POST',headers:{...headers,...(native?{'X-EiZ-Worker':worker}:{})},body:JSON.stringify(value)});
  try{
    assert.equal((await post(base+'/reserve',f.input())).status,403);
    const response=await post(base+'/reserve',f.input(),true);assert.equal(response.status,200);const run=await response.json();
    assert.equal((await post(base+`/${run.id}/finish`,{status:'completed',text:'{}',usage:{}})).status,403);
    assert.equal((await post(`/api/clients/${f.a}/ai/${run.id}/finish`,{status:'completed',result:'forged',usage:{}})).status,403);
    assert.equal((await post(base+`/${run.id}/finish`,{status:'completed',text:JSON.stringify({suggestions:[f.suggestion]}),usage:{}},true)).status,200);
    assert.equal((await fetch(server.url+base)).status,401);
  }finally{await server.close();f.close(true);}
});
test('both provider adapters use server prompt, JSON mode, no tools and a single request',async()=>{
  for(const provider of ['openai','gemini']){const f=fixture();try{const run=reserveKnowledgeRun(f.s,f.a,f.p,f.input());let count=0;
    const result=await callModel({...run,provider,key:'synthetic-secret'},async(url:string,init:any)=>{count++;const b=JSON.parse(init.body);assert.ok(!init.body.includes('synthetic-secret'));assert.equal(b.tools,undefined);
      if(provider==='openai'){assert.equal(b.instructions,run.prompt.system);assert.equal(b.input,run.prompt.user);assert.equal(b.text.format.type,'json_object');return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({suggestions:[f.suggestion]})}]}]}));}
      assert.equal(b.systemInstruction.parts[0].text,run.prompt.system);assert.equal(b.generationConfig.responseMimeType,'application/json');assert.equal(b.store,undefined);return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({suggestions:[]})}]}}]}));
    });assert.equal(count,1);assert.doesNotThrow(()=>JSON.parse(result.text));
  }finally{f.close();}}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Store,validateBackup,AppError} from '../core/store';
import {saveProduct} from '../core/catalog';
import {saveKnowledge,knowledgeState} from '../core/knowledge';
import {saveStrategy,strategyState,exportStrategy,exportProductStrategy} from '../core/strategy';
import {personaContent,hypothesisContent,matchPersonaTitle} from '../core/strategy-input';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
const product={name:'Synthetic product',description:'CSV export',website:'',bookingUrl:'',archived:false};
const persona={code:'IT_LEADERSHIP',name:'IT-Leitung',responsibility:'Verantwortet Systeme und Schnittstellen.',titles:['Head of IT','IT Director']};
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-strategy-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
 const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id,p=saveProduct(s,a,null,product,0).productId,q=saveProduct(s,a,null,product,0).productId;
 const meta={entityId:null,expectedRevision:0,productRevision:1,actor:'Test reviewer',reason:'Synthetischer Beleg',action:'save'};
 const source=saveKnowledge(s,a,p,{...meta,kind:'source',content:{title:'Source',locator:'Synthetic document',capturedAt:'2026-09-01T00:00:00.000Z',text:'CSV export is available.',withdrawn:false}});
 const content={category:'feature',text:'CSV export is available.',sourceId:source.id,quote:'CSV export is available.'};
 const draft=saveKnowledge(s,a,p,{...meta,kind:'claim',content}),fact=saveKnowledge(s,a,p,{...meta,kind:'claim',content,entityId:draft.entityId,expectedRevision:1,action:'approve'});
 function input(kind='persona',content:any=persona,entityId:string|null=null,action='save'){
  const state=strategyState(s,a,p),old=state.items.find(r=>r.entityId===entityId);return {entityId,expectedRevision:old?.revision||0,productRevision:state.productRevision,kind,action,content,actor:'Test reviewer',reason:'Reviewed synthetic strategy'};
 }
 const save=(v=input())=>saveStrategy(s,a,p,v);
 function review(entityId:string,action='approve'){const r=strategyState(s,a,p).items.find(r=>r.entityId===entityId)!;return save(input(r.kind,r.content,entityId,action));}
 const hyp=(personaId:string)=>({name:'IT CSV angle',personaId,segment:'Manufacturers',pain:'Manual transfers',angle:'Verifiable CSV workflow',benefit:'Test whether traceability is relevant',cta:'Compare current workflow',style:'Direct and factual; no invented ROI',knowledgeIds:[fact.id]});
 function setup(){const pd=save(),pa=review(pd.entityId),hd=save(input('hypothesis',hyp(pa.id))),ha=review(hd.entityId);return {pd,pa,hd,ha};}
 return {get s(){return s;},a,b,p,q,dir,file,backups,source,fact,input,save,review,hyp,setup,state:()=>strategyState(s,a,p),reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('strict strategy inputs reject extra fields, bad codes, duplicate normalized titles and oversized facts',()=>{
 for(const patch of [{code:'it'},{titles:[]},{titles:['IT Director','  IT   DIRECTOR ']},{titles:Array.from({length:31},(_,i)=>'Title '+i)},{responsibility:' '},{name:'x\0'},{extra:true}])assert.throws(()=>personaContent({...persona,...patch}));
 const f=fixture();try{for(const patch of [{personaId:'bad'},{knowledgeIds:[]},{knowledgeIds:[f.fact.id,f.fact.id]},{knowledgeIds:Array.from({length:21},()=>randomUUID())},{angle:' '},{approved:true}])assert.throws(()=>hypothesisContent({...f.hyp(randomUUID()),...patch}));}finally{f.close();}
});
test('title preview preserves uncertainty and does not guess similar roles',()=>{
 const p={id:'a',content:persona};assert.equal(matchPersonaTitle(' HEAD   OF IT ',[p]).status,'matched');assert.equal(matchPersonaTitle('Ｈｅａｄ of IT',[p]).status,'matched');
 assert.equal(matchPersonaTitle('Head of IT security',[p]).status,'unknown');assert.equal(matchPersonaTitle('IT Director',[p,{id:'b',content:{...persona,code:'OTHER'}}]).status,'ambiguous');
 assert.throws(()=>matchPersonaTitle(' ',[p]));
});
test('persona and hypothesis have separate unchanged approvals and immutable history',()=>{
 const f=fixture();try{
  const before=f.s.exportBackup().data,pd=f.save();assert.equal(f.state().items[0].usable,false);
  assert.throws(()=>f.save({...f.input('persona',{...persona,name:'changed'},pd.entityId,'approve')}));
  const pa=f.review(pd.entityId);assert.equal(f.state().items[0].usable,true);
  const hd=f.save(f.input('hypothesis',f.hyp(pa.id)));assert.equal(f.state().items.find(r=>r.entityId===hd.entityId)!.state,'draft');
  f.review(hd.entityId);assert.equal(f.state().items.filter(r=>r.usable).length,2);assert.equal(f.state().rows.length,4);
  assert.throws(()=>f.s.db.prepare('UPDATE strategy_versions SET reason=? WHERE id=?').run('changed',pa.id));
  const after=f.s.exportBackup().data;for(const k of ['campaigns','campaignHistory','queueRuns','queueItems','mailTests','leads','aiRuns','knowledge','events'] as const)assert.deepEqual(after[k],before[k],k);
  f.reopen();assert.equal(f.state().rows.length,4);
 }finally{f.close();}
});
test('foreign products, unknown dependencies, drafts and strategic claims cannot authorize hypotheses',()=>{
 const f=fixture();try{
  const pd=f.save();assert.throws(()=>f.save(f.input('hypothesis',f.hyp(pd.id))));const pa=f.review(pd.entityId);
  for(const content of [{...f.hyp(pa.id),personaId:randomUUID()},{...f.hyp(pa.id),knowledgeIds:[f.source.id]},{...f.hyp(pa.id),knowledgeIds:[randomUUID()]}])assert.throws(()=>f.save(f.input('hypothesis',content)));
  assert.throws(()=>saveStrategy(f.s,f.a,f.q,f.input('hypothesis',f.hyp(pa.id))));assert.throws(()=>saveStrategy(f.s,f.b,f.p,f.input()),(e:any)=>e.status===404);
  assert.throws(()=>exportProductStrategy(f.s,f.b,f.p),(e:any)=>e.status===404);
  const source=knowledgeState(f.s,f.a,f.p).items.find(r=>r.id===f.source.id)!;
  const c={category:'hypothesis',text:'Assumption',sourceId:source.id,quote:source.content.text},base={entityId:null,expectedRevision:0,productRevision:1,kind:'claim',action:'save',content:c,actor:'Test',reason:'Test'};
  const draft=saveKnowledge(f.s,f.a,f.p,base),approved=saveKnowledge(f.s,f.a,f.p,{...base,entityId:draft.entityId,expectedRevision:1,action:'approve'});
  assert.throws(()=>f.save(f.input('hypothesis',{...f.hyp(pa.id),knowledgeIds:[approved.id]})));
 }finally{f.close();}
});
test('persona codes remain unique and stable; stale submits and changed approval content fail atomically',()=>{
 const f=fixture();try{
  const original=f.input(),pd=f.save(original),stale=f.input('persona',persona,pd.entityId);f.review(pd.entityId);
  const before=f.s.exportBackup().data;
  assert.throws(()=>f.save(original),/Code/);assert.throws(()=>f.save(stale),(e:any)=>e.status===409);
  assert.throws(()=>f.save(f.input('persona',{...persona,code:'NEW_CODE'},pd.entityId)),/unverändert/);
  assert.deepEqual(f.s.exportBackup().data,before);
  f.s.db.exec("CREATE TRIGGER synthetic_strategy_failure BEFORE INSERT ON strategy_versions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  assert.throws(()=>f.save(f.input('persona',{...persona,code:'OTHER'})),AppError);assert.deepEqual(f.s.exportBackup().data,before);
 }finally{f.close();}
});
test('persona revision, source revision, fact withdrawal and product revision invalidate dependent hypotheses',()=>{
 for(const mode of ['persona','source','fact','product']){const f=fixture();try{
  const {pd,hd}=f.setup();
  if(mode==='persona')f.save(f.input('persona',{...persona,name:'Changed'},pd.entityId));
  if(mode==='product')saveProduct(f.s,f.a,f.p,{...product,name:'Changed'},1);
  if(mode==='source'||mode==='fact'){
   const state=knowledgeState(f.s,f.a,f.p),row=state.items.find(r=>r.id===(mode==='source'?f.source.id:f.fact.id))!;
   saveKnowledge(f.s,f.a,f.p,{entityId:row.entityId,expectedRevision:row.revision,productRevision:1,kind:row.kind,action:mode==='fact'?'withdraw':'save',content:mode==='source'?{...row.content,title:'Changed'}:row.content,actor:'Test',reason:'Changed'});
  }
  assert.equal(f.state().items.find(r=>r.entityId===hd.entityId)!.usable,false,mode);assert.equal(f.state().rows.filter(r=>r.kind==='hypothesis').length,2);
  f.review(hd.entityId,'withdraw');validateBackup(f.s.exportBackup());
 }finally{f.close();}}
});
test('archive and pause prohibit new strategies, but withdrawals remain possible',()=>{
 for(const mode of ['archive','pause']){const f=fixture();try{
  const {pd,hd}=f.setup();if(mode==='archive')saveProduct(f.s,f.a,f.p,{...product,archived:true},1);else f.s.pauseClient(f.a,true,1);
  assert.throws(()=>f.save(f.input('persona',{...persona,code:'OTHER'})),/archiviert|pausiert/);f.review(pd.entityId,'withdraw');f.review(hd.entityId,'withdraw');validateBackup(f.s.exportBackup());
 }finally{f.close();}}
});
test('backups preserve withdrawals across older restores and include checkpoints and isolated restart',()=>{
 const f=fixture();try{
  const {pd}=f.setup(),old=f.s.exportBackup();f.review(pd.entityId,'withdraw');const known=exportStrategy(f.s);f.s.restore(old);
  assert.deepEqual(exportStrategy(f.s),known);assert.equal(f.state().items.some(r=>r.kind==='hypothesis'&&r.usable),false);
  const backup=f.s.exportBackup();assert.equal(rehearseRestore(backup).counts.strategies,5);
  const checkpoint=saveCheckpoint(join(f.dir,'checkpoint'),f.dir),saved=validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8')));assert.deepEqual(saved.data.strategies,JSON.parse(JSON.stringify(known)));
  assert.equal(exportProductStrategy(f.s,f.a,f.p).rows.length,5);
 }finally{f.close();}
});
test('backup validation rejects forged strategy history, wrong dependencies, missing arrays and downgrades',()=>{
 const f=fixture();try{
  const {pa}=f.setup();const original=f.s.exportBackup();
  for(const change of [(b:any)=>delete b.data.strategies,(b:any)=>{b.data.strategies=b.data.strategies.filter((r:any)=>r.id!==pa.id);},(b:any)=>{b.version=14;},(b:any)=>{b.data.strategies[0].clientId=f.b;},(b:any)=>{b.data.strategies[0].previousId=randomUUID();},(b:any)=>{const r=b.data.strategies.find((r:any)=>r.kind==='hypothesis');r.content=JSON.stringify({...JSON.parse(r.content),personaId:randomUUID()});},(b:any)=>{b.data.strategies.find((r:any)=>r.state==='draft').state='approved';}]){
   const b=structuredClone(original);change(b);assert.throws(()=>validateBackup(resign(b)),/Strategie/);
  }
  const changed=structuredClone(original);changed.data.strategies![0].reason='Changed known reason';assert.throws(()=>f.s.restore(resign(changed)),/bekannter Strategiehistorie/);assert.deepEqual(f.s.exportBackup().data,original.data);
 }finally{f.close();}
});
test('revision cap rejects overflow and retains the complete strategy history',()=>{
 const f=fixture();try{const first=f.save();for(let i=1;i<100;i++)f.save(f.input('persona',persona,first.entityId));assert.throws(()=>f.save(f.input('persona',persona,first.entityId)),/Strategie/);assert.equal(f.state().rows.length,100);validateBackup(f.s.exportBackup());}finally{f.close();}
});
test('schema14 upgrade saves product knowledge before introducing an empty strategy catalog',()=>{
 const f=fixture();try{
  const before=f.s.exportBackup().data.knowledge;f.s.db.exec('DROP TABLE experiment_versions; DROP TABLE strategy_versions; PRAGMA user_version=14');f.reopen();assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.state().rows.length,0);
  const file=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,backup=validateBackup(JSON.parse(readFileSync(join(f.backups,file),'utf8')));assert.equal(backup.version,14);assert.equal(backup.data.strategies,undefined);assert.deepEqual(backup.data.knowledge,JSON.parse(JSON.stringify(before)));
 }finally{f.close();}
});
test('strategy API enforces authentication, origin, ownership and optimistic versions',async()=>{
 const f=fixture(),token='s'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/products/${f.p}/strategy`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 try{
  assert.equal((await fetch(server.url+path)).status,401);assert.equal((await fetch(server.url+path,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify(f.input())})).status,403);
  const first=await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(f.input())});assert.equal(first.status,200);const r=await first.json(),update=f.input('persona',persona,r.entityId);
  assert.equal((await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(update)})).status,200);assert.equal((await fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(update)})).status,409);
  assert.equal((await fetch(server.url+path.replace(f.a,f.b),{headers})).status,404);assert.equal((await(await fetch(server.url+path+'-export',{headers})).json()).rows.length,2);
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../core/store';
import {saveModelProfile} from '../core/model-profiles';
import {quoteModelCost,normalizeModelUsage} from '../core/model-usage';
import {setModelBudget,reserveModelBudget,settleModelBudget,modelSpending,markModelStarted,reconcileModelBudget} from '../core/model-budget';
import {publicRecord} from '../core/public-schema';
import {previewContactDeletion,applyContactDeletion} from '../core/data-retention';
const prices={version:'price-1',provider:'openai' as const,protocol:'openai-responses' as const,model:'test',currency:'USD' as const,inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cachedInputMicrosPerMillion:500000,reasoningMicrosPerMillion:null,source:'https://example.test/prices',checkedAt:'2026-10-20T10:00:00Z'};
test('manual provider billing reconciliation is explicit, versioned and survives old backup restore',()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-')),s=new Store(join(dir,'db'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'A',email:'',website:'',notes:''});
  const p=saveModelProfile(s,{name:'Test',provider:'openai',protocol:'openai-responses',model:'test',origin:'https://api.openai.com',basePath:'/v1',credentialRef:null,maxOutputTokens:30});
  setModelBudget(s,{currency:'USD',perRun:100,perDay:100,perMonth:100});const id=randomUUID(),quote=quoteModelCost(p.binding,{inputUpperBound:30,outputUpperBound:30},prices);
  reserveModelBudget(s,id,c.id,quote);
  const input={runId:id,revision:1,currency:'USD',micros:20,note:'Checked provider billing for this request',confirmed:true};
  assert.throws(()=>reconcileModelBudget(s,input),/ungeklärt/i);
  markModelStarted(s,id);settleModelBudget(s,id,{state:'unknown',usage:null});const old=s.exportBackup();
  input.revision=publicRecord(s,'model-run',id)!.revision;
  for(const changes of [{confirmed:false},{currency:'EUR'},{micros:-1},{micros:0.1},{note:''},{revision:1},{extra:true}])assert.throws(()=>reconcileModelBudget(s,{...input,...changes}));
  assert.equal(modelSpending(s,'USD').held,60);
  reconcileModelBudget(s,input);assert.equal(modelSpending(s,'USD').held,0);assert.equal(modelSpending(s,'USD').spent,20);
  assert.throws(()=>reconcileModelBudget(s,input));
  s.restore(old);assert.equal(modelSpending(s,'USD').spent,20);assert.equal(modelSpending(s,'USD').held,0);
  assert.equal(publicRecord(s,'model-run',id)!.content.reconciliation.note,input.note);
  const fresh=new Store(join(dir,'fresh'),join(dir,'fresh-backups'),false);try{fresh.restore(s.exportBackup());assert.equal(modelSpending(fresh,'USD').spent,20);}finally{fresh.close();}
  const zero=randomUUID();reserveModelBudget(s,zero,c.id,quote);settleModelBudget(s,zero,{state:'unknown',usage:null});
  reconcileModelBudget(s,{...input,runId:zero,revision:publicRecord(s,'model-run',zero)!.revision,micros:0});assert.equal(modelSpending(s,'USD').held,0);
  const csv={csv:'email\nprivate@example.com',delimiter:';',filename:'synthetic.csv',mapping:{email:0,firstName:-1,lastName:-1,company:-1,role:-1}};
  s.pauseClient(c.id,false,s.client(c.id).version);s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});const beforeDeletion=s.exportBackup();
  applyContactDeletion(s,previewContactDeletion(s,c.id,s.campaignLeads(c.id)[0].id,'customer').hash);
  assert.ok(!JSON.stringify(s.exportBackup()).includes(input.note),'customer deletion removes free-text billing notes');
  assert.equal(modelSpending(s,'USD').spent,20);assert.throws(()=>s.restore(beforeDeletion),/gelöscht/i);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('two clients cannot reserve the same budget, restart and restore never forget uncertain cost',()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-')),file=join(dir,'data.sqlite');let s=new Store(file,join(dir,'backups'),false);
 try{
  const a=s.createClient({name:'A',email:'',website:'',notes:''}),b=s.createClient({name:'B',email:'',website:'',notes:''});
  const profile=saveModelProfile(s,{name:'Test',provider:'openai',protocol:'openai-responses',model:'test',origin:'https://api.openai.com',basePath:'/v1',credentialRef:null,maxOutputTokens:30});
  setModelBudget(s,{currency:'USD',perRun:100,perDay:100,perMonth:100});
  const old=s.exportBackup(),quote=quoteModelCost(profile.binding,{inputUpperBound:30,outputUpperBound:30},prices),id=randomUUID();
  assert.equal(quote.maximum?.micros,60);reserveModelBudget(s,id,a.id,quote);
  assert.throws(()=>reserveModelBudget(s,randomUUID(),b.id,quote),/Budget/i);
  markModelStarted(s,id);s.close();s=new Store(file,join(dir,'backups'),false);
  assert.equal(modelSpending(s,'USD').held,60);
  s.restore(old);assert.equal(modelSpending(s,'USD').held,60);
  const r=settleModelBudget(s,id,{state:'completed',usage:normalizeModelUsage('openai-responses',{input_tokens:10,output_tokens:10,input_tokens_details:{cached_tokens:0}})});
  assert.equal(r.charged?.micros,20);assert.deepEqual(settleModelBudget(s,id,{state:'completed',usage:null}),r);
  assert.equal(modelSpending(s,'USD').spent,20);assert.equal(modelSpending(s,'USD').held,0);
  const unknown=quoteModelCost(profile.binding,{inputUpperBound:null,outputUpperBound:30},prices);
  assert.equal(unknown.status,'unknown');assert.throws(()=>reserveModelBudget(s,randomUUID(),b.id,unknown),/Preis|Obergrenze/);
  assert.equal(quoteModelCost(profile.binding,{inputUpperBound:30,outputUpperBound:30},null).maximum,null);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

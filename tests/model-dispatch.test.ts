import {saveCapability} from '../core/model-capabilities';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../core/store';
import {saveModelProfile} from '../core/model-profiles';
import {setModelRoute,MODEL_TASKS} from '../core/model-routing';
import {setModelBudget,modelSpending} from '../core/model-budget';
import {configureModelPrice,bindModelRun,authorizeModelDispatch,finishModelDispatch,modelSetup} from '../core/model-jobs';
test('six tasks use reserved immutable destination and dispatch is single use',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dispatch-'));const s=new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);s.publicMode=true;
 try{
  const c=s.createClient({name:'Test',email:'',website:'',notes:''});
  const p=saveModelProfile(s,{name:'One',provider:'openai',protocol:'openai-responses',model:'test',origin:'https://api.openai.com',basePath:'/v1',credentialRef:null,maxOutputTokens:4096});
  saveCapability(s,p.binding,{text:'ok',structured:'{"ok":true}'});
  configureModelPrice(s,p.id,{prices:{version:'p1',provider:'openai',protocol:'openai-responses',model:'test',currency:'USD',inputMicrosPerMillion:1,outputMicrosPerMillion:1,cachedInputMicrosPerMillion:0,reasoningMicrosPerMillion:null,source:'https://example.test/prices',checkedAt:new Date().toISOString()},inputUpperBound:100000,inputBoundSource:'https://example.test/model-context'});
  setModelBudget(s,{currency:'USD',perRun:100,perDay:1000,perMonth:10000});
  for(const task of MODEL_TASKS){
   setModelRoute(s,c.id,task,p.binding.profile);
   const run={id:randomUUID(),clientId:c.id,purpose:task,provider:'openai',model:'test',context:'Public data',prompt:{system:'Only text',user:'Public data'}};
   const stamp=new Date().toISOString();
   s.db.prepare('INSERT INTO ai_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(run.id,c.id,task,'openai','test',0,c.version,'running','{}','','{}',stamp,'unreviewed');
   const mail=task.startsWith('reply-')?{connectionId:randomUUID(),sourceHashes:['b'.repeat(64)],promptVersion:'v1'}:undefined;
   const bound=s.transaction(()=>bindModelRun(s,c.id,run,p.binding.hash,mail));
   const permit=authorizeModelDispatch(s,c.id,run.id,p.binding.hash);
   assert.equal(permit.binding.hash,p.binding.hash);assert.equal(bound.binding.hash,p.binding.hash);
   assert.throws(()=>authorizeModelDispatch(s,c.id,run.id,p.binding.hash),/bereits|aktiv|Status/);
   finishModelDispatch(s,c.id,run.id,{state:'unknown',usage:null});
  }
  assert.ok(modelSpending(s,'USD').held>0);
  const old=modelSetup(s,c.id,'analysis');
  saveModelProfile(s,{...p.binding,id:p.id,expectedRevision:p.revision,name:'Changed',model:'new-test'});
  assert.equal(old.binding.model,'test');assert.throws(()=>modelSetup(s,c.id,'analysis'),/geändert/);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

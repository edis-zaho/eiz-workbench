import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
import {saveModelProfile,modelProfiles} from '../core/model-profiles';
import {resolveModelRoute,setModelRoute,MODEL_TASKS} from '../core/model-routing';
const client={name:'Example',website:'',email:'person@example.test',notes:''};
export function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'model-routing-'));
  const store=new Store(join(dir,'data.sqlite'),join(dir,'backups'),false);
  return {store,id:store.createClient(client).id,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('legacy analysis and writing routes preserve all six assignments',()=>{
  const f=fixture();try{
    const b=f.store.brief(f.id);
    f.store.saveRules(f.id,{...b.content,revision:b.revision,routes:{analysis:{provider:'gemini',model:'analysis-test'},writing:{provider:'openai',model:'writing-test'}}});
    for(const task of MODEL_TASKS){
      const binding=resolveModelRoute(f.store,f.id,task);
      assert.equal(binding.model,['analysis','knowledge','reply-analysis'].includes(task)?'analysis-test':'writing-test');
    }
    assert.equal(modelProfiles(f.store).length,2);
  }finally{f.close();}
});
test('profile revision invalidates a selected route without rewriting a reserved snapshot',()=>{
  const f=fixture();try{
    const p=saveModelProfile(f.store,{name:'Custom',provider:'custom',protocol:'openai-chat-completions',model:'org/model',origin:'https://models.example.test',basePath:'/v1',credentialRef:null,maxOutputTokens:4096});
    setModelRoute(f.store,f.id,'analysis',p.binding.profile);
    const snapshot=resolveModelRoute(f.store,f.id,'analysis');
    const updated=saveModelProfile(f.store,{...p.binding,id:p.id,expectedRevision:p.revision,name:p.name,model:'org/other'});
    assert.equal(snapshot.model,'org/model');
    assert.notEqual(updated.binding.hash,snapshot.hash);
    assert.throws(()=>resolveModelRoute(f.store,f.id,'analysis'),/changed|geändert/i);
    assert.throws(()=>saveModelProfile(f.store,{...p.binding,id:p.id,expectedRevision:p.revision,name:p.name}),/changed|geändert/i);
    setModelRoute(f.store,f.id,'analysis',updated.binding.profile);
    assert.equal(resolveModelRoute(f.store,f.id,'analysis').model,'org/other');
  }finally{f.close();}
});
test('invalid protocol origin or embedded credential cannot be saved',()=>{
  const f=fixture();try{
    const base={name:'Provider',provider:'openai',protocol:'openai-responses',model:'example',origin:'https://api.openai.com',basePath:'/v1',credentialRef:null,maxOutputTokens:4096};
    for(const bad of [{origin:'https://other.example.test'},{origin:'https://user:secret@api.openai.com'},{basePath:'/v1?key=secret'},{protocol:'anthropic-messages'},{maxOutputTokens:0}]){
      assert.throws(()=>saveModelProfile(f.store,{...base,...bad} as any));
    }
    assert.equal(modelProfiles(f.store).length,0);
  }finally{f.close();}
});

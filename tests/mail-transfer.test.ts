import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../core/store';
import {saveModelProfile} from '../core/model-profiles';
import {previewMailTransfer,grantMailTransfer,assertMailTransfer,revokeMailTransfer} from '../core/mail-transfer';
test('mail transfer is bound to context source mailbox purpose customer and destination, revocation survives restore',()=>{
 const dir=mkdtempSync(join(tmpdir(),'transfer-')),s=new Store(join(dir,'data.sqlite'),join(dir,'backups'),false);
 try{
  const client=s.createClient({name:'Test',email:'',website:'',notes:''});
  const p=saveModelProfile(s,{name:'OpenAI',provider:'openai',protocol:'openai-responses',model:'test',origin:'https://api.openai.com',basePath:'/v1',credentialRef:null,maxOutputTokens:4096});
  const input={clientId:client.id,connectionId:randomUUID(),purpose:'reply-analysis' as const,sourceHashes:['a'.repeat(64)],context:'A requested reply excerpt',promptVersion:'reply-analysis-v1',binding:p.binding};
  const preview=previewMailTransfer(input),id=grantMailTransfer(s,input,preview.hash);
  assertMailTransfer(s,id,input);
  for(const change of [{context:'different'},{sourceHashes:['b'.repeat(64)]},{connectionId:randomUUID()},{purpose:'reply-writing'},{clientId:randomUUID()},{binding:{...p.binding,model:'other'}}]){
   let fetches=0;assert.throws(()=>{assertMailTransfer(s,id,{...input,...change} as any);fetches++;});assert.equal(fetches,0);
  }
  const old=s.exportBackup();revokeMailTransfer(s,id);assert.throws(()=>assertMailTransfer(s,id,input));
  s.restore(old);assert.throws(()=>assertMailTransfer(s,id,input));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

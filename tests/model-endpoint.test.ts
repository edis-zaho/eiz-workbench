import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stableHash} from '../core/public-schema';
const require=createRequire(import.meta.url);
const {validateModelEndpoint}=require('../electron/model-endpoint.cjs');
const {createModelVault}=require('../electron/model-vault.cjs');
const fields={profile:{id:randomUUID(),revision:1},provider:'custom',protocol:'openai-chat-completions',model:'org/model',origin:'https://models.example.test',basePath:'/v1',credentialRef:randomUUID(),maxOutputTokens:4096};
const bind=(change={})=>{const f={...fields,...change};return {...f,hash:stableHash(f)};};
test('endpoint and secret cannot drift to another host or profile',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bound-vault-'));
 const safe={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from('CIPHER:'+Buffer.from(s).toString('base64')),decryptString:(b:Buffer)=>{if(!b.toString().startsWith('CIPHER:'))throw Error();return Buffer.from(b.toString().slice(7),'base64').toString();}};
 try{
  const vault=createModelVault(dir,safe),b=bind();vault.save(b,'synthetic-key');
  assert.equal(vault.key(b),'synthetic-key');
  assert.throws(()=>vault.key(bind({origin:'https://other.example.test'})),/Bindung|binding/i);
  assert.throws(()=>vault.key(bind({profile:{id:randomUUID(),revision:1}})),/Bindung|binding/i);
  assert.equal(validateModelEndpoint(b).url,'https://models.example.test/v1/chat/completions');
  for(const origin of ['http://remote.example.test','https://user:pass@example.test','https://models.example.test?q=x','https://models.example.test/other']){
   assert.throws(()=>validateModelEndpoint(bind({origin})));
  }
  assert.throws(()=>validateModelEndpoint(bind({provider:'openai',protocol:'openai-responses'})));
  const path=join(dir,'model-profiles.enc');assert.ok(!readFileSync(path,'utf8').includes('synthetic-key'));
  writeFileSync(path,'broken');assert.throws(()=>vault.save(b,'new'));assert.equal(readFileSync(path,'utf8'),'broken');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

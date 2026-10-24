import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
test('public allowlist rejects private state and preserves only runnable artifacts',async()=>{
 const {checkPublicPackage}=await import('../scripts/check-public-package.mjs');
 const dir=mkdtempSync(join(tmpdir(),'public-package-'));
 const write=(name:string,body='synthetic')=>{const f=join(dir,name);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,body);};
 try{
  write('package.json',JSON.stringify({main:'electron/main.cjs',workbenchChannel:'public'}));
  for(const name of ['backend/run.cjs','dist/index.html','electron/main.cjs','electron/preload.cjs'])write(name);
  assert.equal(checkPublicPackage(dir).passed,true);
  for(const name of ['.env','electron/google-mail.enc','backend/revenue.sqlite','backend/revenue.sqlite-wal','dist/mail-export.json','assets/customer.pdf','qa/report.json']){
   write(name);assert.equal(checkPublicPackage(dir).passed,false,name);rmSync(join(dir,name));
  }
  write('dist/assets/test.js','const address="private-owner@example.invalid"');assert.equal(checkPublicPackage(dir).passed,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

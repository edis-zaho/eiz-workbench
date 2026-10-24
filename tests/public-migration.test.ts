import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {saveModelProfile,modelProfiles} from '../core/model-profiles';
import {setModelRoute,resolveModelRoute} from '../core/model-routing';
test('schema33 upgrade and restore preserve data but never profile dispatch authority',()=>{
  const dir=mkdtempSync(join(tmpdir(),'public-upgrade-'));const file=join(dir,'data.sqlite');
  let s=new Store(file,join(dir,'backups'),false);
  try{
    const c=s.createClient({name:'Kept',website:'',email:'kept@example.test',notes:''});
    s.db.exec('DROP TABLE public_records; PRAGMA user_version=33;');
    s.close();s=new Store(file,join(dir,'backups'),false);
    assert.equal(s.snapshot().database.schema,34);
    assert.equal(s.client(c.id).name,'Kept');
    const p=saveModelProfile(s,{name:'Model',provider:'openai',protocol:'openai-responses',model:'model-test',origin:'https://api.openai.com',basePath:'/v1',credentialRef:'credential-reference',maxOutputTokens:4096});
    setModelRoute(s,c.id,'analysis',p.binding.profile);
    const b=s.exportBackup();assert.equal(b.version,34);
    s.restore(b);
    assert.equal(s.client(c.id).status,'paused');
    assert.equal(modelProfiles(s)[0].binding.credentialRef,null);
    assert.throws(()=>resolveModelRoute(s,c.id,'analysis'),/disabled|deaktiviert|changed|geändert|select|wählen/i);
    const malformed=s.exportBackup();(malformed.data.publicState as any).records[0].content.binding.hash='0'.repeat(64);
    malformed.checksum=createHash('sha256').update(JSON.stringify(malformed.data)).digest('hex');
    assert.throws(()=>validateBackup(malformed));
    const stripped=s.exportBackup();delete stripped.data.publicState;
    stripped.checksum=createHash('sha256').update(JSON.stringify(stripped.data)).digest('hex');
    assert.throws(()=>validateBackup(stripped));
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

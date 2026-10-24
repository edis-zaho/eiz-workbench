import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openProfileStore} from '../core/profile';
const {resolveProfileDirectory}=createRequire(import.meta.url)('../electron/profile.cjs');

test('public startup never opens or seeds the internal profile',()=>{
  const root=mkdtempSync(join(tmpdir(),'public-profile-'));
  const internal=resolveProfileDirectory({appData:root,channel:'internal'});
  const publicPath=resolveProfileDirectory({appData:root,channel:'public'});
  assert.notEqual(internal,publicPath);
  const old=openProfileStore(internal,'internal');
  old.createClient({name:'Private example',email:'private@example.test',website:'',notes:''});
  old.close();
  let store=openProfileStore(publicPath,'public');
  try {
    assert.equal(store.snapshot().clients.length,0);
    assert.equal(store.snapshot().jobs.length,0);
    const own=store.createClient({name:'Public example',email:'public@example.test',website:'',notes:''});
    store.close();store=openProfileStore(publicPath,'public');
    assert.deepEqual(store.snapshot().clients.map(c=>c.id),[own.id]);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('test path requires explicit test mode and unknown channels fail closed',()=>{
  const appData=join(tmpdir(),'profile-root');
  assert.throws(()=>resolveProfileDirectory({appData,channel:'public',testDirectory:appData}),/test/i);
  assert.throws(()=>resolveProfileDirectory({appData,channel:'other'}),/channel/i);
  assert.equal(resolveProfileDirectory({appData,channel:'public',testDirectory:appData,testMode:true}),appData);
});

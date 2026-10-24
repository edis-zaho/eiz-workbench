import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('portable backup authenticates bytes, password and bounded parameters',async()=>{
 const {encryptPortableBackup,decryptPortableBackup,encryptLocalBackup,decryptLocalBackup}=require('../electron/backup-crypto.cjs');
 const bytes=Buffer.from('private@example.test; private message');
 const cipher=await encryptPortableBackup(bytes,'long example passphrase');
 assert.ok(!cipher.includes(bytes));assert.deepEqual(await decryptPortableBackup(cipher,'long example passphrase'),bytes);
 await assert.rejects(decryptPortableBackup(cipher,'wrong passphrase'));
 const altered=JSON.parse(cipher.toString());altered.N=2**28;
 await assert.rejects(decryptPortableBackup(Buffer.from(JSON.stringify(altered)),'long example passphrase'));
 const changed=JSON.parse(cipher.toString());changed.tag=Buffer.alloc(16).toString('base64');
 await assert.rejects(decryptPortableBackup(Buffer.from(JSON.stringify(changed)),'long example passphrase'));
 const key=Buffer.alloc(32,7),local=encryptLocalBackup(bytes,key);
 assert.deepEqual(decryptLocalBackup(local,key),bytes);assert.throws(()=>decryptLocalBackup(local,Buffer.alloc(32,8)));
 await assert.rejects(encryptPortableBackup(bytes,'short'));
});

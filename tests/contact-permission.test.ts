import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
import {contactPermissionProblems,saveContactPermission} from '../core/contact-permission';
test('unknown reason blocks and source/contact change invalidates reviewed permission',()=>{
 const dir=mkdtempSync(join(tmpdir(),'permission-')),s=new Store(join(dir,'db'),join(dir,'backups'),false);
 try{
  const c=s.createClient({name:'Synthetic',email:'',website:'',notes:''}),csv={csv:'email\nperson@example.com',delimiter:';',filename:'test.csv',mapping:{email:0,firstName:-1,lastName:-1,company:-1,role:-1}};
  s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});const l=s.campaignLeads(c.id)[0];
  assert.ok(contactPermissionProblems(s,c.id,l.id).length);
  saveContactPermission(s,c.id,l.id,{source:'Own test recipient',reason:'Recipient asked for this test',status:'reviewed',expectedRevision:0});
  assert.deepEqual(contactPermissionProblems(s,c.id,l.id),[]);
  s.blockLead(c.id,l.id,true,'Do not contact');assert.ok(contactPermissionProblems(s,c.id,l.id).length);
  s.blockLead(c.id,l.id,false,'');assert.ok(contactPermissionProblems(s,c.id,l.id).length,'lifting a block requires a new review');
  saveContactPermission(s,c.id,l.id,{source:'Own test recipient',reason:'Renewed explicit request',status:'reviewed',expectedRevision:1});
  s.db.prepare('UPDATE leads SET company=? WHERE id=?').run('Changed',l.id);assert.ok(contactPermissionProblems(s,c.id,l.id).length);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

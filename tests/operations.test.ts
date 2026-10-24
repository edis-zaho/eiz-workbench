import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
import {blockCompany,companyStop,companyDomain,reviewQueue,reviewIncoming} from '../core/operations';
import {recordConversation} from '../core/inbox';
test('Unternehmenssperre gilt für neue Adressen nur beim richtigen Kunden und überlebt alte Sicherung',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-company-')),s=new Store(join(dir,'db'),join(dir,'backup'),false);
 try{
  const c=s.createClient({name:'A',website:'',email:'',notes:''}),other=s.createClient({name:'B',website:'',email:'',notes:''}),old=s.exportBackup();
  assert.equal(companyDomain(' BÜCHER.de '),'xn--bcher-kva.de');assert.throws(()=>companyDomain('https://firma.de'));assert.throws(()=>companyDomain('a@firma.de'));
  assert.throws(()=>blockCompany(s,c.id,{domain:'firma.de',reason:'Stop',confirmed:false,clientVersion:c.version}));
  blockCompany(s,c.id,{domain:'firma.de',reason:'Kundenwunsch',confirmed:true,clientVersion:c.version});
  assert.ok(companyStop(s,c.id,'new@firma.de'));assert.equal(companyStop(s,other.id,'new@firma.de'),undefined);assert.equal(companyStop(s,c.id,'a@andere-firma.de'),undefined);
  const input={id:randomUUID(),mailboxId:randomUUID(),clientVersion:c.version,sender:'me@example.com',recipient:'new@firma.de',subject:'Test',body:'Test'};
  assert.throws(()=>s.reserveMailTest(c.id,input),/Unternehmensdomain/);
  s.restore(old);assert.ok(companyStop(s,c.id,'other@firma.de'));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('Klärungen sind versioniert, kundengebunden und heben keinen Eingangsstopp auf',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-review-'));let s=new Store(join(dir,'db'),join(dir,'backup'),false);
 try{
  const c=s.createClient({name:'A',website:'',email:'',notes:''}),other=s.createClient({name:'B',website:'',email:'',notes:''});
  const input={id:randomUUID(),mailboxId:randomUUID(),clientVersion:c.version,sender:'me@example.com',recipient:'you@firma.de',subject:'Test',body:'Test'};
  const m=s.reserveMailTest(c.id,input);s.finishMailTest(c.id,m.id,'sent','sent1','OK');
  recordConversation(s,c.id,m.id,{mailboxId:m.mailboxId,clientVersion:c.version,rows:[{providerId:'reply1',threadId:'thread1',sender:'you@firma.de',subject:'Re',excerpt:'Ja',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}]});
  const row=reviewQueue(s)[0];assert.equal(row.review.status,'open');
  const decision={revision:null,status:'done',category:'positive',note:'Gespräch geprüft, Termin noch offen'};
  assert.throws(()=>reviewIncoming(s,other.id,String(row.id),decision));reviewIncoming(s,c.id,String(row.id),decision);
  assert.throws(()=>reviewIncoming(s,c.id,String(row.id),decision),/Klärungsstand geändert/);
  assert.throws(()=>s.reserveMailTest(c.id,{...input,id:randomUUID()}),/angehalten/);
  const backup=s.exportBackup();s.restore(backup);s.close();s=new Store(join(dir,'db'),join(dir,'backup'),false);
  const restored=reviewQueue(s)[0];assert.equal(restored.review.status,'done');assert.equal(restored.review.category,'positive');assert.equal(restored.review.note,decision.note);
  reviewIncoming(s,c.id,String(row.id),{...decision,revision:restored.review.revision,status:'open'});assert.equal(reviewQueue(s)[0].review.status,'open');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

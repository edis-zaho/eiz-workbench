import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {buildMailPresentation,saveSenderProfile,mailPresentation,freezeMailPresentation,assertMailPresentation} from '../core/mail-presentation';
import {openProfileStore} from '../core/profile';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {encodeMime}=createRequire(import.meta.url)('../electron/mail-mime.cjs');
const identity={providerKind:'gmail',connectionId:randomUUID(),email:'sender@example.test',checkedAt:'2026-10-20T10:00:00Z'};
const profile={clientId:randomUUID(),connectionId:identity.connectionId,revision:1,displayName:'Jörg Beispiel',signatureText:'Jörg\u00a0Beispiel — Vertrieb\nhttps://example.test'};
const content={to:'target@example.test',subject:'Grüße',bodyText:'Hallo!\nText <kein HTML>',inReplyTo:'<prior@example.test>',references:['<prior@example.test>']};
test('UTF8 presentation and exact text and HTML survive MIME, signature once and named From',()=>{
 const p=buildMailPresentation(content,profile,identity),raw=Buffer.from(encodeMime(p,`<${randomUUID()}@workbench.local>`),'base64url').toString();
 assert.ok(raw.includes(Buffer.from(p.text.replace(/\r?\n/g,'\r\n')).toString('base64').slice(0,76)));
 const parts=raw.split('Content-Transfer-Encoding: base64\r\n\r\n').slice(1).map(s=>Buffer.from(s.split('\r\n--')[0].replace(/\r\n/g,''),'base64').toString());
 assert.equal(parts[0],p.text.replace(/\r?\n/g,'\r\n'));assert.equal(parts[1],p.html);
 assert.equal(p.text.split(profile.signatureText).length,2);
 assert.ok(raw.includes('From: =?UTF-8?B?'));assert.ok(raw.includes('In-Reply-To: <prior@example.test>'));
 assert.ok(p.html.includes('&lt;kein HTML&gt;'));assert.ok(p.html.includes('href="https://example.test"'));
 for(const bad of [{...profile,displayName:'Bad\r\nBcc:x@example.test'}]){
  assert.throws(()=>buildMailPresentation(content,bad,identity));
 }
 assert.throws(()=>buildMailPresentation({...content,subject:'Hi\r\nBcc:x'},profile,identity));
 assert.throws(()=>encodeMime({...p,text:'changed'},`<${randomUUID()}@workbench.local>`));
});
test('signature changes invalidate pending presentations and preserve their immutable snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mail-presentation-')),s=openProfileStore(dir,'public');
 try{
  const c=s.createClient({name:'Public',email:'',website:'',notes:''});
  assert.throws(()=>mailPresentation(s,c.id,content,identity.connectionId,identity.email));
  saveSenderProfile(s,{...profile,clientId:c.id},identity);
  const p=mailPresentation(s,c.id,content,identity.connectionId,identity.email)!;
  const mail={id:randomUUID(),clientId:c.id,mailboxId:identity.connectionId,sender:identity.email,recipient:content.to,subject:content.subject,body:content.bodyText,inReplyTo:content.inReplyTo};
  freezeMailPresentation(s,mail,p);assertMailPresentation(s,c.id,mail.id);
  saveSenderProfile(s,{...profile,clientId:c.id,signatureText:'Neue Signatur'},identity);
  assert.throws(()=>assertMailPresentation(s,c.id,mail.id),/geändert/);
  const saved=s.exportBackup().data.publicState!.records.find(r=>r.kind==='presentation')!.content;
  assert.deepEqual(saved,p);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('public test send requires exact reviewed presentation and returns frozen MIME source',()=>{
 const dir=mkdtempSync(join(tmpdir(),'public-send-')),s=openProfileStore(dir,'public');
 try{
  const c=s.createClient({name:'Public',email:'',website:'',notes:''});
  saveSenderProfile(s,{...profile,clientId:c.id},identity);
  const d={id:randomUUID(),clientVersion:c.version,mailboxId:identity.connectionId,sender:identity.email,recipient:content.to,subject:content.subject,body:content.bodyText};
  assert.throws(()=>s.reserveMailTest(c.id,d),/vorschau/);
  const p=mailPresentation(s,c.id,{to:d.recipient,subject:d.subject,bodyText:d.body})!;
  const sent=s.reserveMailTest(c.id,{...d,presentationHash:p.hash});
  assert.deepEqual(sent.presentation,p);
  assertMailPresentation(s,c.id,sent.id);
  s.db.prepare('UPDATE mail_tests SET body=? WHERE id=?').run('Different',sent.id);
  assert.throws(()=>assertMailPresentation(s,c.id,sent.id),/geändert/);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

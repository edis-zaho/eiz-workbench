import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core/store';
import {recordDeliveryScan} from '../core/inbox';
const {scanDeliveries}=createRequire(import.meta.url)('../electron/delivery-scan.cjs');
const mailbox={id:randomUUID(),email:'sender@example.com',accessToken:'secret',scopes:['https://www.googleapis.com/auth/gmail.readonly']};
const mail={id:randomUUID(),mailboxId:mailbox.id,sender:mailbox.email,recipient:'lead@example.org',messageId:'<test@workbench.local>',status:'sent',createdAt:'2026-01-01T00:00:00Z'};
const metadata={id:'bounce2',threadId:'independent-thread',labelIds:['INBOX'],internalDate:String(Date.parse('2026-02-01')),payload:{headers:[{name:'Content-Type',value:'multipart/report; report-type=delivery-status'},{name:'From',value:'mailer-daemon@example.org'}]}};
const full={...metadata,payload:{mimeType:'multipart/report',parts:[{mimeType:'message/delivery-status',body:{data:Buffer.from('Reporting-MTA: dns; example.org\r\n\r\nFinal-Recipient: rfc822; lead@example.org\r\nAction: failed\r\nStatus: 5.1.1').toString('base64url')}},{mimeType:'text/rfc822-headers',body:{data:Buffer.from('Message-ID: '+mail.messageId).toString('base64url')}}]}};
test('Separate Rückläufer werden außerhalb des Quellgesprächs zugeordnet; Seitenlimit bleibt sichtbar',async()=>{
 const urls:string[]=[];const result=await scanDeliveries([mail],mailbox,async(url:string)=>{urls.push(url);return url.includes('?maxResults=')?{messages:[{id:'bounce2'}],nextPageToken:'more'}:url.endsWith('format=full')?full:metadata;});
 assert.equal(result.matches.length,1);assert.equal(result.matches[0].mailId,mail.id);assert.equal(result.matches[0].row.threadId,'independent-thread');assert.equal(result.truncated,true);assert.equal(result.checked,1);assert.equal(urls.length,3);
 const unmatched=await scanDeliveries([{...mail,messageId:'<other>'}],mailbox,async(url:string)=>url.includes('?maxResults=')?{messages:[{id:'bounce2'}]}:url.endsWith('format=full')?full:metadata);assert.equal(unmatched.matches.length,0);assert.equal(unmatched.unmatched,1);
 await assert.rejects(()=>scanDeliveries([mail],{...mailbox,id:randomUUID()},async()=>{}),/passen nicht/);
 await assert.rejects(()=>scanDeliveries([mail],{...mailbox,scopes:[]},async()=>{}),/Zugriff fehlt/);
});
test('Andere Nachrichten werden nicht vollständig gelesen; Netzwerkfehler sind keine leere Erfolgsmeldung',async()=>{
 let calls=0;const r=await scanDeliveries([mail],mailbox,async(url:string)=>{calls++;if(url.includes('?maxResults='))return {messages:[{id:'bounce2'}]};assert.ok(url.endsWith('metadata'));return {...metadata,payload:{headers:[]}};});assert.equal(r.skipped,1);assert.equal(calls,2);
 await assert.rejects(()=>scanDeliveries([mail],mailbox,async()=>{throw Error('offline');}),/offline/);
});
test('Separater Zustellbericht stoppt Kontakt, dedupliziert und überlebt eine ältere Sicherung',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-delivery-store-')),s=new Store(join(dir,'db'),join(dir,'backup'),false);
 try{
  const c=s.createClient({name:'A',website:'',email:'',notes:''}),other=s.createClient({name:'B',website:'',email:'',notes:''});
  const input={id:randomUUID(),mailboxId:mailbox.id,sender:mailbox.email,recipient:mail.recipient,subject:'Test',body:'Test',clientVersion:c.version};
  const original=s.reserveMailTest(c.id,input);s.finishMailTest(c.id,original.id,'sent','sent1','OK');const backup=s.exportBackup();
  const row={providerId:'bounce2',threadId:'independent-thread',sender:'mailer-daemon@example.org',subject:'Failed',excerpt:'',receivedAt:new Date().toISOString(),kind:'automatic',evidence:JSON.stringify({delivery:{type:'failed',action:'failed',status:'5.1.1',recipient:mail.recipient,messageId:original.messageId}})};
  const scan={clientVersion:c.version,mailboxId:mailbox.id,checked:1,unmatched:0,skipped:0,truncated:false,query:'test',matches:[{mailId:original.id,row}]};
  assert.throws(()=>recordDeliveryScan(s,other.id,scan));assert.equal(recordDeliveryScan(s,c.id,scan).added,1);assert.equal(recordDeliveryScan(s,c.id,scan).added,0);
  assert.throws(()=>s.reserveMailTest(c.id,{...input,id:randomUUID()}),/angehalten/);s.restore(backup);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM incoming').get()?.n,1);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

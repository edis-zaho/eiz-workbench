import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../core/store';
import {recordDeliveryScan} from '../core/inbox';
import {configureDeliveryAuto,deliveryAuto,dueDeliveryAuto} from '../core/delivery-auto';
const {scanDeliveries}=createRequire(import.meta.url)('../electron/delivery-scan.cjs');
const mailbox={id:randomUUID(),email:'sender@example.com',accessToken:'synthetic',scopes:['https://www.googleapis.com/auth/gmail.readonly']};
const mail={id:randomUUID(),mailboxId:mailbox.id,sender:mailbox.email,recipient:'lead@example.org',messageId:'<test@workbench.local>',status:'sent',createdAt:'2026-01-01T00:00:00Z'};
const message=(refs=mail.messageId,sender=mail.recipient,extra:any[]=[])=>({id:'reply2',threadId:'independent',internalDate:String(Date.now()),labelIds:['INBOX'],snippet:'Bitte nicht weiter kontaktieren.',payload:{headers:[{name:'From',value:sender},{name:'In-Reply-To',value:refs},{name:'Subject',value:'Antwort'},...extra]}});
async function scan(m:any,mails:any[]=[mail],extended=true){let full=0;const result=await scanDeliveries(mails,mailbox,async(url:string)=>{if(url.includes('format=full'))full++;return url.includes('?maxResults=')?{messages:[{id:m.id}]}:m;},extended?{scopeVersion:2,query:'test'}:undefined);assert.equal(full,0);return result;}
test('Unabhängige Antworten werden nur mit Referenz zugeordnet und ohne Volltextabruf klassifiziert',async()=>{
 for(const [m,kind] of [[message(),'reply'],[message(mail.messageId,'other@example.org'),'review'],[message(mail.messageId,mail.recipient,[{name:'Auto-Submitted',value:'auto-replied'}]),'automatic']] as const){const r=await scan(m);assert.equal(r.matches.length,1);assert.equal(r.matches[0].row.kind,kind);assert.equal(r.matches[0].row.threadId,'independent');}
 assert.equal((await scan(message('<unknown>'))).skipped,1);assert.equal((await scan(message(mail.messageId,mailbox.email))).skipped,1);assert.equal((await scan({...message(),internalDate:'1'})).skipped,1);assert.equal((await scan(message(),[mail],false)).skipped,1);
 await assert.rejects(()=>scan({...message(),internalDate:'invalid'}),/Empfangszeit/);
});
test('Mehrdeutige Referenzen bleiben ungeklärt, direkte Referenz hat Vorrang',async()=>{
 const second={...mail,id:randomUUID(),messageId:'<second@workbench.local>'};
 assert.equal((await scan(message(mail.messageId+' '+second.messageId),[mail,second])).unmatched,1);
 const selected=await scan(message(mail.messageId,mail.recipient,[{name:'References',value:second.messageId}]),[mail,second]);assert.equal(selected.matches[0].mailId,mail.id);
 assert.equal((await scan(message('',mail.recipient,[{name:'References',value:mail.messageId}]))).matches.length,1);
});
test('Antwortbeleg stoppt Kontakt, dedupliziert und lässt sich nicht einem anderen Kunden unterschieben',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-reply-')),s=new Store(join(dir,'db'),join(dir,'backup'),false);
 try{const c=s.createClient({name:'A',website:'',email:'',notes:''}),other=s.createClient({name:'B',website:'',email:'',notes:''});
 const input={id:randomUUID(),mailboxId:mailbox.id,sender:mail.sender,recipient:mail.recipient,subject:'Test',body:'Test',clientVersion:c.version};const sent=s.reserveMailTest(c.id,input);s.finishMailTest(c.id,sent.id,'sent','sent1','OK');
 const backup=s.exportBackup(),result=await scan(message(sent.messageId),[{...sent,status:'sent'}]);const saved={...result,extended:true,clientVersion:c.version,mailboxId:mailbox.id};
 assert.throws(()=>recordDeliveryScan(s,other.id,saved));assert.throws(()=>recordDeliveryScan(s,c.id,{...saved,extended:false}));
 assert.equal(recordDeliveryScan(s,c.id,saved).added,1);assert.equal(recordDeliveryScan(s,c.id,saved).added,0);assert.throws(()=>s.reserveMailTest(c.id,{...input,id:randomUUID()}),/angehalten/);
 const corrupt=structuredClone(saved);corrupt.matches[0].row.evidence=JSON.stringify({discovery:'independent-reply',inReplyTo:'<wrong>',references:'',linkedMessageId:sent.messageId});assert.throws(()=>recordDeliveryScan(s,c.id,corrupt),/eindeutig/);
 s.restore(backup);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM incoming').get()?.n,1);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('Alte Freigabe für reine Rückläufer aktiviert den erweiterten Leseumfang nicht',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-scope-')),s=new Store(join(dir,'db'),join(dir,'backup'),false);
 try{const c=s.createClient({name:'A',website:'',email:'',notes:''});s.db.prepare('INSERT INTO meta VALUES (?,?)').run('delivery-auto:'+c.id,JSON.stringify({enabled:true,clientVersion:c.version,mailboxId:mailbox.id,nextAt:0}));assert.equal(deliveryAuto(s,c.id).enabled,false);assert.equal(dueDeliveryAuto(s).length,0);
 configureDeliveryAuto(s,c.id,{enabled:false,mailboxId:mailbox.id});assert.equal(deliveryAuto(s,c.id).scopeVersion,2);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

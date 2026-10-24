import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {deliveryReport}=require('../electron/delivery.cjs');
const {readConversation}=require('../electron/inbox.cjs');
const mail={mailboxId:'box',sender:'sender@example.com',recipient:'lead@example.org',providerId:'sent1',messageId:'<test@workbench.local>',createdAt:'2026-01-01T00:00:00Z'};
const part=(mimeType:string,text:string)=>({mimeType,body:{data:Buffer.from(text).toString('base64url')}});
const report=(action='failed',status='5.1.1',recipient=mail.recipient,id=mail.messageId)=>({mimeType:'multipart/report',parts:[part('message/delivery-status',`Reporting-MTA: dns; mx.example.org\r\n\r\nFinal-Recipient: rfc822; ${recipient}\r\nAction: ${action}\r\nStatus: ${status}\r\nDiagnostic-Code: smtp; mailbox unavailable`),part('text/rfc822-headers',`Message-ID: ${id}\r\nTo: ${recipient}`)]});
test('Zustellbericht benötigt ursprüngliche Message-ID, Empfänger und konsistenten Fehlerstatus',()=>{
 assert.equal(deliveryReport(report(),mail).type,'failed');assert.equal(deliveryReport(report('delayed','4.2.2'),mail).type,'delayed');
 for(const payload of [report('failed','4.1.1'),report('delivered','2.0.0'),report('failed','5.1.1','other@example.org'),report('failed','5.1.1',mail.recipient,'<other>'),{mimeType:'text/plain',parts:report().parts}])assert.equal(deliveryReport(payload,mail).type,'review');
 const ambiguous=report();ambiguous.parts.push(ambiguous.parts[0]);assert.equal(deliveryReport(ambiguous,mail).type,'review');
 const missing=report();missing.parts[0].body.data='';assert.equal(deliveryReport(missing,mail).type,'review');
});
test('Gesprächsabruf liest nur gekennzeichnete Zustellberichte vollständig und speichert technischen Befund',async()=>{
 const mailbox={id:'box',email:mail.sender,accessToken:'test',scopes:['https://www.googleapis.com/auth/gmail.readonly']};
 const headers=(items:Record<string,string>)=>Object.entries(items).map(([name,value])=>({name,value}));
 const source={id:mail.providerId,threadId:'thread1',labelIds:['SENT'],payload:{headers:headers({'Message-ID':mail.messageId,From:mail.sender,To:mail.recipient})}};
 const incoming={id:'bounce1',threadId:'thread1',labelIds:['INBOX'],internalDate:String(Date.parse('2026-02-01')),payload:{headers:headers({From:'mailer-daemon@example.org','Content-Type':'multipart/report; report-type=delivery-status'})}};
 const urls:string[]=[];
 const r=await readConversation(mail,mailbox,async(url:string)=>{urls.push(url);if(url.includes('/threads/'))return {id:'thread1',messages:[source,incoming]};if(url.includes('format=full'))return {...incoming,payload:report()};return source;});
 assert.equal(urls.length,3);assert.ok(urls[2].includes('/bounce1?format=full'));assert.equal(r.rows[0].kind,'automatic');assert.equal(JSON.parse(r.rows[0].evidence).delivery.type,'failed');
 await assert.rejects(()=>readConversation(mail,mailbox,async(url:string)=>url.includes('/threads/')?{id:'thread1',messages:[incoming]}:url.includes('format=full')?{...incoming,threadId:'foreign',payload:report()}:source),/passt nicht/);
});

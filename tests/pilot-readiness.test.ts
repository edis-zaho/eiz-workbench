import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pilotReadiness} from '../src/pilot-readiness';

test('Pilotstatus bindet alle Belege an dasselbe Postfach und meldet fehlende Schritte',()=>{
 const mailbox={id:'mailbox-a',email:'sender@example.com',readAccess:true};
 const data={paused:false,mailbox,proof:{mailboxId:'mailbox-a',email:'sender@example.com',checkedAt:new Date().toISOString(),readVerified:true as const},sentTests:[{mailboxId:'mailbox-a',status:'sent'}],sync:{mailboxId:'mailbox-a',enabled:true,stale:false,lastSuccessAt:'2026-01-01'},progress:{mailboxId:'mailbox-a',status:'complete',stale:false,unmatched:0},unassigned:[]};
 assert.ok(pilotReadiness(data).every(c=>c.ok));
 assert.equal(pilotReadiness({...data,proof:{...data.proof,mailboxId:'mailbox-b'}}).find(c=>c.id==='read-check')?.ok,false);
 assert.equal(pilotReadiness({...data,progress:{...data.progress,stale:true}}).find(c=>c.id==='delivery')?.ok,false);
 assert.equal(pilotReadiness({...data,unassigned:[{mailboxId:'mailbox-a',status:'open'}]}).find(c=>c.id==='unassigned')?.ok,false);
 assert.equal(pilotReadiness({...data,paused:true}).find(c=>c.id==='customer')?.ok,false);
});


test('Pilot meldet unklare eigene Sendungen und fehlende Prüfdaten statt falscher Bereitschaft',()=>{
 const mailbox={id:'a',email:'sender@example.com',readAccess:true},input={paused:false,mailbox,sentTests:[{mailboxId:'a',status:'sent'}],unassigned:[]};
 const check=(value:Parameters<typeof pilotReadiness>[0],id:string)=>pilotReadiness(value).find(c=>c.id===id)!.ok;
 assert.equal(check(input,'uncertain-send'),true);
 for(const status of ['sending','unknown'])assert.equal(check({...input,sentTests:[...input.sentTests,{mailboxId:'a',status}]},'uncertain-send'),false);
 assert.equal(check({...input,sentTests:[...input.sentTests,{mailboxId:'other',status:'unknown'}]},'uncertain-send'),true);
 assert.equal(check({...input,sentTests:undefined},'uncertain-send'),false);
 assert.equal(check({...input,unassigned:undefined},'unassigned'),false);
 assert.equal(check({...input,mailbox:null},'uncertain-send'),false);
});

test('Pilot verlangt einen aktuellen Identitätsbeleg und akzeptiert keine zukünftige Prüfung',()=>{
 const mailbox={id:'a',email:'sender@example.com',readAccess:true};
 for(const offset of [-600001,60000])assert.equal(pilotReadiness({paused:false,mailbox,proof:{mailboxId:'a',email:mailbox.email,checkedAt:new Date(Date.now()+offset).toISOString(),readVerified:true}}).find(c=>c.id==='read-check')!.ok,false);
});

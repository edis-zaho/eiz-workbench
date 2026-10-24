import {startServer} from '../core/server';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {prepareQueue,controlQueue,queueState,tickQueues,stopQueues,localTime,plusDays,activateLiveQueue,claimOutbound,finishOutbound,dueOutbound,authorizeOutbound,expireOutbound} from '../core/outbox';
import {recordConversation} from '../core/inbox';
import {rehearseRestore} from '../core/recovery';
function customer(s:Store,n=2){const c=s.createClient({name:'Pilot',website:'',email:'',notes:''});let b=s.addSource(c.id,{kind:'manual',url:'',title:'Quelle',text:'Einkaufssoftware'},0);b=s.reviewSource(c.id,b.content.sources[0].id,b.revision,true);Object.assign(b.content.rules,{offer:'Software',targets:'Firmen',personas:'Einkauf',claims:'Einkaufssoftware',dailyLimit:500});b.content.routes.analysis.model='test';b.content.routes.writing.model='test';b=s.saveRules(c.id,{...b.content,revision:b.revision});s.approveBrief(c.id,b.revision,c.version);const csv={csv:'email;first;company\n'+Array.from({length:n},(_,i)=>`p${i}@example.com;Person ${i};Firma ${i}`).join('\n'),delimiter:';',filename:'leads.csv',mapping:{email:0,firstName:1,company:2,lastName:-1,role:-1}};s.importLeads(c.id,{...csv,fingerprint:s.previewLeads(c.id,csv).fingerprint});return c;}
function campaign(s:Store,clientId:string,patch:any={}){const content={name:'Pilot',leadIds:s.campaignLeads(clientId).map(l=>l.id),dailyLimit:1,startDate:'2026-10-05',startHour:9,endHour:17,weekdays:[1,2,3,4,5],timezone:'UTC',steps:[{subject:'Hallo {{vorname}}',body:'Für {{unternehmen}}',gapDays:0},{subject:'Nachfrage',body:'Zweiter Ansatz',gapDays:3}],...patch};const c=s.saveCampaign(clientId,{content}),p=s.campaignPreview(clientId,c.id);s.approveCampaign(clientId,c.id,{fingerprint:p.fingerprint,confirmed:true});return {c,p};}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'eiz-queue-'));let s=new Store(join(dir,'db'),join(dir,'backups'),false);const c=customer(s);return {get s(){return s;},c,dir,reopen(){s.close();s=new Store(join(dir,'db'),join(dir,'backups'),false);},close(){s.close();rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}};}
function start(s:Store,clientId:string,r:any){controlQueue(s,clientId,r.id,{revision:r.revision,action:'start',confirmed:true});}
function liveReady(s:Store,clientId:string){const mailboxId=randomUUID(),client=s.client(clientId),mail=s.reserveMailTest(clientId,{id:randomUUID(),mailboxId,clientVersion:client.version,sender:'sender@example.com',recipient:'owner@example.com',subject:'Test',body:'Test'});s.finishMailTest(clientId,mail.id,'sent','google-test','OK');s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+clientId,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:mail.id,mailboxId,clientVersion:client.version,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));return mailboxId;}
test('blocked first ten live runs cannot permanently starve later campaigns',()=>{const f=fixture();try{
 const ids=new Set<string>();
 for(let i=0;i<11;i++){
  const client=customer(f.s,1),{c,p}=campaign(f.s,client.id,{weekdays:[1]}),r=prepareQueue(f.s,client.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0],mailboxId=liveReady(f.s,client.id);
  activateLiveQueue(f.s,client.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});
  start(f.s,client.id,queueState(f.s,client.id)[0]);ids.add(r.id);
 }
 const seen=new Set<string>();
 for(let poll=0;poll<3;poll++){
  const rows=dueOutbound(f.s);assert.ok(rows.length<=10);
  for(const row of rows){seen.add(row.runId);assert.throws(()=>claimOutbound(f.s,row.clientId,row.runId,{mailboxId:row.mailboxId,sender:'sender@example.com'},new Date('2026-10-11T09:00Z')),/Versandzeitfenster/);}
 }
 assert.deepEqual(seen,ids,'Every active campaign must eventually be inspected even when earlier ones cannot send');
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM queue_items WHERE status=\'sending\'').get()!.n,0);
 const beforeRestart=new Set(dueOutbound(f.s).map(r=>r.runId));assert.equal(beforeRestart.size,10);
 f.reopen();const afterRestart=new Set([...dueOutbound(f.s),...dueOutbound(f.s)].map(r=>r.runId));assert.deepEqual(afterRestart,ids);
 const selected=dueOutbound(f.s)[0],paused=queueState(f.s,selected.clientId).find(r=>r.id===selected.runId)!;
 controlQueue(f.s,selected.clientId,selected.runId,{revision:paused.revision,action:'pause'});
 const remaining=dueOutbound(f.s);assert.equal(remaining.length,10);assert.equal(new Set(remaining.map(r=>r.runId)).size,10);assert.ok(remaining.every(r=>r.runId!==selected.runId));
 stopQueues(f.s);assert.deepEqual(dueOutbound(f.s),[]);
}finally{f.close();}});

test('Freigegebener Plan wird einmalig eingefroren; keine Versandaufträge oder Provideraufrufe',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id);assert.throws(()=>prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint}));const r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0];assert.equal(r.items.length,4);assert.equal(r.status,'prepared');assert.ok(r.items.some(q=>q.subject==='Hallo Person 0'));assert.throws(()=>prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true}),/bereits/);assert.equal(tickQueues(f.s,new Date('2026-10-05T09:00Z')).processed,0);assert.equal(f.s.mailTests(f.c.id).length,0);f.reopen();assert.equal(queueState(f.s,f.c.id)[0].items.length,4);}finally{f.close();}});
test('Zeitfenster, Tageslimit, Follow-up ab tatsächlichem Vorgänger und Wiederanlauf verhindern Duplikate',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id);const r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0];start(f.s,f.c.id,r);assert.equal(tickQueues(f.s,new Date('2026-10-05T08:59Z')).processed,0);assert.equal(tickQueues(f.s,new Date('2026-10-05T09:00Z')).processed,1);assert.equal(tickQueues(f.s,new Date('2026-10-05T10:00Z')).processed,0);f.reopen();assert.equal(tickQueues(f.s,new Date('2026-10-06T09:00Z')).processed,1);assert.equal(tickQueues(f.s,new Date('2026-10-07T09:00Z')).processed,0);assert.equal(tickQueues(f.s,new Date('2026-10-08T09:00Z')).processed,1);assert.equal(tickQueues(f.s,new Date('2026-10-09T09:00Z')).processed,1);tickQueues(f.s,new Date('2026-10-09T09:01Z'));const done=queueState(f.s,f.c.id)[0];assert.equal(done.status,'completed');assert.equal(done.items.filter(q=>q.status==='simulated').length,4);assert.equal(f.s.mailTests(f.c.id).length,0);}finally{f.close();}});
test('Pause, Notstopp, veraltete Steuerung und Planänderung halten den Lauf an',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id);let r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0];start(f.s,f.c.id,r);assert.throws(()=>controlQueue(f.s,f.c.id,r.id,{revision:r.revision,action:'cancel'}),/geändert/);stopQueues(f.s);assert.equal(tickQueues(f.s,new Date('2026-10-05T09:00Z')).processed,0);r=queueState(f.s,f.c.id)[0];start(f.s,f.c.id,r);f.s.saveCampaign(f.c.id,{id:c.id,revision:c.revision,content:{...JSON.parse(c.content),name:'Geändert'}});tickQueues(f.s,new Date('2026-10-05T09:00Z'));r=queueState(f.s,f.c.id)[0];assert.equal(r.status,'paused');assert.throws(()=>start(f.s,f.c.id,r),/Freigabe geändert/);controlQueue(f.s,f.c.id,r.id,{revision:r.revision,action:'cancel'});assert.ok(queueState(f.s,f.c.id)[0].items.every(q=>q.status==='cancelled'));}finally{f.close();}});
test('Eingang stoppt nur betroffenen Kontakt samt Follow-ups; Kunde bleibt getrennt',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id,{dailyLimit:20});const r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0];start(f.s,f.c.id,r);const other=customer(f.s,1);assert.throws(()=>controlQueue(f.s,other.id,r.id,{revision:r.revision,action:'pause'}),/nicht gefunden/);const mail=f.s.reserveMailTest(f.c.id,{id:randomUUID(),mailboxId:randomUUID(),clientVersion:f.c.version,sender:'me@example.com',recipient:'p0@example.com',subject:'Test',body:'Test'});f.s.finishMailTest(f.c.id,mail.id,'sent','g1','OK');recordConversation(f.s,f.c.id,mail.id,{clientVersion:f.c.version,mailboxId:mail.mailboxId,rows:[{providerId:'reply1',threadId:'t1',sender:mail.recipient,subject:'Antwort',excerpt:'Stopp',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}]});tickQueues(f.s,new Date('2026-10-05T09:00Z'));const rows=queueState(f.s,f.c.id)[0].items;assert.equal(rows.filter(q=>q.recipient==='p0@example.com'&&q.status==='held').length,2);assert.equal(rows.filter(q=>q.status==='simulated').length,1);}finally{f.close();}});
test('Sicherung enthält ganze Warteschlange; Wiederherstellung startet nichts und beschädigte Einträge werden abgelehnt',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id);const r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0];start(f.s,f.c.id,r);const backup=f.s.exportBackup();assert.equal(rehearseRestore(backup).counts.queueItems,4);const broken=structuredClone(backup);broken.data.queueItems!.pop();broken.checksum=createHash('sha256').update(JSON.stringify(broken.data)).digest('hex');assert.throws(()=>f.s.restore(broken),/Unvollständiger/);f.s.restore(backup);f.reopen();assert.equal(queueState(f.s,f.c.id)[0].status,'paused');assert.equal(tickQueues(f.s,new Date('2026-10-05T09:00Z')).processed,0);}finally{f.close();}});
test('Kalendertage und lokales Versandfenster funktionieren über Zeitumstellung',()=>{assert.equal(plusDays('2026-10-24',3),'2026-10-27');assert.equal(localTime(new Date('2026-10-25T01:30Z'),'Europe/Berlin').hour,2);assert.equal(localTime(new Date('2026-03-29T01:30Z'),'Europe/Berlin').hour,3);});
test('Kundenlimit gilt über Kampagnen hinweg und doppelte aktive Kontakte werden abgewiesen',()=>{const f=fixture();try{let b=f.s.brief(f.c.id);b.content.rules.dailyLimit=1;b=f.s.saveRules(f.c.id,{...b.content,revision:b.revision});f.s.approveBrief(f.c.id,b.revision,f.c.version);const leads=f.s.campaignLeads(f.c.id);for(const lead of leads){const {c,p}=campaign(f.s,f.c.id,{leadIds:[lead.id],steps:[{subject:'Hallo',body:'Test',gapDays:0}]});start(f.s,f.c.id,prepareQueue(f.s,f.c.id,c.id,{confirmed:true,fingerprint:p.fingerprint}).find(r=>r.campaignId===c.id));}
 const duplicate=campaign(f.s,f.c.id,{leadIds:[leads[0].id]});assert.throws(()=>prepareQueue(f.s,f.c.id,duplicate.c.id,{confirmed:true,fingerprint:duplicate.p.fingerprint}),/bereits in einer offenen/);
 assert.equal(tickQueues(f.s,new Date('2026-10-05T09:00Z')).processed,1);assert.equal(tickQueues(f.s,new Date('2026-10-05T09:02Z')).processed,0);assert.equal(tickQueues(f.s,new Date('2026-10-06T09:00Z')).processed,1);
 }finally{f.close();}});
test('Upgrade aus Schema 7 sichert vorher den Synchronisationsstand',()=>{const f=fixture();try{f.s.db.exec('DROP TRIGGER evidence_mail_insert; DROP TRIGGER evidence_mail_update; DROP TRIGGER evidence_incoming_insert; DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; DROP TABLE interpretations; DROP TABLE evidence_events; DROP TABLE lead_account_links; DROP TABLE product_revisions; DROP TABLE account_revisions; DROP TABLE products; DROP TABLE accounts; DROP INDEX lead_id_client; DROP TABLE queue_items; DROP TABLE queue_runs; PRAGMA user_version=7;');f.reopen();assert.equal(f.s.snapshot().database.schema,34);const file=readdirSync(join(f.dir,'backups')).find(x=>x.includes('before-upgrade'))!;const b=validateBackup(JSON.parse(readFileSync(join(f.dir,'backups',file),'utf8')));assert.equal(b.version,7);assert.ok(Array.isArray(b.data.mailSync));}finally{f.close();}});
test('Zehn Kunden mit jeweils 1.000 Kontakten erhalten getrennte persistente Warteschlangen',()=>{const f=fixture();try{for(let i=0;i<10;i++){const client=customer(f.s,1000),{c,p}=campaign(f.s,client.id,{dailyLimit:100,steps:[{subject:'Hallo {{vorname}}',body:'Für {{unternehmen}}',gapDays:0}]});prepareQueue(f.s,client.id,c.id,{fingerprint:p.fingerprint,confirmed:true});}assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM queue_items').get()?.n,10000);f.reopen();assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM queue_items').get()?.n,10000);assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM mail_tests').get()?.n,0);}finally{f.close();}});
test('Live-Lauf braucht Testsendung, aktuelle Rückläuferprüfung und doppelte Freigabe',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id),r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0],mailboxId=liveReady(f.s,f.c.id);assert.throws(()=>activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'falsch'}),/Bestätigungstext/);activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});let live=queueState(f.s,f.c.id)[0];assert.equal(live.snapshot.mode,'live');assert.equal(live.status,'paused');start(f.s,f.c.id,live);assert.equal(tickQueues(f.s,new Date('2026-10-05T09:00Z')).processed,0);assert.equal(dueOutbound(f.s)[0].runId,r.id);}finally{f.close();}});
test('Live-Versand reserviert genau einmal und schaltet Follow-up erst nach bestätigter Gmail-Annahme frei',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id,{leadIds:[f.s.campaignLeads(f.c.id)[0]!.id],dailyLimit:10}),r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0],mailboxId=liveReady(f.s,f.c.id);activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});let live=queueState(f.s,f.c.id)[0];start(f.s,f.c.id,live);const claim=claimOutbound(f.s,f.c.id,r.id,{mailboxId,sender:'sender@example.com'},new Date('2026-10-05T09:00Z'))!;assert.equal(claim.messageId,`<${claim.id}@workbench.local>`);assert.throws(()=>claimOutbound(f.s,f.c.id,r.id,{mailboxId,sender:'sender@example.com'},new Date('2026-10-05T09:00Z')));finishOutbound(f.s,f.c.id,r.id,claim.id,{status:'sent',providerId:'gmail-1',result:'Angenommen'},new Date('2026-10-05T09:00:01Z'));let state=queueState(f.s,f.c.id)[0];assert.equal(state.items.find((q:any)=>q.id===claim.id)!.status,'sent');assert.equal(state.items.find((q:any)=>q.step===1)!.eligibleDate,'2026-10-08');assert.equal(f.s.mailTests(f.c.id).filter(m=>m.id===claim.id).length,1);f.reopen();state=queueState(f.s,f.c.id)[0];assert.equal(state.items.find((q:any)=>q.id===claim.id)!.status,'sent');}finally{f.close();}});
test('Unklares Live-Ergebnis pausiert den Lauf und wird nach Neustart nie automatisch wiederholt',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id,{leadIds:[f.s.campaignLeads(f.c.id)[0].id],steps:[{subject:'Hallo',body:'Test',gapDays:0}]}),r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0],mailboxId=liveReady(f.s,f.c.id);activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});start(f.s,f.c.id,queueState(f.s,f.c.id)[0]);const claim=claimOutbound(f.s,f.c.id,r.id,{mailboxId,sender:'sender@example.com'},new Date('2026-10-05T09:00Z'))!;finishOutbound(f.s,f.c.id,r.id,claim.id,{status:'unknown',providerId:'',result:'Netzwerkabbruch'});assert.equal(queueState(f.s,f.c.id)[0].status,'paused');assert.equal(queueState(f.s,f.c.id)[0].items[0].status,'unknown');f.reopen();assert.equal(dueOutbound(f.s).length,0);assert.equal(f.s.mailTests(f.c.id).find(m=>m.id===claim.id)?.status,'unknown');}finally{f.close();}});
test('Unterbrochene Gmail-Übergabe wird beim Neustart unklar und niemals erneut beansprucht',()=>{const f=fixture();try{const {c,p}=campaign(f.s,f.c.id,{leadIds:[f.s.campaignLeads(f.c.id)[0]!.id],steps:[{subject:'Hallo',body:'Test',gapDays:0}]}),r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0],mailboxId=liveReady(f.s,f.c.id);activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});start(f.s,f.c.id,queueState(f.s,f.c.id)[0]);const claim=claimOutbound(f.s,f.c.id,r.id,{mailboxId,sender:'sender@example.com'},new Date('2026-10-05T09:00Z'))!;assert.equal(queueState(f.s,f.c.id)[0].items[0].status,'sending');f.reopen();const state=queueState(f.s,f.c.id)[0];assert.equal(state.status,'paused');assert.equal(state.items[0].status,'unknown');assert.equal(f.s.mailTests(f.c.id).find(m=>m.id===claim.id)?.status,'unknown');assert.equal(dueOutbound(f.s).length,0);const backup=f.s.exportBackup();assert.doesNotThrow(()=>validateBackup(backup));}finally{f.close();}});

function activeLive(f:ReturnType<typeof fixture>,patch:any={}){
 const {c,p}=campaign(f.s,f.c.id,{dailyLimit:10,...patch});
 const r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0],mailboxId=liveReady(f.s,f.c.id);
 activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});
 start(f.s,f.c.id,queueState(f.s,f.c.id)[0]);
 return {id:r.id,mailboxId,sender:'sender@example.com'};
}
const sendTime=()=>new Date('2026-10-05T09:00:00Z');
test('Sender mismatch and an outstanding reservation block another send for the customer',()=>{const f=fixture();try{
 const live=activeLive(f);assert.throws(()=>claimOutbound(f.s,f.c.id,live.id,{...live,sender:'other@example.com'},sendTime()),/Absender/);
 const claim=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!;
 assert.throws(()=>claimOutbound(f.s,f.c.id,live.id,live,new Date('2026-10-05T09:02Z')),/noch offen/);
 assert.throws(()=>f.s.finishMailTest(f.c.id,claim.id,'sent','id','bypass'),/Warteschlange/);
}finally{f.close();}});
test('Final dispatch decision is single-use and checks new stop, mailbox, revision and elapsed lease',()=>{const f=fixture();try{
 const live=activeLive(f),claim=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!;
 const input={...live,revision:claim.runRevision};
 assert.throws(()=>authorizeOutbound(f.s,f.c.id,live.id,claim.id,{...input,mailboxId:randomUUID()},sendTime()),/Postfach/);
 assert.throws(()=>authorizeOutbound(f.s,f.c.id,live.id,claim.id,input,new Date('2026-10-05T09:02Z')),/abgelaufen/);
 assert.equal(authorizeOutbound(f.s,f.c.id,live.id,claim.id,input,sendTime()).allowed,true);
 assert.throws(()=>authorizeOutbound(f.s,f.c.id,live.id,claim.id,input,sendTime()),/verbraucht/);
 stopQueues(f.s);assert.throws(()=>authorizeOutbound(f.s,f.c.id,live.id,claim.id,input,sendTime()),/angehalten/);
}finally{f.close();}});
test('Late success or failure cannot reverse cancellation; pause also survives a late success',()=>{
 for(const action of ['cancel','pause'])for(const status of ['sent','failed','unknown']){const f=fixture();try{
  const live=activeLive(f,{steps:[{subject:'Hallo',body:'Text',gapDays:0}]}),q=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!;
  const r=queueState(f.s,f.c.id)[0];controlQueue(f.s,f.c.id,live.id,{action,revision:r.revision});
  finishOutbound(f.s,f.c.id,live.id,q.id,{status,providerId:status==='sent'?'google-id':'',result:'spätes Ergebnis'},sendTime());
  assert.equal(queueState(f.s,f.c.id)[0].status,action==='cancel'?'cancelled':'paused');
 }finally{f.close();}}
});
test('Unknown results cannot be restarted; confirmed reconciliation updates queue but requires conscious resume',()=>{const f=fixture();try{
 const live=activeLive(f),q=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!;
 finishOutbound(f.s,f.c.id,live.id,q.id,{status:'unknown',providerId:'',result:'Timeout'},sendTime());
 assert.throws(()=>start(f.s,f.c.id,queueState(f.s,f.c.id)[0]),/noch offen/);
 f.s.reconcileMail(f.c.id,q.id,{mailboxId:live.mailboxId,clientVersion:f.c.version,messageId:q.messageId,outcome:'not_found',providerId:''});
 assert.equal(queueState(f.s,f.c.id)[0].items.find(i=>i.id===q.id)?.status,'unknown');
 f.s.reconcileMail(f.c.id,q.id,{mailboxId:live.mailboxId,clientVersion:f.c.version,messageId:q.messageId,outcome:'found',providerId:'google-id'});
 const r=queueState(f.s,f.c.id)[0];assert.equal(r.status,'paused');assert.equal(r.items.find(i=>i.id===q.id)?.status,'sent');assert.equal(r.items.find(i=>i.leadId===q.leadId&&i.step===1)?.status,'ready');
}finally{f.close();}});
test('Stalled reservations expire without restart and do not resume cancelled runs',()=>{const f=fixture();try{
 const live=activeLive(f),q=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!;
 const r=queueState(f.s,f.c.id)[0];controlQueue(f.s,f.c.id,live.id,{action:'cancel',revision:r.revision});
 assert.equal(expireOutbound(f.s,new Date('2026-10-05T09:04Z')),1);assert.equal(expireOutbound(f.s,new Date('2026-10-05T09:05Z')),0);
 assert.equal(queueState(f.s,f.c.id)[0].status,'cancelled');assert.equal(f.s.mailTests(f.c.id).find(m=>m.id===q.id)?.status,'unknown');
}finally{f.close();}});
test('Partially simulated runs cannot become live and existing live mailbox cannot be replaced',()=>{const f=fixture();try{
 const {c,p}=campaign(f.s,f.c.id);let r=prepareQueue(f.s,f.c.id,c.id,{fingerprint:p.fingerprint,confirmed:true})[0];start(f.s,f.c.id,r);tickQueues(f.s,sendTime());stopQueues(f.s);r=queueState(f.s,f.c.id)[0];
 const mailboxId=liveReady(f.s,f.c.id);assert.throws(()=>activateLiveQueue(f.s,f.c.id,r.id,{revision:r.revision,mailboxId,sender:'sender@example.com',confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'}),/Simulationen/);
}finally{f.close();}
 const f2=fixture();try{const live=activeLive(f2);stopQueues(f2.s);const r=queueState(f2.s,f2.c.id)[0];assert.throws(()=>activateLiveQueue(f2.s,f2.c.id,r.id,{...live,revision:r.revision,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'}),/gebunden/);}finally{f2.close();}
});
test('Old restore cannot erase a campaign attempt; fresh backup retains it; pending backup restores as unknown immediately',()=>{const f=fixture();try{
 const live=activeLive(f),before=f.s.exportBackup(),q=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!,pending=f.s.exportBackup();
 assert.throws(()=>f.s.restore(before),/noch offen/);assert.equal(rehearseRestore(pending).counts.queueItems,4);
 finishOutbound(f.s,f.c.id,live.id,q.id,{status:'sent',providerId:'google-id',result:'OK'},sendTime());
 assert.throws(()=>f.s.restore(before),/Versandhistorie/);assert.equal(f.s.mailTests(f.c.id).find(m=>m.id===q.id)?.status,'sent');
 f.s.restore(f.s.exportBackup());assert.equal(queueState(f.s,f.c.id)[0].status,'paused');
}finally{f.close();}});
test('Follow-up gap uses day of confirmed acceptance and new messages need fresh inbox coverage',()=>{const f=fixture();try{
 const live=activeLive(f),q=claimOutbound(f.s,f.c.id,live.id,live,sendTime())!;
 finishOutbound(f.s,f.c.id,live.id,q.id,{status:'sent',providerId:'google-id',result:'OK'},new Date('2026-10-06T00:01Z'));
 const r=queueState(f.s,f.c.id)[0];assert.equal(r.items.find(i=>i.leadId===q.leadId&&i.step===1)?.eligibleDate,'2026-10-09');
 assert.throws(()=>claimOutbound(f.s,f.c.id,live.id,live,new Date('2026-10-06T09:00Z')),/Rückläuferprüfung/);
}finally{f.close();}});

test('Incoming contact stop persists instead of being rolled back with an exception',()=>{const f=fixture();try{
 const live=activeLive(f),mail=f.s.mailTests(f.c.id)[0];
 // Re-use a confirmed message to this recipient as an earlier conversation.
 f.s.db.prepare('UPDATE mail_tests SET recipient=? WHERE id=?').run('p0@example.com',mail.id);
 recordConversation(f.s,f.c.id,mail.id,{clientVersion:f.c.version,mailboxId:live.mailboxId,rows:[{providerId:'reply-live',threadId:'thread-live',sender:'p0@example.com',subject:'Antwort',excerpt:'Bitte stoppen',receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}]});
 assert.equal(claimOutbound(f.s,f.c.id,live.id,live,sendTime()),null);
 assert.equal(queueState(f.s,f.c.id)[0].items.filter(i=>i.recipient==='p0@example.com'&&i.status==='held').length,2);
 assert.ok(claimOutbound(f.s,f.c.id,live.id,live,sendTime()));
}finally{f.close();}});
test('Real desktop dispatcher and HTTP worker: native gate, stop race and lost commit acknowledgement',async()=>{
 const {dispatchOutbound}=createRequire(import.meta.url)('../electron/outbound.cjs');
 for(const scenario of ['normal','stop','lost-commit']){
  const f=fixture();let service:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
   const live=activeLive(f,{startDate:new Date().toISOString().slice(0,10),startHour:0,endHour:24,weekdays:[0,1,2,3,4,5,6]}),token='r'.repeat(64),workerToken='w'.repeat(64);
   service=await startServer(f.s,token,60000,workerToken);const url=service.url;
   const base=`/api/clients/${f.c.id}/queue/${live.id}`;
   for(const suffix of ['/activate-live','/claim-send','/items/item/authorize-send','/items/item/finish-send']){
    const response=await fetch(url+base+suffix,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
   }
   let sent=0,locks=0,lost=false;
   const google={withMailbox:async(_:string,fn:any)=>{locks++;return fn({id:live.mailboxId,email:live.sender,accessToken:'test'});},sendOnce:async()=>{sent++;return {providerId:'google-accepted'};}};
   const request=async(path:string,input:any)=>{
    if(scenario==='stop'&&path.endsWith('/authorize-send'))stopQueues(f.s);
    const response=await fetch(url+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-EiZ-Worker':workerToken,'Content-Type':'application/json'},body:JSON.stringify(input)});
    const data=await response.json() as any;if(!response.ok)throw Error(data.error);
    if(scenario==='lost-commit'&&path.endsWith('/finish-send')&&!lost){lost=true;throw Error('response lost after durable commit');}
    return data;
   };
   await dispatchOutbound({google,request,row:{clientId:f.c.id,runId:live.id,mailboxId:live.mailboxId}});
   assert.equal(locks,1);assert.equal(sent,scenario==='stop'?0:1);
   const r=queueState(f.s,f.c.id)[0];assert.equal(r.items.find(i=>i.step===0&&i.recipient==='p0@example.com')?.status,scenario==='stop'?'failed':'sent');
   if(scenario==='stop')assert.equal(r.status,'paused');
   assert.equal(f.s.mailTests(f.c.id).filter(m=>m.providerId==='google-accepted').length,scenario==='stop'?0:1);
  }finally{if(service)await service.close();else f.s.close();rmSync(f.dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
 }
});

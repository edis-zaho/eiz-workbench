import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Store,validateBackup} from '../core/store';
import {evidenceJournal,exportEvidenceJournal,suspendEvidenceTriggers} from '../core/evidence-journal';
import {recordConversation} from '../core/inbox';
import {saveAccount,linkAccount,saveProduct} from '../core/catalog';
import {prepareQueue} from '../core/outbox';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'eiz-journal-')),file=join(dir,'db.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
  const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id,mailboxId=randomUUID();
  return {get s(){return s;},a,b,mailboxId,dir,backups,
    mail(client=a){return s.reserveMailTest(client,{id:randomUUID(),mailboxId,clientVersion:s.client(client).version,sender:'sender@example.com',recipient:'lead@example.com',subject:'Synthetic',body:'Synthetic'});},
    rows(){return exportEvidenceJournal(s);},reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
function reply(f:ReturnType<typeof fixture>,mailId:string) {
  return recordConversation(f.s,f.a,mailId,{mailboxId:f.mailboxId,clientVersion:f.s.client(f.a).version,rows:[{providerId:'reply123',threadId:'thread123',sender:'lead@example.com',subject:'Reply',excerpt:'Synthetic',receivedAt:'2026-09-01T12:00:00.000Z',kind:'reply',evidence:'{}'}]});
}

test('status observations are atomic, append-only, restart-safe and preserve unknown before reconciliation',()=>{
  const f=fixture();try {
    const mail=f.mail();assert.equal(f.rows().length,1);const original=f.rows()[0];assert.equal(JSON.parse(original.payload).status,'sending');
    f.reopen();assert.equal(f.rows().length,2);assert.equal(JSON.parse(f.rows().find(e=>e.sourceRevision===2)!.payload).status,'unknown');
    f.s.reconcileMail(f.a,mail.id,{mailboxId:f.mailboxId,messageId:mail.messageId,clientVersion:f.s.client(f.a).version,outcome:'found',providerId:'sent123'});
    assert.equal(f.rows().length,3);assert.deepEqual(f.rows().find(e=>e.id===original.id),original);
    assert.equal(JSON.parse(f.rows().find(e=>e.sourceRevision===3)!.payload).status,'sent');
    f.s.db.prepare('UPDATE mail_tests SET updatedAt=? WHERE id=?').run(new Date().toISOString(),mail.id);assert.equal(f.rows().length,3);
    assert.throws(()=>f.s.db.prepare('UPDATE evidence_events SET origin=? WHERE id=?').run('migration_snapshot',original.id),/overwritten/);
    const count=f.rows().length;
    assert.throws(()=>f.s.transaction(()=>{f.s.db.prepare("UPDATE mail_tests SET status='unknown' WHERE id=?").run(mail.id);throw new Error('rollback');}));
    assert.equal(f.rows().length,count);assert.equal(f.s.mailTests(f.a)[0].status,'sent');
    assert.equal(rehearseRestore(f.s.exportBackup()).restartVerified,true);
  }finally{f.close();}
});

test('recording failure cannot silently commit a source change or clear an unresolved send',()=>{
  const f=fixture();try {
    const m=f.mail();f.s.db.exec("CREATE TRIGGER test_evidence_failure BEFORE INSERT ON evidence_events BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
    assert.throws(()=>f.s.finishMailTest(f.a,m.id,'sent','sent123','OK'),/synthetic disk failure/);
    assert.equal(f.s.mailTests(f.a)[0].status,'sending');assert.equal(f.rows().length,1);
    f.s.db.exec('DROP TRIGGER test_evidence_failure');f.reopen();assert.equal(f.s.mailTests(f.a)[0].status,'unknown');
  }finally{f.close();}
});

test('incoming is deduplicated across scans and mail associations with provider and recording times separated',()=>{
  const f=fixture();try {
    const m=f.mail(),other=f.mail();for(const mail of [m,other])f.s.finishMailTest(f.a,mail.id,'sent','sent'+mail.id.replaceAll('-',''),'OK');
    assert.equal(reply(f,m.id).added,1);assert.equal(reply(f,m.id).added,0);reply(f,other.id);
    const incoming=f.rows().filter(e=>e.source==='incoming');assert.equal(incoming.length,1);
    assert.equal(incoming[0].occurredAt,'2026-09-01T12:00:00.000Z');assert.notEqual(incoming[0].recordedAt,incoming[0].occurredAt);
    assert.equal(JSON.parse(incoming[0].payload).reportedKind,'reply');assert.equal(incoming[0].eventType,'incoming_observed');
    const before=f.rows();f.s.restore(f.s.exportBackup());f.reopen();assert.deepEqual(f.rows(),before);
  }finally{f.close();}
});

test('product snapshot and first observed account assignment remain fixed through edits and replies',()=>{
  const f=fixture();try {
    let brief=f.s.addSource(f.a,{kind:'manual',url:'',title:'Quelle',text:'Synthetisches Angebot'},0);brief=f.s.reviewSource(f.a,brief.content.sources[0].id,brief.revision,true);
    Object.assign(brief.content.rules,{offer:'Angebot',targets:'Firmen',personas:'IT',claims:'Software'});brief.content.routes.analysis.model='test';brief.content.routes.writing.model='test';
    brief=f.s.saveRules(f.a,{...brief.content,revision:brief.revision});f.s.approveBrief(f.a,brief.revision,f.s.client(f.a).version);
    const csv={csv:'email\nlead@example.com',delimiter:',',filename:'test.csv',mapping:{email:0,company:-1,firstName:-1,lastName:-1,role:-1}};f.s.importLeads(f.a,{...csv,fingerprint:f.s.previewLeads(f.a,csv).fingerprint});
    const lead=f.s.leads(f.a).rows[0].id,account=saveAccount(f.s,f.a,null,{name:'Account eins',domain:'example.com'},0);linkAccount(f.s,f.a,lead,account.accountId,0);
    const p=saveProduct(f.s,f.a,null,{name:'Produkt eins',description:'',website:'',bookingUrl:'',archived:false},0);
    const content={name:'Test',leadIds:[lead],productRef:{productId:p.productId,revision:1},dailyLimit:1,startDate:'2099-01-01',startHour:9,endHour:17,weekdays:[1,2,3,4,5],timezone:'UTC',steps:[{subject:'Hello',body:'Synthetic',gapDays:0}]};
    const campaign=f.s.saveCampaign(f.a,{content}),preview=f.s.campaignPreview(f.a,campaign.id);f.s.approveCampaign(f.a,campaign.id,{confirmed:true,fingerprint:preview.fingerprint});
    prepareQueue(f.s,f.a,campaign.id,{confirmed:true,fingerprint:preview.fingerprint});
    const item=f.s.db.prepare('SELECT * FROM queue_items').get()!;
    const at=new Date().toISOString();f.s.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id,f.a,f.mailboxId,'sender@example.com','lead@example.com','Hello','Synthetic',`<${item.id}@workbench.local>`,'sending','','Pending',at,at);
    const first=f.rows()[0],ctx=JSON.parse(first.context);assert.equal(ctx.productRevision,1);assert.equal(ctx.accountId,account.accountId);assert.equal(ctx.linkRevision,1);
    linkAccount(f.s,f.a,lead,null,1);saveProduct(f.s,f.a,p.productId,{name:'Produkt zwei',description:'',website:'',bookingUrl:'',archived:false},1);
    f.s.db.prepare("UPDATE mail_tests SET status='sent',providerId='sent123',result='OK' WHERE id=?").run(item.id);reply(f,String(item.id));
    assert.ok(f.rows().every(e=>e.context===first.context));assert.equal(evidenceJournal(f.s,f.a).rows[0].productName,'Produkt eins');
    validateBackup(f.s.exportBackup());
    const wrong=structuredClone(f.s.exportBackup());for(const e of wrong.data.evidenceEvents!)e.context=JSON.stringify({...JSON.parse(e.context),productRevision:2});assert.throws(()=>validateBackup(resign(wrong)),/Ereignis/);
  }finally{f.close();}
});

test('old restores retain known observations and reject altered history or loss of its customer',()=>{
  const f=fixture();try {
    const old=f.s.exportBackup(),m=f.mail();f.s.finishMailTest(f.a,m.id,'sent','sent123','OK');const known=f.rows();
    f.s.restore(old);assert.deepEqual(f.rows(),known);assert.equal(f.s.mailTests(f.a).length,0); // source absent; original observation remains
    const conflict=f.s.exportBackup();conflict.data.evidenceEvents![0].occurredAt='2000-01-01T00:00:00.000Z';assert.throws(()=>f.s.restore(resign(conflict)),/Beobachtung/);
    const empty=fixture();try{assert.throws(()=>f.s.restore(empty.s.exportBackup()),/Ereignis/);}finally{empty.close();}
    f.reopen();assert.deepEqual(f.rows(),known);assert.equal(f.s.client(f.a).status,'paused');
  }finally{f.close();}
});

test('schema10 upgrade captures honest baselines with a complete previous backup and no replay on restart',()=>{
  const f=fixture();try {
    const m=f.mail();f.s.finishMailTest(f.a,m.id,'sent','sent123','OK');reply(f,m.id);
    suspendEvidenceTriggers(f.s);f.s.db.exec('DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; DROP TABLE interpretations; DROP TABLE evidence_events; PRAGMA user_version=10');f.reopen();
    assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.rows().length,2);assert.ok(f.rows().every(e=>e.origin==='migration_snapshot'&&JSON.parse(e.context).accountBasis==='unknown'));
    const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,backup=validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8')));
    assert.equal(backup.version,10);assert.equal(backup.data.mailTests!.length,1);assert.equal(backup.data.evidenceEvents,undefined);
    const fresh=fixture();try{fresh.s.restore(backup);assert.equal(fresh.rows().length,2);assert.ok(fresh.rows().every(e=>e.origin==='restore_snapshot'));}finally{fresh.close();}
    const rows=f.rows();f.reopen();assert.deepEqual(f.rows(),rows);
  }finally{f.close();}
});

test('malformed journal backups cannot pass by recomputing the checksum',()=>{
  const f=fixture();try {
    f.mail();const original=f.s.exportBackup();
    for(const change of [(b:any)=>delete b.data.evidenceEvents,(b:any)=>b.data.evidenceEvents[0].sourceRevision=2,(b:any)=>b.data.evidenceEvents[0].clientId='missing',
      (b:any)=>b.data.evidenceEvents[0].payload='{}',(b:any)=>b.data.evidenceEvents[0].context='{}',(b:any)=>b.data.evidenceEvents.push({...b.data.evidenceEvents[0]}),
      (b:any)=>b.version=10,(b:any)=>b.data.evidenceEvents[0].context=JSON.stringify({...JSON.parse(b.data.evidenceEvents[0].context),mailId:randomUUID()})]) {
      const copy=structuredClone(original);change(copy);assert.throws(()=>validateBackup(resign(copy)),/Ereignis/);
    }
    assert.deepEqual(f.s.exportBackup().data,original.data);
  }finally{f.close();}
});

test('journal API is read-only, customer scoped, bounded and stable while new rows arrive',async()=>{
  const f=fixture(),token='e'.repeat(64);const m=f.mail();
  for(let i=0;i<61;i++)f.s.db.prepare('UPDATE mail_tests SET result=? WHERE id=?').run('Observation '+i,m.id);
  const other=f.mail(f.b),service=await startServer(f.s,token,600000);
  const get=(client:string,suffix='',auth=true)=>fetch(service.url+`/api/clients/${client}/evidence-journal${suffix}`,{headers:auth?{Authorization:`Bearer ${token}`}:{}});
  try {
    assert.equal((await get(f.a,'',false)).status,401);const first=await(await get(f.a)).json();assert.equal(first.rows.length,50);assert.ok(first.nextBefore);
    f.s.db.prepare("UPDATE mail_tests SET result='new' WHERE id=?").run(m.id);
    const second=await(await get(f.a,`?before=${first.nextBefore}&through=${first.through}`)).json();assert.equal(second.rows.length,12);assert.equal(second.nextBefore,null);
    assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,62);assert.ok(first.rows.every((r:any)=>r.clientId===f.a&&r.sourceId!==other.id));
    assert.equal((await(await get(f.b)).json()).rows.length,1);assert.equal((await get(f.a,'?before=-1')).status,400);
    const before=f.s.exportBackup().data;await get(f.a);assert.deepEqual(f.s.exportBackup().data,before);
  }finally{await service.close();rmSync(f.dir,{recursive:true,force:true});}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, AppError } from '../core/store';
import { exportClientEvidence } from '../core/evidence-source';

const at = '2026-09-01T10:00:00Z';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eiz-evidence-source-'));
  const store = new Store(join(dir,'db.sqlite'),join(dir,'backups'),false);
  const client = (name: string) => store.createClient({name,website:'https://example.com',email:'test@example.com',notes:''}).id;
  const a = client('A'), b = client('B');
  const mail = (id: string, owner = a, status = 'sent', time = at) => store.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,owner,'box','private-sender','private-recipient','private-subject','private-body',id,status,'private-provider','private-result',at,time);
  const incoming = (id: string, mailId: string, kind: string, owner = a) => store.db.prepare('INSERT INTO incoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,owner,mailId,'box',id,'private-thread','private-sender','private-subject','private-excerpt',at,kind,'open','private-evidence',at,'private-recipient');
  const queue = (id: string, runOwner: string, leadOwner: string, campaignOwner = runOwner) => {
    const leadId='lead-'+id, campaignId='campaign-'+id, runId='run-'+id;
    store.db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(leadId,leadOwner,id+'@example.com','','','','','',at,0,'');
    store.db.prepare('INSERT INTO campaigns VALUES (?,?,?,?,?,?,?,?)').run(campaignId,campaignOwner,1,'{}',null,null,at,at);
    store.db.prepare('INSERT INTO queue_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(runId,runOwner,campaignId,id,'{}','paused',1,at,at,'','rehearsal');
    store.db.prepare('INSERT INTO queue_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,runId,leadId,'private-recipient',1,'private-subject','private-body','sent',null,null,null,'');
  };
  return {store,a,b,mail,incoming,queue,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const records = (csv: string) => csv.split('\r\n').slice(1).map(line=>line.split(','));

test('stored statuses map conservatively, customer scope and read-only semantics hold',()=>{
  const f=fixture();try {
    f.mail('sent');f.mail('failed',f.a,'failed');f.mail('unknown',f.a,'unknown');f.mail('pending',f.a,'sending');f.mail('foreign',f.b);
    f.incoming('reply','sent','reply');f.incoming('automatic','sent','automatic');f.incoming('review','sent','review');f.incoming('future','sent','future');
    const before=JSON.stringify(f.store.exportBackup().data);
    const changes=f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
    const result=exportClientEvidence(f.store,f.a,{});
    assert.equal(result.rowCount,7);
    assert.deepEqual(records(result.csv).map(r=>r[6]).sort(),['reply','sent',...Array(5).fill('unknown')].sort());
    assert.ok(!result.csv.includes('private-'));assert.ok(!result.csv.includes('foreign'));assert.ok(!result.csv.includes('pending'));
    assert.equal(JSON.stringify(f.store.exportBackup().data),before);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n,changes);
    assert.equal(exportClientEvidence(f.store,f.b,{}).rowCount,1);
  }finally{f.close();}
});

test('inconsistent runs, leads, campaigns and incoming references cannot leak foreign identifiers',()=>{
  const f=fixture();try {
    f.mail('good');f.queue('good',f.a,f.a);f.incoming('good-reply','good','reply');
    f.mail('bad-run');f.queue('bad-run',f.b,f.a);
    f.mail('bad-lead');f.queue('bad-lead',f.a,f.b);
    f.mail('bad-campaign');f.queue('bad-campaign',f.a,f.a,f.b);
    f.mail('foreign',f.b);f.queue('foreign',f.b,f.b);f.incoming('bad-mail','foreign','reply');
    const data=new Map(records(exportClientEvidence(f.store,f.a,{}).csv).map(r=>[r[0],r]));
    assert.deepEqual(data.get('mail_tests:good')?.slice(2,5),['','lead-good','campaign-good']);
    assert.deepEqual(data.get('incoming:good-reply')?.slice(2,5),['','lead-good','campaign-good']);
    assert.deepEqual(data.get('mail_tests:bad-run')?.slice(2,5),['','','']);
    assert.deepEqual(data.get('mail_tests:bad-lead')?.slice(2,5),['','','campaign-bad-lead']);
    assert.equal(data.get('mail_tests:bad-campaign')?.[4],'');
    assert.deepEqual(data.get('incoming:bad-mail')?.slice(2,5),['','','']);
  }finally{f.close();}
});

test('filter boundaries use instants and record count ignores quoted line breaks',()=>{
  const f=fixture();try {
    f.mail('line\r\nbreak',f.a,'sent','2026-09-01T12:00:00+02:00');
    f.mail('later',f.a,'failed','2026-09-01T11:00:00Z');
    const result=exportClientEvidence(f.store,f.a,{fromInclusive:at,toExclusive:'2026-09-01T11:00:00Z',kinds:['sent']});
    assert.equal(result.rowCount,1);assert.ok(result.csv.includes('line\r\nbreak'));assert.ok(!result.csv.includes('later'));
    assert.equal(exportClientEvidence(f.store,f.a,{kinds:[]}).rowCount,0);
  }finally{f.close();}
});

test('invalid filters and corrupt timestamps produce safe application errors',()=>{
  const f=fixture();try {
    for(const input of [null,[],{clientId:f.b},{kinds:'sent'},{kinds:['invented']},{fromInclusive:'2026-02-30T00:00:00Z'},{fromInclusive:at,toExclusive:'2026-09-01T09:00:00Z'}]) {
      assert.throws(()=>exportClientEvidence(f.store,f.a,input),AppError);
    }
    assert.throws(()=>exportClientEvidence(f.store,'missing',{}),(e:any)=>e instanceof AppError && e.status===404);
    f.mail('corrupt',f.a,'sent','private-invalid-date');
    assert.throws(()=>exportClientEvidence(f.store,f.a,{}),(e:any)=>e instanceof AppError && !e.message.includes('private-invalid-date'));
  }finally{f.close();}
});

test('source limit counts excluded sending records and never silently truncates',()=>{
  const f=fixture();try {
    f.store.transaction(()=>{for(let i=0;i<50000;i++)f.mail('bulk-'+i,f.a,'sending');});
    assert.equal(exportClientEvidence(f.store,f.a,{}).rowCount,0);
    f.incoming('one-more','bulk-0','reply');
    assert.throws(()=>exportClientEvidence(f.store,f.a,{kinds:[]}),/50000/);
  }finally{f.close();}
});

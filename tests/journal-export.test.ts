import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportJournalCsv,type JournalExportFilter} from '../core/journal-export';
import type {EvidenceEvent} from '../core/evidence-journal';
const id=(n:number)=>`00000000-0000-0000-0000-${n.toString().padStart(12,'0')}`;
const owner=id(100),other=id(101),sourceId=id(102);
const context={mailId:sourceId,runId:null,campaignId:null,campaignFingerprint:null,contactId:null,productId:null,productRevision:null,accountId:null,accountRevision:null,linkRevision:null,accountBasis:'unknown'};
const event=(patch:Partial<EvidenceEvent>={}):EvidenceEvent=>({id:id(1),clientId:owner,source:'mail_tests',sourceId,sourceRevision:1,eventType:'mail_status_observed',origin:'runtime',occurredAt:'2026-09-01T00:00:00Z',recordedAt:'2026-09-01T10:00:00.000Z',timeBasis:'local_status_time',mailboxId:id(103),providerId:'private-provider',payload:JSON.stringify({status:'sending',messageId:`<${sourceId}@workbench.local>`,result:'private-result'}),context:JSON.stringify(context),...patch});
const incoming=(patch:Partial<EvidenceEvent>={})=>event({id:id(4),source:'incoming',sourceId:id(104),eventType:'incoming_observed',timeBasis:'provider_received_time',payload:JSON.stringify({reportedKind:'automatic',threadId:'private-thread',evidence:'{"private":"body"}'}),...patch});
const output=(rows:readonly EvidenceEvent[],filter:Partial<JournalExportFilter>={})=>exportJournalCsv(rows,{clientId:owner,...filter});
const records=(csv:string)=>csv.split('\r\n').slice(1).map(line=>line.split(','));
const header='id,clientId,source,sourceId,sourceRevision,eventType,origin,occurredAt,recordedAt,timeBasis,mailStatus,reportedKind,runId,campaignId,campaignFingerprint,contactId,productId,productRevision,accountId,accountRevision,linkRevision,accountBasis';
test('journal CSV empty data keeps the exact schema and null context fields stay empty',()=>{
  assert.deepEqual(output([]),{csv:header,rowCount:0});
  const cells=records(output([event()]).csv)[0];assert.equal(cells.length,22);assert.deepEqual(cells.slice(12,21),Array(9).fill(''));
});
test('journal CSV selects customer before parsing foreign JSON',()=>{
  const foreign=event({id:id(2),clientId:other,context:'{',payload:'{'});
  assert.equal(output([event(),foreign]).rowCount,1);assert.ok(!output([foreign]).csv.includes(other));
});
test('journal CSV retains sending, unknown, sent and technical incoming as separate observations',()=>{
  const rows=['sending','unknown','sent'].map((status,n)=>event({id:id(n+1),sourceRevision:n+1,payload:JSON.stringify({status,messageId:`<${sourceId}@workbench.local>`,result:'private-result'})}));
  const result=output([...rows,incoming()]);assert.equal(result.rowCount,4);
  assert.deepEqual(records(result.csv).map(c=>c[10]),['sending','unknown','sent','']);
  assert.equal(records(result.csv)[3][11],'automatic');
  for(const value of ['private-',id(103),'messageId','threadId','result','evidence'])assert.ok(!result.csv.includes(value));
});
test('journal CSV preserves migration and restore origins without inferring historical interest',()=>{
  const result=output([event({origin:'migration_snapshot'}),event({id:id(2),origin:'restore_snapshot',sourceRevision:2})]);
  assert.deepEqual(records(result.csv).map(c=>c[6]),['migration_snapshot','restore_snapshot']);
});
test('journal CSV validates filters even with empty data',()=>{
  for(const filter of [{clientId:'bad'},{source:'sent'},{source:[]},{source:''},{timeBasis:'local'},{timeBasis:null},{fromInclusive:''},{fromInclusive:0},{fromInclusive:null},{unknown:true}])assert.throws(()=>output([],filter as any),JSON.stringify(filter));
});
test('journal CSV rejects invalid calendar dates and absent or malformed zones',()=>{
  for(const fromInclusive of ['2026-02-30T10:00:00Z','2026-02-29T10:00:00Z','2026-13-01T10:00:00Z','2026-09-01T24:00:00Z','2026-09-01T10:00:00','2026-09-01T10:00:00+24:00','2026-09-01T10:00:00+01:60'])assert.throws(()=>output([],{fromInclusive}),fromInclusive);
  assert.doesNotThrow(()=>output([],{fromInclusive:'2024-02-29T23:30:00-02:00'}));
  for(const toExclusive of ['2026-09-01T00:00:00Z','2026-08-31T00:00:00Z'])assert.throws(()=>output([],{fromInclusive:'2026-09-01T00:00:00Z',toExclusive}));
});
test('journal CSV compares offsets across midnight and respects both interval boundaries',()=>{
  const result=output([event({recordedAt:'2026-08-31T23:30:00-02:00'}),event({id:id(2),recordedAt:'2026-09-01T02:00:00Z'})],{fromInclusive:'2026-09-01T03:30:00+02:00',toExclusive:'2026-09-01T02:00:00Z'});
  assert.equal(result.rowCount,1);assert.equal(records(result.csv)[0][0],id(1));
});
test('journal CSV switches time basis and source without reclassifying incoming',()=>{
  const rows=[event(),incoming()];
  assert.equal(output(rows,{fromInclusive:'2026-09-01T09:00:00Z'}).rowCount,2);
  assert.equal(output(rows,{fromInclusive:'2026-09-01T09:00:00Z',timeBasis:'occurredAt'}).rowCount,0);
  assert.equal(output(rows,{source:'incoming'}).rowCount,1);assert.equal(output(rows,{source:'mail_tests'}).rowCount,1);
});
test('journal CSV sorts by instant then ID without mutating frozen inputs',()=>{
  const rows=Object.freeze([Object.freeze(event({id:id(3),recordedAt:'2026-09-01T01:00:00-02:00'})),Object.freeze(event({id:id(2),recordedAt:'2026-09-01T02:00:00Z'})),Object.freeze(event({id:id(1),recordedAt:'2026-09-01T04:00:00+02:00'}))]);
  assert.deepEqual(records(output(rows).csv).map(c=>c[0]),[id(1),id(2),id(3)]);assert.equal(rows[0].id,id(3));
});
test('journal CSV rejects damaged identities, timestamps, JSON and schema mismatches rather than dropping them',()=>{
  for(const patch of [{id:'bad'},{sourceRevision:1.5},{sourceRevision:0},{occurredAt:'bad'},{recordedAt:'bad'},{source:'other'},{origin:'inferred'},{eventType:'incoming_observed'},{timeBasis:'provider_received_time'},{context:'null'},{context:'{}'},{context:'{'},{payload:'null'},{payload:'{}'}])assert.throws(()=>output([event(patch as any)]),JSON.stringify(patch));
  assert.throws(()=>output([event(),event()]));
});
test('journal CSV never exports freetext; formula or quote-bearing identities are rejected',()=>{
  const row=event({payload:JSON.stringify({status:'sent',messageId:`<${sourceId}@workbench.local>`,result:'="formula", "quote"\r\nprivate'})});
  assert.equal(records(output([row]).csv)[0].length,22);assert.ok(!output([row]).csv.includes('formula'));
  for(const campaignId of ['=@SUM(1+1)','\u0001=cmd','quote"comma,','id\0'])assert.throws(()=>output([event({context:JSON.stringify({...context,campaignId})})]));
});
test('journal CSV validates nested historical context and preserves fixed product/account revisions',()=>{
  const full={...context,runId:id(110),campaignId:id(111),contactId:id(112),campaignFingerprint:'a'.repeat(64),productId:id(113),productRevision:2,accountId:id(114),accountRevision:3,linkRevision:4,accountBasis:'first_mail_observation'};
  const result=records(output([event({context:JSON.stringify(full)})]).csv)[0];assert.deepEqual(result.slice(16,22),[id(113),'2',id(114),'3','4','first_mail_observation']);
  for(const patch of [{productRevision:null},{accountBasis:'unknown'},{linkRevision:null},{campaignFingerprint:'wrong'},{id:other}])assert.throws(()=>output([event({context:JSON.stringify({...full,...patch})})]));
});
test('journal CSV enforces the customer limit before time/source filters',()=>{
  assert.throws(()=>output(Array.from({length:50001},()=>event()),{source:'incoming'}),/50000/);
  assert.equal(output(Array.from({length:50001},()=>event({clientId:other}))).rowCount,0);
});

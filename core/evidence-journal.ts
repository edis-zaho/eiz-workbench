import {AppError, type Store} from './store';
import type {BackupData} from './types';

export type EvidenceContext = {
  mailId:string; runId:string|null; campaignId:string|null; campaignFingerprint:string|null;
  contactId:string|null; productId:string|null; productRevision:number|null;
  accountId:string|null; accountRevision:number|null; linkRevision:number|null;
  accountBasis:'first_mail_observation'|'unknown';
};
export type EvidenceEvent = {
  id:string; clientId:string; source:'mail_tests'|'incoming'; sourceId:string; sourceRevision:number;
  eventType:'mail_status_observed'|'incoming_observed'; origin:'runtime'|'migration_snapshot'|'restore_snapshot';
  occurredAt:string; recordedAt:string; timeBasis:'local_status_time'|'provider_received_time';
  mailboxId:string; providerId:string; payload:string; context:string;
};
const columns=['id','clientId','source','sourceId','sourceRevision','eventType','origin','occurredAt','recordedAt','timeBasis','mailboxId','providerId','payload','context'] as const;
const triggers=['evidence_mail_insert','evidence_mail_update','evidence_incoming_insert'];
const uuidSql="lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6)))";
const stampSql="strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// All SQL fragments below are internal constants/aliases, never request values.
function emptyContext(mailId:string) {
  return `json_object('mailId',${mailId},'runId',NULL,'campaignId',NULL,'campaignFingerprint',NULL,'contactId',NULL,'productId',NULL,'productRevision',NULL,'accountId',NULL,'accountRevision',NULL,'linkRevision',NULL,'accountBasis','unknown')`;
}
function contextSql(mailId:string,clientId:string,historical:boolean) {
  const account=historical?'NULL':'a.accountId',revision=historical?'NULL':'ar.revision',link=historical?'NULL':'a.revision';
  return `COALESCE(
    (SELECT context FROM evidence_events WHERE source='mail_tests' AND sourceId=${mailId} AND clientId=${clientId} ORDER BY sourceRevision LIMIT 1),
    (SELECT json_object('mailId',q.id,'runId',r.id,'campaignId',r.campaignId,'campaignFingerprint',r.fingerprint,
      'contactId',q.leadId,'productId',json_extract(r.snapshot,'$.content.productRef.productId'),
      'productRevision',json_extract(r.snapshot,'$.content.productRef.revision'),
      'accountId',${account},'accountRevision',${revision},'linkRevision',${link},
      'accountBasis',${historical?"'unknown'":"CASE WHEN a.revision IS NULL THEN 'unknown' ELSE 'first_mail_observation' END"})
     FROM queue_items q JOIN queue_runs r ON r.id=q.runId AND r.clientId=${clientId}
     JOIN campaigns campaign ON campaign.id=r.campaignId AND campaign.clientId=r.clientId
     JOIN leads l ON l.id=q.leadId AND l.clientId=r.clientId
     LEFT JOIN lead_account_links a ON a.leadId=q.leadId AND a.clientId=r.clientId AND a.revision=(SELECT MAX(revision) FROM lead_account_links WHERE leadId=q.leadId AND clientId=r.clientId)
     LEFT JOIN account_revisions ar ON ar.accountId=a.accountId AND ar.clientId=r.clientId AND ar.revision=(SELECT MAX(revision) FROM account_revisions WHERE accountId=a.accountId AND clientId=r.clientId)
     WHERE q.id=${mailId}),${emptyContext(mailId)})`;
}
function observationSelect(source:'mail_tests'|'incoming',alias:string,origin:EvidenceEvent['origin']) {
  const mail=source==='mail_tests',mailId=`${alias}.${mail?'id':'mailId'}`;
  const payload=mail?`json_object('status',${alias}.status,'messageId',${alias}.messageId,'result',${alias}.result)`:
    `json_object('threadId',${alias}.threadId,'reportedKind',${alias}.kind,'evidence',${alias}.evidence)`;
  return `SELECT ${uuidSql},${alias}.clientId,'${source}',${alias}.id,
    COALESCE((SELECT MAX(sourceRevision) FROM evidence_events WHERE source='${source}' AND sourceId=${alias}.id AND clientId=${alias}.clientId),0)+1,
    '${mail?'mail_status_observed':'incoming_observed'}','${origin}',${alias}.${mail?'updatedAt':'receivedAt'},${stampSql},
    '${mail?'local_status_time':'provider_received_time'}',${alias}.mailboxId,${alias}.providerId,${payload},
    ${contextSql(mailId,`${alias}.clientId`,origin!=='runtime')}`;
}
export function installEvidenceTriggers(s:Store) {
  s.db.exec(`CREATE TRIGGER evidence_mail_insert AFTER INSERT ON mail_tests BEGIN
    INSERT INTO evidence_events ${observationSelect('mail_tests','NEW','runtime')}; END;
    CREATE TRIGGER evidence_mail_update AFTER UPDATE OF status,providerId,result ON mail_tests
    WHEN OLD.status IS NOT NEW.status OR OLD.providerId IS NOT NEW.providerId OR OLD.result IS NOT NEW.result BEGIN
    INSERT INTO evidence_events ${observationSelect('mail_tests','NEW','runtime')}; END;
    CREATE TRIGGER evidence_incoming_insert AFTER INSERT ON incoming
    WHEN NOT EXISTS(SELECT 1 FROM evidence_events WHERE source='incoming' AND clientId=NEW.clientId AND mailboxId=NEW.mailboxId AND providerId=NEW.providerId) BEGIN
    INSERT INTO evidence_events ${observationSelect('incoming','NEW','runtime')}; END;`);
}
export function suspendEvidenceTriggers(s:Store) {for(const name of triggers)s.db.exec(`DROP TRIGGER ${name}`);}

function captureExisting(s:Store,origin:'migration_snapshot'|'restore_snapshot') {
  s.db.exec(`INSERT INTO evidence_events ${observationSelect('mail_tests','m',origin)} FROM mail_tests m
    WHERE NOT EXISTS(SELECT 1 FROM evidence_events e WHERE e.source='mail_tests' AND e.sourceId=m.id AND e.clientId=m.clientId
      AND e.sourceRevision=(SELECT MAX(sourceRevision) FROM evidence_events WHERE source='mail_tests' AND sourceId=m.id AND clientId=m.clientId)
      AND json_extract(e.payload,'$.status')=m.status AND e.providerId=m.providerId AND json_extract(e.payload,'$.result')=m.result);
    INSERT INTO evidence_events ${observationSelect('incoming','i',origin)} FROM incoming i
    WHERE i.rowid=(SELECT MIN(x.rowid) FROM incoming x WHERE x.clientId=i.clientId AND x.mailboxId=i.mailboxId AND x.providerId=i.providerId)
    AND NOT EXISTS(SELECT 1 FROM evidence_events e WHERE e.source='incoming' AND e.clientId=i.clientId AND e.mailboxId=i.mailboxId AND e.providerId=i.providerId);`);
}
export function migrateEvidence(s:Store) {
  s.db.exec(`CREATE TABLE evidence_events(
    id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),source TEXT NOT NULL CHECK(source IN ('mail_tests','incoming')),
    sourceId TEXT NOT NULL,sourceRevision INTEGER NOT NULL CHECK(sourceRevision>0),eventType TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('runtime','migration_snapshot','restore_snapshot')),
    occurredAt TEXT NOT NULL,recordedAt TEXT NOT NULL,timeBasis TEXT NOT NULL,mailboxId TEXT NOT NULL,providerId TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),context TEXT NOT NULL CHECK(json_valid(context)),UNIQUE(clientId,source,sourceId,sourceRevision));
    CREATE INDEX evidence_client ON evidence_events(clientId);
    CREATE UNIQUE INDEX evidence_incoming_unique ON evidence_events(clientId,mailboxId,providerId) WHERE source='incoming';
    CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence_events BEGIN SELECT RAISE(ABORT,'Evidence cannot be overwritten'); END;
    CREATE TRIGGER evidence_capacity BEFORE INSERT ON evidence_events WHEN (SELECT MAX(rowid) FROM evidence_events)>=1000000
    BEGIN SELECT RAISE(ABORT,'Evidence capacity reached; expand storage before continuing'); END;`);
  captureExisting(s,'migration_snapshot');
  installEvidenceTriggers(s);
  s.db.exec('PRAGMA user_version=11');
}
export function exportEvidenceJournal(s:Store):EvidenceEvent[] {return s.db.prepare('SELECT * FROM evidence_events ORDER BY recordedAt,id').all() as unknown as EvidenceEvent[];}

const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
function bad():never {throw new AppError('Ungültige oder widersprüchliche Ereignishistorie.');}
function exact(value:any,keys:readonly string[]) {if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))bad();}
function validateRows(rows:EvidenceEvent[],clients:Set<string>) {
  if(!Array.isArray(rows)||rows.length>1000000)bad();
  const ids=new Set<string>(),sources=new Map<string,number[]>(),incoming=new Set<string>();
  for(const e of rows) {
    exact(e,columns);
    if(!uuid(e.id)||ids.has(e.id)||!clients.has(e.clientId)||!uuid(e.sourceId)||!positive(e.sourceRevision)||!['mail_tests','incoming'].includes(e.source)||!['runtime','migration_snapshot','restore_snapshot'].includes(e.origin)||!time(e.occurredAt)||!time(e.recordedAt)||new Date(e.recordedAt).toISOString()!==e.recordedAt||!uuid(e.mailboxId)||!text(e.providerId,255)||!text(e.payload,24000)||!text(e.context,2000))bad();
    ids.add(e.id);const key=JSON.stringify([e.clientId,e.source,e.sourceId]);const revs=sources.get(key)||[];revs.push(e.sourceRevision);sources.set(key,revs);
    let p:any,c:EvidenceContext;try{p=JSON.parse(e.payload);c=JSON.parse(e.context);}catch{bad();}
    exact(c,['mailId','runId','campaignId','campaignFingerprint','contactId','productId','productRevision','accountId','accountRevision','linkRevision','accountBasis']);
    if(!uuid(c.mailId)||!['first_mail_observation','unknown'].includes(c.accountBasis))bad();
    for(const k of ['runId','campaignId','contactId','productId','accountId'] as const)if(c[k]!==null&&!uuid(c[k]))bad();
    for(const k of ['productRevision','accountRevision','linkRevision'] as const)if(c[k]!==null&&!positive(c[k]))bad();
    if((c.productId===null)!==(c.productRevision===null)||(c.accountId===null)!==(c.accountRevision===null)||(c.runId===null)!==(c.campaignId===null)||(c.runId===null)!==(c.contactId===null))bad();
    if(c.runId===null&&(c.campaignFingerprint!==null||c.productId!==null||c.accountId!==null||c.linkRevision!==null))bad();
    if(c.runId!==null&&(typeof c.campaignFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(c.campaignFingerprint)))bad();
    if(c.accountBasis==='unknown'&&(c.accountId!==null||c.linkRevision!==null)||c.accountBasis==='first_mail_observation'&&c.linkRevision===null)bad();
    if(e.source==='mail_tests') {
      exact(p,['status','messageId','result']);
      if(e.eventType!=='mail_status_observed'||e.timeBasis!=='local_status_time'||c.mailId!==e.sourceId||!['sending','sent','failed','unknown'].includes(p.status)||p.messageId!==`<${e.sourceId}@workbench.local>`||!text(p.result,2000))bad();
    } else {
      exact(p,['threadId','reportedKind','evidence']);
      if(e.eventType!=='incoming_observed'||e.timeBasis!=='provider_received_time'||e.sourceRevision!==1||!text(p.threadId,200)||!/^[a-zA-Z0-9_-]+$/.test(p.threadId)||!/^[a-zA-Z0-9_-]{1,200}$/.test(e.providerId)||!['reply','automatic','review'].includes(p.reportedKind)||!text(p.evidence,10000))bad();
      try{JSON.parse(p.evidence);}catch{bad();}
      const unique=JSON.stringify([e.clientId,e.mailboxId,e.providerId]);if(incoming.has(unique))bad();incoming.add(unique);
    }
  }
  for(const revs of sources.values())if(revs.sort((a,b)=>a-b).some((r,i)=>r!==i+1))bad();
}
export function validateEvidenceBackup(data:BackupData,version:number) {
  if(data.evidenceEvents===undefined&&version<11)return;
  if(!Array.isArray(data.evidenceEvents)||version<11&&data.evidenceEvents.length)bad();
  validateRows(data.evidenceEvents,new Set(data.clients.map(c=>c.id)));
  // References are historical snapshots. A missing source is allowed after an older
  // restore; an existing source/entity belonging to another customer is never allowed.
  const maps=[data.mailTests||[],data.queueRuns||[],data.campaigns||[],data.leads||[],data.products||[],data.accounts||[]].map(rows=>new Map(rows.map(r=>[r.id,r.clientId])));
  const mails=new Map((data.mailTests||[]).map(m=>[m.id,m]));
  const inputs=new Map((data.incoming||[]).map(i=>[i.id,i]));
  const runs=new Map((data.queueRuns||[]).map(r=>[r.id,r]));
  const items=new Map((data.queueItems||[]).map(q=>[q.id,q]));
  const products=new Set((data.productRevisions||[]).map(p=>JSON.stringify([p.clientId,p.productId,p.revision])));
  const accounts=new Set((data.accountRevisions||[]).map(a=>JSON.stringify([a.clientId,a.accountId,a.revision])));
  const links=new Map((data.leadAccountLinks||[]).map(l=>[JSON.stringify([l.clientId,l.leadId,l.revision]),l]));
  const first=new Map(data.evidenceEvents.filter(e=>e.source==='mail_tests'&&e.sourceRevision===1).map(e=>[JSON.stringify([e.clientId,e.sourceId]),e]));
  for(const e of data.evidenceEvents) {
    const c=JSON.parse(e.context) as EvidenceContext;
    for(const [i,id] of [c.mailId,c.runId,c.campaignId,c.contactId,c.productId,c.accountId].entries())if(id&&maps[i].has(id)&&maps[i].get(id)!==e.clientId)bad();
    if(c.productId&&maps[4].has(c.productId)&&!products.has(JSON.stringify([e.clientId,c.productId,c.productRevision])))bad();
    if(c.accountId&&maps[5].has(c.accountId)&&!accounts.has(JSON.stringify([e.clientId,c.accountId,c.accountRevision])))bad();
    if(c.linkRevision!==null&&maps[3].has(c.contactId!)) {
      const link=links.get(JSON.stringify([e.clientId,c.contactId,c.linkRevision]));if(!link||link.accountId!==c.accountId)bad();
    }
    const original=first.get(JSON.stringify([e.clientId,c.mailId]));if(original&&original.context!==e.context)bad();
    const mail=mails.get(c.mailId);if(mail&&mail.mailboxId!==e.mailboxId)bad();
    if(e.source==='incoming') {
      const source=inputs.get(e.sourceId);if(source&&(source.clientId!==e.clientId||source.mailId!==c.mailId||source.mailboxId!==e.mailboxId||source.providerId!==e.providerId))bad();
    }
    if(c.runId&&runs.has(c.runId)) {
      const run=runs.get(c.runId)!,item=items.get(c.mailId),ref=JSON.parse(run.snapshot).content.productRef;
      if(!item||item.runId!==run.id||item.leadId!==c.contactId||run.campaignId!==c.campaignId||run.fingerprint!==c.campaignFingerprint||(ref?.productId??null)!==c.productId||(ref?.revision??null)!==c.productRevision)bad();
    }
  }
}
export function mergedEvidenceForRestore(s:Store,data:BackupData):EvidenceEvent[] {
  const merged=new Map((data.evidenceEvents||[]).map(e=>[e.id,e]));
  for(const row of exportEvidenceJournal(s)) {
    const previous=merged.get(row.id);
    if(previous&&columns.some(k=>previous[k]!==row[k]))throw new AppError('Sicherung widerspricht einer bereits gespeicherten Beobachtung.');
    merged.set(row.id,row);
  }
  const rows=[...merged.values()];
  validateEvidenceBackup({...data,evidenceEvents:rows},11);
  return rows.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
}
export function restoreEvidenceJournal(s:Store,rows:EvidenceEvent[]) {
  const stmt=s.db.prepare(`INSERT INTO evidence_events (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for(const row of rows)stmt.run(...columns.map(k=>row[k]));
  captureExisting(s,'restore_snapshot');
  installEvidenceTriggers(s);
}

export function evidenceJournal(s:Store,clientId:string,input:{before?:unknown;through?:unknown}={}) {
  s.client(clientId);
  const cursor=(value:unknown)=>{if(typeof value!=='string'||!/^\d{1,16}$/.test(value)||!Number.isSafeInteger(Number(value)))throw new AppError('Ungültige Journalseite.');return Number(value);};
  const through=input.through===undefined?Number(s.db.prepare('SELECT MAX(rowid) AS n FROM evidence_events WHERE clientId=?').get(clientId)?.n||0):cursor(input.through);
  const before=input.before===undefined?Number.MAX_SAFE_INTEGER:cursor(input.before);
  const rows=s.db.prepare('SELECT rowid AS cursor,* FROM evidence_events WHERE clientId=? AND rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT 51').all(clientId,through,before) as unknown as (EvidenceEvent&{cursor:number})[];
  const page=rows.slice(0,50);
  return {through:String(through),nextBefore:rows.length>50?String(page.at(-1)!.cursor):null,
    rows:page.map(row=>{
      const context=JSON.parse(row.context) as EvidenceContext;
      const product=context.productId?s.db.prepare('SELECT name FROM product_revisions WHERE productId=? AND revision=? AND clientId=?').get(context.productId,context.productRevision,clientId):null;
      return {...row,context,payload:JSON.parse(row.payload),productName:product?String(product.name):null};
    }),
    notes:['Technische Beobachtungen: Versandannahme ist kein Zustellbeweis; ein Eingang ist kein Nachweis für menschliches Interesse.',
      'Übernommener Bestand enthält keine rekonstruierten früheren Statuswechsel. Unternehmensbezüge gelten zum ersten erfassten Versand; unbekannte Bezüge bleiben leer.',
      'Quellenzeit und Erfassungszeit sind getrennt. KI-Interpretationen und automatische Signalreaktionen folgen in einem weiteren Baustein.']};
}

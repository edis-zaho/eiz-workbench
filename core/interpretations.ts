import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData} from './types';
import type {EvidenceEvent} from './evidence-journal';
import {exactObject,cleanText,interpretationContent} from './interpretation-input';

export type Interpretation = {
  id:string;clientId:string;eventId:string;revision:number;previousId:string|null;
  origin:'human'|'model';actor:string;provider:string;model:string;promptVersion:string;
  eventHash:string;sourceSnapshot:string;content:string;createdAt:string;
};
type Producer = {origin:'human'|'model';actor:string;provider:string;model:string;promptVersion:string};
const columns=['id','clientId','eventId','revision','previousId','origin','actor','provider','model','promptVersion','eventHash','sourceSnapshot','content','createdAt'] as const;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function bad():never {throw new AppError('Ungültige oder widersprüchliche Bewertungshistorie.');}
export function evidenceHash(event:EvidenceEvent) {
  const keys=['id','clientId','source','sourceId','sourceRevision','eventType','origin','occurredAt','recordedAt','timeBasis','mailboxId','providerId','payload','context'] as const;
  return createHash('sha256').update(JSON.stringify(keys.map(k=>event[k]))).digest('hex');
}
function validateProducer(p:Producer) {
  if(!['human','model'].includes(p.origin)||cleanText(p.actor,120)!==p.actor)bad();
  if(p.origin==='human') {if(p.provider!==''||p.model!==''||p.promptVersion!=='')bad();}
  else for(const k of ['provider','model','promptVersion'] as const)if(cleanText(p[k],160)!==p[k])bad();
}
function validateSource(serialized:string) {
  if(typeof serialized!=='string'||serialized.length>16000)bad();
  const v=JSON.parse(serialized);if(v===null)return;
  exactObject(v,['sender','subject','excerpt','receivedAt']);
  for(const [key,max] of [['sender',254],['subject',500],['excerpt',2000],['receivedAt',80]] as const)
    if(typeof v[key]!=='string'||v[key].length>max||v[key].includes('\0'))bad();
  if(!Number.isFinite(Date.parse(v.receivedAt)))bad();
}
export function migrateInterpretations(s:Store) {
  s.db.exec(`CREATE UNIQUE INDEX evidence_id_client ON evidence_events(id,clientId);
    CREATE TABLE interpretations(
      id TEXT PRIMARY KEY,clientId TEXT NOT NULL,eventId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000),previousId TEXT,
      origin TEXT NOT NULL CHECK(origin IN ('human','model')),actor TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,promptVersion TEXT NOT NULL,
      eventHash TEXT NOT NULL,sourceSnapshot TEXT NOT NULL CHECK(json_valid(sourceSnapshot)),content TEXT NOT NULL CHECK(json_valid(content)),createdAt TEXT NOT NULL,
      UNIQUE(clientId,eventId,revision),FOREIGN KEY(eventId,clientId) REFERENCES evidence_events(id,clientId));
    CREATE INDEX interpretations_client ON interpretations(clientId);
    CREATE TRIGGER interpretations_no_update BEFORE UPDATE ON interpretations BEGIN SELECT RAISE(ABORT,'Interpretations cannot be overwritten'); END;
    CREATE TRIGGER interpretations_capacity BEFORE INSERT ON interpretations WHEN (SELECT MAX(rowid) FROM interpretations)>=100000
      BEGIN SELECT RAISE(ABORT,'Interpretation capacity reached'); END;
    PRAGMA user_version=12;`);
}
function rawEvent(s:Store,clientId:string,eventId:string):EvidenceEvent {
  s.client(clientId);
  const row=s.db.prepare('SELECT * FROM evidence_events WHERE clientId=? AND id=?').get(clientId,eventId) as EvidenceEvent|undefined;
  if(!row)throw new AppError('Rohereignis nicht gefunden.',404);
  if(row.source!=='incoming')throw new AppError('In diesem Ausbauschritt können nur Eingänge bewertet werden.');
  return row;
}
function sourceFor(s:Store,event:EvidenceEvent) {
  const row=s.db.prepare('SELECT sender,subject,excerpt,receivedAt FROM incoming WHERE clientId=? AND id=? AND mailboxId=? AND providerId=?').get(event.clientId,event.sourceId,event.mailboxId,event.providerId);
  return row?JSON.parse(JSON.stringify(row)):null;
}
function basisHash(event:EvidenceEvent,source:unknown) {return createHash('sha256').update(JSON.stringify([evidenceHash(event),source])).digest('hex');}
export function interpretationHistory(s:Store,clientId:string,eventId:string) {
  const event=rawEvent(s,clientId,eventId);
  const rows=s.db.prepare('SELECT * FROM interpretations WHERE clientId=? AND eventId=? ORDER BY revision DESC LIMIT 1001').all(clientId,eventId) as Interpretation[];
  if(rows.length>1000)bad();
  const source=sourceFor(s,event);
  return {eventId,eventHash:evidenceHash(event),basisHash:basisHash(event,source),revision:rows[0]?.revision||0,source,rows:rows.map(r=>({...r,content:JSON.parse(r.content),sourceSnapshot:JSON.parse(r.sourceSnapshot)}))};
}
// Trusted internal seam for a future model workflow; never exposed as arbitrary producer input over HTTP.
export function appendInterpretation(s:Store,clientId:string,eventId:string,expectedRevision:number,expectedBasisHash:string,content:unknown,producer:Producer,hooks?:{before:()=>void;after:(row:Interpretation)=>void}) {
  let value:ReturnType<typeof interpretationContent>;
  try{value=interpretationContent(content);validateProducer(producer);}catch{bad();}
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=1000)bad();
  return s.transaction(()=>{
    hooks?.before();
    const event=rawEvent(s,clientId,eventId);
    const source=sourceFor(s,event);
    if(typeof expectedBasisHash!=='string'||basisHash(event,source)!==expectedBasisHash)throw new AppError('Der Beleg wurde inzwischen geändert. Verlauf neu laden und erneut prüfen.',409);
    const previous=s.db.prepare('SELECT id,revision FROM interpretations WHERE clientId=? AND eventId=? ORDER BY revision DESC LIMIT 1').get(clientId,eventId);
    if((previous?.revision||0)!==expectedRevision)throw new AppError('Bewertung wurde inzwischen geändert. Verlauf neu laden und erneut prüfen.',409);
    const row:Interpretation={id:randomUUID(),clientId,eventId,revision:expectedRevision+1,previousId:previous?String(previous.id):null,...producer,
      eventHash:evidenceHash(event),sourceSnapshot:JSON.stringify(source),content:JSON.stringify(value),createdAt:new Date().toISOString()};
    validateSource(row.sourceSnapshot);
    s.db.prepare(`INSERT INTO interpretations (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>row[k]));
    hooks?.after(row);
    return {id:row.id,revision:row.revision};
  });
}
export function saveHumanInterpretation(s:Store,clientId:string,eventId:string,input:any) {
  let actor:string;
  try{exactObject(input,['expectedRevision','expectedBasisHash','reviewer','content']);actor=cleanText(input.reviewer,120);}catch{bad();}
  return appendInterpretation(s,clientId,eventId,input.expectedRevision,input.expectedBasisHash,input.content,{origin:'human',actor,provider:'',model:'',promptVersion:''});
}
export function exportInterpretations(s:Store):Interpretation[] {return s.db.prepare('SELECT * FROM interpretations ORDER BY id').all() as Interpretation[];}
export function exportClientInterpretations(s:Store,clientId:string) {
  s.client(clientId);const rows=s.db.prepare('SELECT * FROM interpretations WHERE clientId=? ORDER BY eventId,revision LIMIT 10001').all(clientId) as Interpretation[];
  if(rows.length>10000)throw new AppError('Mehr als 10.000 Bewertungen: vollständige lokale Sicherung verwenden. Export wurde nicht gekürzt.');
  return {filename:'bewertungen.json',rowCount:rows.length,archive:{format:'eiz-interpretations',version:1,clientId,exportedAt:new Date().toISOString(),rows}};
}
export function validateInterpretationBackup(data:BackupData,version:number) {
  if(data.interpretations===undefined&&version<12)return;
  try{
    if(!Array.isArray(data.interpretations)||data.interpretations.length>100000||version<12&&data.interpretations.length)bad();
    const events=new Map((data.evidenceEvents||[]).map(e=>[e.id,e])),ids=new Set<string>(),chains=new Map<string,Interpretation[]>();
    for(const row of data.interpretations) {
      exactObject(row,[...columns]);const event=events.get(row.eventId);
      if(!uuid(row.id)||ids.has(row.id)||!event||event.clientId!==row.clientId||event.source!=='incoming'||!Number.isSafeInteger(row.revision)||row.revision<1||row.revision>1000
        ||(row.previousId!==null&&!uuid(row.previousId))||row.eventHash!==evidenceHash(event)||typeof row.createdAt!=='string'||new Date(row.createdAt).toISOString()!==row.createdAt)bad();
      ids.add(row.id);validateProducer(row);validateSource(row.sourceSnapshot);
      if(typeof row.content!=='string'||row.content.length>16000||JSON.stringify(interpretationContent(JSON.parse(row.content)))!==row.content)bad();
      const chain=chains.get(row.eventId)||[];chain.push(row);chains.set(row.eventId,chain);
    }
    for(const chain of chains.values()) {
      chain.sort((a,b)=>a.revision-b.revision);
      if(chain.some((r,i)=>r.revision!==i+1||r.previousId!==(i?chain[i-1].id:null)))bad();
    }
  }catch{bad();}
}
export function mergedInterpretations(s:Store,data:BackupData,evidence:EvidenceEvent[]) {
  const rows=new Map((data.interpretations||[]).map(r=>[r.id,r]));
  for(const row of exportInterpretations(s)) {
    const existing=rows.get(row.id);if(existing&&columns.some(k=>existing[k]!==row[k]))throw new AppError('Sicherung widerspricht einer bekannten Bewertung.');
    rows.set(row.id,row);
  }
  const merged=[...rows.values()];validateInterpretationBackup({...data,evidenceEvents:evidence,interpretations:merged},12);return merged;
}
export function restoreInterpretations(s:Store,rows:Interpretation[]) {
  const insert=s.db.prepare(`INSERT INTO interpretations (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
  for(const row of rows)insert.run(...columns.map(k=>row[k]));
}

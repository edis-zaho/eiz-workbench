import {validatePermission} from './contact-permission';
import {validateTombstone} from './data-retention';
import {validateCapability} from './model-capabilities';
import {validateTransfer} from './mail-transfer';
import {validateDispatch,validatePriceConfig} from './model-jobs';
import {validateLimits,validateReservation} from './model-budget';
import {validateSenderRecord,validatePresentation} from './mail-presentation';
import {createHash} from 'node:crypto';
import {AppError,type Store} from './store';
import {validateModelProfile} from './model-profiles';

export type PublicKind='presentation'|'profile'|'routes'|'model-run'|'budget'|'price'|'sender'|'transfer'|'permission'|'tombstone'|'capability'|'dispatch';
export type PublicRecord={kind:PublicKind;id:string;clientId:string|null;revision:number;content:any};
export type PublicState={version:1;records:PublicRecord[]};
const kinds:PublicKind[]=['presentation','profile','routes','model-run','budget','price','sender','transfer','permission','tombstone','capability','dispatch'];
export function stableHash(value:unknown):string {
  const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
export function migratePublicSchema(s:Store){
  s.db.exec(`CREATE TABLE IF NOT EXISTS public_records(
    kind TEXT NOT NULL,id TEXT NOT NULL,clientId TEXT,revision INTEGER NOT NULL CHECK(revision>0),
    content TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=34;`);
}
export function publicRecords(s:Store,kind?:PublicKind):PublicRecord[]{
  const rows=kind?s.db.prepare('SELECT * FROM public_records WHERE kind=? ORDER BY id').all(kind):s.db.prepare('SELECT * FROM public_records ORDER BY kind,id').all();
  return rows.map((r:any)=>({...r,content:JSON.parse(r.content)}));
}
export function publicRecord(s:Store,kind:PublicKind,id:string):PublicRecord|undefined {
  const r=s.db.prepare('SELECT * FROM public_records WHERE kind=? AND id=?').get(kind,id) as any;
  return r?{...r,content:JSON.parse(r.content)}:undefined;
}
export function putPublicRecord(s:Store,r:PublicRecord){
  validatePublicRecord(r);
  if(r.clientId)s.client(r.clientId);
  s.db.prepare('INSERT INTO public_records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET clientId=excluded.clientId,revision=excluded.revision,content=excluded.content')
    .run(r.kind,r.id,r.clientId,r.revision,JSON.stringify(r.content));
}
export function validatePublicRecord(r:any):asserts r is PublicRecord {
  if(!r||!kinds.includes(r.kind)||typeof r.id!=='string'||!r.id||r.id.length>180||
    (r.clientId!==null&&(typeof r.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(r.clientId)))||
    !Number.isSafeInteger(r.revision)||r.revision<1||!r.content||typeof r.content!=='object'||Array.isArray(r.content)||
    JSON.stringify(r.content).length>2*1024*1024)throw new AppError('Ungültiger öffentlicher Datenstand.');
  if(Object.keys(r).some(k=>!['kind','id','clientId','revision','content'].includes(k)))throw new AppError('Unbekanntes Datenfeld.');
  if(r.kind==='profile'){
    validateModelProfile(r.content);
    if(r.clientId!==null||r.id!==r.content.id||r.revision!==r.content.revision)throw new AppError('Ungültige Profilzuordnung.');
  }
  if(r.kind==='routes'){
    if(r.id!==r.clientId||typeof r.content.enabled!=='boolean'||!r.content.tasks||typeof r.content.tasks!=='object'||Array.isArray(r.content.tasks)||Object.keys(r.content).some(k=>!['enabled','tasks'].includes(k)))throw new AppError('Ungültige Aufgabenrouten.');
    for(const [key,ref] of Object.entries(r.content.tasks) as [string,any][]){
      if(!['analysis','writing','knowledge','campaign-writing','reply-analysis','reply-writing'].includes(key)||
        !ref||typeof ref.id!=='string'||!/^[a-f0-9-]{36}$/.test(ref.id)||!Number.isSafeInteger(ref.revision)||ref.revision<1)throw new AppError('Ungültige Aufgabenroute.');
    }
  }
  if(r.kind==='sender'){validateSenderRecord(r.content);if(r.id!==r.clientId||r.clientId!==r.content.profile.clientId||r.revision!==r.content.profile.revision)throw new AppError('Absenderzuordnung ungültig.');}
  if(r.kind==='presentation'){validatePresentation(r.content);if(!r.clientId)throw new AppError('Mailkunde fehlt.');}
  if(r.kind==='budget'){validateLimits(r.content);if(r.id!==r.content.currency||r.clientId!==null)throw new AppError('Budgetzuordnung ungültig.');}
  if(r.kind==='model-run'){validateReservation(r.content);if(r.id!==r.content.runId||r.clientId!==r.content.clientId)throw new AppError('Kostenauftrag ungültig.');}
  if(r.kind==='transfer'){validateTransfer(r.content);if(r.clientId!==r.content.clientId)throw new AppError('Freigabekunde ungültig.');}
  if(r.kind==='permission'){validatePermission(r.content);if(r.id!==r.content.leadId||r.revision!==r.content.revision||!r.clientId)throw new AppError('Kontaktgrundlage falsch zugeordnet.');}
  if(r.kind==='tombstone'){validateTombstone(r.content);if(r.clientId!==r.content.clientId)throw new AppError('Löschkunde ungültig.');}
  if(r.kind==='capability'){validateCapability(r.content);if(r.id!==r.content.bindingHash||r.clientId!==null)throw new AppError('Ungültige Testzuordnung.');}
  if(r.kind==='price'){validatePriceConfig(r.content);if(r.clientId!==null)throw new AppError('Preise gelten profilbezogen.');}
  if(r.kind==='dispatch'){validateDispatch(r.content);if(r.clientId!==r.content.clientId||r.id!==r.content.runId)throw new AppError('Falsche Auftragszuordnung.');}
  if(!['profile','routes','sender','presentation','budget','model-run','transfer','price','dispatch','capability','tombstone','permission'].includes(r.kind))throw new AppError('Dieser öffentliche Datensatztyp ist noch nicht unterstützt.');
}
export function exportPublicState(s:Store):PublicState{return {version:1,records:publicRecords(s)};}
export function validatePublicState(input:unknown):PublicState {
  const v=input as PublicState;
  if(!v||v.version!==1||!Array.isArray(v.records)||v.records.length>500000)throw new AppError('Öffentlicher Datenstand fehlt oder ist ungültig.');
  const seen=new Set<string>();
  for(const r of v.records){validatePublicRecord(r);const key=r.kind+':'+r.id;if(seen.has(key))throw new AppError('Doppelter öffentlicher Datensatz.');seen.add(key);}
  return v;
}
export function mergePublicState(s:Store,state:PublicState,clients:Set<string>):PublicState{
  const incoming=validatePublicState(structuredClone(state));
  const records=new Map(incoming.records.map(r=>[r.kind+':'+r.id,r]));
  for(const r of publicRecords(s)){
    if(r.clientId&&!clients.has(r.clientId)){
      if(['model-run','tombstone'].includes(r.kind))throw new AppError('Sicherung würde Kosten- oder Löschhistorie entfernen.');
      continue;
    }
    const key=r.kind+':'+r.id,other=records.get(key);
    // Existing external effects, costs and suppressions outrank an older backup.
    if(!other||r.revision>=other.revision||['model-run','tombstone','budget','dispatch','presentation'].includes(r.kind))records.set(key,r);
  }
  return {version:1,records:[...records.values()]};
}
export function restorePublicState(s:Store,state:PublicState){
  s.db.exec('DELETE FROM public_records');
  for(const source of validatePublicState(state).records){
    const r=structuredClone(source);
    if(r.kind==='profile'){
      r.content.enabled=false;r.content.binding.credentialRef=null;
      const {hash,...binding}=r.content.binding;r.content.binding.hash=stableHash(binding);
    }
    if(r.kind==='routes')r.content.enabled=false;
    if(r.kind==='transfer'){r.content.revokedAt=new Date().toISOString();}
    if(r.kind==='model-run'&&['reserved','running'].includes(r.content.state))r.content.state='unknown';
    if(r.kind==='dispatch'&&['reserved','started'].includes(r.content.state))r.content.state='unknown';
    if(r.kind==='permission'&&r.content.status==='reviewed'){r.content.status='unknown';r.content.reviewedAt=null;}
    if(r.kind==='capability')continue;
    putPublicRecord(s,r);
  }
}

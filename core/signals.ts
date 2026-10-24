import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
import type {EvidenceEvent} from './evidence-journal';
import {evidenceHash} from './interpretations';
import {evidenceAttribution} from './evidence-attribution';
import {exactObject,cleanText} from './interpretation-input';
import {isoTime} from './meeting-input';
import {signalFile,signalItem,signalActor,signalToken,type SignalItem,type SignalFile} from './signal-input';
const RECORDED='SIGNAL_RECORDED',WITHDRAWN='SIGNAL_WITHDRAWN',LIMIT=100000;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const fail=(message='Ungültige oder widersprüchliche Signalhistorie.'):never=>{throw new AppError(message,409);};
type Payload={eventId:string;eventHash:string;source:SignalFile['source'];message:SignalFile['message'];signal:SignalItem;origin:'operator_import'|'relay_pull';actor:string};
export type SignalRecord=Payload&{id:string;clientId:string;recordedAt:string};
type Withdrawal={id:string;clientId:string;signalId:string;actor:string;reason:string;recordedAt:string};
const key=(c:string,p:Payload)=>JSON.stringify([c,p.source.provider,p.source.stream,p.signal.externalId]);
const identity=(p:Payload)=>JSON.stringify({eventId:p.eventId,eventHash:p.eventHash,source:p.source,message:p.message,signal:p.signal});
const decode=(e:LedgerEvent):SignalRecord=>({...JSON.parse(e.text),id:e.id,clientId:e.clientId!,recordedAt:e.createdAt});
function safe<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof AppError)throw e;throw new AppError((e as Error).message);}}
function sources(s:Store,c:string){return s.db.prepare('SELECT * FROM evidence_events WHERE clientId=?').all(c) as EvidenceEvent[];}
function source(s:Store,c:string,eventId:string){s.client(c);const e=s.db.prepare('SELECT * FROM evidence_events WHERE clientId=? AND id=?').get(c,eventId) as EvidenceEvent|undefined;
 if(!e)throw new AppError('Quellbeleg nicht gefunden.',404);if(e.source!=='mail_tests'||JSON.parse(e.payload).status!=='sent'||!e.providerId)fail('Signale benötigen eine bestätigte Versandbeobachtung.');
 // Always bind to the first accepted observation, even if the UI opened a later status revision.
 return s.db.prepare("SELECT * FROM evidence_events WHERE clientId=? AND source='mail_tests' AND sourceId=? AND json_extract(payload,'$.status')='sent' AND providerId<>'' ORDER BY sourceRevision LIMIT 1").get(c,e.sourceId) as EvidenceEvent;
}
function records(s:Store,c:string){s.client(c);const rows=s.db.prepare('SELECT * FROM events WHERE clientId=? AND type IN (?,?) ORDER BY createdAt,id LIMIT ?').all(c,RECORDED,WITHDRAWN,LIMIT*2+1) as LedgerEvent[];
 if(rows.length>LIMIT*2)fail('Signalkapazität überschritten; keine gekürzte Auswertung.');
 const signals=rows.filter(e=>e.type===RECORDED).map(decode);if(signals.length>LIMIT)fail('Mehr als 100.000 Signale pro Kunde.');
 const withdrawals=rows.filter(e=>e.type===WITHDRAWN).map(e=>({...JSON.parse(e.text),id:e.id,clientId:e.clientId!,recordedAt:e.createdAt})) as Withdrawal[];
 return {signals,withdrawals};
}
export function signalBasis(s:Store,c:string,eventId:string){const e=source(s,c,eventId);return {eventId:e.id,eventHash:evidenceHash(e),message:{mailboxId:e.mailboxId,providerMessageId:e.providerId}};}
function prepare(s:Store,c:string,eventId:string,input:any){
 exactObject(input,['file','actor','eventHash']);const file=signalFile(input.file),actor=signalActor(input.actor),basis=signalBasis(s,c,eventId),now=new Date().toISOString();
 if(input.eventHash!==basis.eventHash||file.message.mailboxId!==basis.message.mailboxId||file.message.providerMessageId!==basis.message.providerMessageId)fail('Signaldatei gehört nicht zu diesem Versandbeleg.');
 const current=records(s,c),known=new Map(current.signals.map(r=>[key(c,r),r])),pending=new Map<string,Payload>();let duplicates=0;
 for(const signal of file.events){if(signal.capturedAt>now)fail('Signalzeit liegt in der Zukunft.');
  const p:Payload={eventId:basis.eventId,eventHash:basis.eventHash,source:file.source,message:file.message,signal,origin:'operator_import',actor},k=key(c,p),old=known.get(k)||pending.get(k);
  if(old){if(identity(old)!==identity(p))fail('Dieselbe Quellenkennung enthält widersprüchliche Signaldaten. Gesamter Import verworfen.');duplicates++;}else pending.set(k,p);
 }
 if(current.signals.length+pending.size>LIMIT)fail('100.000 Signale pro Kunde erreicht. Kapazität vor weiterem Import erweitern.');
 const digest=createHash('sha256').update(JSON.stringify({file,actor,eventHash:basis.eventHash,eventId:basis.eventId})).digest('hex');
 return {basis,file,actor,pending,digest,duplicates};
}
export function previewSignals(s:Store,c:string,eventId:string,input:any){return safe(()=>{const p=prepare(s,c,eventId,input);return {digest:p.digest,newSignals:p.pending.size,duplicates:p.duplicates,opens:p.file.events.filter(e=>e.kind==='open').length,clicks:p.file.events.filter(e=>e.kind==='click').length,source:p.file.source,message:p.basis.message};});}
export function importSignals(s:Store,c:string,eventId:string,input:any){return safe(()=>s.transaction(()=>{
 exactObject(input,['file','actor','eventHash','digest','confirmed']);if(input.confirmed!==true)fail('Signalimport ausdrücklich bestätigen.');
 const p=prepare(s,c,eventId,{file:input.file,actor:input.actor,eventHash:input.eventHash});if(input.digest!==p.digest)fail('Importvorschau ist veraltet. Bitte erneut prüfen.');
 const at=new Date().toISOString(),stmt=s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)');for(const payload of p.pending.values())stmt.run(randomUUID(),c,null,RECORDED,JSON.stringify(payload),at);
 return {inserted:p.pending.size,duplicates:p.duplicates};
}));}
// Native relay pages share one known-ID index and one transaction across all messages.
export function recordRelayBatch(s:Store,c:string,files:{eventId:string;eventHash:string;file:SignalFile}[],at:string){
 const current=records(s,c),known=new Map(current.signals.map(r=>[key(c,r),r])),pending=new Map<string,Payload>();let duplicates=0;
 for(const input of files){const file=signalFile(input.file),basis=signalBasis(s,c,input.eventId);
  if(input.eventHash!==basis.eventHash||file.message.mailboxId!==basis.message.mailboxId||file.message.providerMessageId!==basis.message.providerMessageId)fail('Signaldatei gehört nicht zu diesem Versandbeleg.');
  for(const signal of file.events){if(signal.capturedAt>at)fail('Signalzeit liegt in der Zukunft.');const p:Payload={...basis,source:file.source,signal,origin:'relay_pull',actor:'EiZ Trackingdienst'},k=key(c,p),old=known.get(k)||pending.get(k);
   if(old){if(identity(old)!==identity(p))fail('Dieselbe Quellenkennung enthält widersprüchliche Signaldaten. Gesamte Seite verworfen.');duplicates++;}else pending.set(k,p);
  }
 }
 if(current.signals.length+pending.size>LIMIT)fail('100.000 Signale pro Kunde erreicht.');
 const stmt=s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)');for(const p of pending.values())stmt.run(randomUUID(),c,null,RECORDED,JSON.stringify(p),at);
 return {inserted:pending.size,duplicates};
}
export function withdrawSignal(s:Store,c:string,id:string,input:any){return safe(()=>s.transaction(()=>{
 exactObject(input,['actor','reason','confirmed']);if(input.confirmed!==true)fail('Widerruf ausdrücklich bestätigen.');const actor=signalActor(input.actor),reason=cleanText(input.reason,1000),r=records(s,c);
 if(!r.signals.some(e=>e.id===id))throw new AppError('Signal nicht gefunden.',404);const old=r.withdrawals.find(e=>e.signalId===id);if(old)return {id:old.id,alreadyWithdrawn:true};
 const withdrawalId=randomUUID();s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(withdrawalId,c,null,WITHDRAWN,JSON.stringify({signalId:id,actor,reason}),new Date().toISOString());return {id:withdrawalId,alreadyWithdrawn:false};
}));}
export function signalOverview(s:Store,c:string){const history=records(s,c),withdrawn=new Set(history.withdrawals.map(w=>w.signalId)),all=sources(s,c),byId=new Map(all.map(e=>[e.id,e])),resolve=evidenceAttribution(s,c,all);
 const rows=history.signals.map(r=>{const e=byId.get(r.eventId);return {...r,withdrawn:withdrawn.has(r.id),attribution:e?resolve(e):null};}).sort((a,b)=>a.signal.occurredAt.localeCompare(b.signal.occurredAt)||a.id.localeCompare(b.id));
 const active=rows.filter(r=>!r.withdrawn),unflagged=active.filter(r=>r.signal.flags.length===0),opens=unflagged.filter(r=>r.signal.kind==='open');
 const groups=new Map<string,typeof opens>();for(const r of opens){const k=JSON.stringify([r.source.provider,r.source.stream,r.eventId]);const group=groups.get(k)||[];group.push(r);groups.set(k,group);}
 return {format:'eiz-signal-journal' as const,version:1,clientId:c,generatedAt:new Date().toISOString(),rows,withdrawals:history.withdrawals,
 summary:{stored:rows.length,withdrawn:rows.length-active.length,active:active.length,opens:active.filter(r=>r.signal.kind==='open').length,clicks:active.filter(r=>r.signal.kind==='click').length,flagged:active.length-unflagged.length,unflagged:unflagged.length},
 repeatedOpens:[...groups.values()].map(group=>({eventId:group[0].eventId,source:group[0].source,observations:group.length,distinctTimes:new Set(group.map(r=>r.signal.occurredAt)).size,utcDays:new Set(group.map(r=>r.signal.occurredAt.slice(0,10))).size,firstAt:group[0].signal.occurredAt,lastAt:group.at(-1)!.signal.occurredAt})),
 notes:['Importierte Quellenangaben sind nicht unabhängig verifiziert. Ohne Automatikmerkmal bedeutet unbekannt, nicht menschlich.', 'Öffnungen und Klicks beweisen weder Lesen, Weiterleitung, Besuchsdauer noch Kaufabsicht. Unterschiedliche Zeiten bleiben ein unsicheres Signal.', 'Deduplizierung gilt für Anbieter, Datenstrom und Ereigniskennung pro Kunde. Verschiedene Quellen können dieselbe Aktivität melden; Summen sind keine Personen- oder Öffnungsrate.', 'Zeitverteilung verwendet UTC; widerrufene Ereignisse bleiben im Verlauf, zählen aber nicht in aktiven Signalen. Wiederholungsmuster schließen markierte Proxy-/Automatikabrufe aus.', 'Dateiimport und automatische Relay-Abholung sind als Herkunft getrennt. Der Abholstand steht beim Trackingdienst; keine Aussage über Vollständigkeit vor dessen Erfassung und keine automatischen Signalreaktionen.']};
}
export function validateSignals(data:BackupData,version:number){safe(()=>{
 const rows=data.events.filter(e=>e.type.startsWith('SIGNAL_'));if(rows.length&&version<31)fail();const clients=new Set(data.clients.map(c=>c.id)),raw=new Map((data.evidenceEvents||[]).map(e=>[e.id,e])),ids=new Set<string>(),keys=new Set<string>(),signals=new Map<string,LedgerEvent>(),counts=new Map<string,number>(),withdrawn=new Set<string>();
 const firstAccepted=new Map<string,EvidenceEvent>();for(const e of raw.values()){if(e.source!=='mail_tests'||!e.providerId||JSON.parse(e.payload).status!=='sent')continue;const k=JSON.stringify([e.clientId,e.sourceId]),old=firstAccepted.get(k);if(!old||old.sourceRevision>e.sourceRevision)firstAccepted.set(k,e);}
 for(const e of rows){if(!uuid(e.id)||ids.has(e.id)||!e.clientId||!clients.has(e.clientId)||e.jobId!==null||![RECORDED,WITHDRAWN].includes(e.type))return fail();ids.add(e.id);isoTime(e.createdAt);
  const p=JSON.parse(e.text);if(e.type===RECORDED){exactObject(p,['eventId','eventHash','source','message','signal','origin','actor']);exactObject(p.source,['provider','stream']);exactObject(p.message,['mailboxId','providerMessageId']);const source=raw.get(p.eventId);
   if(!source||source.clientId!==e.clientId||source.source!=='mail_tests'||JSON.parse(source.payload).status!=='sent'||!source.providerId||firstAccepted.get(JSON.stringify([source.clientId,source.sourceId]))?.id!==source.id||p.eventHash!==evidenceHash(source)||p.message.mailboxId!==source.mailboxId||p.message.providerMessageId!==source.providerId||!(p.origin==='operator_import'||version>=32&&p.origin==='relay_pull'&&p.source.provider==='eiz-relay-v1'&&p.actor==='EiZ Trackingdienst')||!signalToken(p.source.provider)||!signalToken(p.source.stream)||signalActor(p.actor)!==p.actor)fail();
   const normalized=signalItem(p.signal);if(JSON.stringify(normalized)!==JSON.stringify(p.signal)||p.signal.capturedAt>e.createdAt)fail();const k=key(e.clientId,p);if(keys.has(k))fail();keys.add(k);signals.set(e.id,e);const n=(counts.get(e.clientId)||0)+1;if(n>LIMIT)fail();counts.set(e.clientId,n);
  }else{exactObject(p,['signalId','actor','reason']);if(!uuid(p.signalId)||signalActor(p.actor)!==p.actor||cleanText(p.reason,1000)!==p.reason||withdrawn.has(p.signalId))fail();withdrawn.add(p.signalId);}
 }
 for(const e of rows.filter(e=>e.type===WITHDRAWN)){const p=JSON.parse(e.text),signal=signals.get(p.signalId);if(!signal||signal.clientId!==e.clientId||signal.createdAt>e.createdAt)fail();}
 });}
export function mergeSignals(s:Store,data:BackupData){const rows=new Map(data.events.map(e=>[e.id,e]));for(const e of s.db.prepare("SELECT * FROM events WHERE type LIKE 'SIGNAL_%'").all() as LedgerEvent[]){const old=rows.get(e.id);if(old&&(['clientId','jobId','type','text','createdAt'] as const).some(k=>old[k]!==e[k]))fail('Sicherung widerspricht einem bekannten Signalbeleg.');rows.set(e.id,e);}const merged={...data,events:[...rows.values()]};validateSignals(merged,32);return merged.events;}

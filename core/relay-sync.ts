import {assertTrackingObservations} from './tracking';
import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
import {exactObject} from './interpretation-input';
import {uuid,utc,host} from '../relay/contract';
import {signalActor} from './signal-input';
import {signalBasis,recordRelayBatch} from './signals';
import {evidenceHash} from './interpretations';
import {relayImportFiles} from './relay-import';
const BOUND='RELAY_BOUND',PAGE='RELAY_PAGE',LIMIT=100000;
function fail(m='Ungültige Trackinghistorie.'):never{throw new AppError(m,409);}
type Identity={baseURL:string;stream:string;instanceId:string};
type Binding={stream:string;messageRef:string;eventId:string;eventHash:string;message:{mailboxId:string;providerMessageId:string};actor:string};
type Policy={identity:Identity;enabled:boolean;revision:string;clientVersion:number;lastAt:string|null;lastError:string;nextAt:string};
function identity(v:any):Identity{exactObject(v,['baseURL','stream','instanceId']);let u:URL;try{u=new URL(v.baseURL);}catch{return fail();}if(u.origin!==v.baseURL||u.protocol!=='https:'||u.port||!host(u.hostname)||!uuid(v.stream)||!uuid(v.instanceId))fail();return v;}
const same=(a:Identity,b:Identity)=>a.baseURL===b.baseURL&&a.stream===b.stream&&a.instanceId===b.instanceId;
function rows(s:Store,c:string){s.client(c);return s.db.prepare("SELECT * FROM events WHERE clientId=? AND type IN ('RELAY_BOUND','RELAY_PAGE') ORDER BY createdAt,id").all(c) as LedgerEvent[];}
const parse=(e:LedgerEvent)=>JSON.parse(e.text);
const policyKey=(c:string)=>'relay-policy:'+c;
function policy(s:Store,c:string):Policy|null{const r=s.db.prepare('SELECT value FROM meta WHERE key=?').get(policyKey(c));return r?JSON.parse(String(r.value)):null;}
function putPolicy(s:Store,c:string,p:Policy){s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(policyKey(c),JSON.stringify(p));}
function cursor(events:LedgerEvent[],i:Identity){const pages=events.filter(e=>e.type===PAGE).map(parse).filter(p=>p.stream===i.stream&&p.instanceId===i.instanceId).sort((a,b)=>a.after-b.after);const last=pages.at(-1);return {after:last?.next??0,...last&&!last.complete?{through:last.through}:{}};}
export function relayState(s:Store,c:string){const events=rows(s,c),p=policy(s,c),client=s.client(c);return {policy:p?{...p,active:p.enabled&&p.clientVersion===client.version&&client.status!=='paused'}:null,bindingCount:events.filter(e=>e.type===BOUND).length,receiptCount:events.filter(e=>e.type===PAGE).length,cursor:p?cursor(events,p.identity):null};}
export function bindRelay(s:Store,c:string,input:any){return s.transaction(()=>{
 exactObject(input,['stream','messageRef','eventId','eventHash','actor','confirmed']);if(input.confirmed!==true||!uuid(input.stream)||!uuid(input.messageRef))fail('Nachrichtenbindung bitte bewusst bestätigen.');
 const basis=signalBasis(s,c,input.eventId);const prepared=s.db.prepare("SELECT clientId,text FROM events WHERE type='TRACKING_PREPARED' AND json_extract(text,'$.identity.stream')=? AND json_extract(text,'$.messageRef')=?").get(input.stream,input.messageRef);if(prepared){const p=JSON.parse(String(prepared.text)),raw=s.db.prepare('SELECT sourceId FROM evidence_events WHERE id=?').get(basis.eventId);if(prepared.clientId!==c||raw?.sourceId!==p.mailId)fail('Referenz gehört bereits zu einer anderen reservierten Nachricht.');}if(basis.eventHash!==input.eventHash)fail('Versandbeleg wurde geändert.');
 const b:Binding={stream:input.stream,messageRef:input.messageRef,...basis,actor:signalActor(input.actor)},events=rows(s,c),existing=events.filter(e=>e.type===BOUND).map(parse).find(r=>r.stream===b.stream&&r.messageRef===b.messageRef);
 if(existing){if(existing.eventId!==b.eventId||existing.eventHash!==b.eventHash)fail('Diese Relay-Referenz ist bereits fest einer anderen Nachricht zugeordnet.');return {alreadyBound:true,binding:existing};}
 if(events.filter(e=>e.type===BOUND).length>=LIMIT)fail('Maximal 100.000 Nachrichtenbindungen pro Kunde.');
 if(s.db.prepare("SELECT id FROM events WHERE type='RELAY_BOUND' AND clientId<>? AND json_extract(text,'$.stream')=? LIMIT 1").get(c,b.stream))fail('Dieser Datenstrom gehört bereits zu einem anderen Kunden.');
 s.event(c,null,BOUND,JSON.stringify(b));return {alreadyBound:false,binding:b};
});}
export function configureRelay(s:Store,c:string,input:any){return s.transaction(()=>{
 exactObject(input,['identity','enabled','clientVersion']);const i=identity(input.identity),client=s.client(c);
 if(typeof input.enabled!=='boolean'||input.clientVersion!==client.version)fail('Kundenstand wurde geändert.');
 if(input.enabled&&client.status==='paused')fail('Kunde ist pausiert.');
 if(input.enabled&&!rows(s,c).some(e=>e.type===BOUND&&parse(e).stream===i.stream))fail('Zuerst eine bestätigte Versandnachricht dem Datenstrom zuordnen.');
 const previous=policy(s,c),p:Policy={identity:i,enabled:input.enabled,clientVersion:client.version,revision:randomUUID(),lastAt:previous&&same(previous.identity,i)?previous.lastAt:null,lastError:'',nextAt:new Date().toISOString()};putPolicy(s,c,p);return relayState(s,c);
});}
export function relayContext(s:Store,c:string,input:any){exactObject(input,['identity']);const i=identity(input.identity),p=policy(s,c),client=s.client(c);if(!p||!p.enabled||p.clientVersion!==client.version||client.status==='paused'||!same(p.identity,i))fail('Signalabholung ist für diese Verbindung nicht freigegeben.');return {revision:p.revision,...cursor(rows(s,c),i)};}
export function acceptRelayPage(s:Store,c:string,input:any){return s.transaction(()=>{
 exactObject(input,['identity','revision','page']);const i=identity(input.identity),context=relayContext(s,c,{identity:i});if(input.revision!==context.revision)fail('Abholfreigabe wurde geändert.');
 const history=rows(s,c),bindings=history.filter(e=>e.type===BOUND).map(parse).filter(b=>b.stream===i.stream) as Binding[];
 let result:ReturnType<typeof relayImportFiles>;try{result=relayImportFiles(input.page,{stream:i.stream,instanceId:i.instanceId,...context},bindings);}catch(e){throw new AppError('Relay-Seite abgewiesen: '+(e as Error).message,409);}
 assertTrackingObservations(s,c,input.page);
 let inserted=0,duplicates=0;const at=new Date().toISOString();
 if(input.page.rows.length){
  if(history.filter(e=>e.type===PAGE).length>=LIMIT)fail('Maximal 100.000 Abholbelege pro Kunde.');
  const saved=recordRelayBatch(s,c,result.files.map(file=>{const b=bindings.find(b=>b.message.mailboxId===file.message.mailboxId&&b.message.providerMessageId===file.message.providerMessageId)!;return {eventId:b.eventId,eventHash:b.eventHash,file};}),at);inserted=saved.inserted;duplicates=saved.duplicates;
  s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(randomUUID(),c,null,PAGE,JSON.stringify(input.page),at);
 }
 const p=policy(s,c)!;putPolicy(s,c,{...p,lastAt:at,lastError:'',nextAt:new Date(Date.now()+(result.complete?60000:1000)).toISOString()});return {inserted,duplicates,complete:result.complete,...relayState(s,c)};
});}
export function failRelay(s:Store,c:string,input:any){exactObject(input,['revision','reason']);const errors:Record<string,string>={unbound:'Eine Relay-Referenz hat keine lokale Nachrichtenbindung. Diese Zuordnung prüfen; keine Seite wird übersprungen.',invalid:'Relay-Seite oder Herkunft widersprüchlich. Dienstkennung, Quellen-IDs und Zuordnungen prüfen.',capacity:'Signalkapazität erreicht. Keine Seite wurde übersprungen.',connection:'Verbindung zum Trackingdienst fehlgeschlagen. Adresse, Zugang und Erreichbarkeit prüfen.',interrupted:'Signalabholung wurde unterbrochen. Bestätigter Fortschritt bleibt erhalten.'};if(!Object.hasOwn(errors,input.reason))fail();const p=policy(s,c);if(p&&p.revision===input.revision)putPolicy(s,c,{...p,lastError:errors[input.reason],nextAt:new Date(Date.now()+300000).toISOString()});return relayState(s,c);}
export function dueRelay(s:Store){return s.db.prepare("SELECT c.id AS clientId FROM clients c JOIN meta m ON m.key='relay-policy:'||c.id WHERE c.status<>'paused' AND json_extract(m.value,'$.enabled')=1 AND json_extract(m.value,'$.clientVersion')=c.version AND json_extract(m.value,'$.nextAt')<=?").all(new Date().toISOString());}
// Validate the complete provenance and cursor chain, including restored histories.
export function validateRelay(data:BackupData,version:number){
 const events=data.events.filter(e=>e.type.startsWith('RELAY_')),signals=data.events.filter(e=>e.type==='SIGNAL_RECORDED'),relaySignals=signals.filter(e=>parse(e).origin==='relay_pull');if(!events.length&&!relaySignals.length)return;
 if(version<32)fail();const clients=new Set(data.clients.map(c=>c.id)),raw=new Map(data.evidenceEvents?.map(e=>[e.id,e])),bindings=new Map<string,Binding>(),owners=new Map<string,string>(),groups=new Map<string,LedgerEvent[]>(),counts=new Map<string,number>(),signalMap=new Map<string,LedgerEvent>(),proven=new Set<string>();
 const bindingKey=(c:string,stream:string,ref:string)=>JSON.stringify([c,stream,ref]);
 const signalKey=(c:string,stream:string,id:string)=>JSON.stringify([c,stream,id]);
 for(const e of signals){const p=parse(e);if(p.source.provider==='eiz-relay-v1')signalMap.set(signalKey(e.clientId!,p.source.stream,p.signal.externalId),e);}
 const firstAccepted=new Map<string,string>();for(const e of raw.values()){if(e.source!=='mail_tests'||!e.providerId||JSON.parse(e.payload).status!=='sent')continue;const k=JSON.stringify([e.clientId,e.sourceId]),old=raw.get(firstAccepted.get(k)||'');if(!old||e.sourceRevision<old.sourceRevision)firstAccepted.set(k,e.id);}
 const eventIds=new Set<string>();
 for(const e of events){if(eventIds.has(e.id))fail();eventIds.add(e.id);if(!uuid(e.id)||!e.clientId||!clients.has(e.clientId)||e.jobId!==null||![BOUND,PAGE].includes(e.type))fail();utc(e.createdAt);const n=(counts.get(e.clientId+e.type)||0)+1;counts.set(e.clientId+e.type,n);if(n>LIMIT)fail();
  const p=parse(e);if(e.type===BOUND){exactObject(p,['stream','messageRef','eventId','eventHash','message','actor']);exactObject(p.message,['mailboxId','providerMessageId']);const source=raw.get(p.eventId),k=bindingKey(e.clientId,p.stream,p.messageRef);if(!uuid(p.stream)||!uuid(p.messageRef)||bindings.has(k)||!source||source.clientId!==e.clientId||source.source!=='mail_tests'||JSON.parse(source.payload).status!=='sent'||!source.providerId||p.eventHash!==evidenceHash(source)||p.message.mailboxId!==source.mailboxId||p.message.providerMessageId!==source.providerId||signalActor(p.actor)!==p.actor)fail();
   if(firstAccepted.get(JSON.stringify([source.clientId,source.sourceId]))!==source.id)fail();
   if(owners.has(p.stream)&&owners.get(p.stream)!==e.clientId)fail();owners.set(p.stream,e.clientId);bindings.set(k,p);
  }else{const k=JSON.stringify([e.clientId,p.stream,p.instanceId]),group=groups.get(k)||[];group.push(e);groups.set(k,group);}
 }
 for(const group of groups.values()){
  group.sort((a,b)=>parse(a).after-parse(b).after);let after=0,through:number|undefined;const first=parse(group[0]),client=group[0].clientId!,matching=[...bindings.entries()].filter(([k,b])=>b.stream===first.stream&&owners.get(b.stream)===client).map(([,b])=>b);
  for(const e of group){const page=parse(e);if(!page.rows?.length)fail();const result=relayImportFiles(page,{stream:first.stream,instanceId:first.instanceId,after,through},matching);
   for(const row of page.rows){const b=bindings.get(bindingKey(client,page.stream,row.messageRef))!,signal=signalMap.get(signalKey(client,page.stream,row.id));if(!signal)fail();const p=parse(signal),expected={externalId:row.id,kind:row.kind,occurredAt:row.occurredAt,capturedAt:row.capturedAt,linkId:row.linkId,flags:[...row.flags].sort()};if(p.eventId!==b.eventId||p.eventHash!==b.eventHash||JSON.stringify(p.message)!==JSON.stringify(b.message)||JSON.stringify(p.signal)!==JSON.stringify(expected)||row.capturedAt>e.createdAt||signal.createdAt>e.createdAt)fail();if(p.origin==='relay_pull'&&signal.createdAt===e.createdAt)proven.add(signal.id);}
   after=result.next;through=result.complete?undefined:result.through;
  }
 }
 if(relaySignals.some(e=>!proven.has(e.id)))fail('Automatisch erfasster Signalbeleg hat keinen passenden Abholnachweis.');
}
export function mergeRelay(s:Store,data:BackupData){const map=new Map(data.events.map(e=>[e.id,e]));for(const e of s.db.prepare("SELECT * FROM events WHERE type LIKE 'RELAY_%'").all() as LedgerEvent[]){const old=map.get(e.id);if(old&&(['clientId','jobId','type','text','createdAt'] as const).some(k=>old[k]!==e[k]))fail('Sicherung widerspricht einer bekannten Relay-Bindung oder Abholung.');map.set(e.id,e);}const merged={...data,events:[...map.values()]};validateRelay(merged,32);return merged.events;}

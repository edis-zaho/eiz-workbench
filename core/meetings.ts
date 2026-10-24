import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
import type {EvidenceEvent} from './evidence-journal';
import {evidenceHash} from './interpretations';
import {exactObject,cleanText} from './interpretation-input';
import {meetingContent,isoTime,type MeetingContent} from './meeting-input';
const TYPE='MEETING_RECORDED',limit=100000;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const fail=(text='Ungültige oder widersprüchliche Terminhistorie.'):never=>{throw new AppError(text,409);};
type Payload={meetingId:string;eventId:string;eventHash:string;reference:string;revision:number;previousId:string|null;origin:'human';content:MeetingContent};
export type MeetingRecord=Payload&{id:string;clientId:string;createdAt:string};
function decode(e:LedgerEvent):MeetingRecord{return {...JSON.parse(e.text),id:e.id,clientId:e.clientId!,createdAt:e.createdAt};}
function raw(s:Store,c:string,id:string){s.client(c);const e=s.db.prepare('SELECT * FROM evidence_events WHERE clientId=? AND id=?').get(c,id) as EvidenceEvent|undefined;if(!e)throw new AppError('Quellbeleg nicht gefunden.',404);if(e.source!=='incoming'&&!(e.source==='mail_tests'&&JSON.parse(e.payload).status==='sent'&&e.providerId))fail('Termin benötigt einen Eingang oder eine bestätigte Versandbeobachtung.');return e;}
export function meetingRecords(s:Store,c:string){s.client(c);const rows=s.db.prepare('SELECT * FROM events WHERE clientId=? AND type=? ORDER BY id LIMIT ?').all(c,TYPE,limit+1) as LedgerEvent[];if(rows.length>limit)fail('Mehr als 100.000 Terminversionen: keine gekürzte Auswertung.');return rows.map(decode);}
export function latestMeetings(rows:MeetingRecord[]){const latest=new Map<string,MeetingRecord>();for(const r of rows){const old=latest.get(r.meetingId);if(!old||old.revision<r.revision)latest.set(r.meetingId,r);}return [...latest.values()];}
export function meetingOverview(s:Store,c:string){const history=meetingRecords(s,c),now=new Date().toISOString();return {format:'eiz-meetings' as const,version:1,clientId:c,generatedAt:now,history,current:latestMeetings(history).sort((a,b)=>a.content.scheduledAt.localeCompare(b.content.scheduledAt)).map(r=>({...r,attendanceUnverified:!r.content.withdrawn&&(r.content.status==='held_unverified'||['booked','rescheduled'].includes(r.content.status)&&r.content.scheduledAt<now)}))};}
export function meetingBasis(s:Store,c:string,eventId:string){const e=raw(s,c,eventId),rows=meetingRecords(s,c).filter(r=>r.eventId===eventId).sort((a,b)=>b.revision-a.revision);return {eventId,eventHash:evidenceHash(e),rows};}
export function saveMeeting(s:Store,c:string,eventId:string,input:any){try{return s.transaction(()=>{
 exactObject(input,['meetingId','expectedRevision','eventHash','reference','content','confirmed']);if(input.confirmed!==true||!uuid(input.meetingId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=1000)fail('Terminangaben ausdrücklich bestätigen.');
 const e=raw(s,c,eventId),hash=evidenceHash(e),rows=meetingRecords(s,c),previous=latestMeetings(rows).find(r=>r.meetingId===input.meetingId);
 const foreign=s.db.prepare("SELECT id FROM events WHERE type=? AND json_extract(text,'$.meetingId')=? AND clientId<>? LIMIT 1").get(TYPE,input.meetingId,c);if(foreign)fail('Termin gehört zu einem anderen Kunden.');
 if(input.eventHash!==hash||input.expectedRevision!==(previous?.revision||0))fail('Termingrundlage wurde geändert. Bitte neu laden.');
 const reference=cleanText(input.reference,200).normalize('NFC'),content=meetingContent(input.content),createdAt=new Date().toISOString();
 if(content.observedAt>createdAt)fail('Beobachtungszeit darf nicht in der Zukunft liegen.');
 if(previous&&(previous.eventId!==eventId||previous.eventHash!==hash||previous.reference!==reference))fail('Quellbeleg und Terminreferenz bleiben fest. Fehlzuordnung widerrufen und neu erfassen.');
 if(!content.withdrawn&&latestMeetings(rows).some(r=>r.meetingId!==input.meetingId&&r.reference===reference&&!r.content.withdrawn))fail('Diese Terminreferenz ist bereits erfasst. Bestehenden Termin bearbeiten.');
 const payload:Payload={meetingId:input.meetingId,eventId,eventHash:hash,reference,revision:input.expectedRevision+1,previousId:previous?.id||null,origin:'human',content};
 const id=randomUUID();s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(id,c,null,TYPE,JSON.stringify(payload),createdAt);return meetingBasis(s,c,eventId);
});}catch(e){if(e instanceof AppError)throw e;throw new AppError((e as Error).message);}}
export function validateMeetings(data:BackupData,version:number){try{
 const events=data.events.filter(e=>e.type.startsWith('MEETING_'));if(events.length&&version<30)fail();
 const sources=new Map((data.evidenceEvents||[]).map(e=>[e.id,e])),clients=new Set(data.clients.map(c=>c.id)),chains=new Map<string,MeetingRecord[]>(),ids=new Set<string>(),counts=new Map<string,number>();
 for(const e of events){if(e.type!==TYPE||!uuid(e.id)||ids.has(e.id)||!e.clientId||!clients.has(e.clientId)||e.jobId!==null)return fail();ids.add(e.id);isoTime(e.createdAt);
  const count=(counts.get(e.clientId)||0)+1;if(count>limit)fail();counts.set(e.clientId,count);
  const p:Payload=JSON.parse(e.text);exactObject(p,['meetingId','eventId','eventHash','reference','revision','previousId','origin','content']);const source=sources.get(p.eventId);if(!source)return fail();
  if(!uuid(p.meetingId)||!source||source.clientId!==e.clientId||evidenceHash(source)!==p.eventHash||p.origin!=='human'||!Number.isSafeInteger(p.revision)||p.revision<1||p.revision>1000||p.previousId!==null&&!uuid(p.previousId)||cleanText(p.reference,200).normalize('NFC')!==p.reference)fail();
  if(source.source!=='incoming'&&!(source.source==='mail_tests'&&JSON.parse(source.payload).status==='sent'&&source.providerId))fail();
  const content=meetingContent(p.content);if(JSON.stringify(content)!==JSON.stringify(p.content)||content.observedAt>e.createdAt)fail();
  const chain=chains.get(p.meetingId)||[];chain.push(decode(e));chains.set(p.meetingId,chain);
 }
 const refs=new Set<string>();for(const chain of chains.values()){chain.sort((a,b)=>a.revision-b.revision);const first=chain[0];if(chain.some((r,i)=>r.revision!==i+1||r.previousId!==(i?chain[i-1].id:null)||r.clientId!==first.clientId||r.eventId!==first.eventId||r.eventHash!==first.eventHash||r.reference!==first.reference))fail();const last=chain.at(-1)!;if(!last.content.withdrawn){const key=last.clientId+':'+last.reference;if(refs.has(key))fail();refs.add(key);}}
 }catch{fail();}}
export function mergeMeetings(s:Store,data:BackupData){
 const rows=new Map(data.events.map(e=>[e.id,e]));for(const e of s.db.prepare('SELECT * FROM events WHERE type=?').all(TYPE) as LedgerEvent[]){const old=rows.get(e.id);if(old&&JSON.stringify(old)!==JSON.stringify(e)){
  if(['clientId','jobId','type','text','createdAt'].some(k=>(old as any)[k]!== (e as any)[k]))fail('Sicherung widerspricht einem bekannten Terminbeleg.');
 }rows.set(e.id,e);}
 const merged={...data,events:[...rows.values()]};validateMeetings(merged,30);return merged.events;
}

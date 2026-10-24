import {experimentCompanySignals} from './experiment-company-signals';
import {experimentResponses} from './experiment-responses';
import {createHash} from 'node:crypto';
import {AppError,type Store} from './store';
import {signalOverview} from './signals';
import {signalFields} from './experiment-signal-fields';

export type SignalMail={eventId:string;mailId:string;hypothesisId:string;contactId:string;accountId:string;acceptedAt:string};
type Counters=Record<typeof signalFields[number][0],number>;
export function signalWindow(value:unknown=7):7|14|30 {
 if(value===7||value===14||value===30)return value;
 throw new AppError('Signalvergleich benötigt ein Zeitfenster von 7, 14 oder 30 Tagen.');
}
export function experimentSignals(s:Store,clientId:string,hypothesisIds:string[],mails:SignalMail[],generatedAt:string,days=7,companyWindows?:ReturnType<typeof experimentResponses>){
 const windowDays=signalWindow(days),now=Date.parse(generatedAt),duration=windowDays*86400000;
 // Never expose prepared messages, URL tokens or target URLs in either report.
 const ledger=s.db.prepare("SELECT type,text FROM events WHERE clientId=? AND type IN ('TRACKING_PREPARED','TRACKING_REGISTERED') LIMIT 200001").all(clientId);
 if(ledger.length>200000)throw new AppError('Zu viele Trackingbelege; keine gekürzte Auswertung.',413);
 const registered=new Map<string,string>();for(const e of ledger)if(e.type==='TRACKING_REGISTERED'){const r=JSON.parse(String(e.text));registered.set(r.mailId,r.planHash);}
 const coverage=new Map<string,{click:boolean;expiresAt:number}>();
 for(const e of ledger)if(e.type==='TRACKING_PREPARED'){
  const p=JSON.parse(String(e.text));if(registered.get(p.mailId)!==createHash('sha256').update(JSON.stringify(p)).digest('hex'))continue;
  coverage.set(p.mailId,{click:p.registrations.some((r:any)=>r.kind==='click'),expiresAt:Math.min(...p.registrations.map((r:any)=>Date.parse(r.expiresAt)))});
 }
 const byEvent=new Map(mails.map(m=>[m.eventId,m])),groups=new Map(hypothesisIds.map(id=>[id,mails.filter(m=>m.hypothesisId===id)]));
 const overview=signalOverview(s,clientId),excluded:{signalId:string;eventId:string;reason:string}[]=[];
 const rows=overview.rows.filter(r=>byEvent.has(r.eventId));
 const countedIds=new Set<string>();
 const byArm=new Map(hypothesisIds.map(id=>[id,rows.filter(r=>byEvent.get(r.eventId)!.hypothesisId===id)]));
 const arms=hypothesisIds.map(hypothesisId=>{
  const all=groups.get(hypothesisId)!,c=Object.fromEntries(signalFields.map(([key])=>[key,0])) as Counters;
  const mature=new Map<string,SignalMail>();
  c.acceptedMessages=all.length;
  for(const m of all){const start=Date.parse(m.acceptedAt);if(!Number.isFinite(start)||start>now)c.invalidTimeMessages++;else if(start+duration>now)c.pendingMessages++;else mature.set(m.eventId,m);}
  c.matureMessages=mature.size;
  const registeredIds=new Set<string>();
  for(const m of mature.values()){const proof=coverage.get(m.mailId);if(proof){c.registeredMessages++;registeredIds.add(m.eventId);if(proof.click)c.clickEnabledMessages++;if(proof.expiresAt<Date.parse(m.acceptedAt)+duration)c.expiresBeforeWindowEnd++;}}
  c.withoutRegistration=c.matureMessages-c.registeredMessages;
  const messages=new Set<string>(),contacts=new Set<string>(),companies=new Set<string>(),openTimes=new Map<string,{eventId:string;times:Set<string>}>();
  for(const r of byArm.get(hypothesisId)!){
   if(r.withdrawn){c.withdrawnSignals++;continue;}
   const m=mature.get(r.eventId),at=Date.parse(r.signal.occurredAt),start=m?Date.parse(m.acceptedAt):NaN;
   let reason='';
   if(!m)reason='Versandzeit ungültig oder Beobachtungsfenster noch nicht vollständig verstrichen.';
   else if(at<start)reason='Abruf vor erster bestätigter Anbieterannahme.';
   else if(!Number.isFinite(at)||at>=start+duration||Date.parse(r.signal.capturedAt)>now||Date.parse(r.recordedAt)>now)reason='Abruf außerhalb des Zeitfensters oder erst nach Berechnungsstand erfasst.';
   if(reason){c.excludedSignals++;excluded.push({signalId:r.id,eventId:r.eventId,reason});continue;}
   countedIds.add(r.id);messages.add(r.eventId);contacts.add(m!.contactId);companies.add(m!.accountId);
   c[r.signal.kind==='open'?'opens':'clicks']++;
   c[r.signal.flags.length?'flaggedSignals':'unflaggedSignals']++;
   c[r.origin==='relay_pull'?'relaySignals':'importedSignals']++;
   if(r.signal.kind==='open'&&!r.signal.flags.length){const key=JSON.stringify([r.eventId,r.source.provider,r.source.stream]),g=openTimes.get(key)||{eventId:r.eventId,times:new Set<string>()};g.times.add(r.signal.occurredAt);openTimes.set(key,g);}
  }
  c.observedMessages=messages.size;c.observedContacts=contacts.size;c.observedCompanies=companies.size;
  c.registeredWithoutSignal=[...registeredIds].filter(id=>!messages.has(id)).length;
  c.repeatedOpenMessages=new Set([...openTimes.values()].filter(g=>g.times.size>=3).map(g=>g.eventId)).size;
  return {hypothesisId,...c};
 });
 return {companyComparison:experimentCompanySignals(companyWindows??experimentResponses(hypothesisIds,mails,[],generatedAt,windowDays),mails,rows,coverage,generatedAt),version:1,windowDays,arms,excluded,observations:rows.map(r=>({signalId:r.id,eventId:r.eventId,hypothesisId:byEvent.get(r.eventId)!.hypothesisId,kind:r.signal.kind,occurredAt:r.signal.occurredAt,origin:r.origin,flags:r.signal.flags,status:r.withdrawn?'withdrawn':countedIds.has(r.id)?'counted':'excluded'})),methodology:[
  `Je Kampagnennachricht die ersten ${windowDays} Tage ab der ersten bestätigten Anbieterannahme: Start eingeschlossen, Ende ausgeschlossen. Nur vollständig verstrichene Fenster; Dialogantworten separat in der Gesamthistorie.`,
  'Der Anker ist die gespeicherte lokale Versandbestätigung, nicht der tatsächliche Zustellzeitpunkt. Bei späterem Versandabgleich können frühere Abrufe vor diesem Anker liegen; sie bleiben im Journal und werden hier separat ausgeschlossen.',
  'Gleiche Beobachtungsdauer je Nachricht, nicht je Unternehmen. Unterschiedliche Nachrichtenanzahl, Follow-ups, Quellen und Erfassungslücken begrenzen den Vergleich. Keine Öffnungsrate und keine Gewinnerentscheidung.',
  'Registrierungsbeleg bedeutet weder lückenlose Abholung noch verfügbare Messung über das gesamte Fenster. Kennungen laufen 30 Tage nach Vorbereitung ab, möglicherweise früher als das Beobachtungsfenster endet. Fehlende Abrufe sind kein Beweis fehlenden Interesses.',
  'Proxy-/Automatikmerkmale werden getrennt gezählt. Ohne Merkmal bedeutet unbekannt, nicht menschlich. Mindestens drei verschiedene Abrufzeiten werden nur innerhalb derselben Nachricht und Quelle zusammengezählt; kein Nachweis des Lesens oder Weiterleitens.',
  'Quellenkennungen sind im Journal dedupliziert; verschiedene Quellen können dieselbe Aktivität melden. Widerrufe und ausgeschlossene Zeitfenster zählen nicht als aktive Abrufe. Diese Qualitätszähler umfassen auch jüngere Nachrichten. Später importierte Belege können eine neue Berechnung verändern.'
 ]};
}

import type {experimentResponses} from './experiment-responses';
import type {SignalMail} from './experiment-signals';
import type {SignalRecord} from './signals';
import {companySignalFields} from './experiment-company-signal-fields';
type Windows=ReturnType<typeof experimentResponses>;
type Row=Pick<SignalRecord,'id'|'eventId'|'signal'|'source'|'origin'|'recordedAt'>&{withdrawn:boolean};
type Coverage=ReadonlyMap<string,{click:boolean;expiresAt:number}>;
type Counters=Record<typeof companySignalFields[number][0],number>;
export function experimentCompanySignals(windows:Windows,mails:SignalMail[],rows:Row[],coverage:Coverage,generatedAt:string){
 const now=Date.parse(generatedAt),key=(arm:string,company:string)=>JSON.stringify([arm,company]);
 if(!Number.isFinite(now)||![7,14,30].includes(windows.windowDays))throw Error('Ungültiger Stand für Unternehmenssignale.');
 const companies=new Map(windows.companies.map(c=>[key(c.hypothesisId,c.accountId),c])),byEvent=new Map(mails.map(m=>[m.eventId,m]));
 const observations:{signalId:string;eventId:string;hypothesisId:string;accountId:string;status:string;reason:string}[]=[];
 const arms=windows.arms.map(a=>{
  const c=Object.fromEntries(companySignalFields.map(([name])=>[name,0])) as Counters;
  for(const name of ['contactedCompanies','matureCompanies','pendingCompanies','invalidTimeCompanies'] as const)c[name]=a[name];
  const eligible=new Map<string,{mail:SignalMail;start:number;end:number}>(),registered=new Set<string>();
  for(const m of mails.filter(m=>m.hypothesisId===a.hypothesisId)){
   const company=companies.get(key(a.hypothesisId,m.accountId)),start=Date.parse(m.acceptedAt),end=Date.parse(company?.windowEndsAt||'');
   if(company?.status!=='mature'||!Number.isFinite(start)||start<Date.parse(company.firstAcceptedAt!)||start>=end)continue;
   eligible.set(m.eventId,{mail:m,start,end});c.messagesInWindow++;
   const proof=coverage.get(m.mailId);if(proof){registered.add(m.eventId);c.registeredMessages++;if(proof.click)c.clickEnabledMessages++;if(proof.expiresAt<end)c.expiresBeforeWindowEnd++;}
  }
  c.withoutRegistration=c.messagesInWindow-c.registeredMessages;
  const observed=new Set<string>(),observedCompanies=new Set<string>(),opens=new Set<string>(),clicks=new Set<string>(),repeat=new Map<string,{company:string;times:Set<number>}>();
  for(const r of rows){const m=byEvent.get(r.eventId);if(!m||m.hypothesisId!==a.hypothesisId)continue;
   const entry=eligible.get(r.eventId),at=Date.parse(r.signal.occurredAt),captured=Date.parse(r.signal.capturedAt),recorded=Date.parse(r.recordedAt);
   let reason='';
   if(r.withdrawn)reason='Signal widerrufen.';
   else if(!entry)reason='Kein gereiftes Unternehmensfenster oder Nachricht außerhalb dieses Fensters.';
   else if(!Number.isFinite(at)||!Number.isFinite(captured)||!Number.isFinite(recorded)||captured>now||recorded>now)reason='Ungültige Signalzeit oder Erfassung nach Berechnungsstand.';
   else if(at<entry.start||at>=entry.end)reason='Abruf vor bestätigter Nachrichtenannahme oder nach Unternehmensfensterende.';
   observations.push({signalId:r.id,eventId:r.eventId,hypothesisId:a.hypothesisId,accountId:m.accountId,status:r.withdrawn?'withdrawn':reason?'excluded':'counted',reason});
   if(reason){c[r.withdrawn?'withdrawnSignals':'excludedSignals']++;continue;}
   observed.add(r.eventId);observedCompanies.add(m.accountId);
   c[r.signal.kind==='open'?'opens':'clicks']++;(r.signal.kind==='open'?opens:clicks).add(m.accountId);
   c[r.signal.flags.length?'flaggedSignals':'unflaggedSignals']++;c[r.origin==='relay_pull'?'relaySignals':'importedSignals']++;
   if(r.signal.kind==='open'&&!r.signal.flags.length){const k=JSON.stringify([r.eventId,r.source.provider,r.source.stream]),g=repeat.get(k)||{company:m.accountId,times:new Set<number>()};g.times.add(at);repeat.set(k,g);}
  }
  c.observedMessages=observed.size;c.observedCompanies=observedCompanies.size;c.openCompanies=opens.size;c.clickCompanies=clicks.size;
  c.registeredWithoutSignal=[...registered].filter(id=>!observed.has(id)).length;
  c.repeatedOpenCompanies=new Set([...repeat.values()].filter(g=>g.times.size>=3).map(g=>g.company)).size;
  return {hypothesisId:a.hypothesisId,...c};
 });
 return {version:1,windowDays:windows.windowDays,arms,observations,methodology:[
  `Je Unternehmen die ersten ${windows.windowDays} Tage ab erster bestätigter Kampagnenannahme im Testarm. Dieselben vollständig verstrichenen Unternehmensfenster wie Antworten und Termine; Anfang inklusive, Ende exklusiv.`,
  'Weitere Personen und Follow-ups beginnen kein neues Unternehmensfenster. Signale zählen erst ab bestätigter Annahme ihrer jeweiligen Kampagnennachricht. Spätere Nachrichten haben nur die verbleibende Beobachtungszeit; sie müssen kein zusätzliches Nachrichtenfenster abwarten. Dialogsignale sind nicht enthalten.',
  'Unternehmen werden je Kennzahl nur einmal gezählt. Pixel- und Klickunternehmen können sich überschneiden und dürfen nicht addiert werden. Unterschiedliche Nachrichten-/Personenzahlen begrenzen Vergleiche weiterhin.',
  'Technische Abrufe belegen weder menschliches Lesen noch Weiterleiten. Ohne Automatikmerkmal bedeutet unbekannt. Wiederholungen erfordern drei verschiedene Abrufzeiten ohne Automatikmerkmal innerhalb derselben Nachricht und Quelle; Quellen werden dafür nicht vermischt.',
  'Passender Registrierungsbeleg, fehlender Beleg, Ablauf vor Fensterende und registriert ohne Signal bleiben getrennt. Registrierung beweist weder lückenlose Abholung noch verfügbare Messung. Kein Abruf ist kein Beweis fehlenden Interesses; keine Öffnungsrate.',
  'Aktuelle Widerrufe zählen nicht. Erfassung und lokale Speicherung müssen bis zum Berechnungsstand erfolgt sein. Späte Importe können neue Berichte verändern. Ausschlüsse stehen im internen Export; Rohdaten bleiben unverändert. Keine Kausalität oder automatische Strategieänderung.'
 ]};
}

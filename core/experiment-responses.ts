import type {SignalMail} from './experiment-signals';

type Reply={eventId:string;hypothesisId:string;contactId:string;accountId:string;occurredAt:string;assessment:null|{id:string;revision:number;origin:string;replyType:string;meetingIntent:string;withdrawn:boolean;requiresHumanReview:boolean}};
type Company={hypothesisId:string;accountId:string;first:number;invalid:boolean;contacts:Map<string,number>};
const humanTypes=new Set(['interest','rejection','wrong_person','other']);
const automaticTypes=new Set(['automatic','out_of_office']);
const rate=(numerator:number,denominator:number)=>({numerator,denominator,percent:denominator?Math.round(numerator/denominator*10000)/100:null});

// Inputs are already checked against the immutable experiment allocation and approval.
// This function never reads or changes dispatch, interpretation or raw journal state.
export function experimentResponses(hypothesisIds:string[],mails:SignalMail[],replies:Reply[],generatedAt:string,windowDays:number){
 if(![7,14,30].includes(windowDays))throw Error('Antwortvergleich benötigt 7, 14 oder 30 Tage.');
 const now=Date.parse(generatedAt),duration=windowDays*86400000;
 if(!Number.isFinite(now))throw Error('Ungültiger Berechnungsstand.');
 const companies=new Map<string,Company>();
 const key=(hypothesisId:string,accountId:string)=>JSON.stringify([hypothesisId,accountId]);
 for(const m of mails){
  const k=key(m.hypothesisId,m.accountId),at=Date.parse(m.acceptedAt),c=companies.get(k)||{hypothesisId:m.hypothesisId,accountId:m.accountId,first:Infinity,invalid:false,contacts:new Map<string,number>()};
  if(!Number.isFinite(at)||at>now)c.invalid=true;
  else {c.first=Math.min(c.first,at);c.contacts.set(m.contactId,Math.min(c.contacts.get(m.contactId)??Infinity,at));}
  companies.set(k,c);
 }
 const status=(c:Company)=>c.invalid?'invalid':c.first+duration>now?'pending':'mature';
 const observations:{eventId:string;hypothesisId:string;accountId:string;contactId:string;occurredAt:string;counted:boolean;reason:string;assessmentId:string|null;assessmentRevision:number|null}[]=[];
 const arms=hypothesisIds.map(hypothesisId=>{
  const own=[...companies.values()].filter(c=>c.hypothesisId===hypothesisId),mature=own.filter(c=>status(c)==='mature');
  const human=new Set<string>(),positive=new Set<string>(),meeting=new Set<string>(),modelPositive=new Set<string>(),modelMeeting=new Set<string>();
  let incomingMessages=0,unreviewedMessages=0,automaticMessages=0,excludedMessages=0;
  for(const r of replies.filter(r=>r.hypothesisId===hypothesisId)){
   const c=companies.get(key(hypothesisId,r.accountId)),at=Date.parse(r.occurredAt),contactAt=c?.contacts.get(r.contactId);
   let reason='';
   if(!c)reason='Keine bestätigte Kampagnenannahme für dieses Unternehmen.';
   else if(status(c)==='invalid')reason='Versandzeit des Unternehmens ungeklärt; kein belastbarer Anker.';
   else if(status(c)==='pending')reason='Beobachtungsfenster des Unternehmens noch nicht vollständig verstrichen.';
   else if(contactAt===undefined)reason='Keine bestätigte Kampagnenannahme an dieselbe Person.';
   else if(!Number.isFinite(at)||at<contactAt)reason='Eingang vor bestätigtem Kampagnenkontakt derselben Person oder ungültige Eingangszeit.';
   else if(at>=c.first+duration)reason='Eingang nach Ende des Unternehmensfensters.';
   observations.push({eventId:r.eventId,hypothesisId,accountId:r.accountId,contactId:r.contactId,occurredAt:r.occurredAt,counted:!reason,reason,assessmentId:r.assessment?.id??null,assessmentRevision:r.assessment?.revision??null});
   if(reason){excludedMessages++;continue;}
   incomingMessages++;
   const a=r.assessment,reviewed=!!a&&!a.withdrawn&&!a.requiresHumanReview;
   if(!reviewed||a!.origin!=='human'||a!.replyType==='unclear')unreviewedMessages++;
   if(!reviewed)continue;
   if(a!.origin==='human'&&automaticTypes.has(a!.replyType))automaticMessages++;
   if(!humanTypes.has(a!.replyType))continue;
   if(a!.origin==='human'){human.add(r.accountId);if(a!.replyType==='interest')positive.add(r.accountId);if(a!.meetingIntent==='yes')meeting.add(r.accountId);}
   else if(a!.origin==='model'){if(a!.replyType==='interest')modelPositive.add(r.accountId);if(a!.meetingIntent==='yes')modelMeeting.add(r.accountId);}
  }
  return {hypothesisId,contactedCompanies:own.length,matureCompanies:mature.length,pendingCompanies:own.filter(c=>status(c)==='pending').length,invalidTimeCompanies:own.filter(c=>status(c)==='invalid').length,incomingMessages,humanReplyCompanies:human.size,positiveCompanies:positive.size,meetingIntentCompanies:meeting.size,unreviewedMessages,automaticMessages,modelPositiveCompanies:modelPositive.size,modelMeetingIntentCompanies:modelMeeting.size,excludedMessages,humanReplyRate:rate(human.size,mature.length),positiveRate:rate(positive.size,mature.length),meetingIntentRate:rate(meeting.size,mature.length)};
 });
 return {version:1,windowDays,arms,companies:[...companies.values()].map(c=>({hypothesisId:c.hypothesisId,accountId:c.accountId,firstAcceptedAt:Number.isFinite(c.first)?new Date(c.first).toISOString():null,windowEndsAt:Number.isFinite(c.first)?new Date(c.first+duration).toISOString():null,status:status(c)})),observations,methodology:[
  `Je Unternehmen die ersten ${windowDays} Tage ab seiner ersten bestätigten Kampagnenannahme im Testarm. Start eingeschlossen, Ende ausgeschlossen. Nur vollständig verstrichene Fenster bilden den Nenner. Noch laufende und zeitlich unklare Unternehmen zählen nicht als erfolglose Unternehmen.`,
  'Mehrere Personen und Follow-ups desselben Unternehmens vergrößern den Nenner nicht und starten das Fenster nicht neu. Eine später kontaktierte Person hat entsprechend weniger Zeit innerhalb dieses Unternehmensfensters.',
  'Antworten zählen nur nach bestätigter Kampagnenannahme an dieselbe Person. Auch Eingänge über belegte Dialogketten können zählen. Ausschlüsse bleiben im internen Export; keine Rohdaten werden verändert.',
  'Maßgeblich ist die Eingangszeit der Nachricht, nicht der Zeitpunkt ihrer Bewertung. Verwendet wird die aktuelle Einordnung am Berechnungsstand, auch wenn sie erst später geprüft oder korrigiert wurde. Dieser Bericht rekonstruiert keinen historischen Wissensstand.',
  'Nur aktuelle menschliche Einordnungen ohne Widerruf oder Prüfbedarf zählen als geprüfte Antwort, Interesse oder Terminabsicht. KI-Einordnungen sind separat und unbestätigt. Terminabsicht ist keine Buchung oder Teilnahme.',
  'Fehlende oder verspätet abgeholte Eingänge können Ergebnisse verändern. Der Anker beruht auf lokaler Versandbestätigung, nicht Zustellung. Gleiche Laufzeit gleicht Unterschiede in Personenzahl, Kontaktstrategie oder Messlücken nicht aus. Kein statistischer Gewinner oder Kausalitätsnachweis.',
  'Diese Antwortquoten beziehen sich auf Unternehmen. Technische Signale verwenden weiterhin eigene Fenster je Nachricht; die Gesamthistorie für Antworten und Termine bleibt separat.'
 ]};
}

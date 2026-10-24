import type {experimentResponses} from './experiment-responses';
import type {SignalMail} from './experiment-signals';
import type {MeetingContent} from './meeting-input';
type CompanyWindows=ReturnType<typeof experimentResponses>;
type Meeting={meetingId:string;revisionId:string;revision:number;eventId:string;hypothesisId:string;accountId:string;contactId:string;status:MeetingContent['status'];scheduledAt:string;observedAt:string;withdrawn:boolean};
const rate=(numerator:number,denominator:number)=>({numerator,denominator,percent:denominator?Math.round(numerator/denominator*10000)/100:null});
export function experimentMeetings(windows:CompanyWindows,mails:SignalMail[],meetings:Meeting[],generatedAt:string){
 const now=Date.parse(generatedAt),key=(hypothesisId:string,id:string)=>JSON.stringify([hypothesisId,id]);
 if(!Number.isFinite(now)||![7,14,30].includes(windows.windowDays))throw Error('Ungültiger Stand für den Terminvergleich.');
 const companies=new Map(windows.companies.map(c=>[key(c.hypothesisId,c.accountId),c])),contacts=new Map<string,number>();
 for(const m of mails){const k=key(m.hypothesisId,m.contactId),at=Date.parse(m.acceptedAt);if(Number.isFinite(at)&&at<=now)contacts.set(k,Math.min(contacts.get(k)??Infinity,at));}
 const observations:(Meeting&{counted:boolean;reason:string})[]=[];
 const arms=windows.arms.map(a=>{
  let recordedMeetings=0,heldConfirmedMeetings=0,cancelledMeetings=0,noShowMeetings=0,attendanceUnverifiedMeetings=0,withdrawnMeetings=0,excludedMeetings=0;
  const meetingCompanies=new Set<string>(),heldCompanies=new Set<string>();
  for(const m of meetings.filter(m=>m.hypothesisId===a.hypothesisId)){
   const c=companies.get(key(m.hypothesisId,m.accountId)),contactAt=contacts.get(key(m.hypothesisId,m.contactId)),at=Date.parse(m.scheduledAt),observedAt=Date.parse(m.observedAt);
   let reason='';
   if(m.withdrawn)reason='Aktuelle Terminversion widerrufen.';
   else if(!c)reason='Keine bestätigte Kampagnenannahme für dieses Unternehmen.';
   else if(c.status==='invalid')reason='Versandzeit des Unternehmens ungeklärt.';
   else if(c.status!=='mature')reason='Unternehmensfenster noch nicht vollständig verstrichen.';
   else if(contactAt===undefined)reason='Keine bestätigte Kampagnenannahme an dieselbe Person.';
   else if(!Number.isFinite(at)||!Number.isFinite(observedAt)||at<contactAt||observedAt<contactAt||observedAt>now)reason='Termin- oder Beobachtungszeit widerspricht bestätigtem Kontakt oder Berechnungsstand.';
   else if(at<Date.parse(c.firstAcceptedAt!)||at>=Date.parse(c.windowEndsAt!))reason='Terminzeit außerhalb des Unternehmensfensters.';
   observations.push({...m,counted:!reason,reason});
   if(reason){if(m.withdrawn)withdrawnMeetings++;else excludedMeetings++;continue;}
   recordedMeetings++;meetingCompanies.add(m.accountId);
   if(m.status==='held_confirmed'){heldConfirmedMeetings++;heldCompanies.add(m.accountId);}
   else if(m.status==='cancelled')cancelledMeetings++;
   else if(m.status==='no_show')noShowMeetings++;
   else attendanceUnverifiedMeetings++;
  }
  return {hypothesisId:a.hypothesisId,contactedCompanies:a.contactedCompanies,matureCompanies:a.matureCompanies,pendingCompanies:a.pendingCompanies,invalidTimeCompanies:a.invalidTimeCompanies,recordedMeetings,meetingCompanies:meetingCompanies.size,heldConfirmedMeetings,heldConfirmedCompanies:heldCompanies.size,cancelledMeetings,noShowMeetings,attendanceUnverifiedMeetings,withdrawnMeetings,excludedMeetings,meetingRate:rate(meetingCompanies.size,a.matureCompanies),heldConfirmedRate:rate(heldCompanies.size,a.matureCompanies)};
 });
 return {version:1,windowDays:windows.windowDays,arms,observations,methodology:[
  `Terminzeit innerhalb der ersten ${windows.windowDays} Tage je Unternehmen ab erster bestätigter Kampagnenannahme. Dieselben vollständig verstrichenen Unternehmensfenster und Nenner wie im Antwortvergleich; Anfang inklusive, Ende exklusiv.`,
  'Verwendet wird die Terminzeit der aktuellen nicht widerrufenen Version. Dies ist kein Buchungsdatum und kein Nachweis, wann ein Termin tatsächlich begonnen hat. Spätere Verschiebungen können seine Fensterzugehörigkeit ändern; die alte Gesamthistorie bleibt erhalten.',
  'Maßgeblich ist der aktuelle Betreiberbeleg am Berechnungsstand. Eine spätere Teilnahmebestätigung kann einen früheren Termin im Fenster bestätigen. Keine Rekonstruktion des damaligen Wissensstands und keine automatische Teilnahmeannahme aus einem vergangenen Datum.',
  'Terminzeit und Beobachtungszeit dürfen nicht vor dem bestätigten Kampagnenkontakt derselben Person liegen. Bestehende historische Quellen- und Dialogzuordnung bleibt erhalten; sie belegt keine Kausalität oder neu durch die Kampagne erzeugte Buchung.',
  'Je Termin zählt nur die aktuelle Version. Mehrere Termine oder Personen eines Unternehmens erhöhen die Unternehmensquote nicht mehrfach. Absage, Nichterscheinen, ungeklärte und bestätigte Teilnahme sind getrennte Terminstatus; Terminbelegquote schließt Absagen ein.',
  'Ungeklärte Teilnahme umfasst gebuchte, verschobene und ausdrücklich ungeklärte Termine im verstrichenen Fenster. Fehlende Erfassung ist kein Beweis eines fehlenden Termins. Widerrufe und Ausschlüsse bleiben im internen Export nachvollziehbar.',
  'Bestätigung beruht auf Betreiberangaben, nicht Kalender- oder Meetinganbieter-Verifikation. Keine Abrechnungsfreigabe, kein statistischer Gewinner. Terminabsicht, Terminbeleg und bestätigte Teilnahme bleiben getrennte Größen.'
 ]};
}

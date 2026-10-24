import {experimentMeetings} from './experiment-meetings';
import {experimentResponses} from './experiment-responses';
import {experimentSignals,signalWindow,type SignalMail} from './experiment-signals';
import {meetingRecords,latestMeetings} from './meetings';
import {evidenceAttribution,type Attribution} from './evidence-attribution';
import {AppError,type Store} from './store';
import {campaignMessaging} from './campaign-messaging';
import {exportExperiments} from './experiments';
import {matchesExperimentCampaign,type ExperimentContent} from './experiment-input';
import type {CampaignContent} from './campaign';
import type {EvidenceEvent,EvidenceContext} from './evidence-journal';
import type {Interpretation} from './interpretations';
import type {InterpretationContent} from './interpretation-input';

const limit=100000;
function bounded<T>(rows:T[]){if(rows.length>limit)throw new AppError('Zu viele Belege für diese Ergebnisansicht. Keine gekürzte Auswertung erstellt.',413);return rows;}
const rate=(numerator:number,denominator:number)=>({numerator,denominator,percent:denominator?Math.round(numerator/denominator*10000)/100:null});
const humanTypes=new Set(['interest','rejection','wrong_person','other']);
export function experimentResults(s:Store,clientId:string,productId:string,experimentId:string,windowDays=7){return s.transaction(()=>{
  signalWindow(windowDays);
  const client=s.client(clientId);
  const versions=exportExperiments(s).filter(r=>r.clientId===clientId&&r.productId===productId&&r.experimentId===experimentId).sort((a,b)=>a.revision-b.revision);
  const first=versions[0];if(!first)throw new AppError('Experiment nicht gefunden.',404);
  const plan:ExperimentContent=JSON.parse(first.content),state=versions[versions.length-1].state;
  const product=s.db.prepare('SELECT name FROM product_revisions WHERE clientId=? AND productId=? AND revision=?').get(clientId,productId,plan.input.productRevision);
  const histories=bounded(s.db.prepare("SELECT * FROM campaign_history WHERE clientId=? AND json_extract(content,'$.experimentId')=? ORDER BY revision,id LIMIT 100001").all(clientId,experimentId));
  const approvals=new Map<string,CampaignContent>(),campaigns=new Map<string,{id:string;name:string;hypothesisId:string}>();
  for(const h of histories){const c:CampaignContent=JSON.parse(String(h.content));
    if(c.productRef?.productId!==productId||!matchesExperimentCampaign(experimentId,plan,c))throw new AppError('Widersprüchliche Kampagnenbindung. Ergebnisansicht abgebrochen.');
    campaigns.set(String(h.campaignId),{id:String(h.campaignId),name:c.name,hypothesisId:c.hypothesisId!});
    if(h.action==='approved')approvals.set(h.campaignId+':'+h.fingerprint,c);
  }
  const runs=new Map(bounded(s.db.prepare('SELECT id,campaignId,fingerprint,snapshot FROM queue_runs WHERE clientId=? LIMIT 100001').all(clientId)).map(r=>[String(r.id),r]));
  const events=bounded(s.db.prepare('SELECT * FROM evidence_events WHERE clientId=? ORDER BY recordedAt,id LIMIT 100001').all(clientId)) as EvidenceEvent[];
  const assessments=bounded(s.db.prepare('SELECT * FROM interpretations WHERE clientId=? ORDER BY eventId,revision LIMIT 100001').all(clientId)) as Interpretation[];
  const latestAssessment=new Map<string,Interpretation>();for(const r of assessments)latestAssessment.set(r.eventId,r);
  const contactArm=new Map(plan.allocation.groups.flatMap(g=>g.leadIds.map(id=>[id,{hypothesisId:g.hypothesisId,accountId:g.accountId}] as const)));
  const warnings:string[]=[],unattributed:{eventId:string;reason:string;path:string[]}[]=[];
  const attribute=evidenceAttribution(s,clientId,events);
  const excluded:{eventId:string;reason:string}[]=[];
  type Observation={attribution:Attribution;eventId:string;sourceId:string;mailId:string;runId:string;campaignId:string;fingerprint:string;contactId:string;accountId:string;hypothesisId:string;source:string;status:string;occurredAt:string;recordedAt:string;counted:boolean;assessment:null|{id:string;revision:number;origin:string;replyType:string;meetingIntent:string;withdrawn:boolean;requiresHumanReview:boolean}};
  const observations:Observation[]=[],mailLatest=new Map<string,{event:EvidenceEvent;observation:Observation}>(),incoming=new Map<string,{event:EvidenceEvent;observation:Observation}>();
  let missingRuns=0;
  for(const event of events){
    const attribution=attribute(event),c=attribution.context;if(!c){unattributed.push({eventId:event.id,reason:attribution.reason,path:attribution.path});continue;}if(!c.campaignId||!campaigns.has(c.campaignId))continue;
    const approved=approvals.get(c.campaignId+':'+c.campaignFingerprint),allocation=contactArm.get(c.contactId||'');
    let reason='';
    if(!approved)reason='Keine exakt passende historische Kampagnenfreigabe.';
    else if(c.productId!==productId||c.productRevision!==plan.input.productRevision||!allocation||allocation.hypothesisId!==approved.hypothesisId||!approved.leadIds.includes(c.contactId!))reason='Beleg stimmt nicht mit Produktversion oder Kontaktzuteilung überein.';
    else if(c.accountId!==null&&c.accountId!==allocation.accountId)reason='Beobachtetes Unternehmen weicht von der festen Zuteilung ab.';
    else if(!c.runId)reason='Keine Versandlaufkennung.';
    const run=runs.get(c.runId||'');
    if(!reason&&run){const snap=JSON.parse(String(run.snapshot));if(snap.mode!=='live')reason='Probelauf: kein Live-Versandbeleg.';else if(run.campaignId!==c.campaignId||run.fingerprint!==c.campaignFingerprint||!matchesExperimentCampaign(experimentId,plan,snap.content)||snap.content.hypothesisId!==allocation!.hypothesisId)reason='Versandlauf und Beleg widersprechen sich.';}
    if(reason){excluded.push({eventId:event.id,reason});continue;}
    if(!run)missingRuns++;
    const payload=JSON.parse(event.payload),review=latestAssessment.get(event.id),value:InterpretationContent|undefined=review?JSON.parse(review.content):undefined;
    const o:Observation={attribution,eventId:event.id,sourceId:event.sourceId,mailId:c.mailId,runId:c.runId!,campaignId:c.campaignId,fingerprint:c.campaignFingerprint!,contactId:c.contactId!,accountId:allocation!.accountId,hypothesisId:allocation!.hypothesisId,source:event.source,status:event.source==='mail_tests'?payload.status:payload.reportedKind,occurredAt:event.occurredAt,recordedAt:event.recordedAt,counted:false,assessment:review&&value?{id:review.id,revision:review.revision,origin:review.origin,replyType:value.replyType,meetingIntent:value.meetingIntent,withdrawn:value.withdrawn,requiresHumanReview:value.requiresHumanReview}:null};
    observations.push(o);
    if(event.source==='mail_tests'){
      const old=mailLatest.get(c.mailId);if(!old||old.event.sourceRevision<event.sourceRevision)mailLatest.set(c.mailId,{event,observation:o});
    }else{const key=event.mailboxId+':'+event.providerId;if(!incoming.has(key))incoming.set(key,{event,observation:o});}
  }
  for(const {observation:o} of [...mailLatest.values(),...incoming.values()])o.counted=true;
  if(missingRuns)warnings.push(`${missingRuns} Belege ohne erhaltenen Queue-Datensatz: Zuordnung aus fester Journalreferenz und exakter historischer Freigabe.`);
  if(unattributed.length)warnings.push(`${unattributed.length} kundenweite Rohbeobachtungen ohne belastbare Experimentzuordnung; keine automatische Zurechnung zu diesem Vergleich.`);
  if(excluded.length)warnings.push(`${excluded.length} Belege wegen fehlender oder widersprüchlicher Zuordnung ausgeschlossen; Einzelgründe im Export.`);
  const calculationAt=new Date().toISOString(),observed=new Map(observations.map(o=>[o.eventId,o])),sources=new Map(events.map(e=>[e.id,e]));
  const meetingExcluded:{meetingId:string;reason:string}[]=[];
  const meetingObservations=latestMeetings(meetingRecords(s,clientId)).flatMap(r=>{
    const o=observed.get(r.eventId);if(!o){const e=sources.get(r.eventId),a=e?attribute(e):null;if(!a?.context||campaigns.has(a.context.campaignId||''))meetingExcluded.push({meetingId:r.meetingId,reason:'Kein gültiger Quellbeleg in diesem Vergleich; keine Zurechnung.'});return [];}
    return [{meetingId:r.meetingId,revisionId:r.id,revision:r.revision,eventId:r.eventId,origin:r.origin,status:r.content.status,scheduledAt:r.content.scheduledAt,observedAt:r.content.observedAt,withdrawn:r.content.withdrawn,contactId:o.contactId,accountId:o.accountId,hypothesisId:o.hypothesisId,attribution:o.attribution,counted:false,attendanceUnverified:!r.content.withdrawn&&(r.content.status==='held_unverified'||['booked','rescheduled'].includes(r.content.status)&&r.content.scheduledAt<calculationAt)}];
  });
  const arms=plan.input.hypothesisIds.map(hypothesisId=>{
    const groups=plan.allocation.groups.filter(g=>g.hypothesisId===hypothesisId),assigned=groups.flatMap(g=>g.leadIds);
    const h=s.db.prepare('SELECT content FROM strategy_versions WHERE clientId=? AND productId=? AND id=?').get(clientId,productId,hypothesisId);
    const hypothesis=h?JSON.parse(String(h.content)):null;
    const persona=hypothesis?s.db.prepare("SELECT content FROM strategy_versions WHERE clientId=? AND productId=? AND id=? AND kind='persona'").get(clientId,productId,hypothesis.personaId):undefined;
    const personaName=persona?JSON.parse(String(persona.content)).name:null;
    const mail=[...mailLatest.values()].filter(v=>v.observation.hypothesisId===hypothesisId),inputs=[...incoming.values()].filter(v=>v.observation.hypothesisId===hypothesisId);
    const campaignMail=mail.filter(v=>v.observation.attribution.kind==='campaign'),dialogueMail=mail.filter(v=>v.observation.attribution.kind==='dialogue');
    const accepted=campaignMail.filter(v=>v.observation.status==='sent'&&!!v.event.providerId),contacts=new Set(accepted.map(v=>v.observation.contactId)),companies=new Set(accepted.map(v=>v.observation.accountId));
    const reviewed=inputs.filter(v=>{const r=v.observation.assessment;return r?.origin==='human'&&!r.withdrawn&&!r.requiresHumanReview&&humanTypes.has(r.replyType);});
    const matched=(rows:typeof reviewed)=>rows.filter(v=>contacts.has(v.observation.contactId));
    const human=matched(reviewed),positive=human.filter(v=>v.observation.assessment?.replyType==='interest'),meeting=human.filter(v=>v.observation.assessment?.meetingIntent==='yes');
    const modeled=inputs.filter(v=>{const r=v.observation.assessment;return r?.origin==='model'&&!r.withdrawn&&!r.requiresHumanReview&&humanTypes.has(r.replyType);}),modelMatched=matched(modeled),modelPositive=modelMatched.filter(v=>v.observation.assessment?.replyType==='interest'),modelMeeting=modelMatched.filter(v=>v.observation.assessment?.meetingIntent==='yes');
    const distinct=(rows:typeof reviewed,key:'contactId'|'accountId')=>new Set(rows.map(v=>v.observation[key])).size;
    const allMeetings=meetingObservations.filter(m=>m.hypothesisId===hypothesisId&&!m.withdrawn),meetings=allMeetings.filter(m=>contacts.has(m.contactId));for(const m of meetings)m.counted=true;
    const meetingCompanies=new Set(meetings.map(m=>m.accountId)).size,held=meetings.filter(m=>m.status==='held_confirmed'),heldCompanies=new Set(held.map(m=>m.accountId)).size;
    const acceptedIds=new Set(accepted.map(v=>v.observation.mailId));
    const dates=observations.filter(o=>o.source==='mail_tests'&&o.status==='sent'&&acceptedIds.has(o.mailId)).map(o=>o.occurredAt).sort((a,b)=>Date.parse(a)-Date.parse(b)||a.localeCompare(b));
    const fingerprints=[...new Set(observations.filter(o=>o.hypothesisId===hypothesisId).map(o=>o.fingerprint))];
    return {hypothesisId,personaName,name:hypothesis?.name||hypothesisId,personaId:hypothesis?.personaId||null,angle:hypothesis?.angle||'',campaigns:[...campaigns.values()].filter(c=>c.hypothesisId===hypothesisId),assignedCompanies:groups.length,assignedContacts:assigned.length,
      acceptedMessages:accepted.length,dialogueAcceptedMessages:dialogueMail.filter(v=>v.observation.status==='sent'&&!!v.event.providerId).length,dialogueFailedMessages:dialogueMail.filter(v=>v.observation.status==='failed').length,dialogueUnresolvedMessages:dialogueMail.filter(v=>['sending','unknown'].includes(v.observation.status)).length,dialogueIncomingMessages:inputs.filter(v=>v.observation.attribution.kind==='dialogue').length,acceptedContacts:contacts.size,acceptedCompanies:companies.size,failedMessages:campaignMail.filter(v=>v.observation.status==='failed').length,unresolvedMessages:campaignMail.filter(v=>['sending','unknown'].includes(v.observation.status)).length,
      incomingMessages:inputs.length,unreviewedMessages:inputs.filter(v=>{const r=v.observation.assessment;return !r||r.origin!=='human'||r.withdrawn||r.requiresHumanReview||r.replyType==='unclear';}).length,reportedReplies:inputs.filter(v=>v.observation.status==='reply').length,reportedAutomatic:inputs.filter(v=>v.observation.status==='automatic').length,reportedReview:inputs.filter(v=>v.observation.status==='review').length,
      assessedModelMessages:modeled.length,modelAssessmentsWithoutAcceptedContact:modeled.length-modelMatched.length,modelPositiveContacts:distinct(modelPositive,'contactId'),modelPositiveCompanies:distinct(modelPositive,'accountId'),modelMeetingIntentCompanies:distinct(modelMeeting,'accountId'),modelPositiveRate:rate(distinct(modelPositive,'accountId'),companies.size),modelMeetingIntentRate:rate(distinct(modelMeeting,'accountId'),companies.size),
      assessedHumanMessages:reviewed.length,assessmentsWithoutAcceptedContact:reviewed.length-human.length,humanReplyContacts:distinct(human,'contactId'),humanReplyCompanies:distinct(human,'accountId'),positiveContacts:distinct(positive,'contactId'),positiveCompanies:distinct(positive,'accountId'),meetingIntentContacts:distinct(meeting,'contactId'),meetingIntentCompanies:distinct(meeting,'accountId'),
      recordedMeetings:meetings.length,meetingsWithoutAcceptedContact:allMeetings.length-meetings.length,scheduledMeetings:meetings.filter(m=>['booked','rescheduled'].includes(m.status)).length,cancelledMeetings:meetings.filter(m=>m.status==='cancelled').length,noShowMeetings:meetings.filter(m=>m.status==='no_show').length,heldConfirmedMeetings:held.length,attendanceUnverifiedMeetings:meetings.filter(m=>m.attendanceUnverified).length,meetingCompanies,heldConfirmedCompanies:heldCompanies,meetingRate:rate(meetingCompanies,companies.size),heldConfirmedRate:rate(heldCompanies,companies.size),
      coverage:rate(companies.size,groups.length),humanReplyRate:rate(distinct(human,'accountId'),companies.size),positiveRate:rate(distinct(positive,'accountId'),companies.size),meetingIntentRate:rate(distinct(meeting,'accountId'),companies.size),firstAcceptedAt:dates[0]||null,lastAcceptedAt:dates.at(-1)||null,observedCampaignVersions:fingerprints.length};
  });
  if(arms.some(a=>!a.acceptedCompanies))warnings.push('Mindestens ein Testarm hat noch keinen angenommenen Versand. Ergebnisraten sind dort nicht berechenbar.');
  if(arms.some(a=>a.observedCampaignVersions>1))warnings.push('Mehrere Kampagnenfassungen fließen in mindestens einen Arm ein. Unterschiede nicht allein der Hypothese zuschreiben.');
  if(arms.some(a=>a.assessmentsWithoutAcceptedContact))warnings.push('Menschliche Bewertungen ohne angenommenen Versand an denselben Kontakt sind sichtbar, aber nicht in den Ergebnisraten enthalten.');
  const sequenceCounts=new Map<string,number>();for(const o of observations)if(o.counted){const key=o.campaignId+':'+o.fingerprint;sequenceCounts.set(key,(sequenceCounts.get(key)||0)+1);}
  const messageSequences=[...approvals].flatMap(([key,c])=>{
    const messaging=campaignMessaging(clientId,c);if(!messaging)return [];
    const [campaignId,fingerprint]=key.split(':');
    return [{campaignId,fingerprint,hypothesisId:c.hypothesisId!,...messaging,countedObservations:sequenceCounts.get(key)||0}];
  });
  const signalMails:SignalMail[]=[],firstAccepted=new Map<string,EvidenceEvent>();
  for(const e of events){if(e.source!=='mail_tests'||!e.providerId||JSON.parse(e.payload).status!=='sent')continue;const old=firstAccepted.get(e.sourceId);if(!old||e.sourceRevision<old.sourceRevision)firstAccepted.set(e.sourceId,e);}
  for(const {observation:o,event} of mailLatest.values()){
    if(o.attribution.kind!=='campaign'||o.status!=='sent'||!event.providerId)continue;
    const firstSent=firstAccepted.get(o.sourceId);
    if(firstSent&&observed.has(firstSent.id))signalMails.push({eventId:firstSent.id,mailId:o.mailId,hypothesisId:o.hypothesisId,contactId:o.contactId,accountId:o.accountId,acceptedAt:firstSent.occurredAt});
  }
  const responseComparison=experimentResponses(plan.input.hypothesisIds,signalMails,[...incoming.values()].map(v=>v.observation),calculationAt,windowDays);
  const {companyComparison:companySignalComparison,...signalComparison}=experimentSignals(s,clientId,plan.input.hypothesisIds,signalMails,calculationAt,windowDays,responseComparison);
  const meetingComparison=experimentMeetings(responseComparison,signalMails,meetingObservations,calculationAt);
  return {format:'eiz-experiment-results' as const,version:1,calculationVersion:'experiment-results-v8',attributionVersion:'dialogue-lineage-v1',generatedAt:calculationAt,clientName:client.name,productName:product?String(product.name):null,clientId,productId,experimentId,planVersionId:first.id,productRevision:plan.input.productRevision,name:plan.input.name,state,plannedAt:first.createdAt,
    arms,signalComparison,responseComparison,meetingComparison,companySignalComparison,warnings,observations,excluded,unattributed,messageSequences,meetingObservations,meetingExcluded,unavailable:['Automatisch verifizierte Terminbuchung und Teilnahme'],
    methodology:['Termine beruhen auf lokalen Betreiberbelegen, nicht auf Kalenderverifikation. Je Termin zählt nur die aktuelle nicht widerrufene Version. Erfasste Termine und Unternehmen mit Termin schließen Absagen und Nichterscheinen ein; bestätigte Teilnahme wird separat gezählt. Verschiebungen bleiben derselbe Termin. Verstrichene Terminzeit bedeutet nur ungeklärte Teilnahme. Raten benötigen eine angenommene Kampagnensendung am selben Kontakt; kein Nachweis der Abrechenbarkeit.', 'Anbieterannahme ist keine Zustell- oder Lesebestätigung. Follow-ups zählen als Nachrichten, Kontakte und Unternehmen jeweils nur einmal.', 'Ergebnisraten: Unternehmen mit mindestens einer aktuell menschlich geprüften Reaktion eines kontaktierten Gruppenmitglieds / Unternehmen mit angenommenem Versand. Jede Quote zeigt ihren Nenner.', 'Technische Eingangskategorien und menschliche Bewertungen sind getrennt. Nur aktuelle menschliche Bewertungen ohne Widerruf oder offenen Prüfbedarf zählen als geprüfte Ergebnisse.', 'Dialogzuordnung wird aus gespeicherten Belegketten abgeleitet; Rohbeobachtungen bleiben unverändert. Dialogsendungen werden separat gezählt und erweitern den Akquise-Nenner nicht. Nicht zuordenbare Beobachtungen sind kundenweit und gehören nicht nachweislich zu diesem Experiment.', 'KI-Einordnungen sind vorläufig und zählen nicht als menschlich bestätigte Ergebnisse. Korrekturen ersetzen die jeweilige aktuelle Einordnung; verschiedene Nachrichten desselben Unternehmens können in beiden Gruppen liegen. Gruppen nicht addieren.', 'Meetingabsicht ist weder Buchung noch Teilnahme. Kategorien können sich über verschiedene Eingänge überschneiden.', 'Gesamter gespeicherter Verlauf bis zum Berechnungsstand; unterschiedliche Laufzeiten und Kontaktzahlen beachten. Kein statistischer Sieger, kein Kausalitätsnachweis, keine automatische Regeländerung.']};
});}

import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
import type {Incoming} from './inbox';
import {markUnsubscribe} from './inbox';
import {exactObject,cleanText,type InterpretationContent} from './interpretation-input';
import {interpretationHistory} from './interpretations';
import {replyRun} from './reply-analysis';

const RULE='CONVERSATION_RULES_SAVED',CASE='CONVERSATION_CASE_SAVED';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
import {states,defaultConversationRules,type ConversationStatus,type ConversationRules} from './conversation-input';
export {defaultConversationRules,type ConversationStatus,type ConversationRules} from './conversation-input';

type RuleData={revision:number;previousId:string|null;clientVersion:number;briefRevision:number;rules:ConversationRules;actor:string;reason:string};
type RuleRow=RuleData&{id:string;createdAt:string};
type Basis={recipient:string;incomingId:string;eventId:string;assessmentId:string|null;analysisRunId:string|null;source:Pick<Incoming,'sender'|'subject'|'excerpt'|'receivedAt'|'kind'|'disposition'>;ambiguous:boolean;hasUnsubscribe:boolean;sourceHash:string};
type CaseData={recipient:string;revision:number;previousId:string|null;origin:'human'|'rule';policyId:string|null;basis:Basis;status:ConversationStatus;dueDate:string|null;actor:string;reason:string};
type CaseRow=CaseData&{id:string;createdAt:string};
function checked<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof AppError)throw e;throw new AppError('Ungültiger Gesprächsfall oder Regelstand. Daten neu laden und prüfen.');}}
function day(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Error('Invalid day');return value;}
function addDays(value:string,n:number){const d=new Date(day(value)+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return day(d.toISOString().slice(0,10));}
function rules(value:any):ConversationRules{exactObject(value,['enabled','allowModel','absenceReminders','rejectionCooldown','absenceDelayDays','cooldownDays']);for(const k of ['enabled','allowModel','absenceReminders','rejectionCooldown'])if(typeof value[k]!=='boolean')throw new Error();for(const [k,min,max] of [['absenceDelayDays',0,30],['cooldownDays',1,365]] as const)if(!Number.isSafeInteger(value[k])||value[k]<min||value[k]>max)throw new Error();return {...value};}
function logRows(s:Store,clientId:string){s.client(clientId);const rows=s.db.prepare('SELECT * FROM events WHERE clientId=? AND type IN (?,?) ORDER BY rowid LIMIT 10001').all(clientId,RULE,CASE) as LedgerEvent[];if(rows.length>10000)throw new AppError('Mehr als 10.000 Gesprächsentscheidungen für diesen Kunden. Verlauf wurde nicht gekürzt.',413);return rows;}
function ruleRows(rows:LedgerEvent[]):RuleRow[]{return rows.filter(e=>e.type===RULE).map(e=>({...JSON.parse(e.text),id:e.id,createdAt:e.createdAt})).sort((a,b)=>b.revision-a.revision);}
function caseRows(rows:LedgerEvent[],recipient?:string):CaseRow[]{return rows.filter(e=>e.type===CASE).map(e=>({...JSON.parse(e.text),id:e.id,createdAt:e.createdAt})).filter(e=>recipient===undefined||e.recipient===recipient).sort((a,b)=>b.revision-a.revision);}
function append(s:Store,clientId:string,type:string,data:RuleData|CaseData,at=new Date()){if(logRows(s,clientId).length>=10000)throw new AppError('Gesprächsverlauf voll. Keine Entscheidung gespeichert.');const id=randomUUID();s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(id,clientId,null,type,JSON.stringify(data),at.toISOString());return {id,createdAt:at.toISOString(),...data};}
function policyState(s:Store,clientId:string,rows=logRows(s,clientId)){
 const current=ruleRows(rows)[0]||null,c=s.client(clientId),b=s.briefState(clientId);
 const active=!!current?.rules.enabled&&c.status!=='paused'&&b.approved&&current.clientVersion===c.version&&current.briefRevision===b.revision;
 return {current,active,clientVersion:c.version,briefRevision:b.revision,reason:active?'Freigegebene Regeln sind aktiv.':!current?.rules.enabled?'Automatische Fallsteuerung ausgeschaltet.':'Kunde pausiert oder Kundenrahmen geändert. Regeln erneut prüfen und freigeben.',history:ruleRows(rows)};
}
export function saveConversationRules(s:Store,clientId:string,input:any){return checked(()=>s.transaction(()=>{
 exactObject(input,['expectedId','clientVersion','briefRevision','rules','actor','reason','confirmed']);if(input.confirmed!==true)throw new Error();const p=policyState(s,clientId),value=rules(input.rules),actor=cleanText(input.actor,120),reason=cleanText(input.reason,1500);
 if(input.expectedId!==(p.current?.id||null)||input.clientVersion!==p.clientVersion||input.briefRevision!==p.briefRevision)throw new AppError('Regel- oder Kundenstand geändert. Neu laden.',409);
 if(value.enabled&&(s.client(clientId).status==='paused'||!s.briefState(clientId).approved))throw new AppError('Aktiven Kundenrahmen zuerst freigeben.');
 append(s,clientId,RULE,{revision:(p.current?.revision||0)+1,previousId:p.current?.id||null,clientVersion:p.clientVersion,briefRevision:p.briefRevision,rules:value,actor,reason});return policyState(s,clientId);
}));}
function basisFor(s:Store,clientId:string,recipient:string){
 s.client(clientId);const messages=s.db.prepare('SELECT * FROM incoming WHERE clientId=? AND recipient=? ORDER BY receivedAt DESC,id DESC LIMIT 201').all(clientId,recipient) as Incoming[];messages.sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt)||b.id.localeCompare(a.id));
 if(!messages.length)throw new AppError('Gespräch nicht gefunden.',404);if(messages.length>200)throw new AppError('Mehr als 200 Eingänge zu diesem Kontakt. Manuelle Klärung erforderlich; nichts gekürzt.',413);
 const m=messages[0],e=s.db.prepare("SELECT id FROM evidence_events WHERE clientId=? AND source='incoming' AND sourceId=? ORDER BY sourceRevision,rowid LIMIT 1").get(clientId,m.id);if(!e)throw new AppError('Eingangsbeleg fehlt.');
 const h=interpretationHistory(s,clientId,String(e.id)),assessment=h.rows[0]||null;
 const modelId=assessment?.origin==='model'&&assessment.promptVersion.startsWith('reply-analysis-v1:')?assessment.promptVersion.slice('reply-analysis-v1:'.length):null;
 const run=modelId?replyRun(s,clientId,modelId):null;
 const source={sender:m.sender,subject:m.subject,excerpt:m.excerpt,receivedAt:m.receivedAt,kind:m.kind,disposition:m.disposition};
 const basis:Basis={recipient,incomingId:m.id,eventId:String(e.id),assessmentId:assessment?.id||null,analysisRunId:run?.id||null,source,ambiguous:messages.length>1&&Date.parse(messages[1].receivedAt)===Date.parse(m.receivedAt),hasUnsubscribe:messages.some(m=>m.disposition==='unsubscribe'),sourceHash:hash([messages,assessment?.id||null])};
 return {basis,assessment,analysis:run?.result?.analysis||null};
}
function decision(b:Basis,value:InterpretationContent|null,origin:string|undefined,analysis:any,r:ConversationRules):{status:ConversationStatus;dueDate:string|null;reason:string}{
 const review=(reason:string)=>({status:'needs_review' as const,dueDate:null,reason});
 if(b.hasUnsubscribe)return {status:'permanent_suppression',dueDate:null,reason:'Bereits bestätigtes Kontaktverbot. Keine Freigabe durch Gesprächsregeln.'};
 if(b.ambiguous)return review('Mehrere Eingänge mit derselben Eingangszeit. Reihenfolge menschlich klären.');
 if(!value||value.withdrawn)return review('Keine aktuelle, verwertbare Bewertung.');
 if(b.source.kind==='review')return review('Technische Zuordnung verlangt menschliche Prüfung.');
 if(origin==='model'){
  if(!r.allowModel||!analysis||analysis.confidence!=='high')return review('Modellbewertung nicht für automatische Fallsteuerung freigegeben oder unsicher.');
  if(analysis.privacyRequest!=='no'||analysis.unsubscribe!=='no')return review('Datenschutz oder mögliches Kontaktverbot: menschlich klären.');
  if([analysis.technicalQuestion,analysis.materialRequest,analysis.meetingIntent].includes('unknown'))return review('Modellbewertung enthält offene fachliche Signale.');
 }else if(value.requiresHumanReview)return review('Die menschliche Bewertung fordert eine Klärung.');
 if(value.replyType==='out_of_office'){
  if(!r.absenceReminders||!analysis?.returnDate)return review('Abwesenheit: kein für die Regel freigegebener Rückkehrbeleg. Datum manuell setzen.');
  return {status:'absence_until',dueDate:addDays(analysis.returnDate,r.absenceDelayDays),reason:'Wiedervorlage aus belegtem Rückkehrdatum plus freigegebenem Abstand. Kein automatischer Versand.'};
 }
 if(value.replyType==='rejection'){
  if(origin==='model'&&analysis.rejectionScope!=='contact')return review('Mögliche Account-Ablehnung oder unklarer Ablehnungsumfang.');
  if(!r.rejectionCooldown)return review('Persönliche Ablehnung. Automatischer Cooldown ist nicht freigegeben.');
  return {status:'cooldown_until',dueDate:addDays(new Date(b.source.receivedAt).toISOString().slice(0,10),r.cooldownDays),reason:'Persönliche Ablehnung: Cooldown ab Eingangstag. Keine permanente Sperre und kein Wiederanlauf nach Fristende.'};
 }
 if(value.meetingIntent==='yes')return review('Termininteresse: Abstimmung oder Buchungsweg prüfen.');
 if(value.technicalQuestion==='yes'||value.materialRequest==='yes')return review('Fachfrage oder Materialwunsch: freigegebene Antwortgrundlage prüfen.');
 if(value.replyType==='interest')return {status:'dialogue_ready',dueDate:null,reason:'Interesse eingeordnet. Gespräch vorbereiten; Versand benötigt den getrennten Dialogpfad.'};
 return review('Weitere Bearbeitung oder Zuständigkeit menschlich klären.');
}
export function conversationPreview(s:Store,clientId:string,recipient:string){return checked(()=>{
 const rows=logRows(s,clientId),p=policyState(s,clientId,rows),current=caseRows(rows,recipient)[0]||null,info=basisFor(s,clientId,recipient);
 const proposed=decision(info.basis,info.assessment?.content||null,info.assessment?.origin,info.analysis,p.current?.rules||defaultConversationRules());
 return {recipient,current,policy:p,basis:info.basis,assessment:info.assessment,analysis:info.analysis,proposed,basisHash:hash([info.basis,p.current?.id||null,p.clientVersion,p.briefRevision,current?.id||null])};
});}
export function saveConversationCase(s:Store,clientId:string,input:any){return checked(()=>{
 exactObject(input,['recipient','expectedId','basisHash','status','dueDate','actor','reason','confirmed']);if(input.confirmed!==true||!states.includes(input.status))throw new Error();const actor=cleanText(input.actor,120),reason=cleanText(input.reason,1500);
 const write=()=>{const p=conversationPreview(s,clientId,input.recipient);if(input.expectedId!==(p.current?.id||null)||input.basisHash!==p.basisHash)throw new AppError('Gespräch, Bewertung oder Regelstand geändert. Vorschau neu laden.',409);
  if((p.current?.status==='permanent_suppression'||p.basis.hasUnsubscribe)&&input.status!=='permanent_suppression')throw new AppError('Ein bestätigtes Kontaktverbot kann hier nicht aufgehoben werden.');
  if(['absence_until','cooldown_until'].includes(input.status)){if(typeof input.dueDate!=='string'||day(input.dueDate)<new Date().toISOString().slice(0,10))throw new AppError('Wiedervorlage muss heute oder später liegen (UTC-Datum).');}else if(input.dueDate!==null)throw new Error();
  const data:CaseData={recipient:input.recipient,revision:(p.current?.revision||0)+1,previousId:p.current?.id||null,origin:'human',policyId:p.policy.current?.id||null,basis:p.basis,status:input.status,dueDate:input.dueDate,actor,reason};
  if(input.status==='permanent_suppression'){
   // The caller below owns the existing unsubscribe transaction; this callback only appends provenance.
   return data;
  }
  append(s,clientId,CASE,data);return data;
 };
 if(input.status==='permanent_suppression'){
  const p=conversationPreview(s,clientId,input.recipient);
  let data:CaseData;markUnsubscribe(s,clientId,p.basis.incomingId,{before(){data=write();},after(){append(s,clientId,CASE,data);}});
 }else s.transaction(write);
 return conversationPreview(s,clientId,input.recipient);
});}
export function applyConversationRules(s:Store,clientId:string,limit=25,at=new Date()){return checked(()=>s.transaction(()=>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isFinite(at.getTime()))throw new Error();const rows=logRows(s,clientId),p=policyState(s,clientId,rows);if(!p.active)return {applied:0,active:false};
 const recipients=s.db.prepare('SELECT DISTINCT recipient FROM incoming WHERE clientId=? ORDER BY recipient LIMIT 10001').all(clientId);if(recipients.length>10000)throw new AppError('Mehr als 10.000 Gesprächskontakte. Verarbeitung nicht gekürzt.',413);
 const latest=new Map<string,CaseRow>();for(const row of caseRows(rows))if(!latest.has(row.recipient))latest.set(row.recipient,row);let applied=0;
 for(const row of recipients){if(applied>=limit)break;const recipient=String(row.recipient),previous=latest.get(recipient);if(previous?.status==='permanent_suppression')continue;
  const info=basisFor(s,clientId,recipient);if(previous?.basis.sourceHash===info.basis.sourceHash||previous?.origin==='human'&&previous.basis.incomingId===info.basis.incomingId&&!info.basis.hasUnsubscribe)continue;
  const result=decision(info.basis,info.assessment?.content||null,info.assessment?.origin,info.analysis,p.current!.rules);
  append(s,clientId,CASE,{recipient,revision:(previous?.revision||0)+1,previousId:previous?.id||null,origin:'rule',policyId:p.current!.id,basis:info.basis,...result,actor:'Freigegebene Gesprächsregeln'},at);applied++;
 }
 return {applied,active:true};
}));}
export function tickConversations(s:Store,at=new Date()){
 const clients=s.db.prepare("SELECT id FROM clients WHERE status!='paused' ORDER BY id LIMIT 1001").all();if(clients.length>1000)throw new AppError('Zu viele Kunden für den lokalen Gesprächsdienst.');
 const failures:string[]=[];let applied=0;for(const c of clients)try{applied+=applyConversationRules(s,String(c.id),25,at).applied;}catch{failures.push(String(c.id));}return {applied,failedClients:failures};
}
export function conversationState(s:Store,clientId:string,offset=0,at=new Date()){
 if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw new AppError('Ungültige Gesprächsseite.');const rows=logRows(s,clientId),p=policyState(s,clientId,rows),current=new Map<string,CaseRow>();for(const row of caseRows(rows))if(!current.has(row.recipient))current.set(row.recipient,row);
 const recipients=s.db.prepare('SELECT DISTINCT recipient FROM incoming WHERE clientId=? ORDER BY recipient LIMIT 10001').all(clientId);if(recipients.length>10000)throw new AppError('Mehr als 10.000 Gesprächskontakte. Ansicht nicht gekürzt.',413);
 const cases=recipients.map(r=>{const recipient=String(r.recipient),c=current.get(recipient)||null;const info=basisFor(s,clientId,recipient),stale=!!c&&(c.basis.incomingId!==info.basis.incomingId||c.origin==='rule'&&c.basis.sourceHash!==info.basis.sourceHash);return {recipient,current:c,stale,due:!stale&&!!c?.dueDate&&c.dueDate<=at.toISOString().slice(0,10),history:caseRows(rows,recipient)};});
 cases.sort((a,b)=>Number(b.due)-Number(a.due)||a.recipient.localeCompare(b.recipient));
 return {policy:p,total:cases.length,dueCount:cases.filter(c=>c.due).length,offset,nextOffset:offset+50<cases.length?offset+50:null,cases:cases.slice(offset,offset+50),asOf:at.toISOString(),timezone:'UTC'};
}

export function validateConversations(data:BackupData,version:number){checked(()=>{
 const events=data.events.filter(e=>[RULE,CASE].includes(e.type));if(events.length&&version<22)throw new Error();const byId=new Map(events.map(e=>[e.id,e])),chains=new Map<string,LedgerEvent[]>();
 for(const e of events){if(!e.clientId||e.jobId!==null||!data.clients.some(c=>c.id===e.clientId))throw new Error();const d=JSON.parse(e.text);const keys=e.type===RULE?['revision','previousId','clientVersion','briefRevision','rules','actor','reason']:['recipient','revision','previousId','origin','policyId','basis','status','dueDate','actor','reason'];exactObject(d,keys);cleanText(d.actor,120);cleanText(d.reason,1500);if(!Number.isSafeInteger(d.revision)||d.revision<1)throw new Error();
  if(e.type===RULE){rules(d.rules);if(!Number.isSafeInteger(d.clientVersion)||d.clientVersion<1||!Number.isSafeInteger(d.briefRevision)||d.briefRevision<0)throw new Error();}
  else {
   if(!['human','rule'].includes(d.origin)||!states.includes(d.status))throw new Error();const b=d.basis;exactObject(b,['recipient','incomingId','eventId','assessmentId','analysisRunId','source','ambiguous','hasUnsubscribe','sourceHash']);exactObject(b.source,['sender','subject','excerpt','receivedAt','kind','disposition']);
   const incoming=data.incoming?.find(i=>i.id===b.incomingId&&i.clientId===e.clientId&&i.recipient===d.recipient),event=data.evidenceEvents?.find(v=>v.id===b.eventId&&v.clientId===e.clientId&&v.sourceId===b.incomingId&&v.source==='incoming');
   if(!incoming||!event||b.recipient!==d.recipient||typeof b.ambiguous!=='boolean'||typeof b.hasUnsubscribe!=='boolean'||!/^[a-f0-9]{64}$/.test(b.sourceHash)||!['open','unsubscribe'].includes(b.source.disposition))throw new Error();
   for(const k of ['sender','subject','excerpt','receivedAt','kind'] as const)if(b.source[k]!==incoming[k])throw new Error();
   const a=b.assessmentId?(data.interpretations||[]).find(i=>i.id===b.assessmentId&&i.clientId===e.clientId&&i.eventId===b.eventId):null;if(b.assessmentId!==null&&!a)throw new Error();
   const run=b.analysisRunId?data.aiRuns?.find(r=>r.id===b.analysisRunId&&r.clientId===e.clientId&&r.purpose==='reply-analysis'&&r.status==='completed'):null;if(b.analysisRunId!==null&&(!run||!a||a.promptVersion!=='reply-analysis-v1:'+run.id||JSON.parse(run.result).interpretationId!==a.id))throw new Error();
   const policy=d.policyId?byId.get(d.policyId):null;if(d.policyId!==null&&(!policy||policy.type!==RULE||policy.clientId!==e.clientId))throw new Error();
   if(['absence_until','cooldown_until'].includes(d.status)){day(d.dueDate);}else if(d.dueDate!==null)throw new Error();
   if(d.status==='permanent_suppression'&&!data.incoming?.some(i=>i.clientId===e.clientId&&i.recipient===d.recipient&&i.disposition==='unsubscribe'))throw new Error();
   if(d.origin==='rule'){if(!policy||!JSON.parse(policy.text).rules.enabled||d.actor!=='Freigegebene Gesprächsregeln')throw new Error();const expected=decision(b,a?JSON.parse(a.content):null,a?.origin,run?JSON.parse(run.result).analysis:null,JSON.parse(policy.text).rules);if(d.status!==expected.status||d.dueDate!==expected.dueDate||d.reason!==expected.reason)throw new Error();}
  }
  const key=e.clientId+':'+e.type+(e.type===CASE?':'+d.recipient:'');const chain=chains.get(key)||[];chain.push(e);chains.set(key,chain);
 }
 for(const chain of chains.values()){chain.sort((a,b)=>JSON.parse(a.text).revision-JSON.parse(b.text).revision);for(let i=0;i<chain.length;i++){const d=JSON.parse(chain[i].text);if(d.revision!==i+1||d.previousId!==(i?chain[i-1].id:null))throw new Error();if(i&&chain[i].type===CASE&&JSON.parse(chain[i-1].text).status==='permanent_suppression'&&d.status!=='permanent_suppression')throw new Error();}}
});}
export function mergeConversations(s:Store,data:BackupData){const events=new Map(data.events.map(e=>[e.id,e]));for(const e of s.db.prepare('SELECT * FROM events WHERE type IN (?,?)').all(RULE,CASE) as LedgerEvent[]){const old=events.get(e.id);if(old&&(Object.keys(e) as (keyof LedgerEvent)[]).some(k=>old[k]!==e[k]))throw new AppError('Sicherung widerspricht einer bekannten Gesprächsentscheidung.');events.set(e.id,e);}const merged=[...events.values()];validateConversations({...data,events:merged},22);return merged;}
export function exportConversations(s:Store,clientId:string){return {format:'eiz-conversation-history',version:1,clientId,exportedAt:new Date().toISOString(),events:logRows(s,clientId)};}

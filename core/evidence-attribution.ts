import {AppError,type Store} from './store';
import type {EvidenceContext,EvidenceEvent} from './evidence-journal';
import type {LedgerEvent} from './types';

export type Attribution={kind:'campaign'|'dialogue'|'unattributed';context:EvidenceContext|null;rootMailId:string|null;rootEventId:string|null;path:string[];reason:string};
// A read-time derivation from retained records. Original journal observations are never rewritten.
export function evidenceAttribution(s:Store,clientId:string,events:EvidenceEvent[]){
 s.client(clientId);
 const ledger=s.db.prepare("SELECT * FROM events WHERE clientId=? AND type='DIALOGUE_RESERVED' LIMIT 100001").all(clientId) as LedgerEvent[];
 if(ledger.length>100000)throw new AppError('Zu viele Dialogbelege für die Herkunftsprüfung.',413);
 const dialogues=new Map(ledger.map(e=>[e.id,e]));
 const firstMail=new Map<string,EvidenceEvent>(),incoming=new Map<string,EvidenceEvent>();
 for(const e of events){if(e.clientId!==clientId)throw new AppError('Fremdkunde in Herkunftsprüfung.');if(e.source==='incoming')incoming.set(e.sourceId,e);else{const old=firstMail.get(e.sourceId);if(!old||e.sourceRevision<old.sourceRevision)firstMail.set(e.sourceId,e);}}
 const mails=new Map(s.db.prepare('SELECT id,mailboxId,sender,recipient FROM mail_tests WHERE clientId=?').all(clientId).map(m=>[String(m.id),m]));
 const inputs=new Map(s.db.prepare('SELECT id,mailId,mailboxId,recipient,threadId FROM incoming WHERE clientId=?').all(clientId).map(i=>[String(i.id),i]));
 const unresolved=(reason:string,path:string[]=[]):Attribution=>({kind:'unattributed',context:null,rootMailId:null,rootEventId:null,path,reason});
 function resolve(e:EvidenceEvent,seen:Set<string>,path:string[]):Attribution{
  const c:EvidenceContext=JSON.parse(e.context),mailId=c.mailId;
  if(seen.has(mailId)||seen.size>=100)return unresolved('Zyklische oder zu lange Dialogherkunft.',path);
  seen.add(mailId);
  if(c.campaignId){if(dialogues.has(mailId))return unresolved('Dialog und direkte Kampagnenherkunft widersprechen sich.',path);return {kind:'campaign',context:c,rootMailId:mailId,rootEventId:firstMail.get(mailId)?.id||e.id,path:[...path,e.id,...(firstMail.get(mailId)&&firstMail.get(mailId)!.id!==e.id?[firstMail.get(mailId)!.id]:[])],reason:'Historische Kampagnenzuordnung aus Rohbeleg.'};}
  const declaration=dialogues.get(mailId);if(!declaration)return unresolved('Keine historische Kampagnen- oder Dialogzuordnung.',path);
  const d=JSON.parse(declaration.text),parent=incoming.get(d.incomingId),input=inputs.get(d.incomingId),mail=mails.get(mailId);
  const next=[...path,e.id,declaration.id];
  if(!parent||!input||!mail)return unresolved('Dialogquelle oder verknüpfte Nachricht fehlt.',next);
  const parentContext:EvidenceContext=JSON.parse(parent.context),parentMail=mails.get(String(input.mailId)),payload=JSON.parse(parent.payload);
  if(declaration.jobId!==null||parentContext.mailId!==input.mailId||d.mailboxId!==e.mailboxId||d.mailboxId!==parent.mailboxId||d.mailboxId!==input.mailboxId||d.mailboxId!==mail.mailboxId||d.recipient!==input.recipient||d.recipient!==mail.recipient||d.sender!==mail.sender||d.threadId!==input.threadId||d.threadId!==payload.threadId||!parentMail||parentMail.mailboxId!==d.mailboxId||parentMail.recipient!==d.recipient||parentMail.sender!==d.sender)return unresolved('Dialogherkunft widerspricht Kunde, Postfach, Empfänger oder Gespräch.',next);
  const root=resolve(parent,seen,next);
  if(!root.context)return root;
  return {...root,kind:'dialogue',context:{...root.context,mailId},reason:'Aus gespeicherter Dialogkette abgeleitet; ursprünglicher Rohbeleg unverändert.'};
 }
 return (event:EvidenceEvent):Attribution=>{if(event.clientId!==clientId)throw new AppError('Fremdkunde in Herkunftsprüfung.');return resolve(event,new Set(),[]);};
}

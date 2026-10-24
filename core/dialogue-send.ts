import {mailPresentation,freezeMailPresentation,assertMailPresentation} from './mail-presentation';
import {assertTrackingReady} from './tracking';
import {assertAutoAttempt} from './dialogue-auto';
import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
import type {MailTest} from './mail';
import {currentReplyDraft} from './reply-writing';
import {threadContextSetup,threadContextState} from './thread-context';
import {validateThreadCapture} from './thread-input';
import {assertDeliveryFresh} from './delivery-progress';
import {unassigned} from './unassigned';
import {exactObject} from './interpretation-input';
import {conversationPreview} from './conversations';
const RESERVED='DIALOGUE_RESERVED',AUTHORIZED='DIALOGUE_AUTHORIZED';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(message:string):never=>{throw new AppError(message,409);};
const epoch=(s:Store)=>String(s.db.prepare("SELECT id FROM events WHERE type='QUEUE_EMERGENCY_STOP' ORDER BY rowid DESC LIMIT 1").get()?.id||'');
function checked<T>(f:()=>T):T{try{return f();}catch(e){if(e instanceof AppError)throw e;throw new AppError((e as Error).message);}}
export function dialogueRecord(s:Store,clientId:string,id:string){return s.db.prepare('SELECT * FROM events WHERE id=? AND clientId=? AND type=?').get(id,clientId,RESERVED) as LedgerEvent|undefined;}
export function dialogueHistory(s:Store,clientId:string,incomingId:string){threadContextState(s,clientId,incomingId);return s.db.prepare("SELECT e.id,e.text,e.createdAt,m.status,m.providerId,m.result FROM events e JOIN mail_tests m ON m.id=e.id WHERE e.clientId=? AND e.type=? AND json_extract(e.text,'$.incomingId')=? ORDER BY e.rowid DESC").all(clientId,RESERVED,incomingId).map(r=>({id:String(r.id),createdAt:String(r.createdAt),status:String(r.status),providerId:String(r.providerId),result:String(r.result),snapshot:JSON.parse(String(r.text))}));}
function context(s:Store,clientId:string,incomingId:string,draftId:string){
 const {draft,setup}=currentReplyDraft(s,clientId,incomingId,draftId),thread=threadContextState(s,clientId,incomingId),source=threadContextSetup(s,clientId,incomingId),last=thread.capture!.messages.at(-1)!;
 if(source.incoming.kind!=='reply'||conversationPreview(s,clientId,source.mail.recipient).assessment?.content.requiresHumanReview!==false)fail('Eingang benötigt menschliche Klärung.');
 if(last.providerId!==source.incoming.providerId||last.direction!=='received')fail('Gespräch wurde bereits beantwortet oder enthält neuere Nachrichten. Neu einlesen und bewerten.');
 if(!/^<[^<>\s@]+@[^<>\s@]+>$/.test(last.messageId)||last.messageId.length>254)fail('Eindeutige Antwortreferenz fehlt.');
 if(!last.subject.trim()||last.subject.length>120||/[\r\n\0]/.test(last.subject))fail('Gesprächsbetreff nicht sicher verwendbar.');
 const presentation=mailPresentation(s,clientId,{to:source.mail.recipient,subject:last.subject,bodyText:draft.body,inReplyTo:last.messageId,references:[last.messageId]},source.mail.mailboxId,source.mail.sender);
 return {...(presentation?{presentation}:{}),draftId,incomingId,runId:draft.runId,writingBasisHash:setup.basisHash,threadSnapshotId:thread.latest!.id,threadDigest:thread.latest!.digest,mailboxId:source.mail.mailboxId,sender:source.mail.sender,recipient:source.mail.recipient,threadId:source.incoming.threadId,inReplyTo:last.messageId,subject:last.subject,body:draft.body,clientVersion:setup.context.clientVersion,briefRevision:setup.context.briefRevision,stopEpoch:epoch(s)};
}
function gates(s:Store,clientId:string,mailboxId:string,except='',at=new Date()){
 if(!Number.isFinite(at.getTime()))fail('Ungültige Uhrzeit.');
 assertDeliveryFresh(s,clientId,mailboxId);
 if(unassigned(s,clientId).some(x=>x.status==='open'))fail('Ungeklärte Postfacheingänge zuerst bearbeiten.');
 if(s.db.prepare("SELECT id FROM mail_tests WHERE clientId=? AND id<>? AND status IN ('sending','unknown') LIMIT 1").get(clientId,except))fail('Versandergebnis noch offen. Zuerst Gmail abgleichen.');
 const day=at.toISOString().slice(0,10),rows=s.db.prepare('SELECT id,createdAt FROM mail_tests WHERE clientId=? AND id<>? AND substr(createdAt,1,10)=?').all(clientId,except,day);
 if(rows.length>=s.brief(clientId).content.rules.dailyLimit)fail('Gemeinsames Tageslimit erreicht. Fehlversuche zählen mit.');
 const last=s.db.prepare('SELECT MAX(createdAt) at FROM mail_tests WHERE clientId=? AND id<>?').get(clientId,except)?.at;
 if(last&&at.getTime()-Date.parse(String(last))<60000)fail('Mindestabstand von einer Minute pro Kunde.');
}
export function dialoguePreview(s:Store,clientId:string,incomingId:string,draftId:string){
 const snapshot=context(s,clientId,incomingId,draftId);
 if(s.db.prepare("SELECT id FROM events WHERE clientId=? AND type=? AND json_extract(text,'$.incomingId')=?").get(clientId,RESERVED,incomingId))fail('Für diesen Eingang existiert bereits ein Versandversuch. Kein erneuter Versand.');
 gates(s,clientId,snapshot.mailboxId);return {snapshot,basisHash:hash(snapshot),draftSubject:currentReplyDraft(s,clientId,incomingId,draftId).draft.subject};
}
export function reserveDialogue(s:Store,clientId:string,incomingId:string,input:any){return checked(()=>s.transaction(()=>{
 exactObject(input,['draftId','basisHash','confirmed','mailboxId','sender','capture',...(Object.hasOwn(input||{},'autoAttemptId')?['autoAttemptId']:[])]);if(input.confirmed!==true)fail('Echten Antwortversand ausdrücklich bestätigen.');const p=dialoguePreview(s,clientId,incomingId,input.draftId);
 if(p.basisHash!==input.basisHash)fail('Versandvorschau geändert. Neu prüfen.');if(input.mailboxId!==p.snapshot.mailboxId||input.sender!==p.snapshot.sender)fail('Postfach oder Absender geändert.');
 if(hash(validateThreadCapture(input.capture))!==p.snapshot.threadDigest)fail('Google-Gespräch inzwischen geändert. Neu einlesen und Antwort prüfen.');
 if(Object.hasOwn(input,'autoAttemptId')){const policy=assertAutoAttempt(s,clientId,input.autoAttemptId,incomingId,input.draftId,p.basisHash);if(policy.mailboxId!==p.snapshot.mailboxId||policy.sender!==p.snapshot.sender)fail('Automatikpostfach geändert.');}
 const id=randomUUID(),at=new Date().toISOString(),d={...p.snapshot,...(Object.hasOwn(input,'autoAttemptId')?{autoAttemptId:input.autoAttemptId}:{})},messageId=`<${id}@workbench.local>`;
 s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(id,clientId,null,RESERVED,JSON.stringify(d),at);
 s.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,clientId,d.mailboxId,d.sender,d.recipient,d.subject,d.body,messageId,'sending','','Antwort reserviert; Ergebnis offen.',at,at);
 freezeMailPresentation(s,{id,clientId,...d},d.presentation);return {id,clientId,...d,messageId};
}));}
export function authorizeDialogue(s:Store,clientId:string,id:string,input:any){return checked(()=>s.transaction(()=>{
 assertTrackingReady(s,clientId,id);assertMailPresentation(s,clientId,id);
 exactObject(input,['mailboxId','sender']);const e=dialogueRecord(s,clientId,id);if(!e)fail('Antwortauftrag fehlt.');const d=JSON.parse(e!.text),m=s.db.prepare('SELECT * FROM mail_tests WHERE id=? AND clientId=?').get(id,clientId) as MailTest|undefined;
 if(!m||m.status!=='sending')fail('Antwortauftrag nicht mehr aktiv.');const age=Date.now()-Date.parse(m!.createdAt);if(age<0||age>60000)fail('Versandreservierung abgelaufen.');
 if(input.mailboxId!==d.mailboxId||input.sender!==d.sender)fail('Postfach geändert.');const {autoAttemptId,...snapshot}=d;if(autoAttemptId)assertAutoAttempt(s,clientId,autoAttemptId,d.incomingId,d.draftId,hash(snapshot),id);if(hash(context(s,clientId,d.incomingId,d.draftId))!==hash(snapshot))fail('Antwortgrundlage oder Notstopp geändert.');gates(s,clientId,d.mailboxId,id);
 if(s.db.prepare("SELECT id FROM events WHERE clientId=? AND type=? AND json_extract(text,'$.mailId')=?").get(clientId,AUTHORIZED,id))fail('Versandentscheidung bereits verbraucht.');
 s.event(clientId,null,AUTHORIZED,JSON.stringify({mailId:id}));return {allowed:true};
}));}
export function finishDialogue(s:Store,clientId:string,id:string,input:any){return checked(()=>s.transaction(()=>{
 exactObject(input,['status','providerId','result']);if(!dialogueRecord(s,clientId,id))fail('Antwortauftrag fehlt.');const {status,providerId,result}=input;
 if(!['sent','failed','unknown'].includes(status)||typeof providerId!=='string'||(status==='sent'?!/^[a-zA-Z0-9_-]{1,200}$/.test(providerId):providerId!=='')||typeof result!=='string'||result.length>2000)fail('Ungültiger Antwortabschluss.');
 if(status==='sent'&&!s.db.prepare("SELECT id FROM events WHERE clientId=? AND type=? AND json_extract(text,'$.mailId')=?").get(clientId,AUTHORIZED,id))fail('Versandentscheidung fehlt.');
 if(!s.db.prepare("UPDATE mail_tests SET status=?,providerId=?,result=?,updatedAt=? WHERE id=? AND clientId=? AND status='sending'").run(status,providerId,result,new Date().toISOString(),id,clientId).changes)fail('Antwortabschluss bereits gespeichert.');
 s.event(clientId,null,'DIALOGUE_FINISHED',JSON.stringify({mailId:id,status,providerId}));return {status};
}));}
export function expireDialogues(s:Store){return s.transaction(()=>s.db.prepare("UPDATE mail_tests SET status='unknown',result='Antwortabschluss fehlt. Gmail abgleichen; keine Wiederholung.',updatedAt=? WHERE status='sending' AND createdAt<? AND id IN (SELECT id FROM events WHERE type=?)").run(new Date().toISOString(),new Date(Date.now()-180000).toISOString(),RESERVED).changes);}
export function protectDialogueRestore(s:Store,data:BackupData){for(const e of s.db.prepare("SELECT * FROM events WHERE type IN ('DIALOGUE_RESERVED','DIALOGUE_AUTHORIZED','DIALOGUE_FINISHED')").all() as LedgerEvent[]){const old=data.events.find(x=>x.id===e.id);if(!old||Object.keys(e).some(k=>(e as any)[k]!== (old as any)[k]))fail('Sicherung würde bekannte Dialog-Versandhistorie zurücksetzen. Aktuelle Sicherung verwenden.');if(e.type===RESERVED){const m=s.db.prepare('SELECT * FROM mail_tests WHERE id=?').get(e.id)!,saved=data.mailTests?.find(x=>x.id===e.id);if(!saved||Object.keys(m).some(k=>m[k]!== (saved as any)[k]))fail('Sicherung würde bekannten Dialog-Versandstatus zurücksetzen.');}}}
export function validateDialogue(data:BackupData,version:number){checked(()=>{
 const rows=data.events.filter(e=>e.type===RESERVED),seen=new Set<string>();if(version<25&&data.events.some(e=>e.type.startsWith('DIALOGUE_')))fail('Dialogversand benötigt Datenversion25.');
 for(const e of rows){const d=JSON.parse(e.text);exactObject(d,['draftId','incomingId','runId','writingBasisHash','threadSnapshotId','threadDigest','mailboxId','sender','recipient','threadId','inReplyTo','subject','body','clientVersion','briefRevision','stopEpoch',...(Object.hasOwn(d,'autoAttemptId')?['autoAttemptId']:[])]);if(Object.hasOwn(d,'autoAttemptId')&&(typeof d.autoAttemptId!=='string'||!/^[a-f0-9-]{36}$/.test(d.autoAttemptId)))fail('Ungültiger Automatikverweis.');const draft=data.events.find(x=>x.id===d.draftId&&x.clientId===e.clientId&&x.type==='REPLY_DRAFT_SAVED'),r=data.aiRuns?.find(x=>x.id===d.runId&&x.clientId===e.clientId&&x.purpose==='reply-writing'),t=data.threadContexts?.find(x=>x.id===d.threadSnapshotId&&x.clientId===e.clientId&&x.incomingId===d.incomingId&&x.digest===d.threadDigest),i=data.incoming?.find(x=>x.id===d.incomingId&&x.clientId===e.clientId),m=data.mailTests?.find(x=>x.id===e.id&&x.clientId===e.clientId);if(!draft||!r||!t||!i||!m)fail('Dialogherkunft fehlt.');const v=JSON.parse(draft!.text),ctx=JSON.parse(r!.context),capture=JSON.parse(t!.payload),last=capture.messages.at(-1),anchor=data.mailTests?.find(x=>x.id===i!.mailId);
 const key=e.clientId+':'+d.incomingId;if(seen.has(key)||e.jobId!==null||v.incomingId!==d.incomingId||v.runId!==d.runId||v.body!==d.body||hash(ctx)!==d.writingBasisHash||ctx.threadSnapshotId!==d.threadSnapshotId||ctx.clientVersion!==d.clientVersion||ctx.briefRevision!==d.briefRevision||!anchor||anchor.mailboxId!==d.mailboxId||anchor.sender!==d.sender||anchor.recipient!==d.recipient||i!.threadId!==d.threadId||last.providerId!==i!.providerId||last.direction!=='received'||last.messageId!==d.inReplyTo||last.subject!==d.subject||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(d.inReplyTo)||d.inReplyTo.length>254||typeof d.stopEpoch!=='string'||d.stopEpoch!==''&&!data.events.some(x=>x.id===d.stopEpoch&&x.type==='QUEUE_EMERGENCY_STOP'))fail('Dialogbindung widerspricht Herkunft.');
 if(['mailboxId','sender','recipient','subject','body'].some(k=>(m as any)[k]!==d[k])||m!.messageId!==`<${e.id}@workbench.local>`||m!.createdAt!==e.createdAt)fail('Dialogmail widerspricht Freigabe.');seen.add(key);
 }
 const authorized=new Set<string>();for(const e of data.events.filter(e=>e.type===AUTHORIZED)){const d=JSON.parse(e.text);exactObject(d,['mailId']);if(e.jobId!==null||authorized.has(d.mailId)||!rows.some(r=>r.id===d.mailId&&r.clientId===e.clientId))fail('Ungültige Dialog-Schlussprüfung.');authorized.add(d.mailId);}
 for(const e of rows){const m=data.mailTests!.find(m=>m.id===e.id)!;if(m.status==='sent'&&!authorized.has(e.id))fail('Dialogversand ohne Schlussprüfung.');}
 for(const e of data.events.filter(e=>e.type==='DIALOGUE_FINISHED')){const d=JSON.parse(e.text);exactObject(d,['mailId','status','providerId']);if(e.jobId!==null||!rows.some(r=>r.id===d.mailId&&r.clientId===e.clientId)||!['sent','failed','unknown'].includes(d.status)||typeof d.providerId!=='string'||(d.status==='sent'?!/^[a-zA-Z0-9_-]{1,200}$/.test(d.providerId):d.providerId!==''))fail('Ungültiger Dialogabschluss.');}
});}

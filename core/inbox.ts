import {saveUnassigned} from './unassigned';
import {bindGmailReference} from './gmail-reference';
import {mailReferences} from './mail-references';
import { randomUUID } from 'node:crypto';
import { AppError, type Store } from './store';
export type Incoming={id:string;clientId:string;mailId:string;mailboxId:string;providerId:string;threadId:string;sender:string;subject:string;excerpt:string;receivedAt:string;kind:'reply'|'automatic'|'review';disposition:'open'|'unsubscribe';evidence:string;createdAt:string;recipient:string};
export function validateIncoming(r:any){
 if(!r||!['reply','automatic','review'].includes(r.kind)||!Number.isFinite(Date.parse(r.receivedAt)))throw new AppError('Ungültige Eingangsnachricht.');
 for(const [k,max] of Object.entries({providerId:200,threadId:200,sender:254,subject:500,excerpt:2000,evidence:10000}))if(typeof r[k]!=='string'||r[k].length>max||r[k].includes('\0'))throw new AppError('Ungültige Nachrichtenmetadaten.');
 if(!/^[a-zA-Z0-9_-]+$/.test(r.providerId)||!/^[a-zA-Z0-9_-]+$/.test(r.threadId))throw new AppError('Ungültige Gmail-Kennung.');
 try{JSON.parse(r.evidence);}catch{throw new AppError('Ungültiger Zuordnungsnachweis.');}
}
export function incomingState(s:Store,clientId:string){s.client(clientId);return s.db.prepare('SELECT * FROM incoming WHERE clientId=? ORDER BY receivedAt DESC,id LIMIT 100').all(clientId);}
export function deliveryMails(s:Store,clientId:string,mailboxId:string){
 return mailReferences(s,clientId,mailboxId);
}
export function recordDeliveryScan(s:Store,clientId:string,input:any,onRecorded?:(added:number)=>void){return s.transaction(()=>{
 const c=s.client(clientId);if(input?.clientVersion!==c.version)throw new AppError('Kundenstand geändert. Bitte erneut prüfen.',409);
 if(typeof input.mailboxId!=='string'||!/^[a-f0-9-]{36}$/.test(input.mailboxId)||!Array.isArray(input.matches)||input.matches.length>100||typeof input.truncated!=='boolean'||typeof input.query!=='string'||input.query.length>300||['checked','unmatched','skipped'].some(k=>!Number.isInteger(input[k])||input[k]<0||input[k]>100)||input.matches.length+input.unmatched+input.skipped!==input.checked)throw new AppError('Ungültiger Rückläuferlauf.');
 if(input.unresolved!==undefined){if(!Array.isArray(input.unresolved)||input.unresolved.length!==input.unmatched||input.unresolved.some((r:any)=>r.mailboxId!==input.mailboxId))throw new AppError('Ungeklärte Eingänge sind unvollständig.');saveUnassigned(s,clientId,input.unresolved);}
 let added=0;const candidates=input.extended===true?deliveryMails(s,clientId,input.mailboxId):[];
 for(const match of input.matches){
  const r=match.row;validateIncoming(r);
  const mail=s.db.prepare("SELECT * FROM mail_tests WHERE id=? AND clientId=? AND mailboxId=? AND status='sent'").get(match.mailId,clientId,input.mailboxId);
  const evidence=JSON.parse(r.evidence),d=evidence?.delivery;
  if(input.extended===true&&evidence?.discovery==='independent-reply'){
   const direct=typeof evidence.inReplyTo==='string'?evidence.inReplyTo.match(/<[^<>\s]+>/g)||[]:[],refs=typeof evidence.references==='string'?evidence.references.match(/<[^<>\s]+>/g)||[]:[];
   const exact=candidates.filter(m=>direct.includes(m.providerMessageId||String(m.messageId))),linked=exact.length?exact:candidates.filter(m=>refs.includes(m.providerMessageId||String(m.messageId)));
   const expected=r.sender!==mail?.recipient?'review':evidence.autoSubmitted&&evidence.autoSubmitted.toLowerCase()!=='no'?'automatic':'reply';
   if(!mail||linked.length!==1||linked[0].id!==mail.id||evidence.linkedMessageId!==mail.messageId||r.kind!==expected||r.sender===mail.sender||Date.parse(r.receivedAt)<Date.parse(String(mail.createdAt)))throw new AppError('Antwort passt nicht eindeutig zur Ausgangsnachricht.');
   const changed=s.db.prepare('INSERT OR IGNORE INTO incoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),clientId,mail.id,mail.mailboxId,r.providerId,r.threadId,r.sender,r.subject,r.excerpt,r.receivedAt,r.kind,'open',r.evidence,new Date().toISOString(),String(mail.recipient));
   if(changed.changes){added++;s.event(clientId,null,'INCOMING_HOLD',JSON.stringify({mailId:mail.id,providerId:r.providerId,recipient:mail.recipient,kind:r.kind,reason:'Referenzierte Antwort außerhalb bekannter Gespräche.'}));}continue;
  }
  if(!mail||r.kind!=='automatic'||!d||d.messageId!==mail.messageId||d.recipient!==mail.recipient||!((d.type==='failed'&&d.action==='failed'&&/^5\.\d{1,3}\.\d{1,3}$/.test(d.status))||(d.type==='delayed'&&d.action==='delayed'&&/^4\.\d{1,3}\.\d{1,3}$/.test(d.status)))||Date.parse(r.receivedAt)<Date.parse(String(mail.createdAt)))throw new AppError('Zustellbericht passt nicht zur Ausgangsnachricht.');
  const changed=s.db.prepare('INSERT OR IGNORE INTO incoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),clientId,mail.id,mail.mailboxId,r.providerId,r.threadId,r.sender,r.subject,r.excerpt,r.receivedAt,r.kind,'open',r.evidence,new Date().toISOString(),String(mail.recipient));
  if(changed.changes){added++;s.event(clientId,null,'DELIVERY_HOLD',JSON.stringify({mailId:mail.id,providerId:r.providerId,recipient:mail.recipient,delivery:d.type}));}
 }
 const summary={checked:input.checked,matched:input.matches.length,added,unmatched:input.unmatched,skipped:input.skipped,truncated:input.truncated,query:input.query};
 s.event(clientId,null,'DELIVERY_SCAN_COMPLETED',JSON.stringify(summary));onRecorded?.(added);return summary;
});}
export function recordConversation(s:Store,clientId:string,mailId:string,input:any){return s.transaction(()=>{
 const c=s.client(clientId);const mail=s.db.prepare("SELECT * FROM mail_tests WHERE id=? AND clientId=? AND status='sent'").get(mailId,clientId);
 if(!mail||input?.mailboxId!==mail.mailboxId||input?.clientVersion!==c.version)throw new AppError('Ausgangsnachricht oder Kundenstand geändert.',409);
 if(!Array.isArray(input.rows)||input.rows.length>200)throw new AppError('Ungültiger Gesprächsabruf.');
 if(input.sourceReference!==undefined)bindGmailReference(s,clientId,mail,input.sourceReference);
 let added=0;
 for(const r of input.rows){validateIncoming(r);
  const changed=s.db.prepare('INSERT OR IGNORE INTO incoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),clientId,mailId,mail.mailboxId,r.providerId,r.threadId,r.sender,r.subject,r.excerpt,r.receivedAt,r.kind,'open',r.evidence,new Date().toISOString(),String(mail.recipient));
  if(changed.changes){added++;s.event(clientId,null,'INCOMING_HOLD',JSON.stringify({mailId,providerId:r.providerId,kind:r.kind,recipient:mail.recipient,reason:'Nachricht im Gespräch; weiterer Kontakt angehalten.'}));}
 }
 s.event(clientId,null,'CONVERSATION_CHECKED',JSON.stringify({mailId,mailboxId:mail.mailboxId,observed:input.rows.length,added}));
 return {added,total:input.rows.length};
});}
export function markUnsubscribe(s:Store,clientId:string,id:string,hooks?:{before:()=>void;after:()=>void}){return s.transaction(()=>{
 hooks?.before();
 s.client(clientId);const row=s.db.prepare('SELECT * FROM incoming WHERE id=? AND clientId=?').get(id,clientId);
 if(!row)throw new AppError('Nachricht nicht gefunden.',404);
 if(row.disposition!=='unsubscribe'){s.db.prepare("UPDATE incoming SET disposition='unsubscribe' WHERE id=? AND clientId=?").run(id,clientId);s.event(clientId,null,'UNSUBSCRIBE_CONFIRMED',JSON.stringify({incomingId:id,recipient:row.recipient}));}
 hooks?.after();
 return {ok:true};
});}

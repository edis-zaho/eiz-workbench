import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
const TYPE='GMAIL_MESSAGE_ID_BOUND';
type Reference={mailId:string;mailboxId:string;providerId:string;threadId:string;messageId:string};
const validId=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
const validMessageId=(v:unknown)=>typeof v==='string'&&v.length<=254&&/^<[^<>\s@]+@[^<>\s@]+>$/.test(v);
function fail():never{throw new AppError('Gmail-Nachrichtenbindung fehlt oder widerspricht dem bestätigten Versand.',409);}
function checked(mail:any,r:any):Reference{
 if(!r||Object.keys(r).sort().join(',')!=='mailId,mailboxId,messageId,providerId,threadId'||mail?.status!=='sent'||r.mailId!==mail.id||r.mailboxId!==mail.mailboxId||r.providerId!==mail.providerId||!validId(r.providerId)||!validId(r.threadId)||!validMessageId(r.messageId))fail();return r;
}
export function withGmailReference<T extends {id:unknown;clientId:unknown}>(s:Store,mail:T):T&{providerMessageId?:string;providerThreadId?:string}{
 const rows=s.db.prepare('SELECT text FROM events WHERE clientId=? AND type=? AND json_extract(text,\'$.mailId\')=?').all(String(mail.clientId),TYPE,String(mail.id));
 if(rows.length>1)fail();if(!rows.length)return mail;const r=checked(mail,JSON.parse(String(rows[0].text)));return {...mail,providerMessageId:r.messageId,providerThreadId:r.threadId};
}
export function withGmailReferences<T extends {id:unknown;clientId:unknown}>(s:Store,clientId:string,mails:T[]):(T&{providerMessageId?:string;providerThreadId?:string})[]{
 const refs=new Map<string,Reference>();for(const row of s.db.prepare('SELECT text FROM events WHERE clientId=? AND type=?').all(clientId,TYPE)){const r:Reference=JSON.parse(String(row.text));if(refs.has(r.mailId))fail();refs.set(r.mailId,r);}
 return mails.map(mail=>{if(mail.clientId!==clientId)fail();const ref=refs.get(String(mail.id));if(!ref)return mail;const r=checked(mail,ref);return {...mail,providerMessageId:r.messageId,providerThreadId:r.threadId};});
}
export function bindGmailReference(s:Store,clientId:string,mail:any,input:any){
 const r=checked(mail,input);if(mail.clientId!==clientId)fail();const bound=withGmailReference(s,mail);
 if(s.db.prepare("SELECT id FROM mail_tests WHERE mailboxId=? AND providerId=? AND id<>? AND status='sent'").get(r.mailboxId,r.providerId,mail.id))fail();
 if(bound.providerMessageId){if(bound.providerMessageId!==r.messageId||bound.providerThreadId!==r.threadId)fail();return;}
 const conflict=s.db.prepare('SELECT text FROM events WHERE type=? AND json_extract(text,\'$.mailboxId\')=? AND (json_extract(text,\'$.providerId\')=? OR json_extract(text,\'$.messageId\')=?)').get(TYPE,r.mailboxId,r.providerId,r.messageId);
 if(conflict)fail();s.event(clientId,null,TYPE,JSON.stringify(r));
 // A new reference can expose replies previously skipped by the independent scan.
 s.db.prepare('DELETE FROM meta WHERE key=?').run('delivery-progress:'+clientId);
}
export function referenceFromData<T extends {id:unknown;clientId:unknown}>(data:BackupData,mail:T):T&{providerMessageId?:string;providerThreadId?:string}{
 const events=data.events.filter(e=>e.type===TYPE&&e.clientId===mail.clientId&&JSON.parse(e.text).mailId===mail.id);if(events.length>1)fail();if(!events.length)return mail;const r=checked(mail,JSON.parse(events[0].text));return {...mail,providerMessageId:r.messageId,providerThreadId:r.threadId};
}
export function validateGmailReferences(data:BackupData){
 const mails=new Map((data.mailTests||[]).map(m=>[m.id,m])),seen=new Set<string>();
 for(const e of data.events.filter(e=>e.type===TYPE)){let r:Reference;try{r=JSON.parse(e.text);}catch{return fail();}const mail=mails.get(r.mailId);checked(mail,r);if(e.clientId!==mail!.clientId||e.jobId!==null)fail();
  for(const key of ['mail:'+r.mailId,'provider:'+r.mailboxId+':'+r.providerId,'message:'+r.mailboxId+':'+r.messageId]){if(seen.has(key))fail();seen.add(key);}
 }
}
export function preserveGmailReferences(s:Store,data:BackupData){
 const clients=new Set(data.clients.map(c=>c.id));data.mailTests||=[];
 for(const e of s.db.prepare('SELECT * FROM events WHERE type=?').all(TYPE) as LedgerEvent[]){if(!clients.has(e.clientId!))continue;
  const r:Reference=JSON.parse(e.text),mail=s.db.prepare('SELECT * FROM mail_tests WHERE id=? AND clientId=?').get(r.mailId,e.clientId!),old=data.mailTests.find(m=>m.id===r.mailId);checked(mail,r);
  if(old){checked(old,r);if(['sender','recipient','messageId'].some(k=>(old as any)[k]!==mail![k]))fail();}else data.mailTests.push(mail as any);
  const saved=data.events.find(x=>x.id===e.id);if(saved){if(Object.keys(e).some(k=>(saved as any)[k]!== (e as any)[k]))fail();}else data.events.push(e);
 }validateGmailReferences(data);
}

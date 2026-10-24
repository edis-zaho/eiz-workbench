import {domainToASCII} from 'node:url';
import {AppError, type Store} from './store';
import type {BackupData} from './types';

export function validateOperations(data:BackupData){
 const revisions=new Set<string>();
 for(const e of data.events){
  if(!['COMPANY_DOMAIN_BLOCKED','INCOMING_REVIEWED'].includes(e.type))continue;
  try{
   if(!data.clients.some(c=>c.id===e.clientId)||e.jobId!==null)throw Error();
   const d=JSON.parse(e.text);
   if(e.type==='COMPANY_DOMAIN_BLOCKED'){
    if(companyDomain(d.domain)!==d.domain||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>1000)throw Error();
   }else{
    const key=e.clientId+':'+d.incomingId+':'+d.sequence;
    if(!data.incoming?.some(r=>r.id===d.incomingId&&r.clientId===e.clientId)||!Number.isSafeInteger(d.sequence)||d.sequence<1||revisions.has(key)||!['open','done'].includes(d.status)||!['positive','negative','absence','bounce','other'].includes(d.category)||typeof d.note!=='string'||!d.note.trim()||d.note.length>2000)throw Error();
    revisions.add(key);
   }
  }catch{throw new AppError('Sicherung enthält ungültige Unternehmenssperren oder Klärungsentscheidungen.');}
 }
}

// Operational decisions are append-only events, included in existing backups.
export function companyDomain(value:unknown){
 if(typeof value!=='string')throw new AppError('Bitte eine Unternehmensdomain angeben.');
 const domain=domainToASCII(value.trim().toLowerCase());
 if(domain.length>253||!domain.includes('.')||!domain.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))||/^\d+(\.\d+)+$/.test(domain))throw new AppError('Bitte nur die Domain eingeben, zum Beispiel firma.de.');
 return domain;
}
export function companyBlocks(s:Store,clientId:string){
 s.client(clientId);const found=new Map<string,{domain:string;reason:string;createdAt:string}>();
 for(const e of s.db.prepare("SELECT text,createdAt FROM events WHERE clientId=? AND type='COMPANY_DOMAIN_BLOCKED' ORDER BY rowid").all(clientId)){
  const r=JSON.parse(String(e.text));found.set(companyDomain(r.domain),{domain:r.domain,reason:r.reason,createdAt:String(e.createdAt)});
 }return [...found.values()];
}
export function companyStop(s:Store,clientId:string,email:string){return companyBlocks(s,clientId).find(b=>b.domain===email.split('@')[1]?.toLowerCase());}
export function blockCompany(s:Store,clientId:string,input:any){return s.transaction(()=>{
 const c=s.client(clientId);if(c.version!==input?.clientVersion)throw new AppError('Kundenstand geändert. Bitte neu laden.',409);
 const domain=companyDomain(input?.domain);
 if(input?.confirmed!==true||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)throw new AppError('Domain prüfen, ausdrücklich bestätigen und einen Grund angeben.');
 if(!companyStop(s,clientId,'check@'+domain))s.event(clientId,null,'COMPANY_DOMAIN_BLOCKED',JSON.stringify({domain,reason:input.reason.trim()}));
 return companyBlocks(s,clientId);
});}
export function reviewQueue(s:Store,clientId?:string){
 if(clientId)s.client(clientId);
 const decisions=new Map<string,any>();
 const events=s.db.prepare("SELECT id,clientId,text,createdAt FROM events WHERE type='INCOMING_REVIEWED' ORDER BY rowid").all();
 for(const e of events){const d=JSON.parse(String(e.text));const key=String(e.clientId)+':'+d.incomingId;if(!decisions.has(key)||decisions.get(key).sequence<d.sequence)decisions.set(key,{...d,revision:e.id,updatedAt:e.createdAt});}
 return s.db.prepare(`SELECT i.*,c.name AS clientName FROM incoming i JOIN clients c ON c.id=i.clientId ${clientId?'WHERE i.clientId=?':''} ORDER BY i.receivedAt DESC,i.id`).all(...(clientId?[clientId]:[])).map(r=>({...r,id:String(r.id),review:decisions.get(String(r.clientId)+':'+r.id)||{status:'open',category:'unclassified',note:'',revision:null,sequence:0}}));
}
export function reviewIncoming(s:Store,clientId:string,id:string,input:any){return s.transaction(()=>{
 s.client(clientId);const row=reviewQueue(s,clientId).find(r=>r.id===id);if(!row)throw new AppError('Eingang nicht gefunden.',404);
 if(input?.revision!==row.review.revision)throw new AppError('Klärungsstand geändert. Bitte neu laden.',409);
 if(!['open','done'].includes(input.status)||!['positive','negative','absence','bounce','other'].includes(input.category)||typeof input.note!=='string'||!input.note.trim()||input.note.length>2000)throw new AppError('Einordnung und kurze Prüfnotiz angeben.');
 s.event(clientId,null,'INCOMING_REVIEWED',JSON.stringify({incomingId:id,sequence:row.review.sequence+1,status:input.status,category:input.category,note:input.note.trim()}));
 return {ok:true};
});}

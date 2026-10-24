import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData} from './types';
const uuid=(s:any)=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
export function validateUnassigned(r:any){
 if(!r||!uuid(r.mailboxId)||!Number.isFinite(Date.parse(r.receivedAt)))throw new AppError('Ungültiger ungeklärter Eingang.');
 for(const [k,max] of Object.entries({providerId:200,threadId:200,sender:254,subject:500,excerpt:2000,reason:500,evidence:6000}))if(typeof r[k]!=='string'||r[k].length>max||r[k].includes('\0'))throw new AppError('Ungültiger Eingangsbeleg.');
 if(!/^[a-zA-Z0-9_-]+$/.test(r.providerId)||!/^[a-zA-Z0-9_-]+$/.test(r.threadId)||!r.reason.trim())throw new AppError('Ungültige Eingangskennung.');
 try{JSON.parse(r.evidence);}catch{throw new AppError('Ungültiger Zuordnungsbeleg.');}
}
export function unassigned(s:Store,clientId:string){s.client(clientId);const found=new Map<string,any>();const events=s.db.prepare("SELECT * FROM events WHERE clientId=? AND type IN ('UNASSIGNED_FOUND','UNASSIGNED_DECIDED') ORDER BY rowid").all(clientId);
 for(const e of events.filter(e=>e.type==='UNASSIGNED_FOUND')){const r=JSON.parse(String(e.text));found.set(String(e.id),{...r,id:e.id,clientId,status:'open',sequence:0,revision:null,note:''});}
 for(const e of events.filter(e=>e.type==='UNASSIGNED_DECIDED')){const d=JSON.parse(String(e.text)),r=found.get(d.caseId);if(r&&d.sequence>r.sequence)Object.assign(r,d,{status:d.action==='open'?'open':'done',revision:e.id});}
 return [...found.values()];
}
export function saveUnassigned(s:Store,clientId:string,rows:any[]){const known=new Set(unassigned(s,clientId).map(r=>r.mailboxId+':'+r.providerId));for(const r of rows){validateUnassigned(r);const key=r.mailboxId+':'+r.providerId;if(!known.has(key)){s.event(clientId,null,'UNASSIGNED_FOUND',JSON.stringify(r));known.add(key);}}}
export function openUnassigned(s:Store,id:string,mailboxId:string){return unassigned(s,id).filter(r=>r.mailboxId===mailboxId&&r.status==='open').length;}
export function decideUnassigned(s:Store,clientId:string,id:string,input:any){return s.transaction(()=>{
 const row=unassigned(s,clientId).find(r=>r.id===id);if(!row)throw new AppError('Ungeklärter Eingang nicht gefunden.',404);
 if(input?.revision!==row.revision)throw new AppError('Fall wurde geändert. Bitte neu laden.',409);
 if(input.confirmed!==true||!['assign','unrelated','open'].includes(input.action)||typeof input.note!=='string'||!input.note.trim()||input.note.length>2000)throw new AppError('Entscheidung bestätigen und Prüfnotiz angeben.');
 let mail:any;
 if(input.action==='assign'){
  mail=s.db.prepare("SELECT * FROM mail_tests WHERE id=? AND clientId=? AND mailboxId=? AND status='sent'").get(input.mailId,clientId,row.mailboxId);
  if(!mail||Date.parse(row.receivedAt)<Date.parse(mail.createdAt))throw new AppError('Ausgangsnachricht passt nicht zu Kunde, Postfach oder Empfangszeit.');
  const evidence=JSON.stringify({discovery:'manual-assignment',caseId:id,operatorNote:input.note.trim(),originalEvidence:JSON.parse(row.evidence)});if(evidence.length>10000)throw new AppError('Zuordnungsbeleg zu lang. Bitte Prüfnotiz kürzen.');
  s.db.prepare('INSERT OR IGNORE INTO incoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),clientId,mail.id,row.mailboxId,row.providerId,row.threadId,row.sender,row.subject,row.excerpt,row.receivedAt,'review','open',evidence,new Date().toISOString(),mail.recipient);
  s.event(clientId,null,'INCOMING_HOLD',JSON.stringify({mailId:mail.id,providerId:row.providerId,recipient:mail.recipient,reason:'Manuelle Zuordnung eines ungeklärten Eingangs.'}));
 }
 s.event(clientId,null,'UNASSIGNED_DECIDED',JSON.stringify({caseId:id,sequence:row.sequence+1,action:input.action,note:input.note.trim(),mailId:mail?.id||null}));return {ok:true};
});}
export function validateUnassignedBackup(data:BackupData){
 const sources=new Map<string,any>(),keys=new Set<string>();
 for(const e of data.events.filter(e=>e.type==='UNASSIGNED_FOUND')){const r=JSON.parse(e.text);validateUnassigned(r);const key=e.clientId+':'+r.mailboxId+':'+r.providerId;if(e.jobId!==null||!data.clients.some(c=>c.id===e.clientId)||keys.has(key))throw new AppError('Ungültige Eingangssicherung.');keys.add(key);sources.set(e.id,{...r,clientId:e.clientId});}
 const revisions=new Set<string>();
 for(const e of data.events.filter(e=>e.type==='UNASSIGNED_DECIDED')){const d=JSON.parse(e.text),r=sources.get(d.caseId),key=d.caseId+':'+d.sequence;if(!r||r.clientId!==e.clientId||e.jobId!==null||!Number.isSafeInteger(d.sequence)||d.sequence<1||revisions.has(key)||!['assign','unrelated','open'].includes(d.action)||typeof d.note!=='string'||!d.note.trim()||d.note.length>2000)throw new AppError('Ungültige Klärungsentscheidung.');if(d.action==='assign'&&(!data.mailTests?.some(m=>m.id===d.mailId&&m.clientId===e.clientId&&m.mailboxId===r.mailboxId)||!data.incoming?.some(i=>i.mailId===d.mailId&&i.clientId===e.clientId&&i.mailboxId===r.mailboxId&&i.providerId===r.providerId)))throw new AppError('Ungültige manuelle Zuordnung.');revisions.add(key);}
}

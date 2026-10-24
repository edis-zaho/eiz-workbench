import { AppError, type Store } from './store';
import {randomUUID} from 'node:crypto';
import {mailReferences} from './mail-references';
export type SyncState={clientId:string;mailboxId:string;enabled:number;status:'idle'|'running'|'failed';lastStartedAt:string|null;lastSuccessAt:string|null;nextAttemptAt:string|null;lastError:string;consecutiveFailures:number;updatedAt:string};
const now=()=>new Date().toISOString();
const key=(id:string)=>'conversation-progress:'+id;
type Progress={mailboxId:string;clientVersion:number;ids:string[];offset:number;startedAt:string;leaseId:string;pageIds:string[]};
function progress(s:Store,id:string):Progress|null{const r=s.db.prepare('SELECT value FROM meta WHERE key=?').get(key(id));return r?JSON.parse(String(r.value)):null;}
function save(s:Store,id:string,p:Progress){s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key(id),JSON.stringify(p));}
const mailbox=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9-]{36}$/.test(value))throw new AppError('Ungültiges Postfach.');return value;};
export function syncState(s:Store,clientId:string){s.client(clientId);const row=s.db.prepare('SELECT * FROM mail_sync WHERE clientId=?').get(clientId) as unknown as SyncState|undefined,p=progress(s,clientId);return row?{...row,enabled:!!row.enabled,progress:p?{checked:p.offset,total:p.ids.length,startedAt:p.startedAt}:null,stale:!!p||!row.lastSuccessAt||Date.now()-Date.parse(row.lastSuccessAt)>10*60*1000}:{clientId,mailboxId:'',enabled:false,status:'idle',lastStartedAt:null,lastSuccessAt:null,nextAttemptAt:null,lastError:'',consecutiveFailures:0,updatedAt:null,stale:true,progress:null};}
export function configureSync(s:Store,clientId:string,input:any){return s.transaction(()=>{const c=s.client(clientId);if(c.version!==input?.clientVersion)throw new AppError('Kundenstand geändert. Bitte neu laden.',409);const id=mailbox(input?.mailboxId);if(typeof input?.enabled!=='boolean')throw new AppError('Synchronisationsstatus fehlt.');s.db.prepare('DELETE FROM meta WHERE key=?').run(key(clientId));const at=now();s.db.prepare(`INSERT INTO mail_sync VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(clientId) DO UPDATE SET mailboxId=excluded.mailboxId,enabled=excluded.enabled,status='idle',nextAttemptAt=excluded.nextAttemptAt,lastError='',consecutiveFailures=0,updatedAt=excluded.updatedAt`).run(clientId,id,input.enabled?1:0,'idle',null,null,input.enabled?at:null,'',0,at);s.event(clientId,null,input.enabled?'MAIL_SYNC_ENABLED':'MAIL_SYNC_DISABLED',input.enabled?'Automatische Gesprächssynchronisation aktiviert. Noch kein Kampagnenversand.':'Automatische Gesprächssynchronisation deaktiviert.');return syncState(s,clientId);});}
export function dueSyncs(s:Store){const at=now();return s.db.prepare(`SELECT m.clientId,m.mailboxId FROM mail_sync m JOIN clients c ON c.id=m.clientId WHERE m.enabled=1 AND m.status<>'running' AND c.status<>'paused' AND (m.nextAttemptAt IS NULL OR m.nextAttemptAt<=?) ORDER BY COALESCE(m.nextAttemptAt,''),m.clientId LIMIT 10`).all(at);}
export function claimSync(s:Store,clientId:string,input:any){return s.transaction(()=>{
 const c=s.client(clientId);if(c.status==='paused')throw new AppError('Kunde ist pausiert.');
 const id=mailbox(input?.mailboxId),force=input?.force===true,state=s.db.prepare('SELECT * FROM mail_sync WHERE clientId=? AND mailboxId=? AND enabled=1').get(clientId,id) as unknown as SyncState|undefined;
 if(!state)throw new AppError('Automatische Synchronisation ist für dieses Postfach nicht aktiviert.',409);
 if(state.status==='running')throw new AppError('Synchronisation läuft bereits.',409);
 if(!force&&state.nextAttemptAt&&state.nextAttemptAt>now())throw new AppError('Synchronisation ist noch nicht fällig.',409);
 const at=now(),mails=mailReferences(s,clientId,id);let p=progress(s,clientId);
 if(!p||p.mailboxId!==id||p.clientVersion!==c.version)p={mailboxId:id,clientVersion:c.version,ids:mails.map(m=>String(m.id)),offset:0,startedAt:at,leaseId:'',pageIds:[]};
 const byId=new Map(mails.map(m=>[String(m.id),m]));p.pageIds=p.ids.slice(p.offset,p.offset+50);
 const messages=p.pageIds.map(id=>byId.get(id));if(messages.some(m=>!m))throw new AppError('Gespeicherte Versandreferenz fehlt. Synchronisation neu aktivieren.');
 p.leaseId=randomUUID();save(s,clientId,p);
 s.db.prepare("UPDATE mail_sync SET status='running',lastStartedAt=?,lastError='',updatedAt=? WHERE clientId=? AND mailboxId=?").run(at,at,clientId,id);
 return {messages:messages as typeof mails,clientVersion:c.version,startedAt:p.startedAt,leaseId:p.leaseId,checked:p.offset,total:p.ids.length};
});}
export function finishSync(s:Store,clientId:string,input:any){return s.transaction(()=>{
 const id=mailbox(input?.mailboxId),state=s.db.prepare("SELECT * FROM mail_sync WHERE clientId=? AND mailboxId=? AND enabled=1 AND status='running'").get(clientId,id) as unknown as SyncState|undefined,p=progress(s,clientId);
 if(!state||!p||p.leaseId!==input?.leaseId||p.mailboxId!==id)throw new AppError('Synchronisationslauf ist nicht mehr aktiv.',409);
 const c=s.client(clientId),at=now(),success=input?.success===true;
 if(success){
  if(c.status==='paused'||c.version!==p.clientVersion)throw new AppError('Kundenstand geändert.',409);
  if(!Number.isSafeInteger(input.checked)||input.checked<0||input.checked>p.pageIds.length||!Number.isSafeInteger(input.added)||input.added<0||input.added>input.checked*200)throw new AppError('Ungültiger Seitenabschluss.');
  p.offset+=input.checked;p.leaseId='';p.pageIds=[];
  if(p.offset===p.ids.length){const known=new Set(p.ids);for(const m of mailReferences(s,clientId,id))if(!known.has(String(m.id)))p.ids.push(String(m.id));}
  const complete=p.offset===p.ids.length;
  if(complete)s.db.prepare('DELETE FROM meta WHERE key=?').run(key(clientId));else save(s,clientId,p);
  s.db.prepare("UPDATE mail_sync SET status='idle',lastSuccessAt=?,nextAttemptAt=?,lastError='',consecutiveFailures=0,updatedAt=? WHERE clientId=? AND mailboxId=?").run(complete?p.startedAt:state.lastSuccessAt,new Date(Date.now()+(complete?300000:15000)).toISOString(),at,clientId,id);
  // Existing event type only for a fully checked snapshot, never for a partial page.
  if(complete)s.event(clientId,null,'MAIL_SYNC_SUCCEEDED',JSON.stringify({mailboxId:id,checked:p.ids.length,completedAt:at,observedSince:p.startedAt}));
 }else{
  const message=typeof input?.error==='string'?input.error.trim().slice(0,1000):'Synchronisation fehlgeschlagen.',failures=Math.min(state.consecutiveFailures+1,20),minutes=Math.min(60,2**Math.min(failures,6));p.leaseId='';save(s,clientId,p);
  s.db.prepare("UPDATE mail_sync SET status='failed',nextAttemptAt=?,lastError=?,consecutiveFailures=?,updatedAt=? WHERE clientId=? AND mailboxId=?").run(new Date(Date.now()+minutes*60000).toISOString(),message,failures,at,clientId,id);
  s.event(clientId,null,'MAIL_SYNC_FAILED',JSON.stringify({mailboxId:id,error:message,nextAttemptMinutes:minutes}));
 }
 return syncState(s,clientId);
});}

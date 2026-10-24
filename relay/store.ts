import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import {dirname} from 'node:path';
import {RelayError,registration,secret,uuid,type Scope,type Registration,type RelayObservation,type RelayPage} from './contract';
type TokenRow={digest:string;stream:string;messageRef:string;kind:'open'|'click';linkId:string|null;target:string|null;expiresAt:string;createdAt:string;revokedAt:string|null};
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export class RelayStore{
 readonly db:DatabaseSync;readonly instanceId:string;
 constructor(filename:string,readonly limits={tokensPerStream:100000,eventsPerStream:500000},private clock=()=>Date.now()){
  if(!Number.isSafeInteger(limits.tokensPerStream)||limits.tokensPerStream<1||limits.tokensPerStream>100000||!Number.isSafeInteger(limits.eventsPerStream)||limits.eventsPerStream<1||limits.eventsPerStream>500000)throw new RelayError(400,'Invalid capacity');
  mkdirSync(dirname(filename),{recursive:true});this.db=new DatabaseSync(filename);try{const v=this.db.prepare('PRAGMA user_version').get()!.user_version;
  if(v!==0&&v!==1){throw new RelayError(500,'Unsupported relay database');}
  if(v===0&&Number(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()!.n)>0){throw new RelayError(500,'Not an empty relay database');}
  if(v===1){try{if(!uuid(this.db.prepare("SELECT value FROM relay_meta WHERE key='instance'").get()?.value))throw Error();}catch{throw new RelayError(500,'Invalid relay identity');}}
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
  if(v===0)this.transaction(()=>{this.db.exec(`CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE relay_tokens(digest TEXT PRIMARY KEY,stream TEXT NOT NULL,messageRef TEXT NOT NULL,kind TEXT NOT NULL,linkId TEXT,target TEXT,expiresAt TEXT NOT NULL,createdAt TEXT NOT NULL,revokedAt TEXT); CREATE INDEX relay_token_stream ON relay_tokens(stream); CREATE TABLE relay_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,stream TEXT NOT NULL,messageRef TEXT NOT NULL,kind TEXT NOT NULL,occurredAt TEXT NOT NULL,linkId TEXT,flags TEXT NOT NULL); CREATE INDEX relay_event_stream ON relay_events(stream,seq); CREATE TRIGGER relay_events_no_update BEFORE UPDATE ON relay_events BEGIN SELECT RAISE(ABORT,'Immutable observations'); END; CREATE TRIGGER relay_events_no_delete BEFORE DELETE ON relay_events BEGIN SELECT RAISE(ABORT,'Immutable observations'); END; PRAGMA user_version=1;`);this.db.prepare('INSERT INTO relay_meta VALUES (?,?)').run('instance',randomUUID());});
  this.instanceId=String(this.db.prepare("SELECT value FROM relay_meta WHERE key='instance'").get()!.value);
  if(!uuid(this.instanceId)){throw new RelayError(500,'Invalid relay identity');}
  }catch(error){this.db.close();throw error;}
 }
 private transaction<T>(fn:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 register(scope:Scope,input:any){const p=registration(input,scope);return this.transaction(()=>{const hash=digest(p.token),old=this.db.prepare('SELECT * FROM relay_tokens WHERE digest=?').get(hash) as TokenRow|undefined;
  if(old){if(old.stream!==scope.stream||(['messageRef','kind','linkId','target','expiresAt'] as const).some(k=>old[k]!==p[k]))throw new RelayError(409,'Registration conflict');return {registered:true,repeated:true,revoked:old.revokedAt!==null};}
  const now=this.clock();if(Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>now+90*86400000)throw new RelayError(400,'Expiry must be within 90 days');
  if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM relay_tokens WHERE stream=?').get(scope.stream)!.n)>=this.limits.tokensPerStream)throw new RelayError(503,'Registration capacity reached');
  this.db.prepare('INSERT INTO relay_tokens VALUES (?,?,?,?,?,?,?,?,NULL)').run(hash,scope.stream,p.messageRef,p.kind,p.linkId,p.target,p.expiresAt,new Date(now).toISOString());return {registered:true,repeated:false,revoked:false};
 });}
 revoke(scope:Scope,token:string){if(!secret(token))throw new RelayError(400,'Invalid token');const r=this.db.prepare('UPDATE relay_tokens SET revokedAt=COALESCE(revokedAt,?) WHERE stream=? AND digest=?').run(new Date(this.clock()).toISOString(),scope.stream,digest(token));if(!r.changes)throw new RelayError(404,'Not found');return {revoked:true};}
 capture(token:string,kind:'open'|'click',allScopes:Scope[],flags:RelayObservation['flags'],head=false){if(!secret(token))throw new RelayError(404,'Not found');return this.transaction(()=>{
  const row=this.db.prepare('SELECT * FROM relay_tokens WHERE digest=?').get(digest(token)) as TokenRow|undefined,now=new Date(this.clock()).toISOString(),scope=row&&allScopes.find(s=>s.stream===row.stream);
  if(!row||!scope||row.kind!==kind||row.revokedAt||row.expiresAt<=now)throw new RelayError(404,'Not found');
  if(row.kind==='click')registration({token,messageRef:row.messageRef,kind:row.kind,linkId:row.linkId,target:row.target,expiresAt:row.expiresAt},scope);
  if(!head){if(Number(this.db.prepare('SELECT COUNT(*) AS n FROM relay_events WHERE stream=?').get(row.stream)!.n)>=this.limits.eventsPerStream)throw new RelayError(503,'Observation capacity reached');this.db.prepare('INSERT INTO relay_events(id,stream,messageRef,kind,occurredAt,linkId,flags) VALUES (?,?,?,?,?,?,?)').run(randomUUID(),row.stream,row.messageRef,row.kind,now,row.linkId,JSON.stringify(flags));}
  return {target:row.target};
 });}
 page(scope:Scope,after:number,through?:number):RelayPage{
  const max=Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM relay_events WHERE stream=?').get(scope.stream)!.n),top=through??max;
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(top)||top<after||top>max)throw new RelayError(409,'Invalid or regressed cursor');
  const raw=this.db.prepare('SELECT * FROM relay_events WHERE stream=? AND seq>? AND seq<=? ORDER BY seq LIMIT 501').all(scope.stream,after,top),rows:RelayObservation[]=raw.slice(0,500).map(r=>({cursor:Number(r.seq),id:String(r.id),messageRef:String(r.messageRef),kind:r.kind as Registration['kind'],occurredAt:String(r.occurredAt),capturedAt:String(r.occurredAt),linkId:r.linkId===null?null:String(r.linkId),flags:JSON.parse(String(r.flags))}));
  const complete=raw.length<=500;return {format:'eiz-relay-page',version:1,instanceId:this.instanceId,stream:scope.stream,after,through:top,next:complete?top:rows.at(-1)!.cursor,complete,rows};
 }
 status(scope:Scope){return {instanceId:this.instanceId,stream:scope.stream,registered:Number(this.db.prepare('SELECT COUNT(*) AS n FROM relay_tokens WHERE stream=?').get(scope.stream)!.n),observations:Number(this.db.prepare('SELECT COUNT(*) AS n FROM relay_events WHERE stream=?').get(scope.stream)!.n),limits:this.limits};}
 async snapshot(destination:string){const fd=openSync(destination,'wx',0o600);closeSync(fd);await backup(this.db,destination);}
 close(){this.db.close();}
}

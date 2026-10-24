import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData,LedgerEvent} from './types';
import {exactObject,cleanText} from './interpretation-input';
import {dialoguePreview} from './dialogue-send';
import type {DialogueAutoRules} from './dialogue-auto-input';
const POLICY='DIALOGUE_AUTO_POLICY',ATTEMPT='DIALOGUE_AUTO_ATTEMPT',RESULT='DIALOGUE_AUTO_RESULT';
const types=[POLICY,ATTEMPT,RESULT];
const fail=(m:string):never=>{throw new AppError(m,409);};
const epoch=(s:Store)=>String(s.db.prepare("SELECT id FROM events WHERE type='QUEUE_EMERGENCY_STOP' ORDER BY rowid DESC LIMIT 1").get()?.id||'');
const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
function checked<T>(f:()=>T):T{try{return f();}catch(e){if(e instanceof AppError)throw e;throw new AppError((e as Error).message);}}
export function validateAutoRules(v:any):DialogueAutoRules{
 exactObject(v,['enabled','timezone','weekdays','startHour','endHour','dailyLimit','accountDailyLimit','accountGapMinutes','minDelayMinutes']);
 if(typeof v.enabled!=='boolean'||typeof v.timezone!=='string'||v.timezone.length>80)fail('Ungültige Automatikregeln.');
 new Intl.DateTimeFormat('en',{timeZone:v.timezone}).format();
 if(!Array.isArray(v.weekdays)||!v.weekdays.length||v.weekdays.length>7||new Set(v.weekdays).size!==v.weekdays.length||v.weekdays.some((n:any)=>!Number.isInteger(n)||n<0||n>6))fail('Versandtage fehlen oder sind ungültig.');
 for(const [key,min,max] of [['startHour',0,23],['endHour',1,24],['dailyLimit',1,1000],['accountDailyLimit',1,100],['accountGapMinutes',1,10080],['minDelayMinutes',0,1440]] as const)if(!Number.isInteger(v[key])||v[key]<min||v[key]>max)fail('Ungültige Grenze: '+key);
 if(v.startHour>=v.endHour||v.accountDailyLimit>v.dailyLimit)fail('Zeitfenster oder Unternehmenslimit ungültig.');return structuredClone(v);
}
export function localAutoTime(at:Date,timezone:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(at);const v=(key:string)=>parts.find(p=>p.type===key)!.value;return {day:`${v('year')}-${v('month')}-${v('day')}`,hour:Number(v('hour')),weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(v('weekday'))};}
type Policy={revision:number;previousId:string|null;clientVersion:number;briefRevision:number;stopEpoch:string;mailboxId:string;sender:string;rules:DialogueAutoRules;actor:string;reason:string};
type Attempt={policyId:string;draftId:string;incomingId:string;basisHash:string;accountKey:string};
type Row<T>=T&{id:string;createdAt:string};
function rows(s:Store,c:string,type:string){return s.db.prepare('SELECT * FROM events WHERE clientId=? AND type=? ORDER BY rowid DESC').all(c,type) as LedgerEvent[];}
const decode=<T>(e:LedgerEvent):Row<T>=>({...JSON.parse(e.text),id:e.id,createdAt:e.createdAt});
function append<T>(s:Store,c:string,type:string,d:T){const id=randomUUID(),createdAt=new Date().toISOString();s.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(id,c,null,type,JSON.stringify(d),createdAt);return {id,createdAt,...d};}
export function autoPolicy(s:Store,c:string){const client=s.client(c),b=s.briefState(c),history=rows(s,c,POLICY).map(decode<Policy>).sort((a,b)=>b.revision-a.revision),current=history[0]||null,stopEpoch=epoch(s);const active=!!current?.rules.enabled&&client.status!=='paused'&&b.approved&&current.clientVersion===client.version&&current.briefRevision===b.revision&&current.stopEpoch===stopEpoch;return {current,history,active,clientVersion:client.version,briefRevision:b.revision,stopEpoch,reason:active?'Dialogautomatik freigegeben.':!current?.rules.enabled?'Dialogautomatik ausgeschaltet.':'Freigabe nach Pause, Rahmenänderung oder Notstopp erneut prüfen.'};}
export function saveAutoPolicy(s:Store,c:string,input:any){return checked(()=>s.transaction(()=>{
 exactObject(input,['expectedId','clientVersion','briefRevision','stopEpoch','rules','actor','reason','confirmed','mailboxId','sender']);
 const p=autoPolicy(s,c),r=validateAutoRules(input.rules);if(input.confirmed!==true)fail('Automatischen echten Versand ausdrücklich freigeben.');
 if(input.expectedId!==(p.current?.id||null)||input.clientVersion!==p.clientVersion||input.briefRevision!==p.briefRevision||input.stopEpoch!==p.stopEpoch)fail('Freigabestand geändert. Neu laden.');
 if(r.enabled&&(s.client(c).status==='paused'||!s.briefState(c).approved))fail('Aktiven Kundenrahmen zuerst freigeben.');
 if(r.enabled&&r.dailyLimit>s.brief(c).content.rules.dailyLimit)fail('Automatiklimit überschreitet den genehmigten Kundenrahmen.');
 if(r.enabled?(!uuid(input.mailboxId)||typeof input.sender!=='string'||!/^\S+@\S+\.\S+$/.test(input.sender)):(input.mailboxId!==''||input.sender!==''))fail('Verifiziertes Postfach fehlt.');
 append<Policy>(s,c,POLICY,{revision:(p.current?.revision||0)+1,previousId:p.current?.id||null,clientVersion:p.clientVersion,briefRevision:p.briefRevision,stopEpoch:p.stopEpoch,mailboxId:input.mailboxId,sender:input.sender,rules:r,actor:cleanText(input.actor,120),reason:cleanText(input.reason,1500)});return autoPolicy(s,c);
}));}
export function autoAccountKey(s:Store,c:string,recipient:string){const lead=s.db.prepare('SELECT id FROM leads WHERE clientId=? AND email=?').get(c,recipient);const link=lead?s.db.prepare('SELECT accountId FROM lead_account_links WHERE clientId=? AND leadId=? ORDER BY revision DESC LIMIT 1').get(c,lead.id):null;return link?.accountId?'account:'+String(link.accountId):'domain:'+recipient.split('@')[1].toLowerCase();}
function activeRule(s:Store,c:string,policyId:string,at:Date){const p=autoPolicy(s,c);if(!p.active||p.current!.id!==policyId)fail('Automatikfreigabe geändert oder angehalten.');const r=p.current!.rules,t=localAutoTime(at,r.timezone);if(!r.weekdays.includes(t.weekday)||t.hour<r.startHour||t.hour>=r.endHour)fail('Außerhalb des freigegebenen Zeitfensters.');return {p:p.current!,r,t};}
function limits(s:Store,c:string,policyId:string,accountKey:string,at:Date,exceptAttempt='',exceptMail=''){
 const {p,r,t}=activeRule(s,c,policyId,at),attempts=rows(s,c,ATTEMPT).filter(e=>e.id!==exceptAttempt);
 if(attempts.filter(e=>localAutoTime(new Date(e.createdAt),r.timezone).day===t.day).length>=r.dailyLimit)fail('Automatik-Tageslimit erreicht. Auch angehaltene Versuche zählen.');
 const pending=attempts.some(e=>!s.db.prepare("SELECT id FROM events WHERE clientId=? AND type=? AND json_extract(text,'$.attemptId')=?").get(c,RESULT,e.id));if(pending)fail('Automatikversuch noch offen.');
 const times=s.db.prepare('SELECT recipient,createdAt FROM mail_tests WHERE clientId=? AND id<>?').all(c,exceptMail).filter(m=>autoAccountKey(s,c,String(m.recipient))===accountKey).map(m=>String(m.createdAt));
 for(const e of attempts){const d=JSON.parse(e.text);if(d.accountKey===accountKey&&!s.db.prepare("SELECT id FROM events WHERE clientId=? AND type='DIALOGUE_RESERVED' AND json_extract(text,'$.autoAttemptId')=?").get(c,e.id))times.push(e.createdAt);}
 if(times.filter(ti=>localAutoTime(new Date(ti),r.timezone).day===t.day).length>=r.accountDailyLimit)fail('Unternehmens-Tageslimit erreicht.');
 if(times.some(ti=>at.getTime()-Date.parse(ti)<r.accountGapMinutes*60000))fail('Mindestabstand für dieses Unternehmen noch nicht erreicht.');return p;
}
export function assertAutoAttempt(s:Store,c:string,id:string,incomingId:string,draftId:string,basisHash:string,exceptMail=''){
 const e=rows(s,c,ATTEMPT).find(e=>e.id===id);if(!e)fail('Automatikauftrag fehlt.');const d=decode<Attempt>(e!),age=Date.now()-Date.parse(d.createdAt);if(age<0||age>60000)fail('Automatikauftrag abgelaufen.');
 if(d.incomingId!==incomingId||d.draftId!==draftId||d.basisHash!==basisHash||rows(s,c,RESULT).some(r=>JSON.parse(r.text).attemptId===id))fail('Automatikauftrag geändert oder abgeschlossen.');
 const recipient=String(s.db.prepare('SELECT recipient FROM incoming WHERE clientId=? AND id=?').get(c,incomingId)?.recipient||'');if(!recipient||autoAccountKey(s,c,recipient)!==d.accountKey)fail('Unternehmenszuordnung geändert.');
 return limits(s,c,d.policyId,d.accountKey,new Date(),id,exceptMail);
}
function eligible(s:Store,c:string,incomingId:string,draftId:string,policyId:string,at:Date){
 if(rows(s,c,ATTEMPT).some(e=>JSON.parse(e.text).draftId===draftId))fail('Entwurf bereits automatisch versucht. Menschlich prüfen; kein automatischer Neuversand.');
 const preview=dialoguePreview(s,c,incomingId,draftId),key=autoAccountKey(s,c,preview.snapshot.recipient),p=limits(s,c,policyId,key,at);
 if(preview.snapshot.mailboxId!==p.mailboxId||preview.snapshot.sender!==p.sender)fail('Entwurf gehört nicht zum freigegebenen Postfach.');
 const draft=s.db.prepare('SELECT createdAt FROM events WHERE id=? AND clientId=?').get(draftId,c)!;
 if(at.getTime()-Date.parse(String(draft.createdAt))<p.rules.minDelayMinutes*60000)fail('Wartezeit seit Entwurfsprüfung noch nicht erreicht.');
 return {preview,accountKey:key};
}
export function autoState(s:Store,c:string){const policy=autoPolicy(s,c),seen=new Set<string>(),at=new Date();const candidates=rows(s,c,'REPLY_DRAFT_SAVED').sort((a,b)=>JSON.parse(b.text).revision-JSON.parse(a.text).revision).filter(e=>{const id=JSON.parse(e.text).incomingId;if(seen.has(id))return false;seen.add(id);return true;}).map(e=>{const d=JSON.parse(e.text);let reason='Automatik nicht freigegeben.',basisHash='';try{const p=eligible(s,c,d.incomingId,e.id,policy.current?.id||'',at);basisHash=p.preview.basisHash;reason='Versand nach frischer Google-Prüfung möglich.';}catch(error){reason=(error as Error).message;}return {draftId:e.id,incomingId:d.incomingId,recipient:String(s.db.prepare('SELECT recipient FROM incoming WHERE id=? AND clientId=?').get(d.incomingId,c)?.recipient||''),ready:!!basisHash,basisHash,reason};});
 const results=rows(s,c,RESULT);const attempts=rows(s,c,ATTEMPT).map(e=>{const d=decode<Attempt>(e),result=results.find(r=>JSON.parse(r.text).attemptId===e.id);const mail=s.db.prepare("SELECT m.id,m.status,m.result FROM events e JOIN mail_tests m ON m.id=e.id WHERE e.clientId=? AND e.type='DIALOGUE_RESERVED' AND json_extract(e.text,'$.autoAttemptId')=?").get(c,e.id);return {...d,result:result?JSON.parse(result.text):null,mail:mail||null};});return {policy,candidates,attempts,asOf:at.toISOString()};
}
export function dueAuto(s:Store){const due=[];for(const c of s.db.prepare("SELECT id FROM clients WHERE status<>'paused'").all()){const id=String(c.id);if(!autoPolicy(s,id).active)continue;const state=autoState(s,id),candidate=state.candidates.find(c=>c.ready);if(candidate)due.push({clientId:id,policyId:state.policy.current!.id,...candidate});}return due;}
export function claimAuto(s:Store,c:string,input:any){return checked(()=>s.transaction(()=>{exactObject(input,['policyId','incomingId','draftId','basisHash']);const p=eligible(s,c,input.incomingId,input.draftId,input.policyId,new Date());if(p.preview.basisHash!==input.basisHash)fail('Entwurf geändert.');return append<Attempt>(s,c,ATTEMPT,{policyId:input.policyId,draftId:input.draftId,incomingId:input.incomingId,basisHash:input.basisHash,accountKey:p.accountKey});}));}
export function finishAuto(s:Store,c:string,id:string,input:any){return checked(()=>s.transaction(()=>{exactObject(input,['reason']);if(!rows(s,c,ATTEMPT).some(e=>e.id===id)||rows(s,c,RESULT).some(e=>JSON.parse(e.text).attemptId===id))fail('Automatikauftrag fehlt oder ist abgeschlossen.');return append(s,c,RESULT,{attemptId:id,reason:cleanText(input.reason,2000)});}));}
export function expireAuto(s:Store,restart=false){const cutoff=Date.now()-180000;const pending=s.db.prepare("SELECT a.* FROM events a WHERE a.type=? AND NOT EXISTS (SELECT 1 FROM events r WHERE r.type=? AND r.clientId=a.clientId AND json_extract(r.text,'$.attemptId')=a.id)").all(ATTEMPT,RESULT) as LedgerEvent[];for(const e of pending){if(!restart&&Date.parse(e.createdAt)>cutoff)continue;finishAuto(s,e.clientId!,e.id,{reason:'Automatik unterbrochen. Versandstatus prüfen; keine automatische Wiederholung.'});}}
export function exportAuto(s:Store,c:string){s.client(c);return {format:'eiz-dialogue-automation',clientId:c,exportedAt:new Date().toISOString(),state:autoState(s,c),events:s.db.prepare('SELECT * FROM events WHERE clientId=? AND type IN (?,?,?) ORDER BY rowid').all(c,...types)};}
export function protectAutoRestore(s:Store,data:BackupData){for(const e of s.db.prepare('SELECT * FROM events WHERE type IN (?,?,?)').all(...types) as LedgerEvent[]){const old=data.events.find(x=>x.id===e.id);if(!old||Object.keys(e).some(k=>(e as any)[k]!== (old as any)[k]))fail('Sicherung würde bekannte Dialogautomatik zurücksetzen. Aktuelle Sicherung verwenden.');}}
export function validateAuto(data:BackupData,version:number){checked(()=>{
 const events=data.events.filter(e=>e.type.startsWith('DIALOGUE_AUTO_'));if(events.length&&version<26)fail('Dialogautomatik benötigt Datenversion26.');const policies=new Map<string,LedgerEvent>(),attempts=new Map<string,LedgerEvent>(),drafts=new Set<string>(),results=new Set<string>();
 for(const e of events){if(!types.includes(e.type)||!e.clientId||e.jobId!==null)fail('Ungültige Automatikherkunft.');const d=JSON.parse(e.text);
 if(e.type===POLICY){exactObject(d,['revision','previousId','clientVersion','briefRevision','stopEpoch','mailboxId','sender','rules','actor','reason']);validateAutoRules(d.rules);cleanText(d.actor,120);cleanText(d.reason,1500);
 if(!Number.isInteger(d.revision)||d.revision<1||!Number.isInteger(d.clientVersion)||d.clientVersion<1||!Number.isInteger(d.briefRevision)||d.briefRevision<0||typeof d.stopEpoch!=='string'||(d.stopEpoch!==''&&!data.events.some(x=>x.id===d.stopEpoch&&x.type==='QUEUE_EMERGENCY_STOP')))fail('Ungültige Automatikrevision.');
 if(d.rules.enabled?(!uuid(d.mailboxId)||typeof d.sender!=='string'||!/^\S+@\S+\.\S+$/.test(d.sender)):(d.mailboxId!==''||d.sender!==''))fail('Ungültige Automatikpostfachbindung.');policies.set(e.id,e);
 }else if(e.type===ATTEMPT){exactObject(d,['policyId','draftId','incomingId','basisHash','accountKey']);if(!uuid(d.policyId)||!uuid(d.draftId)||!uuid(d.incomingId)||typeof d.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(d.basisHash)||typeof d.accountKey!=='string'||!/^account:[a-f0-9-]{36}$|^domain:[^\s@]+$/.test(d.accountKey)||drafts.has(d.draftId))fail('Ungültiger oder wiederholter Automatikversuch.');drafts.add(d.draftId);attempts.set(e.id,e);
 }else{exactObject(d,['attemptId','reason']);cleanText(d.reason,2000);if(results.has(d.attemptId))fail('Wiederholter Automatikabschluss.');results.add(d.attemptId);}}
 for(const e of policies.values()){const d=JSON.parse(e.text),siblings=[...policies.values()].filter(p=>p.clientId===e.clientId&&JSON.parse(p.text).revision===d.revision);const prev=d.previousId?policies.get(d.previousId):null;if(siblings.length!==1||(d.revision===1?d.previousId!==null:!prev||prev.clientId!==e.clientId||JSON.parse(prev.text).revision!==d.revision-1))fail('Automatik-Regelkette unterbrochen.');}
 for(const e of attempts.values()){const d=JSON.parse(e.text),p=policies.get(d.policyId),draft=data.events.find(x=>x.id===d.draftId&&x.clientId===e.clientId&&x.type==='REPLY_DRAFT_SAVED');if(!p||p.clientId!==e.clientId||!JSON.parse(p.text).rules.enabled||!draft||JSON.parse(draft.text).incomingId!==d.incomingId)fail('Automatikauftrag ohne freigegebene Herkunft.');}
 for(const e of events.filter(x=>x.type===RESULT)){const a=attempts.get(JSON.parse(e.text).attemptId);if(!a||a.clientId!==e.clientId)fail('Automatikabschluss ohne Auftrag.');}
 const bound=new Set<string>();for(const e of data.events.filter(x=>x.type==='DIALOGUE_RESERVED')){const d=JSON.parse(e.text);if(!d.autoAttemptId)continue;const a=attempts.get(d.autoAttemptId),v=a?JSON.parse(a.text):null,p=v?policies.get(v.policyId):null,r=p?JSON.parse(p.text):null;if(!a||a.clientId!==e.clientId||v.draftId!==d.draftId||v.incomingId!==d.incomingId||r.mailboxId!==d.mailboxId||r.sender!==d.sender||bound.has(a.id))fail('Dialog ohne passende Automatikfreigabe.');const {autoAttemptId,...snapshot}=d;if(v.basisHash!==createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'))fail('Automatikgrundlage widerspricht Versand.');bound.add(a!.id);}
});}

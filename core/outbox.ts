import {assertContactPermission} from './contact-permission';
import {freezeMailPresentation,assertMailPresentation,mailPresentation} from './mail-presentation';
import {assertTrackingReady} from './tracking';
import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {personalize,validateCampaign,type CampaignContent} from './campaign';
import {companyStop} from './operations';
import {unassigned} from './unassigned';
import {assertDeliveryFresh} from './delivery-progress';
import type {BackupData} from './types';
export type QueueRun={id:string;clientId:string;campaignId:string;fingerprint:string;snapshot:string;status:string;revision:number;createdAt:string;updatedAt:string;reason:string};
export type QueueItem={id:string;runId:string;leadId:string;recipient:string;step:number;subject:string;body:string;status:string;eligibleDate:string|null;simulatedAt:string|null;localDay:string|null;reason:string};
export function localTime(at:Date,zone:string){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(at).map(p=>[p.type,p.value]));const day=`${p.year}-${p.month}-${p.day}`;return {day,hour:Number(p.hour),weekday:new Date(day+'T12:00:00Z').getUTCDay()};}
export function plusDays(day:string,gap:number){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+gap);return d.toISOString().slice(0,10);}
function run(s:Store,clientId:string,id:string){s.client(clientId);const r=s.db.prepare('SELECT * FROM queue_runs WHERE id=? AND clientId=?').get(id,clientId) as unknown as QueueRun;if(!r)throw new AppError('Probelauf nicht gefunden.',404);return r;}
function current(s:Store,r:QueueRun){const snap=JSON.parse(r.snapshot),c=s.client(r.clientId),b=s.briefState(r.clientId),p=s.campaignPreview(r.clientId,r.campaignId);if(c.status==='paused'||c.version!==snap.clientVersion||!b.approved||b.revision!==snap.briefRevision||p.fingerprint!==r.fingerprint||s.campaign(r.clientId,r.campaignId).approvedHash!==r.fingerprint)throw new AppError('Kunde, Kontakte oder Freigabe geändert. Lauf bleibt angehalten; Plan erneut prüfen und neue Fassung vorbereiten.');return snap;}
export function queueState(s:Store,clientId:string){s.client(clientId);return (s.db.prepare('SELECT * FROM queue_runs WHERE clientId=? ORDER BY createdAt DESC,id').all(clientId) as unknown as QueueRun[]).map(r=>({...r,snapshot:JSON.parse(r.snapshot),counts:s.db.prepare('SELECT status,COUNT(*) AS count FROM queue_items WHERE runId=? GROUP BY status').all(r.id),items:s.db.prepare('SELECT * FROM queue_items WHERE runId=? ORDER BY step,recipient,id LIMIT 100').all(r.id)}));}
export function prepareQueue(s:Store,clientId:string,campaignId:string,input:any){return s.transaction(()=>{
 const p=s.campaignPreview(clientId,campaignId);if(input?.confirmed!==true||input.fingerprint!==p.fingerprint||!p.approved)throw new AppError('Aktuell geprüften Kampagnenplan ausdrücklich bestätigen.',409);
 if(s.db.prepare('SELECT id FROM queue_runs WHERE campaignId=? AND fingerprint=?').get(campaignId,p.fingerprint))throw new AppError('Diese Planfassung wurde bereits übernommen. Vorhandenen Lauf öffnen.',409);
 const campaign=s.campaign(clientId,campaignId),content=validateCampaign(JSON.parse(campaign.content)),brief=s.briefState(clientId),id=randomUUID(),at=new Date().toISOString();
 if(content.leadIds.length>1000)throw new AppError('Probelauf ist auf 1.000 Kontakte je Kampagne begrenzt.');
 const leads=content.leadIds.map(id=>s.db.prepare('SELECT * FROM leads WHERE id=? AND clientId=?').get(id,clientId) as any);
 for(const lead of leads)if(s.db.prepare("SELECT q.id FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE r.clientId=? AND q.recipient=? AND q.status IN ('ready','waiting') AND r.status IN ('prepared','active','paused') LIMIT 1").get(clientId,lead.email))throw new AppError(`${lead.email}: bereits in einer offenen Warteschlange dieses Kunden.`);
 const snapshot=JSON.stringify({mode:'rehearsal',name:content.name,content,clientVersion:s.client(clientId).version,briefRevision:brief.revision,clientDailyLimit:brief.content.rules.dailyLimit});
 s.db.prepare('INSERT INTO queue_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,clientId,campaignId,p.fingerprint,snapshot,'prepared',1,at,at,'Noch nicht gestartet.','rehearsal');
 const insert=s.db.prepare('INSERT INTO queue_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
 for(const lead of leads)for(const [step,msg]of content.steps.entries())insert.run(randomUUID(),id,lead.id,lead.email,step,personalize(msg.subject,lead),personalize(msg.body,lead),step?'waiting':'ready',step?null:content.startDate,null,null,'');
 s.event(clientId,null,'QUEUE_PREPARED',JSON.stringify({runId:id,campaignId,contacts:leads.length,messages:leads.length*content.steps.length,mode:'rehearsal'}));return queueState(s,clientId);
});}
export function controlQueue(s:Store,clientId:string,id:string,input:any){return s.transaction(()=>{
 const r=run(s,clientId,id);if(input?.revision!==r.revision)throw new AppError('Lauf wurde geändert. Bitte neu laden.',409);if(!['start','pause','cancel'].includes(input.action))throw new AppError('Ungültige Laufaktion.');if(['completed','cancelled'].includes(r.status))throw new AppError('Lauf ist bereits abgeschlossen.');
 if(input.action==='start'){if(input.confirmed!==true)throw new AppError('Lauf ausdrücklich bestätigen.');const snap=current(s,r);if(snap.mode==='live')assertNoOpenSend(s,clientId);}
 const live=JSON.parse(r.snapshot).mode==='live';
 const finished=live&&input.action==='start'&&!s.db.prepare("SELECT id FROM queue_items WHERE runId=? AND status IN ('ready','waiting','sending','unknown') LIMIT 1").get(id);
 const status=finished?'completed':input.action==='start'?'active':input.action==='pause'?'paused':'cancelled',reason=finished?'Lauf geprüft und abgeschlossen; keine offenen Versandaufträge.':input.action==='start'?(live?'Live-Versand aktiv.':'Probelauf aktiv · keine echten E-Mails.'):input.action==='pause'?'Durch Betreiber angehalten.':'Durch Betreiber abgebrochen.';
 s.db.prepare('UPDATE queue_runs SET status=?,revision=revision+1,reason=?,updatedAt=? WHERE id=?').run(status,reason,new Date().toISOString(),id);
 if(status==='cancelled')s.db.prepare("UPDATE queue_items SET status='cancelled',reason=? WHERE runId=? AND status IN ('ready','waiting')").run(reason,id);
 s.event(clientId,null,'QUEUE_CONTROLLED',JSON.stringify({runId:id,action:input.action,mode:live?'live':'rehearsal'}));return queueState(s,clientId);
});}

export function activateLiveQueue(s:Store,clientId:string,id:string,input:any){return s.transaction(()=>{
 const r=run(s,clientId,id),snap=current(s,r);
 if(!['prepared','paused'].includes(r.status)||input?.revision!==r.revision)throw new AppError('Lauf wurde geändert. Bitte neu laden.',409);
 if(input?.confirmed!==true||input?.phrase!=='ECHTEN VERSAND AKTIVIEREN')throw new AppError('Echten Versand mit dem angezeigten Bestätigungstext freigeben.',409);
 if(snap.mode==='live')throw new AppError('Dieser Lauf ist bereits an sein Versandpostfach gebunden.');
 if(s.db.prepare("SELECT id FROM queue_items WHERE runId=? AND status NOT IN ('ready','waiting') LIMIT 1").get(id))throw new AppError('Bereits verarbeitete Simulationen können nicht live werden. Neue Planfassung vorbereiten.');
 const mailboxId=typeof input.mailboxId==='string'?input.mailboxId:'',sender=typeof input.sender==='string'?input.sender.toLowerCase():'';
 if(!/^[a-f0-9-]{36}$/.test(mailboxId)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sender))throw new AppError('Postfachzuordnung ist ungültig.');
 if(!s.db.prepare("SELECT id FROM mail_tests WHERE clientId=? AND mailboxId=? AND sender=? AND status='sent' LIMIT 1").get(clientId,mailboxId,sender))throw new AppError('Für dieses Postfach fehlt eine von Google angenommene Testnachricht.');
 assertDeliveryFresh(s,clientId,mailboxId);
 if(unassigned(s,clientId).some(x=>x.mailboxId===mailboxId&&x.status==='open'))throw new AppError('Ungeklärte Postfacheingänge müssen zuerst bearbeitet werden.');
 mailPresentation(s,clientId,{to:sender,subject:'Absenderprüfung',bodyText:'Absenderprüfung'},mailboxId,sender);
 const next={...snap,mode:'live',mailboxId,sender,activatedAt:new Date().toISOString()};
 s.db.prepare("UPDATE queue_runs SET snapshot=?,status='paused',revision=revision+1,reason=?,updatedAt=? WHERE id=?").run(JSON.stringify(next),'Echter Versand freigegeben. Lauf muss anschließend bewusst gestartet werden.',new Date().toISOString(),id);
 s.event(clientId,null,'QUEUE_LIVE_APPROVED',JSON.stringify({runId:id,mailboxId,sender,contacts:next.content.leadIds.length}));return queueState(s,clientId);
});}

function assertNoOpenSend(s:Store,clientId:string,except=''){
 if(s.db.prepare("SELECT id FROM mail_tests WHERE clientId=? AND id<>? AND status IN ('sending','unknown') LIMIT 1").get(clientId,except))throw new AppError('Ein Versandergebnis ist noch offen. Zuerst Gmail abgleichen; keine weiteren Sendungen.',409);
}
export function expireOutbound(s:Store,at=new Date()){return s.transaction(()=>{
 const rows=s.db.prepare("SELECT q.id,r.id AS runId,r.clientId FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE q.status='sending' AND q.simulatedAt<?").all(new Date(at.getTime()-180000).toISOString());
 for(const q of rows){const message='Versandabschluss fehlt. Gmail abgleichen; keine automatische Wiederholung.';
  s.db.prepare("UPDATE mail_tests SET status='unknown',result=?,updatedAt=? WHERE id=? AND status='sending'").run(message,at.toISOString(),q.id);
  s.db.prepare("UPDATE queue_items SET status='unknown',reason=? WHERE id=?").run(message,q.id);
  s.db.prepare("UPDATE queue_runs SET status='paused',revision=revision+1,reason=?,updatedAt=? WHERE id=? AND status NOT IN ('cancelled','completed')").run(message,at.toISOString(),q.runId);
  s.event(String(q.clientId),null,'QUEUE_SEND_EXPIRED',JSON.stringify({itemId:q.id,runId:q.runId}));
 }return rows.length;
});}
// Rotate the bounded inspection page even when a run cannot claim a message.
// This is only a scheduling hint; all durable send decisions remain in claim/authorize.
const outboundCursors=new WeakMap<Store,string>();
export function dueOutbound(s:Store){
 expireOutbound(s);const cursor=outboundCursors.get(s)||'';
 const rows=s.db.prepare("SELECT * FROM queue_runs WHERE status='active' AND json_extract(snapshot,'$.mode')='live' AND id>? ORDER BY id LIMIT 10").all(cursor) as unknown as QueueRun[];
 if(rows.length<10&&cursor)rows.push(...s.db.prepare("SELECT * FROM queue_runs WHERE status='active' AND json_extract(snapshot,'$.mode')='live' AND id<=? ORDER BY id LIMIT ?").all(cursor,10-rows.length) as unknown as QueueRun[]);
 if(rows.length)outboundCursors.set(s,rows[rows.length-1].id);else outboundCursors.delete(s);
 return rows.map(r=>({clientId:r.clientId,runId:r.id,mailboxId:JSON.parse(r.snapshot).mailboxId}));
}

export function claimOutbound(s:Store,clientId:string,id:string,input:any,at=new Date()){return s.transaction(()=>{
 if(!Number.isFinite(at.getTime()))throw new AppError('Ungültige Uhrzeit.');const r=run(s,clientId,id),snap=current(s,r);if(r.status!=='active'||snap.mode!=='live')throw new AppError('Live-Lauf ist nicht aktiv.',409);
 if(input?.mailboxId!==snap.mailboxId)throw new AppError('Postfach wurde geändert. Versand angehalten.',409);assertDeliveryFresh(s,clientId,snap.mailboxId);
 if(input.sender!==snap.sender)throw new AppError('Absender wurde geändert. Versand angehalten.',409);assertNoOpenSend(s,clientId);
 if(unassigned(s,clientId).some(x=>x.status==='open'))throw new AppError('Ungeklärte Postfacheingänge vorhanden. Versand angehalten.',409);
 const content=snap.content as CampaignContent,time=localTime(at,content.timezone);if(time.day<content.startDate||!content.weekdays.includes(time.weekday)||time.hour<content.startHour||time.hour>=content.endHour)throw new AppError('Kein freigegebenes Versandzeitfenster.',409);
 const campaignCount=Number(s.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE runId=? AND localDay=? AND status IN ('sending','sent','unknown','failed')").get(r.id,time.day)?.n);
 const utcDay=at.toISOString().slice(0,10),clientCount=Number(s.db.prepare("SELECT COUNT(*) AS n FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE r.clientId=? AND q.status IN ('sending','sent','unknown','failed') AND substr(q.simulatedAt,1,10)=?").get(clientId,utcDay)?.n);
 const dialogueRows=s.db.prepare("SELECT m.createdAt FROM mail_tests m JOIN events e ON e.id=m.id AND e.type='DIALOGUE_RESERVED' WHERE m.clientId=?").all(clientId),dialogueCount=dialogueRows.filter(m=>String(m.createdAt).slice(0,10)===utcDay).length;
 if(campaignCount>=content.dailyLimit||clientCount+dialogueCount>=snap.clientDailyLimit)throw new AppError('Tageslimit erreicht.',409);
 const last=s.db.prepare("SELECT MAX(q.simulatedAt) AS at FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE r.clientId=? AND q.status IN ('sending','sent','unknown','failed')").get(clientId)?.at;if(last&&at.getTime()-Date.parse(String(last))<60000)throw new AppError('Mindestabstand von einer Minute pro Kunde.',409);
 if(dialogueRows.some(m=>at.getTime()-Date.parse(String(m.createdAt))<60000))throw new AppError('Mindestabstand von einer Minute pro Kunde.',409);
 const q=s.db.prepare("SELECT * FROM queue_items WHERE runId=? AND status='ready' AND eligibleDate<=? ORDER BY eligibleDate,step,recipient,id LIMIT 1").get(r.id,time.day) as unknown as QueueItem|undefined;if(!q)throw new AppError('Kein Versandauftrag ist fällig.',409);
 assertContactPermission(s,clientId,q.leadId);const stop=reason(s,r,q);if(stop){s.db.prepare("UPDATE queue_items SET status='held',reason=? WHERE runId=? AND recipient=? AND status IN ('ready','waiting')").run(stop,r.id,q.recipient);s.event(clientId,null,'QUEUE_CONTACT_HELD',JSON.stringify({runId:id,recipient:q.recipient,reason:stop}));return null;}
 if(q.step>0&&!s.db.prepare("SELECT id FROM queue_items WHERE runId=? AND leadId=? AND step=? AND status='sent'").get(id,q.leadId,q.step-1))throw new AppError('Vorgänger wurde nicht bestätigt.');
 const messageId=`<${q.id}@workbench.local>`,stamp=at.toISOString();s.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(q.id,clientId,snap.mailboxId,snap.sender,q.recipient,q.subject,q.body,messageId,'sending','','Kampagnenversand gestartet. Ergebnis noch offen.',stamp,stamp);
 s.db.prepare("UPDATE queue_items SET status='sending',simulatedAt=?,localDay=?,reason='Für Gmail reserviert; Ergebnis offen.' WHERE id=? AND status='ready'").run(stamp,time.day,q.id);s.db.prepare("UPDATE queue_runs SET reason='Eine Nachricht wird für Gmail geprüft.',updatedAt=? WHERE id=?").run(stamp,r.id);s.event(clientId,null,'QUEUE_SEND_STARTED',JSON.stringify({runId:r.id,itemId:q.id,recipient:q.recipient,step:q.step,messageId}));const mail={...q,clientId,mailboxId:snap.mailboxId,sender:snap.sender,messageId,runRevision:r.revision};const presentation=freezeMailPresentation(s,mail);return {...mail,...(presentation?{presentation}:{})};
});}

export function authorizeOutbound(s:Store,clientId:string,id:string,itemId:string,input:any,at=new Date()){return s.transaction(()=>{
 assertTrackingReady(s,clientId,itemId);assertMailPresentation(s,clientId,itemId);
 const r=run(s,clientId,id),snap=current(s,r),q=s.db.prepare('SELECT * FROM queue_items WHERE id=? AND runId=?').get(itemId,id) as unknown as QueueItem|undefined;
 if(r.status!=='active'||snap.mode!=='live'||r.revision!==input?.revision||!q||q.status!=='sending')throw new AppError('Lauf angehalten oder geändert. Keine Übergabe an Gmail.',409);
 assertContactPermission(s,clientId,q.leadId);
 if(input.mailboxId!==snap.mailboxId||input.sender!==snap.sender)throw new AppError('Postfach oder Absender geändert.',409);
 const age=at.getTime()-Date.parse(q.simulatedAt||'');if(!Number.isFinite(age)||age<0||age>60000)throw new AppError('Versandreservierung ist abgelaufen.',409);
 const time=localTime(at,snap.content.timezone);if(time.day!==q.localDay||!snap.content.weekdays.includes(time.weekday)||time.hour<snap.content.startHour||time.hour>=snap.content.endHour)throw new AppError('Versandzeitfenster geschlossen.',409);
 assertNoOpenSend(s,clientId,itemId);assertDeliveryFresh(s,clientId,snap.mailboxId);
 assertContactPermission(s,clientId,q.leadId);const stop=reason(s,r,q);if(stop)throw new AppError(stop,409);
 if(unassigned(s,clientId).some(x=>x.status==='open'))throw new AppError('Ungeklärte Postfacheingänge vorhanden.',409);
 if(s.db.prepare("SELECT id FROM events WHERE clientId=? AND type='QUEUE_SEND_AUTHORIZED' AND json_extract(text,'$.itemId')=?").get(clientId,itemId))throw new AppError('Versandentscheidung bereits verbraucht. Gmail prüfen.',409);
 s.event(clientId,null,'QUEUE_SEND_AUTHORIZED',JSON.stringify({runId:id,itemId,revision:r.revision,mailboxId:snap.mailboxId,at:at.toISOString()}));return {allowed:true};
});}

export function finishOutbound(s:Store,clientId:string,id:string,itemId:string,input:any,finishedAt=new Date()){return s.transaction(()=>{
 const r=run(s,clientId,id),q=s.db.prepare('SELECT * FROM queue_items WHERE id=? AND runId=?').get(itemId,id) as unknown as QueueItem|undefined;if(!q||q.status!=='sending')throw new AppError('Versandauftrag ist nicht mehr aktiv.',409);
 const status=input?.status,providerId=typeof input?.providerId==='string'?input.providerId:'',result=typeof input?.result==='string'?input.result.slice(0,2000):'';if(!['sent','failed','unknown'].includes(status)||status==='sent'&&!/^[a-zA-Z0-9_-]{1,255}$/.test(providerId))throw new AppError('Ungültiges Versandergebnis.');
 const at=finishedAt.toISOString();const changed=s.db.prepare("UPDATE mail_tests SET status=?,providerId=?,result=?,updatedAt=? WHERE id=? AND clientId=? AND status='sending'").run(status,providerId,result,at,itemId,clientId);if(!changed.changes)throw new AppError('Versandhistorie wurde geändert. Gmail abgleichen.',409);s.db.prepare('UPDATE queue_items SET status=?,reason=? WHERE id=?').run(status,result,itemId);
 if(status==='failed')s.db.prepare("UPDATE queue_items SET status='held',reason='Vorgänger fehlgeschlagen; keine automatische Fortsetzung.' WHERE runId=? AND leadId=? AND status='waiting'").run(id,q.leadId);
 if(status==='sent'){releaseFollowup(s,r,q,finishedAt);s.db.prepare("UPDATE queue_runs SET reason='Von Google angenommen. Zustellung noch nicht bestätigt.',updatedAt=? WHERE id=? AND status='active'").run(at,id);}
 else s.db.prepare("UPDATE queue_runs SET status='paused',revision=revision+1,reason=?,updatedAt=? WHERE id=? AND status NOT IN ('cancelled','completed')").run(status==='unknown'?'Versandergebnis unklar. Gmail prüfen; keine automatische Wiederholung.':'Versand fehlgeschlagen. Dieser Auftrag wird nicht wiederholt; nach Prüfung kann der Rest fortgesetzt werden.',at,id);
 if(status==='sent'&&!s.db.prepare("SELECT id FROM queue_items WHERE runId=? AND status IN ('ready','waiting','sending','unknown') LIMIT 1").get(id))s.db.prepare("UPDATE queue_runs SET status='completed',revision=revision+1,reason='Live-Lauf abgeschlossen. Zustellung und Antworten weiter prüfen.',updatedAt=? WHERE id=? AND status='active'").run(at,id);
 s.event(clientId,null,'QUEUE_SEND_FINISHED',JSON.stringify({runId:id,itemId,status,providerId,result}));return queueState(s,clientId);
});}
function releaseFollowup(s:Store,r:QueueRun,q:QueueItem,at:Date){
 if(['cancelled','completed'].includes(r.status))return;
 const snap=JSON.parse(r.snapshot),next=snap.content.steps[q.step+1];if(next)s.db.prepare("UPDATE queue_items SET status='ready',eligibleDate=? WHERE runId=? AND leadId=? AND step=? AND status='waiting'").run(plusDays(localTime(at,snap.content.timezone).day,next.gapDays),r.id,q.leadId,q.step+1);
}
export function reconcileOutbound(s:Store,clientId:string,itemId:string,result:string){
 const q=s.db.prepare("SELECT q.* FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE q.id=? AND r.clientId=? AND q.status='unknown'").get(itemId,clientId) as unknown as QueueItem|undefined;if(!q)return;
 const r=run(s,clientId,q.runId);s.db.prepare("UPDATE queue_items SET status='sent',reason=? WHERE id=?").run(result,itemId);releaseFollowup(s,r,q,new Date());
 s.db.prepare("UPDATE queue_runs SET status='paused',revision=revision+1,reason='Gmail-Abgleich bestätigt. Vor Fortsetzung Lauf prüfen.',updatedAt=? WHERE id=? AND status NOT IN ('cancelled','completed')").run(new Date().toISOString(),r.id);
}
export function stopQueues(s:Store){return s.transaction(()=>{const result=s.db.prepare("UPDATE queue_runs SET status='paused',revision=revision+1,reason='Globaler Notstopp. Bewusst erneut starten.',updatedAt=? WHERE status IN ('active','prepared')").run(new Date().toISOString());s.event(null,null,'QUEUE_EMERGENCY_STOP','Alle aktiven und vorbereiteten Probeläufe angehalten.');return {stopped:Number(result.changes)};});}
function reason(s:Store,r:QueueRun,item:QueueItem){const lead=s.db.prepare('SELECT * FROM leads WHERE id=? AND clientId=?').get(item.leadId,r.clientId);if(!lead||lead.email!==item.recipient)return 'Kontakt fehlt oder wurde geändert.';if(lead.blocked)return 'Kontakt gesperrt.';if(companyStop(s,r.clientId,item.recipient))return 'Unternehmensdomain gesperrt.';if(s.db.prepare('SELECT id FROM incoming WHERE clientId=? AND recipient=? LIMIT 1').get(r.clientId,item.recipient))return 'Eingang vorhanden: Kontakt angehalten.';return '';}
// No network adapter exists in this worker. A simulation can never become a send.
export function tickQueues(s:Store,at=new Date()){return s.transaction(()=>{
 if(!Number.isFinite(at.getTime()))throw new AppError('Ungültige Uhrzeit.');let processed=0;
 const runs=s.db.prepare("SELECT * FROM queue_runs WHERE status='active' ORDER BY updatedAt,id LIMIT 20").all() as unknown as QueueRun[];
 for(const r of runs){
  const pause=(message:string)=>{s.db.prepare("UPDATE queue_runs SET status='paused',revision=revision+1,reason=?,updatedAt=? WHERE id=?").run(message,at.toISOString(),r.id);s.event(r.clientId,null,'QUEUE_HELD',JSON.stringify({runId:r.id,reason:message}));};
  let snap:any;try{snap=current(s,r);}catch(e){pause((e as Error).message);continue;}if(snap.mode==='live')continue;
  if(unassigned(s,r.clientId).some(x=>x.status==='open')){pause('Ungeklärte Postfacheingänge vorhanden.');continue;}
  const content=snap.content as CampaignContent,time=localTime(at,content.timezone);
  const stopped=new Map<string,string>();for(const item of s.db.prepare("SELECT * FROM queue_items WHERE runId=? AND status='ready'").all(r.id) as unknown as QueueItem[]){const stop=reason(s,r,item);if(stop)stopped.set(item.recipient,stop);}
  for(const [email,stop]of stopped)s.db.prepare("UPDATE queue_items SET status='held',reason=? WHERE runId=? AND recipient=? AND status IN ('ready','waiting')").run(stop,r.id,email);
  if(!s.db.prepare("SELECT id FROM queue_items WHERE runId=? AND status IN ('ready','waiting') LIMIT 1").get(r.id)){s.db.prepare("UPDATE queue_runs SET status='completed',revision=revision+1,reason='Probelauf abgeschlossen; angehaltene Kontakte gegebenenfalls prüfen.',updatedAt=? WHERE id=?").run(at.toISOString(),r.id);continue;}
  let wait='';
  if(time.day<content.startDate||!content.weekdays.includes(time.weekday)||time.hour<content.startHour||time.hour>=content.endHour)wait='Wartet auf Versandzeitfenster.';
  const count=Number(s.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE runId=? AND localDay=? AND status='simulated'").get(r.id,time.day)?.n);
  const day=at.toISOString().slice(0,10),total=Number(s.db.prepare("SELECT COUNT(*) AS n FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE r.clientId=? AND q.status='simulated' AND substr(q.simulatedAt,1,10)=?").get(r.clientId,day)?.n);
  if(count>=content.dailyLimit||total>=snap.clientDailyLimit)wait='Tageslimit erreicht (Kampagne lokal, Kunde UTC).';
  const last=s.db.prepare("SELECT MAX(q.simulatedAt) AS at FROM queue_items q JOIN queue_runs r ON r.id=q.runId WHERE r.clientId=?").get(r.clientId)?.at;
  if(last&&at.getTime()-Date.parse(String(last))<60000)wait='Mindestabstand von einer Minute pro Kunde.';
  const item=s.db.prepare("SELECT * FROM queue_items WHERE runId=? AND status='ready' AND eligibleDate<=? ORDER BY eligibleDate,step,recipient,id LIMIT 1").get(r.id,time.day) as unknown as QueueItem|undefined;
  if(!item&&!wait)wait='Wartet auf nächsten Follow-up-Tag.';
  if(wait){s.db.prepare('UPDATE queue_runs SET reason=?,updatedAt=? WHERE id=?').run(wait,at.toISOString(),r.id);continue;}
  const q=item!;s.db.prepare("UPDATE queue_items SET status='simulated',simulatedAt=?,localDay=?,reason='Nur simuliert; nicht versendet.' WHERE id=? AND status='ready'").run(at.toISOString(),time.day,q.id);
  const next=content.steps[q.step+1];if(next)s.db.prepare("UPDATE queue_items SET status='ready',eligibleDate=? WHERE runId=? AND leadId=? AND step=? AND status='waiting'").run(plusDays(time.day,next.gapDays),r.id,q.leadId,q.step+1);
  s.db.prepare("UPDATE queue_runs SET reason='Nachricht simuliert. Kein Versand.',updatedAt=? WHERE id=?").run(at.toISOString(),r.id);s.event(r.clientId,null,'QUEUE_SIMULATED',JSON.stringify({runId:r.id,itemId:q.id,recipient:q.recipient,step:q.step,at:at.toISOString()}));processed++;
 }
 return {processed};
});}
export function validateQueueBackup(data:BackupData){
 const runs=data.queueRuns||[],items=data.queueItems||[];if(!Array.isArray(runs)||!Array.isArray(items)||runs.length>10000||items.length>500000)throw new AppError('Ungültige Warteschlangensicherung.');const ids=new Map<string,QueueRun>(),unique=new Set<string>(),snapshots=new Map<string,any>(),leadIndex=new Map((data.leads||[]).map(l=>[l.id,l])),counts=new Map<string,number>();
 for(const r of runs){const snap=JSON.parse(r.snapshot);validateCampaign(snap.content);if(!/^[a-f0-9-]{36}$/.test(r.id)||ids.has(r.id)||!data.campaigns?.some(c=>c.id===r.campaignId&&c.clientId===r.clientId)||!['rehearsal','live'].includes(snap.mode)||(r as any).mode!=='rehearsal'||snap.mode==='live'&&(!/^[a-f0-9-]{36}$/.test(snap.mailboxId)||typeof snap.sender!=='string')||!['prepared','active','paused','completed','cancelled'].includes(r.status)||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isSafeInteger(snap.clientVersion)||!Number.isSafeInteger(snap.briefRevision)||!Number.isInteger(snap.clientDailyLimit)||snap.clientDailyLimit<1||snap.clientDailyLimit>1000||!/^[a-f0-9]{64}$/.test(r.fingerprint)||!Number.isFinite(Date.parse(r.createdAt))||!Number.isFinite(Date.parse(r.updatedAt))||typeof r.reason!=='string'||r.reason.length>2000)throw new AppError('Ungültiger Probelauf.');ids.set(r.id,r);snapshots.set(r.id,snap);}
 const itemIds=new Set<string>();for(const q of items){const r=ids.get(q.runId),snap=r?snapshots.get(r.id):null,key=q.runId+':'+q.leadId+':'+q.step;const lead=leadIndex.get(q.leadId);if(!r||!lead||lead.clientId!==r.clientId||!snap.content.leadIds.includes(q.leadId)||q.recipient!==lead.email||!Number.isInteger(q.step)||q.step<0||q.step>=snap.content.steps.length||!/^[a-f0-9-]{36}$/.test(q.id)||itemIds.has(q.id)||unique.has(key)||!['ready','waiting','simulated','sending','sent','failed','unknown','held','cancelled'].includes(q.status)||typeof q.subject!=='string'||q.subject.length>120||/[\r\n\0]/.test(q.subject)||typeof q.body!=='string'||q.body.length>4000||q.body.includes('\0')||typeof q.reason!=='string'||q.reason.length>2000||q.eligibleDate!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(q.eligibleDate)||q.simulatedAt!==null&&!Number.isFinite(Date.parse(q.simulatedAt))||['simulated','sending','sent','failed','unknown'].includes(q.status)&&(!q.simulatedAt||!q.localDay)||q.status==='ready'&&!q.eligibleDate||['sending','sent','failed','unknown'].includes(q.status)&&!data.mailTests?.some(m=>m.id===q.id&&m.clientId===r.clientId&&m.recipient===q.recipient))throw new AppError('Ungültiger Warteschlangenauftrag.');unique.add(key);itemIds.add(q.id);counts.set(q.runId,(counts.get(q.runId)||0)+1);}
 for(const r of runs){const snap=JSON.parse(r.snapshot);if((counts.get(r.id)||0)!==snap.content.leadIds.length*snap.content.steps.length)throw new AppError('Unvollständiger Probelauf.');}
}

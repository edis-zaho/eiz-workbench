import {openUnassigned} from './unassigned';
import {deliveryAuto,assertDeliveryAuto,settleDeliveryAuto} from './delivery-auto';
import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {deliveryMails,recordDeliveryScan} from './inbox';
const key=(client:string)=>'delivery-progress:'+client;
function read(s:Store,client:string){const r=s.db.prepare('SELECT value FROM meta WHERE key=?').get(key(client));return r?JSON.parse(String(r.value)):null;}
function write(s:Store,client:string,state:any){s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key(client),JSON.stringify(state));}
export function deliveryProgress(s:Store,client:string){const c=s.client(client),r=read(s,client);if(!r)return {automation:deliveryAuto(s,client),status:'never',stale:true,sendAllowed:false};return {...r,unmatched:r.unresolvedTracking?openUnassigned(s,client,r.mailboxId):r.unmatched+openUnassigned(s,client,r.mailboxId),automation:deliveryAuto(s,client),stale:r.syncVersion!==1||r.scopeVersion!==2||r.status!=='complete'||r.clientVersion!==c.version||Date.now()-r.cutoff*1000>600000,sendAllowed:false};}
export function claimDeliveryPage(s:Store,client:string,input:any){return s.transaction(()=>{
 if(input?.automatic===true)assertDeliveryAuto(s,client,input);
 const c=s.client(client);if(c.status==='paused')throw new AppError('Kunde ist pausiert.');if(c.version!==input?.clientVersion)throw new AppError('Kundenstand geändert.',409);
 const mails=deliveryMails(s,client,input.mailboxId);if(!mails.length)throw new AppError('Keine bestätigten Testsendungen für dieses Postfach.');
 const mailSet=mails.map(m=>String(m.id)).sort().join(',');
 let r=read(s,client);if(r?.status==='running'&&r.leaseUntil>Date.now())throw new AppError('Rückläuferprüfung läuft bereits.',409);
 if(!r||r.trackingVersion!==1||r.syncVersion!==1||r.scopeVersion!==2||r.mailSet!==mailSet||r.mailboxId!==input.mailboxId||r.clientVersion!==c.version||r.status==='complete'||r.resetRequired||input.restart===true){
  const incremental=r?.trackingVersion===1&&r?.syncVersion===1&&r.mailSet===mailSet&&r.mailboxId===input.mailboxId&&r.clientVersion===c.version&&r.status==='complete'&&r.historyId&&!r.resetRequired&&input.restart!==true;
  const cutoff=Math.floor(Date.now()/1000),start=Math.max(0,Math.floor(mails.reduce((oldest,m)=>Math.min(oldest,Date.parse(String(m.createdAt))),Infinity)/1000)-86400);
  r={trackingVersion:1,syncVersion:1,phase:incremental?'history':'full',historyId:incremental?r.historyId:undefined,mailSet,scopeVersion:2,runId:randomUUID(),mailboxId:input.mailboxId,clientVersion:c.version,cutoff,query:`after:${start} -in:sent -in:drafts`,pageToken:'',pages:0,checked:0,added:0,unmatched:incremental?r.unmatched:0,skipped:0,tokens:[],lastError:''};
 }
 r.autoGeneration=deliveryAuto(s,client).generation;r.automatic=input?.automatic===true;r.status='running';r.leaseId=randomUUID();r.leaseUntil=Date.now()+120000;r.lastError='';write(s,client,r);
 return {...r,mails};
});}
function active(s:Store,client:string,input:any){const r=read(s,client);if(!r||r.status!=='running'||r.leaseId!==input?.leaseId||r.runId!==input?.runId||r.leaseUntil<Date.now())throw new AppError('Prüflauf ist nicht mehr aktiv.',409);return r;}
export function finishDeliveryPage(s:Store,client:string,input:any){
 const r=active(s,client,input),token=input.nextPageToken;
 if(typeof token!=='string'||token.length>2000||/[\r\n\0]/.test(token)||token&&(token===r.pageToken||r.tokens.includes(token))||r.pages>=1000)throw new AppError('Suchfortschritt ungültig oder Grenze erreicht. Bitte Prüfung neu starten.');
 if(input.query!==r.query||input.mailboxId!==r.mailboxId||input.clientVersion!==r.clientVersion)throw new AppError('Prüflauf wurde verändert.',409);
 const valid=(id:any)=>typeof id==='string'&&/^[1-9][0-9]{0,39}$/.test(id);
 if(r.phase==='full'&&(!valid(input.baselineHistoryId)||r.baselineHistoryId&&r.baselineHistoryId!==input.baselineHistoryId)||r.phase==='history'&&(!valid(input.historyId)||BigInt(input.historyId)<BigInt(r.historyId)))throw new AppError('Ungültiger Google-Änderungsstand.');
 return recordDeliveryScan(s,client,{...input,extended:r.scopeVersion===2,truncated:!!token},(added)=>{
  r.unresolvedTracking=Array.isArray(input.unresolved);r.added+=added;r.status=token?'partial':'complete';r.pageToken=token;r.pages++;r.checked+=input.checked;r.unmatched+=input.unmatched;r.skipped+=input.skipped;r.leaseUntil=0;
  if(token)r.tokens.push(token);
  if(r.phase==='full'){r.baselineHistoryId=input.baselineHistoryId;if(!token){r.phase='history';r.historyId=r.baselineHistoryId;r.status='partial';r.tokens=[];}}
  else if(!token)r.historyId=input.historyId;
  r.updatedAt=new Date().toISOString();write(s,client,r);if(r.automatic)settleDeliveryAuto(s,client,r.status==='complete','',r.autoGeneration);
 });
}
export function failDeliveryPage(s:Store,client:string,input:any){return s.transaction(()=>{const r=active(s,client,input);r.status='failed';r.leaseUntil=0;if(input.historyExpired===true&&r.phase==='history'){r.resetRequired=true;delete r.historyId;}r.lastError=typeof input.error==='string'?input.error.slice(0,1000):'Abruf fehlgeschlagen.';write(s,client,r);if(r.automatic)settleDeliveryAuto(s,client,false,r.lastError,r.autoGeneration);return deliveryProgress(s,client);});}
export function assertDeliveryFresh(s:Store,client:string,mailboxId:string){const r=deliveryProgress(s,client);const mailSet=deliveryMails(s,client,mailboxId).map(m=>String(m.id)).sort().join(',');if(r.mailboxId!==mailboxId||r.stale||r.unmatched>0||!Number.isFinite(r.cutoff)||r.cutoff*1000>Date.now()+1000||r.mailSet!==mailSet||s.client(client).status==='paused')throw new AppError('Rückläuferprüfung fehlt, ist unvollständig oder veraltet. Versand bleibt angehalten.');}

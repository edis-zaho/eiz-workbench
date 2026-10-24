import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {deliveryMails} from './inbox';
const key=(id:string)=>'delivery-auto:'+id;
export function deliveryAuto(s:Store,id:string):any{s.client(id);const row=s.db.prepare('SELECT value FROM meta WHERE key=?').get(key(id));if(!row)return {enabled:false,nextAt:0,failures:0,lastError:''};const r=JSON.parse(String(row.value));return r.scopeVersion===2?r:{...r,enabled:false,lastError:'Erweiterte Antwortprüfung benötigt eine neue Aktivierung.'};}
function save(s:Store,id:string,r:any){s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key(id),JSON.stringify(r));}
export function configureDeliveryAuto(s:Store,id:string,input:any){return s.transaction(()=>{
 const c=s.client(id);if(typeof input?.enabled!=='boolean')throw new AppError('Status fehlt.');
 if(input.enabled){if(c.status==='paused'||c.version!==input.clientVersion)throw new AppError('Kunde pausiert oder geändert.');if(!deliveryMails(s,id,input.mailboxId).length)throw new AppError('Keine bestätigten Testsendungen.');}
 const r={scopeVersion:2,generation:randomUUID(),enabled:input.enabled,mailboxId:input.mailboxId,clientVersion:c.version,nextAt:Date.now(),failures:0,lastError:''};save(s,id,r);
 s.event(id,null,input.enabled?'DELIVERY_AUTO_ENABLED':'DELIVERY_AUTO_DISABLED',input.enabled?'Automatische Rückläuferprüfung aktiviert.':'Automatische Rückläuferprüfung angehalten.');return r;
});}
export function assertDeliveryAuto(s:Store,id:string,input:any){const c=s.client(id),r=deliveryAuto(s,id);if(!r.enabled||r.mailboxId!==input.mailboxId||r.clientVersion!==c.version||c.status==='paused'||r.nextAt>Date.now())throw new AppError('Automatische Prüfung ist nicht freigegeben oder noch nicht fällig.',409);}
export function settleDeliveryAuto(s:Store,id:string,complete:boolean,error='',generation?:string){const r=deliveryAuto(s,id);if(!r.enabled||r.generation!==generation)return; r.failures=error?r.failures+1:0;r.lastError=error.slice(0,1000);r.nextAt=Date.now()+(error?Math.min(3600000,60000*2**r.failures):complete?300000:15000);if(r.failures>=5){r.enabled=false;s.event(id,null,'DELIVERY_AUTO_HALTED','Rückläuferprüfung nach fünf Fehlern angehalten.');}save(s,id,r);}
export function failDeliveryAutoStart(s:Store,id:string,input:any){return s.transaction(()=>{settleDeliveryAuto(s,id,false,typeof input?.error==='string'?input.error:'Prüfung konnte nicht starten.',input?.generation);return deliveryAuto(s,id);});}
export function dueDeliveryAuto(s:Store){return s.db.prepare("SELECT c.id,m.value FROM clients c JOIN meta m ON m.key='delivery-auto:'||c.id WHERE c.status<>'paused'").all().flatMap(row=>{const r=JSON.parse(String(row.value)),c=s.client(String(row.id));const p=s.db.prepare('SELECT value FROM meta WHERE key=?').get('delivery-progress:'+row.id),progress=p?JSON.parse(String(p.value)):null;return r.scopeVersion===2&&r.enabled&&r.clientVersion===c.version&&r.nextAt<=Date.now()&&!(progress?.status==='running'&&progress.leaseUntil>Date.now())?[{clientId:row.id,...r}]:[];}).sort((a,b)=>a.nextAt-b.nextAt).slice(0,10);}

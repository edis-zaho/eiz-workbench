import {AppError,type Store} from './store';
import {publicRecord,putPublicRecord,stableHash} from './public-schema';
import {isDeletedAddress} from './data-retention';
import {companyStop} from './operations';
function contact(s:Store,c:string,id:string){const r=s.db.prepare('SELECT * FROM leads WHERE clientId=? AND id=?').get(c,id);if(!r)throw new AppError('Kontakt fehlt.');return r;}
function fingerprint(s:Store,c:string,l:any){
 const blocks=s.db.prepare("SELECT id FROM events WHERE clientId=? AND type IN ('LEAD_BLOCK_CHANGED','COMPANY_DOMAIN_BLOCKED') ORDER BY rowid").all(c);
 return stableHash({lead:l,blocks});
}
export function validatePermission(v:any){
 if(!v||!/^[a-f0-9-]{36}$/.test(v.leadId)||!/^[a-f0-9]{64}$/.test(v.fingerprint)||!['unknown','reviewed','blocked'].includes(v.status)||typeof v.source!=='string'||v.source.length>2000||typeof v.reason!=='string'||v.reason.length>2000||!Number.isSafeInteger(v.revision)||v.revision<1||v.reviewedAt!==null&&!Number.isFinite(Date.parse(v.reviewedAt))||Object.keys(v).some(k=>!['leadId','source','reason','status','reviewedAt','revision','fingerprint'].includes(k)))throw new AppError('Ungültige Kontaktgrundlage.');
 if(v.status==='reviewed'&&(!v.source.trim()||!v.reason.trim()||!v.reviewedAt))throw new AppError('Quelle und Grund müssen ausdrücklich geprüft sein.');
}
export function saveContactPermission(s:Store,c:string,id:string,input:any){return s.transaction(()=>{
 const l=contact(s,c,id),old=publicRecord(s,'permission',id);
 if(input.expectedRevision!==(old?.revision||0))throw new AppError('Kontaktgrundlage geändert.',409);
 if(input.status==='reviewed'&&(l.blocked||isDeletedAddress(s,String(l.email))||companyStop(s,c,String(l.email))))throw new AppError('Eine bestehende Kontaktsperre bleibt wirksam.');
 const revision=(old?.revision||0)+1,content={leadId:id,source:input.source,reason:input.reason,status:input.status,reviewedAt:input.status==='reviewed'?new Date().toISOString():null,revision,fingerprint:fingerprint(s,c,l)};
 validatePermission(content);putPublicRecord(s,{kind:'permission',id,clientId:c,revision,content});return content;
});}
export function contactPermissionProblems(s:Store,c:string,id:string){
 const l=contact(s,c,id),p=publicRecord(s,'permission',id);
 if(l.blocked||isDeletedAddress(s,String(l.email))||companyStop(s,c,String(l.email)))return ['Kontakt bleibt gesperrt.'];
 if(!p||p.clientId!==c||p.content.status!=='reviewed')return ['Quelle und Kontaktgrund zuerst prüfen.'];
 if(p.content.fingerprint!==fingerprint(s,c,l))return ['Kontakt oder Sperrhistorie geändert. Kontaktgrund erneut prüfen.'];
 return [];
}
export function assertContactPermission(s:Store,c:string,id:string){if(s.publicMode){const problems=contactPermissionProblems(s,c,id);if(problems.length)throw new AppError(problems.join(' '),409);}}

import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {validateBinding,getModelProfile,type ModelBinding} from './model-profiles';
import {publicRecord,putPublicRecord,stableHash} from './public-schema';
export type MailTransferInput={clientId:string;connectionId:string;purpose:'reply-analysis'|'reply-writing';sourceHashes:string[];context:string;promptVersion:string;binding:ModelBinding};
export type MailTransferPreview={hash:string;context:string;destination:string;model:string;bindingHash:string;purpose:MailTransferInput['purpose']};
function facts(i:MailTransferInput){
 validateBinding(i.binding);
 if(!/^[a-f0-9-]{36}$/.test(i.clientId)||!/^[a-f0-9-]{36}$/.test(i.connectionId)||!['reply-analysis','reply-writing'].includes(i.purpose)||
 typeof i.context!=='string'||!i.context||i.context.length>60000||typeof i.promptVersion!=='string'||!i.promptVersion||i.promptVersion.length>120||
 !Array.isArray(i.sourceHashes)||!i.sourceHashes.length||i.sourceHashes.length>100||i.sourceHashes.some(h=>!/^[a-f0-9]{64}$/.test(h)))throw new AppError('Ungültige Mailübertragung.');
 return {clientId:i.clientId,connectionId:i.connectionId,purpose:i.purpose,sourceHashes:[...i.sourceHashes],contextHash:stableHash(i.context),
 promptVersion:i.promptVersion,bindingHash:i.binding.hash,destination:i.binding.origin+i.binding.basePath,model:i.binding.model};
}
export function previewMailTransfer(i:MailTransferInput):MailTransferPreview{
 const f=facts(i);return {hash:stableHash(f),context:i.context,destination:f.destination,model:f.model,bindingHash:f.bindingHash,purpose:f.purpose};
}
export function validateTransfer(v:any){
 if(!v||!/^[a-f0-9-]{36}$/.test(v.clientId)||!/^[a-f0-9-]{36}$/.test(v.connectionId)||!['reply-analysis','reply-writing'].includes(v.purpose)||
 !Array.isArray(v.sourceHashes)||!v.sourceHashes.length||v.sourceHashes.length>100||v.sourceHashes.some((h:any)=>!/^[a-f0-9]{64}$/.test(h))||
 !/^[a-f0-9]{64}$/.test(v.contextHash)||!/^[a-f0-9]{64}$/.test(v.bindingHash)||typeof v.promptVersion!=='string'||v.promptVersion.length>120||
 typeof v.destination!=='string'||v.destination.length>500||!/^https?:\/\//.test(v.destination)||typeof v.model!=='string'||v.model.length>160||
 !Number.isFinite(Date.parse(v.createdAt))||v.revokedAt!==null&&!Number.isFinite(Date.parse(v.revokedAt)))throw new AppError('Ungültige Mailfreigabe.');
 const {hash,createdAt,revokedAt,...f}=v;
 if(hash!==stableHash(f)||Object.keys(f).some(k=>!['clientId','connectionId','purpose','sourceHashes','contextHash','promptVersion','bindingHash','destination','model'].includes(k)))throw new AppError('Mailfreigabe wurde verändert.');
}
export function grantMailTransferWithinTransaction(s:Store,i:MailTransferInput,expectedHash:string){
 s.client(i.clientId);const f=facts(i),hash=stableHash(f),p=getModelProfile(s,i.binding.profile.id);
 if(hash!==expectedHash||!p.enabled||p.binding.hash!==i.binding.hash)throw new AppError('Übertragungsansicht wurde geändert.',409);
 const id=randomUUID();putPublicRecord(s,{kind:'transfer',id,clientId:i.clientId,revision:1,content:{...f,hash,createdAt:new Date().toISOString(),revokedAt:null}});return id;
}
export function grantMailTransfer(s:Store,i:MailTransferInput,expectedHash:string){return s.transaction(()=>grantMailTransferWithinTransaction(s,i,expectedHash));}
export function assertMailTransfer(s:Store,id:string,i:MailTransferInput){
 const r=publicRecord(s,'transfer',id);if(!r||r.clientId!==i.clientId||r.content.revokedAt||r.content.hash!==previewMailTransfer(i).hash)throw new AppError('Modellübertragung ist nicht mehr freigegeben.',409);
 const p=getModelProfile(s,i.binding.profile.id);if(!p.enabled||p.binding.hash!==i.binding.hash)throw new AppError('Modellziel wurde geändert.',409);
}
export function revokeMailTransfer(s:Store,id:string){return s.transaction(()=>{const r=publicRecord(s,'transfer',id);if(!r)throw new AppError('Freigabe fehlt.');r.content.revokedAt=new Date().toISOString();r.revision++;putPublicRecord(s,r);});}

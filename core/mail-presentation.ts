import {AppError,type Store} from './store';
import {publicRecord,putPublicRecord,stableHash} from './public-schema';
import type {MailIdentity} from './mail-provider';
export type SenderProfile={clientId:string;connectionId:string;revision:number;displayName:string;signatureText:string};
export type MailContent={to:string;subject:string;bodyText:string;inReplyTo?:string;references?:string[]};
export type MailPresentation=MailContent&{fromEmail:string;fromName:string;text:string;html:string;senderRevision:number;hash:string};
const email=(s:unknown)=>typeof s==='string'&&s.length<=254&&/^[^\s<>@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)&&!/[;\r\n\0]/.test(s);
const header=(s:unknown,max:number)=>typeof s==='string'&&!!s.trim()&&s.length<=max&&!/[\r\n\0\uFFFD]/.test(s);
const reference=(s:unknown)=>typeof s==='string'&&s.length<=254&&/^<[^<>\s@]+@[^<>\s@]+>$/.test(s);
function html(text:string){
 const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">'+text.split(/(https?:\/\/[^\s<>"]+)/g).map(s=>/^https?:\/\//.test(s)?`<a href="${escape(s)}">${escape(s)}</a>`:escape(s).replace(/\r?\n/g,'<br>')).join('')+'</div>';
}
export function validateSenderRecord(c:any){
 const p=c?.profile,i=c?.identity;
 if(!p||!i||!header(p.displayName,120)||typeof p.signatureText!=='string'||p.signatureText.length>2000||/[\0\uFFFD]/.test(p.signatureText)||
 !Number.isSafeInteger(p.revision)||p.revision<1||p.connectionId!==i.connectionId||i.providerKind!=='gmail'||!email(i.email)||
 !i.checkedAt||!Number.isFinite(Date.parse(i.checkedAt))||!/^[a-f0-9-]{36}$/.test(p.clientId)||!/^[a-f0-9-]{36}$/.test(p.connectionId)||
 Object.keys(p).some(k=>!['clientId','connectionId','revision','displayName','signatureText'].includes(k))||
 Object.keys(i).some(k=>!['providerKind','connectionId','email','checkedAt'].includes(k))||
 Object.keys(c).some(k=>!['profile','identity'].includes(k)))throw new AppError('Absenderprofil oder bestätigte Gmail-Identität fehlt.');
}
export function buildMailPresentation(c:MailContent,p:SenderProfile,i:MailIdentity):MailPresentation{
 validateSenderRecord({profile:p,identity:i});
 if(!email(c.to)||!header(c.subject,120)||typeof c.bodyText!=='string'||!c.bodyText.trim()||c.bodyText.length>4000||/[\0\uFFFD]/.test(c.bodyText)||
 c.inReplyTo!==undefined&&!reference(c.inReplyTo)||c.references!==undefined&&(!Array.isArray(c.references)||c.references.length>30||c.references.some(r=>!reference(r))))throw new AppError('Ungültiger Mailinhalt.');
 const text=c.bodyText.trim()+(p.signatureText.trim()?'\n\n'+p.signatureText.trim():'');
 const fields={to:c.to,subject:c.subject,bodyText:c.bodyText,...(c.inReplyTo?{inReplyTo:c.inReplyTo}:{}),...(c.references?{references:c.references}:{}),
 fromEmail:i.email,fromName:p.displayName,text,html:html(text),senderRevision:p.revision};
 return {...fields,hash:stableHash(fields)};
}
export function validatePresentation(p:any){
 if(!p||!header(p.fromName,120)||!email(p.fromEmail)||!email(p.to)||!header(p.subject,120)||typeof p.bodyText!=='string'||
 typeof p.text!=='string'||p.text.length>6002||/[\0\uFFFD]/.test(p.text)||typeof p.html!=='string'||p.html!==html(p.text)||
 !Number.isSafeInteger(p.senderRevision)||p.senderRevision<1||p.inReplyTo!==undefined&&!reference(p.inReplyTo)||
 p.references!==undefined&&(!Array.isArray(p.references)||p.references.length>30||p.references.some((r:any)=>!reference(r))))throw new AppError('Ungültige Maildarstellung.');
 const {hash,...fields}=p;
 if(hash!==stableHash(fields)||Object.keys(fields).some(k=>!['to','subject','bodyText','inReplyTo','references','fromEmail','fromName','text','html','senderRevision'].includes(k)))throw new AppError('Maildarstellung wurde geändert.');
}
export function senderState(s:Store,clientId:string){s.client(clientId);return publicRecord(s,'sender',clientId)?.content as {profile:SenderProfile;identity:MailIdentity}|undefined;}
export function saveSenderProfile(s:Store,p:SenderProfile,i:MailIdentity){
 return s.transaction(()=>{const old=senderState(s,p.clientId);const content={profile:{...p,revision:(old?.profile.revision||0)+1},identity:i};
  validateSenderRecord(content);putPublicRecord(s,{kind:'sender',id:p.clientId,clientId:p.clientId,revision:content.profile.revision,content});return content;});
}
export function senderFingerprint(s:Store,c:string){const state=senderState(s,c);if(!state){if(s.publicMode)throw new AppError('Bitte zuerst Absender und Signatur einrichten.');return null;}return stableHash(state);}
export function mailPresentation(s:Store,c:string,content:MailContent,connectionId?:string,email?:string){
 const state=senderState(s,c);if(!state){if(s.publicMode)throw new AppError('Bitte zuerst Absender und Signatur einrichten.');return null;}
 if(connectionId!==undefined&&connectionId!==state.profile.connectionId||email!==undefined&&email!==state.identity.email)throw new AppError('Bestätigtes Absenderkonto wurde geändert.');
 return buildMailPresentation(content,state.profile,state.identity);
}
export function freezeMailPresentation(s:Store,m:{id:string;clientId:string;mailboxId:string;sender:string;recipient:string;subject:string;body:string;inReplyTo?:string},expected?:MailPresentation|null){
 const p=mailPresentation(s,m.clientId,{to:m.recipient,subject:m.subject,bodyText:m.body,...(m.inReplyTo?{inReplyTo:m.inReplyTo,references:[m.inReplyTo]}:{})},m.mailboxId,m.sender);
 if(expected&&expected.hash!==p?.hash)throw new AppError('Mailvorschau wurde geändert.',409);
 if(p){if(publicRecord(s,'presentation',m.id))throw new AppError('Maildarstellung bereits reserviert.');putPublicRecord(s,{kind:'presentation',id:m.id,clientId:m.clientId,revision:1,content:p});}
 return p;
}
export function assertMailPresentation(s:Store,c:string,id:string){
 const p=publicRecord(s,'presentation',id);
 if(!p){if(s.publicMode)throw new AppError('Freigegebene Maildarstellung fehlt.');return;}
 if(p.clientId!==c)throw new AppError('Falscher Kunde.');
 const m=s.db.prepare('SELECT * FROM mail_tests WHERE id=? AND clientId=?').get(id,c);
 if(m&&(m.body!==p.content.bodyText||m.subject!==p.content.subject||m.sender!==p.content.fromEmail||m.recipient!==p.content.to))throw new AppError('Mailauftrag wurde geändert.',409);
 const current=mailPresentation(s,c,p.content);
 if(current?.hash!==p.content.hash)throw new AppError('Absender oder Signatur wurde geändert. Erneut prüfen.',409);
}

import {exactObject,cleanText} from './interpretation-input';
import {isoTime} from './meeting-input';
export const signalFlags=['proxy','automation','prefetch'] as const;
export type SignalItem={externalId:string;kind:'open'|'click';occurredAt:string;capturedAt:string;linkId:string|null;flags:(typeof signalFlags[number])[]};
export type SignalFile={format:'eiz-signal-import';version:1;source:{provider:string;stream:string};message:{mailboxId:string;providerMessageId:string};events:SignalItem[]};
export const signalToken=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(v);
export function signalItem(v:any):SignalItem{
 exactObject(v,['externalId','kind','occurredAt','capturedAt','linkId','flags']);
 if(!signalToken(v.externalId)||!['open','click'].includes(v.kind)||v.kind==='open'&&v.linkId!==null||v.kind==='click'&&!signalToken(v.linkId)||!Array.isArray(v.flags)||v.flags.length>3||new Set(v.flags).size!==v.flags.length||v.flags.some((f:any)=>!signalFlags.includes(f)))throw Error('Ungültiges Signal oder Herkunftsmerkmal.');
 const occurredAt=isoTime(v.occurredAt),capturedAt=isoTime(v.capturedAt);
 // Lexical ordering is valid only for the four-digit UTC ISO representation used by this contract.
 if(!/^\d{4}-/.test(occurredAt)||!/^\d{4}-/.test(capturedAt))throw Error('Signalzeit benötigt ein vierstelliges Jahr.');
 if(occurredAt>capturedAt)throw Error('Erfassungszeit der Quelle liegt vor dem Ereignis.');
 return {externalId:v.externalId,kind:v.kind,occurredAt,capturedAt,linkId:v.linkId,flags:[...v.flags].sort()};
}
export function signalFile(v:any):SignalFile{
 exactObject(v,['format','version','source','message','events']);exactObject(v.source,['provider','stream']);exactObject(v.message,['mailboxId','providerMessageId']);
 if(v.format!=='eiz-signal-import'||v.version!==1||!signalToken(v.source.provider)||!signalToken(v.source.stream)||!Array.isArray(v.events)||v.events.length<1||v.events.length>1000||typeof v.message.mailboxId!=='string'||!/^[a-f0-9-]{36}$/.test(v.message.mailboxId)||!signalToken(v.message.providerMessageId))throw Error('Signaldatei benötigt eine Quelle, eine Nachrichtenbindung und 1 bis 1.000 Ereignisse.');
 return {format:'eiz-signal-import',version:1,source:{provider:v.source.provider,stream:v.source.stream},message:{mailboxId:v.message.mailboxId,providerMessageId:v.message.providerMessageId},events:v.events.map(signalItem)};
}
export function signalActor(v:unknown){const value=cleanText(v,120);if(/[\r\n\t]/.test(value))throw Error('Betreiber muss eine einzeilige Angabe sein.');return value;}

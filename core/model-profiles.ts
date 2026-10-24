import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {publicRecords,publicRecord,putPublicRecord,stableHash} from './public-schema';

export type ModelTask='analysis'|'writing'|'knowledge'|'campaign-writing'|'reply-analysis'|'reply-writing';
export type ModelProtocol='openai-responses'|'gemini-generate-content'|'anthropic-messages'|'openai-chat-completions';
export type ProfileRef={id:string;revision:number};
export type ModelBinding={profile:ProfileRef;provider:'openai'|'gemini'|'anthropic'|'custom';protocol:ModelProtocol;model:string;origin:string;basePath:string;credentialRef:string|null;maxOutputTokens:number;hash:string};
export type ModelProfile={id:string;revision:number;name:string;binding:ModelBinding;enabled:boolean};
export type SaveModelProfileInput=Omit<ModelBinding,'profile'|'hash'> & {id?:string;expectedRevision?:number;name:string};
const builtins={
  openai:{protocol:'openai-responses',origin:'https://api.openai.com',basePath:'/v1'},
  gemini:{protocol:'gemini-generate-content',origin:'https://generativelanguage.googleapis.com',basePath:'/v1beta'},
  anthropic:{protocol:'anthropic-messages',origin:'https://api.anthropic.com',basePath:'/v1'}
} as const;
export function endpointFields(provider:ModelBinding['provider']){return provider==='custom'?undefined:builtins[provider];}
export function validateBinding(input:any):asserts input is ModelBinding {
  if(!input||!['openai','gemini','anthropic','custom'].includes(input.provider)||!input.profile||
    typeof input.profile.id!=='string'||!/^[a-f0-9-]{36}$/.test(input.profile.id)||!Number.isSafeInteger(input.profile.revision)||input.profile.revision<1||
    typeof input.model!=='string'||!input.model||input.model.length>160||/[\s\x00-\x1f]/.test(input.model)||
    !Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1||input.maxOutputTokens>65536||
    (input.credentialRef!==null&&(typeof input.credentialRef!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.credentialRef))))throw new AppError('Ungültiges Modellprofil.');
  let url:URL;try{url=new URL(input.origin);}catch{throw new AppError('Ungültige Modelladresse.');}
  const local=['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if(url.origin!==input.origin||url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))||
    typeof input.basePath!=='string'||!/^\/[a-zA-Z0-9/_-]*$/.test(input.basePath)||input.basePath.includes('//')||input.basePath.length>120)throw new AppError('Ungültiger Modell-Endpunkt.');
  const expected=endpointFields(input.provider);
  if(expected&&Object.entries(expected).some(([k,v])=>input[k]!==v))throw new AppError('Anbieter und Endpunkt passen nicht zusammen.');
  if(!expected&&input.protocol!=='openai-chat-completions')throw new AppError('Custom unterstützt Chat-Completions.');
  const {hash,...fields}=input;
  if(typeof hash!=='string'||hash!==stableHash(fields)||Object.keys(fields).some(k=>!['profile','provider','protocol','model','origin','basePath','credentialRef','maxOutputTokens'].includes(k)))throw new AppError('Modellbindung wurde verändert.');
}
export function validateModelProfile(p:any):asserts p is ModelProfile {
  if(!p||typeof p.name!=='string'||!p.name.trim()||p.name.length>120||typeof p.enabled!=='boolean'||
    Object.keys(p).some(k=>!['id','revision','name','binding','enabled'].includes(k)))throw new AppError('Ungültiges Modellprofil.');
  validateBinding(p.binding);
  if(p.id!==p.binding.profile.id||p.revision!==p.binding.profile.revision)throw new AppError('Profilrevision passt nicht.');
}
export function modelProfiles(s:Store):ModelProfile[]{return publicRecords(s,'profile').map(r=>r.content);}
export function getModelProfile(s:Store,id:string):ModelProfile {
  const p=publicRecord(s,'profile',id)?.content;if(!p)throw new AppError('Modellprofil fehlt.',404);validateModelProfile(p);return p;
}
export function saveModelProfile(s:Store,input:SaveModelProfileInput):ModelProfile {
  return s.transaction(()=>saveModelProfileWithinTransaction(s,input));
}
export function saveModelProfileWithinTransaction(s:Store,input:SaveModelProfileInput):ModelProfile {
  if(!input||typeof input.name!=='string')throw new AppError('Profilname fehlt.');
    const old=input.id?getModelProfile(s,input.id):undefined;
    if(old&&old.revision!==input.expectedRevision)throw new AppError('Modellprofil wurde geändert.',409);
    const id=old?.id||randomUUID(),revision=(old?.revision||0)+1;
    const fields={profile:{id,revision},provider:input.provider,protocol:input.protocol,model:input.model,origin:input.origin,basePath:input.basePath,credentialRef:input.credentialRef,maxOutputTokens:input.maxOutputTokens};
    const p:ModelProfile={id,revision,name:input.name.trim(),binding:{...fields,hash:stableHash(fields)},enabled:true};
    validateModelProfile(p);
    putPublicRecord(s,{kind:'profile',id,clientId:null,revision,content:p});return p;
}

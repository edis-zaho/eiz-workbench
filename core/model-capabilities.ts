import {AppError,type Store} from './store';
import {publicRecord,putPublicRecord} from './public-schema';
import type {ModelBinding} from './model-profiles';
export type Capability={bindingHash:string;text:boolean;structured:boolean;testedAt:string};
export function evaluateModelCapabilities(binding:ModelBinding,results:{text:string;structured:string}):Capability{
 let structured=false;try{const j=JSON.parse(results.structured);structured=j?.ok===true&&Object.keys(j).length===1;}catch{}
 return {bindingHash:binding.hash,text:typeof results.text==='string'&&results.text.trim().length>0,structured,testedAt:new Date().toISOString()};
}
export function validateCapability(v:any){
 if(!v||!/^[a-f0-9]{64}$/.test(v.bindingHash)||typeof v.text!=='boolean'||typeof v.structured!=='boolean'||!Number.isFinite(Date.parse(v.testedAt))||Object.keys(v).some(k=>!['bindingHash','text','structured','testedAt'].includes(k)))throw new AppError('Ungültiger Modelltest.');
}
export function saveCapability(s:Store,binding:ModelBinding,result:{text:string;structured:string}){
 const content=evaluateModelCapabilities(binding,result),old=publicRecord(s,'capability',binding.hash);
 s.transaction(()=>putPublicRecord(s,{kind:'capability',id:binding.hash,clientId:null,revision:(old?.revision||0)+1,content}));
 return content;
}
export function assertCapability(s:Store,binding:ModelBinding,structured:boolean){
 const c=publicRecord(s,'capability',binding.hash)?.content;
 if(!c?.text||structured&&!c.structured)throw new AppError('Dieses Modellprofil zuerst mit synthetischen Daten testen.');
}

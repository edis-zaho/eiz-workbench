import {randomUUID} from 'node:crypto';
import {assertCapability} from './model-capabilities';
import {AppError,type Store} from './store';
import {publicRecord,publicRecords,putPublicRecord,stableHash} from './public-schema';
import {resolveModelRoute} from './model-routing';
import {getModelProfile,validateBinding,type ModelTask,type ModelBinding} from './model-profiles';
import {validatePrice,quoteModelCost,natural,type PriceSchedule} from './model-usage';
import {reserveModelBudgetWithinTransaction,markModelStartedWithinTransaction,settleModelBudget,type ModelBillingOutcome} from './model-budget';
import {grantMailTransferWithinTransaction,previewMailTransfer,assertMailTransfer,type MailTransferInput} from './mail-transfer';
import type {BackupData} from './types';
type PriceConfig={bindingHash:string;prices:PriceSchedule;inputUpperBound:number;inputBoundSource:string};
type MailBasis={connectionId:string;sourceHashes:string[];promptVersion:string};
export type DispatchPermit={runId:string;binding:ModelBinding;contextHash:string;reservationId:string;mailGrantId:string|null};
export function taskRoute(s:Store,c:string,t:ModelTask,legacy:{provider:string;model:string}){
 if(!s.publicMode)return legacy;
 const b=resolveModelRoute(s,c,t);return {provider:b.provider,model:b.model};
}
export function historicalModelRoute(data:BackupData,run:{id:string;provider:string;model:string},legacy:{provider:string;model:string}){
 const d=data.publicState?.records.find(r=>r.kind==='dispatch'&&r.id===run.id)?.content;
 return d?.binding||legacy;
}
export function validatePriceConfig(v:any){
 if(!v||!/^[a-f0-9]{64}$/.test(v.bindingHash)||!natural(v.inputUpperBound)||v.inputUpperBound<1||v.inputUpperBound>10000000||
 typeof v.inputBoundSource!=='string'||!/^https:\/\//.test(v.inputBoundSource)||v.inputBoundSource.length>2000||
 Object.keys(v).some(k=>!['bindingHash','prices','inputUpperBound','inputBoundSource'].includes(k)))throw new AppError('Dokumentierte Modellobergrenze fehlt.');
 validatePrice(v.prices);
}
export function configureModelPrice(s:Store,id:string,input:Omit<PriceConfig,'bindingHash'>){
 return s.transaction(()=>{const p=getModelProfile(s,id),content={...input,bindingHash:p.binding.hash};validatePriceConfig(content);
  if(content.prices.provider!==p.binding.provider||content.prices.protocol!==p.binding.protocol||content.prices.model!==p.binding.model)throw new AppError('Preis gehört zu einem anderen Modell.');
  const old=publicRecord(s,'price',id);putPublicRecord(s,{kind:'price',id,clientId:null,revision:(old?.revision||0)+1,content});return content;});
}
export function modelSetup(s:Store,c:string,t:ModelTask){
 const binding=resolveModelRoute(s,c,t),p=publicRecord(s,'price',binding.profile.id)?.content as PriceConfig|undefined;
 const price=p?.bindingHash===binding.hash?p:null;
 return {binding,quote:quoteModelCost(binding,{inputUpperBound:price?.inputUpperBound??null,outputUpperBound:binding.maxOutputTokens},price?.prices||null)};
}
function sourceFingerprint(s:Store,c:string){
 const tables=['clients','briefs','products','product_revisions','accounts','account_revisions','lead_account_links','knowledge_versions','strategy_versions','campaigns','incoming','interpretations','thread_contexts','leads'];
 const values=tables.map(table=>[table,s.db.prepare(`SELECT * FROM ${table} WHERE ${table==='clients'?'id':'clientId'}=? ORDER BY rowid`).all(c)]);
 const policies=s.db.prepare("SELECT * FROM events WHERE (clientId=? OR clientId IS NULL) AND type IN ('QUEUE_EMERGENCY_STOP','ANALYSIS_AUTO_POLICY','REPLY_PREPARATION_POLICY','LEAD_BLOCK_CHANGED','COMPANY_DOMAIN_BLOCKED') ORDER BY rowid").all(c);
 return stableHash({values,policies});
}
export function validateDispatch(v:any){
 if(!v||!/^[a-f0-9-]{36}$/.test(v.runId)||!/^[a-f0-9-]{36}$/.test(v.clientId)||!['analysis','writing','knowledge','campaign-writing','reply-analysis','reply-writing'].includes(v.purpose)||
 !['reserved','started','finished','unknown'].includes(v.state)||!Number.isFinite(Date.parse(v.createdAt))||!/^[a-f0-9]{64}$/.test(v.sourceHash)||
 !/^[a-f0-9]{64}$/.test(v.contextHash)||v.reservationId!==v.runId||v.mailGrantId!==null&&!/^[a-f0-9-]{36}$/.test(v.mailGrantId)||
 typeof v.priceHash!=='string'||!/^[a-f0-9]{64}$/.test(v.priceHash))throw new AppError('Ungültige Modellübergabe.');
 validateBinding(v.binding);
 if(!v.payload||typeof v.payload!=='object'||Array.isArray(v.payload))throw new AppError('Modellinhalt fehlt.');
 if(v.payload.context!==undefined&&(typeof v.payload.context!=='string'||v.payload.context.length>60000)||v.payload.prompt!==undefined&&
 (!v.payload.prompt||typeof v.payload.prompt.system!=='string'||v.payload.prompt.system.length>10000||typeof v.payload.prompt.user!=='string'||v.payload.prompt.user.length>60000)||
 Object.keys(v.payload).some(k=>!['context','prompt'].includes(k))||v.contextHash!==stableHash(v.payload))throw new AppError('Modellinhalt wurde geändert.');
 if(v.purpose.startsWith('reply-')!==!!v.mailGrantId)throw new AppError('Mailübertragungsfreigabe fehlt.');
 if(Object.keys(v).some(k=>!['runId','clientId','purpose','binding','contextHash','reservationId','mailGrantId','mailInput','sourceHash','priceHash','payload','state','createdAt','capabilityTest'].includes(k)))throw new AppError('Unbekanntes Übergabefeld.');
 if(v.capabilityTest!==undefined&&typeof v.capabilityTest!=='boolean')throw new AppError('Ungültiger Verbindungstest.');
 if(v.capabilityTest&&(v.purpose!=='analysis'||v.mailInput))throw new AppError('Ungültiger Testzweck.');
 if(v.purpose.startsWith('reply-')!==!!v.mailInput)throw new AppError('Mailherkunft fehlt.');
 if(v.mailInput&&(previewMailTransfer(v.mailInput).bindingHash!==v.binding.hash||v.mailInput.clientId!==v.clientId||v.mailInput.purpose!==v.purpose||v.mailInput.context!==JSON.stringify(v.payload)))throw new AppError('Falsche Mailzielbindung.');
}
export function bindModelRun(s:Store,c:string,run:any,expectedHash?:string,mail?:MailBasis,capabilityTest=false){
 if(!s.publicMode)return run;
 const {binding,quote}=modelSetup(s,c,run.purpose);
 if(!capabilityTest)assertCapability(s,binding,!['analysis','writing'].includes(run.purpose));
 if(binding.hash!==expectedHash)throw new AppError('Modellvorschau wurde geändert. Erneut bestätigen.',409);
 if(publicRecord(s,'dispatch',run.id))throw new AppError('Modellauftrag bereits gebunden.');
 const payload={...(run.context!==undefined?{context:run.context}:{}),...(run.prompt?{prompt:run.prompt}:{})};
 let mailGrantId:string|null=null,mailInput:MailTransferInput|null=null;
 if(run.purpose.startsWith('reply-')){
  if(!mail)throw new AppError('Mailherkunft fehlt.');
  mailInput={clientId:c,...mail,purpose:run.purpose,context:JSON.stringify(payload),binding};
  mailGrantId=grantMailTransferWithinTransaction(s,mailInput,previewMailTransfer(mailInput).hash);
 }
 reserveModelBudgetWithinTransaction(s,run.id,c,quote);
 const price=publicRecord(s,'price',binding.profile.id)!;
 const content={runId:run.id,clientId:c,purpose:run.purpose,binding,contextHash:stableHash(payload),reservationId:run.id,mailGrantId,mailInput,
 capabilityTest,sourceHash:sourceFingerprint(s,c),priceHash:stableHash(price.content),payload,state:'reserved',createdAt:new Date().toISOString()};
 putPublicRecord(s,{kind:'dispatch',id:run.id,clientId:c,revision:1,content});
 s.db.prepare('UPDATE ai_runs SET provider=?,model=? WHERE id=? AND clientId=?').run(binding.provider,binding.model,run.id,c);
 return {...run,provider:binding.provider,model:binding.model,binding,contextHash:content.contextHash,reservationId:run.id,mailGrantId,capabilityTest};
}
export function authorizeModelDispatch(s:Store,c:string,id:string,expectedHash:string):DispatchPermit{return s.transaction(()=>{
 const r=publicRecord(s,'dispatch',id);if(!r||r.clientId!==c||r.content.state!=='reserved')throw new AppError('Modellauftrag nicht aktiv oder bereits gestartet.',409);
 const d=r.content,binding=resolveModelRoute(s,c,d.purpose),run=s.db.prepare('SELECT * FROM ai_runs WHERE id=? AND clientId=?').get(id,c);
 if(!run||run.status!=='running'||s.client(c).status==='paused'||binding.hash!==expectedHash||binding.hash!==d.binding.hash||
 sourceFingerprint(s,c)!==d.sourceHash||stableHash(publicRecord(s,'price',binding.profile.id)?.content)!==d.priceHash)throw new AppError('Modellziel, Quellen, Preis oder Freigabe geändert.',409);
 if(!d.capabilityTest)assertCapability(s,binding,!['analysis','writing'].includes(d.purpose));
 if(d.mailGrantId)assertMailTransfer(s,d.mailGrantId,d.mailInput);
 markModelStartedWithinTransaction(s,id);r.content.state='started';r.revision++;putPublicRecord(s,r);
 return {runId:id,binding:structuredClone(d.binding),contextHash:d.contextHash,reservationId:id,mailGrantId:d.mailGrantId};
});}
export function finishModelDispatch(s:Store,c:string,id:string,outcome:ModelBillingOutcome){
 const r=publicRecord(s,'dispatch',id);if(!r||r.clientId!==c)throw new AppError('Modellauftrag fehlt.');
 const settled=settleModelBudget(s,id,outcome);
 s.transaction(()=>{const latest=publicRecord(s,'dispatch',id)!;latest.content.state=settled.costStatus==='unknown'?'unknown':'finished';latest.revision++;putPublicRecord(s,latest);});
 return settled;
}

export function reserveCapabilityRun(s:Store,c:string,expectedHash:string){return s.transaction(()=>{
 const binding=resolveModelRoute(s,c,'analysis');
 if(s.db.prepare("SELECT id FROM ai_runs WHERE clientId=? AND status='running'").get(c))throw new AppError('Modellauftrag läuft bereits.');
 const id=randomUUID(),client=s.client(c),brief=s.brief(c),prompt={system:'Return only JSON: {"ok":true}',user:'Synthetic capability test. No customer data.'};
 s.db.prepare('INSERT INTO ai_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c,'analysis',binding.provider,binding.model,brief.revision,client.version,'running','{}','','{}',new Date().toISOString(),'unreviewed');
 return bindModelRun(s,c,{id,clientId:c,purpose:'analysis',prompt},expectedHash,undefined,true);
});}

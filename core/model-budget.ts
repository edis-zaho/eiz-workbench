import {AppError,type Store} from './store';
import {publicRecord,publicRecords,putPublicRecord,stableHash} from './public-schema';
import {natural,validatePrice,priceModelUsage,quoteModelCost,type Money,type CostQuote,type ModelUsage} from './model-usage';
export type BudgetLimits={currency:Money['currency'];perRun:number;perDay:number;perMonth:number};
export type BudgetReservation={runId:string;clientId:string;quote:CostQuote;state:'reserved'|'settled'|'unknown'|'released';phase:'reserved'|'started';createdAt:string;charged:Money|null;settlement:BudgetSettlement|null;reconciliation?:{checkedAt:string;note:string}};
export type ModelBillingOutcome={state:'not-started'|'completed'|'unknown';usage:ModelUsage|null};
export type BudgetSettlement={runId:string;charged:Money|null;reserved:Money|null;costStatus:'priced'|'unknown'};
export function validateLimits(v:any):asserts v is BudgetLimits{
 if(!v||!['USD','EUR'].includes(v.currency)||!natural(v.perRun)||!natural(v.perDay)||!natural(v.perMonth)||Object.keys(v).some(k=>!['currency','perRun','perDay','perMonth'].includes(k)))throw new AppError('Budgetgrenzen ungültig.');
}
export function validateReservation(v:any){
 if(!v||!/^[a-f0-9-]{36}$/.test(v.runId)||!/^[a-f0-9-]{36}$/.test(v.clientId)||!['reserved','settled','unknown','released'].includes(v.state)||!['reserved','started'].includes(v.phase)||
 !Number.isFinite(Date.parse(v.createdAt))||!v.quote||v.quote.status!=='bounded'||!/^[a-f0-9]{64}$/.test(v.quote.bindingHash)||
 !v.quote.maximum||!['USD','EUR'].includes(v.quote.maximum.currency)||!natural(v.quote.maximum.micros)||!v.quote.prices||
 v.charged!==null&&(!['USD','EUR'].includes(v.charged.currency)||!natural(v.charged.micros)))throw new AppError('Kostenreservierung ungültig.');
 validatePrice(v.quote.prices);
 if(v.quote.priceVersion!==v.quote.prices.version||v.quote.maximum.currency!==v.quote.prices.currency||!natural(v.quote.bounds?.inputUpperBound)||!natural(v.quote.bounds?.outputUpperBound))throw new AppError('Kostenquote ungültig.');
 const p=v.quote.prices,recomputed=quoteModelCost({provider:p.provider,protocol:p.protocol,model:p.model,hash:v.quote.bindingHash,maxOutputTokens:v.quote.bounds.outputUpperBound} as any,v.quote.bounds,p);
 if(stableHash(recomputed)!==stableHash(v.quote)||new Date(v.createdAt).toISOString()!==v.createdAt)throw new AppError('Kostenquote oder Zeitpunkt widersprüchlich.');
 if(['settled','released'].includes(v.state)){
  if(!v.charged||v.charged.currency!==p.currency||v.state==='released'&&v.charged.micros!==0||stableHash(v.settlement)!==stableHash({runId:v.runId,charged:v.charged,reserved:null,costStatus:'priced'}))throw new AppError('Kostenabschluss widersprüchlich.');
 }else if(v.charged!==null||v.settlement!==null&&stableHash(v.settlement)!==stableHash({runId:v.runId,charged:null,reserved:v.quote.maximum,costStatus:'unknown'}))throw new AppError('Ungeklärte Kosten widersprüchlich.');
 if(v.reconciliation!==undefined){const a=v.reconciliation;if(v.state!=='settled'||!a||typeof a.note!=='string'||a.note.trim().length<8||a.note.length>500||!Number.isFinite(Date.parse(a.checkedAt))||new Date(a.checkedAt).toISOString()!==a.checkedAt||Object.keys(a).some(k=>!['checkedAt','note'].includes(k)))throw new AppError('Kostenabgleich ungültig.');}
 if(Object.keys(v).some(k=>!['runId','clientId','quote','state','phase','createdAt','charged','settlement','reconciliation'].includes(k)))throw new AppError('Unbekanntes Kostenfeld.');
}
export function reconcileModelBudget(s:Store,input:any){return s.transaction(()=>{
 if(!input||Object.keys(input).some(k=>!['runId','revision','currency','micros','note','confirmed'].includes(k))||input.confirmed!==true||typeof input.runId!=='string'||!natural(input.revision)||!natural(input.micros)||typeof input.note!=='string'||input.note.trim().length<8||input.note.length>500)throw new AppError('Betrag und geprüften Abrechnungsnachweis bestätigen.');
 const r=publicRecord(s,'model-run',input.runId);
 if(!r||r.content.state!=='unknown')throw new AppError('Nur ungeklärte Kosten können abgeglichen werden.',409);
 if(r.revision!==input.revision)throw new AppError('Kostenauftrag geändert. Bitte neu laden.',409);
 if(input.currency!==r.content.quote.maximum.currency)throw new AppError('Währung stimmt nicht mit dem Auftrag überein.');
 const charged={currency:input.currency,micros:input.micros};
 r.content={...r.content,state:'settled',charged,settlement:{runId:r.id,charged,reserved:null,costStatus:'priced'},reconciliation:{checkedAt:new Date().toISOString(),note:input.note.trim()}};
 r.revision++;putPublicRecord(s,r);return r;
});}
export function setModelBudget(s:Store,v:BudgetLimits){validateLimits(v);return s.transaction(()=>{const old=publicRecord(s,'budget',v.currency);putPublicRecord(s,{kind:'budget',id:v.currency,clientId:null,revision:(old?.revision||0)+1,content:v});return v;});}
export function modelSpending(s:Store,currency:Money['currency'],at=new Date()){
 const runs=publicRecords(s,'model-run').map(r=>r.content as BudgetReservation).filter(r=>r.quote.maximum?.currency===currency),day=at.toISOString().slice(0,10),month=day.slice(0,7);
 const held=(r:BudgetReservation)=>['reserved','unknown'].includes(r.state)?r.quote.maximum!.micros:0;
 const spent=(r:BudgetReservation)=>r.state==='settled'?r.charged?.micros||0:0;
 return {held:runs.reduce((n,r)=>n+held(r),0),spent:runs.reduce((n,r)=>n+spent(r),0),
 day:runs.reduce((n,r)=>n+held(r)+(r.createdAt.startsWith(day)?spent(r):0),0),
 month:runs.reduce((n,r)=>n+held(r)+(r.createdAt.startsWith(month)?spent(r):0),0)};
}
export function reserveModelBudgetWithinTransaction(s:Store,runId:string,clientId:string,quote:CostQuote):BudgetReservation{
 s.client(clientId);
 if(publicRecord(s,'model-run',runId))throw new AppError('Kostenauftrag bereits reserviert.',409);
 if(quote.status!=='bounded'||!quote.maximum||!quote.prices)throw new AppError('Preis oder belastbare Kostenobergrenze fehlt.');
 const limit=publicRecord(s,'budget',quote.maximum.currency)?.content as BudgetLimits|undefined;
 if(!limit)throw new AppError('Bitte zuerst ein Modellbudget einrichten.');
 const use=modelSpending(s,quote.maximum.currency),cost=quote.maximum.micros;
 if(cost>limit.perRun||cost>limit.perDay-use.day||cost>limit.perMonth-use.month)throw new AppError('Modellbudget reicht für diese Reservierung nicht.');
 const content:BudgetReservation={runId,clientId,quote:structuredClone(quote),state:'reserved',phase:'reserved',createdAt:new Date().toISOString(),charged:null,settlement:null};
 putPublicRecord(s,{kind:'model-run',id:runId,clientId,revision:1,content});return content;
}
export function reserveModelBudget(s:Store,runId:string,clientId:string,quote:CostQuote){return s.transaction(()=>reserveModelBudgetWithinTransaction(s,runId,clientId,quote));}
export function markModelStartedWithinTransaction(s:Store,id:string){
 const r=publicRecord(s,'model-run',id);
 if(!r||r.content.state!=='reserved'||r.content.phase!=='reserved')throw new AppError('Modellauftrag bereits gestartet oder ungeklärt.',409);
 r.content.phase='started';r.revision++;putPublicRecord(s,r);
}
export function markModelStarted(s:Store,id:string){return s.transaction(()=>markModelStartedWithinTransaction(s,id));}
export function settleModelBudget(s:Store,runId:string,outcome:ModelBillingOutcome){return s.transaction(()=>{
 const r=publicRecord(s,'model-run',runId);if(!r)throw new AppError('Kostenauftrag fehlt.');
 const v=r.content as BudgetReservation;if(v.settlement&&['settled','released'].includes(v.state))return v.settlement;
 if(!['not-started','completed','unknown'].includes(outcome.state))throw new AppError('Ungültiger Kostenabschluss.');
 let charged:Money|null=null,state:BudgetReservation['state']='unknown';
 if(outcome.state==='not-started'&&v.phase==='reserved'){charged={currency:v.quote.maximum!.currency,micros:0};state='released';}
 else if(outcome.state==='completed'&&outcome.usage&&v.phase==='started'){charged=priceModelUsage(outcome.usage,v.quote.prices!);if(charged)state='settled';}
 const settlement:BudgetSettlement={runId,charged,reserved:state==='unknown'?v.quote.maximum:null,costStatus:charged?'priced':'unknown'};
 r.content={...v,state,charged,settlement};r.revision++;putPublicRecord(s,r);return settlement;
});}

import {normalizeModelUsage as normalize} from '../electron/model-usage.cjs';
import {AppError} from './store';
import type {ModelBinding,ModelProtocol} from './model-profiles';
export type ModelUsage={inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;reasoningTokens:number|null;raw:Record<string,unknown>};
export type Money={currency:'USD'|'EUR';micros:number};
export type TokenBounds={inputUpperBound:number|null;outputUpperBound:number};
export type PriceSchedule={version:string;provider:ModelBinding['provider'];protocol:ModelProtocol;model:string;currency:Money['currency'];inputMicrosPerMillion:number;outputMicrosPerMillion:number;cachedInputMicrosPerMillion:number|null;reasoningMicrosPerMillion:number|null;source:string;checkedAt:string};
export type CostQuote={bindingHash:string;priceVersion:string|null;maximum:Money|null;status:'bounded'|'unknown';prices:PriceSchedule|null;bounds:TokenBounds};
export const natural=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
export function normalizeModelUsage(protocol:ModelProtocol,raw:unknown):ModelUsage{return normalize(protocol,raw);}
export function validatePrice(p:any):asserts p is PriceSchedule{
 if(!p||typeof p.version!=='string'||!p.version||p.version.length>120||!['USD','EUR'].includes(p.currency)||
 !['openai','gemini','anthropic','custom'].includes(p.provider)||!['openai-responses','gemini-generate-content','anthropic-messages','openai-chat-completions'].includes(p.protocol)||
 typeof p.model!=='string'||!p.model||p.model.length>160||!natural(p.inputMicrosPerMillion)||!natural(p.outputMicrosPerMillion)||
 p.cachedInputMicrosPerMillion!==null&&!natural(p.cachedInputMicrosPerMillion)||p.reasoningMicrosPerMillion!==null&&!natural(p.reasoningMicrosPerMillion)||
 typeof p.source!=='string'||p.source.length>2000||!/^https:\/\//.test(p.source)||typeof p.checkedAt!=='string'||!Number.isFinite(Date.parse(p.checkedAt))||
 Object.keys(p).some(k=>!['version','provider','protocol','model','currency','inputMicrosPerMillion','outputMicrosPerMillion','cachedInputMicrosPerMillion','reasoningMicrosPerMillion','source','checkedAt'].includes(k)))throw new AppError('Preisstand ist ungültig.');
}
function total(parts:[number,number][]):number|null{
 const sum=parts.reduce((s,[n,rate])=>s+BigInt(n)*BigInt(rate),0n),micros=(sum+999999n)/1000000n;
 return micros<=BigInt(Number.MAX_SAFE_INTEGER)?Number(micros):null;
}
export function quoteModelCost(binding:ModelBinding,bounds:TokenBounds,prices:PriceSchedule|null):CostQuote{
 if(prices)validatePrice(prices);
 if(bounds.inputUpperBound!==null&&!natural(bounds.inputUpperBound)||!natural(bounds.outputUpperBound)||bounds.outputUpperBound<binding.maxOutputTokens)throw new AppError('Ungültige Tokenobergrenze.');
 const matches=prices&&prices.provider===binding.provider&&prices.protocol===binding.protocol&&prices.model===binding.model;
 const amount=matches&&bounds.inputUpperBound!==null?total([[bounds.inputUpperBound,Math.max(prices.inputMicrosPerMillion,prices.cachedInputMicrosPerMillion||0)],[bounds.outputUpperBound,Math.max(prices.outputMicrosPerMillion,prices.reasoningMicrosPerMillion||0)]]):null;
 return {bindingHash:binding.hash,priceVersion:prices?.version||null,maximum:amount===null?null:{currency:prices!.currency,micros:amount},status:amount===null?'unknown':'bounded',prices:prices?structuredClone(prices):null,bounds:{...bounds}};
}
export function priceModelUsage(u:ModelUsage,p:PriceSchedule):Money|null{
 if(!u||!natural(u.inputTokens)||!natural(u.outputTokens))return null;
 if(p.protocol==='anthropic-messages'&&Number(u.raw.cache_creation_input_tokens||0)>0)return null;
 const cached=u.cachedInputTokens,reasoning=u.reasoningTokens;
 if(cached!==null&&(!natural(cached)||cached>u.inputTokens)||reasoning!==null&&(!natural(reasoning)||reasoning>u.outputTokens))return null;
 if(p.cachedInputMicrosPerMillion!==null&&cached===null||p.reasoningMicrosPerMillion!==null&&reasoning===null)return null;
 const c=cached||0,r=reasoning||0;
 if(c>0&&p.cachedInputMicrosPerMillion===null)return null;
 const micros=total([[u.inputTokens-c,p.inputMicrosPerMillion],[c,p.cachedInputMicrosPerMillion??p.inputMicrosPerMillion],[u.outputTokens-r,p.outputMicrosPerMillion],[r,p.reasoningMicrosPerMillion??p.outputMicrosPerMillion]]);
 return micros===null?null:{currency:p.currency,micros};
}

import { AppError } from './store';
import { createHash } from 'node:crypto';
export type Provider = 'openai' | 'gemini';
export type Route = { provider: Provider; model: string };
export type Source = { id: string; url: string; title: string; text: string; capturedAt: string; hash: string; reviewed: boolean; kind: 'website' | 'manual' };
export type Rules = { offer: string; targets: string; personas: string; exclusions: string; claims: string; forbidden: string; firstStyle: string; followStyle: string; signalStyle: string; goal: string; dailyLimit: number; maxTouches: number; minGapDays: number; companyCap: number; aiDailyLimit: number };
export type Brief = { sources: Source[]; rules: Rules; routes: { analysis: Route; writing: Route } };
export type BriefRecord = { clientId: string; revision: number; content: Brief; approvedAt: string | null; approvedClientVersion: number | null; updatedAt: string };
export type AIRun = { id: string; clientId: string; purpose: 'analysis' | 'writing' | 'knowledge' | 'campaign-writing' | 'reply-analysis' | 'reply-writing'; provider: Provider | 'anthropic' | 'custom'; model: string; revision: number; clientVersion: number; status: string; context: string; result: string; usage: string; createdAt: string; review: string };
export const emptyBrief = (): Brief => ({ sources: [], rules: { offer:'', targets:'', personas:'', exclusions:'', claims:'', forbidden:'Keine erfundenen Referenzen, Zahlen, Garantien oder persönliche Bekanntschaft.', firstStyle:'Direkt, konkret, kurz. Keine Floskeln. Eine klare Frage.', followStyle:'Neuer konkreter Nutzen statt bloßer Erinnerung.', signalStyle:'Öffnungen sind unsichere Signale. Keine Behauptung, dass jemand gelesen hat.', goal:'Ein qualifiziertes Erstgespräch.', dailyLimit:20, maxTouches:3, minGapDays:3, companyCap:2, aiDailyLimit:20 }, routes: { analysis:{provider:'openai',model:''}, writing:{provider:'openai',model:''} } });
export function validateRoute(route: any): Route {
  if (!route || !['openai','gemini'].includes(route.provider) || typeof route.model!=='string' || !/^[a-zA-Z0-9._:-]{0,120}$/.test(route.model)) throw new AppError('Anbieter oder Modellkennung ist ungültig.');
  return {provider:route.provider,model:route.model};
}
export function validateRules(input: any): Rules {
  if (!input || typeof input !== 'object') throw new AppError('Betriebsrahmen fehlt.');
  const output:any={};
  for(const key of ['offer','targets','personas','exclusions','claims','forbidden','firstStyle','followStyle','signalStyle','goal']) {
    if(typeof input[key]!=='string'||input[key].length>4000||input[key].includes('\0')) throw new AppError('Ein Textfeld ist ungültig oder zu lang (maximal 4.000 Zeichen).');
    output[key]=input[key].trim();
  }
  for(const [key,max] of [['dailyLimit',500],['maxTouches',10],['minGapDays',90],['companyCap',20],['aiDailyLimit',100]] as const) {
    if(!Number.isInteger(input[key])||input[key]<1||input[key]>max)throw new AppError(`Ungültige Grenze: ${key} (1–${max}).`);
    output[key]=input[key];
  }
  return output;
}
export function validateBrief(input: any): Brief {
  if(!input||!Array.isArray(input.sources)||input.sources.length>12)throw new AppError('Ungültiges Kundenwissen.');
  const ids=new Set();
  for(const s of input.sources){
    if(!s||typeof s.id!=='string'||!/^[a-f0-9-]{36}$/.test(s.id)||ids.has(s.id)||!['website','manual'].includes(s.kind)||typeof s.reviewed!=='boolean'||typeof s.url!=='string'||s.url.length>2000||typeof s.title!=='string'||s.title.length>160||typeof s.text!=='string'||!s.text.trim()||s.text.length>12000||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash)||!Number.isFinite(Date.parse(s.capturedAt)))throw new AppError('Ungültiger Quellennachweis.');
    if(s.url){try{const url=new URL(s.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error();}catch{throw new AppError('Ungültige Quellenadresse.');}}
    ids.add(s.id);
    if(createHash('sha256').update(s.text).digest('hex')!==s.hash)throw new AppError('Quelleninhalt stimmt nicht mit dem gespeicherten Nachweis überein.');
  }
  return {sources:input.sources,rules:validateRules(input.rules),routes:{analysis:validateRoute(input.routes?.analysis),writing:validateRoute(input.routes?.writing)}};
}
export function approvalProblems(brief: Brief,publicMode=false) {
  const missing:string[]=[];
  for(const [key,label] of [['offer','Angebot'],['targets','Zielunternehmen'],['personas','Personas'],['claims','Erlaubte Aussagen'],['firstStyle','Erstmail-Stil'],['goal','Ziel']] as const) if(!brief.rules[key].trim())missing.push(label);
  if(!brief.sources.some(s=>s.reviewed))missing.push('mindestens eine geprüfte Quelle');
  if(!publicMode&&(!brief.routes.analysis.model||!brief.routes.writing.model))missing.push('Modellkennungen für beide Aufgaben');
  return missing;
}

import {cleanText,exactObject} from './interpretation-input';
import {knowledgeUuid} from './knowledge-input';
export type PersonaContent={code:string;name:string;responsibility:string;titles:string[]};
export type HypothesisContent={name:string;personaId:string;segment:string;pain:string;angle:string;benefit:string;cta:string;style:string;knowledgeIds:string[]};
export const normalizeTitle=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US');
export function personaContent(v:any):PersonaContent{
  exactObject(v,['code','name','responsibility','titles']);
  if(typeof v.code!=='string'||! /^[A-Z][A-Z0-9_]{1,59}$/.test(v.code)||!Array.isArray(v.titles)||v.titles.length<1||v.titles.length>30)throw new Error('Persona-Code oder Jobtitel ungültig.');
  const titles=v.titles.map((t:unknown)=>cleanText(t,160));
  if(new Set(titles.map(normalizeTitle)).size!==titles.length)throw new Error('Doppelte Jobtitel in einer Persona.');
  return {code:v.code,name:cleanText(v.name,160),responsibility:cleanText(v.responsibility,3000),titles};
}
export function hypothesisContent(v:any):HypothesisContent{
  exactObject(v,['name','personaId','segment','pain','angle','benefit','cta','style','knowledgeIds']);
  if(!knowledgeUuid(v.personaId)||!Array.isArray(v.knowledgeIds)||v.knowledgeIds.length<1||v.knowledgeIds.length>20||v.knowledgeIds.some((id:unknown)=>!knowledgeUuid(id))||new Set(v.knowledgeIds).size!==v.knowledgeIds.length)throw new Error('Personaversion oder Wissensauswahl ungültig.');
  return {name:cleanText(v.name,160),personaId:v.personaId,segment:cleanText(v.segment,2000),pain:cleanText(v.pain,2000),angle:cleanText(v.angle,1000),benefit:cleanText(v.benefit,2000),cta:cleanText(v.cta,1000),style:cleanText(v.style,2000),knowledgeIds:[...v.knowledgeIds].sort()};
}
export function matchPersonaTitle(title:string,personas:{id:string;content:PersonaContent}[]){
  const value=cleanText(title,160),matches=personas.filter(p=>p.content.titles.some(t=>normalizeTitle(t)===normalizeTitle(value))).map(p=>({id:p.id,code:p.content.code,name:p.content.name}));
  return {title:value,status:matches.length===1?'matched':matches.length?'ambiguous':'unknown',matches};
}

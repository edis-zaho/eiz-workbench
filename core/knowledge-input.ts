import {cleanText,exactObject} from './interpretation-input';

export const knowledgeCategories=['feature','benefit','use_case','proof','objection','hypothesis'] as const;
export type SourceContent={title:string;locator:string;capturedAt:string;text:string;withdrawn:boolean};
export type ClaimContent={category:typeof knowledgeCategories[number];text:string;sourceId:string;quote:string};
export const knowledgeUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function knowledgeDate(v:unknown):v is string {return typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
export function sourceContent(v:any):SourceContent {
  exactObject(v,['title','locator','capturedAt','text','withdrawn']);
  const title=cleanText(v.title,200),locator=cleanText(v.locator,2000),text=cleanText(v.text,20000);
  if(!knowledgeDate(v.capturedAt)||typeof v.withdrawn!=='boolean')throw new Error('Quellenzeitpunkt oder Status ungültig.');
  if(/^[a-z][a-z0-9+.-]*:/i.test(locator)) {
    const u=new URL(locator);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('Nur HTTP(S)-Fundstellen ohne Zugangsdaten sind erlaubt.');
  }
  return {title,locator,capturedAt:v.capturedAt,text,withdrawn:v.withdrawn};
}
export function claimContent(v:any):ClaimContent {
  exactObject(v,['category','text','sourceId','quote']);
  if(!knowledgeCategories.includes(v.category)||!knowledgeUuid(v.sourceId))throw new Error('Kategorie oder Quellenreferenz ungültig.');
  return {category:v.category,text:cleanText(v.text,3000),sourceId:v.sourceId,quote:cleanText(v.quote,3000)};
}

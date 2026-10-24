import {AppError,type Store} from './store';
import {strategyState} from './strategy';
import type {CampaignContent} from './campaign';
import type {BackupData} from './types';
import type {HypothesisContent,PersonaContent} from './strategy-input';

// Resolve the fixed version, never silently substitute the latest hypothesis.
export function campaignStrategy(s:Store,clientId:string,content:CampaignContent){
  if(!content.hypothesisId)return null;
  if(!content.productRef)throw new AppError('Produktbindung für die Kampagnenhypothese fehlt.');
  const state=strategyState(s,clientId,content.productRef.productId);
  const row=state.rows.find(r=>r.id===content.hypothesisId);
  if(!row||row.kind!=='hypothesis'||row.state!=='approved'||row.productRevision!==content.productRef.revision)throw new AppError('Hypothesenbezug enthält keine passende freigegebene Produktstrategie.');
  const hypothesis=row.content as HypothesisContent;
  const persona=state.rows.find(r=>r.id===hypothesis.personaId&&r.kind==='persona'&&r.state==='approved');
  if(!persona)throw new AppError('Personaversion der Kampagnenhypothese fehlt.');
  if(hypothesis.knowledgeIds.some(id=>!content.knowledgeIds?.includes(id)))throw new AppError('Alle Produktfakten der Hypothese müssen im Kampagnenwissen enthalten sein.');
  const latest=state.items.find(r=>r.entityId===row.entityId);
  const inactiveReason=latest?.id!==row.id?'Hypothese inzwischen geändert':latest.inactiveReason;
  return {id:row.id,entityId:row.entityId,revision:row.revision,content:hypothesis,persona:{id:persona.id,revision:persona.revision,content:persona.content as PersonaContent},usable:!inactiveReason,inactiveReason};
}

export function checkCampaignStrategy(s:Store,clientId:string,content:CampaignContent){
  const hypothesis=campaignStrategy(s,clientId,content);
  if(hypothesis&&!hypothesis.usable)throw new AppError('Kampagnenhypothese ist nicht mehr aktuell freigegeben. Auswahl neu prüfen.',409);
}

export function validateCampaignStrategyBackup(data:BackupData,version:number){
  const index=new Map((data.strategies||[]).map(r=>[r.id,r]));
  function check(clientId:string,content:CampaignContent){
    if(content.hypothesisId===undefined)return;
    const row=index.get(content.hypothesisId);
    if(version<16||!row||row.kind!=='hypothesis'||row.state!=='approved'||row.clientId!==clientId||row.productId!==content.productRef?.productId||row.productRevision!==content.productRef?.revision)throw new AppError('Ungültiger Hypothesenbezug in Kampagne, Historie oder Versandlauf.');
    const hypothesis=JSON.parse(row.content) as HypothesisContent;
    if(hypothesis.knowledgeIds.some(id=>!content.knowledgeIds?.includes(id)))throw new AppError('Hypothesenbezug ohne vollständige Faktenbasis in der Sicherung.');
  }
  for(const row of [...data.campaigns||[],...data.campaignHistory||[]])check(row.clientId,JSON.parse(row.content));
  const approvals=new Map<string,string[]>();
  for(const row of data.campaignHistory||[])if(row.action==='approved'){
    const key=row.clientId+':'+row.campaignId+':'+row.fingerprint;
    const values=approvals.get(key)||[];values.push(JSON.parse(row.content).hypothesisId||'');approvals.set(key,values);
  }
  for(const row of data.queueRuns||[]){
    const content:CampaignContent=JSON.parse(row.snapshot).content;check(row.clientId,content);
    const approved=approvals.get(row.clientId+':'+row.campaignId+':'+row.fingerprint)||[];
    // Also detect removal of a binding from a previously approved run.
    if((content.hypothesisId||approved.some(Boolean))&&!approved.includes(content.hypothesisId||''))throw new AppError('Hypothesenbezug des Versandlaufs weicht von seiner Freigabe ab.');
  }
}

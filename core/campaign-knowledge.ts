import {AppError,type Store} from './store';
import {knowledgeState} from './knowledge';
import type {CampaignContent} from './campaign';
import type {BackupData} from './types';
import type {ClaimContent,SourceContent} from './knowledge-input';

export function campaignKnowledge(s:Store,clientId:string,content:CampaignContent) {
  if(!content.knowledgeIds?.length)return [];
  if(!content.productRef)throw new AppError('Produktbindung für Kampagnenwissen fehlt.');
  const state=knowledgeState(s,clientId,content.productRef.productId);
  return content.knowledgeIds.map(id=>{
    const row=state.rows.find(r=>r.id===id),latest=state.items.find(r=>r.entityId===row?.entityId);
    if(!row||row.kind!=='claim'||row.state!=='approved'||row.productRevision!==content.productRef!.revision||(row.content as ClaimContent).category==='hypothesis')throw new AppError('Kampagnenwissen enthält keine passende freigegebene Produktfakt-Version.');
    const claim=row.content as ClaimContent,source=state.rows.find(r=>r.id===claim.sourceId);
    if(!source||source.kind!=='source')throw new AppError('Belegquelle des Kampagnenwissens fehlt.');
    const inactiveReason=latest?.id!==row.id?'Aussage inzwischen geändert':latest.inactiveReason;
    return {id:row.id,entityId:row.entityId,revision:row.revision,category:claim.category,text:claim.text,quote:claim.quote,sourceId:source.id,sourceTitle:(source.content as SourceContent).title,locator:(source.content as SourceContent).locator,usable:!inactiveReason,inactiveReason};
  });
}
export function checkCampaignKnowledge(s:Store,clientId:string,content:CampaignContent){
  const rows=campaignKnowledge(s,clientId,content);
  if(rows.some(r=>!r.usable))throw new AppError('Kampagnenwissen ist nicht mehr aktuell freigegeben. Auswahl neu prüfen.',409);
}
export function validateCampaignKnowledgeBackup(data:BackupData,version:number){
  const index=new Map((data.knowledge||[]).map(r=>[r.id,r]));
  function check(clientId:string,content:CampaignContent){
    for(const id of content.knowledgeIds||[]){
      const row=index.get(id);
      if(version<14||!row||row.kind!=='claim'||row.state!=='approved'||row.clientId!==clientId||row.productId!==content.productRef?.productId||row.productRevision!==content.productRef?.revision||JSON.parse(row.content).category==='hypothesis')throw new AppError('Ungültiger Wissensbezug in Kampagne, Historie oder Versandlauf.');
    }
  }
  for(const row of [...data.campaigns||[],...data.campaignHistory||[]])check(row.clientId,JSON.parse(row.content));
  for(const row of data.queueRuns||[]){
    const content:CampaignContent=JSON.parse(row.snapshot).content;check(row.clientId,content);
    const approvals=(data.campaignHistory||[]).filter(h=>h.campaignId===row.campaignId&&h.clientId===row.clientId&&h.action==='approved'&&h.fingerprint===row.fingerprint);
    if((content.knowledgeIds?.length||approvals.some(h=>JSON.parse(h.content).knowledgeIds?.length))&&!approvals.some(h=>JSON.stringify(JSON.parse(h.content).knowledgeIds)===JSON.stringify(content.knowledgeIds)))throw new AppError('Wissensbezug des Versandlaufs weicht von seiner Freigabe ab.');
  }
}

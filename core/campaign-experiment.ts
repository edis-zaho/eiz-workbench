import {AppError,type Store} from './store';
import {exportExperiments,experimentState,type ExperimentRow} from './experiments';
import {matchesExperimentCampaign,type ExperimentContent} from './experiment-input';
import {catalogState} from './catalog';
import type {CampaignContent} from './campaign';
import type {BackupData} from './types';

function binding(c:CampaignContent){return c.experimentId?`${c.experimentId}:${c.hypothesisId}`:'';}
function matching(row:ExperimentRow|undefined,clientId:string,c:CampaignContent):boolean{
  return !!row&&row.clientId===clientId&&row.productId===c.productRef?.productId&&matchesExperimentCampaign(row.experimentId,JSON.parse(row.content),c);
}
export function campaignExperiment(s:Store,clientId:string,c:CampaignContent){
  if(!c.experimentId)return null;
  const row=exportExperiments(s).find(r=>r.experimentId===c.experimentId&&r.revision===1);
  if(!row||!matching(row,clientId,c))throw new AppError('Experimentbindung passt nicht zu Produkt, Testarm oder vollständiger Kontaktzuteilung.');
  const state=experimentState(s,clientId,row.productId).items.find(r=>r.experimentId===row.experimentId)!;
  const content:ExperimentContent=JSON.parse(row.content);
  return {id:row.experimentId,planVersionId:row.id,name:content.input.name,hypothesisId:c.hypothesisId!,state:state.state,
    companies:content.allocation.groups.filter(g=>g.hypothesisId===c.hypothesisId).length,contacts:c.leadIds.length,
    problems:state.state==='closed'?['Experimentplan ist geschlossen.']:state.problems};
}

// Reservations also apply to unbound campaigns. Frozen contact identities cannot
// be freed by unlinking them after allocation. Domain matching is exact, not inferred.
export function experimentReservationProblems(s:Store,clientId:string,c:CampaignContent){
  const rows=exportExperiments(s).filter(r=>r.clientId===clientId),closed=new Set(rows.filter(r=>r.state==='closed').map(r=>r.experimentId));
  const plans=rows.filter(r=>r.revision===1&&!closed.has(r.experimentId)&&!matching(r,clientId,c));
  if(!plans.length)return [];
  const catalog=catalogState(s,clientId),links=new Map(catalog.links.map(r=>[String(r.leadId),String(r.accountId)])),accounts=new Map(catalog.accounts.map(r=>[String(r.accountId),String(r.domain)]));
  const contacts=c.leadIds.map(id=>({id,accountId:links.get(id)||'',email:String(s.db.prepare('SELECT email FROM leads WHERE clientId=? AND id=?').get(clientId,id)?.email||'')}));
  return plans.filter(r=>{
    const p:ExperimentContent=JSON.parse(r.content),ids=new Set(p.allocation.groups.map(g=>g.accountId));
    const frozen=p.contacts.filter(t=>!!t.accountId&&ids.has(t.accountId)),leads=new Set(frozen.map(t=>t.leadId));
    const domains=new Set(frozen.map(t=>t.domain).filter(Boolean));
    for(const id of ids){const domain=accounts.get(id);if(domain)domains.add(domain);}
    return contacts.some(t=>leads.has(t.id)||ids.has(t.accountId)||domains.has(accounts.get(t.accountId)||'')||domains.has(t.email.split('@')[1]?.toLowerCase()||''));
  }).map(r=>`Unternehmen für Experiment „${(JSON.parse(r.content) as ExperimentContent).input.name}“ reserviert. Den zugeteilten Testarm verwenden.`);
}

export function checkCampaignExperiment(s:Store,clientId:string,c:CampaignContent,campaignId?:string){
  const state=campaignExperiment(s,clientId,c);
  const problems=[...state?.problems||[],...experimentReservationProblems(s,clientId,c)];
  if(problems.length)throw new AppError(problems.join(' '),409);
  const history=s.db.prepare('SELECT campaignId,content FROM campaign_history WHERE clientId=?').all(clientId);
  for(const h of history){const old:CampaignContent=JSON.parse(String(h.content));
    if(h.campaignId===campaignId&&old.experimentId&&binding(old)!==binding(c))throw new AppError('Eine gespeicherte Experimentbindung bleibt fest. Für einen neuen Vergleich einen neuen Experimentplan verwenden.',409);
    if(c.experimentId&&h.campaignId!==campaignId&&binding(old)===binding(c))throw new AppError('Dieser Testarm besitzt bereits eine Kampagne. Die bestehende Kampagne öffnen.',409);
  }
}

export function validateCampaignExperimentBackup(data:BackupData,version:number){
  const plans=new Map((data.experiments||[]).filter(r=>r.revision===1).map(r=>[r.experimentId,r]));
  const owners=new Map<string,string>();
  function check(clientId:string,campaignId:string,c:CampaignContent){
    if(!c.experimentId)return;
    if(version<18||!matching(plans.get(c.experimentId),clientId,c))throw new AppError('Ungültige Experimentbindung in Kampagne, Historie oder Versandlauf.');
    const key=clientId+':'+binding(c),old=owners.get(key);if(old&&old!==campaignId)throw new AppError('Ein Experimentarm gehört zu mehreren Kampagnen.');owners.set(key,campaignId);
  }
  const histories=data.campaignHistory||[];
  for(const row of histories)check(row.clientId,row.campaignId,JSON.parse(row.content));
  for(const row of data.campaigns||[]){
    const c:CampaignContent=JSON.parse(row.content);check(row.clientId,row.id,c);
    if(histories.some(h=>h.clientId===row.clientId&&h.campaignId===row.id&&JSON.parse(h.content).experimentId&&binding(JSON.parse(h.content))!==binding(c)))throw new AppError('Gespeicherte Experimentbindung wurde entfernt oder gewechselt.');
  }
  for(const row of data.queueRuns||[]){
    const c:CampaignContent=JSON.parse(row.snapshot).content;check(row.clientId,row.campaignId,c);
    const approvals=histories.filter(h=>h.clientId===row.clientId&&h.campaignId===row.campaignId&&h.fingerprint===row.fingerprint&&h.action==='approved').map(h=>binding(JSON.parse(h.content)));
    if((c.experimentId||approvals.some(Boolean))&&!approvals.includes(binding(c)))throw new AppError('Experimentbindung des Versandlaufs weicht von seiner Freigabe ab.');
  }
}

import type {CampaignContent} from './campaign';
import {createHash} from 'node:crypto';
import {cleanText,exactObject} from './interpretation-input';
import {knowledgeUuid} from './knowledge-input';
import {normalizeTitle,type PersonaContent} from './strategy-input';

export type ExperimentInput={name:string;seed:string;productRevision:number;hypothesisIds:string[];leadIds:string[]};
export type ExperimentContact={leadId:string;role:string;blocked:boolean;linkId:string|null;accountId:string|null;accountRevision:number|null;company:string;domain:string};
export type ExperimentArm={id:string;personaId:string;persona:PersonaContent};
export type ExperimentGroup={accountId:string;hypothesisId:string;leadIds:string[]};
export type Allocation={groups:ExperimentGroup[];held:{leadId:string;reason:string}[]};
export type ExperimentContent={algorithm:'company-balanced-v1';input:ExperimentInput;contacts:ExperimentContact[];allocation:Allocation};
export const experimentHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function experimentInput(v:any):ExperimentInput{
  exactObject(v,['name','seed','productRevision','hypothesisIds','leadIds']);
  if(!Number.isSafeInteger(v.productRevision)||v.productRevision<1)throw new Error('Ungültige Produktversion.');
  for(const [key,min,max] of [['hypothesisIds',2,4],['leadIds',1,1000]] as const){
    if(!Array.isArray(v[key])||v[key].length<min||v[key].length>max||v[key].some((id:unknown)=>!knowledgeUuid(id))||new Set(v[key]).size!==v[key].length)throw new Error('Zwei bis vier eindeutige Hypothesen und 1–1.000 eindeutige Kontakte auswählen.');
  }
  return {name:cleanText(v.name,160),seed:cleanText(v.seed,80),productRevision:v.productRevision,hypothesisIds:[...v.hypothesisIds].sort(),leadIds:[...v.leadIds].sort()};
}
// Common eligibility pool avoids assigning IT-only companies to a sales-persona arm.
// Balance is by companies, not contacts. Seed and algorithm are frozen with the plan.
export function allocateCompanies(seed:string,contacts:ExperimentContact[],arms:ExperimentArm[]):Allocation{
  const personas=[...new Map(arms.map(a=>[a.personaId,a.persona])).entries()];
  const held=new Map<string,string>(),eligible=new Map<string,Map<string,string[]>>();
  for(const c of contacts){
    if(c.blocked){held.set(c.leadId,'Kontakt gesperrt');continue;}
    if(!c.accountId){held.set(c.leadId,'Keine bestätigte Unternehmenszuordnung');continue;}
    const matches=personas.filter(([,p])=>p.titles.some(t=>normalizeTitle(t)===normalizeTitle(c.role)));
    if(matches.length!==1){held.set(c.leadId,matches.length?'Titel mehrdeutig':'Titel nicht zugeordnet');continue;}
    const byPersona=eligible.get(c.accountId)||new Map<string,string[]>(),ids=byPersona.get(matches[0][0])||[];
    ids.push(c.leadId);byPersona.set(matches[0][0],ids);eligible.set(c.accountId,byPersona);
  }
  const companies=[...eligible.keys()].filter(id=>personas.every(([p])=>eligible.get(id)!.has(p)));
  const order=(id:string)=>experimentHash([seed,id]);
  companies.sort((a,b)=>order(a).localeCompare(order(b))||a.localeCompare(b));
  const sortedArms=[...arms].sort((a,b)=>a.id.localeCompare(b.id));
  const groups=companies.map((id,i)=>({accountId:id,hypothesisId:sortedArms[i%sortedArms.length].id,leadIds:[...eligible.get(id)!.get(sortedArms[i%sortedArms.length].personaId)!].sort()}));
  const selected=new Set(groups.flatMap(g=>g.leadIds));
  const common=new Set(companies);
  for(const c of contacts)if(!selected.has(c.leadId)&&!held.has(c.leadId))held.set(c.leadId,common.has(c.accountId!)?'Andere Persona als zugeteilter Testarm':'Unternehmen hat nicht für jeden Testarm passende Kontakte');
  return {groups,held:[...held].sort(([a],[b])=>a.localeCompare(b)).map(([leadId,reason])=>({leadId,reason}))};
}

// The whole arm is fixed; a caller cannot silently trim inconvenient contacts.
export function matchesExperimentCampaign(id:string,p:ExperimentContent,c:CampaignContent){
  if(c.experimentId!==id||c.productRef?.revision!==p.input.productRevision||!c.hypothesisId||!p.input.hypothesisIds.includes(c.hypothesisId))return false;
  const ids=p.allocation.groups.filter(g=>g.hypothesisId===c.hypothesisId).flatMap(g=>g.leadIds).sort();
  return ids.length>0&&JSON.stringify(ids)===JSON.stringify([...c.leadIds].sort());
}

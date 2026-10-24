import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {strategyState} from './strategy';
import {catalogState} from './catalog';
import {cleanText,exactObject} from './interpretation-input';
import {knowledgeDate,knowledgeUuid} from './knowledge-input';
import {experimentInput,experimentHash,allocateCompanies,matchesExperimentCampaign,type ExperimentContent,type ExperimentContact,type ExperimentArm} from './experiment-input';
import type {BackupData} from './types';
export type ExperimentRow={id:string;clientId:string;productId:string;experimentId:string;revision:number;state:'planned'|'closed';content:string;actor:string;reason:string;createdAt:string};
const columns=['id','clientId','productId','experimentId','revision','state','content','actor','reason','createdAt'] as const;
function bad():never{throw new AppError('Ungültiger Experimentplan oder widersprüchliche Zuteilung.');}
function checked<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof AppError)throw e;throw new AppError(e instanceof Error?e.message:'Ungültiger Experimentplan.');}}
export function migrateExperiments(s:Store){s.db.exec(`CREATE TABLE experiment_versions(
 id TEXT PRIMARY KEY,clientId TEXT NOT NULL,productId TEXT NOT NULL,experimentId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision IN (1,2)),state TEXT NOT NULL CHECK(state IN ('planned','closed')),content TEXT NOT NULL CHECK(json_valid(content)),actor TEXT NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL,
 UNIQUE(experimentId,revision),FOREIGN KEY(productId,clientId) REFERENCES products(id,clientId));
 CREATE INDEX experiment_client ON experiment_versions(clientId,productId);
 CREATE TRIGGER experiment_no_update BEFORE UPDATE ON experiment_versions BEGIN SELECT RAISE(ABORT,'Experiment history cannot be overwritten'); END;
 CREATE TRIGGER experiment_capacity BEFORE INSERT ON experiment_versions WHEN (SELECT COUNT(*) FROM experiment_versions)>=2000 BEGIN SELECT RAISE(ABORT,'Experiment capacity reached'); END;
 PRAGMA user_version=17;`);}
export function exportExperiments(s:Store):ExperimentRow[]{return s.db.prepare('SELECT * FROM experiment_versions ORDER BY id').all() as ExperimentRow[];}
function latest(rows:ExperimentRow[]){const m=new Map<string,ExperimentRow>();for(const r of rows)if((m.get(r.experimentId)?.revision||0)<r.revision)m.set(r.experimentId,r);return [...m.values()];}
function clientPlans(s:Store,clientId:string){return s.db.prepare('SELECT * FROM experiment_versions WHERE clientId=? ORDER BY experimentId,revision').all(clientId) as ExperimentRow[];}
function armsFor(rows:{id:string;kind:string;state:string;productRevision:number;content:any}[],ids:string[],revision:number):ExperimentArm[]{
  return ids.map(id=>{const h=rows.find(r=>r.id===id&&r.kind==='hypothesis'&&r.state==='approved'&&r.productRevision===revision),p=rows.find(r=>r.id===h?.content.personaId&&r.kind==='persona'&&r.state==='approved'&&r.productRevision===revision);if(!h||!p)bad();return {id,personaId:p.id,persona:p.content};});
}
function snapshots(s:Store,clientId:string,ids:string[]):ExperimentContact[]{
  const catalog=catalogState(s,clientId),links=new Map(catalog.links.map(r=>[String(r.leadId),r])),accounts=new Map(catalog.accounts.map(r=>[String(r.accountId),r]));
  const query=s.db.prepare('SELECT role,blocked FROM leads WHERE clientId=? AND id=?');
  return ids.map(leadId=>{const lead=query.get(clientId,leadId);if(!lead)throw new AppError('Ein Kontakt gehört nicht zu diesem Kunden.');const link=links.get(leadId),account=accounts.get(String(link?.accountId));return {leadId,role:String(lead.role),blocked:!!lead.blocked,linkId:link?String(link.id):null,accountId:account?String(account.accountId):null,accountRevision:account?Number(account.revision):null,company:account?String(account.name):'',domain:account?String(account.domain):''};});
}
function conflict(s:Store,clientId:string,accounts:Set<string>,except?:string){
  for(const row of latest(clientPlans(s,clientId)))if(row.state==='planned'&&row.experimentId!==except){const c:ExperimentContent=JSON.parse(row.content);if(c.allocation.groups.some(g=>accounts.has(g.accountId)))return 'Unternehmen ist bereits einem offenen Experimentplan zugeteilt.';}
  const links=new Map(catalogState(s,clientId).links.map(r=>[String(r.leadId),String(r.accountId)]));
  // Closed experiment campaigns cannot be authorized again. Their historical
  // approvedHash must not reserve companies forever; open queues still do.
  const closed=latest(clientPlans(s,clientId)).filter(r=>r.state==='closed');
  const approved=s.db.prepare('SELECT content FROM campaigns WHERE clientId=? AND approvedHash IS NOT NULL').all(clientId).map(r=>JSON.parse(String(r.content))).filter(c=>!closed.some(r=>c.productRef?.productId===r.productId&&matchesExperimentCampaign(r.experimentId,JSON.parse(r.content),c)));
  const contents=[...approved,...s.db.prepare("SELECT snapshot FROM queue_runs WHERE clientId=? AND status IN ('prepared','active','paused')").all(clientId).map(r=>JSON.parse(String(r.snapshot)).content)];
  const own=except?clientPlans(s,clientId).find(r=>r.experimentId===except&&r.revision===1):undefined;
  if(contents.some(c=>!(own&&c.productRef?.productId===own.productId&&matchesExperimentCampaign(own.experimentId,JSON.parse(own.content),c))&&c.leadIds.some((id:string)=>accounts.has(links.get(id)||''))))return 'Unternehmen befindet sich bereits in einer freigegebenen Kampagne oder offenen Warteschlange.';
  const catalog=catalogState(s,clientId).accounts;
  for(const a of catalog)if(accounts.has(String(a.accountId))&&a.domain&&catalog.some(b=>b.accountId!==a.accountId&&b.domain===a.domain))return 'Mehrere Unternehmenseinträge verwenden dieselbe Domain. Zuordnung zuerst klären.';
  return '';
}
export function previewExperiment(s:Store,clientId:string,productId:string,value:unknown){return checked(()=>{
  const input=experimentInput(value),state=strategyState(s,clientId,productId);
  if(state.paused||state.archived||state.productRevision!==input.productRevision)throw new AppError('Produktstand geändert, archiviert oder Kunde pausiert. Neu prüfen.',409);
  if(input.hypothesisIds.some(id=>!state.items.some(r=>r.id===id&&r.kind==='hypothesis'&&r.usable)))throw new AppError('Alle Testarme benötigen aktuell freigegebene Hypothesen.',409);
  const contacts=snapshots(s,clientId,input.leadIds),allocation=allocateCompanies(input.seed,contacts,armsFor(state.rows,input.hypothesisIds,input.productRevision));
  const problems:string[]=[];if(allocation.groups.length<input.hypothesisIds.length)problems.push('Zu wenige vergleichbare Unternehmen: mindestens ein Unternehmen je Testarm muss passende Kontakte für alle gewählten Personas haben.');
  const problem=conflict(s,clientId,new Set(allocation.groups.map(g=>g.accountId)));if(problem)problems.push(problem);
  const content:ExperimentContent={algorithm:'company-balanced-v1',input,contacts,allocation};
  if(JSON.stringify(content).length>2000000)throw new AppError('Experimentplan überschreitet die sichere Speichergrenze. Kontaktauswahl verkleinern.');
  return {content,fingerprint:experimentHash({clientId,productId,content}),problems};
});}
function insert(s:Store,r:ExperimentRow){s.db.prepare(`INSERT INTO experiment_versions (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>r[k]));}
export function saveExperiment(s:Store,clientId:string,productId:string,v:any){return checked(()=>{
  exactObject(v,['input','fingerprint','confirmed','actor','reason']);if(v.confirmed!==true||typeof v.fingerprint!=='string')bad();const actor=cleanText(v.actor,120),reason=cleanText(v.reason,2000);
  return s.transaction(()=>{
    if(Number(s.db.prepare('SELECT COUNT(*) AS n FROM experiment_versions WHERE revision=1').get()!.n)>=1000)throw new AppError('Maximal 1.000 Experimentpläne.');
    const p=previewExperiment(s,clientId,productId,v.input);if(p.problems.length)throw new AppError(p.problems.join(' '),409);if(p.fingerprint!==v.fingerprint)throw new AppError('Zuteilung inzwischen geändert. Vorschau neu prüfen.',409);
    const row:ExperimentRow={id:randomUUID(),clientId,productId,experimentId:randomUUID(),revision:1,state:'planned',content:JSON.stringify(p.content),actor,reason,createdAt:new Date().toISOString()};insert(s,row);return row;
  });
});}
export function closeExperiment(s:Store,clientId:string,productId:string,experimentId:string,v:any){return checked(()=>{
  exactObject(v,['revision','confirmed','actor','reason']);if(v.confirmed!==true||v.revision!==1)bad();const actor=cleanText(v.actor,120),reason=cleanText(v.reason,2000);
  return s.transaction(()=>{strategyState(s,clientId,productId);const old=latest(clientPlans(s,clientId)).find(r=>r.productId===productId&&r.experimentId===experimentId);if(!old)throw new AppError('Experiment nicht gefunden.',404);if(old.state!=='planned')throw new AppError('Experiment bereits geschlossen.',409);const row:ExperimentRow={...old,id:randomUUID(),revision:2,state:'closed',actor,reason,createdAt:new Date().toISOString()};insert(s,row);return row;});
});}
export function experimentState(s:Store,clientId:string,productId:string){
  const strategy=strategyState(s,clientId,productId);
  const rows=clientPlans(s,clientId).filter(r=>r.productId===productId);
  return {productRevision:strategy.productRevision,archived:strategy.archived,paused:strategy.paused,items:latest(rows).map(r=>{
    const content:ExperimentContent=JSON.parse(r.content),problems:string[]=[];
    if(r.state==='planned'){
      if(strategy.archived||strategy.paused||strategy.productRevision!==content.input.productRevision)problems.push('Produktstand geändert, archiviert oder Kunde pausiert.');
      if(content.input.hypothesisIds.some(id=>!strategy.items.some(h=>h.id===id&&h.usable)))problems.push('Hypothesen oder ihre Belege sind nicht mehr aktuell freigegeben.');
      if(JSON.stringify(snapshots(s,clientId,content.input.leadIds))!==JSON.stringify(content.contacts))problems.push('Kontakt- oder Unternehmenszuordnung geändert. Keine automatische Neuzuteilung.');
      const overlap=conflict(s,clientId,new Set(content.allocation.groups.map(g=>g.accountId)),r.experimentId);if(overlap)problems.push(overlap);
    }
    const campaigns=s.db.prepare('SELECT id,content FROM campaigns WHERE clientId=?').all(clientId).map(c=>({id:String(c.id),content:JSON.parse(String(c.content))})).filter(c=>c.content.experimentId===r.experimentId).map(c=>({id:c.id,hypothesisId:String(c.content.hypothesisId),name:String(c.content.name)}));
    return {...r,content,problems,campaigns};
  })};
}
export function exportProductExperiments(s:Store,clientId:string,productId:string){
  const state=strategyState(s,clientId,productId),rows=clientPlans(s,clientId).filter(r=>r.productId===productId),ids=new Set(rows.flatMap(r=>(JSON.parse(r.content) as ExperimentContent).input.hypothesisIds));
  for(const r of state.rows)if(ids.has(r.id))ids.add(r.content.personaId);
  return {format:'eiz-experiment-plans',version:1,clientId,productId,exportedAt:new Date().toISOString(),rows,strategies:state.rows.filter(r=>ids.has(r.id))};
}
export function validateExperimentBackup(data:BackupData,version:number){checked(()=>{
  if(data.experiments===undefined&&version<17)return;
  const rows=data.experiments;if(!Array.isArray(rows)||rows.length>2000||version<17&&rows.length)bad();
  const products=new Map((data.products||[]).map(r=>[r.id,r.clientId])),leads=new Map((data.leads||[]).map(r=>[r.id,r.clientId])),links=new Map((data.leadAccountLinks||[]).map(r=>[r.id,r])),accounts=new Map((data.accountRevisions||[]).map(r=>[r.accountId+':'+r.revision,r]));
  const ids=new Set<string>(),chains=new Map<string,ExperimentRow[]>();
  for(const r of rows){
    exactObject(r,[...columns]);if(!knowledgeUuid(r.id)||ids.has(r.id)||!knowledgeUuid(r.experimentId)||products.get(r.productId)!==r.clientId||![1,2].includes(r.revision)||r.state!==(r.revision===1?'planned':'closed')||!knowledgeDate(r.createdAt)||cleanText(r.actor,120)!==r.actor||cleanText(r.reason,2000)!==r.reason||typeof r.content!=='string'||r.content.length>2000000)bad();ids.add(r.id);
    const c:ExperimentContent=JSON.parse(r.content);exactObject(c,['algorithm','input','contacts','allocation']);const input=experimentInput(c.input);
    if(c.algorithm!=='company-balanced-v1'||JSON.stringify(input)!==JSON.stringify(c.input)||!Array.isArray(c.contacts)||c.contacts.length!==input.leadIds.length)bad();
    for(const [i,t] of c.contacts.entries()){
      exactObject(t,['leadId','role','blocked','linkId','accountId','accountRevision','company','domain']);
      if(t.leadId!==input.leadIds[i]||leads.get(t.leadId)!==r.clientId||typeof t.role!=='string'||t.role.length>4000||typeof t.blocked!=='boolean')bad();
      if(t.linkId===null){if(t.accountId!==null)bad();}else{const link=links.get(t.linkId);if(!link||link.clientId!==r.clientId||link.leadId!==t.leadId||link.accountId!==t.accountId||link.createdAt>r.createdAt)bad();}
      if(t.accountId===null){if(t.accountRevision!==null||t.company!==''||t.domain!=='')bad();}else{const account=accounts.get(t.accountId+':'+t.accountRevision);if(!account||account.clientId!==r.clientId||account.name!==t.company||account.domain!==t.domain||account.createdAt>r.createdAt)bad();}
    }
    const strategies=(data.strategies||[]).filter(h=>h.clientId===r.clientId&&h.productId===r.productId&&h.createdAt<=r.createdAt).map(h=>({...h,content:JSON.parse(h.content)}));
    const allocation=allocateCompanies(input.seed,c.contacts,armsFor(strategies,input.hypothesisIds,input.productRevision));
    if(allocation.groups.length<input.hypothesisIds.length||JSON.stringify(allocation)!==JSON.stringify(c.allocation))bad();
    const chain=chains.get(r.experimentId)||[];chain.push(r);chains.set(r.experimentId,chain);
  }
  if(chains.size>1000)bad();
  for(const chain of chains.values()){chain.sort((a,b)=>a.revision-b.revision);if(chain.length>2||chain.some((r,i)=>r.revision!==i+1||r.clientId!==chain[0].clientId||r.productId!==chain[0].productId||r.content!==chain[0].content||r.createdAt<chain[0].createdAt))bad();}
  const reserved=new Set<string>();for(const r of latest(rows))if(r.state==='planned')for(const g of (JSON.parse(r.content) as ExperimentContent).allocation.groups){const key=r.clientId+':'+g.accountId;if(reserved.has(key))bad();reserved.add(key);}
});}
export function protectExperimentRestore(s:Store,data:BackupData){
  const saved=new Map((data.experiments||[]).map(r=>[r.id,r]));for(const r of exportExperiments(s)){const old=saved.get(r.id);if(!old||columns.some(k=>old[k]!==r[k]))throw new AppError('Sicherung würde bekannte Experimentpläne oder Schließungen zurücksetzen. Aktuelle Sicherung verwenden.');}
}
export function restoreExperiments(s:Store,rows:ExperimentRow[]){for(const r of rows)insert(s,r);}

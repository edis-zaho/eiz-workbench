import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {cleanText,exactObject} from './interpretation-input';
import {knowledgeDate,knowledgeUuid} from './knowledge-input';
import {knowledgeState} from './knowledge';
import {personaContent,hypothesisContent,type PersonaContent,type HypothesisContent} from './strategy-input';
import type {BackupData} from './types';
export type StrategyRow={id:string;clientId:string;productId:string;productRevision:number;entityId:string;kind:'persona'|'hypothesis';revision:number;previousId:string|null;state:'draft'|'approved'|'withdrawn';content:string;actor:string;reason:string;createdAt:string};
const columns=['id','clientId','productId','productRevision','entityId','kind','revision','previousId','state','content','actor','reason','createdAt'] as const;
function bad():never{throw new AppError('Ungültige Strategie oder widersprüchliche Persona-/Hypothesenhistorie.');}
function checked<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof AppError)throw e;return bad();}}
const parsed=(kind:string,v:any)=>kind==='persona'?personaContent(v):hypothesisContent(v);
export function migrateStrategy(s:Store){s.db.exec(`CREATE TABLE strategy_versions(
 id TEXT PRIMARY KEY,clientId TEXT NOT NULL,productId TEXT NOT NULL,productRevision INTEGER NOT NULL,
 entityId TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('persona','hypothesis')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100),previousId TEXT,
 state TEXT NOT NULL CHECK(state IN ('draft','approved','withdrawn')),content TEXT NOT NULL CHECK(json_valid(content)),actor TEXT NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL,
 UNIQUE(entityId,revision),FOREIGN KEY(productId,clientId) REFERENCES products(id,clientId),FOREIGN KEY(productId,productRevision) REFERENCES product_revisions(productId,revision));
 CREATE INDEX strategy_product ON strategy_versions(clientId,productId);
 CREATE TRIGGER strategy_no_update BEFORE UPDATE ON strategy_versions BEGIN SELECT RAISE(ABORT,'Strategy history cannot be overwritten'); END;
 CREATE TRIGGER strategy_capacity BEFORE INSERT ON strategy_versions WHEN (SELECT COUNT(*) FROM strategy_versions)>=10000 OR (SELECT COUNT(*) FROM strategy_versions WHERE productId=NEW.productId)>=1000 BEGIN SELECT RAISE(ABORT,'Strategy capacity reached'); END;
 PRAGMA user_version=15;`);}
function rowsFor(s:Store,clientId:string,productId:string){return s.db.prepare('SELECT * FROM strategy_versions WHERE clientId=? AND productId=? ORDER BY entityId,revision').all(clientId,productId) as StrategyRow[];}
function latestRows(rows:StrategyRow[]){const map=new Map<string,StrategyRow>();for(const row of rows)if(!map.has(row.entityId)||map.get(row.entityId)!.revision<row.revision)map.set(row.entityId,row);return map;}
export function strategyState(s:Store,clientId:string,productId:string){
  const knowledge=knowledgeState(s,clientId,productId),rows=rowsFor(s,clientId,productId),latest=latestRows(rows);
  function base(row:StrategyRow){return knowledge.archived?'Produkt archiviert':row.productRevision!==knowledge.productRevision?'Produktstand geändert':row.state!=='approved'?(row.state==='withdrawn'?'Widerrufen':'Noch nicht freigegeben'):'';}
  function dependency(content:HypothesisContent){
    const persona=rows.find(r=>r.id===content.personaId&&r.kind==='persona');
    if(!persona||latest.get(persona.entityId)?.id!==persona.id||base(persona))return 'Personaversion nicht mehr aktuell freigegeben';
    if(content.knowledgeIds.some(id=>!knowledge.items.some(k=>k.id===id&&k.kind==='claim'&&k.usable&&k.content.category!=='hypothesis')))return 'Produktfakten nicht mehr aktuell freigegeben';
    return '';
  }
  return {productRevision:knowledge.productRevision,archived:knowledge.archived,paused:s.client(clientId).status==='paused',rows:rows.map(r=>({...r,content:JSON.parse(r.content)})),items:[...latest.values()].map(r=>{
    const content=JSON.parse(r.content),inactiveReason=base(r)||(r.kind==='hypothesis'?dependency(content):'');return {...r,content,usable:!inactiveReason,inactiveReason};
  })};
}
export function saveStrategy(s:Store,clientId:string,productId:string,input:any){return checked(()=>{
  exactObject(input,['entityId','expectedRevision','productRevision','kind','action','content','actor','reason']);
  if(input.entityId!==null&&!knowledgeUuid(input.entityId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=100||!['persona','hypothesis'].includes(input.kind)||!['save','approve','withdraw'].includes(input.action))bad();
  const content=JSON.stringify(parsed(input.kind,input.content)),actor=cleanText(input.actor,120),reason=cleanText(input.reason,2000);
  return s.transaction(()=>{
    const state=strategyState(s,clientId,productId);
    if(input.productRevision!==state.productRevision)throw new AppError('Produktstand geändert. Strategie neu laden.',409);
    if(input.action!=='withdraw'&&(state.archived||state.paused))throw new AppError('Produkt archiviert oder Kunde pausiert. Keine neue Strategie freigeben.');
    const rows=rowsFor(s,clientId,productId),latest=latestRows(rows),prev=input.entityId?latest.get(input.entityId):undefined;
    if(input.entityId&&!prev)throw new AppError('Strategieelement nicht gefunden.',404);
    if((prev?.revision||0)!==input.expectedRevision)throw new AppError('Strategie inzwischen geändert. Neu laden.',409);
    if(prev&&prev.kind!==input.kind)bad();
    let status:StrategyRow['state']='draft';
    if(input.action!=='save'){
      if(!prev||prev.content!==content)throw new AppError('Zuerst den unveränderten Entwurf speichern.');
      if(input.action==='approve'&&(prev.state!=='draft'||prev.productRevision!==state.productRevision))throw new AppError('Nur ein aktueller Entwurf kann freigegeben werden.');
      if(input.action==='withdraw'&&prev.state==='withdrawn')throw new AppError('Bereits widerrufen.');
      status=input.action==='approve'?'approved':'withdrawn';
    }
    const c=JSON.parse(content);
    if(input.kind==='persona'){
      if(prev&&JSON.parse(prev.content).code!==c.code)throw new AppError('Der Persona-Code bleibt für dieses Element unverändert.');
      if([...latest.values()].some(r=>r.entityId!==prev?.entityId&&r.kind==='persona'&&JSON.parse(r.content).code===c.code))throw new AppError('Dieser Persona-Code ist bereits vergeben. Vorhandene Persona bearbeiten.');
    }else if(input.action!=='withdraw'){
      const persona=state.items.find(r=>r.id===c.personaId&&r.kind==='persona'&&r.usable);
      const knowledge=knowledgeState(s,clientId,productId);
      if(!persona||c.knowledgeIds.some((id:string)=>!knowledge.items.some(r=>r.id===id&&r.kind==='claim'&&r.usable&&r.content.category!=='hypothesis')))throw new AppError('Hypothese benötigt eine aktuell freigegebene Persona und Produktfakten.');
    }
    if(rows.length>=1000||Number(s.db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get()!.n)>=10000)throw new AppError('Strategiegrenze erreicht. Keine Version wurde überschrieben.');
    const row:StrategyRow={id:randomUUID(),clientId,productId,productRevision:state.productRevision,entityId:prev?.entityId||randomUUID(),kind:input.kind,revision:input.expectedRevision+1,previousId:prev?.id||null,state:status,content,actor,reason,createdAt:new Date().toISOString()};
    insert(s,row);return {id:row.id,entityId:row.entityId,revision:row.revision};
  });
});}
function insert(s:Store,r:StrategyRow){s.db.prepare(`INSERT INTO strategy_versions (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>r[k]));}
export function exportStrategy(s:Store):StrategyRow[]{return s.db.prepare('SELECT * FROM strategy_versions ORDER BY id').all() as StrategyRow[];}
export function exportProductStrategy(s:Store,clientId:string,productId:string){strategyState(s,clientId,productId);return {format:'eiz-product-strategy',version:1,clientId,productId,exportedAt:new Date().toISOString(),rows:rowsFor(s,clientId,productId)};}
export function validateStrategyBackup(data:BackupData,version:number){
  if(data.strategies===undefined&&version<15)return;
  checked(()=>{
    const rows=data.strategies;if(!Array.isArray(rows)||rows.length>10000||version<15&&rows.length)bad();
    const ids=new Map<string,StrategyRow>(),chains=new Map<string,StrategyRow[]>(),counts=new Map<string,number>();
    const products=new Map((data.products||[]).map(r=>[r.id,r.clientId])),revisions=new Map((data.productRevisions||[]).map(r=>[r.productId+':'+r.revision,r]));
    for(const r of rows){
      exactObject(r,[...columns]);
      if(!knowledgeUuid(r.id)||ids.has(r.id)||!knowledgeUuid(r.entityId)||products.get(r.productId)!==r.clientId||!revisions.has(r.productId+':'+r.productRevision)||!Number.isSafeInteger(r.productRevision)||!Number.isSafeInteger(r.revision)||r.revision<1||r.revision>100||r.previousId!==null&&!knowledgeUuid(r.previousId)||!knowledgeDate(r.createdAt)||!['persona','hypothesis'].includes(r.kind)||!['draft','approved','withdrawn'].includes(r.state)||typeof r.content!=='string'||r.content.length>60000||cleanText(r.actor,120)!==r.actor||cleanText(r.reason,2000)!==r.reason)bad();
      if(JSON.stringify(parsed(r.kind,JSON.parse(r.content)))!==r.content)bad();
      ids.set(r.id,r);const chain=chains.get(r.entityId)||[];chain.push(r);chains.set(r.entityId,chain);const count=(counts.get(r.productId)||0)+1;if(count>1000)bad();counts.set(r.productId,count);
    }
    const codes=new Map<string,string>(),knowledge=new Map((data.knowledge||[]).map(r=>[r.id,r]));
    for(const chain of chains.values()){
      chain.sort((a,b)=>a.revision-b.revision);
      for(let i=0;i<chain.length;i++){
        const r=chain[i],prev=chain[i-1],c=JSON.parse(r.content);
        if(r.revision!==i+1||r.previousId!==(prev?.id||null)||r.clientId!==chain[0].clientId||r.productId!==chain[0].productId||r.kind!==chain[0].kind||prev&&(r.productRevision<prev.productRevision||r.createdAt<prev.createdAt))bad();
        if(r.state!=='draft'&&(!prev||prev.content!==r.content))bad();
        if(r.state==='approved'&&(prev.state!=='draft'||prev.productRevision!==r.productRevision))bad();
        if(r.state==='withdrawn'&&prev.state==='withdrawn')bad();
        if(r.kind==='persona'){
          const key=r.productId+':'+c.code;if(codes.has(key)&&codes.get(key)!==r.entityId||prev&&JSON.parse(prev.content).code!==c.code)bad();codes.set(key,r.entityId);
        }else{
          const p=ids.get(c.personaId);if(!p||p.kind!=='persona'||p.state!=='approved'||p.productId!==r.productId||p.clientId!==r.clientId||p.createdAt>r.createdAt||r.state!=='withdrawn'&&p.productRevision!==r.productRevision)bad();
          for(const id of c.knowledgeIds){const k=knowledge.get(id);if(!k||k.kind!=='claim'||k.state!=='approved'||k.productId!==r.productId||k.clientId!==r.clientId||k.createdAt>r.createdAt||JSON.parse(k.content).category==='hypothesis'||r.state!=='withdrawn'&&k.productRevision!==r.productRevision)bad();}
        }
      }
    }
  });
}
export function mergedStrategy(s:Store,data:BackupData){
  const merged=new Map((data.strategies||[]).map(r=>[r.id,r]));
  for(const row of exportStrategy(s)){const old=merged.get(row.id);if(old&&columns.some(k=>old[k]!==row[k]))throw new AppError('Sicherung widerspricht bekannter Strategiehistorie.');merged.set(row.id,row);}
  const rows=[...merged.values()];validateStrategyBackup({...data,strategies:rows},15);return rows;
}
export function restoreStrategy(s:Store,rows:StrategyRow[]){for(const r of rows)insert(s,r);}

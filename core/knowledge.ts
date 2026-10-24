import {randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {BackupData} from './types';
import {cleanText,exactObject} from './interpretation-input';
import {sourceContent,claimContent,knowledgeUuid,knowledgeDate,type SourceContent,type ClaimContent} from './knowledge-input';

export type KnowledgeRow={id:string;clientId:string;productId:string;productRevision:number;entityId:string;kind:'source'|'claim';revision:number;previousId:string|null;state:'recorded'|'draft'|'approved'|'withdrawn';content:string;actor:string;reason:string;createdAt:string};
const columns=['id','clientId','productId','productRevision','entityId','kind','revision','previousId','state','content','actor','reason','createdAt'] as const;
function bad():never {throw new AppError('Ungültiges Produktwissen oder widersprüchliche Quellen-/Freigabehistorie.');}
function checked<T>(fn:()=>T):T {try{return fn();}catch(e){if(e instanceof AppError)throw e;return bad();}}
export function migrateKnowledge(s:Store) {
  s.db.exec(`CREATE TABLE knowledge_versions(
    id TEXT PRIMARY KEY,clientId TEXT NOT NULL,productId TEXT NOT NULL,productRevision INTEGER NOT NULL,
    entityId TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('source','claim')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100),previousId TEXT,
    state TEXT NOT NULL CHECK(state IN ('recorded','draft','approved','withdrawn')),content TEXT NOT NULL CHECK(json_valid(content)),actor TEXT NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL,
    UNIQUE(entityId,revision),FOREIGN KEY(productId,clientId) REFERENCES products(id,clientId),FOREIGN KEY(productId,productRevision) REFERENCES product_revisions(productId,revision));
    CREATE INDEX knowledge_product ON knowledge_versions(clientId,productId);
    CREATE TRIGGER knowledge_no_update BEFORE UPDATE ON knowledge_versions BEGIN SELECT RAISE(ABORT,'Knowledge history cannot be overwritten'); END;
    CREATE TRIGGER knowledge_capacity BEFORE INSERT ON knowledge_versions WHEN
      (SELECT COUNT(*) FROM knowledge_versions)>=10000 OR (SELECT COUNT(*) FROM knowledge_versions WHERE productId=NEW.productId)>=1000
      BEGIN SELECT RAISE(ABORT,'Knowledge capacity reached'); END;
    PRAGMA user_version=13;`);
}
function product(s:Store,clientId:string,productId:string) {
  s.client(clientId);
  const row=s.db.prepare('SELECT * FROM product_revisions WHERE clientId=? AND productId=? ORDER BY revision DESC LIMIT 1').get(clientId,productId);
  if(!row)throw new AppError('Produkt nicht gefunden.',404);return row;
}
function rowsFor(s:Store,clientId:string,productId:string):KnowledgeRow[] {
  return s.db.prepare('SELECT * FROM knowledge_versions WHERE clientId=? AND productId=? ORDER BY entityId,revision').all(clientId,productId) as KnowledgeRow[];
}
function latestRows(rows:KnowledgeRow[]) {const map=new Map<string,KnowledgeRow>();for(const r of rows)if(!map.has(r.entityId)||map.get(r.entityId)!.revision<r.revision)map.set(r.entityId,r);return map;}
function usable(row:KnowledgeRow,latest:Map<string,KnowledgeRow>,all:Map<string,KnowledgeRow>,productRevision:number,archived:boolean):string {
  if(archived)return 'Produkt archiviert';
  if(row.productRevision!==productRevision)return 'Produktstand geändert';
  if(row.kind==='source')return (JSON.parse(row.content) as SourceContent).withdrawn?'Quelle zurückgezogen':'';
  if(row.state!=='approved')return row.state==='withdrawn'?'Aussage widerrufen':'Noch nicht freigegeben';
  const source=all.get((JSON.parse(row.content) as ClaimContent).sourceId);
  if(!source||latest.get(source.entityId)?.id!==source.id)return 'Quelle inzwischen geändert';
  if(source.productRevision!==productRevision)return 'Quelle gehört zu einem älteren Produktstand';
  return (JSON.parse(source.content) as SourceContent).withdrawn?'Quelle zurückgezogen':'';
}
export function knowledgeState(s:Store,clientId:string,productId:string) {
  const p=product(s,clientId,productId),rows=rowsFor(s,clientId,productId),latest=latestRows(rows),all=new Map(rows.map(r=>[r.id,r]));
  return {productRevision:Number(p.revision),archived:!!p.archived,rows:rows.map(r=>({...r,content:JSON.parse(r.content)})),items:[...latest.values()].map(r=>{
    const inactiveReason=usable(r,latest,all,Number(p.revision),!!p.archived);return {...r,content:JSON.parse(r.content),usable:!inactiveReason,inactiveReason};
  })};
}
export function saveKnowledge(s:Store,clientId:string,productId:string,input:any,newDraftEntityId?:string) {
  return checked(()=>{
    exactObject(input,['entityId','expectedRevision','productRevision','kind','action','content','actor','reason']);
    const actor=cleanText(input.actor,120),reason=cleanText(input.reason,2000);
    if(newDraftEntityId&&(!knowledgeUuid(newDraftEntityId)||input.entityId!==null||input.kind!=='claim'||input.action!=='save'))bad();
    if(input.entityId!==null&&!knowledgeUuid(input.entityId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=100||!['source','claim'].includes(input.kind)||!['save','approve','withdraw'].includes(input.action))bad();
    const content=JSON.stringify(input.kind==='source'?sourceContent(input.content):claimContent(input.content));
    const write=()=>{
      const p=product(s,clientId,productId);if(p.archived)throw new AppError('Archivierte Produkte können nicht bearbeitet werden.');
      if(input.productRevision!==p.revision)throw new AppError('Produktstand geändert. Wissen neu laden.',409);
      const rows=rowsFor(s,clientId,productId),latest=latestRows(rows),previous=input.entityId?latest.get(input.entityId):undefined;
      if(input.entityId&&!previous)throw new AppError('Wissenselement nicht gefunden.',404);
      if((previous?.revision||0)!==input.expectedRevision)throw new AppError('Wissen inzwischen geändert. Neu laden und prüfen.',409);
      if(previous&&previous.kind!==input.kind)bad();
      if(rows.length>=1000||Number(s.db.prepare('SELECT COUNT(*) AS n FROM knowledge_versions').get()!.n)>=10000)throw new AppError('Wissensgrenze erreicht. Nichts wurde gekürzt oder gespeichert.');
      let state:KnowledgeRow['state']=input.kind==='source'?'recorded':'draft';
      if(input.kind==='source'&&input.action!=='save')bad();
      if(input.kind==='claim') {
        const c=JSON.parse(content) as ClaimContent,source=rows.find(r=>r.id===c.sourceId&&r.kind==='source');
        if(!source||!(JSON.parse(source.content) as SourceContent).text.includes(c.quote))throw new AppError('Der wörtliche Beleg fehlt in der gewählten Quellenversion.');
        // A withdrawal must remain possible even after the source was superseded.
        if(input.action!=='withdraw'&&(latest.get(source.entityId)?.id!==source.id||(JSON.parse(source.content) as SourceContent).withdrawn||source.productRevision!==p.revision))throw new AppError('Für diesen Entwurf eine aktuelle, nicht zurückgezogene Quelle wählen.');
        if(input.action!=='save') {
          if(!previous||previous.content!==content)throw new AppError('Erst den Entwurf speichern; Freigabe und Widerruf dürfen keinen Inhalt ändern.');
          if(input.action==='approve'&&(previous.state!=='draft'||previous.productRevision!==p.revision))throw new AppError('Nur ein aktueller gespeicherter Entwurf kann freigegeben werden.');
          if(input.action==='withdraw'&&previous.state==='withdrawn')throw new AppError('Aussage ist bereits widerrufen.');
          state=input.action==='approve'?'approved':'withdrawn';
        }
      }
      const row:KnowledgeRow={id:randomUUID(),clientId,productId,productRevision:Number(p.revision),entityId:previous?.entityId||newDraftEntityId||randomUUID(),kind:input.kind,revision:input.expectedRevision+1,previousId:previous?.id||null,state,content,actor,reason,createdAt:new Date().toISOString()};
      insert(s,row);return {id:row.id,entityId:row.entityId,revision:row.revision};
    };
    // A seeded suggestion draft is called only inside the integrator's adoption transaction.
    return newDraftEntityId?write():s.transaction(write);
  });
}
function insert(s:Store,row:KnowledgeRow){s.db.prepare(`INSERT INTO knowledge_versions (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>row[k]));}
export function exportKnowledge(s:Store):KnowledgeRow[]{return s.db.prepare('SELECT * FROM knowledge_versions ORDER BY id').all() as KnowledgeRow[];}
export function exportProductKnowledge(s:Store,clientId:string,productId:string){product(s,clientId,productId);return {format:'eiz-product-knowledge',version:1,clientId,productId,exportedAt:new Date().toISOString(),rows:rowsFor(s,clientId,productId)};}
export function validateKnowledgeBackup(data:BackupData,version:number) {
  if(data.knowledge===undefined&&version<13)return;
  checked(()=>{
    const rows=data.knowledge;if(!Array.isArray(rows)||rows.length>10000||(version<13&&rows.length))bad();
    const ids=new Map<string,KnowledgeRow>(),chains=new Map<string,KnowledgeRow[]>(),counts=new Map<string,number>();
    const products=new Map((data.products||[]).map(r=>[r.id,r.clientId]));
    const versions=new Map((data.productRevisions||[]).map(r=>[r.productId+':'+r.revision,r]));
    for(const r of rows){
      exactObject(r,[...columns]);
      if(!knowledgeUuid(r.id)||ids.has(r.id)||!knowledgeUuid(r.entityId)||!products.has(r.productId)||products.get(r.productId)!==r.clientId||!versions.has(r.productId+':'+r.productRevision)||!Number.isSafeInteger(r.productRevision)||!Number.isSafeInteger(r.revision)||r.revision<1||r.revision>100||!knowledgeDate(r.createdAt)||!['source','claim'].includes(r.kind)||r.previousId!==null&&!knowledgeUuid(r.previousId)||cleanText(r.actor,120)!==r.actor||cleanText(r.reason,2000)!==r.reason||typeof r.content!=='string'||r.content.length>160000)bad();
      const content=r.kind==='source'?sourceContent(JSON.parse(r.content)):claimContent(JSON.parse(r.content));
      if(JSON.stringify(content)!==r.content||!(r.kind==='source'?['recorded']:['draft','approved','withdrawn']).includes(r.state))bad();
      ids.set(r.id,r);const chain=chains.get(r.entityId)||[];chain.push(r);chains.set(r.entityId,chain);
      const count=(counts.get(r.productId)||0)+1;if(count>1000)bad();counts.set(r.productId,count);
    }
    for(const chain of chains.values()){
      chain.sort((a,b)=>a.revision-b.revision);
      for(let i=0;i<chain.length;i++){
        const r=chain[i],prev=chain[i-1];
        if(r.revision!==i+1||r.previousId!==(prev?.id||null)||r.clientId!==chain[0].clientId||r.productId!==chain[0].productId||r.kind!==chain[0].kind||prev&&(r.productRevision<prev.productRevision||r.createdAt<prev.createdAt))bad();
        if(r.kind==='claim'){
          const c=JSON.parse(r.content) as ClaimContent,source=ids.get(c.sourceId);
          if(!source||source.kind!=='source'||source.clientId!==r.clientId||source.productId!==r.productId||source.createdAt>r.createdAt||!(JSON.parse(source.content) as SourceContent).text.includes(c.quote))bad();
          if(r.state!=='withdrawn'&&(source.productRevision!==r.productRevision||(JSON.parse(source.content) as SourceContent).withdrawn))bad();
          if(r.state!=='draft'&&(!prev||prev.content!==r.content))bad();
          if(r.state==='approved'&&(prev.state!=='draft'||prev.productRevision!==r.productRevision))bad();
          if(r.state==='withdrawn'&&prev.state==='withdrawn')bad();
        }
      }
    }
  });
}
export function mergedKnowledge(s:Store,data:BackupData) {
  const merged=new Map((data.knowledge||[]).map(r=>[r.id,r]));
  for(const r of exportKnowledge(s)){
    const old=merged.get(r.id);if(old&&columns.some(k=>old[k]!==r[k]))throw new AppError('Sicherung widerspricht bekanntem Produktwissen.');merged.set(r.id,r);
  }
  const rows=[...merged.values()];validateKnowledgeBackup({...data,knowledge:rows},13);return rows;
}
export function restoreKnowledge(s:Store,rows:KnowledgeRow[]){for(const r of rows)insert(s,r);}

import {taskRoute,bindModelRun,historicalModelRoute,modelSetup} from './model-jobs';
import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import type {AIRun} from './brief';
import type {BackupData} from './types';
import {knowledgeState,saveKnowledge,type KnowledgeRow} from './knowledge';
import {claimContent,knowledgeUuid,type SourceContent} from './knowledge-input';
import {cleanText,exactObject} from './interpretation-input';
import {createKnowledgePrompt,parseKnowledgeSuggestions,type ExtractionSource} from './knowledge-extraction';

type Context={productId:string;productRevision:number;sources:ExtractionSource[]};
function checked<T>(fn:()=>T):T {try{return fn();}catch(e){if(e instanceof AppError)throw e;throw new AppError('Ungültiger Wissensauftrag. Quellen, Belege und Auswahl prüfen.');}}
function context(text:string):Context {
  const d=JSON.parse(text);exactObject(d,['productId','productRevision','sources']);
  createKnowledgePrompt(d.sources);
  if(d.productId!==d.sources[0].productId||d.productRevision!==d.sources[0].productRevision)throw new Error();
  return d;
}
function current(s:Store,clientId:string,d:Context,clientVersion:number) {
  const c=s.client(clientId),state=knowledgeState(s,clientId,d.productId);
  if(c.status==='paused'||c.version!==clientVersion||state.archived||state.productRevision!==d.productRevision)throw new AppError('Kunden- oder Produktstand geändert. Vorschläge erneut anfordern.',409);
  for(const source of d.sources){
    const row=state.items.find(r=>r.id===source.id&&r.kind==='source'&&r.usable);
    if(!row||JSON.stringify({id:row.id,productId:row.productId,productRevision:row.productRevision,title:row.content.title,text:row.content.text})!==JSON.stringify(source))throw new AppError('Quellenstand geändert oder zurückgezogen. Vorschläge erneut anfordern.',409);
  }
  return state;
}
function runFor(s:Store,clientId:string,productId:string,id:string):AIRun {
  s.client(clientId);
  const r=s.db.prepare("SELECT * FROM ai_runs WHERE id=? AND clientId=? AND purpose='knowledge'").get(id,clientId) as AIRun|undefined;
  if(!r||context(r.context).productId!==productId)throw new AppError('Wissensauftrag nicht gefunden.',404);
  return r;
}
function entityId(runId:string,index:number){const h=createHash('sha256').update(`knowledge-draft:${runId}:${index}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;}
function usage(value:any) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
  if(Object.keys(value).some(k=>!['inputTokens','outputTokens','reasoningTokens'].includes(k)))throw new Error();
  const out:Record<string,number|null|string>={costStatus:'unpriced'};
  for(const k of ['inputTokens','outputTokens','reasoningTokens']){const v=value[k]??null;if(v!==null&&(!Number.isSafeInteger(v)||v<0))throw new Error();out[k]=v;}
  return out;
}
export function reserveKnowledgeRun(s:Store,clientId:string,productId:string,input:any) {
  return checked(()=>s.transaction(()=>{
    exactObject(input,['productRevision','sourceIds','briefRevision','confirmed',...(s.publicMode?['expectedBindingHash']:[])]);
    if(input.confirmed!==true||!Array.isArray(input.sourceIds)||!input.sourceIds.every(knowledgeUuid)||new Set(input.sourceIds).size!==input.sourceIds.length)throw new Error();
    const c=s.client(clientId),state=knowledgeState(s,clientId,productId),brief=s.brief(clientId),route=taskRoute(s,clientId,'knowledge',brief.content.routes.analysis);
    if(input.briefRevision!==brief.revision||input.productRevision!==state.productRevision)throw new AppError('Auswahl oder Modellrahmen geändert. Neu laden.',409);
    if(!route.model)throw new AppError('Zuerst das Analysemodell im Kundenrahmen festlegen.');
    const sources:ExtractionSource[]=input.sourceIds.map((id:string)=>{const row=state.items.find(r=>r.id===id&&r.kind==='source'&&r.usable);if(!row)throw new AppError('Nur aktuelle Quellen dieses Produkts auswählen.');return {id:row.id,productId,productRevision:state.productRevision,title:row.content.title,text:row.content.text};});
    const prompt=createKnowledgePrompt(sources),d={productId,productRevision:state.productRevision,sources};current(s,clientId,d,c.version);
    const serialized=JSON.stringify(d);if(serialized.length>60000||prompt.user.length>60000)throw new AppError('Quellenauswahl überschreitet das Aufruflimit. Weniger Quellen auswählen; nichts wurde gekürzt.');
    if(s.db.prepare("SELECT id FROM ai_runs WHERE clientId=? AND status='running'").get(clientId))throw new AppError('Für diesen Kunden läuft bereits eine Modellaufgabe.',409);
    const day=new Date().toISOString().slice(0,10),counterKey=`aiUsage:${clientId}:${day}`;
    const count=Math.max(Number(s.db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE clientId=? AND createdAt>=?').get(clientId,day+'T00:00:00.000Z')?.n),Number(s.db.prepare('SELECT value FROM meta WHERE key=?').get(counterKey)?.value||0));
    if(count>=brief.content.rules.aiDailyLimit)throw new AppError('Tageslimit für Modellaufrufe erreicht. Auch fehlgeschlagene Versuche zählen.');
    const id=randomUUID();s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(counterKey,String(count+1));
    s.db.prepare('INSERT INTO ai_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,clientId,'knowledge',route.provider,route.model,brief.revision,c.version,'running',serialized,'',JSON.stringify(usage({})),new Date().toISOString(),'unreviewed');
    return bindModelRun(s,clientId,{id,clientId,productId,purpose:'knowledge',...route,prompt},input.expectedBindingHash);
  }));
}
export function finishKnowledgeRun(s:Store,clientId:string,productId:string,id:string,input:any) {
  return checked(()=>s.transaction(()=>{
    exactObject(input,['status','text','usage']);
    if(!['completed','failed','unknown'].includes(input.status)||typeof input.text!=='string'||input.text.length>30000)throw new Error();
    const run=runFor(s,clientId,productId,id);if(run.status!=='running')throw new AppError('Auftrag ist bereits abgeschlossen.',409);
    const u=usage(input.usage);let status=input.status,result='Kein vollständiges Ergebnis. Mögliche Kosten beim Anbieter prüfen. Keine automatische Wiederholung.';
    if(status==='completed'){
      try{result=JSON.stringify({suggestions:parseKnowledgeSuggestions(input.text,context(run.context).sources)});}
      catch{status='failed';result='Modellantwort verworfen: ungültige Struktur oder fehlender wörtlicher Beleg. Keine Aussage übernommen.';}
    }
    s.db.prepare('UPDATE ai_runs SET status=?,result=?,usage=? WHERE id=?').run(status,result,JSON.stringify(u),id);
    return knowledgeRuns(s,clientId,productId);
  }));
}
export function knowledgeRuns(s:Store,clientId:string,productId:string) {
  const state=knowledgeState(s,clientId,productId);
  const runs=s.db.prepare("SELECT * FROM ai_runs WHERE clientId=? AND purpose='knowledge' ORDER BY createdAt DESC,rowid DESC").all(clientId) as AIRun[];
  return runs.filter(r=>context(r.context).productId===productId).map(r=>{
    const d=context(r.context);let stale='';try{current(s,clientId,d,r.clientVersion);}catch(e){stale=(e as Error).message;}
    const suggestions=r.status==='completed'?parseKnowledgeSuggestions(r.result,d.sources):[];
    return {id:r.id,provider:r.provider,model:r.model,createdAt:r.createdAt,status:r.status,productRevision:d.productRevision,sources:d.sources,usage:JSON.parse(r.usage),stale,message:r.status==='completed'?'':r.result,suggestions:suggestions.map((content,index)=>({content,index,entityId:state.rows.some(k=>k.entityId===entityId(r.id,index))?entityId(r.id,index):null}))};
  });
}
export function adoptKnowledgeSuggestion(s:Store,clientId:string,productId:string,id:string,input:any) {
  return checked(()=>s.transaction(()=>{
    exactObject(input,['index','content','actor','reason']);
    if(!Number.isSafeInteger(input.index)||input.index<0)throw new Error();
    const run=runFor(s,clientId,productId,id),d=context(run.context);
    if(run.status!=='completed')throw new AppError('Nur vollständige Vorschläge können übernommen werden.');
    current(s,clientId,d,run.clientVersion);
    const suggestions=parseKnowledgeSuggestions(run.result,d.sources),original=suggestions[input.index],content=claimContent(input.content);
    if(!original||original.sourceId!==content.sourceId)throw new AppError('Die Belegquelle des Vorschlags darf nicht ausgetauscht werden.');
    const seed=entityId(id,input.index);if(s.db.prepare('SELECT id FROM knowledge_versions WHERE entityId=?').get(seed))throw new AppError('Dieser Vorschlag wurde bereits als Entwurf übernommen.',409);
    const reason=cleanText(input.reason,1500);
    return saveKnowledge(s,clientId,productId,{entityId:null,expectedRevision:0,productRevision:d.productRevision,kind:'claim',action:'save',content,actor:input.actor,reason:`KI-Entwurf ${id} / Vorschlag ${input.index+1} (${run.provider}, ${run.model}). ${reason}`},seed);
  }));
}
export function validateKnowledgeRuns(data:BackupData) {
  checked(()=>{
    const ids=new Set<string>();
    for(const r of data.aiRuns||[]){
      if(ids.has(r.id))throw new Error();ids.add(r.id);if(r.purpose!=='knowledge')continue;
      if(!knowledgeUuid(r.id)||!r.model||!data.clients.some(c=>c.id===r.clientId)||r.review!=='unreviewed')throw new Error();
      const d=context(r.context);
      for(const source of d.sources){
        const row=data.knowledge?.find(k=>k.id===source.id&&k.kind==='source'&&k.clientId===r.clientId&&k.productId===d.productId&&k.productRevision===d.productRevision);
        if(!row)throw new Error();const v=JSON.parse(row.content) as SourceContent;
        if(v.withdrawn||v.title!==source.title||v.text!==source.text)throw new Error();
      }
      const u=JSON.parse(r.usage);exactObject(u,['costStatus','inputTokens','outputTokens','reasoningTokens']);
      if(u.costStatus!=='unpriced')throw new Error();usage({inputTokens:u.inputTokens,outputTokens:u.outputTokens,reasoningTokens:u.reasoningTokens});
      if(r.status==='completed')parseKnowledgeSuggestions(r.result,d.sources);
    }
  });
}
export function mergeKnowledgeRuns(s:Store,data:BackupData,knowledge:KnowledgeRow[]) {
  const merged=new Map((data.aiRuns||[]).map(r=>[r.id,r]));
  for(const row of s.db.prepare("SELECT * FROM ai_runs WHERE purpose='knowledge'").all() as AIRun[]){
    const old=merged.get(row.id);
    if(old&&(['clientId','purpose','provider','model','revision','clientVersion','context','createdAt'] as const).some(k=>old[k]!==row[k]))throw new AppError('Sicherung widerspricht bekanntem Wissensauftrag.');
    if(old?.status==='completed'&&row.status==='completed'&&(old.result!==row.result||old.usage!==row.usage))throw new AppError('Sicherung widerspricht bekanntem Modellergebnis.');
    merged.set(row.id,old?.status==='completed'?old:row);
  }
  const aiRuns=[...merged.values()];validateKnowledgeRuns({...data,knowledge,aiRuns});return aiRuns;
}

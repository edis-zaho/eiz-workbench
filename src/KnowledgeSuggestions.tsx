import React,{useLayoutEffect,useRef,useState} from 'react';
import type {ClaimContent} from '../core/knowledge-input';
import {knowledgeCategories} from '../core/knowledge-input';
import type {knowledgeRuns} from '../core/knowledge-runs';
import type {Route} from '../core/brief';

type Runs=ReturnType<typeof knowledgeRuns>;
type Props={clientId:string;productId:string;productRevision:number;archived:boolean;sources:{id:string;title:string;text:string}[];api:(path:string,value?:unknown,method?:string)=>Promise<any>;onAdopt:()=>void};
const labels:Record<string,string>={feature:'Funktion',benefit:'Nutzen',use_case:'Anwendungsfall',proof:'Nachweis',objection:'Einwand / Antwort',hypothesis:'Hypothese',running:'Läuft',completed:'Vorschläge verfügbar',failed:'Verworfen / fehlgeschlagen',unknown:'Ergebnis unklar'};
export function KnowledgeSuggestions({clientId,productId,productRevision,archived,sources,api,onAdopt}:Props){
  const [runs,setRuns]=useState<Runs>([]),[route,setRoute]=useState<(Route&{revision:number})|null>(null),[chosen,setChosen]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[actor,setActor]=useState(''),[reason,setReason]=useState('');
  const [edits,setEdits]=useState<Record<string,ClaimContent>>({});const generation=useRef(0),lock=useRef(false);
  const base=`/api/clients/${clientId}/products/${productId}/knowledge-runs`,signature=sources.map(s=>s.id).join(',');
  useLayoutEffect(()=>{
    const g=++generation.current;lock.current=true;setBusy(true);setRuns([]);setRoute(null);setChosen([]);setConfirmed(false);setError('');setNotice('');setEdits({});setActor('');setReason('');
    Promise.all([api(base),api(`/api/clients/${clientId}/brief`)]).then(([r,b])=>{if(g===generation.current){setRuns(r);setRoute({...b.content.routes.analysis,revision:b.revision});}}).catch(()=>{if(g===generation.current)setError('Wissensvorschläge konnten nicht geladen werden.');}).finally(()=>{if(g===generation.current){lock.current=false;setBusy(false);}});
    return ()=>{generation.current++;};
  },[clientId,productId,productRevision,signature]);
  async function action(fn:(g:number)=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const g=generation.current;try{await fn(g);}catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Vorgang fehlgeschlagen.');}finally{if(g===generation.current){lock.current=false;setBusy(false);}}}
  const count=sources.filter(s=>chosen.includes(s.id)).reduce((sum,s)=>sum+s.text.length,0);
  return <section className="knowledge-suggestions" aria-label="KI-Wissensvorschläge">
    <h3>Wissensvorschläge aus deinen Quellen</h3>
    <p>Wähle gespeicherte Quellen dieses Produkts. Die KI schlägt Aussagen mit wörtlichen Belegen vor. Du prüfst und bearbeitest sie; eine Übernahme speichert ausschließlich einen Entwurf.</p>
    {error&&<div className="alert error" role="alert">{error}</div>}{notice&&<div className="alert success" role="status">{notice}</div>}
    <fieldset disabled={busy||archived}>
      <legend>Quellen und Modell</legend>
      {!sources.length&&<p>Speichere zuerst eine aktuelle Produktquelle im Bereich oben.</p>}
      {sources.map(s=><label className="knowledge-check" key={s.id}><input type="checkbox" aria-label={`KI-Quelle ${s.title}`} checked={chosen.includes(s.id)} onChange={e=>{setChosen(e.target.checked?[...chosen,s.id]:chosen.filter(id=>id!==s.id));setConfirmed(false);}}/>{s.title} · {s.text.length.toLocaleString('de-DE')} Zeichen</label>)}
      <p>{chosen.length} von höchstens 8 Quellen · {count.toLocaleString('de-DE')} Textzeichen. Übertragen werden Titel und vollständige gespeicherte Quellentexte, keine ungespeicherten Änderungen.</p>
      <p>Analysemodell aus deinem Kundenrahmen: <strong>{route?.provider} / {route?.model||'noch nicht festgelegt'}</strong>. Den API-Schlüssel hinterlegst du unter „Modelle“.</p>
      <label className="knowledge-check"><input type="checkbox" aria-label="KI-Quellenübertragung bestätigen" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Diese Quellen an den genannten Anbieter übertragen. Es gelten dessen API-Kosten; das Tageslimit im Kundenrahmen zählt mit.</label>
      <button type="button" className="primary" disabled={!route?.model||!confirmed||chosen.length<1||chosen.length>8||count>60000} onClick={()=>action(async g=>{
        const result=await window.workbench.extractKnowledge({clientId,productId,productRevision,sourceIds:chosen,briefRevision:route!.revision,confirmed:true});
        if(g!==generation.current)return;setRuns(result);setConfirmed(false);setNotice('Aufruf abgeschlossen. Ergebnis unten prüfen; es wurde keine Aussage freigegeben.');
      })}>Wissensvorschläge anfordern</button>
    </fieldset>
    <button type="button" className="secondary" disabled={busy} onClick={()=>action(async g=>{const [r,b]=await Promise.all([api(base),api(`/api/clients/${clientId}/brief`)]);if(g!==generation.current)return;setRuns(r);setRoute({...b.content.routes.analysis,revision:b.revision});setConfirmed(false);})}>Vorschläge und Modellstand neu laden</button>
    {runs.length>0&&<fieldset disabled={busy||archived}><legend>Entwurf bewusst übernehmen</legend><label>Dein Name<input aria-label="KI-Entwurf Betreiber" maxLength={120} value={actor} onChange={e=>setActor(e.target.value)}/></label><label>Prüfung / Anpassung begründen<textarea aria-label="KI-Entwurf Begründung" maxLength={1500} value={reason} onChange={e=>setReason(e.target.value)}/></label></fieldset>}
    {runs.map(run=><article className="knowledge-run" key={run.id}>
      <h4>{run.provider} / {run.model} · {labels[run.status]||run.status}</h4>
      <p>{new Date(run.createdAt).toLocaleString()} · Produktversion {run.productRevision}</p>
      <p>Tokens laut Anbieter: Eingabe {String(run.usage.inputTokens??'unbekannt')}, Ausgabe {String(run.usage.outputTokens??'unbekannt')}, Reasoning {String(run.usage.reasoningTokens??'unbekannt')}. Tatsächliche Kosten unbekannt; beim Anbieter prüfen.</p>
      {run.stale&&<p role="status">{run.stale} Die Historie bleibt lesbar.</p>}{run.message&&<p>{run.message}</p>}
      {run.status==='completed'&&!run.suggestions.length&&<p>Keine belegten Vorschläge zurückgegeben. Es wurde nichts übernommen.</p>}
      <details><summary>Quellen dieses Aufrufs lesen</summary>{run.sources.map(s=><div key={s.id}><strong>{s.title}</strong><pre>{s.text}</pre></div>)}</details>
      {run.suggestions.map(suggestion=>{const key=`${run.id}:${suggestion.index}`,content=edits[key]||suggestion.content,source=run.sources.find(s=>s.id===content.sourceId);return <fieldset key={key} disabled={busy||archived||!!run.stale||!!suggestion.entityId}>
        <legend>Vorschlag {suggestion.index+1}{suggestion.entityId?' · Bereits als Entwurf übernommen':''}</legend>
        <label>Kategorie<select aria-label={`KI-Kategorie ${suggestion.index+1}`} value={content.category} onChange={e=>setEdits({...edits,[key]:{...content,category:e.target.value as ClaimContent['category']}})}>{knowledgeCategories.map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></label>
        <label>Aussage<textarea aria-label={`KI-Aussage ${suggestion.index+1}`} maxLength={3000} value={content.text} onChange={e=>setEdits({...edits,[key]:{...content,text:e.target.value}})}/></label>
        <p>Belegquelle: {source?.title}. Prüfe die inhaltliche Ableitung; ein wörtliches Zitat allein beweist keine Aussage.</p>
        <label>Wörtlicher Beleg<textarea aria-label={`KI-Beleg ${suggestion.index+1}`} maxLength={3000} value={content.quote} onChange={e=>setEdits({...edits,[key]:{...content,quote:e.target.value}})}/></label>
        <button type="button" className="secondary" disabled={!actor.trim()||!reason.trim()||!content.text.trim()||!content.quote.trim()} onClick={()=>action(async g=>{
          await api(`${base}/${run.id}/adopt`,{index:suggestion.index,content,actor,reason});if(g!==generation.current)return;
          const r=await api(base);if(g!==generation.current)return;setRuns(r);setNotice('Entwurf gespeichert. Wähle ihn oben unter „Aussage auswählen“, prüfe ihn und gib ihn bei Bedarf separat frei.');onAdopt();
        })}>Vorschlag {suggestion.index+1} als Entwurf übernehmen</button>
      </fieldset>;})}
    </article>)}
  </section>;
}

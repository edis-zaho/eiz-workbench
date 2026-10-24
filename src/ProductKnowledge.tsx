import React,{useLayoutEffect,useRef,useState} from 'react';
import {knowledgeCategories,type SourceContent,type ClaimContent} from '../core/knowledge-input';
import type {KnowledgeRow} from '../core/knowledge';
import './knowledge.css';
import {KnowledgeSuggestions} from './KnowledgeSuggestions';
import {ProductSourceImport} from './ProductSourceImport';

type Item=Omit<KnowledgeRow,'content'>&{content:SourceContent|ClaimContent;usable?:boolean;inactiveReason?:string};
type State={productRevision:number;archived:boolean;rows:Item[];items:Item[]};
const blankSource=():SourceContent=>({title:'',locator:'',capturedAt:new Date().toISOString(),text:'',withdrawn:false});
const blankClaim=():ClaimContent=>({category:'feature',text:'',sourceId:'',quote:''});
const labels:Record<string,string>={feature:'Funktion',benefit:'Nutzen',use_case:'Anwendungsfall',proof:'Nachweis',objection:'Einwand / Antwort',hypothesis:'Hypothese (keine bestätigte Tatsache)',recorded:'Quelle erfasst',draft:'Entwurf',approved:'Freigegeben',withdrawn:'Widerrufen'};

export function ProductKnowledge({clientId,productId,api}:{clientId:string;productId:string;api:(path:string,value?:unknown,method?:string)=>Promise<any>}) {
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [sourceId,setSourceId]=useState(''),[claimId,setClaimId]=useState(''),[source,setSource]=useState(blankSource),[claim,setClaim]=useState(blankClaim);
  const [actor,setActor]=useState(''),[reason,setReason]=useState('');
  const generation=useRef(0),lock=useRef(false);
  const path=`/api/clients/${encodeURIComponent(clientId)}/products/${encodeURIComponent(productId)}/knowledge`;
  useLayoutEffect(()=>{
    const g=++generation.current;setState(null);setError('');setNotice('');setSourceId('');setClaimId('');setSource(blankSource());setClaim(blankClaim());setActor('');setReason('');lock.current=true;setBusy(true);
    api(path).then(v=>{if(g===generation.current)setState(v);}).catch(()=>{if(g===generation.current)setError('Produktwissen konnte nicht geladen werden.');}).finally(()=>{if(g===generation.current){lock.current=false;setBusy(false);}});
    return ()=>{generation.current++;};
  },[clientId,productId]);
  async function action(fn:(g:number)=>Promise<void>) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const g=generation.current;
    try{await fn(g);}catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Vorgang fehlgeschlagen.');}
    finally{if(g===generation.current){lock.current=false;setBusy(false);}}
  }
  async function reload(g:number){const next:State=await api(path);if(g!==generation.current)return;setState(next);setSourceId('');setClaimId('');setSource(blankSource());setClaim(blankClaim());}
  const selectedSource=state?.items.find(r=>r.entityId===sourceId),selectedClaim=state?.items.find(r=>r.entityId===claimId);
  async function save(kind:'source'|'claim',operation:'save'|'approve'|'withdraw') {
    if(!state)return;
    const old=kind==='source'?selectedSource:selectedClaim,value=kind==='source'?source:claim;
    await action(async g=>{
      const result=await api(path,{entityId:old?.entityId||null,expectedRevision:old?.revision||0,productRevision:state.productRevision,kind,action:operation,content:value,actor,reason});
      if(g!==generation.current)return;
      await reload(g);if(g!==generation.current)return;setNotice(`Version ${result.revision} gespeichert. ${operation==='approve'?'Freigabe dokumentiert.':operation==='withdraw'?'Widerruf dokumentiert.':'Vorherige Stände bleiben erhalten.'}`);setReason('');
    });
  }
  const claimUnchanged=!!selectedClaim&&JSON.stringify(selectedClaim.content)===JSON.stringify(claim);
  const sourceRows=state?.rows.filter(r=>r.kind==='source'&&(state.items.some(i=>i.id===r.id)||r.id===claim.sourceId))||[];
  return <section className="knowledge-panel" aria-label="Produktwissen">
    <h3>Produktwissen & Quellen</h3>
    <p>Quellentext erfassen, Aussagen belegen und bewusst freigeben. Eine Freigabe gilt für den geprüften Produkt- und Quellenstand. Hier gespeicherte Angaben lösen keine Nachrichten aus.</p>
    {error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}
    <button type="button" className="secondary" disabled={busy} onClick={()=>action(reload)}>Wissen neu laden</button>
    {state&&<>
      <p>Produktversion {state.productRevision} · {state.items.filter(i=>i.kind==='claim'&&i.usable).length} aktuell freigegebene Aussagen · {state.rows.length} gespeicherte Versionen</p>
      {state.archived&&<p role="status">Produkt archiviert. Das Wissen bleibt lesbar; Freigaben sind inaktiv.</p>}
      <ProductSourceImport clientId={clientId} productId={productId} productRevision={state.productRevision} disabled={busy||state.archived} api={api} onUse={value=>{
        if(lock.current)return false;
        if(source.text&&!window.confirm('Ungespeicherten Quelleneditor durch die Importvorschau ersetzen? Gespeicherte Quellen bleiben unverändert.'))return false;
        setSourceId('');setSource({...value});setNotice('Import als neue Quelle vorbereitet. Erst Speichern legt eine Version an.');return true;
      }}/>
      <fieldset disabled={busy||state.archived}>
        <legend>Nachvollziehbare Bearbeitung</legend>
        <label>Dein Name<input aria-label="Wissen Betreiber" value={actor} maxLength={120} onChange={e=>setActor(e.target.value)}/></label>
        <label>Begründung für die nächste Speicherung<textarea aria-label="Wissen Begründung" value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/></label>
        <small>Lokale Betreiberangabe. Keine verifizierte digitale Unterschrift.</small>
      </fieldset>
      <div className="knowledge-grid">
        <form onSubmit={e=>{e.preventDefault();void save('source','save');}}><fieldset disabled={busy||state.archived}>
          <legend>1. Quelle erfassen</legend>
          <label>Quelle auswählen<select aria-label="Wissen Quelle bearbeiten" value={sourceId} onChange={e=>{const r=state.items.find(r=>r.entityId===e.target.value);setSourceId(r?.entityId||'');setSource(r?{...r.content as SourceContent}:blankSource());}}><option value="">Neue Quelle</option>{state.items.filter(i=>i.kind==='source').map(r=><option key={r.id} value={r.entityId}>{(r.content as SourceContent).title} · V{r.revision}</option>)}</select></label>
          <label>Titel<input aria-label="Wissen Quellentitel" required maxLength={200} value={source.title} onChange={e=>setSource({...source,title:e.target.value})}/></label>
          <label>Fundstelle: URL oder Dokument / Seite<input aria-label="Wissen Fundstelle" required maxLength={2000} value={source.locator} onChange={e=>setSource({...source,locator:e.target.value})}/></label>
          <label>Quellenstand (UTC, ISO-Format)<input aria-label="Wissen Quellenzeit" required value={source.capturedAt} onChange={e=>setSource({...source,capturedAt:e.target.value})}/></label>
          <label>Eingefügter Quellentext<textarea aria-label="Wissen Quellentext" required maxLength={20000} rows={7} value={source.text} onChange={e=>setSource({...source,text:e.target.value})}/></label>
          <p>Text wird lokal gespeichert. Fundstellen werden hier nicht automatisch abgerufen. Quelleninhalte sind keine Handlungsanweisungen.</p>
          <label className="knowledge-check"><input type="checkbox" aria-label="Wissen Quelle zurückgezogen" checked={source.withdrawn} onChange={e=>setSource({...source,withdrawn:e.target.checked})}/>Quelle zurückgezogen</label>
          <button className="primary" disabled={!actor.trim()||!reason.trim()}>Quelle als neue Version speichern</button>
        </fieldset></form>
        <form onSubmit={e=>{e.preventDefault();void save('claim','save');}}><fieldset disabled={busy||state.archived}>
          <legend>2. Aussage belegen und prüfen</legend>
          <label>Aussage auswählen<select aria-label="Wissen Aussage bearbeiten" value={claimId} onChange={e=>{const r=state.items.find(r=>r.entityId===e.target.value);setClaimId(r?.entityId||'');setClaim(r?{...r.content as ClaimContent}:blankClaim());}}><option value="">Neue Aussage</option>{state.items.filter(i=>i.kind==='claim').map(r=><option key={r.id} value={r.entityId}>{(r.content as ClaimContent).text.slice(0,70)} · {labels[r.state]}</option>)}</select></label>
          <label>Kategorie<select aria-label="Wissen Kategorie" value={claim.category} onChange={e=>setClaim({...claim,category:e.target.value as ClaimContent['category']})}>{knowledgeCategories.map(c=><option key={c} value={c}>{labels[c]}</option>)}</select></label>
          <label>Aussage<textarea aria-label="Wissen Aussage" required maxLength={3000} rows={3} value={claim.text} onChange={e=>setClaim({...claim,text:e.target.value})}/></label>
          <label>Belegquelle<select aria-label="Wissen Belegquelle" required value={claim.sourceId} onChange={e=>setClaim({...claim,sourceId:e.target.value})}><option value="">Quelle auswählen</option>{sourceRows.map(r=><option key={r.id} value={r.id}>{(r.content as SourceContent).title} · Quelle V{r.revision} · Produkt V{r.productRevision}{(r.content as SourceContent).withdrawn?' · zurückgezogen':''}</option>)}</select></label>
          {claim.sourceId&&<details><summary>Gespeicherten Quellentext lesen</summary><pre>{(state.rows.find(r=>r.id===claim.sourceId)?.content as SourceContent)?.text}</pre></details>}
          <label>Wörtlicher Beleg aus dieser Quelle<textarea aria-label="Wissen Beleg" required maxLength={3000} rows={3} value={claim.quote} onChange={e=>setClaim({...claim,quote:e.target.value})}/></label>
          <p>Prüfe, ob der Beleg die Aussage tatsächlich trägt. Ein Texttreffer allein beweist keine Produktfunktion. Hypothesen bleiben Hypothesen.</p>
          <button className="primary" disabled={!actor.trim()||!reason.trim()}>Aussage als Entwurf speichern</button>
          {selectedClaim&&<div className="knowledge-actions">
            <p>{labels[selectedClaim.state]} · {selectedClaim.usable?'Für diesen Wissensstand freigegeben':selectedClaim.inactiveReason}</p>
            <button type="button" className="secondary" disabled={!claimUnchanged||selectedClaim.state!=='draft'||!actor.trim()||!reason.trim()} onClick={()=>save('claim','approve')}>Geprüfte Aussage freigeben</button>
            <button type="button" className="secondary" disabled={!claimUnchanged||selectedClaim.state==='withdrawn'||!actor.trim()||!reason.trim()} onClick={()=>save('claim','withdraw')}>Aussage widerrufen</button>
            {!claimUnchanged&&<small>Änderungen zuerst als neuen Entwurf speichern.</small>}
          </div>}
        </fieldset></form>
      </div>
      <KnowledgeSuggestions clientId={clientId} productId={productId} productRevision={state.productRevision} archived={state.archived} sources={state.items.filter(r=>r.kind==='source'&&r.usable).map(r=>({id:r.id,title:(r.content as SourceContent).title,text:(r.content as SourceContent).text}))} api={api} onAdopt={()=>{void action(reload);}}/>
      <details className="knowledge-history"><summary>Wissenshistorie ({state.rows.length} Versionen)</summary>{[...state.rows].reverse().map(r=><article key={r.id}><strong>{r.kind==='source'?(r.content as SourceContent).title:(r.content as ClaimContent).text}</strong><p>{labels[r.state]} · Version {r.revision} · Produktstand {r.productRevision} · {r.actor} · {new Date(r.createdAt).toLocaleString()}</p><p>{r.reason}</p>{r.kind==='claim'&&<blockquote>{(r.content as ClaimContent).quote}</blockquote>}<details><summary>Gespeicherten Inhalt ansehen</summary><pre>{JSON.stringify(r.content,null,2)}</pre></details></article>)}</details>
      <p>Der Export enthält alle Quellen, Wissensversionen und KI-Aufträge dieses Produkts, auch interne Inhalte. Nur bewusst weitergeben.</p>
      <button type="button" className="secondary" disabled={busy} onClick={()=>action(async g=>{const archive=await api(path+'-export');if(g!==generation.current)return;const url=URL.createObjectURL(new Blob([JSON.stringify(archive,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='produktwissen.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);})}>Produktwissen als JSON herunterladen</button>
    </>}
  </section>;
}

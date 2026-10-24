import {useLayoutEffect,useRef,useState} from 'react';
import type {CampaignContent} from '../core/campaign';
import type {experimentState} from '../core/experiments';
import type {strategyState} from '../core/strategy';
import type {campaignExperiment} from '../core/campaign-experiment';
export type BoundExperiment=ReturnType<typeof campaignExperiment>;
export function ExperimentDetails({experiment}:{experiment:BoundExperiment}){
  if(!experiment)return null;
  return <div className="campaign-experiment-summary"><p><strong>Experiment: {experiment.name}</strong> · {experiment.companies} Unternehmen · {experiment.contacts} fest zugeteilte Kontakte · {experiment.state==='closed'?'Geschlossen':'Geplant'}</p><small>Fester Testarm. Änderungen am Experiment können eine bestehende Versandfreigabe sperren.</small>{experiment.problems.map(p=><p className="alert error" key={p}>{p}</p>)}</div>;
}
export function CampaignExperiment({clientId,campaignId,form,locked,disabled,api,onChange}:{clientId:string;campaignId?:string;form:CampaignContent;locked:boolean;disabled:boolean;api:(p:string)=>Promise<any>;onChange:(c:CampaignContent)=>void}){
  const [plans,setPlans]=useState<ReturnType<typeof experimentState>|null>(null),[strategy,setStrategy]=useState<ReturnType<typeof strategyState>|null>(null),[selection,setSelection]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const generation=useRef(0),ref=form.productRef;
  useLayoutEffect(()=>{
    const g=++generation.current;setPlans(null);setStrategy(null);setSelection('');setError('');setLoading(!!ref);
    if(ref)Promise.all([api(`/api/clients/${clientId}/products/${ref.productId}/experiments`),api(`/api/clients/${clientId}/products/${ref.productId}/strategy`)]).then(([p,s])=>{if(g===generation.current){setPlans(p);setStrategy(s);}}).catch(()=>{if(g===generation.current)setError('Testgruppen konnten nicht geladen werden. Bestehende Bindung bleibt erhalten.');}).finally(()=>{if(g===generation.current)setLoading(false);});
    return()=>{generation.current++;};
  },[clientId,ref?.productId,ref?.revision,refresh]);
  if(!ref)return null;
  const options=(plans?.items||[]).flatMap(p=>p.content.input.hypothesisIds.map(id=>({p,id,key:p.experimentId+':'+id,h:strategy?.rows.find(r=>r.id===id),owner:p.campaigns.find(c=>c.hypothesisId===id)})));
  const unavailable=(o:typeof options[number])=>o.p.state!=='planned'||!!o.p.problems.length||o.p.content.input.productRevision!==ref.revision||!o.h||!!o.owner&&o.owner.id!==campaignId;
  const selected=options.find(o=>o.key===selection),bound=options.find(o=>o.p.experimentId===form.experimentId&&o.id===form.hypothesisId);
  return <section className="campaign-experiment" aria-label="Testgruppe der Kampagne"><h3>Gespeicherte Testgruppe übernehmen</h3><p>Wähle einen geprüften Experimentarm. Die Übernahme ersetzt Kontakte und Hypothese und ergänzt deren Produktfakten. Nachrichtentexte und Versandrahmen bleiben erhalten. Pro Testarm ist eine Kampagne vorgesehen; nach dem Speichern bleibt diese Bindung fest.</p>
    {error&&<p role="alert" className="alert error">{error}</p>}{loading&&<p role="status">Testgruppen werden geladen …</p>}
    <button type="button" className="secondary" disabled={disabled||loading} onClick={()=>setRefresh(n=>n+1)}>Testgruppen aktualisieren</button>
    {form.experimentId?<><p><strong>{bound?.p.content.input.name||'Gespeicherter Experimentplan'}</strong> · {bound?.h?.content.name||form.hypothesisId} · {form.leadIds.length} Kontakte</p>{bound?.p.problems.map(p=><p role="alert" className="alert error" key={p}>{p}</p>)}{bound?.p.state==='closed'&&<p role="alert" className="alert error">Experimentplan geschlossen. Versand ist gesperrt.</p>}{!locked&&<button type="button" className="secondary" disabled={disabled} onClick={()=>{const {experimentId:old,...rest}=form;onChange(rest);}}>Noch ungespeicherte Experimentbindung entfernen</button>}</>:<>
      <label>Experiment und Testarm<select aria-label="Kampagnen-Testgruppe" value={selection} disabled={disabled||loading||!plans} onChange={e=>{setSelection(e.target.value);setError('');}}><option value="">Testgruppe auswählen</option>{options.map(o=><option key={o.key} value={o.key} disabled={unavailable(o)}>{o.p.content.input.name} · {o.h?.content.name||o.id} · {o.p.content.allocation.groups.filter(g=>g.hypothesisId===o.id).length} Unternehmen{o.owner&&o.owner.id!==campaignId?' · Kampagne vorhanden':unavailable(o)?' · erneut prüfen':''}</option>)}</select></label>
      <button type="button" className="secondary" disabled={disabled||!selected||unavailable(selected)} onClick={()=>{
        if(!selected||unavailable(selected))return;
        const knowledgeIds=[...new Set([...(form.knowledgeIds||[]),...selected.h!.content.knowledgeIds])].sort();
        if(knowledgeIds.length>20){setError('Mehr als 20 Produktfakten. Zuerst nicht benötigte Fakten entfernen.');return;}
        onChange({...form,experimentId:selected.p.experimentId,hypothesisId:selected.id,knowledgeIds,leadIds:selected.p.content.allocation.groups.filter(g=>g.hypothesisId===selected.id).flatMap(g=>g.leadIds).sort()});
      }}>Testgruppe in den Entwurf übernehmen</button>
    </>}
  </section>;
}

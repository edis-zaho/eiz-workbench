import {useLayoutEffect,useRef,useState} from 'react';
import type {CampaignContent} from '../core/campaign';
import type {HypothesisContent,PersonaContent} from '../core/strategy-input';
import type {campaignStrategy} from '../core/campaign-strategy';

export type BoundHypothesis=ReturnType<typeof campaignStrategy>;
type Row={id:string;entityId:string;revision:number;productRevision:number;kind:string;state:string;content:HypothesisContent|PersonaContent;usable?:boolean;inactiveReason?:string};
type State={productRevision:number;archived:boolean;paused:boolean;items:Row[];rows:Row[]};
export function HypothesisDetails({hypothesis}:{hypothesis:BoundHypothesis}){
  if(!hypothesis)return null;
  const h=hypothesis.content,p=hypothesis.persona;
  return <div className="campaign-hypothesis-summary"><p><strong>{h.name}</strong> · feste Hypothesenversion {hypothesis.revision}</p>
    <p>Persona: {p.content.name} ({p.content.code}) · Version {p.revision}</p>
    <p><strong>Zielgruppe:</strong> {h.segment}<br/><strong>Problem:</strong> {h.pain}<br/><strong>Angle:</strong> {h.angle}<br/><strong>Erwarteter Nutzen:</strong> {h.benefit}</p>
    <p><strong>Handlungsaufforderung:</strong> {h.cta}<br/><strong>Nachrichtenstil:</strong> {h.style}</p>
    {!hypothesis.usable&&<p className="alert error">Erneut prüfen: {hypothesis.inactiveReason}</p>}
  </div>;
}
export function CampaignStrategy({clientId,form,disabled,api,onChange}:{clientId:string;form:CampaignContent;disabled:boolean;api:(path:string)=>Promise<any>;onChange:(content:CampaignContent)=>void}){
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const generation=useRef(0),ref=form.productRef;
  useLayoutEffect(()=>{
    const g=++generation.current;setState(null);setError('');setLoading(!!ref);
    if(ref)api(`/api/clients/${clientId}/products/${ref.productId}/strategy`).then(s=>{if(g===generation.current)setState(s);}).catch(()=>{if(g===generation.current)setError('Hypothesen konnten nicht geladen werden. Die gespeicherte Auswahl bleibt erhalten.');}).finally(()=>{if(g===generation.current)setLoading(false);});
    return()=>{generation.current++;};
  },[clientId,ref?.productId,ref?.revision,refresh]);
  if(!ref)return null;
  const current=state?.items.filter(r=>r.kind==='hypothesis'&&r.state==='approved')||[];
  const selected=state?.rows.find(r=>r.id===form.hypothesisId&&r.kind==='hypothesis');
  const rows=selected&&!current.some(r=>r.id===selected.id)?[...current,selected]:current;
  const usable=(r:Row)=>r.usable===true&&r.productRevision===ref.revision&&state?.productRevision===ref.revision&&!state?.archived&&!state?.paused;
  const latest=state?.items.find(r=>r.entityId===selected?.entityId);
  const content=selected?.content as HypothesisContent|undefined;
  const persona=state?.rows.find(r=>r.id===content?.personaId&&r.kind==='persona');
  const reason=latest?.id!==selected?.id?'Hypothese inzwischen geändert':latest?.inactiveReason||(!latest||!usable(latest)?'Derzeit nicht verwendbar':'');
  return <section className="campaign-strategy" aria-label="Hypothese des Kampagnenplans">
    <h3>Welche Hypothese testet diese Kampagne?</h3>
    <p>Verbinde den Plan mit einer ausdrücklich freigegebenen Persona und Ansprache. Die nötigen Produktfakten werden bei der Auswahl ergänzt. Kontakte und Nachrichtentexte bleiben unverändert; gleiche sie mit der Hypothese ab.</p>
    {error&&<p role="alert" className="alert error">{error}</p>}{loading&&<p role="status">Hypothesen werden geladen …</p>}
    <button type="button" className="secondary" disabled={disabled||loading} onClick={()=>setRefresh(n=>n+1)}>Kampagnenhypothesen aktualisieren</button>
    <label>Freigegebene Hypothese<select aria-label="Kampagnenhypothese" value={form.hypothesisId||''} disabled={disabled||loading||!state} onChange={e=>{
      const id=e.target.value;setError('');
      if(!id){const {hypothesisId:old,...rest}=form;onChange(rest);return;}
      const row=current.find(r=>r.id===id);if(!row||!usable(row))return;
      const knowledgeIds=[...new Set([...(form.knowledgeIds||[]),...(row.content as HypothesisContent).knowledgeIds])].sort();
      if(knowledgeIds.length>20){setError('Zusammen wären mehr als 20 Produktfakten ausgewählt. Entferne zuerst nicht benötigte Aussagen. Die Hypothese wurde nicht geändert.');return;}
      onChange({...form,hypothesisId:id,knowledgeIds});
    }}><option value="">Ohne Hypothesenbindung</option>{rows.map(r=><option key={r.id} value={r.id} disabled={!usable(r)}>{r.content.name} · Version {r.revision}{!usable(r)?' · erneut prüfen':''}</option>)}{form.hypothesisId&&!rows.some(r=>r.id===form.hypothesisId)&&<option value={form.hypothesisId} disabled>Gespeicherte Hypothese nicht verfügbar</option>}</select></label>
    {selected&&content&&persona&&<HypothesisDetails hypothesis={{id:selected.id,entityId:selected.entityId,revision:selected.revision,content,persona:{id:persona.id,revision:persona.revision,content:persona.content as PersonaContent},usable:!reason,inactiveReason:reason}}/>}
    {content&&content.knowledgeIds.some(id=>!form.knowledgeIds?.includes(id))&&<p role="alert" className="alert error">Erforderliche Produktfakten fehlen. Wähle sie unten wieder aus oder entferne die Hypothesenbindung.</p>}
    <small>Änderung oder Widerruf von Hypothese, Persona oder Fakten erfordert eine neue Planprüfung. Das Entfernen der Hypothese entfernt keine Fakten. Gespeicherte Experimentgruppen lassen sich oben ausdrücklich übernehmen.</small>
  </section>;
}

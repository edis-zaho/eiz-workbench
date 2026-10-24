import {useLayoutEffect,useRef,useState} from 'react';
import type {ProductReference} from '../core/campaign';
type Row={id:string;entityId:string;revision:number;productRevision:number;kind:string;state:string;usable?:boolean;inactiveReason?:string;content:{category?:string;text?:string;quote?:string}};
type State={productRevision:number;archived:boolean;rows:Row[];items:Row[]};
export function CampaignKnowledge({clientId,productRef,ids=[],disabled,api,onChange}:{clientId:string;productRef?:ProductReference;ids?:string[];disabled:boolean;api:(path:string)=>Promise<any>;onChange:(ids:string[])=>void}){
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const generation=useRef(0);
  useLayoutEffect(()=>{
    const g=++generation.current;setState(null);setError('');setLoading(!!productRef);
    if(productRef)api(`/api/clients/${clientId}/products/${productRef.productId}/knowledge`).then(s=>{if(g===generation.current)setState(s);}).catch(()=>{if(g===generation.current)setError('Produktwissen konnte nicht geladen werden. Die gespeicherte Auswahl bleibt erhalten.');}).finally(()=>{if(g===generation.current)setLoading(false);});
    return()=>{generation.current++;};
  },[clientId,productRef?.productId,productRef?.revision,refresh]);
  if(!productRef)return <p>Für belegte Kampagnenaussagen zuerst ein Produkt auswählen.</p>;
  const current=state?.items.filter(r=>r.kind==='claim'&&r.state==='approved'&&r.content.category!=='hypothesis')||[];
  const rows=[...current,...(state?.rows.filter(r=>ids.includes(r.id)&&!current.some(c=>c.id===r.id))||[])];
  const usable=(r:Row)=>r.usable===true&&r.productRevision===productRef.revision&&state?.productRevision===productRef.revision&&!state?.archived;
  return <section className="campaign-knowledge" aria-label="Kampagnenwissen">
    <h3>Freigegebene Produktfakten für diese Kampagne</h3>
    <p>Wähle bis zu 20 belegte Aussagen als Grundlage deiner Nachrichten. Ihre Versionen werden mit dem Plan gespeichert. Die Auswahl verändert keine Nachrichtentexte; prüfe deren Inhalt selbst. Die oben gewählte Hypothese benötigt ihre vollständige Faktenbasis.</p>
    <p>Ändert sich eine ausgewählte Aussage, ihre Quelle oder der Produktstand, muss die Kampagne erneut geprüft werden. Andere neue Aussagen werden nicht automatisch ergänzt.</p>
    {error&&<p role="alert" className="alert error">{error}</p>}
    {loading&&<p role="status">Freigegebene Aussagen werden geladen …</p>}
    <button type="button" className="secondary" disabled={disabled||loading} onClick={()=>setRefresh(n=>n+1)}>Kampagnenwissen aktualisieren</button>
    <fieldset disabled={disabled||loading||!!error}><legend>{ids.length} Aussagen ausgewählt</legend>
      {!loading&&state&&!rows.length&&<p>Noch keine freigegebenen Produktfakten. Im Produktwissen zuerst Aussagen mit Beleg speichern und freigeben.</p>}
      {rows.map(r=><div className="source" key={r.id}><label className="toggle-row"><input type="checkbox" aria-label={`Kampagnenaussage ${r.id}`} checked={ids.includes(r.id)} disabled={!ids.includes(r.id)&&(!usable(r)||ids.length>=20)} onChange={e=>onChange(e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/>{r.content.text}</label><small>Feste Aussageversion {r.revision}{!usable(r)?' · '+(r.inactiveReason||'Nicht mehr aktuell verwendbar'):''}</small><p>Beleg: {r.content.quote}</p></div>)}
      {ids.filter(id=>state&&!rows.some(r=>r.id===id)).map(id=><p key={id}>Gespeicherte Aussage fehlt: {id} <button type="button" className="text-button" onClick={()=>onChange(ids.filter(v=>v!==id))}>Aus Auswahl entfernen</button></p>)}
    </fieldset>
    <small>Ohne Auswahl bleibt die Kampagne ohne belegte Wissensbindung. Eine Auswahl ersetzt weder Planprüfung noch Versandfreigabe.</small>
  </section>;
}

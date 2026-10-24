import {useEffect,useRef,useState} from 'react';
import type {ProductReference} from '../core/campaign';
type Product={productId:string;revision:number;name:string;archived:boolean};
const key=(p:ProductReference)=>`${p.productId}:${p.revision}`;

export function CampaignProduct({clientId,value,onChange,api,disabled}:{clientId:string;value?:ProductReference;onChange:(value?:ProductReference)=>void;api:(path:string)=>Promise<any>;disabled:boolean}) {
  const [products,setProducts]=useState<Product[]>([]),[selected,setSelected]=useState<Product|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  const generation=useRef(0);
  useEffect(()=>{
    const g=++generation.current;setLoading(true);setError('');setSelected(null);
    (async()=>{
      const catalog=await api(`/api/clients/${clientId}/catalog`);
      let saved=value?catalog.products.find((p:Product)=>key(p)===key(value)):null;
      if(value&&!saved){const rows=await api(`/api/clients/${clientId}/products/${value.productId}/history`);saved=rows.find((p:Product)=>p.revision===value.revision);}
      if(g===generation.current){setProducts(catalog.products);setSelected(saved||null);}
    })().catch(()=>{if(g===generation.current)setError('Produktversionen konnten nicht geladen werden. Eine vorhandene Zuordnung bleibt erhalten.');}).finally(()=>{if(g===generation.current)setLoading(false);});
    return ()=>{generation.current++;};
  },[clientId,value?.productId,value?.revision,refresh]);
  const selectedKey=value?key(value):'';
  return <div className="campaign-product">
    <label>Produkt und feste Version<select aria-label="Kampagnenprodukt" value={selectedKey} disabled={disabled||loading} onChange={e=>{
      if(!e.target.value){onChange();return;}
      const p=products.find(p=>key(p)===e.target.value);if(p)onChange({productId:p.productId,revision:p.revision});
    }}>
      <option value="">Ohne Produktzuordnung</option>
      {value&&!products.some(p=>key(p)===selectedKey)&&<option value={selectedKey}>{selected?.name||'Gespeicherte Produktzuordnung'} · Version {value.revision} (beibehalten)</option>}
      {products.map(p=><option key={key(p)} value={key(p)} disabled={p.archived&&key(p)!==selectedKey}>{p.name} · Version {p.revision}{p.archived?' · archiviert':''}</option>)}
    </select></label>
    <button type="button" className="secondary" disabled={disabled||loading} onClick={()=>setRefresh(r=>r+1)}>Produktversionen aktualisieren</button>
    <small>{value?'Diese Version wird mit dem Kampagnenplan gespeichert. Spätere Produktänderungen ersetzen sie nicht automatisch.':'Ohne Auswahl bleiben Ergebnisse produktseitig unzugeordnet.'} Die Auswahl ändert keine Nachrichtentexte und ersetzt keine Inhaltsprüfung.</small>
    {error&&<p role="alert" className="alert error">{error}</p>}
  </div>;
}

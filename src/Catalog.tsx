import {ProductExperiments} from './ProductExperiments';
import {ProductStrategy} from './ProductStrategy';
import React,{useState,useLayoutEffect,useRef} from 'react';
import type {ProductInput,AccountInput} from '../core/catalog-input';
import './catalog.css';
import {ProductKnowledge} from './ProductKnowledge';
type Product=ProductInput&{productId:string;revision:number;createdAt:string};
type Account=AccountInput&{accountId:string;revision:number};
type Link={leadId:string;accountId:string|null;revision:number};
type State={products:Product[];accounts:Account[];links:Link[]};
const blankProduct:ProductInput={name:'',description:'',website:'',bookingUrl:'',archived:false};

export function Catalog({clientId,api}:{clientId:string;api:(path:string,value?:unknown,method?:string)=>Promise<any>}) {
  const [state,setState]=useState<State>({products:[],accounts:[],links:[]});
  const [leads,setLeads]=useState<{id:string;email:string;company:string}[]>([]);
  const [product,setProduct]=useState<ProductInput>(blankProduct),[productId,setProductId]=useState<string|null>(null),[productRevision,setProductRevision]=useState(0);
  const [account,setAccount]=useState<AccountInput>({name:'',domain:''}),[accountId,setAccountId]=useState<string|null>(null),[accountRevision,setAccountRevision]=useState(0);
  const [leadId,setLeadId]=useState(''),[targetAccount,setTargetAccount]=useState(''),[linkRevision,setLinkRevision]=useState(0);
  const [history,setHistory]=useState<Product[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0),lock=useRef(false),loadVersion=useRef(0);
  const prefix=`/api/clients/${encodeURIComponent(clientId)}`;
  const load=async(g:number)=>{
    const version=++loadVersion.current;
    const [catalog,contacts]=await Promise.all([api(prefix+'/catalog'),api(prefix+'/campaign-leads')]);
    if(g===generation.current&&version===loadVersion.current){setState(catalog);setLeads(contacts);}
  };
  useLayoutEffect(()=>{
    const g=++generation.current;lock.current=false;setBusy(false);setError('');setNotice('');setHistory([]);
    setState({products:[],accounts:[],links:[]});setLeads([]);setLeadId('');setTargetAccount('');setLinkRevision(0);
    setProduct(blankProduct);setProductId(null);setProductRevision(0);setAccount({name:'',domain:''});setAccountId(null);setAccountRevision(0);
    load(g).catch(()=>{if(g===generation.current)setError('Produkt- und Unternehmensdaten konnten nicht geladen werden.');});
    return ()=>{generation.current++;};
  },[clientId]);
  async function action(fn:(g:number)=>Promise<void>) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const g=generation.current;
    try{await fn(g);}catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Aktion fehlgeschlagen.');}
    finally{if(g===generation.current){lock.current=false;setBusy(false);}}
  }
  async function save(kind:'product'|'account'|'link',id:string|null,expectedRevision:number,value:unknown) {
    await action(async g=>{
      const saved=await api(prefix+'/catalog',{kind,id,expectedRevision,value});
      if(g!==generation.current)return;
      if(kind==='product'){setProductId(saved.productId);setProductRevision(saved.revision);setProduct({name:saved.name,description:saved.description,website:saved.website,bookingUrl:saved.bookingUrl,archived:saved.archived});setHistory([]);}
      if(kind==='account'){setAccountId(saved.accountId);setAccountRevision(saved.revision);setAccount({name:saved.name,domain:saved.domain});}
      if(kind==='link')setLinkRevision(saved.revision);
      setNotice('Gespeichert. Vorherige Versionen bleiben erhalten.');await load(g);
    });
  }
  const chooseProduct=(id:string)=>{const p=state.products.find(p=>p.productId===id);setProductId(p?.productId||null);setProductRevision(p?.revision||0);setProduct(p?{name:p.name,description:p.description,website:p.website,bookingUrl:p.bookingUrl,archived:p.archived}:{...blankProduct});setHistory([]);};
  const chooseAccount=(id:string)=>{const a=state.accounts.find(a=>a.accountId===id);setAccountId(a?.accountId||null);setAccountRevision(a?.revision||0);setAccount(a?{name:a.name,domain:a.domain}:{name:'',domain:''});};
  return <section className="card catalog-panel">
    <div className="card-head"><h2>Produkte & Zielunternehmen</h2><p>Pflege Produkte getrennt und ordne Kontakte bewusst Unternehmen zu. Bestehende Kampagnen nutzen vorerst weiterhin ihren bisherigen Betriebsrahmen; hier gespeicherte Änderungen starten keinen Versand.</p></div>
    {error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}
    <button className="secondary" disabled={busy} onClick={()=>action(g=>load(g))}>Produktdaten neu laden</button>
    <div className="catalog-grid"><form onSubmit={e=>{e.preventDefault();void save('product',productId,productRevision,product);}}><fieldset disabled={busy}>
      <legend>Produkt oder Dienstleistung</legend>
      <label>Produkt auswählen<select aria-label="Produkt auswählen" value={productId||''} onChange={e=>chooseProduct(e.target.value)}><option value="">Neues Produkt</option>{state.products.map(p=><option key={p.productId} value={p.productId}>{p.name}{p.archived?' · archiviert':''}</option>)}</select></label>
      <label>Produktname<input aria-label="Produktname" value={product.name} maxLength={160} required onChange={e=>setProduct({...product,name:e.target.value})}/></label>
      <label>Beschreibung<textarea aria-label="Produktbeschreibung" value={product.description} maxLength={12000} onChange={e=>setProduct({...product,description:e.target.value})}/></label>
      <label>Produktwebsite<input type="url" value={product.website} maxLength={2000} onChange={e=>setProduct({...product,website:e.target.value})}/></label>
      <label>Terminbuchungslink<input type="url" value={product.bookingUrl} maxLength={2000} onChange={e=>setProduct({...product,bookingUrl:e.target.value})}/></label>
      <label className="catalog-check"><input type="checkbox" checked={product.archived} onChange={e=>setProduct({...product,archived:e.target.checked})}/>Archiviert</label>
      <button className="primary" type="submit">Produkt speichern</button> {productRevision>0&&<small>Version {productRevision}</small>}
      {productId&&<button type="button" className="secondary" onClick={()=>action(async g=>{const rows=await api(prefix+`/products/${productId}/history`);if(g===generation.current)setHistory(rows);})}>Produktverlauf anzeigen</button>}
      {history.length>0&&<ol className="catalog-history">{history.map(p=><li key={p.revision}><strong>Version {p.revision}: {p.name}</strong><p>{p.description||'Keine Beschreibung'}{p.archived?' · archiviert':''}</p><small>{new Date(p.createdAt).toLocaleString()}</small></li>)}</ol>}
    </fieldset></form></div><details className="advanced-panel"><summary>Zielunternehmen und Kontaktzuordnung</summary>
    <form onSubmit={e=>{e.preventDefault();void save('account',accountId,accountRevision,account);}}><fieldset disabled={busy}>
      <legend>Zielunternehmen</legend>
      <label>Unternehmen auswählen<select aria-label="Unternehmen auswählen" value={accountId||''} onChange={e=>chooseAccount(e.target.value)}><option value="">Neues Unternehmen</option>{state.accounts.map(a=><option key={a.accountId} value={a.accountId}>{a.name}</option>)}</select></label>
      <label>Unternehmensname<input aria-label="Unternehmensname" value={account.name} maxLength={160} required onChange={e=>setAccount({...account,name:e.target.value})}/></label>
      <label>Domain, optional<input aria-label="Unternehmensdomain" value={account.domain} maxLength={253} placeholder="beispiel.de" onChange={e=>setAccount({...account,domain:e.target.value})}/></label>
      <p>Gleiche Namen oder Domains werden nicht automatisch zusammengeführt.</p>
      <button className="primary" type="submit">Unternehmen speichern</button> {accountRevision>0&&<small>Version {accountRevision}</small>}
    </fieldset></form>
    <form onSubmit={e=>{e.preventDefault();void save('link',leadId,linkRevision,targetAccount||null);}}><fieldset disabled={busy||!leads.length}>
      <legend>Kontakt einem Unternehmen zuordnen</legend>
      <label>Kontakt<select aria-label="Kontakt zuordnen" value={leadId} required onChange={e=>{setLeadId(e.target.value);const link=state.links.find(l=>l.leadId===e.target.value);setTargetAccount(link?.accountId||'');setLinkRevision(link?.revision||0);}}><option value="">Kontakt auswählen</option>{leads.map(l=><option key={l.id} value={l.id}>{l.email}{l.company?' · '+l.company:''}</option>)}</select></label>
      <label>Zuordnung<select aria-label="Zielunternehmen zuordnen" value={targetAccount} onChange={e=>setTargetAccount(e.target.value)}><option value="">Keine Zuordnung</option>{state.accounts.map(a=><option key={a.accountId} value={a.accountId}>{a.name}</option>)}</select></label>
      <button className="primary" type="submit">Kontaktzuordnung speichern</button>
    </fieldset>{!leads.length&&<p>Importiere zuerst Kontakte. Danach „Produktdaten neu laden“ wählen.</p>}</form>
    </details>
    {productId&&<details className="advanced-panel"><summary>Produktwissen und belegte Aussagen</summary><ProductKnowledge key={`${clientId}:${productId}:${productRevision}`} clientId={clientId} productId={productId} api={api}/></details>}
    {productId&&<details className="advanced-panel"><summary>Personas und Ansprache entwickeln</summary><ProductStrategy key={`strategy:${clientId}:${productId}:${productRevision}`} clientId={clientId} productId={productId} api={api}/></details>}
    {productId&&<details className="advanced-panel"><summary>Tests und Varianten vergleichen</summary><ProductExperiments key={`experiments:${clientId}:${productId}:${productRevision}`} clientId={clientId} productId={productId} api={api}/></details>}
  </section>;
}

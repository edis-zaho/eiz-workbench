import React,{useLayoutEffect,useRef,useState} from 'react';
import type {SourceContent} from '../core/knowledge-input';
type Preview={clientId:string;productId:string;productRevision:number;kind:'website'|'document';source:SourceContent};
type Props={clientId:string;productId:string;productRevision:number;disabled:boolean;api:(path:string,value?:unknown,method?:string)=>Promise<any>;onUse:(source:SourceContent)=>boolean};
export function ProductSourceImport({clientId,productId,productRevision,disabled,api,onUse}:Props){
  const [url,setUrl]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0),lock=useRef(false),fileInput=useRef<HTMLInputElement>(null);
  useLayoutEffect(()=>{generation.current++;lock.current=false;setBusy(false);setUrl('');setPreview(null);setError('');setNotice('');if(fileInput.current)fileInput.current.value='';return ()=>{generation.current++;};},[clientId,productId,productRevision]);
  async function act(fn:(g:number)=>Promise<void>){if(lock.current||disabled)return;lock.current=true;setBusy(true);setError('');setNotice('');const g=generation.current;try{await fn(g);}catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Import fehlgeschlagen.');}finally{if(g===generation.current){lock.current=false;setBusy(false);}}}
  async function load(input:unknown,g:number){
    const result:Preview=await api(`/api/clients/${clientId}/products/${productId}/source-preview`,input);
    if(g!==generation.current)return;
    if(result.clientId!==clientId||result.productId!==productId||result.productRevision!==productRevision)throw new Error('Import gehört nicht zum angezeigten Produktstand. Neu starten.');
    setPreview(result);
  }
  return <section className="product-source-import" aria-label="Produktquelle importieren">
    <h3>Website oder Datei als Quelle vorbereiten</h3>
    <p>Eine Produktseite, Case Study oder Textdatei einlesen und den Inhalt prüfen. Die Vorschau wird erst gespeichert, wenn du sie in den Quelleneditor übernimmst und dort bewusst speicherst.</p>
    {error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}
    <fieldset disabled={disabled||busy}>
      <legend>Öffentliche Website</legend>
      <label>Adresse der Produktseite<input aria-label="Produktquelle Website" type="url" maxLength={2000} placeholder="https://unternehmen.de/produkt" value={url} onChange={e=>{setUrl(e.target.value);setPreview(null);setNotice('');}}/></label>
      <p>Die angegebene öffentliche HTTPS-Seite wird ohne Anmeldung abgerufen. Kein Crawl von Unterseiten und keine JavaScript-Ausführung. Maximal 20.000 Textzeichen; längere Inhalte werden nicht gekürzt.</p>
      <button type="button" className="secondary" disabled={!url.trim()} onClick={()=>act(async g=>{setPreview(null);await load({kind:'website',productRevision,url:url.trim()},g);})}>Produktseite als Vorschau laden</button>
    </fieldset>
    <fieldset disabled={disabled||busy}>
      <legend>Lokale Textdatei</legend>
      <label>Datei auswählen<input ref={fileInput} aria-label="Produktquelle Datei" type="file" accept=".txt,.md,.html,.htm" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;void act(async g=>{
        setPreview(null);
        if(!/^.+\.(txt|md|html|htm)$/i.test(file.name))throw new Error('Bitte eine UTF-8-Textdatei (.txt, .md, .html oder .htm) auswählen. PDF und Office folgen als eigener Import.');
        if(file.size>256*1024)throw new Error('Maximal 256 KiB pro Datei. Bitte einen bezeichneten Auszug verwenden.');
        const bytes=new Uint8Array(await file.arrayBuffer());if(g!==generation.current)return;
        let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));
        await load({kind:'document',productRevision,filename:file.name,base64:btoa(raw)},g);
      });}}/></label>
      <p>UTF-8-Dateien: TXT, Markdown und HTML. Maximal 20.000 Textzeichen. Inhalte bleiben lokal; HTML wird ausschließlich als Text ausgewertet. Für PDF, Word und Präsentationen vorerst einen bezeichneten Textauszug verwenden.</p>
    </fieldset>
    {busy&&<p role="status">Vorschau wird vorbereitet …</p>}
    {preview&&<div className="source-preview">
      <h4>Importvorschau: {preview.source.title}</h4>
      <p>{preview.source.locator} · {preview.source.text.length.toLocaleString('de-DE')} Zeichen · {new Date(preview.source.capturedAt).toLocaleString()}</p>
      <pre>{preview.source.text}</pre>
      <p>Prüfe Vollständigkeit und Relevanz. Website-Aussagen sind noch keine geprüften Produktfakten. Die Übernahme ersetzt den ungespeicherten Quelleneditor; vorhandene gespeicherte Quellen bleiben erhalten.</p>
      <button type="button" className="primary" disabled={disabled||busy} onClick={()=>act(async()=>{if(onUse(preview.source)){setPreview(null);setNotice('Im Quelleneditor vorbereitet. Name und Begründung ergänzen, Inhalt prüfen und als neue Quelle speichern.');}})}>Als neue Quelle in den Editor übernehmen</button>
    </div>}
  </section>;
}

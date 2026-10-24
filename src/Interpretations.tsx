import {useLayoutEffect,useRef,useState} from 'react';
import {emptyInterpretation,type InterpretationContent} from '../core/interpretation-input';
import type {Interpretation} from '../core/interpretations';
type Api=(path:string,body?:unknown,method?:string)=>Promise<any>;
type Source={sender:string;subject:string;excerpt:string;receivedAt:string};
type Row=Omit<Interpretation,'content'|'sourceSnapshot'>&{content:InterpretationContent;sourceSnapshot:Source|null};
type History={revision:number;basisHash:string;source:Source|null;rows:Row[]};
const labels:Record<InterpretationContent['replyType'],string>={unclear:'Unklar',interest:'Interesse',rejection:'Ablehnung',out_of_office:'Abwesenheit',automatic:'Automatische Nachricht',wrong_person:'Falscher Ansprechpartner',other:'Anderes'};
const tri={unknown:'Unklar',yes:'Ja',no:'Nein'};
function Evidence({source}:{source:Source|null}) {
  return source?<blockquote><strong>{source.subject||'Ohne Betreff'}</strong><p>{source.excerpt||'Kein Nachrichtenausschnitt gespeichert.'}</p><small>{source.sender} · {source.receivedAt}</small></blockquote>:<p className="info">Kein lokaler Nachrichtenausschnitt verfügbar. Fehlendes Wissen bleibt unklar; eine Bewertung benötigt eine eigene Begründung.</p>;
}
export function Interpretations({clientId,eventId,api}:{clientId:string;eventId:string;api:Api}) {
  const [history,setHistory]=useState<History|null>(null),[content,setContent]=useState(emptyInterpretation),[reviewer,setReviewer]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reloadRequired,setReloadRequired]=useState(false);
  const generation=useRef(0),lock=useRef(false);
  useLayoutEffect(()=>{generation.current++;lock.current=false;setHistory(null);setContent(emptyInterpretation());setReviewer('');setError('');setNotice('');setBusy(false);setReloadRequired(false);return()=>{generation.current++;};},[clientId,eventId]);
  const path=`/api/clients/${encodeURIComponent(clientId)}/evidence-journal/${encodeURIComponent(eventId)}/interpretations`;
  async function perform(save:boolean) {
    if(lock.current||save&&(!history||reloadRequired))return;
    lock.current=true;setBusy(true);setError('');setNotice('');const request=++generation.current;
    try{
      if(save)await api(path,{expectedRevision:history!.revision,expectedBasisHash:history!.basisHash,reviewer,content},'POST');
      if(generation.current!==request)return;
      const next:History=await api(path);
      if(generation.current!==request)return;
      if(!next||!Number.isSafeInteger(next.revision)||!Array.isArray(next.rows))throw new Error('Bewertungsverlauf konnte nicht gelesen werden.');
      setHistory(next);setContent(next.rows[0]?{...next.rows[0].content}:emptyInterpretation());setReloadRequired(false);
      if(save)setNotice(`Version ${next.revision} gespeichert. Frühere Bewertungen bleiben erhalten.`);
    }catch(e){if(generation.current===request){setError(e instanceof Error?e.message:'Bewertung fehlgeschlagen.');if(save)setReloadRequired(true);}}
    finally{if(generation.current===request){lock.current=false;setBusy(false);}}
  }
  return <section className="interpretations" aria-label="Bewertung des Eingangs">
    <button className="secondary" disabled={busy} onClick={()=>perform(false)}>{busy?'Wird verarbeitet…':history?'Bewertungen neu laden':'Bewertungen öffnen'}</button>
    {error&&<p className="alert error" role="alert">{error}{reloadRequired?' Vor einem weiteren Speichern bitte neu laden.':''}</p>}
    {notice&&<p className="alert success" role="status">{notice}</p>}
    {history&&<>
      <p className="info">Bewertungen sind begründete Einschätzungen. Hierdurch werden keine Nachrichten versendet oder Kontaktsperren aufgehoben. Betreibername ist eine lokale Angabe.</p>
      <details><summary>Verfügbarer Beleg für die nächste Bewertung</summary><Evidence source={history.source}/></details>
      <form onSubmit={e=>{e.preventDefault();void perform(true);}}>
        <fieldset disabled={busy||reloadRequired}>
          <label>Betreiber<input aria-label="Bewertung Betreiber" maxLength={120} required value={reviewer} onChange={e=>setReviewer(e.target.value)}/></label>
          <label>Antworttyp<select aria-label="Bewertung Antworttyp" value={content.replyType} onChange={e=>setContent({...content,replyType:e.target.value as InterpretationContent['replyType']})}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          {([['technicalQuestion','Technische Frage'],['materialRequest','Materialanfrage'],['meetingIntent','Terminabsicht']] as const).map(([key,label])=><label key={key}>{label}<select aria-label={`Bewertung ${label}`} value={content[key]} onChange={e=>setContent({...content,[key]:e.target.value})}>{Object.entries(tri).map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>)}
          <label><input type="checkbox" checked={content.requiresHumanReview} onChange={e=>setContent({...content,requiresHumanReview:e.target.checked})}/> Menschliche Klärung nötig</label>
          <label><input type="checkbox" checked={content.withdrawn} onChange={e=>setContent({...content,withdrawn:e.target.checked})}/> Bewertung widerrufen (neue Version)</label>
          <label>Begründung<textarea aria-label="Bewertung Begründung" required maxLength={2000} value={content.rationale} onChange={e=>setContent({...content,rationale:e.target.value})}/></label>
          <button className="primary" type="submit">Bewertung als neue Version speichern</button>
        </fieldset>
      </form>
      <details className="interpretation-history"><summary>Bewertungsverlauf · {history.rows.length} Versionen</summary>
        {history.rows.length===0?<p>Noch keine Bewertung gespeichert.</p>:history.rows.map(row=><article key={row.id}>
          <h4>Version {row.revision} · {row.content.withdrawn?'Widerrufen':labels[row.content.replyType]}</h4>
          <p>{row.origin==='human'?'Betreiber':'Modell'}: {row.actor} · {new Date(row.createdAt).toLocaleString('de-DE')}</p>
          {row.origin==='model'&&<p>{row.provider} · {row.model} · Promptversion {row.promptVersion}</p>}
          <p>Technische Frage: {tri[row.content.technicalQuestion]} · Material: {tri[row.content.materialRequest]} · Terminabsicht: {tri[row.content.meetingIntent]} · Klärung: {row.content.requiresHumanReview?'Ja':'Nein'}</p>
          <p>{row.content.rationale}</p><details><summary>Damals verwendeter Beleg</summary><Evidence source={row.sourceSnapshot}/></details>
        </article>)}
      </details>
    </>}
  </section>;
}
export function InterpretationExport({clientId,api}:{clientId:string;api:Api}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');const generation=useRef(0),lock=useRef(false);
  useLayoutEffect(()=>{generation.current++;lock.current=false;setBusy(false);setMessage('');return()=>{generation.current++;};},[clientId]);
  async function download(){
    if(lock.current)return;lock.current=true;setBusy(true);setMessage('');const request=++generation.current;
    try{
      const result=await api(`/api/clients/${encodeURIComponent(clientId)}/interpretation-export`);
      if(generation.current!==request)return;
      if(result?.archive?.format!=='eiz-interpretations'||result.archive.clientId!==clientId||!Array.isArray(result.archive.rows)||!Number.isSafeInteger(result.rowCount)||result.rowCount!==result.archive.rows.length||result.rowCount>10000)throw new Error('Ungültiger Bewertungsexport.');
      const url=URL.createObjectURL(new Blob([JSON.stringify(result.archive,null,2)],{type:'application/json;charset=utf-8'})),link=document.createElement('a');
      try{link.href=url;link.download='bewertungen.json';document.body.appendChild(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      setMessage(`${result.rowCount} Bewertungsversionen exportiert.`);
    }catch(e){if(generation.current===request)setMessage(e instanceof Error?e.message:'Export fehlgeschlagen.');}
    finally{if(generation.current===request){lock.current=false;setBusy(false);}}
  }
  return <details className="interpretation-export"><summary>Bewertungen exportieren</summary><p className="info">Der JSON-Export enthält Begründungen, Betreibernamen und gespeicherte Nachrichtenausschnitte dieses Kunden. Er enthält personenbezogene Daten. Maximal 10.000 Versionen; für größere Bestände die vollständige Sicherung verwenden.</p><button className="secondary" disabled={busy} onClick={download}>Bewertungen als JSON herunterladen</button>{message&&<p role="status">{message}</p>}</details>;
}

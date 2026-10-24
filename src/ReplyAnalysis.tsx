import {useLayoutEffect,useRef,useState} from 'react';
import './reply-analysis.css';
import type {replyInbox,replySetup} from '../core/reply-analysis';
import {Interpretations} from './Interpretations';
type Page=ReturnType<typeof replyInbox>;
type Prepared={eventId:string;setup:ReturnType<typeof replySetup>};
type Api=(path:string,body?:unknown,method?:string)=>Promise<any>;
const labels:Record<string,string>={unclear:'Unklar',interest:'Interesse',rejection:'Ablehnung',out_of_office:'Abwesenheit',automatic:'Automatisch',wrong_person:'Andere Zuständigkeit',other:'Anderes'};
export function ReplyAnalysis({clientId,api}:{clientId:string;api:Api}){
 const [page,setPage]=useState<Page|null>(null),[selected,setSelected]=useState<string[]>([]),[prepared,setPrepared]=useState<Prepared[]>([]),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[running,setRunning]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[filter,setFilter]=useState('all');
 const generation=useRef(0),lock=useRef(false),stop=useRef(false),base=`/api/clients/${clientId}/reply-analysis`;
 useLayoutEffect(()=>{generation.current++;lock.current=false;stop.current=true;setPage(null);setSelected([]);setPrepared([]);setConfirmed(false);setBusy(false);setRunning(false);setError('');setNotice('');return()=>{generation.current++;stop.current=true;};},[clientId]);
 async function action(fn:(g:number)=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');const g=generation.current;try{await fn(g);}catch(e){if(g===generation.current)setError((e as Error).message);}finally{if(g===generation.current){lock.current=false;setBusy(false);setRunning(false);}}}
 async function load(before?:string){await action(async g=>{const p=await api(base+(before?'?before='+encodeURIComponent(before):''));if(g!==generation.current)return;setPage(p);setSelected([]);setPrepared([]);setConfirmed(false);setNotice('');});}
 async function prepare(){await action(async g=>{setPrepared([]);setConfirmed(false);const rows:Prepared[]=[];for(const eventId of selected){if(g!==generation.current)return;rows.push({eventId,setup:await api(base+`/${eventId}/context`)});}if(g===generation.current)setPrepared(rows);});}
 async function run(){if(!confirmed||!prepared.length)return;await action(async g=>{stop.current=false;setRunning(true);setConfirmed(false);let done=0;for(const item of prepared){if(stop.current||g!==generation.current)break;setNotice(`Auswertung ${done+1} von ${prepared.length} …`);const result=await window.workbench.analyzeReply({clientId,eventId:item.eventId,basisHash:item.setup.basisHash,confirmed:true});done++;if(g!==generation.current)return;if(result.status!=='completed'||!result.result?.interpretationId){setError(result.message||result.result?.heldReason||'Auswertung angehalten. Verlauf prüfen.');break;}}if(g!==generation.current)return;const next=await api(base);if(g!==generation.current)return;setPage(next);setPrepared([]);setSelected([]);setNotice(`${done} von ${prepared.length} Aufträgen abgeschlossen${stop.current?' · Rest gestoppt':''}. Ergebnisse und Fehler bleiben gespeichert.`);});}
 const shown=page?.rows.filter(r=>filter==='all'||filter==='new'&&r.eligible||filter==='review'&&(r.latest?.content.requiresHumanReview||r.run?.status==='failed'||r.run?.status==='unknown'||!!r.run?.result?.heldReason))||[];
 const sorted=[...shown].sort((a,b)=>(a.run&&!a.run.superseded?a.run.route?.priority??4:4)-(b.run&&!b.run.superseded?b.run.route?.priority??4:4));
 return <section className="card reply-analysis" aria-label="KI-Eingangsauswertung">
  <div className="card-head"><h2>Antworten verstehen & priorisieren</h2><button className="secondary" disabled={busy} onClick={()=>load()}>Eingangsauswertung laden</button></div>
  <p>Bis zu 20 neue Eingänge nach einer gemeinsamen Freigabe nacheinander auswerten. KI-Einschätzungen werden mit Belegen gespeichert und bleiben menschlich korrigierbar. Die Auswertung versendet keine Antworten. Freigegebene Gesprächsregeln können daraus Bearbeitungsfälle und Wiedervorlagen erzeugen; Kontaktstopps bleiben bestehen.</p>
  <p className="info">Grundlage ist der gespeicherte Ausschnitt (maximal 2.000 Zeichen), kein vollständiges Gespräch. Ein Rückkehrdatum ist ein belegter Hinweis; die Einordnung und die Bedeutung eines Zitats können dennoch falsch sein.</p>
  {error&&<p className="alert error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {running&&<button className="secondary" onClick={()=>{stop.current=true;setNotice('Stopp angefordert. Der laufende Aufruf wird noch gespeichert; danach startet kein weiterer.');}}>Nach laufendem Aufruf stoppen</button>}
  {page&&<>
   <fieldset disabled={busy}><legend>Eingänge auswählen</legend><label>Ansicht<select aria-label="KI-Eingangsfilter" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Alle</option><option value="new">Noch nicht ausgewertet</option><option value="review">Klärungsbedarf / Fehler</option></select></label>
    <p>{shown.length} von {page.rows.length} Eingängen auf dieser Seite. Priorität gilt innerhalb dieser Seite.</p>
    <button className="secondary" onClick={()=>{setSelected(shown.filter(r=>r.eligible).slice(0,20).map(r=>String(r.eventId)));setPrepared([]);setConfirmed(false);}}>Bis zu 20 neue Eingänge auswählen</button>
    <button className="secondary" disabled={!selected.length} onClick={prepare}>Übertragung für {selected.length} Eingänge prüfen</button>
   </fieldset>
   {prepared.length>0&&<fieldset disabled={busy}><legend>Modellaufrufe freigeben</legend><p>{prepared.length} einzelne Aufrufe. Jeder zählt zum gemeinsamen Tageslimit des Kunden. API-Kosten entstehen beim Anbieter. Bei Fehler, veraltetem Stand oder Seitenwechsel stoppt der Rest.</p>
    {prepared.map(p=><details key={p.eventId}><summary>{p.setup.context.transport.subject||'Ohne Betreff'} · {p.setup.provider} / {p.setup.model}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(p.setup.context.transport,null,2)}</pre></details>)}
    <p>Nur die angezeigten Betreffzeilen, Ausschnitte, Eingangszeiten und technischen Angaben werden übertragen. Darin können personenbezogene Daten stehen; Absenderfelder und Kontaktlisten werden nicht zusätzlich beigefügt.</p>
    <label className="toggle-row"><input aria-label="KI-Eingänge freigeben" type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Diese Übertragung und automatische Speicherung der gekennzeichneten KI-Bewertungen freigeben.</label>
    <button className="primary" disabled={!confirmed} onClick={run}>Ausgewählte Antworten auswerten</button>
   </fieldset>}
   <div className="reply-analysis-list">{sorted.map(r=><article key={String(r.eventId)} className="journal-entry">
    <h3>{String(r.subject)||'Ohne Betreff'}</h3><small>{String(r.sender)} · {new Date(String(r.receivedAt)).toLocaleString('de-DE')}</small>
    {r.eligible&&<label className="toggle-row"><input aria-label={`Eingang auswählen ${r.eventId}`} type="checkbox" disabled={busy||!selected.includes(String(r.eventId))&&selected.length>=20} checked={selected.includes(String(r.eventId))} onChange={e=>{setSelected(e.target.checked?[...selected,String(r.eventId)]:selected.filter(id=>id!==r.eventId));setPrepared([]);setConfirmed(false);}}/>Für Auswertung auswählen</label>}
    <blockquote>{String(r.excerpt)||'Kein Ausschnitt verfügbar'}</blockquote>
    {r.latest&&<p><strong>Aktuelle Bewertung: {r.latest.content.withdrawn?'Widerrufen':labels[r.latest.content.replyType]}</strong> · {r.latest.origin==='human'?'Menschliche Bewertung':'KI-Einschätzung'} · Version {String(r.latest.revision)}</p>}
    {r.run&&<div><p>{r.run.provider} / {r.run.model} · {r.run.status==='completed'?'Auswertung gespeichert':r.run.status==='running'?'Aufruf läuft':r.run.status==='unknown'?'Ergebnis unklar':'Aufruf fehlgeschlagen'}</p>
     {r.run.superseded&&<p>Diese KI-Einschätzung wurde durch eine spätere Bewertung ersetzt. Ihre damaligen Hinweise bleiben im Verlauf erhalten.</p>}
     {r.run.result&&<details open={!r.run.superseded}><summary>{r.run.superseded?'Frühere KI-Hinweise':r.run.route?.label}</summary>
      <p>{r.run.result.analysis.rationale}</p><p>Selbsteinschätzung des Modells: {r.run.result.analysis.confidence} – keine gemessene Trefferwahrscheinlichkeit.</p>
      {r.run.result.analysis.quotes.map((q:string,i:number)=><blockquote key={i}>{q}</blockquote>)}
      {r.run.result.analysis.returnDate&&<p>Rückkehrhinweis: {r.run.result.analysis.returnDate}. Beleg: {r.run.result.analysis.dateQuote}. Kein automatischer Wiederanlauf.</p>}
      {r.run.result.heldReason&&<p role="status">{r.run.result.heldReason}</p>}
     </details>}{r.run.message&&<p>{r.run.message}</p>}
     <details><summary>Aufrufnachweis</summary><p>{r.run.createdAt} · Tokens: {String(r.run.usage.inputTokens??'unbekannt')} hinein / {String(r.run.usage.outputTokens??'unbekannt')} heraus. Kosten beim Anbieter prüfen.</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(r.run.transport,null,2)}</pre></details>
    </div>}
    {!busy&&<details><summary>Bewertung prüfen oder korrigieren</summary><Interpretations key={String(r.eventId)+':'+String(r.latest?.revision||0)} clientId={clientId} eventId={String(r.eventId)} api={api}/><small>Nach einer Korrektur die Eingangsauswertung neu laden.</small></details>}
   </article>)}</div>
   {page.nextBefore&&<button className="secondary" disabled={busy} onClick={()=>load(page.nextBefore!)}>Ältere Eingänge zur Auswertung</button>}
  </>}
 </section>;
}

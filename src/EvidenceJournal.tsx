import {useLayoutEffect,useRef,useState} from 'react';
import {SignalImport,SignalOverview} from './Signals';
import {RelayConnection} from './RelayConnection';
import {MeetingEditor,MeetingOverview} from './Meetings';
import './evidence-journal.css';
import {ReplyAnalysis} from './ReplyAnalysis';
import {Conversations} from './Conversations';
import {Interpretations,InterpretationExport} from './Interpretations';
import type {EvidenceContext,EvidenceEvent} from '../core/evidence-journal';
type Row=Omit<EvidenceEvent,'context'|'payload'> & {context:EvidenceContext;payload:Record<string,string>;productName:string|null};
type Page={rows:Row[];through:string;nextBefore:string|null;notes:string[]};
const statuses:Record<string,string>={sending:'Versand reserviert · Ergebnis offen',sent:'Vom Anbieter angenommen',failed:'Versand fehlgeschlagen',unknown:'Versandergebnis unklar'};
export function EvidenceJournal({clientId,api}:{clientId:string;api:(path:string,body?:unknown,method?:string)=>Promise<any>}) {
  const [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),locked=useRef(false);
  useLayoutEffect(()=>{generation.current++;locked.current=false;setPage(null);setBusy(false);setError('');return()=>{generation.current++;};},[clientId]);
  async function load(older=false) {
    if(locked.current)return;
    locked.current=true;setBusy(true);setError('');const request=++generation.current;
    try {
      const query=older&&page?.nextBefore?`?before=${encodeURIComponent(page.nextBefore)}&through=${encodeURIComponent(page.through)}`:'';
      const next=await api(`/api/clients/${encodeURIComponent(clientId)}/evidence-journal${query}`);
      if(generation.current!==request)return;
      if(!next||!Array.isArray(next.rows)||!Array.isArray(next.notes))throw new Error('Ereignishistorie konnte nicht gelesen werden.');
      setPage(next);
    } catch(e) {if(generation.current===request)setError(e instanceof Error?e.message:'Ereignishistorie konnte nicht geladen werden.');}
    finally {if(generation.current===request){locked.current=false;setBusy(false);}}
  }
  return <><Conversations clientId={clientId} api={api}/><ReplyAnalysis clientId={clientId} api={api}/><MeetingOverview clientId={clientId} api={api}/><SignalOverview clientId={clientId} api={api}/><section className="card evidence-journal">
    <div className="card-head"><h2>Ereignishistorie</h2><button className="secondary" disabled={busy} onClick={()=>load()}>{busy?'Wird geladen…':page?'Neueste Ereignisse':'Historie laden'}</button></div>
    <p className="info">Gespeicherte technische Beobachtungen bleiben erhalten. Bei Eingängen kannst du getrennte Bewertungen und Korrekturen erfassen. Die Eingangsauswertung ergänzt gekennzeichnete KI-Bewertungen; Korrekturen bleiben getrennte Versionen.</p>
    <InterpretationExport clientId={clientId} api={api}/>
    {error&&<div className="alert error" role="alert">{error}</div>}
    {page&&<>
      {page.rows.length===0?<p>Noch keine Versand- oder Eingangsbeobachtungen erfasst.</p>:<div className="journal-list">{page.rows.map(row=><details key={row.id} className="journal-entry">
        <summary><strong>{row.source==='incoming'?'Eingang erfasst':statuses[row.payload.status]||'Versandbeobachtung'}</strong> · {new Date(row.occurredAt).toLocaleString('de-DE')}<br/>
          <span className="info">{row.productName?`${row.productName} · Version ${row.context.productRevision}`:row.context.productId?`Historisches Produkt · Version ${row.context.productRevision}`:'Ohne Produktzuordnung'}{row.origin!=='runtime'?' · Übernommener Bestand':''}</span>
        </summary>
        <dl><dt>Quellenzeit</dt><dd>{row.occurredAt} · {row.timeBasis==='local_status_time'?'lokale Statusmeldung':'Eingangszeit laut Anbieter'}</dd>
          <dt>Erfasst am</dt><dd>{new Date(row.recordedAt).toLocaleString('de-DE')}</dd>
          <dt>Herkunft</dt><dd>{row.origin==='runtime'?'Im laufenden Betrieb erfasst':row.origin==='migration_snapshot'?'Beim Versionswechsel übernommener Zustand':'Bei Wiederherstellung übernommener Zustand'}</dd>
          <dt>Unternehmensbezug</dt><dd>{row.context.accountId?'Bei der ersten Versandbeobachtung festgehalten':'Nicht historisch belegt'}</dd>
          <dt>Quellrevision</dt><dd>{row.sourceRevision}</dd>
          {row.source==='mail_tests'&&<><dt>Gemeldetes Ergebnis</dt><dd>{row.payload.result}</dd></>}
          {row.source==='incoming'&&<><dt>Technische Einordnung</dt><dd>{row.payload.reportedKind} · keine Bewertung des Interesses</dd></>}
        </dl>
        {row.source==='incoming'&&<Interpretations clientId={clientId} eventId={row.id} api={api}/>}
        {(row.source==='incoming'||row.payload.status==='sent')&&<MeetingEditor clientId={clientId} eventId={row.id} api={api}/>}
        {row.source==='mail_tests'&&row.payload.status==='sent'&&row.providerId&&<SignalImport clientId={clientId} eventId={row.id} api={api}/>}
      </details>)}</div>}
      {page.nextBefore&&<button className="secondary" disabled={busy} onClick={()=>load(true)}>Ältere Ereignisse</button>}
      <details><summary>Was diese Historie belegt</summary><ul>{page.notes.map(note=><li key={note}>{note}</li>)}</ul></details>
    </>}
  </section></>;
}

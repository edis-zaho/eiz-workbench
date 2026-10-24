import {useLayoutEffect,useRef,useState} from 'react';
import './meetings.css';
import {meetingLabels,type MeetingContent} from '../core/meeting-input';
import type {MeetingRecord,meetingBasis,meetingOverview} from '../core/meetings';
type Api=(path:string,body?:unknown,method?:string)=>Promise<any>;
type Basis=ReturnType<typeof meetingBasis>;
const localTime=(iso:string)=>{const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
function download(data:unknown){const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='EiZ-Terminbelege.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
export function MeetingEditor({clientId,eventId,api}:{clientId:string;eventId:string;api:Api}){
 const [basis,setBasis]=useState<Basis|null>(null),[selected,setSelected]=useState<MeetingRecord|null>(null),[reference,setReference]=useState(''),[status,setStatus]=useState<MeetingContent['status']>('booked'),[scheduled,setScheduled]=useState(''),[observed,setObserved]=useState(localTime(new Date().toISOString())),[actor,setActor]=useState(''),[evidence,setEvidence]=useState(''),[withdrawn,setWithdrawn]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[stale,setStale]=useState(false);
 const generation=useRef(0),lock=useRef(false),newId=useRef(crypto.randomUUID());
 function choose(r:MeetingRecord|null){setSelected(r);setReference(r?.reference||'');setStatus(r?.content.status||'booked');setScheduled(r?localTime(r.content.scheduledAt):'');setObserved(localTime(new Date().toISOString()));setActor('');setEvidence('');setWithdrawn(r?.content.withdrawn||false);setConfirmed(false);newId.current=crypto.randomUUID();}
 useLayoutEffect(()=>{generation.current++;lock.current=false;setBasis(null);choose(null);setBusy(false);setError('');setNotice('');setStale(false);return()=>{generation.current++;};},[clientId,eventId]);
 const path=`/api/clients/${clientId}/evidence-journal/${eventId}/meetings`;
 async function perform(save=false){if(lock.current||save&&(!basis||stale))return;lock.current=true;setBusy(true);setError('');setNotice('');const g=generation.current;
  try{const next:Basis=save?await api(path,{meetingId:selected?.meetingId||newId.current,expectedRevision:selected?.revision||0,eventHash:basis!.eventHash,reference,content:{status,scheduledAt:new Date(scheduled).toISOString(),observedAt:new Date(observed).toISOString(),actor,evidence,withdrawn},confirmed},'POST'):await api(path);
   if(g!==generation.current)return;setBasis(next);setStale(false);if(save){const id=selected?.meetingId||newId.current;choose(next.rows.find(r=>r.meetingId===id)||null);setNotice('Terminversion gespeichert. Frühere Belege bleiben erhalten.');}
   else choose(next.rows[0]||null);
  }catch(e){if(g===generation.current){setError(e instanceof Error?e.message:'Termin konnte nicht gespeichert werden.');if(save)setStale(true);}}
  finally{if(g===generation.current){lock.current=false;setBusy(false);}}
 }
 const latest=basis?.rows.filter((r,i,all)=>all.findIndex(x=>x.meetingId===r.meetingId)===i)||[];
 return <section className="meeting-editor" aria-label="Terminbeleg erfassen"><button className="secondary" disabled={busy} onClick={()=>void perform()}>{basis?'Terminbelege neu laden':'Terminbelege öffnen'}</button>
  {error&&<p role="alert" className="alert error">{error}{stale?' Vor erneutem Speichern neu laden.':''}</p>}{notice&&<p role="status" className="alert success">{notice}</p>}
  {basis&&<><p>Lokaler Betreiberbeleg zu dieser Nachricht. Keine Einladung, Kalenderänderung oder Versandfreigabe. Betreibername ist eine lokale Angabe. Zeiten: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
   <label>Termin auswählen<select aria-label="Termin auswählen" disabled={busy||stale} value={selected?.meetingId||''} onChange={e=>choose(latest.find(r=>r.meetingId===e.target.value)||null)}><option value="">Neuen Termin erfassen</option>{latest.map(r=><option key={r.meetingId} value={r.meetingId}>{r.reference} · {meetingLabels[r.content.status]}{r.content.withdrawn?' · widerrufen':''}</option>)}</select></label>
   <form onSubmit={e=>{e.preventDefault();void perform(true);}}><fieldset disabled={busy||stale}>
    <label>Terminreferenz<input aria-label="Terminreferenz" required maxLength={200} disabled={!!selected} value={reference} onChange={e=>{setReference(e.target.value);setConfirmed(false);}} placeholder="Eindeutige Kalenderkennung oder eigene Terminreferenz"/></label>
    <label>Status<select aria-label="Terminstatus" value={status} onChange={e=>{setStatus(e.target.value as MeetingContent['status']);setConfirmed(false);}}>{Object.entries(meetingLabels).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label>Terminzeit<input aria-label="Terminzeit" type="datetime-local" required value={scheduled} onChange={e=>{setScheduled(e.target.value);setConfirmed(false);}}/></label>
    <label>Beobachtet / bestätigt am<input aria-label="Terminbeobachtung" type="datetime-local" required value={observed} onChange={e=>{setObserved(e.target.value);setConfirmed(false);}}/></label>
    <label>Betreiber<input aria-label="Termin Betreiber" required maxLength={120} value={actor} onChange={e=>{setActor(e.target.value);setConfirmed(false);}}/></label>
    <label>Beleg und Grund der Änderung<textarea aria-label="Terminbeleg" required maxLength={2000} value={evidence} onChange={e=>{setEvidence(e.target.value);setConfirmed(false);}} placeholder="Zum Beispiel: Buchungsbestätigung oder Rückmeldung des Kunden zur Teilnahme"/></label>
    <label className="toggle-row"><input aria-label="Termin widerrufen" type="checkbox" checked={withdrawn} onChange={e=>{setWithdrawn(e.target.checked);setConfirmed(false);}}/>Erfassung widerrufen – etwa bei falscher Zuordnung. Keine Terminabsage.</label>
    <label className="toggle-row"><input aria-label="Termin bestätigen" type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Angaben und Beleg geprüft. Teilnahme nur nach tatsächlicher Rückmeldung bestätigen.</label>
    <button className="primary" disabled={!confirmed} type="submit">Terminversion speichern</button>
   </fieldset></form>
   <details className="meeting-history"><summary>Terminverlauf · {basis.rows.length} Versionen</summary>{basis.rows.map(r=><article key={r.id}><strong>{r.reference} · Version {r.revision} · {meetingLabels[r.content.status]}{r.content.withdrawn?' · widerrufen':''}</strong><p>Termin: {new Date(r.content.scheduledAt).toLocaleString('de-DE')} · Beobachtung: {new Date(r.content.observedAt).toLocaleString('de-DE')} · Erfasst: {new Date(r.createdAt).toLocaleString('de-DE')}</p><p>{r.content.actor}: {r.content.evidence}</p></article>)}</details>
  </>}
 </section>;
}
export function MeetingOverview({clientId,api}:{clientId:string;api:Api}){
 const [data,setData]=useState<ReturnType<typeof meetingOverview>|null>(null),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const generation=useRef(0),lock=useRef(false);
 useLayoutEffect(()=>{generation.current++;lock.current=false;setData(null);setSelected('');setBusy(false);setError('');return()=>{generation.current++;};},[clientId]);
 async function load(){if(lock.current)return;lock.current=true;setBusy(true);setError('');const g=generation.current;try{const r=await api(`/api/clients/${clientId}/meetings`);if(g===generation.current)setData(r);}catch(e){if(g===generation.current)setError((e as Error).message);}finally{if(g===generation.current){lock.current=false;setBusy(false);}}}
 return <section className="card leads-panel meeting-overview"><h2>Termine & Teilnahmebelege</h2><p>Neue Termine am passenden Versand- oder Eingangsbeleg in der Ereignishistorie erfassen. Hier werden lokale Betreiberangaben angezeigt. Ein vergangener Zeitpunkt belegt keine Teilnahme und keine Abrechenbarkeit.</p><button className="secondary" disabled={busy} onClick={()=>void load()}>Terminübersicht laden / aktualisieren</button>{error&&<p className="alert error" role="alert">{error}</p>}{data&&<><p>{data.current.length} erfasste Termine, einschließlich widerrufener Erfassungen. Erste 100 hier; vollständiger Verlauf im Export.</p>{data.current.slice(0,100).map(r=><article key={r.meetingId}><strong>{r.reference} · {meetingLabels[r.content.status]}{r.content.withdrawn?' · widerrufen':''}</strong><p>{new Date(r.content.scheduledAt).toLocaleString('de-DE')}{r.attendanceUnverified?' · Teilnahme ungeklärt':''}</p><button className="secondary" onClick={()=>setSelected(r.eventId)}>Terminverlauf öffnen</button></article>)}<button className="secondary" onClick={()=>download(data)}>Angezeigten Terminstand exportieren</button>{selected&&<MeetingEditor key={selected} clientId={clientId} eventId={selected} api={api}/>}</>}</section>;
}

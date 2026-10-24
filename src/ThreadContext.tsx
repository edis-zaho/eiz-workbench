import {useLayoutEffect,useRef,useState} from 'react';
import type {threadContextState} from '../core/thread-context';
import {threadIssueLabels} from '../core/thread-input';
type State=ReturnType<typeof threadContextState>;
export function ThreadContext({clientId,incomingId,api}:{clientId:string;incomingId:string;api:(path:string,body?:unknown)=>Promise<any>}){
 const [state,setState]=useState<State|null>(null),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const version=useRef(0),locked=useRef(false),base=`/api/clients/${clientId}/thread-context/${incomingId}`;
 useLayoutEffect(()=>{version.current++;locked.current=false;setState(null);setBusy(false);setConfirmed(false);setError('');setNotice('');return()=>{version.current++;};},[clientId,incomingId]);
 async function action(fn:(g:number)=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError('');setNotice('');const g=version.current;try{await fn(g);}catch(e){if(g===version.current)setError((e as Error).message);}finally{if(g===version.current){setBusy(false);locked.current=false;setConfirmed(false);}}}
 async function download(){await action(async g=>{const data=await api(base+'/export');if(g!==version.current)return;if(data.format!=='eiz-thread-context'||data.clientId!==clientId||data.incomingId!==incomingId)throw Error('Fremder Gesprächsexport.');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');try{a.href=url;a.download='gespraechskontext.json';document.body.appendChild(a);a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}setNotice('Gesprächskontext exportiert. Die Datei enthält Nachrichtentexte und personenbezogene Daten.');});}
 return <section className="thread-context" aria-label="Vollständiger Gesprächskontext"><h3>Gesprächskontext</h3>
  <p>Zusammenhängende Klartext-Nachrichten lokal prüfen. Der Abruf liest dieses Gespräch bei Google und speichert es auf diesem PC. Keine Übertragung an ein KI-Modell, kein Versand. Anhänge und HTML-Inhalte werden nicht ausgeführt oder als vollständiger Klartext ausgegeben.</p>
  <div className="button-row"><button className="secondary" disabled={busy} onClick={()=>action(async g=>{const r=await api(base);if(g===version.current)setState(r);})}>Gespeicherten Kontext laden</button><button className="secondary" disabled={busy||!state?.latest} onClick={download}>Gesprächskontext exportieren</button></div>
  <label className="toggle-row"><input aria-label="Gesprächskontext Abruf bestätigen" type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Dieses Gespräch von Google lesen und lokal speichern.</label>
  <button className="primary" disabled={busy||!confirmed} onClick={()=>action(async g=>{const r=await window.workbench.googleThreadContext({clientId,incomingId,confirmed:true});if(g===version.current){setState(r);setNotice('Gesprächskontext lokal gespeichert.');}})}>Gespräch von Google einlesen</button>
  {error&&<p role="alert" className="alert error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {state&&!state.latest&&<p>Noch kein vollständiger Gesprächsabruf gespeichert. Der bisherige Eingangsausschnitt bleibt erhalten.</p>}
  {state?.latest&&<><p>Version {state.latest.revision} · Abgerufen {new Date(state.latest.createdAt).toLocaleString('de-DE')} · {state.capture!.messages.length} Nachrichten</p>
   {state.stale&&<p className="alert error">Lokale Grundlage seit dem Abruf geändert. Gespräch erneut einlesen. Der gespeicherte Verlauf bleibt erhalten.</p>}
   <p className={state.hasGaps?'alert error':'info'}>{state.hasGaps?'Kontext mit Lücken oder Klärungshinweisen. Vor einer Antwort manuell prüfen.':'Klartext für alle Nachrichten dieses Abrufs vorhanden. Spätere Eingänge sind erst nach erneutem Abgleich bekannt.'}</p>
   <div className="thread-timeline">{state.capture!.messages.map(m=><details key={m.providerId} open><summary>{m.direction==='sent'?'Gesendet':m.direction==='received'?'Empfangen':'Zuordnung prüfen'} · {m.subject||'(ohne Betreff)'} · {new Date(m.sentAt).toLocaleString('de-DE')}</summary><p>Von: {m.from} · An: {m.to}{m.cc?' · CC: '+m.cc:''}</p>{m.issues.length>0&&<p className="alert error">{m.issues.map(i=>threadIssueLabels[i]).join(' · ')}</p>}<pre>{m.textStatus==='plain'?m.text:'Kein auswertbarer Klartext gespeichert.'}</pre></details>)}</div>
   <details><summary>Gespeicherte Abrufversionen · {state.history.length}</summary>{state.history.map(h=><p key={h.id}>Version {h.revision} · {h.createdAt} · {h.messageCount} Nachrichten</p>)}</details>
  </>}
 </section>;
}

import {useLayoutEffect,useRef,useState} from 'react';
import type {relayState} from '../core/relay-sync';
import type {signalBasis} from '../core/signals';
type Api=(path:string,body?:unknown,method?:string)=>Promise<any>;
export function RelaySync({clientId,revision,api}:{clientId:string;revision:string;api:Api}){
 const [state,setState]=useState<ReturnType<typeof relayState>|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const gen=useRef(0),lock=useRef(false);
 useLayoutEffect(()=>{gen.current++;lock.current=false;setState(null);setError('');setNotice('');setBusy(false);return()=>{gen.current++;};},[clientId,revision]);
 async function run(mode:'load'|'on'|'off'|'pull'){if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const g=++gen.current;
  try{let result;if(mode==='pull')result=await window.workbench.relayPull({clientId,revision});else if(mode!=='load')result=await window.workbench.relayConfigure({clientId,revision,enabled:mode==='on'});if(g!==gen.current)return;
   const next=await api(`/api/clients/${clientId}/relay-sync`);if(g!==gen.current)return;setState(next);setNotice(result?.cancelled?'Abgebrochen.':mode==='pull'?`${result.inserted} neue Signale · ${result.duplicates} bereits vorhanden. ${result.complete?'Aktueller Abruf abgeschlossen.':'Weitere Seite steht aus.'}`:'Abholstand aktualisiert.');
  }catch(e){if(g===gen.current)setError((e as Error).message);}finally{if(g===gen.current){lock.current=false;setBusy(false);}}
 }
 return <div className="relay-sync"><h3>Automatische Signalabholung</h3><p>Maximal 500 Beobachtungen pro Seite. Der Fortschritt wird zusammen mit den Signalbelegen gespeichert. Unbekannte Referenzen halten die gesamte Seite an. Die Workbench muss geöffnet oder im Hintergrund aktiv sein.</p>
  {error&&<p className="alert error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button className="secondary" disabled={busy} onClick={()=>void run('load')}>Abholstand laden</button>
  {state&&<><p>{state.bindingCount} feste Nachrichtenbindungen · {state.receiptCount} gespeicherte Abholseiten · Fortschritt {state.cursor?.after??0}</p><p>{state.policy?.active?'Automatische Abholung freigegeben':'Automatische Abholung ist aus oder benötigt erneute Freigabe'}</p><p>Letzter erfolgreicher Abruf: {state.policy?.lastAt?new Date(state.policy.lastAt).toLocaleString('de-DE'):'Noch keiner'}</p>{state.policy?.lastError&&<p className="alert error">{state.policy.lastError}</p>}<div className="actions"><button className="secondary" disabled={busy||!state.bindingCount} onClick={()=>void run(state.policy?.active?'off':'on')}>{state.policy?.active?'Signalabholung stoppen':'Signalabholung freigeben'}</button><button className="secondary" disabled={busy||!state.policy?.active} onClick={()=>void run('pull')}>Jetzt Signalseite abholen</button></div></>}
 </div>;
}
export function RelayBinding({clientId,basis}:{clientId:string;basis:ReturnType<typeof signalBasis>}){
 const [ref,setRef]=useState(''),[actor,setActor]=useState(''),[busy,setBusy]=useState(false),[text,setText]=useState('');const gen=useRef(0),lock=useRef(false);
 useLayoutEffect(()=>{gen.current++;lock.current=false;setRef('');setActor('');setText('');setBusy(false);return()=>{gen.current++;};},[clientId,basis.eventId,basis.eventHash]);
 async function bind(){if(lock.current)return;lock.current=true;setBusy(true);setText('');const g=gen.current;
  try{const status=await window.workbench.relayStatus(clientId);if(g!==gen.current)return;if(!status.connection)throw Error('Zuerst den Trackingdienst im Kundenbereich verbinden.');const result=await window.workbench.relayBind({clientId,revision:status.revision,eventId:basis.eventId,eventHash:basis.eventHash,messageRef:ref,actor});if(g===gen.current)setText(result.cancelled?'Abgebrochen.':result.alreadyBound?'Diese Zuordnung besteht bereits.':'Relay-Referenz dauerhaft zugeordnet. Abholstand oben aktualisieren.');}
  catch(e){if(g===gen.current)setText((e as Error).message);}finally{if(g===gen.current){lock.current=false;setBusy(false);}}
 }
 return <details className="relay-binding"><summary>Relay-Referenz dieser Nachricht zuordnen</summary><p>Für eine bereits auf deinem Trackingdienst registrierte messageRef. Nur die tatsächlich zu dieser versendeten Nachricht gehörende Referenz eintragen. Die Bindung kann später nicht auf eine andere Nachricht verschoben werden. Es wird kein Pixel erzeugt.</p><fieldset disabled={busy}><label>Registrierte Nachrichtenreferenz<input aria-label="Relay Nachrichtenreferenz" value={ref} onChange={e=>setRef(e.target.value)} maxLength={36}/></label><label>Prüfender Betreiber<input aria-label="Relay Betreiber" value={actor} onChange={e=>setActor(e.target.value)} maxLength={120}/></label><button className="secondary" disabled={!ref||!actor.trim()} onClick={()=>void bind()}>Relay-Referenz fest zuordnen</button></fieldset>{text&&<p role="status">{text}</p>}</details>;
}

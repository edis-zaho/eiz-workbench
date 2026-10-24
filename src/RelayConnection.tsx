import {TrackingSettings} from './TrackingSettings';
import {RelaySync} from './RelaySync';
import {useLayoutEffect,useRef,useState} from 'react';
import './relay.css';
type Connection={canRegister?:boolean;baseURL:string;stream:string;instanceId:string;checkedAt:string;registered:number;observations:number;limits:{tokensPerStream:number;eventsPerStream:number}};
type Status={revision:string|null;connection:Connection|null};
export type RelayBridge={
 trackingConfigure(data:any):Promise<any>;
 relayBind(data:any):Promise<any>;
 relayConfigure(data:any):Promise<any>;
 relayPull(data:any):Promise<any>;
 relayStatus(id:string):Promise<Status>;
 relayConnect(data:{clientId:string;revision:string|null;baseURL:string;stream:string;readKey:string}):Promise<Status&{cancelled:boolean}>;
 relayCheck(data:{clientId:string;revision:string|null}):Promise<Status>;
 relayDisconnect(data:{clientId:string;revision:string|null}):Promise<Status&{cancelled:boolean}>;
};
export function RelayConnection({clientId,api}:{clientId:string;api:(path:string,body?:unknown,method?:string)=>Promise<any>}){
 const [state,setState]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[baseURL,setBaseURL]=useState(''),[stream,setStream]=useState(''),[readKey,setReadKey]=useState('');
 const generation=useRef(0),lock=useRef(false);
 useLayoutEffect(()=>{const g=++generation.current;lock.current=false;setState(null);setBusy(false);setError('');setNotice('');setBaseURL('');setStream('');setReadKey('');window.workbench.relayStatus(clientId).then(s=>{if(g===generation.current)setState(s);},e=>{if(g===generation.current)setError(e.message);});return()=>{generation.current++;};},[clientId]);
 async function run(action:'load'|'connect'|'check'|'disconnect'){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const g=++generation.current;
  const pendingKey=readKey;setReadKey('');
  try{
   const input={clientId,revision:state?.revision??null};
   const result=action==='load'?await window.workbench.relayStatus(clientId):action==='connect'?await window.workbench.relayConnect({...input,baseURL,stream,readKey:pendingKey}):action==='check'?await window.workbench.relayCheck(input):await window.workbench.relayDisconnect(input);
   if(g!==generation.current)return;
   setState(result);setNotice('cancelled' in result&&result.cancelled?'Abgebrochen.':action==='check'?'Verbindung erfolgreich geprüft.':action==='connect'?'Zugang verschlüsselt gespeichert.':action==='disconnect'?'Lokaler Zugang entfernt.':'Lokaler Verbindungsstand geladen.');
  }catch(e){if(g===generation.current)setError((e as Error).message);}
  finally{if(g===generation.current){lock.current=false;setBusy(false);}}
 }
 const c=state?.connection;
 return <section className="card relay-connection"><h2>Trackingdienst verbinden</h2>
  <p>Verbinde deinen eigenen Trackingdienst. Der Zugang wird auf diesem PC verschlüsselt gespeichert und ist nicht Teil der Datensicherung.</p>
  <p className="muted">Nach der Verbindung kannst du automatisches Versandtracking freigeben. Öffnungen und Klicks bleiben technische Beobachtungen mit möglichen Proxy- oder Automatikabrufen.</p>
  {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {c?<><dl><dt>Dienst</dt><dd>{c.baseURL}</dd><dt>Datenstrom</dt><dd>{c.stream}</dd><dt>Gebundene Dienstkennung</dt><dd>{c.instanceId}</dd><dt>Letzte erfolgreiche Prüfung</dt><dd>{new Date(c.checkedAt).toLocaleString('de-DE')}</dd><dt>Gemeldeter Stand bei dieser Prüfung</dt><dd>{c.registered} registrierte Kennungen · {c.observations} technische Abrufe</dd></dl><p className="muted">Abrufe sind keine bestätigten Leser. Dienstzähler sind kein Nachweis vollständig übernommener Signale. Den lokalen Abholstand siehst du unten.</p><div className="actions"><button className="secondary" disabled={busy} onClick={()=>void run('check')}>Trackingverbindung prüfen</button><button className="secondary" disabled={busy} onClick={()=>void run('disconnect')}>Trackingzugang lokal trennen</button></div></>:state&&<fieldset disabled={busy}><label>Dienstadresse<input aria-label="Tracking Dienstadresse" type="url" placeholder="https://tracking.deine-domain.de" value={baseURL} onChange={e=>setBaseURL(e.target.value)} /></label><label>Datenstrom-ID<input aria-label="Tracking Datenstrom" value={stream} onChange={e=>setStream(e.target.value)} autoComplete="off" /></label><label>Leseschlüssel<input aria-label="Tracking Leseschlüssel" type="password" autoComplete="new-password" value={readKey} onChange={e=>setReadKey(e.target.value)} /></label><p className="muted">Verwende den Leseschlüssel des EiZ-Trackingdienstes. Den Schreibschlüssel hinterlegst du anschließend bei der Versandtracking-Freigabe.</p><button className="primary" disabled={!baseURL||!stream||!readKey} onClick={()=>void run('connect')}>Trackingdienst prüfen und verbinden</button></fieldset>}
  <button className="secondary" disabled={busy} onClick={()=>void run('load')}>Lokalen Trackingstand neu laden</button>{busy&&<p role="status">Trackingzugang wird geprüft …</p>}
 {c&&<TrackingSettings key={clientId+state!.revision+'tracking'} clientId={clientId} revision={state!.revision!} canRegister={!!c.canRegister} api={api} refresh={()=>void run('load')}/>}
 {c&&<RelaySync key={clientId+state!.revision} clientId={clientId} revision={state!.revision!} api={api}/>}
 </section>;
}

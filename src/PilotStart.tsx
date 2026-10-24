import {useEffect,useRef,useState} from 'react';
import {pilotProgress,type PilotProgressSnapshot} from './pilot-readiness';
import './pilot-start.css';
const steps=[
 ['mailbox','1 · Postfach verbinden','Google-Konfiguration importieren, eigenes Postfach verbinden und Lesezugriff live prüfen.'],
 ['brief','2 · Angebot und Grenzen','Unternehmenswissen, Nachrichtenstil, Limits und Betriebsrahmen ausarbeiten und freigeben.'],
 ['catalog','3 · Produkt und Testidee','Produktwissen und bei Bedarf Persona/Angle und Experiment festlegen.'],
 ['leads','4 · Eigene Testkontakte','Zunächst ausschließlich eigene oder ausdrücklich freigegebene Testadressen importieren.'],
 ['campaigns','5 · Kampagne prüfen und starten','Texte und Empfänger prüfen, Plan freigeben und Lauf vorbereiten. Für echten Versand separat freigeben, danach LIVE starten.'],
 ['journal','6 · Ergebnisse kontrollieren','Antwort abrufen, Kontaktstopp und Verlauf prüfen. Erst danach Umfang bewusst erhöhen.']
] as const;
type CampaignOption={id:string;clientId:string;content:{name:string}};
export function PilotStart({clientId,clientVersion,paused,unavailable,api,onOpen}:{clientId:string;clientVersion:number;paused:boolean;unavailable:boolean;api:(path:string)=>Promise<any>;onOpen?:(id:string)=>void}){
 const [snapshot,setSnapshot]=useState<PilotProgressSnapshot>(),[campaigns,setCampaigns]=useState<CampaignOption[]>([]),[selected,setSelected]=useState('');
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
 const generation=useRef(0),apiRef=useRef(api);apiRef.current=api;
 async function load(preferred=selected){
  const gen=++generation.current,startedAt=Date.now(),base=`/api/clients/${encodeURIComponent(clientId)}`;
  setLoading(true);setSnapshot(undefined);setError('');
  try{
   const [brief,leads,options,runs]=await Promise.all(['/brief','/campaign-leads','/campaigns','/queue'].map(path=>apiRef.current(base+path)));
   if(brief.clientId!==clientId||!Array.isArray(leads)||!Array.isArray(options)||!Array.isArray(runs)||[...leads,...options,...runs].some(row=>row.clientId!==clientId))throw new Error('Ungültiger Kundenbezug');
   const chosen=options.find((c:CampaignOption)=>c.id===preferred)||(!preferred?options[0]:undefined);
   const preview=chosen?await apiRef.current(`${base}/campaigns/${encodeURIComponent(chosen.id)}/preview`):null;
   if(gen!==generation.current)return;
   setCampaigns(options);setSelected(chosen?.id||'');setNow(Date.now());
   setSnapshot({clientId,clientVersion:brief.clientVersion,checkedAt:startedAt,briefApproved:brief.approved===true,contactCount:leads.length,
    campaign:chosen?{id:chosen.id,approved:preview.approved===true,problemCount:preview.problemCount,fingerprint:preview.fingerprint}:null,
    runs:runs.map(r=>({clientId:r.clientId,campaignId:r.campaignId,fingerprint:r.fingerprint,status:r.status,snapshot:{mode:r.snapshot.mode},counts:r.counts}))});
  }catch{
   if(gen===generation.current){setSnapshot(undefined);setError('Vorbereitungsstand konnte nicht geladen werden. Keine Bereitschaft bestätigt. Bitte erneut laden.');}
  }finally{if(gen===generation.current)setLoading(false);}
 }
 useEffect(()=>{if(unavailable){generation.current++;setSnapshot(undefined);setLoading(false);return;}void load();return()=>{generation.current++;};},[clientId,clientVersion,unavailable]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const progress=pilotProgress({clientId,clientVersion,paused,now,snapshot:unavailable?undefined:snapshot});
 const stateLabels={unknown:'Ungeprüft',open:'Offen',checked:'Gespeichert geprüft',simulation:'Probelauf',live:'LIVE aktiv',attention:'Prüfen'};
 const nextLabels:Record<string,string>={reload:'Stand neu laden',client:'Kundenpause prüfen',brief:'Betriebsrahmen ausarbeiten',leads:'Testkontakte importieren',campaigns:'Kampagne und Warteschlange prüfen',journal:'Ergebnisse im Signaljournal prüfen'};
 function jump(id:string){if(onOpen){onOpen(id);return;}const target=document.getElementById('pilot-'+id);if(target){target.scrollIntoView({behavior:'instant',block:'start'});target.focus({preventScroll:true});}}
 return <section className="card pilot-start" aria-label="Pilot einrichten"><h2>Dein erster eigener Kampagnenlauf</h2>
  <p>Gespeicherter Vorbereitungsstand für diesen Kunden. Ungespeicherte Eingaben sind nicht enthalten. Diese Übersicht erteilt keine Versandfreigabe.</p>
  <div className="button-row"><button type="button" className="secondary" disabled={loading||unavailable} onClick={()=>void load()}>Vorbereitungsstand neu laden</button><span role="status">{loading?'Wird geladen …':snapshot?`Stand ${new Date(snapshot.checkedAt).toLocaleTimeString('de-DE')} · ${progress.fresh?'Momentaufnahme':'veraltet – neu laden'}`:'Noch kein gültiger Stand'}</span></div>
  <p>Nach Änderungen neu laden. Nach einer Minute gilt die Anzeige als veraltet. Postfach, Tracking und aktuelle Versandhindernisse prüfst du weiterhin in ihren jeweiligen Bereichen.</p>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {campaigns.length>0&&<label className="pilot-campaign-select">Kampagne für diese Übersicht<select aria-label="Kampagne für Pilotübersicht" value={selected} disabled={loading||unavailable} onChange={e=>{setSelected(e.target.value);void load(e.target.value);}}><option value="" disabled>Kampagne auswählen</option>{campaigns.map(c=><option key={c.id} value={c.id}>{c.content.name}</option>)}</select></label>}
  <div className="pilot-progress">{progress.steps.map(step=><div key={step.id} data-pilot-step={step.id} data-state={step.state}><div><strong>{step.label}</strong><span className={'pill '+(step.state==='checked'?'done':'')}>{stateLabels[step.state]}</span></div><p>{step.detail}</p><button type="button" className="text-button" onClick={()=>jump(step.id==='queue'?'campaigns':step.id)}>Bereich öffnen</button></div>)}</div>
  <div className="button-row"><strong>Nächster Schritt:</strong><button type="button" className="secondary" disabled={loading||(progress.next==='reload'&&unavailable)} onClick={()=>progress.next==='reload'?void load():jump(progress.next)}>{nextLabels[progress.next]}</button><button type="button" className="text-button" onClick={()=>jump('mailbox')}>Postfachprüfungen öffnen</button></div>
  <details className="pilot-guide"><summary>Alle sechs Einrichtungsschritte und Hinweise</summary><p>Die Buttons öffnen den jeweiligen Abschnitt und erteilen keine Freigabe.</p><ol>{steps.map(([id,label,description])=><li key={id}><button type="button" className="text-button" onClick={()=>jump(id)}>{label}</button><p>{description}</p></li>)}</ol><p><strong>Ohne Trackingserver starten:</strong> Tracking muss in den Postfacheinstellungen ausgeschaltet sein. Versand und Antwortabgleich funktionieren unabhängig davon. Fehlende Öffnungssignale lassen sich später nicht nachholen.</p><p><strong>Probelauf oder echte Mail:</strong> Ein gestarteter Probelauf sendet keine E-Mail und lässt sich anschließend nicht in einen Live-Lauf umwandeln. Für den echten Test einen neuen unverarbeiteten Lauf vorbereiten, separat freigeben und LIVE starten.</p><p>Ein API-Modell ist für manuell geschriebene Kampagnentexte nicht erforderlich. Automatische KI-Bewertungen und Antworten benötigen eigene Modell- und Regelfreigaben. PC und App müssen laufen; zum Anhalten „Notstopp aller Läufe“ verwenden.</p></details></section>;
}

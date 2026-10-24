import {modelTemplates} from './model-templates';
import './guided-setup.css';
import {useEffect,useLayoutEffect,useState,useRef} from 'react';
import type {ModelProfile} from '../core/model-profiles';
const tasks=[['analysis','Unternehmensanalyse'],['writing','Personas & Ansprache'],['knowledge','Quellen auswerten'],['campaign-writing','Nachrichtenfolgen'],['reply-analysis','Antworten auswerten'],['reply-writing','Antwortentwürfe']] as const;
const endpoints:any={openai:{protocol:'openai-responses',origin:'https://api.openai.com',basePath:'/v1'},gemini:{protocol:'gemini-generate-content',origin:'https://generativelanguage.googleapis.com',basePath:'/v1beta'},anthropic:{protocol:'anthropic-messages',origin:'https://api.anthropic.com',basePath:'/v1'},custom:{protocol:'openai-chat-completions',origin:'http://127.0.0.1:11434',basePath:'/v1'}};
const blank=()=>({name:'',provider:'openai',model:'',...endpoints.openai,maxOutputTokens:4096});
export function ModelSettings({clientId}:{clientId?:string}){
 const [data,setData]=useState<any>(),[selected,setSelected]=useState(''),[client,setClient]=useState(clientId||''),[form,setForm]=useState<any>(blank),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [step,setStep]=useState(0),[templateId,setTemplateId]=useState('');
 useLayoutEffect(()=>{window.scrollTo(0,0);},[step]);
 const [price,setPrice]=useState({currency:'USD',input:'',output:'',cached:'',reasoning:'',source:'',inputBound:'',boundSource:''});
 const [budget,setBudget]=useState({currency:'USD',perRun:'',perDay:'',perMonth:''});
 const live=useRef(0),lock=useRef(false);
 async function load(){const e=live.current;const v=await window.workbench.modelCommand('list');if(e===live.current){setData(v);if(!client&&!clientId)setClient(v.clients[0]?.id||'');}}
 useEffect(()=>{live.current++;setClient(clientId||'');void load().catch(e=>setError(e.message));return()=>{live.current++;};},[clientId]);
 async function action(fn:()=>Promise<any>,message:string){if(lock.current)return;lock.current=true;const e=live.current;setBusy(true);setError('');setNotice('');try{await fn();if(e!==live.current)return;await load();setNotice(message);}catch(x){if(e===live.current){setError((x as Error).message);try{await load();}catch{/* Preserve the original actionable error. */}}}finally{lock.current=false;if(e===live.current)setBusy(false);}}
 const profile=data?.profiles.find((p:any)=>p.id===selected) as (ModelProfile&{credentialPresent:boolean})|undefined;
 const cap=data?.records.find((r:any)=>r.kind==='capability'&&r.id===profile?.binding.hash)?.content;
 const currentPrice=data?.records.find((r:any)=>r.kind==='price'&&r.id===selected&&r.content.bindingHash===profile?.binding.hash)?.content;
 const savedBudget=data?.records.find((r:any)=>r.kind==='budget'&&r.id===budget.currency);
 // Hydrate only when the selected persisted version changes; unrelated reloads
 // must not discard edits that the user has not saved yet.
 useEffect(()=>{
  const p=currentPrice?.prices;
  const amount=(v:unknown)=>typeof v==='number'?String(v/1e6):'';
  setPrice({currency:p?.currency||'USD',input:amount(p?.inputMicrosPerMillion),output:amount(p?.outputMicrosPerMillion),
   cached:amount(p?.cachedInputMicrosPerMillion),reasoning:amount(p?.reasoningMicrosPerMillion),
   source:p?.source||'',inputBound:currentPrice?String(currentPrice.inputUpperBound):'',boundSource:currentPrice?.inputBoundSource||''});
 },[selected,profile?.binding.hash,currentPrice?.prices.version]);
 useEffect(()=>{
  const v=savedBudget?.content;
  setBudget(b=>({...b,perRun:v?String(v.perRun/1e6):'',perDay:v?String(v.perDay/1e6):'',perMonth:v?String(v.perMonth/1e6):''}));
 },[budget.currency,savedBudget?.revision]);
 const template=modelTemplates.find(t=>t.model===profile?.binding.model&&t.provider===profile?.binding.provider);
 const routes=data?.routes.find((r:any)=>r.clientId===client)?.content;
 function choose(id:string){setSelected(id);setTemplateId('');setKey('');const p=data?.profiles.find((p:any)=>p.id===id);setForm(p?{name:p.name,...p.binding}:blank());setNotice('');}
 async function save(){
  const old=data?.profiles.find((p:any)=>p.id===selected);
  const credentialRef=old?.binding.credentialRef||('key-'+crypto.randomUUID());
  const input={name:form.name,provider:form.provider,model:form.model,protocol:form.protocol,origin:form.origin,basePath:form.basePath,maxOutputTokens:Number(form.maxOutputTokens),credentialRef:form.origin.startsWith('http:')?null:credentialRef,...(old?{id:old.id,expectedRevision:old.revision}:{})};
  const p=await window.workbench.modelCommand('profile',input);setSelected(p.id);
 }
 async function saveTemplatePrice(){
  if(!profile||!template)return;
  await window.workbench.modelCommand('price',{id:profile.id,input:{inputUpperBound:template.inputBound,inputBoundSource:template.source,prices:{version:'template-'+template.id+'-'+template.checkedAt,provider:profile.binding.provider,protocol:profile.binding.protocol,model:profile.binding.model,currency:'USD',inputMicrosPerMillion:Math.round(template.input*1e6),outputMicrosPerMillion:Math.round(template.output*1e6),cachedInputMicrosPerMillion:Math.round(template.cached*1e6),reasoningMicrosPerMillion:template.reasoning===null?null:Math.round(template.reasoning*1e6),source:template.source,checkedAt:template.checkedAt}}});
 }
 async function useForAll(){
  if(!profile||!client)return;
  try{for(const [task] of tasks)await window.workbench.modelCommand('route',{clientId:client,task,ref:profile.binding.profile});}
  catch(e){await load();throw new Error('Die Zuordnung wurde nicht vollständig gespeichert. Prüfe die einzelnen Aufgaben unter Erweitert und versuche es erneut.');}
 }
 const money=(v:unknown)=>typeof v==='number'?(v/1000000).toLocaleString('de-DE',{maximumFractionDigits:6}):'unbekannt';
 return <section className="model-settings" onWheelCapture={e=>{
  // Native number fields can change even while the user intends to scroll the page.
  const active=document.activeElement;
  if(active instanceof HTMLInputElement&&active.type==='number'&&e.currentTarget.contains(active))active.blur();
 }}>
  <div className="page-title"><div><h1>Modelle & Kosten</h1><p>Eigene API-Schlüssel, freie Modellwahl. Die Workbench berechnet keinen Aufschlag. Anbietergebühren fallen direkt bei deinem Anbieter an.</p></div></div>
  {error&&<div className="alert error" role="alert">{error}</div>}{notice&&<div className="alert success" role="status">{notice}</div>}
  <div className="model-progress" aria-label="KI-Einrichtungsstand"><span>{profile?'✓':'○'} Modell gespeichert</span><span>{profile&&(profile.credentialPresent||!profile.binding.credentialRef)?'✓':'○'} Zugang hinterlegt</span><span>{currentPrice?'✓':'○'} Preise gespeichert</span><span>{savedBudget?'✓':'○'} Budget gespeichert ({budget.currency})</span></div>
  <nav className="model-steps" aria-label="KI-Einrichtung">{['1 · Modell & Zugang','2 · Kostenlimit','3 · Verwenden & testen'].map((label,i)=><button type="button" key={label} aria-current={step===i?'step':undefined} onClick={()=>setStep(i)}>{label}</button>)}</nav>
  <div className="model-stage" hidden={step!==0}><section className="card setting">
   <h2>Welche KI möchtest du verwenden?</h2><p className="setup-help">Du brauchst einen eigenen API-Zugang beim Anbieter. Ein Chat-Abonnement allein enthält diesen normalerweise nicht. Deine Schlüssel bleiben verschlüsselt auf diesem PC.</p><label>Gespeichertes Profil<select aria-label="Modellprofil" value={selected} onChange={e=>choose(e.target.value)} disabled={busy}><option value="">Neues Profil</option>{data?.profiles.map((p:any)=><option value={p.id} key={p.id}>{p.name} · {p.binding.model}</option>)}</select></label>
   {!selected&&<div className="template-pick"><label>Mit einer Vorlage beginnen<select aria-label="Modellvorlage" value={templateId} onChange={e=>{const id=e.target.value,t=modelTemplates.find(t=>t.id===id);setTemplateId(id);setForm(t?{...blank(),name:t.name,provider:t.provider,model:t.model,...endpoints[t.provider]}:blank());}}><option value="">Eigenes Modell / freie Auswahl</option>{modelTemplates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><small>Vorlagen füllen die technischen Angaben aus. Im nächsten Schritt kannst du die zugehörigen Preise übernehmen. Verfügbarkeit und Qualität prüfst du mit deinem eigenen Konto.</small></div>}
   <form className="editor" onSubmit={e=>{e.preventDefault();void action(save,'Profil gespeichert. Schlüssel, Preis und Test gelten nur für diese Fassung.');}}>
    <label>Profilname<input aria-label="Profilname" required value={form.name} maxLength={120} onChange={e=>setForm({...form,name:e.target.value})}/></label>
    <label>Anbieter<select aria-label="Modellanbieter" value={form.provider} onChange={e=>setForm({...form,provider:e.target.value,...endpoints[e.target.value]})}>{Object.keys(endpoints).map(p=><option key={p} value={p}>{p}</option>)}</select></label>
    <label>Modellkennung<input aria-label="Modellkennung" required value={form.model} maxLength={160} onChange={e=>setForm({...form,model:e.target.value})}/></label>
    {form.provider==='custom'&&<><label>Server-Adresse<input aria-label="Modellserver" required value={form.origin} onChange={e=>setForm({...form,origin:e.target.value})}/></label><label>API-Pfad<input required value={form.basePath} onChange={e=>setForm({...form,basePath:e.target.value})}/></label><p>HTTPS oder ausdrücklich gewählter lokaler Server. Ein lokales Modell wird hier nicht installiert.</p></>}
    <details className="advanced-panel"><summary>Erweitert: Antwortlänge</summary><label>Maximale Ausgabetokens<input type="number" min={1} max={65536} value={form.maxOutputTokens} onChange={e=>setForm({...form,maxOutputTokens:Number(e.target.value)})}/></label>
    </details><button className="primary" disabled={busy}>Modellprofil speichern</button>
   </form>
   {profile&&<div className="editor"><p>{profile.binding.origin}{profile.binding.basePath} · Fassung {profile.revision}</p><p>Schlüssel: {profile.credentialPresent?'lokal verbunden':'fehlt oder neu verbinden'}</p>{profile.binding.credentialRef&&<><label>Eigener API-Schlüssel<input type="password" aria-label="Profil API-Schlüssel" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)}/></label><button className="secondary" disabled={busy||!key} onClick={()=>action(async()=>{await window.workbench.modelCommand('credential',{bindingHash:profile.binding.hash,key});setKey('');},'Schlüssel verschlüsselt und an dieses Ziel gebunden.')}>Schlüssel mit Profil verbinden</button><button className="text-button" disabled={busy} onClick={()=>action(()=>window.workbench.modelCommand('credential',{bindingHash:profile.binding.hash,remove:true}),'Schlüssel entfernt.')}>Profilschlüssel entfernen</button></>}</div>}
   <button className="primary" disabled={!profile||busy} onClick={()=>setStep(1)}>Weiter zum Kostenlimit</button>
  </section></div><div className="model-stage" hidden={step!==1}><section className="card setting">
   <h2>Preise für dein Modell</h2><p>Die Workbench reserviert vor jedem Aufruf einen sicheren Höchstbetrag und rechnet danach die gemeldete Nutzung ab. Du zahlst direkt beim Anbieter.</p>
   {!profile&&<p>Wähle oder speichere zuerst ein Modell unter „Modell & Zugang“.</p>}
   {template&&<div className="template-pick"><strong>{template.name} · Standard-API in USD</strong><p>Je Million Textbausteine (Tokens): Eingabe {template.input} USD · Ausgabe {template.output} USD. Stand {template.checkedAt.slice(0,10)}; keine automatische Preisaktualisierung.</p><small>Quelle: {template.source}</small><button className="secondary" disabled={busy} onClick={()=>action(saveTemplatePrice,'Preisdaten der Vorlage gespeichert. Bitte jetzt dein Budget festlegen.')}>Preisdaten der Vorlage übernehmen</button></div>}
   <details className="advanced-panel" open={!template}><summary>Preise und technische Grenzen selbst eintragen</summary><p>Für andere Modelle findest du diese Werte auf der Preisseite des Anbieters. Ohne dokumentierte Angaben bleibt der Aufruf gesperrt.</p>
   <p>{currentPrice?'Preisstand vorhanden: '+currentPrice.prices.version:'Noch kein passender Preisstand.'}</p>
   <form className="editor" onSubmit={e=>{e.preventDefault();if(!profile)return;void action(()=>window.workbench.modelCommand('price',{id:profile.id,input:{inputUpperBound:Number(price.inputBound),inputBoundSource:price.boundSource,prices:{version:new Date().toISOString(),provider:profile.binding.provider,protocol:profile.binding.protocol,model:profile.binding.model,currency:price.currency,inputMicrosPerMillion:Math.round(Number(price.input)*1e6),outputMicrosPerMillion:Math.round(Number(price.output)*1e6),cachedInputMicrosPerMillion:price.cached===''?null:Math.round(Number(price.cached)*1e6),reasoningMicrosPerMillion:price.reasoning===''?null:Math.round(Number(price.reasoning)*1e6),source:price.source,checkedAt:new Date().toISOString()}}}),'Preisstand gespeichert.');}}>
    <label>Währung<select value={price.currency} onChange={e=>setPrice({...price,currency:e.target.value})}><option>USD</option><option>EUR</option></select></label>
    {([['input','Eingabe je Million Tokens'],['output','Ausgabe je Million Tokens'],['cached','Cache-Lesen je Million (optional)'],['reasoning','Reasoning je Million (optional)']] as const).map(([k,label])=><label key={k}>{label}<input required={k==='input'||k==='output'} type="number" min={0} step="any" value={price[k]} onChange={e=>setPrice({...price,[k]:e.target.value})}/></label>)}
    <label>Offizielle Preisquelle<input type="url" required value={price.source} onChange={e=>setPrice({...price,source:e.target.value})}/></label>
    <label>Dokumentiertes Eingabelimit in Tokens<input type="number" min={1} max={10000000} required value={price.inputBound} onChange={e=>setPrice({...price,inputBound:e.target.value})}/></label>
    <label>Quelle für das Eingabelimit<input type="url" required value={price.boundSource} onChange={e=>setPrice({...price,boundSource:e.target.value})}/></label>
    <button className="secondary" disabled={busy||!profile}>Preis und Obergrenze speichern</button>
   </form>
  </details></section><section className="card setting"><h2>Dein Kostenlimit</h2><p>Gemeinsam für alle Kunden, getrennt nach Währung. Tages- und Monatswechsel gelten in UTC. Unklare Kosten bleiben reserviert.</p>
   <p className="setup-help">Zum Einstieg kannst du 1 pro Aufruf, 5 pro Tag und 25 pro Monat in der ausgewählten Währung eintragen. Das sind Obergrenzen, keine Buchung und kein Guthabenkauf.</p><button className="secondary" disabled={busy} onClick={()=>setBudget({...budget,perRun:'1',perDay:'5',perMonth:'25'})}>Startbudget eintragen</button>
   <form className="editor" onSubmit={e=>{e.preventDefault();void action(()=>window.workbench.modelCommand('budget',{currency:budget.currency,...Object.fromEntries(['perRun','perDay','perMonth'].map(k=>[k,Math.round(Number((budget as any)[k])*1e6)]))}),'Budget gespeichert.');}}>
    <label>Währung<select value={budget.currency} onChange={e=>setBudget({...budget,currency:e.target.value})}><option>USD</option><option>EUR</option></select></label>
    {([['perRun','Pro Aufruf'],['perDay','Pro UTC-Tag'],['perMonth','Pro UTC-Monat']] as const).map(([k,label])=><label key={k}>{label}<input type="number" min={0} step="any" required value={budget[k]} onChange={e=>setBudget({...budget,[k]:e.target.value})}/></label>)}<button className="secondary" disabled={busy}>Budget speichern</button>
   </form>
   {['USD','EUR'].map(c=><p key={c}>{c}: abgerechnet {money(data?.spending[c]?.spent)} · reserviert / unklar {money(data?.spending[c]?.held)}</p>)}
   <details><summary>Ungeklärte Modellkosten prüfen</summary><p>Prüfe zuerst die Abrechnung beim Anbieter. Trage die tatsächlichen Kosten dieses Aufrufs ein; 0 nur, wenn keine Kosten bestätigt wurden. Ohne Nachweis bleibt die Reservierung bestehen.</p>
    {data?.records.filter((r:any)=>r.kind==='model-run'&&r.content.state==='unknown').map((r:any)=><CostReconciliation key={r.id+':'+r.revision} record={r} customer={data.clients.find((c:any)=>c.id===r.clientId)?.name||r.clientId} busy={busy} save={input=>action(()=>window.workbench.modelCommand('reconcile',input),'Geprüfte Kosten übernommen. Kein Modellauftrag wiederholt.')}/>)}
    {!data?.records.some((r:any)=>r.kind==='model-run'&&r.content.state==='unknown')&&<p>Keine ungeklärten Kosten.</p>}
   </details>
   {currentPrice&&budget.currency!==currentPrice.prices.currency&&<p role="alert">Wähle für das Budget dieselbe Währung wie für den Modellpreis: {currentPrice.prices.currency}.</p>}
   <button className="primary" disabled={busy||!currentPrice||!savedBudget||budget.currency!==currentPrice.prices.currency} onClick={()=>setStep(2)}>Weiter zur Verwendung</button>
  </section></div><div className="model-stage" hidden={step!==2}><section className="card setting"><h2>Ein Modell für deinen Arbeitsbereich</h2><p className="setup-help">Für den Anfang reicht ein Modell für Analyse, Texte und Antworten. Unterschiedliche Modelle kannst du unter „Erweitert“ einzeln zuordnen.</p>
   <label>Kunde<select aria-label="Modellkunde" value={client} disabled={busy||!!clientId} onChange={e=>setClient(e.target.value)}><option value="">Kunde auswählen</option>{data?.clients.map((c:any)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <p>Ausgewählt: <strong>{profile?.name||'Bitte zuerst ein Modell wählen'}</strong></p>
   <button className="primary" disabled={busy||!profile||!client} onClick={()=>action(useForAll,'Modell für alle sechs Aufgaben gespeichert. Bestehende Freigaben müssen bei einem Modellwechsel neu geprüft werden.')}>Dieses Modell für alle Aufgaben verwenden</button>
   <p>{tasks.every(([task])=>routes?.tasks[task]?.id===profile?.id&&routes?.tasks[task]?.revision===profile?.revision)&&profile?'Alle Aufgaben verwenden dieses Modell.':'Noch nicht durchgehend zugeordnet. Bestehende Einzelzuordnungen bleiben bis zu deinem Klick erhalten.'}</p>
   <details className="advanced-panel"><summary>Erweitert: je Aufgabe ein anderes Modell</summary><p>Der Button oben ersetzt alle Einzelzuordnungen für diesen Kunden.</p>
   <div className="editor">{tasks.map(([task,label])=><label key={task}>{label}<select aria-label={'Route '+task} disabled={busy||!client} value={routes?.tasks[task]?routes.tasks[task].id+':'+routes.tasks[task].revision:''} onChange={e=>{const p=data.profiles.find((p:any)=>p.id+':'+p.revision===e.target.value);if(p)void action(()=>window.workbench.modelCommand('route',{clientId:client,task,ref:p.binding.profile}),'Aufgabe neu zugeordnet. Alte Freigaben gelten nicht für das neue Ziel.');}}><option value="">Profil wählen</option>{data?.profiles.map((p:any)=><option key={p.id} value={p.id+':'+p.revision}>{p.name} · {p.binding.model}</option>)}</select>{routes?.tasks[task]&&data?.profiles.find((p:any)=>p.id===routes.tasks[task].id)?.revision!==routes.tasks[task].revision&&<small>Profil geändert: neu auswählen.</small>}</label>)}</div>
   </details><p>Ausgewähltes Profil: {profile?.name||'keines'} · Test: {cap?.structured?'Text und JSON geprüft':cap?.text?'Nur Text geprüft':'noch nicht geprüft'}. Dies bestätigt keine inhaltliche Richtigkeit.</p>
   <button className="secondary" disabled={busy||!client||!profile||routes?.tasks.analysis?.id!==profile.id} onClick={()=>action(()=>window.workbench.modelCommand('test',{clientId:client,bindingHash:profile!.binding.hash}),'Synthetischer Test abgeschlossen. Ergebnis oben prüfen.')}>Analyseprofil mit synthetischen Daten testen</button>
   <p>Der Test sendet ausschließlich einen kurzen Beispielauftrag. Die Kostenreservierung und Zieladresse werden vorher angezeigt. Für andere Profile zuerst die Analyse-Zuordnung ändern.</p>
  </section></div>
 </section>;
}
function CostReconciliation({record,customer,busy,save}:{record:any;customer:string;busy:boolean;save:(input:any)=>Promise<void>}){
 const [amount,setAmount]=useState(''),[note,setNote]=useState('');const r=record.content,currency=r.quote.maximum.currency;
 return <form className="editor" onSubmit={e=>{e.preventDefault();void save({runId:record.id,revision:record.revision,currency,micros:Math.round(Number(amount)*1e6),note});}}>
  <p>{customer} · {r.quote.prices.model} · {new Date(r.createdAt).toLocaleString()}<br/>Auftrag: {record.id}<br/>Reserviert: {r.quote.maximum.micros/1e6} {currency}</p>
  <label>Bestätigte Kosten ({currency})<input aria-label="Bestätigte Modellkosten" type="number" min="0" step="0.000001" required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
  <label>Abrechnungsnachweis / Prüfnotiz<input aria-label="Kostenprüfnotiz" required minLength={8} maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label>
  <button className="secondary" disabled={busy||amount===''||note.trim().length<8}>Kostenabgleich prüfen</button>
 </form>;
}

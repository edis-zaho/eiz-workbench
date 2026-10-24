const {localBackupKey}=require('./backup-key.cjs');
const {encryptPortableBackup}=require('./backup-crypto.cjs');
const {createGmailProvider}=require('./gmail-provider.cjs');
const {saveAnalysisAuto,runAnalysisAuto}=require('./analysis-auto.cjs');
const {savePreparation,runPreparation}=require('./reply-preparation.cjs');
const {runMailSync}=require('./mail-sync.cjs');
const {runDialogueAuto,saveDialogueAutoPolicy}=require('./dialogue-auto.cjs');
const { app, BrowserWindow, ipcMain, utilityProcess, Tray, Menu, nativeImage, dialog, shell, safeStorage } = require('electron');
const { createGoogleService, makeRawMail } = require('./google.cjs');
const {dispatchDialogue}=require('./dialogue.cjs');
const { dispatchOutbound } = require('./outbound.cjs');
const { createVault } = require('./models.cjs');
const {createModelVault}=require('./model-vault.cjs');
const {createModelDispatcher}=require('./model-dispatch.cjs');
const {createRelayClient}=require('./relay-client.cjs');
const {runRelay}=require('./relay-sync.cjs');
const {createTracking}=require('./tracking.cjs');
const { join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const {resolveProfileDirectory}=require('./profile.cjs');
const appChannel=require('../package.json').workbenchChannel;
app.setName(appChannel==='public'?'EiZ Workbench':'EiZ Revenue Workbench Next');
app.setPath('userData',resolveProfileDirectory({appData:app.getPath('appData'),channel:appChannel,
  ...(process.env.EIZ_SMOKE_DIR?{testDirectory:resolve(process.env.EIZ_SMOKE_DIR),testMode:true}:{})}));
let win, tray, worker, quitting = false, background = true, connection, workerReady = false, google, syncTimer, syncTicking=false, outboundTicking=false;
const token = randomBytes(32).toString('hex');
const workerToken = randomBytes(32).toString('hex');
const dataDir = app.getPath('userData');
const entry = pathToFileURL(join(__dirname, '../dist/index.html')).href;
const preferences = join(dataDir, 'preferences.json');
function trusted(event) { if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== entry) throw new Error('Unbekannte Oberfläche.'); }
async function request(path, body = {}, method='POST') {
  if (!workerReady) throw new Error('Hintergrunddienst ist nicht verfügbar. Bitte Workbench neu starten.');
  if(appChannel==='public'&&method==='POST'){
    let purpose=path.endsWith('/ai-reserve')?body.purpose:path.includes('/knowledge-runs/')&&path.endsWith('/reserve')?'knowledge':path.includes('/writing-runs/')&&path.endsWith('/reserve')?'campaign-writing':path.includes('/reply-analysis/')&&path.endsWith('/reserve')?'reply-analysis':path.includes('/reply-writing/')&&path.endsWith('/reserve')?'reply-writing':null;
    if(purpose){const clientId=path.split('/')[3],setup=await request(`/api/clients/${clientId}/model-setup/${purpose}`,{},'GET');body={...body,expectedBindingHash:body.expectedBindingHash||setup.binding.hash};}
  }
  const res = await fetch(connection + path, { method, headers: { Authorization: `Bearer ${token}`, 'X-EiZ-Worker': workerToken, 'Content-Type': 'application/json' }, ...(method==='GET'?{}:{body: JSON.stringify(body)}), signal: AbortSignal.timeout(path.startsWith('/api/backup-file/')?300000:30000) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error); return result;
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    mkdirSync(dataDir, { recursive: true });
    try { background = JSON.parse(readFileSync(preferences, 'utf8')).background !== false; } catch {}
    worker = utilityProcess.fork(join(__dirname, '../backend/run.cjs'), [], { env: { ...process.env, EIZ_APP_CHANNEL:appChannel, EIZ_DATA_DIR: dataDir, EIZ_LOCAL_TOKEN: token, EIZ_WORKER_TOKEN: workerToken }, serviceName: 'EiZ Hintergrundverarbeitung', stdio: 'pipe' });
    if(appChannel==='public')worker.postMessage({type:'backup-key',key:localBackupKey(dataDir,safeStorage).toString('base64')});
    worker.on('exit', () => { workerReady = false; });
    connection = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Hintergrunddienst konnte nicht starten.')), 15000);
      worker.on('message', msg => { if (msg.type === 'ready') { clearTimeout(timeout); workerReady = true; resolve(msg.url); } if (msg.type === 'failed') { clearTimeout(timeout); reject(new Error('Lokale Datenbank konnte nicht geöffnet werden.')); } });
      worker.once('exit', () => { clearTimeout(timeout); reject(new Error('Hintergrunddienst wurde beendet.')); });
    });
    ipcMain.handle('bootstrap', event => { trusted(event); return { url: connection, token, dataDir, background, version: require('../package.json').version,publicMode:appChannel==='public' }; });
    const legacyVault=createVault(dataDir,safeStorage),boundVault=createModelVault(dataDir,safeStorage);
    const vault={...legacyVault,key:b=>typeof b==='object'?boundVault.key(b):legacyVault.key(b)};
    const callModel=createModelDispatcher({request,vault:boundVault,confirm:async({run,payload,quote})=>{const answer=await dialog.showMessageBox(win,{type:'question',title:'Modellübertragung prüfen',message:`${run.binding.provider} · ${run.binding.model}`,detail:`Ziel: ${run.binding.origin}${run.binding.basePath}
Ausgabegrenze: ${run.binding.maxOutputTokens}
Reserviert: ${quote.maximum?quote.maximum.micros/1000000+' '+quote.maximum.currency:'unbekannt'}

Übertragener Inhalt:
${JSON.stringify(payload,null,2)}`,buttons:['Abbrechen','Übertragen'],defaultId:0,cancelId:0});return answer.response===1;}});
    ipcMain.handle('model-status',event=>{trusted(event);return vault.status();});
    ipcMain.handle('model-save',(event,data)=>{trusted(event);return vault.save(data?.provider,data?.key,data?.remove);});
    ipcMain.handle('model-command',async(event,data)=>{
      trusted(event);const {action,input}=data||{};
      if(action==='list'){
        const state=await request('/api/models',{},'GET');
        return {...state,profiles:state.profiles.map(p=>{let credentialPresent=false;try{boundVault.key(p.binding);credentialPresent=true;}catch{}return {...p,credentialPresent};})};
      }
      if(action==='profile')return request('/api/models/profile',input);
      if(action==='price')return request('/api/models/price',input);
      if(action==='budget')return request('/api/models/budget',input);
      if(action==='reconcile'){
        const state=await request('/api/models',{},'GET'),run=state.records.find(r=>r.kind==='model-run'&&r.id===input?.runId&&r.revision===input.revision&&r.content.state==='unknown');
        if(!run||input.currency!==run.content.quote.maximum.currency||!Number.isSafeInteger(input.micros)||input.micros<0||typeof input.note!=='string'||input.note.trim().length<8||input.note.length>500)throw Error('Kostenauftrag oder Abrechnungsnachweis ungültig.');
        const answer=await dialog.showMessageBox(win,{type:'question',title:'Modellkosten abgleichen',message:`Geprüfte Kosten: ${input.micros/1e6} ${input.currency}`,detail:`Auftrag ${run.id}\n${input.note}\nNur nach Prüfung der Anbieterabrechnung bestätigen. Auch 0 muss belegt sein. Dies wiederholt keinen Auftrag und verändert keine Nachrichten.`,buttons:['Abbrechen','Geprüfte Kosten übernehmen'],defaultId:0,cancelId:0});
        if(answer.response!==1)throw Error('Kostenabgleich abgebrochen. Reservierung bleibt bestehen.');
        return request('/api/models/reconcile',{...input,confirmed:true});
      }
      if(action==='route'){if(!/^[a-f0-9-]{36}$/.test(input?.clientId))throw Error('Ungültiger Kunde.');return request(`/api/clients/${input.clientId}/model-route`,{task:input.task,ref:input.ref});}
      if(action==='credential'){
        const state=await request('/api/models',{},'GET'),p=state.profiles.find(p=>p.binding.hash===input?.bindingHash);
        if(!p)throw Error('Modellprofil geändert.');
        return input.remove?boundVault.remove(p.binding.credentialRef):boundVault.save(p.binding,input.key);
      }
      if(action==='test'){
        if(!/^[a-f0-9-]{36}$/.test(input?.clientId))throw Error('Ungültiger Kunde.');
        const setup=await request(`/api/clients/${input.clientId}/model-setup/analysis`,{},'GET');
        if(setup.binding.hash!==input.bindingHash)throw Error('Analyseprofil zuerst auswählen.');
        const run=await request('/api/models/test-reserve',{clientId:input.clientId,expectedBindingHash:input.bindingHash});
        try{
          const result=await callModel(run);
          await request(`/api/clients/${input.clientId}/ai/${run.id}/finish`,{status:'completed',result:result.text,usage:result.usage});
          return request('/api/models/test-result',{runId:run.id,results:{text:result.text,structured:result.text}});
        }catch(e){try{await request(`/api/clients/${input.clientId}/ai/${run.id}/finish`,{status:e.kind||'unknown',result:'Synthetischer Test nicht abgeschlossen.',usage:{}});}catch{}throw e;}
      }
      throw Error('Unbekannte Modelleinstellung.');
    });
    const knowledgeBusy=new Set();
    const replyBusy=new Set();
    ipcMain.handle('reply-analyze',async(event,data)=>{
      trusted(event);
      if(!data||Object.keys(data).some(k=>!['clientId','eventId','basisHash','confirmed'].includes(k))||![data.clientId,data.eventId].every(id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))throw new Error('Ungültiger Antwortauftrag.');
      if(replyBusy.has(data.clientId))throw new Error('Für diesen Kunden läuft bereits eine Eingangsauswertung.');
      replyBusy.add(data.clientId);
      try{
        const base=`/api/clients/${data.clientId}/reply-analysis`,setup=await request(base+`/${data.eventId}/context`,{},'GET');
        const run=await request(base+`/${data.eventId}/reserve`,{basisHash:data.basisHash,confirmed:data.confirmed});
        let result;
        try{result=await callModel(run);}
        catch(error){return request(base+`/${run.id}/finish`,{status:error.kind||'failed',text:'',usage:{}});}
        return request(base+`/${run.id}/finish`,{status:'completed',text:result.text,usage:result.usage});
      }finally{replyBusy.delete(data.clientId);}
    });
    const dialogueBusy=new Set();
    ipcMain.handle('dialogue-send',async(event,data)=>{trusted(event);if(!data||Object.keys(data).some(k=>!['clientId','incomingId','draftId','basisHash','confirmed'].includes(k))||![data.clientId,data.incomingId,data.draftId].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v))||data.confirmed!==true)throw new Error('Ungültige Versandfreigabe.');if(dialogueBusy.has(data.clientId))throw new Error('Antwortversand läuft bereits.');dialogueBusy.add(data.clientId);try{return await dispatchDialogue({google,request,data,stopping:()=>quitting||!workerReady});}finally{dialogueBusy.delete(data.clientId);}});
    let dialogueAutoTicking=false;
    const runAuto=async(clientId)=>{if(dialogueAutoTicking||quitting||!workerReady)return {busy:true};dialogueAutoTicking=true;try{return await runDialogueAuto({google,request,clientId,stopping:()=>quitting||!workerReady});}finally{dialogueAutoTicking=false;}};
    ipcMain.handle('dialogue-auto-run',async(event,data)=>{trusted(event);if(!data||Object.keys(data).length!==1||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('Ungültiger Kunde.');return runAuto(data.clientId);});
    ipcMain.handle('dialogue-auto-policy',async(event,data)=>{trusted(event);return saveDialogueAutoPolicy({google,request,data});});
    if(!process.env.EIZ_SMOKE_DIR){const timer=setInterval(()=>runAuto().catch(()=>{}),30000);timer.unref?.();}
    ipcMain.handle('reply-approval-policy',async(event,data)=>{trusted(event);if(!data||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('Ungültiger Kunde.');const {clientId,...input}=data;return request(`/api/clients/${clientId}/reply-approval/policy`,input);});
    async function confirmModelPolicy(data,purpose){if(data?.enabled===false)return true;const setup=await request(`/api/clients/${data.clientId}/model-setup/${purpose}`,{},'GET');const a=await dialog.showMessageBox(win,{type:'question',title:'Automatische Modellübertragung',message:`${setup.binding.model} · ${setup.binding.origin}`,detail:`Zweck: ${purpose}. Übertragen werden passende Mailausschnitte und der freigegebene Faktenrahmen. Keine Anhänge oder Zugangsdaten. Maximal ${data.dailyLimit} Aufrufe pro UTC-Tag; zusätzlich gelten die Geldbudgets. Profilwechsel erfordert neue Freigabe.`,buttons:['Abbrechen','Rahmen freigeben'],defaultId:0,cancelId:0});return a.response===1;}
    let preparationTicking=false;
    const runPrepared=async(clientId)=>{if(preparationTicking||quitting||!workerReady)return {busy:true};preparationTicking=true;try{return await runPreparation({google,vault,request,callModel,clientId,stopping:()=>quitting||!workerReady});}finally{preparationTicking=false;}};
    ipcMain.handle('reply-preparation-run',async(event,data)=>{trusted(event);if(!data||Object.keys(data).length!==1||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('Ungültiger Kunde.');return runPrepared(data.clientId);});
    ipcMain.handle('reply-preparation-policy',async(event,data)=>{trusted(event);if(!await confirmModelPolicy(data,'reply-writing'))throw Error('Übertragung nicht freigegeben.');return savePreparation({google,vault,request,data});});
    if(!process.env.EIZ_SMOKE_DIR){const timer=setInterval(()=>runPrepared().catch(()=>{}),45000);timer.unref?.();}
    let analysisTicking=false;
    const runAnalyzed=async(clientId)=>{if(analysisTicking||quitting||!workerReady)return {busy:true};analysisTicking=true;try{return await runAnalysisAuto({google,vault,request,callModel,clientId,stopping:()=>quitting||!workerReady});}finally{analysisTicking=false;}};
    ipcMain.handle('analysis-auto-policy',async(event,data)=>{trusted(event);if(!await confirmModelPolicy(data,'reply-analysis'))throw Error('Übertragung nicht freigegeben.');return saveAnalysisAuto({google,vault,request,data});});
    ipcMain.handle('analysis-auto-run',async(event,data)=>{trusted(event);if(!data||Object.keys(data).length!==1||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('Ungültiger Kunde.');return runAnalyzed(data.clientId);});
    if(!process.env.EIZ_SMOKE_DIR){const timer=setInterval(()=>runAnalyzed().catch(()=>{}),30000);timer.unref?.();}
    const replyWritingBusy=new Set();
    ipcMain.handle('reply-write',async(event,data)=>{
      trusted(event);if(!data||Object.keys(data).some(k=>!['clientId','incomingId','productId','factIds','basisHash','confirmed'].includes(k))||![data.clientId,data.incomingId,data.productId].every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id)))throw new Error('Ungültiger Antwortauftrag.');
      if(replyWritingBusy.has(data.clientId))throw new Error('Antwortauftrag läuft bereits.');replyWritingBusy.add(data.clientId);
      try{const base=`/api/clients/${data.clientId}/reply-writing/${data.incomingId}`,setup=await request(base+'/context',{productId:data.productId,factIds:data.factIds});const run=await request(base+'/reserve',{productId:data.productId,factIds:data.factIds,basisHash:data.basisHash,confirmed:data.confirmed});let result;try{result=await callModel(run);}catch(error){return request(base+`/${run.id}/finish`,{status:error.kind||'failed',text:'',usage:{}});}return request(base+`/${run.id}/finish`,{status:'completed',text:result.text,usage:result.usage});}finally{replyWritingBusy.delete(data.clientId);}
    });
    const writingBusy=new Set();
    ipcMain.handle('campaign-write',async(event,data)=>{
      trusted(event);
      if(!data||Object.keys(data).some(k=>!['clientId','campaignId','basisHash','confirmed'].includes(k))||![data.clientId,data.campaignId].every(id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))throw new Error('Ungültiger Textauftrag.');
      if(writingBusy.has(data.clientId))throw new Error('Für diesen Kunden läuft bereits ein Textauftrag.');
      writingBusy.add(data.clientId);
      try{
        const base=`/api/clients/${data.clientId}/campaigns/${data.campaignId}`;
        const setup=await request(base+'/writing-context',{},'GET');
        
        const run=await request(base+'/writing-runs/reserve',{basisHash:data.basisHash,confirmed:data.confirmed});
        let result;
        try{result=await callModel(run);}
        catch(error){return request(base+`/writing-runs/${run.id}/finish`,{status:error.kind||'failed',text:'',usage:{}});}
        return request(base+`/writing-runs/${run.id}/finish`,{status:'completed',text:result.text,usage:result.usage});
      }finally{writingBusy.delete(data.clientId);}
    });
    ipcMain.handle('knowledge-extract',async(event,data)=>{
      trusted(event);
      if(!data||Object.keys(data).some(k=>!['clientId','productId','productRevision','sourceIds','briefRevision','confirmed'].includes(k))||![data.clientId,data.productId].every(id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))throw new Error('Ungültige Wissensauswahl.');
      if(knowledgeBusy.has(data.clientId))throw new Error('Für diesen Kunden läuft bereits eine Wissensabfrage.');
      knowledgeBusy.add(data.clientId);
      try{
        const base=`/api/clients/${data.clientId}/products/${data.productId}/knowledge-runs`;
        const brief=await request(`/api/clients/${data.clientId}/brief`,{},'GET');
        
        const run=await request(base+'/reserve',{productRevision:data.productRevision,sourceIds:data.sourceIds,briefRevision:data.briefRevision,confirmed:data.confirmed});
        let result;
        try{result=await callModel(run);}
        catch(error){return request(base+`/${run.id}/finish`,{status:error.kind||'failed',text:'',usage:{}});}
        return request(base+`/${run.id}/finish`,{status:'completed',text:result.text,usage:result.usage});
      }finally{knowledgeBusy.delete(data.clientId);}
    });
    ipcMain.handle('model-run',async(event,data)=>{
      trusted(event);
      if(!data||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId)||!['analysis','writing'].includes(data.purpose))throw new Error('Ungültige Modellaufgabe.');
      const base=`/api/clients/${data.clientId}`;
      const brief=await request(base+'/brief',{},'GET');
      
      const run=await request(base+'/ai-reserve',{purpose:data.purpose,revision:data.revision});
      let result;
      try { result=await callModel(run); }
      catch(error){await request(base+`/ai/${run.id}/finish`,{status:error.kind||'failed',result:error.message,usage:{}});throw error;}
      return request(base+`/ai/${run.id}/finish`,{status:'completed',result:result.text,usage:result.usage});
    });
    const mailHealth=new Map();
    google=createGmailProvider({syncStatus:id=>mailHealth.get(id),google:createGoogleService({directory:dataDir,safeStorage,openExternal:url=>shell.openExternal(url),fetcher:(...args)=>fetch(...args)}),stop:async id=>{const c=await customer(id);await request('/api/clients/'+id+'/pause',{paused:true,version:c.version});}});
    const customerId=value=>{if(typeof value!=='string'||!/^[a-f0-9-]{36}$/.test(value))throw new Error('Ungültiger Kunde.');return value;};
    const customer=async value=>{const id=customerId(value);const state=await request('/api/state?clientId='+id,{},'GET');return state.clients.find(c=>c.id===id);};
    const relay=createRelayClient(dataDir,safeStorage);
    google.prepareTracking=createTracking({relay,request,stopping:()=>quitting||!workerReady});
    const relayCustomer=async id=>{const c=await customer(id);if(!c)throw Error('Kunde nicht gefunden.');return c;};
    ipcMain.handle('relay-status',async(event,id)=>{trusted(event);await relayCustomer(id);return relay.status(id);});
    ipcMain.handle('relay-connect',async(event,data)=>{
      trusted(event);const c=await relayCustomer(data?.clientId);
      return relay.connect(data,async target=>{const answer=await dialog.showMessageBox(win,{type:'question',title:'Trackingdienst verbinden',message:`Trackingdienst für ${c.name} verbinden?`,detail:`Der Leseschlüssel wird an ${target.baseURL} übertragen. Datenstrom: ${target.stream}. Nur einen von dir kontrollierten Dienst verwenden. Es werden noch keine Signale importiert oder Nachrichten versendet.`,buttons:['Abbrechen','Dienst verbinden'],defaultId:0,cancelId:0});await relayCustomer(c.id);return answer.response===1;});
    });
    ipcMain.handle('tracking-configure',async(event,data)=>{
      trusted(event);const c=await relayCustomer(data?.clientId),r=relayCurrent(data);
      if(typeof data.enabled!=='boolean'||!Array.isArray(data.hosts))throw Error('Trackingfreigabe fehlt.');
      const answer=await dialog.showMessageBox(win,{type:'question',title:'Versandtracking freigeben',message:data.enabled?`Tracking für ${c.name} aktivieren?`:`Tracking für ${c.name} deaktivieren?`,detail:data.enabled?`Für neue Kampagnenmails, Testmails und Antworten werden Pixel und HTTPS-Links bei ${r.connection.baseURL} registriert. Nachrichtentext bleibt unverändert. Linkdomains: ${data.hosts.join(', ')||'keine'}. Laufzeit: 30 Tage. Abholung bei laufender App automatisch. Technische Abrufe beweisen keinen menschlichen Leser. Dienstzugang bleibt verschlüsselt auf diesem PC.`:'Neue Nachrichten erhalten kein Tracking. Bereits versendete Links bleiben bis zu ihrem Ablauf erreichbar. Automatische Abholung wird ebenfalls deaktiviert.',buttons:['Abbrechen','Bestätigen'],defaultId:0,cancelId:0});
      if(answer.response!==1)return {cancelled:true};relayCurrent(data);
      if(data.enabled&&data.writeKey)await relay.setWriter(c.id,r.revision,data.writeKey);
      const latest=relay.status(c.id);if(data.enabled&&!latest.connection?.canRegister)throw Error('Bitte den Schreibschlüssel des verbundenen Datenstroms eingeben.');
      const result=await request(`/api/clients/${c.id}/tracking/configure`,{identity:relayIdentity(r.connection),hosts:data.hosts,enabled:data.enabled,clientVersion:c.version});return {cancelled:false,...latest,tracking:result};
    });
    ipcMain.handle('relay-check',async(event,data)=>{trusted(event);await relayCustomer(data?.clientId);return relay.check(data.clientId,data.revision);});
    ipcMain.handle('relay-disconnect',async(event,data)=>{
      trusted(event);const c=await relayCustomer(data?.clientId);
      return relay.disconnect(c.id,data.revision,async()=>{const answer=await dialog.showMessageBox(win,{type:'question',title:'Trackingdienst lokal trennen',message:`Trackingzugang für ${c.name} entfernen?`,detail:'Der lokal gespeicherte Leseschlüssel wird entfernt. Bestehende Signalbelege bleiben erhalten. Den Schlüssel bei Bedarf zusätzlich auf dem Trackingdienst widerrufen.',buttons:['Abbrechen','Trackingzugang entfernen'],defaultId:0,cancelId:0});if(answer.response===1){const current=relay.status(c.id).connection;await request(`/api/clients/${c.id}/relay-sync/configure`,{identity:{baseURL:current.baseURL,stream:current.stream,instanceId:current.instanceId},enabled:false,clientVersion:c.version});}return answer.response===1;});
    });
    const relayIdentity=c=>({baseURL:c.baseURL,stream:c.stream,instanceId:c.instanceId});
    const relayCurrent=data=>{const r=relay.status(data.clientId);if(!r.connection||r.revision!==data.revision)throw Error('Trackingverbindung wurde geändert. Bitte neu laden.');return r;};
    ipcMain.handle('relay-bind',async(event,data)=>{
      trusted(event);const c=await relayCustomer(data?.clientId),r=relayCurrent(data);
      const answer=await dialog.showMessageBox(win,{type:'question',title:'Relay-Nachricht fest zuordnen',message:`Relay-Referenz für ${c.name} fest zuordnen?`,detail:'Die Referenz wird dauerhaft an den gewählten bestätigten Versandbeleg gebunden. Eine andere Nachricht kann später nicht dieselbe Referenz übernehmen. Noch keine automatische Abholung.',buttons:['Abbrechen','Zuordnung speichern'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};relayCurrent(data);
      return request(`/api/clients/${c.id}/relay-sync/bind`,{stream:r.connection.stream,messageRef:data.messageRef,eventId:data.eventId,eventHash:data.eventHash,actor:data.actor,confirmed:true});
    });
    ipcMain.handle('relay-configure',async(event,data)=>{
      trusted(event);const c=await relayCustomer(data?.clientId),r=relayCurrent(data);if(typeof data.enabled!=='boolean')throw Error('Abholstatus fehlt.');
      if(data.enabled){const answer=await dialog.showMessageBox(win,{type:'question',title:'Signalabholung freigeben',message:`Signale für ${c.name} automatisch abholen?`,detail:`Quelle: ${r.connection.baseURL}. Nur fest zugeordnete Nachrichten werden übernommen. Bei fehlenden Zuordnungen hält der Fortschritt an. Keine Mails oder Signalreaktionen werden ausgelöst.`,buttons:['Abbrechen','Abholung freigeben'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};}
      relayCurrent(data);return request(`/api/clients/${c.id}/relay-sync/configure`,{identity:relayIdentity(r.connection),enabled:data.enabled,clientVersion:c.version});
    });
    ipcMain.handle('relay-pull',async(event,data)=>{trusted(event);await relayCustomer(data?.clientId);relayCurrent(data);return runRelay({clientId:data.clientId,relay,request,stopping:()=>quitting||!workerReady});});
    let relayTicking=false;
    const pollRelay=async()=>{if(relayTicking||quitting||!workerReady)return;relayTicking=true;try{for(const row of await request('/api/relay-due',{},'GET')){if(quitting)break;try{await runRelay({clientId:row.clientId,relay,request,stopping:()=>quitting||!workerReady});}catch{}}}catch{}finally{relayTicking=false;}};
    if(!process.env.EIZ_SMOKE_DIR){const timer=setInterval(pollRelay,15000);timer.unref?.();setTimeout(pollRelay,10000).unref?.();}
    const syncMail=(clientId,force=false)=>runMailSync({clientId,force,google,request,stopping:()=>quitting||!workerReady});
    const runDeliveryAuto=async row=>{
      const c=await customer(row.clientId),base=`/api/clients/${c.id}/delivery-progress`;
      let claim;
      try{claim=await request(base+'/claim',{mailboxId:row.mailboxId,clientVersion:c.version,automatic:true});await google.withMailbox(c.id,async mailbox=>{if(mailbox.id!==row.mailboxId)throw new Error('Postfach wurde geändert.');const result=await google.scanDeliveries(claim.mails,mailbox,claim);await request(base+'/finish',{...result,runId:claim.runId,leaseId:claim.leaseId,mailboxId:mailbox.id,clientVersion:c.version});});}
      catch(e){try{if(claim)await request(base+'/fail',{runId:claim.runId,leaseId:claim.leaseId,error:e.message,historyExpired:e.historyExpired===true});else await request(base+'/start-failed',{generation:row.generation,error:e.message});}catch{}throw e;}
    };
    let deliveryTicking=false;
    const pollDelivery=async()=>{if(deliveryTicking||quitting||!workerReady)return;deliveryTicking=true;try{for(const row of await request('/api/delivery-due',{},'GET')){if(quitting)break;if(google.status(row.clientId).busy)break;try{await runDeliveryAuto(row);}catch{}}}catch{}finally{deliveryTicking=false;}};
    {const timer=setInterval(pollDelivery,15000);timer.unref?.();setTimeout(pollDelivery,6000).unref?.();}
    const pollMailSync=async()=>{if(syncTicking||quitting||!workerReady)return;syncTicking=true;try{const due=await request('/api/sync-due',{},'GET');for(const row of due){try{await syncMail(row.clientId,false);}catch{}}}finally{syncTicking=false;}};
    if(!process.env.EIZ_SMOKE_DIR){syncTimer=setInterval(pollMailSync,60000);syncTimer.unref?.();setTimeout(pollMailSync,5000).unref?.();}
    const pollOutbound=async()=>{if(outboundTicking||quitting||!workerReady)return;outboundTicking=true;try{for(const row of await request('/api/outbound-due',{},'GET')){if(quitting)break;try{await dispatchOutbound({google,request,row,stopping:()=>quitting||!workerReady});}catch{/* No reservation, or an outstanding reservation blocks the next attempt. */}}}catch{}finally{outboundTicking=false;}};
    if(!process.env.EIZ_SMOKE_DIR){const timer=setInterval(pollOutbound,15000);timer.unref?.();setTimeout(pollOutbound,8000).unref?.();}
    ipcMain.handle('privacy-command',async(event,data)=>{trusted(event);const {action,input}=data||{};const c=await customer(input?.clientId);if(!/^[a-f0-9-]{36}$/.test(input?.leadId)||!['preview','delete'].includes(action))throw Error('Ungültige Löschanfrage.');const base=`/api/clients/${c.id}/privacy`,preview=await request(base+'/preview',{leadId:input.leadId,scope:input.scope});if(action==='preview')return preview;if(preview.hash!==input.hash)throw Error('Löschvorschau geändert.');const a=await dialog.showMessageBox(win,{type:'warning',title:'Daten endgültig löschen',message:preview.scope==='customer'?`Gesamten Bestand von ${preview.customerName} löschen?`:`Kontakt ${preview.contact} löschen?`,detail:preview.notice+'\nAuch '+preview.localBackups.length+' lokale Sicherungen des gesamten Profils werden entfernt.\n'+preview.externalCopies,buttons:['Abbrechen','Endgültig löschen'],defaultId:0,cancelId:0});if(a.response!==1)return {cancelled:true};const result=await request(base+'/delete',{hash:preview.hash});if(preview.scope==='customer')google.disconnect(c.id);return result;});
    ipcMain.handle('sender-save',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId);
      if(!data||Object.keys(data).some(k=>!['clientId','displayName','signatureText'].includes(k)))throw Error('Ungültiges Absenderprofil.');
      return google.withMailbox(c.id,async m=>request(`/api/clients/${c.id}/sender-profile`,{profile:{clientId:c.id,connectionId:m.id,revision:1,displayName:data.displayName,signatureText:data.signatureText},identity:{providerKind:'gmail',connectionId:m.id,email:m.email,checkedAt:m.checkedAt}}));
    });
    ipcMain.handle('google-status',async(event,id)=>{trusted(event);await customer(id);const sync=await request(`/api/clients/${id}/mail-sync`,{},'GET').catch(()=>null),progress=await request(`/api/clients/${id}/delivery-progress`,{},'GET').catch(()=>null),m=google.status(id).mailbox;mailHealth.set(id,{mailboxId:m?.id,verified:!!sync&&!sync.stale&&progress?.status==='complete'&&!progress.stale&&progress.unmatched===0,lastSyncAt:sync?.lastSuccessAt});const sender=await request(`/api/clients/${id}/sender-profile`,{},'GET');return {...google.status(id),capabilities:google.mailStatus(id),senderReady:!!sender&&sender.profile.connectionId===m?.id&&sender.identity.email===m?.email};});
    ipcMain.handle('google-config',async event=>{trusted(event);const pick=await dialog.showOpenDialog(win,{title:'Google-Desktop-Konfiguration importieren',properties:['openFile'],filters:[{name:'Google OAuth JSON',extensions:['json','eizbackup']}]});if(pick.canceled)return {cancelled:true};if(statSync(pick.filePaths[0]).size>20000)throw new Error('Google-Konfigurationsdatei ist zu groß.');google.configure(readFileSync(pick.filePaths[0],'utf8'));return {cancelled:false};});
    ipcMain.handle('google-connect',async(event,id)=>{trusted(event);const c=await customer(id),previous=google.status(id).mailbox;if(c.status==='paused')throw new Error('Kunde ist pausiert.');const result=await google.connect(id,async email=>{const latest=await customer(id);if(latest.version!==c.version||latest.status==='paused')throw new Error('Kunde wurde geändert. Bitte erneut verbinden.');const answer=await dialog.showMessageBox(win,{type:'question',title:'Postfach zuordnen',message:`${email} mit ${c.name} verbinden?`,detail:'Dieses Postfach wird nur diesem Kunden zugeordnet. Es wird noch keine E-Mail versendet.',buttons:['Abbrechen','Postfach verbinden'],defaultId:0,cancelId:0});return answer.response===1;});if(!result.cancelled&&previous&&result.mailbox?.id!==previous.id)await request(`/api/clients/${id}/mail-sync/configure`,{mailboxId:result.mailbox.id,clientVersion:c.version,enabled:false});return result;});
    ipcMain.handle('google-cancel',event=>{trusted(event);google.cancel();return {ok:true};});
    ipcMain.handle('google-read-connect',async(event,id)=>{
      trusted(event);const c=await customer(id);
      if(!google.status(id).mailbox)throw new Error('Bitte zuerst ein Google-Postfach zuordnen.');
      const answer=await dialog.showMessageBox(win,{type:'question',title:'Lesenden Gmail-Zugriff erlauben',message:'Gmail-Nachrichten lesen und unklare Sendungen prüfen?',detail:'Google erteilt Zugriff auf Nachrichten und Einstellungen des Postfachs. Dieser Ausbau nutzt ihn gezielt zum Abgleich unklarer Testsendungen. Es werden keine Nachrichten gelöscht, verändert oder erneut gesendet. Du kannst danach gezielt Gespraeche zu bestaetigten Testsendungen abrufen. Eingehende Nachrichten halten weitere Kontaktversuche an.',buttons:['Abbrechen','Lesezugriff einrichten'],defaultId:0,cancelId:0});
      if(answer.response!==1)return {cancelled:true};
      return google.connect(id,async()=>{if((await customer(id)).version!==c.version)throw new Error('Kunde wurde geändert. Bitte erneut beginnen.');return true;},true);
    });
    ipcMain.handle('google-reconcile',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId);
      if(typeof data?.id!=='string'||!/^[a-f0-9-]{36}$/.test(data.id))throw new Error('Ungültige Testkennung.');
      const path=`/api/clients/${c.id}/mail-tests/${data.id}/reconcile`;
      return google.withMailbox(c.id,async mailbox=>{
        const mail=await request(path,{},'GET');
        const outcome=await google.findSent(mail,mailbox);
        return request(path,{...outcome,mailboxId:mailbox.id,messageId:mail.messageId,clientVersion:c.version});
      });
    });
    ipcMain.handle('google-thread-context',async(event,data)=>{
      trusted(event);if(!data||data.confirmed!==true||Object.keys(data).some(k=>!['clientId','incomingId','confirmed'].includes(k))||typeof data.incomingId!=='string'||!/^[a-f0-9-]{36}$/.test(data.incomingId))throw new Error('Gesprächsabruf bitte bewusst bestätigen.');
      const c=await customer(data.clientId),path=`/api/clients/${c.id}/thread-context/${data.incomingId}`;
      return google.withMailbox(c.id,async mailbox=>{const setup=await request(path+'/setup',{},'GET');const capture=await google.readThreadContext(setup.mail,setup.incoming,mailbox);return request(path,{basisHash:setup.basisHash,expectedId:setup.expectedId,capture});});
    });
    ipcMain.handle('google-conversation',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId);
      if(typeof data?.id!=='string'||!/^[a-f0-9-]{36}$/.test(data.id))throw new Error('Ungültige Nachrichtenkennung.');
      const path=`/api/clients/${c.id}/mail-tests/${data.id}/conversation`;
      return google.withMailbox(c.id,async mailbox=>{
        const mail=await request(path,{},'GET');
        const result=await google.readConversation(mail,mailbox);
        return request(path,{...result,mailboxId:mailbox.id,clientVersion:c.version});
      });
    });
    ipcMain.handle('google-delivery-auto',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId),enabled=data?.enabled;if(typeof enabled!=='boolean')throw new Error('Status fehlt.');
      const mailbox=google.status(c.id).mailbox;
      if(enabled){if(!mailbox?.readAccess)throw new Error('Lesender Gmail-Zugriff fehlt.');const answer=await dialog.showMessageBox(win,{type:'question',title:'Automatische Rückläuferprüfung',message:'Postfachprüfung im Hintergrund aktivieren?',detail:'Liest Suchseiten seit der ältesten bestätigten Testsendung einschließlich Spam und Papierkorb. Referenzierte Antworten werden anhand ihrer Header zugeordnet; Absender, Betreff und Textauszug werden gespeichert und halten den Kontakt an. Nur gekennzeichnete Zustellberichte werden vollständig gelesen. Weitere Seiten folgen automatisch; nach der Erstprüfung folgt der Änderungsabgleich, anschließend etwa alle fünf Minuten. Bei abgelaufenem Google-Fortschritt beginnt die vollständige Prüfung erneut. Gilt während die Workbench läuft, auch im Infobereich, und bleibt nach Neustart aktiv. Kein E-Mail-Versand. Nach Änderungen am Kunden erneut aktivieren.',buttons:['Abbrechen','Automatisch prüfen'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};}
      await request(`/api/clients/${c.id}/delivery-progress/configure`,{enabled,mailboxId:mailbox?.id||'',clientVersion:c.version});if(enabled)void pollDelivery();return {cancelled:false,state:await request(`/api/clients/${c.id}/delivery-progress`,{},'GET')};
    });
    ipcMain.handle('google-delivery-progress',async(event,id)=>{trusted(event);await customer(id);return request(`/api/clients/${id}/delivery-progress`,{},'GET');});
    ipcMain.handle('google-delivery-page',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId);
      const answer=await dialog.showMessageBox(win,{type:'question',title:'Fortsetzbare Rückläuferprüfung',message:'Nächste Seite der erweiterten Postfachprüfung lesen?',detail:'Prüft eingegangene Nachrichten seit der ältesten bestätigten Testsendung, einschließlich Spam und Papierkorb, ohne Absenderfilter. Referenzierte Antworten werden samt Absender, Betreff und Textauszug gespeichert und halten den Kontakt an. Nur gekennzeichnete Zustellberichte werden vollständig gelesen. Erstprüfung: bis zu 25 Suchtreffer pro Seite; anschließend Änderungen über Googles Änderungsverlauf. Fortschritt bleibt auf diesem PC gespeichert. Neuer Lauf beginnt bei Bedarf wieder am Anfang.',buttons:['Abbrechen','Seite prüfen'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};
      return google.withMailbox(c.id,async mailbox=>{
        const base=`/api/clients/${c.id}/delivery-progress`,claim=await request(base+'/claim',{mailboxId:mailbox.id,clientVersion:c.version,restart:data?.restart===true});
        try{const result=await google.scanDeliveries(claim.mails,mailbox,claim);await request(base+'/finish',{...result,runId:claim.runId,leaseId:claim.leaseId,mailboxId:mailbox.id,clientVersion:c.version});return {cancelled:false,state:await request(base,{},'GET')};}
        catch(e){try{await request(base+'/fail',{runId:claim.runId,leaseId:claim.leaseId,error:e.message,historyExpired:e.historyExpired===true});}catch{}throw e;}
      });
    });
    ipcMain.handle('google-delivery-scan',async(event,id)=>{
      trusted(event);const c=await customer(id);
      const answer=await dialog.showMessageBox(win,{type:'question',title:'Separate Rückläufer prüfen',message:'Nach Zustellberichten außerhalb bekannter Gespräche suchen?',detail:'Prüft maximal 100 Suchtreffer der letzten 30 Tage von mailer-daemon oder postmaster. Spam und Papierkorb sind ausgeschlossen. Gekennzeichnete Zustellberichte werden vollständig gelesen, auch wenn sie sich anschließend nicht zuordnen lassen. Nur passende Berichte zu bestätigten Testsendungen dieses Kunden werden gespeichert. Ein unvollständiger Lauf wird angezeigt.',buttons:['Abbrechen','Rückläufer prüfen'],defaultId:0,cancelId:0});
      if(answer.response!==1)return {cancelled:true};
      return google.withMailbox(c.id,async mailbox=>{
        const base=`/api/clients/${c.id}`,mails=await request(base+'/delivery-mails?mailboxId='+mailbox.id,{},'GET');
        const result=await google.scanDeliveries(mails,mailbox);
        const summary=await request(base+'/delivery-scan',{...result,mailboxId:mailbox.id,clientVersion:c.version});
        return {cancelled:false,...summary};
      });
    });
    ipcMain.handle('google-sync-status',async(event,id)=>{trusted(event);await customer(id);return request(`/api/clients/${id}/mail-sync`,{},'GET');});
    ipcMain.handle('google-sync-config',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId),mailbox=google.status(c.id).mailbox;if(!mailbox?.readAccess)throw new Error('Bitte zuerst den lesenden Gmail-Zugriff einrichten.');
      const enabled=data?.enabled===true;if(enabled){const answer=await dialog.showMessageBox(win,{type:'question',title:'Automatische Gesprächssynchronisation',message:'Gespräche im Hintergrund regelmäßig prüfen?',detail:'Die Workbench prüft bei laufender App etwa alle fünf Minuten bekannte, bestätigte Testsendungen. Eingänge halten den jeweiligen Empfänger an. Es werden keine Nachrichten gesendet, verändert oder gelöscht.',buttons:['Abbrechen','Synchronisation aktivieren'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};}
      const state=await request(`/api/clients/${c.id}/mail-sync/configure`,{mailboxId:mailbox.id,clientVersion:c.version,enabled});if(enabled)void syncMail(c.id,true).catch(()=>{});return {cancelled:false,state};
    });
    ipcMain.handle('google-sync-now',async(event,id)=>{trusted(event);return syncMail(customerId(id),true);});
    ipcMain.handle('google-check',async(event,id)=>{trusted(event);await customer(id);return google.check(id);});
    ipcMain.handle('google-verify-read',async(event,id)=>{trusted(event);await customer(id);return google.verifyRead(id);});
    ipcMain.handle('google-revoke',async(event,id)=>{trusted(event);await customer(id);const a=await dialog.showMessageBox(win,{type:'question',title:'Google-Zugriff widerrufen',message:'Zugriff bei Google widerrufen und lokale Zugangsdaten entfernen?',detail:'Der Kunde wird pausiert. Gespeicherte Antworten und Kontaktstopps bleiben erhalten.',buttons:['Abbrechen','Widerrufen'],defaultId:0,cancelId:0});if(a.response!==1)return {cancelled:true};return google.disconnectProvider(id,'revoke');});
    ipcMain.handle('google-disconnect',async(event,id)=>{trusted(event);const c=await customer(id);const m=google.status(id).mailbox;if(!m)return {cancelled:false};const answer=await dialog.showMessageBox(win,{type:'question',title:'Postfach lokal trennen',message:`${m.email} lokal trennen?`,detail:'Gespeicherte Zugangsdaten dieses Postfachs werden entfernt. Die Google-Freigabe kannst du zusätzlich in deinem Google-Konto widerrufen. Testversand-Verlauf bleibt erhalten; automatische Synchronisation wird deaktiviert.',buttons:['Abbrechen','Lokal trennen'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};try{await request(`/api/clients/${id}/mail-sync/configure`,{mailboxId:m.id,clientVersion:c.version,enabled:false});}catch{}await request(`/api/clients/${id}/delivery-progress/configure`,{enabled:false,mailboxId:m.id,clientVersion:c.version});await google.disconnectProvider(id,'local');return {cancelled:false};});
    ipcMain.handle('google-help',(event,topic)=>{trusted(event);const pages={setup:'https://console.cloud.google.com/auth/clients',gmail:'https://console.cloud.google.com/apis/library/gmail.googleapis.com',permissions:'https://myaccount.google.com/connections'};if(!Object.hasOwn(pages,topic))throw new Error('Unbekannte Hilfeseite.');return shell.openExternal(pages[topic]);});
    ipcMain.handle('google-test',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId);if(data?.confirmed!==true)throw new Error('Bitte Testvorschau bestätigen.');if(c.status==='paused')throw new Error('Kunde ist pausiert.');
      return google.withMailbox(c.id,async mailbox=>{
        if(mailbox.id!==data.mailboxId)throw new Error('Postfach wurde geändert. Vorschau neu erstellen.');
        const mail={id:data.id,mailboxId:mailbox.id,clientVersion:data.clientVersion,sender:mailbox.email,recipient:data.recipient,subject:data.subject,body:data.body,messageId:`<${data.id}@workbench.local>`};
        const presentation=await request('/api/clients/'+c.id+'/mail-preview',mail);if(presentation){mail.presentation=presentation;mail.presentationHash=presentation.hash;}
        makeRawMail(mail);
        const answer=await dialog.showMessageBox(win,{type:'question',title:'Eine echte Test-E-Mail senden',message:`Von: ${mail.sender}\nAn: ${mail.recipient}\nKunde: ${c.name}`,detail:`Betreff: ${mail.subject}\n\n${mail.presentation?.text||mail.body}\n\nDies versendet genau eine echte Nachricht.`,buttons:['Abbrechen','Jetzt einmal senden'],defaultId:0,cancelId:0,noLink:true});
        if(answer.response!==1)return {cancelled:true};
        const base=`/api/clients/${c.id}`;const run=await request(base+'/mail-reserve',mail);
        let outcome;
        try{const prepared=await google.prepareTracking(run);await request(base+'/tracking/authorize',{mailId:run.id,clientVersion:c.version});prepared.check();outcome=await google.sendOnce(prepared.mail,mailbox.accessToken);}catch(e){try{await request(base+`/mail-tests/${run.id}/finish`,{status:e.kind==='unknown'?'unknown':'failed',providerId:'',result:e.message});}catch{throw new Error('Testversand konnte nicht abschließend protokolliert werden. Gmail und Verlauf prüfen; nicht erneut senden.');}throw e;}
        try{await request(base+`/mail-tests/${run.id}/finish`,{status:'sent',providerId:outcome.providerId,result:'Von Google angenommen. Zustellung nicht bestätigt.'});}catch{throw new Error('Google hat die Nachricht angenommen, aber die lokale Bestätigung fehlt. Nicht erneut senden; Verlauf und Gmail prüfen.');}
        return {cancelled:false,sent:true};
      });
    });
    ipcMain.handle('google-queue-live',async(event,data)=>{
      trusted(event);const c=await customer(data?.clientId);if(typeof data?.runId!=='string'||!/^[a-f0-9-]{36}$/.test(data.runId)||!Number.isSafeInteger(data?.revision))throw new Error('Ungültiger Kampagnenlauf.');
      const mailbox=google.status(c.id).mailbox;if(!mailbox?.readAccess)throw new Error('Bitte zuerst den lesenden Gmail-Zugriff einrichten.');await google.verifyRead(c.id);
      const runs=await request(`/api/clients/${c.id}/queue`,{},'GET'),run=runs.find(r=>r.id===data.runId);if(!run||run.revision!==data.revision)throw new Error('Lauf wurde geändert. Bitte neu laden.');
      const answer=await dialog.showMessageBox(win,{type:'warning',title:'Echten Kampagnenversand freigeben',message:`${run.snapshot.name} über ${mailbox.email} wirklich für echten Versand vorbereiten?`,detail:`${run.snapshot.content.leadIds.length} Kontakte · bis zu ${run.snapshot.content.dailyLimit} Nachrichten pro Kampagnentag. Nach der Freigabe bleibt der Lauf pausiert und muss noch einmal bewusst gestartet werden. Unklare Ergebnisse werden nicht wiederholt.`,buttons:['Abbrechen','ECHTEN VERSAND AKTIVIEREN'],defaultId:0,cancelId:0,noLink:true});if(answer.response!==1)return {cancelled:true};
      return google.withMailbox(c.id,async current=>{if(current.id!==mailbox.id||current.email!==mailbox.email)throw new Error('Postfach wurde während der Freigabe geändert. Erneut prüfen.');const result=await request(`/api/clients/${c.id}/queue/${run.id}/activate-live`,{revision:run.revision,mailboxId:current.id,sender:current.email,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN'});return {cancelled:false,result};});
    });
    ipcMain.handle('background', (event, value) => { trusted(event); if (typeof value !== 'boolean') throw new Error('Ungültig'); writeFileSync(preferences, JSON.stringify({ background: value }), { flush: true }); background = value; return background; });
    ipcMain.handle('open-data', async event => { trusted(event); const error = await shell.openPath(dataDir); if (error) throw new Error(error); return true; });
    ipcMain.handle('export-backup', async (event,passphrase) => {
      trusted(event);
      const { filePath, canceled } = await dialog.showSaveDialog(win, { title: 'Sicherung zusätzlich exportieren', defaultPath: `EiZ-Sicherung-${new Date().toISOString().slice(0,10)}.eizbackup`, filters: [{ name: 'Verschlüsselte Workbench-Sicherung', extensions: ['eizbackup'] }] });
      if (canceled || !filePath) return { cancelled: true };
      const result = await request('/api/backup'); writeFileSync(filePath, await encryptPortableBackup(Buffer.from(JSON.stringify(result.backup)),passphrase), { flush: true }); return { cancelled: false };
    });
    ipcMain.handle('check-backup', async (event,passphrase) => {
      trusted(event);
      const pick = await dialog.showOpenDialog(win, {title:'Sicherung unverbindlich prüfen',properties:['openFile'],filters:[{name:'Workbench-Sicherung',extensions:['json','eizbackup']}]});
      if(pick.canceled) return {cancelled:true};
      const result=await request('/api/backup-file/check',{path:pick.filePaths[0],passphrase});
      return {cancelled:false,report:result.report};
    });
    ipcMain.handle('restore-backup', async (event,passphrase) => {
      trusted(event);
      const { filePaths, canceled } = await dialog.showOpenDialog(win, { title: 'Workbench-Sicherung auswählen', properties: ['openFile'], filters: [{ name: 'Workbench-Sicherung', extensions: ['json','eizbackup'] }] });
      if (canceled) return { cancelled: true };
      const checked=await request('/api/backup-file/check',{path:filePaths[0],passphrase});
      const answer = await dialog.showMessageBox(win, { type: 'warning', title: 'Daten wiederherstellen', message: 'Aktuelle Kundendaten durch diese Sicherung ersetzen?', detail: 'Diese Datei wurde erfolgreich in einer getrennten Testdatenbank wiederhergestellt. Vorher wird automatisch eine Sicherung des aktuellen Standes erstellt. Alle wiederhergestellten Kunden werden pausiert und offene Aufträge angehalten.', buttons: ['Abbrechen', 'Wiederherstellen'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return { cancelled: true };
      if(google.status('').busy)throw new Error('Bitte zuerst den Postfachvorgang abschließen.');
      await request('/api/backup-file/restore',{path:filePaths[0],fileDigest:checked.fileDigest,passphrase}); google.disconnectAll(); return { cancelled: false };
    });
    win = new BrowserWindow({ width: 1380, height: 920, minWidth: 1050, minHeight: 700, backgroundColor: '#f5f6f2', title: 'EiZ Workbench', show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== entry) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.on('close', event => { if (!quitting && background && tray) { event.preventDefault(); win.hide(); } else app.quit(); });
    // A small RGBA tray mark; it has no network or asset dependency.
    const pixels = Buffer.alloc(32 * 32 * 4);
    for (let y=0; y<32; y++) for (let x=0; x<32; x++) { const p=(y*32+x)*4; const e=x>=9&&x<=12&&y>=7&&y<=24 || x>=9&&x<=23&&(y>=7&&y<=10||y>=14&&y<=17||y>=21&&y<=24); pixels[p]=e?233:29; pixels[p+1]=e?242:69; pixels[p+2]=e?207:55; pixels[p+3]=255; }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }));
    tray.setToolTip('EiZ Workbench · lokal');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Workbench öffnen', click: () => win.show() }, { label: 'Workbench vollständig beenden', click: () => app.quit() }]));
    tray.on('double-click', () => win.show());
    await win.loadURL(entry);
    if (!process.env.EIZ_SMOKE_DIR) win.show();
    if (process.env.EIZ_SMOKE_DIR) { const { runSmoke } = require('../tests/desktop.cjs'); await runSmoke(win, connection, token, dataDir); app.quit(); }
  }).catch(error => { if (process.env.EIZ_SMOKE_DIR) { console.error(error); app.exit(1); } else { dialog.showErrorBox('Workbench konnte nicht starten', error.message); app.quit(); } });
}
app.on('before-quit', () => { quitting = true;clearInterval(syncTimer); google?.cancel(); worker?.postMessage('stop'); });
app.on('will-quit', () => { tray?.destroy(); worker?.kill(); });
app.on('window-all-closed', () => { if (!background || quitting) app.quit(); });

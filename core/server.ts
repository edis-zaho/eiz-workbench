import {saveContactPermission,contactPermissionProblems} from './contact-permission';
import {previewContactDeletion,applyContactDeletion} from './data-retention';
import {saveCapability} from './model-capabilities';
import {reserveCapabilityRun} from './model-jobs';
import {modelProfiles,saveModelProfile} from './model-profiles';
import {setModelRoute} from './model-routing';
import {publicRecords} from './public-schema';
import {setModelBudget,modelSpending,reconcileModelBudget} from './model-budget';
import {configureModelPrice,modelSetup,authorizeModelDispatch,finishModelDispatch} from './model-jobs';
import {senderState,saveSenderProfile,mailPresentation} from './mail-presentation';
import {withGmailReference} from './gmail-reference';
import {trackingState,configureTracking,prepareTracking,registeredTracking,authorizeTrackedTest,bindPreparedTracking} from './tracking';
import {relayState,bindRelay,configureRelay,relayContext,acceptRelayPage,failRelay,dueRelay} from './relay-sync';
import {meetingOverview,meetingBasis,saveMeeting} from './meetings';
import {signalOverview,signalBasis,previewSignals,importSignals,withdrawSignal} from './signals';
import {analysisState,analysisBasis,saveAnalysisPolicy,dueAnalysis,authorizeAnalysis,expireAnalysis,exportAnalysisAuto} from './analysis-auto';
import {readBackupFile} from './backup-file';
import {clarificationBoard,exportClarifications} from './clarifications';
import {approvalState,saveApprovalPolicy,exportApproval} from './reply-approval';
import {preparationState,preparationBasis,savePreparationPolicy,duePreparation,claimPreparation,preparationClaim,preparationModelSetup,authorizePreparationProvider,finishPreparation,expirePreparation,exportPreparation} from './reply-preparation';
import {autoState,saveAutoPolicy,dueAuto,claimAuto,finishAuto,expireAuto,exportAuto} from './dialogue-auto';
import {dialoguePreview,dialogueHistory,reserveDialogue,authorizeDialogue,finishDialogue,expireDialogues,dialogueRecord} from './dialogue-send';
import {replyWritingOptions,replyWritingSetup,reserveReplyWriting,finishReplyWriting,replyWritingState,saveReplyDraft,exportReplyWriting} from './reply-writing';
import {threadContextSetup,threadContextState,saveThreadContext,exportThreadHistory} from './thread-context';
import {experimentResults} from './experiment-results';
import {previewExperiment,saveExperiment,closeExperiment,experimentState,exportProductExperiments} from './experiments';
import {queueState,prepareQueue,controlQueue,stopQueues,tickQueues,activateLiveQueue,dueOutbound,claimOutbound,authorizeOutbound,finishOutbound} from './outbox';
import {unassigned,decideUnassigned} from './unassigned';
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Store, AppError } from './store';
import { fetchWebsite } from './website';
import { rehearseRestore } from './recovery';
import {incomingState,recordConversation,markUnsubscribe,deliveryMails,recordDeliveryScan} from './inbox';
import {syncState,configureSync,dueSyncs,claimSync,finishSync} from './sync';
import {companyBlocks,blockCompany,reviewQueue,reviewIncoming} from './operations';
import {configureDeliveryAuto,dueDeliveryAuto,failDeliveryAutoStart} from './delivery-auto';
import {deliveryProgress,claimDeliveryPage,finishDeliveryPage,failDeliveryPage} from './delivery-progress';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { assessStorage } from './storage';
import { exportClientEvidence } from './evidence-source';
import {strategyState,saveStrategy,exportProductStrategy} from './strategy';
import {knowledgeState,saveKnowledge,exportProductKnowledge} from './knowledge';
import {previewProductSource} from './source-import';
import {conversationState,conversationPreview,saveConversationRules,saveConversationCase,applyConversationRules,tickConversations,exportConversations} from './conversations';
import {replyInbox,replySetup,reserveReply,finishReply} from './reply-analysis';
import {writingSetup,writingRuns,reserveWriting,finishWriting,adoptWriting} from './campaign-writing';
import {knowledgeRuns,reserveKnowledgeRun,finishKnowledgeRun,adoptKnowledgeSuggestion} from './knowledge-runs';
import { catalogState, changeCatalog, productHistory } from './catalog';
import {evidenceJournal} from './evidence-journal';
import {exportClientJournal} from './journal-source';
import {interpretationHistory,saveHumanInterpretation,exportClientInterpretations} from './interpretations';

async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 50 * 1024 * 1024) throw new AppError('Datei zu groß (maximal 50 MB).', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new AppError('Ungültige Daten.'); }
}
export async function startServer(store: Store, token: string, interval = 1000, workerToken = '') {
  if (token.length < 32) throw new Error('Strong local access token required');
  const runtime = { heartbeat: new Date().toISOString(), startedAt: new Date().toISOString(), lastError: '', ready: true };
  let lastQueueTick=0,lastConversationTick=Date.now();let conversationError='';
  const tick = () => {
    try {
      store.runDueJobs();expireAnalysis(store);expireDialogues(store);expireAuto(store);expirePreparation(store);if(Date.now()-lastQueueTick>=5000){tickQueues(store);lastQueueTick=Date.now();}
      if(Date.now()-lastConversationTick>=30000){lastConversationTick=Date.now();const c=tickConversations(store);conversationError=c.failedClients.length?`Gesprächsregeln bei ${c.failedClients.length} Kunden angehalten. Fälle und Verlauf prüfen.`:'';}
      const latest = store.snapshot().latestBackup;
      if (!latest || Date.now() - Date.parse(latest) > 86400000) store.saveBackup('daily');
      runtime.heartbeat = new Date().toISOString(); runtime.lastError = conversationError;
    } catch { runtime.lastError = 'Hintergrundverarbeitung gestört. Bitte Speicherplatz und Datenordner prüfen.'; }
  };
  const timer = setInterval(tick, interval); tick();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') { res.writeHead(403); res.end(JSON.stringify({ error: 'Zugriff verweigert.' })); return; }
    if (origin === 'null') { res.setHeader('Access-Control-Allow-Origin', 'null'); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS'); res.writeHead(204); res.end(); return; }
    const actual = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401); res.end(JSON.stringify({ error: 'Zugriff verweigert.' })); return; }
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const nativeOnly=(req.method==='POST'&&parts[1]==='models')||(req.method==='POST'&&['relay-sync','tracking'].includes(parts[3]))||(parts[0]==='api'&&parts[1]==='backup-file')||(req.method==='POST'&&parts[3]==='analysis-auto')||(req.method==='POST'&&parts[3]==='reply-approval')||(req.method==='POST'&&parts[3]==='reply-preparation'&&parts.at(-1)!=='basis')||(req.method==='POST'&&parts[3]==='dialogue-auto')||req.method==='POST'&&parts[0]==='api'&&parts[1]==='clients'&&(
        ['privacy','model-dispatch','ai-reserve','model-route','sender-profile','mail-reserve','delivery-progress','delivery-scan','mail-sync'].includes(parts[3])||
        parts[3]==='ai'&&parts.at(-1)==='finish'||
        parts[3]==='mail-tests'&&parts[5]==='conversation'||
        parts[3]==='products'&&parts[5]==='knowledge-runs'&&['reserve','finish'].includes(parts.at(-1)||'')||
        parts[3]==='reply-writing'&&['reserve','finish'].includes(parts.at(-1)||'')||
        parts[3]==='thread-context'||
        parts[3]==='dialogue'&&parts.at(-1)==='reserve'||parts[3]==='dialogue-send'||
        parts[3]==='reply-analysis'&&['reserve','finish'].includes(parts.at(-1)||'')||
        parts[3]==='campaigns'&&parts[5]==='writing-runs'&&['reserve','finish'].includes(parts.at(-1)||'')||
        parts[3]==='queue'&&['activate-live','claim-send','authorize-send','finish-send'].includes(parts.at(-1)||'')||
        parts[3]==='mail-tests'&&parts[5]==='reconcile'&&(!!store.db.prepare('SELECT id FROM queue_items WHERE id=?').get(parts[4])||!!dialogueRecord(store,parts[2],parts[4])));
      if(nativeOnly){const proof=Buffer.from(String(req.headers['x-eiz-worker']||'')),expectedProof=Buffer.from(workerToken);if(workerToken.length<32||proof.length!==expectedProof.length||!timingSafeEqual(proof,expectedProof))throw new AppError('Diese Versandaktion erfordert den Desktop-Dienst.',403);}
      let result: unknown;
      if (req.method === 'GET' && url.pathname === '/api/state') result = { ...store.snapshot(url.searchParams.get('clientId') || undefined), runtime };
      else if(parts[1]==='models'&&req.method==='GET')result={profiles:modelProfiles(store),clients:store.snapshot().clients,routes:publicRecords(store,'routes'),records:publicRecords(store).filter(r=>['price','budget','capability','model-run'].includes(r.kind)),spending:{USD:modelSpending(store,'USD'),EUR:modelSpending(store,'EUR')}};
      else if(parts[1]==='models'&&req.method==='POST'){const d=await body(req);if(parts[2]==='profile')result=saveModelProfile(store,d);else if(parts[2]==='price')result=configureModelPrice(store,d.id,d.input);else if(parts[2]==='budget')result=setModelBudget(store,d);else if(parts[2]==='reconcile')result=reconcileModelBudget(store,d);else if(parts[2]==='test-reserve')result=reserveCapabilityRun(store,d.clientId,d.expectedBindingHash);else if(parts[2]==='test-result'){const dispatch=publicRecords(store,'dispatch').find(r=>r.id===d.runId);if(!dispatch?.content.capabilityTest||dispatch.content.state!=='finished')throw new AppError('Testauftrag nicht abgeschlossen.');result=saveCapability(store,dispatch.content.binding,d.results);}else throw new AppError('Unbekannte Modelleinstellung.');}
      else if(parts[0]==='api'&&parts[1]==='clients'&&parts[3]==='model-setup'&&req.method==='GET')result=modelSetup(store,parts[2],parts[4] as any);
      else if(parts[0]==='api'&&parts[1]==='clients'&&parts[3]==='model-route'&&req.method==='POST'){const d=await body(req);result=setModelRoute(store,parts[2],d.task,d.ref);}
      else if(parts[0]==='api'&&parts[1]==='clients'&&parts[3]==='model-dispatch'&&req.method==='POST'){const d=await body(req);if(parts[5]==='authorize')result=authorizeModelDispatch(store,parts[2],parts[4],d.expectedBindingHash);else if(parts[5]==='finish')result=finishModelDispatch(store,parts[2],parts[4],d);else throw new AppError('Unbekannter Modellschritt.');}
      else if(req.method==='GET'&&url.pathname==='/api/relay-due')result=dueRelay(store);
      else if (req.method === 'POST' && url.pathname === '/api/queue-stop') result = stopQueues(store);
      else if (req.method === 'GET' && url.pathname === '/api/review-queue') result = reviewQueue(store);
      else if (req.method === 'GET' && url.pathname === '/api/delivery-due') result = dueDeliveryAuto(store);
      else if(req.method==='GET'&&url.pathname==='/api/analysis-auto-due')result=dueAnalysis(store);
      else if(req.method==='GET'&&['/api/clarifications','/api/clarifications/export'].includes(url.pathname)){const filter={clientId:url.searchParams.get('clientId')||undefined,state:url.searchParams.get('state')||undefined};result=url.pathname.endsWith('/export')?exportClarifications(store,filter):clarificationBoard(store,{...filter,offset:Number(url.searchParams.get('offset')||0)});}
      else if(req.method==='GET'&&url.pathname==='/api/reply-preparation-due')result=duePreparation(store);
      else if(req.method==='GET'&&url.pathname==='/api/dialogue-auto-due')result=dueAuto(store);
      else if (req.method === 'GET' && url.pathname === '/api/outbound-due') result = dueOutbound(store);
      else if (req.method === 'GET' && url.pathname === '/api/sync-due') result = dueSyncs(store);
      else if (req.method === 'POST' && url.pathname === '/api/clients') result = store.createClient(await body(req));
      else if (req.method === 'POST' && url.pathname === '/api/backup') result = store.saveBackup();
      else if(req.method==='POST'&&['/api/backup-file/check','/api/backup-file/restore'].includes(url.pathname)){
        const restore=url.pathname.endsWith('/restore'),file=await readBackupFile(await body(req),restore,(bytes,passphrase)=>store.decodeBackup(bytes,passphrase));
        if(restore)result=store.restore(file.backup);
        else result={report:rehearseRestore(file.backup),fileDigest:file.fileDigest,bytes:file.bytes};
      }
      else if (req.method === 'GET' && url.pathname === '/api/storage-check') {
        let freeBytes:number|null=null;
        try{const space=statfsSync(dirname(store.filename));freeBytes=space.bavail*space.bsize;}catch{}
        result=assessStorage(Buffer.byteLength(JSON.stringify(store.exportBackup()),'utf8'),freeBytes);
      }
      else if (req.method === 'POST' && url.pathname === '/api/backup-check') {
        try { result = rehearseRestore(await body(req)); }
        catch (e) { if (e instanceof AppError) throw e; throw new AppError('Sicherung konnte nicht probeweise wiederhergestellt werden. Der aktive Datenbestand wurde nicht verändert.'); }
      }
      else if (req.method === 'POST' && url.pathname === '/api/restore') {
        const data = await body(req);
        try { result = store.restore(data); } catch (e) { if (e instanceof AppError) throw e; throw new AppError('Sicherung enthält widersprüchliche Daten. Bestehende Daten bleiben erhalten.'); }
      }
      else if (parts[0] === 'api' && parts[1] === 'clients' && parts[2]) {
        if(req.method==='GET'&&parts.length===4&&parts[3]==='tracking')result=trackingState(store,parts[2]);
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='tracking'){const actions:Record<string,Function>={configure:configureTracking,prepare:prepareTracking,registered:registeredTracking,authorize:authorizeTrackedTest};if(!actions[parts[4]])throw new AppError('Unbekannte Trackingaktion.');result=actions[parts[4]](store,parts[2],await body(req));}
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='relay-sync')result=relayState(store,parts[2]);
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='relay-sync'){
          const actions:Record<string,Function>={bind:bindRelay,configure:configureRelay,context:(s:Store,c:string,b:any)=>{bindPreparedTracking(s,c);return relayContext(s,c,b);},accept:acceptRelayPage,fail:failRelay};
          if(!Object.hasOwn(actions,parts[4]))throw new AppError('Unbekannte Trackingaktion.',404);
          result=actions[parts[4]](store,parts[2],await body(req));
        }
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='signals')result=signalOverview(store,parts[2]);
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='signals'&&parts[5]==='withdraw')result=withdrawSignal(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='evidence-journal'&&parts[5]==='signals'&&req.method==='GET')result=signalBasis(store,parts[2],parts[4]);
        else if(parts.length===7&&parts[3]==='evidence-journal'&&parts[5]==='signals'&&parts[6]==='preview'&&req.method==='POST')result=previewSignals(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='evidence-journal'&&parts[5]==='signals'&&req.method==='POST')result=importSignals(store,parts[2],parts[4],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='meetings')result=meetingOverview(store,parts[2]);
        else if(parts.length===6&&parts[3]==='evidence-journal'&&parts[5]==='meetings'&&req.method==='GET')result=meetingBasis(store,parts[2],parts[4]);
        else if(parts.length===6&&parts[3]==='evidence-journal'&&parts[5]==='meetings'&&req.method==='POST')result=saveMeeting(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='privacy'&&req.method==='POST'){const d=await body(req);if(parts[4]==='preview')result=previewContactDeletion(store,parts[2],d.leadId,d.scope);else if(parts[4]==='delete')result=applyContactDeletion(store,d.hash);else throw new AppError('Unbekannte Löschaktion.');}
        else if(parts.length===4&&parts[3]==='sender-profile'&&req.method==='GET')result=senderState(store,parts[2])||null;
        else if(parts.length===4&&parts[3]==='sender-profile'&&req.method==='POST'){const d=await body(req);if(d.profile?.clientId!==parts[2])throw new AppError('Falscher Kunde.');result=saveSenderProfile(store,d.profile,d.identity);}
        else if(parts.length===4&&parts[3]==='mail-preview'&&req.method==='POST'){const d=await body(req);result=mailPresentation(store,parts[2],{to:d.recipient,subject:d.subject,bodyText:d.body},d.mailboxId,d.sender);}
        else if (req.method === 'PUT' && parts.length === 3) { const data = await body(req); result = store.updateClient(parts[2], data, data.version); }
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='experiments'&&req.method==='GET')result=experimentState(store,parts[2],parts[4]);
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='experiment-preview'&&req.method==='POST')result=previewExperiment(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='experiments'&&req.method==='POST')result=saveExperiment(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='experiments-export'&&req.method==='GET')result=exportProductExperiments(store,parts[2],parts[4]);
        else if(parts.length===8&&parts[3]==='products'&&parts[5]==='experiments'&&parts[7]==='results'&&req.method==='GET')result=experimentResults(store,parts[2],parts[4],parts[6],url.searchParams.has('signalDays')?Number(url.searchParams.get('signalDays')):7);
        else if(parts.length===8&&parts[3]==='products'&&parts[5]==='experiments'&&parts[7]==='close'&&req.method==='POST')result=closeExperiment(store,parts[2],parts[4],parts[6],await body(req));
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='strategy'&&req.method==='GET')result=strategyState(store,parts[2],parts[4]);
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='strategy'&&req.method==='POST')result=saveStrategy(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='strategy-export'&&req.method==='GET')result=exportProductStrategy(store,parts[2],parts[4]);
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='knowledge'&&req.method==='GET')result=knowledgeState(store,parts[2],parts[4]);
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='source-preview'&&req.method==='POST')result=await previewProductSource(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='knowledge'&&req.method==='POST')result=saveKnowledge(store,parts[2],parts[4],await body(req));
        else if(parts.length===6&&parts[3]==='products'&&parts[5]==='knowledge-export'&&req.method==='GET')result={...exportProductKnowledge(store,parts[2],parts[4]),version:2,extractionRuns:knowledgeRuns(store,parts[2],parts[4])};
        else if(parts[3]==='products'&&parts[5]==='knowledge-runs'&&parts.length===6&&req.method==='GET')result=knowledgeRuns(store,parts[2],parts[4]);
        else if(parts[3]==='products'&&parts[5]==='knowledge-runs'&&parts.length===7&&parts[6]==='reserve'&&req.method==='POST')result=reserveKnowledgeRun(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='products'&&parts[5]==='knowledge-runs'&&parts.length===8&&parts[7]==='finish'&&req.method==='POST')result=finishKnowledgeRun(store,parts[2],parts[4],parts[6],await body(req));
        else if(parts[3]==='products'&&parts[5]==='knowledge-runs'&&parts.length===8&&parts[7]==='adopt'&&req.method==='POST')result=adoptKnowledgeSuggestion(store,parts[2],parts[4],parts[6],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='catalog')result=catalogState(store,parts[2]);
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='catalog')result=changeCatalog(store,parts[2],await body(req));
        else if(req.method==='GET'&&parts.length===6&&parts[3]==='products'&&parts[5]==='history')result=productHistory(store,parts[2],parts[4]);
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='evidence-export')result=exportClientEvidence(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='journal-export')result=exportClientJournal(store,parts[2],await body(req));
        else if(req.method==='GET'&&parts.length===6&&parts[3]==='evidence-journal'&&parts[5]==='interpretations')result=interpretationHistory(store,parts[2],parts[4]);
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='evidence-journal'&&parts[5]==='interpretations')result=saveHumanInterpretation(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='analysis-auto'&&parts.length===4&&req.method==='GET')result=analysisState(store,parts[2]);
        else if(parts[3]==='analysis-auto'&&parts.length===5&&parts[4]==='basis'&&req.method==='GET')result=analysisBasis(store,parts[2]);
        else if(parts[3]==='analysis-auto'&&parts.length===5&&parts[4]==='export'&&req.method==='GET')result=exportAnalysisAuto(store,parts[2]);
        else if(parts[3]==='analysis-auto'&&parts.length===5&&parts[4]==='policy'&&req.method==='POST')result=saveAnalysisPolicy(store,parts[2],await body(req));
        else if(parts[3]==='analysis-auto'&&parts.length===6&&parts[5]==='authorize'&&req.method==='POST')result=authorizeAnalysis(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='reply-approval'&&parts.length===4&&req.method==='GET')result=approvalState(store,parts[2]);
        else if(parts[3]==='reply-approval'&&parts.length===5&&parts[4]==='policy'&&req.method==='POST')result=saveApprovalPolicy(store,parts[2],await body(req));
        else if(parts[3]==='reply-approval'&&parts.length===5&&parts[4]==='export'&&req.method==='GET')result=exportApproval(store,parts[2]);
        else if(parts[3]==='reply-preparation'&&parts.length===4&&req.method==='GET')result=preparationState(store,parts[2]);
        else if(parts[3]==='reply-preparation'&&parts.length===5&&parts[4]==='export'&&req.method==='GET')result=exportPreparation(store,parts[2]);
        else if(parts[3]==='reply-preparation'&&parts.length===5&&parts[4]==='basis'&&req.method==='POST'){const d=await body(req);result=preparationBasis(store,parts[2],d.productId,d.factIds);}
        else if(parts[3]==='reply-preparation'&&parts.length===5&&parts[4]==='policy'&&req.method==='POST')result=savePreparationPolicy(store,parts[2],await body(req));
        else if(parts[3]==='reply-preparation'&&parts.length===5&&parts[4]==='claim'&&req.method==='POST')result=claimPreparation(store,parts[2],await body(req));
        else if(parts[3]==='reply-preparation'&&parts.length===6&&parts[5]==='source'&&req.method==='GET')result=preparationClaim(store,parts[2],parts[4]);
        else if(parts[3]==='reply-preparation'&&parts.length===6&&parts[5]==='context'&&req.method==='GET')result=preparationModelSetup(store,parts[2],parts[4]);
        else if(parts[3]==='reply-preparation'&&parts.length===6&&parts[5]==='authorize'&&req.method==='POST')result=authorizePreparationProvider(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='reply-preparation'&&parts.length===6&&parts[5]==='finish'&&req.method==='POST')result=finishPreparation(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='dialogue-auto'&&parts.length===4&&req.method==='GET')result=autoState(store,parts[2]);
        else if(parts[3]==='dialogue-auto'&&parts.length===5&&parts[4]==='export'&&req.method==='GET')result=exportAuto(store,parts[2]);
        else if(parts[3]==='dialogue-auto'&&parts.length===5&&parts[4]==='policy'&&req.method==='POST')result=saveAutoPolicy(store,parts[2],await body(req));
        else if(parts[3]==='dialogue-auto'&&parts.length===5&&parts[4]==='claim'&&req.method==='POST')result=claimAuto(store,parts[2],await body(req));
        else if(parts[3]==='dialogue-auto'&&parts.length===6&&parts[5]==='finish'&&req.method==='POST')result=finishAuto(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='dialogue'&&parts.length===5&&req.method==='GET')result=dialogueHistory(store,parts[2],parts[4]);
        else if(parts[3]==='dialogue'&&parts.length===6&&parts[5]==='preview'&&req.method==='POST'){const d=await body(req);result=dialoguePreview(store,parts[2],parts[4],d.draftId);}
        else if(parts[3]==='dialogue'&&parts.length===6&&parts[5]==='reserve'&&req.method==='POST')result=reserveDialogue(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='dialogue-send'&&parts.length===6&&parts[5]==='authorize'&&req.method==='POST')result=authorizeDialogue(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='dialogue-send'&&parts.length===6&&parts[5]==='finish'&&req.method==='POST')result=finishDialogue(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='reply-writing'&&parts.length===5&&req.method==='GET')result=replyWritingState(store,parts[2],parts[4]);
        else if(parts[3]==='reply-writing'&&parts.length===6&&parts[5]==='options'&&req.method==='GET')result=replyWritingOptions(store,parts[2],parts[4]);
        else if(parts[3]==='reply-writing'&&parts.length===6&&parts[5]==='export'&&req.method==='GET')result=exportReplyWriting(store,parts[2],parts[4]);
        else if(parts[3]==='reply-writing'&&parts.length===6&&parts[5]==='context'&&req.method==='POST'){const d=await body(req);result=replyWritingSetup(store,parts[2],parts[4],d.productId,d.factIds);}
        else if(parts[3]==='reply-writing'&&parts.length===6&&parts[5]==='reserve'&&req.method==='POST')result=reserveReplyWriting(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='reply-writing'&&parts.length===7&&parts[6]==='finish'&&req.method==='POST')result=finishReplyWriting(store,parts[2],parts[4],parts[5],await body(req));
        else if(parts[3]==='reply-writing'&&parts.length===7&&parts[6]==='draft'&&req.method==='POST')result=saveReplyDraft(store,parts[2],parts[4],parts[5],await body(req));
        else if(parts[3]==='thread-context'&&parts.length===5&&req.method==='GET')result=threadContextState(store,parts[2],parts[4]);
        else if(parts[3]==='thread-context'&&parts.length===6&&parts[5]==='setup'&&req.method==='GET')result=threadContextSetup(store,parts[2],parts[4]);
        else if(parts[3]==='thread-context'&&parts.length===6&&parts[5]==='export'&&req.method==='GET')result=exportThreadHistory(store,parts[2],parts[4]);
        else if(parts[3]==='thread-context'&&parts.length===5&&req.method==='POST')result=saveThreadContext(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='conversation-state'&&parts.length===4&&req.method==='GET')result=conversationState(store,parts[2],Number(url.searchParams.get('offset')||0));
        else if(parts[3]==='conversation-preview'&&parts.length===4&&req.method==='POST'){const d=await body(req);result=conversationPreview(store,parts[2],d.recipient);}
        else if(parts[3]==='conversation-rules'&&parts.length===4&&req.method==='POST')result=saveConversationRules(store,parts[2],await body(req));
        else if(parts[3]==='conversation-case'&&parts.length===4&&req.method==='POST')result=saveConversationCase(store,parts[2],await body(req));
        else if(parts[3]==='conversation-process'&&parts.length===4&&req.method==='POST')result=applyConversationRules(store,parts[2]);
        else if(parts[3]==='conversation-export'&&parts.length===4&&req.method==='GET')result=exportConversations(store,parts[2]);
        else if(parts[3]==='reply-analysis'&&parts.length===4&&req.method==='GET')result=replyInbox(store,parts[2],url.searchParams.get('before')??undefined);
        else if(parts[3]==='reply-analysis'&&parts.length===6&&parts[5]==='context'&&req.method==='GET')result=replySetup(store,parts[2],parts[4]);
        else if(parts[3]==='reply-analysis'&&parts.length===6&&parts[5]==='reserve'&&req.method==='POST')result=reserveReply(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='reply-analysis'&&parts.length===6&&parts[5]==='finish'&&req.method==='POST')result=finishReply(store,parts[2],parts[4],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='interpretation-export')result=exportClientInterpretations(store,parts[2]);
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='evidence-journal')result=evidenceJournal(store,parts[2],{before:url.searchParams.get('before')??undefined,through:url.searchParams.get('through')??undefined});
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='queue')result=queueState(store,parts[2]);
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='campaigns'&&parts[5]==='prepare-queue')result=prepareQueue(store,parts[2],parts[4],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='queue'&&parts[5]==='control')result=controlQueue(store,parts[2],parts[4],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='queue'&&parts[5]==='activate-live')result=activateLiveQueue(store,parts[2],parts[4],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='queue'&&parts[5]==='claim-send')result=claimOutbound(store,parts[2],parts[4],await body(req));
        else if(req.method==='POST'&&parts.length===8&&parts[3]==='queue'&&parts[5]==='items'&&parts[7]==='authorize-send')result=authorizeOutbound(store,parts[2],parts[4],parts[6],await body(req));
        else if(req.method==='POST'&&parts.length===8&&parts[3]==='queue'&&parts[5]==='items'&&parts[7]==='finish-send')result=finishOutbound(store,parts[2],parts[4],parts[6],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='campaign-leads')result=store.campaignLeads(parts[2]);
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='campaigns')result=store.campaigns(parts[2]);
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='campaigns')result=store.saveCampaign(parts[2],await body(req));
        else if(parts[3]==='campaigns'&&parts[5]==='writing-context'&&parts.length===6&&req.method==='GET')result=writingSetup(store,parts[2],parts[4]);
        else if(parts[3]==='campaigns'&&parts[5]==='writing-runs'&&parts.length===6&&req.method==='GET')result=writingRuns(store,parts[2],parts[4]);
        else if(parts[3]==='campaigns'&&parts[5]==='writing-runs'&&parts.length===7&&parts[6]==='reserve'&&req.method==='POST')result=reserveWriting(store,parts[2],parts[4],await body(req));
        else if(parts[3]==='campaigns'&&parts[5]==='writing-runs'&&parts.length===8&&parts[7]==='finish'&&req.method==='POST')result=finishWriting(store,parts[2],parts[4],parts[6],await body(req));
        else if(parts[3]==='campaigns'&&parts[5]==='writing-runs'&&parts.length===8&&parts[7]==='adopt'&&req.method==='POST')result=adoptWriting(store,parts[2],parts[4],parts[6],await body(req));
        else if(req.method==='GET'&&parts.length===6&&parts[3]==='campaigns'&&parts[5]==='history')result=store.campaignHistory(parts[2],parts[4]);
        else if(req.method==='GET'&&parts.length===6&&parts[3]==='campaigns'&&parts[5]==='preview')result=store.campaignPreview(parts[2],parts[4]);
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='campaigns'&&parts[5]==='approve')result=store.approveCampaign(parts[2],parts[4],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='mail-tests')result=store.mailTests(parts[2]);
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='company-blocks')result=companyBlocks(store,parts[2]);
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='company-blocks')result=blockCompany(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='incoming'&&parts[5]==='review')result=reviewIncoming(store,parts[2],parts[4],await body(req));
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='delivery-progress'&&parts[4]==='start-failed')result=failDeliveryAutoStart(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='delivery-progress'&&parts[4]==='configure')result=configureDeliveryAuto(store,parts[2],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='delivery-progress')result=deliveryProgress(store,parts[2]);
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='delivery-progress'&&parts[4]==='claim')result=claimDeliveryPage(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='delivery-progress'&&parts[4]==='finish')result=finishDeliveryPage(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='delivery-progress'&&parts[4]==='fail')result=failDeliveryPage(store,parts[2],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='delivery-mails')result=deliveryMails(store,parts[2],url.searchParams.get('mailboxId')||'');
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='delivery-scan')result=recordDeliveryScan(store,parts[2],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='unassigned')result=unassigned(store,parts[2]);
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='unassigned'&&parts[5]==='decide')result=decideUnassigned(store,parts[2],parts[4],await body(req));
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='incoming')result=incomingState(store,parts[2]);
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='mail-sync')result=syncState(store,parts[2]);
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='mail-sync'&&parts[4]==='configure')result=configureSync(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='mail-sync'&&parts[4]==='claim')result=claimSync(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===5&&parts[3]==='mail-sync'&&parts[4]==='finish')result=finishSync(store,parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='incoming'&&parts[5]==='unsubscribe')result=markUnsubscribe(store,parts[2],parts[4]);
        else if(req.method==='GET'&&parts.length===6&&parts[3]==='mail-tests'&&parts[5]==='conversation'){
          store.client(parts[2]);result=store.db.prepare("SELECT * FROM mail_tests WHERE clientId=? AND id=? AND status='sent'").get(parts[2],parts[4]);if(!result)throw new AppError('Bestätigte Ausgangsnachricht nicht gefunden.',404);result=withGmailReference(store,result as {id:string;clientId:string});
        }
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='mail-tests'&&parts[5]==='conversation'){
          const input=await body(req);
          result=recordConversation(store,parts[2],parts[4],input);
        }
        else if(req.method==='GET'&&parts.length===6&&parts[3]==='mail-tests'&&parts[5]==='reconcile')result=store.mailForReconciliation(parts[2],parts[4]);
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='mail-tests'&&parts[5]==='reconcile')result=store.reconcileMail(parts[2],parts[4],await body(req));
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='mail-reserve')result=store.reserveMailTest(parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='mail-tests'&&parts[5]==='finish'){const d=await body(req);result=store.finishMailTest(parts[2],parts[4],d.status,d.providerId,d.result);}
        else if(parts.length===6&&parts[3]==='leads'&&parts[5]==='permission'){if(req.method==='POST')result=saveContactPermission(store,parts[2],parts[4],await body(req));else result={current:publicRecords(store,'permission').find(r=>r.id===parts[4]&&r.clientId===parts[2])?.content||null,problems:contactPermissionProblems(store,parts[2],parts[4])};}
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='leads')result=store.leads(parts[2],Number(url.searchParams.get('offset')||0));
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='lead-preview')result=store.previewLeads(parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='lead-import')result=store.importLeads(parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='leads'&&parts[5]==='block'){const d=await body(req);result=store.blockLead(parts[2],parts[4],d.blocked,d.reason);}
        else if(req.method==='GET'&&parts.length===4&&parts[3]==='brief')result=store.briefState(parts[2]);
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='rules')result=store.saveRules(parts[2],await body(req));
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='approve') {const d=await body(req);if(d.confirmed!==true)throw new AppError('Bitte den Betriebsrahmen ausdrücklich bestätigen.');result=store.approveBrief(parts[2],d.revision,d.clientVersion);}
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='source') {const d=await body(req);result=store.addSource(parts[2],{kind:'manual',url:d.url||'',title:d.title,text:d.text},d.revision);}
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='website') {const d=await body(req);const before=store.brief(parts[2]);const client=store.client(parts[2]);if(before.revision!==d.revision)throw new AppError('Kundenwissen geändert. Bitte neu laden.',409);if(!client.website)throw new AppError('Bitte zuerst die Website in den Unternehmensangaben speichern.');const source=await fetchWebsite(client.website);if(store.client(parts[2]).version!==client.version)throw new AppError('Kundenangaben wurden während des Abrufs geändert. Bitte erneut starten.',409);result=store.addSource(parts[2],source,d.revision);}
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='sources'&&parts[5]==='review'){const d=await body(req);result=store.reviewSource(parts[2],parts[4],d.revision,d.reviewed);}
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='sources'&&parts[5]==='remove'){const d=await body(req);result=store.removeSource(parts[2],parts[4],d.revision);}
        else if(req.method==='POST'&&parts.length===4&&parts[3]==='ai-reserve'){const d=await body(req);result=store.reserveAI(parts[2],d.purpose,d.revision,d.expectedBindingHash);}
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='ai'&&parts[5]==='finish'){const d=await body(req);result=store.finishAI(parts[2],parts[4],d.status,d.result,d.usage);}
        else if(req.method==='POST'&&parts.length===6&&parts[3]==='ai'&&parts[5]==='review'){const d=await body(req);result=store.reviewAI(parts[2],parts[4],d.review);}
        else if (req.method === 'POST' && parts.length === 4 && parts[3] === 'pause') { const data = await body(req); if (typeof data.paused !== 'boolean') throw new AppError('Status fehlt.'); result = store.pauseClient(parts[2], data.paused, data.version); }
        else if (req.method === 'POST' && parts.length === 4 && parts[3] === 'test-jobs') { const data = await body(req); result = { id: store.enqueueDiagnostic(parts[2], data.delaySeconds) }; }
        else if (req.method === 'POST' && parts.length === 6 && parts[3] === 'jobs' && parts[5] === 'cancel') { store.cancelJob(parts[2], parts[4]); result = { ok: true }; }
        else throw new AppError('Nicht gefunden.', 404);
      } else throw new AppError('Nicht gefunden.', 404);
      res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(e instanceof AppError ? e.status : 500); res.end(JSON.stringify({ error: e instanceof AppError ? e.message : 'Vorgang fehlgeschlagen. Bitte Datenordner und Speicherplatz prüfen.' })); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local address');
  return { url: `http://127.0.0.1:${address.port}`, runtime, close: async () => { clearInterval(timer); await new Promise<void>(r => server.close(() => r())); store.close(); } };
}

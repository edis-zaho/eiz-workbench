import {bindRelay,configureRelay,relayContext,acceptRelayPage} from '../core/relay-sync';
import {configureTracking,prepareTracking,registeredTracking,trackingHash} from '../core/tracking';
import {experimentSignals} from '../core/experiment-signals';
import {buildCustomerReport,customerReportData} from '../core/customer-report';
import {signalBasis,previewSignals,importSignals,signalOverview,withdrawSignal} from '../core/signals';
import {meetingBasis,saveMeeting} from '../core/meetings';
import {experimentResults} from '../core/experiment-results';
import {evidenceAttribution} from '../core/evidence-attribution';
import {conversationPreview,saveConversationCase} from '../core/conversations';
import {threadContextSetup,saveThreadContext} from '../core/thread-context';
import {replyWritingSetup,reserveReplyWriting,finishReplyWriting,saveReplyDraft} from '../core/reply-writing';
import {dialoguePreview,reserveDialogue,authorizeDialogue,finishDialogue} from '../core/dialogue-send';
import {recordConversation} from '../core/inbox';
import {interpretationHistory,saveHumanInterpretation,appendInterpretation} from '../core/interpretations';
import {emptyInterpretation} from '../core/interpretation-input';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Store,validateBackup,AppError} from '../core/store';
import {saveProduct,saveAccount,linkAccount} from '../core/catalog';
import {previewExperiment,saveExperiment,closeExperiment,experimentState,exportProductExperiments} from '../core/experiments';
import {allocateCompanies,experimentInput,type ExperimentContact} from '../core/experiment-input';
import {prepareQueue,controlQueue,activateLiveQueue,claimOutbound,authorizeOutbound} from '../core/outbox';
import {validateCampaign,type CampaignContent} from '../core/campaign';
import {saveKnowledge,knowledgeState} from '../core/knowledge';
import {saveStrategy,strategyState,exportStrategy,exportProductStrategy} from '../core/strategy';
import {personaContent,hypothesisContent,matchPersonaTitle} from '../core/strategy-input';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';
const {saveCheckpoint}=createRequire(import.meta.url)('../scripts/save-checkpoint.cjs');
const product={name:'Synthetic product',description:'CSV export',website:'',bookingUrl:'',archived:false};
const persona={code:'IT_LEADERSHIP',name:'IT-Leitung',responsibility:'Verantwortet Systeme und Schnittstellen.',titles:['Head of IT','IT Director']};
const resign=(b:any)=>{b.checksum=createHash('sha256').update(JSON.stringify(b.data)).digest('hex');return b;};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'eiz-strategy-')),file=join(dir,'revenue.sqlite'),backups=join(dir,'backups');let s=new Store(file,backups,false);
 const a=s.createClient({name:'A',website:'',email:'',notes:''}).id,b=s.createClient({name:'B',website:'',email:'',notes:''}).id,p=saveProduct(s,a,null,product,0).productId,q=saveProduct(s,a,null,product,0).productId;
 const meta={entityId:null,expectedRevision:0,productRevision:1,actor:'Test reviewer',reason:'Synthetischer Beleg',action:'save'};
 const source=saveKnowledge(s,a,p,{...meta,kind:'source',content:{title:'Source',locator:'Synthetic document',capturedAt:'2026-09-01T00:00:00.000Z',text:'CSV export is available.',withdrawn:false}});
 const content={category:'feature',text:'CSV export is available.',sourceId:source.id,quote:'CSV export is available.'};
 const draft=saveKnowledge(s,a,p,{...meta,kind:'claim',content}),fact=saveKnowledge(s,a,p,{...meta,kind:'claim',content,entityId:draft.entityId,expectedRevision:1,action:'approve'});
 function input(kind='persona',content:any=persona,entityId:string|null=null,action='save'){
  const state=strategyState(s,a,p),old=state.items.find(r=>r.entityId===entityId);return {entityId,expectedRevision:old?.revision||0,productRevision:state.productRevision,kind,action,content,actor:'Test reviewer',reason:'Reviewed synthetic strategy'};
 }
 const save=(v=input())=>saveStrategy(s,a,p,v);
 function review(entityId:string,action='approve'){const r=strategyState(s,a,p).items.find(r=>r.entityId===entityId)!;return save(input(r.kind,r.content,entityId,action));}
 const hyp=(personaId:string)=>({name:'IT CSV angle',personaId,segment:'Manufacturers',pain:'Manual transfers',angle:'Verifiable CSV workflow',benefit:'Test whether traceability is relevant',cta:'Compare current workflow',style:'Direct and factual; no invented ROI',knowledgeIds:[fact.id]});
 function setup(){const pd=save(),pa=review(pd.entityId),hd=save(input('hypothesis',hyp(pa.id))),ha=review(hd.entityId);return {pd,pa,hd,ha};}
 const {pa,ha}=setup(),hd2=save(input('hypothesis',{...hyp(pa.id),name:'Second angle',angle:'Process review'})),ha2=review(hd2.entityId);
 const csv={csv:'email;company;role\n'+Array.from({length:8},(_,i)=>`lead${i}@company${Math.floor(i/2)}.example;Company ${Math.floor(i/2)};Head of IT`).join('\n'),delimiter:';',filename:'synthetic.csv',mapping:{email:0,company:1,role:2,firstName:-1,lastName:-1}};
 s.importLeads(a,{...csv,fingerprint:s.previewLeads(a,csv).fingerprint});const leads=s.campaignLeads(a);const accounts=Array.from({length:4},(_,i)=>saveAccount(s,a,null,{name:'Company '+i,domain:`company${i}.example`},0));
 for(const l of leads)linkAccount(s,a,l.id,accounts[Number(l.email.match(/company(\d)/)![1])].accountId,0);
 const plan={name:'Synthetic comparison',seed:'repeatable-test',productRevision:1,hypothesisIds:[ha.id,ha2.id],leadIds:leads.map(l=>l.id)};
 const preview=()=>previewExperiment(s,a,p,plan);
 const persist=(v=preview())=>saveExperiment(s,a,p,{input:v.content.input,fingerprint:v.fingerprint,confirmed:true,actor:'Test',reason:'Reviewed allocation'});
 return {plan,preview,persist,leads,accounts,ha,ha2,pa,get s(){return s;},a,b,p,q,dir,file,backups,source,fact,input,save,review,hyp,setup,state:()=>strategyState(s,a,p),reopen(){s.close();s=new Store(file,backups,false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}

test('allocation repeats across input ordering and keeps all company contacts in one balanced arm',()=>{
 const f=fixture();try{
  const a=f.preview(),b=previewExperiment(f.s,f.a,f.p,{...f.plan,hypothesisIds:[...f.plan.hypothesisIds].reverse(),leadIds:[...f.plan.leadIds].reverse()});
  assert.deepEqual(a,b);assert.equal(a.content.allocation.groups.length,4);assert.equal(a.content.allocation.held.length,0);
  for(const id of f.plan.hypothesisIds)assert.equal(a.content.allocation.groups.filter(g=>g.hypothesisId===id).length,2);
  assert.equal(new Set(a.content.allocation.groups.map(g=>g.accountId)).size,4);assert.ok(a.content.allocation.groups.every(g=>g.leadIds.length===2));
  assert.equal(f.s.exportBackup().data.experiments!.length,0,'preview is read-only');
 }finally{f.close();}
});

test('common eligibility excludes incomplete companies, ambiguous titles, blocked and unlinked contacts',()=>{
 const c=(leadId:string,accountId:string|null,role:string,blocked=false):ExperimentContact=>({leadId,accountId,role,blocked,linkId:null,accountRevision:null,company:'Test',domain:''});
 const contacts=[c('a','one','IT'),c('b','one','Sales'),c('c','two','IT'),c('d','two','Sales'),c('e','three','IT'),c('f','one','CEO'),c('g',null,'IT'),c('h','one','IT',true)];
 const arms=[{id:'a',personaId:'it',persona:{...persona,titles:['IT']}},{id:'b',personaId:'sales',persona:{...persona,code:'SALES',titles:['Sales']}}];
 const allocation=allocateCompanies('seed',contacts,arms);
 assert.equal(allocation.groups.length,2);assert.equal(allocation.groups.reduce((n,g)=>n+g.leadIds.length,0),2);
 const held=new Map(allocation.held.map(h=>[h.leadId,h.reason]));assert.match(held.get('e')!,/nicht für jeden/);assert.match(held.get('f')!,/nicht zugeordnet/);assert.match(held.get('g')!,/Unternehmenszuordnung/);assert.match(held.get('h')!,/gesperrt/);
 assert.deepEqual(allocateCompanies('seed',[...contacts].reverse(),[...arms].reverse()),allocation);
 const ambiguous=allocateCompanies('seed',contacts,[arms[0],{...arms[1],persona:{...arms[1].persona,titles:['IT','Sales']}}]);assert.match(ambiguous.held.find(h=>h.leadId==='a')!.reason,/mehrdeutig/);
});

test('strict bounded inputs, foreign contacts/products, stale hypotheses and paused clients fail',()=>{
 const f=fixture();try{
  for(const patch of [{hypothesisIds:[f.ha.id]},{hypothesisIds:[f.ha.id,f.ha.id]},{leadIds:[]},{leadIds:[...f.plan.leadIds,f.plan.leadIds[0]]},{seed:''},{productRevision:0},{unexpected:true}])assert.throws(()=>experimentInput({...f.plan,...patch}));
  assert.throws(()=>previewExperiment(f.s,f.a,f.p,{...f.plan,leadIds:[randomUUID()]}),/Kunden/);assert.throws(()=>previewExperiment(f.s,f.b,f.p,f.plan));assert.throws(()=>previewExperiment(f.s,f.a,f.q,f.plan));
  assert.throws(()=>previewExperiment(f.s,f.a,f.p,{...f.plan,productRevision:2}),/Produktstand/);
  f.review(f.ha.entityId,'withdraw');assert.throws(()=>f.preview(),/freigegebene Hypothesen/);assert.equal(f.s.exportBackup().data.experiments!.length,0);
 }finally{f.close();}
 const g=fixture();try{g.s.pauseClient(g.a,true,1);assert.throws(()=>g.preview(),/pausiert/);}finally{g.close();}
});

test('save checks preview again, rejects concurrent overlapping plans and preserves immutable assignments',()=>{
 const f=fixture();try{
  const p=f.preview(),lead=f.leads[0];linkAccount(f.s,f.a,lead.id,null,1);
  assert.throws(()=>f.persist(p),/inzwischen geändert/);assert.equal(f.s.exportBackup().data.experiments!.length,0);
  const fresh=f.preview(),row=f.persist(fresh);assert.throws(()=>f.persist(fresh),/offenen Experimentplan/);assert.throws(()=>f.s.db.prepare('UPDATE experiment_versions SET reason=? WHERE id=?').run('Changed',row.id));
  f.reopen();const saved=experimentState(f.s,f.a,f.p).items[0];assert.deepEqual(saved.content,fresh.content);assert.equal(saved.problems.length,0);assert.equal(saved.state,'planned');
  const data=f.s.exportBackup().data;assert.equal(data.campaigns!.length,0);assert.equal(data.mailTests!.length,0);assert.equal(data.queueRuns!.length,0);
 }finally{f.close();}
});

test('storage failure rolls back completely without reserving companies',()=>{
 const f=fixture();try{
  const p=f.preview(),before=f.s.exportBackup().data;f.s.db.exec("CREATE TRIGGER synthetic_experiment_fail BEFORE INSERT ON experiment_versions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  assert.throws(()=>f.persist(p),/synthetic failure/);assert.deepEqual(f.s.exportBackup().data,before);
  f.s.db.exec('DROP TRIGGER synthetic_experiment_fail');f.persist(p);
 }finally{f.close();}
});

test('account or persona drift is reported without moving saved groups; closing is explicit and permanent',()=>{
 const f=fixture();try{
  const row=f.persist(),content=row.content;linkAccount(f.s,f.a,f.leads[0].id,null,1);f.review(f.pa.entityId,'withdraw');
  const state=experimentState(f.s,f.a,f.p).items[0];assert.equal(JSON.stringify(state.content),content);assert.match(state.problems.join(' '),/Unternehmenszuordnung geändert/);assert.match(state.problems.join(' '),/Hypothesen/);
  assert.throws(()=>closeExperiment(f.s,f.a,f.p,row.experimentId,{revision:1,confirmed:false,actor:'Test',reason:'Close'}));
  const closed=closeExperiment(f.s,f.a,f.p,row.experimentId,{revision:1,confirmed:true,actor:'Test',reason:'Stop comparison'});assert.equal(closed.revision,2);assert.equal(closed.content,content);assert.equal(experimentState(f.s,f.a,f.p).items[0].state,'closed');
  assert.throws(()=>closeExperiment(f.s,f.a,f.p,row.experimentId,{revision:1,confirmed:true,actor:'Test',reason:'Again'}),/bereits/);
 }finally{f.close();}
});

test('closing releases planning reservations and repeated plans keep distinct experiment identities',()=>{
 const f=fixture();try{
  const first=f.persist();closeExperiment(f.s,f.a,f.p,first.experimentId,{revision:1,confirmed:true,actor:'Test',reason:'Closed before next comparison'});
  const second=f.persist();assert.notEqual(first.experimentId,second.experimentId);assert.equal(first.content,second.content);assert.equal(exportProductExperiments(f.s,f.a,f.p).rows.length,3);
 }finally{f.close();}
});

test('duplicate company domains and existing approved campaigns or open queues block planning',()=>{
 const f=fixture();try{
  saveAccount(f.s,f.a,null,{name:'Duplicate',domain:'company0.example'},0);assert.match(f.preview().problems.join(' '),/dieselbe Domain/);assert.throws(()=>f.persist(),/dieselbe Domain/);
 }finally{f.close();}
 const g=fixture();try{
  let b=g.s.addSource(g.a,{kind:'manual',url:'',title:'Test',text:'Synthetic'},0);b=g.s.reviewSource(g.a,b.content.sources[0].id,b.revision,true);Object.assign(b.content.rules,{offer:'CSV',targets:'Companies',personas:'IT',claims:'CSV'});b.content.routes.analysis.model='test';b.content.routes.writing.model='test';b=g.s.saveRules(g.a,{...b.content,revision:b.revision});g.s.approveBrief(g.a,b.revision,1);
  const content={name:'Existing',leadIds:[g.leads[0].id],dailyLimit:1,startDate:'2026-10-01',startHour:9,endHour:17,weekdays:[1,2,3,4,5],timezone:'UTC',steps:[{subject:'Test',body:'Test',gapDays:0}]};
  const c=g.s.saveCampaign(g.a,{content}),p=g.s.campaignPreview(g.a,c.id);g.s.approveCampaign(g.a,c.id,{confirmed:true,fingerprint:p.fingerprint});assert.match(g.preview().problems.join(' '),/freigegebenen Kampagne/);assert.throws(()=>g.persist(),/freigegebenen Kampagne/);
  prepareQueue(g.s,g.a,c.id,{confirmed:true,fingerprint:p.fingerprint});g.s.saveCampaign(g.a,{id:c.id,revision:c.revision,content:{...content,name:'Changed'}});assert.match(g.preview().problems.join(' '),/offenen Warteschlange/);assert.throws(()=>g.persist(),/offenen Warteschlange/);
 }finally{g.close();}
});

test('backup, checkpoint, restart and export retain plans and closures; stale restore cannot reopen a plan',()=>{
 const f=fixture();try{
  const before=f.s.exportBackup(),row=f.persist(),active=f.s.exportBackup();assert.throws(()=>f.s.restore(before),/Experimentpläne/);
  closeExperiment(f.s,f.a,f.p,row.experimentId,{revision:1,confirmed:true,actor:'Test',reason:'Close'});assert.throws(()=>f.s.restore(active),/Schließungen/);
  const backup=f.s.exportBackup();assert.equal(rehearseRestore(backup).counts.experiments,2);f.s.restore(backup);f.reopen();assert.equal(experimentState(f.s,f.a,f.p).items[0].state,'closed');
  const path=saveCheckpoint(join(f.dir,'checkpoint'),f.dir).filename;assert.deepEqual(validateBackup(JSON.parse(readFileSync(path,'utf8'))).data.experiments,JSON.parse(JSON.stringify(backup.data.experiments)));
  const exported=exportProductExperiments(f.s,f.a,f.p);assert.equal(exported.strategies.length,3);assert.equal(exported.rows.length,2);assert.throws(()=>exportProductExperiments(f.s,f.b,f.p));
 }finally{f.close();}
});

test('backup validation rejects forged allocation, references, missing plans and incompatible schema',()=>{
 const f=fixture();try{
  f.persist();const original=f.s.exportBackup();
  for(const mutate of [(b:any)=>delete b.data.experiments,(b:any)=>{b.version=16;},(b:any)=>{b.data.experiments[0].clientId=f.b;},(b:any)=>{b.data.experiments[0].revision=2;},(b:any)=>{const r=b.data.experiments[0],c=JSON.parse(r.content);c.allocation.groups[0].leadIds=[];r.content=JSON.stringify(c);},(b:any)=>{const r=b.data.experiments[0],c=JSON.parse(r.content);c.contacts[0].linkId=randomUUID();r.content=JSON.stringify(c);},(b:any)=>{const r=b.data.experiments[0];b.data.experiments.push({...r,id:randomUUID(),experimentId:randomUUID()});}]){
   const b=structuredClone(original);mutate(b);assert.throws(()=>validateBackup(resign(b)),/Experimentplan|Zuteilung/);
  }
 }finally{f.close();}
});

test('schema16 upgrade backs up all strategy and contact history before adding an empty plan table',()=>{
 const f=fixture();try{
  const before=f.s.exportBackup();f.s.db.exec('DROP TABLE experiment_versions; PRAGMA user_version=16');f.reopen();assert.equal(f.s.snapshot().database.schema,34);
  const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,backup=validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8')));assert.equal(backup.version,16);assert.equal(backup.data.experiments,undefined);assert.deepEqual(backup.data.strategies,JSON.parse(JSON.stringify(before.data.strategies)));assert.deepEqual(backup.data.leadAccountLinks,JSON.parse(JSON.stringify(before.data.leadAccountLinks)));
 }finally{f.close();}
});

test('experiment API protects authentication, origin, ownership and explicit confirmation',async()=>{
 const f=fixture(),token='e'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/products/${f.p}`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 try{
  assert.equal((await fetch(server.url+path+'/experiments')).status,401);
  assert.equal((await fetch(server.url+path+'/experiment-preview',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:JSON.stringify(f.plan)})).status,403);
  assert.equal((await fetch(server.url+path.replace(f.a,f.b)+'/experiments',{headers})).status,404);
  const p=await(await fetch(server.url+path+'/experiment-preview',{method:'POST',headers,body:JSON.stringify(f.plan)})).json();
  const payload={input:p.content.input,fingerprint:p.fingerprint,confirmed:true,actor:'Test',reason:'Review'};
  assert.equal((await fetch(server.url+path+'/experiments',{method:'POST',headers,body:JSON.stringify({...payload,confirmed:false})})).status,400);
  assert.equal((await fetch(server.url+path+'/experiments',{method:'POST',headers,body:JSON.stringify(payload)})).status,200);
  assert.equal((await fetch(server.url+path+'/experiments',{method:'POST',headers,body:JSON.stringify(payload)})).status,409);
  assert.equal((await(await fetch(server.url+path+'/experiments-export',{headers})).json()).rows.length,1);
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('insufficient common pool still explains every held contact but cannot be saved',()=>{
 const f=fixture();try{
  for(const l of f.leads)linkAccount(f.s,f.a,l.id,null,1);
  const p=f.preview();assert.equal(p.content.allocation.groups.length,0);assert.equal(p.content.allocation.held.length,8);assert.match(p.problems[0],/Zu wenige/);assert.throws(()=>f.persist(p),/Zu wenige/);assert.equal(f.s.exportBackup().data.experiments!.length,0);
 }finally{f.close();}
});

function operational(f:ReturnType<typeof fixture>){
 let b=f.s.addSource(f.a,{kind:'manual',url:'',title:'Synthetic',text:'CSV'},0);b=f.s.reviewSource(f.a,b.content.sources[0].id,b.revision,true);
 Object.assign(b.content.rules,{offer:'CSV',targets:'Companies',personas:'IT',claims:'CSV',companyCap:2});b.content.routes.analysis.model='test';b.content.routes.writing.model='test';b=f.s.saveRules(f.a,{...b.content,revision:b.revision});f.s.approveBrief(f.a,b.revision,1);
 const plan=f.persist(),allocation=JSON.parse(plan.content).allocation;
 const content=(hypothesisId=f.ha.id):CampaignContent=>({name:'Experiment campaign',experimentId:plan.experimentId,hypothesisId,productRef:{productId:f.p,revision:1},knowledgeIds:[f.fact.id],leadIds:allocation.groups.filter((g:any)=>g.hypothesisId===hypothesisId).flatMap((g:any)=>g.leadIds),dailyLimit:1,startDate:'2026-10-01',startHour:0,endHour:24,weekdays:[0,1,2,3,4,5,6],timezone:'UTC',steps:[{subject:'Synthetic',body:'CSV workflow',gapDays:0}]});
 const approve=(hypothesisId=f.ha.id)=>{const c=f.s.saveCampaign(f.a,{content:content(hypothesisId)}),p=f.s.campaignPreview(f.a,c.id);assert.equal(p.problemCount,0,p.problems.join(' '));f.s.approveCampaign(f.a,c.id,{fingerprint:p.fingerprint,confirmed:true});return {c,p};};
 return {plan,content,approve,close:()=>closeExperiment(f.s,f.a,f.p,plan.experimentId,{revision:1,confirmed:true,actor:'Test',reason:'Stop experiment'})};
}

test('experiment campaign accepts only the complete fixed arm and rejects forged references',()=>{
 const f=fixture();try{const o=operational(f),form=o.content();
  for(const patch of [{experimentId:''},{experimentId:null},{experimentId:123},{hypothesisId:undefined},{productRef:undefined}])assert.throws(()=>validateCampaign({...form,...patch}));
  for(const patch of [{experimentId:randomUUID()},{leadIds:form.leadIds.slice(1)},{leadIds:[...form.leadIds,f.leads.find(l=>!form.leadIds.includes(l.id))!.id]},{hypothesisId:f.ha2.id},{productRef:{productId:f.q,revision:1}}])assert.throws(()=>f.s.saveCampaign(f.a,{content:{...form,...patch}}));
  assert.throws(()=>f.s.saveCampaign(f.b,{content:form}));assert.equal(f.s.campaigns(f.a).length,0);
  const c=f.s.saveCampaign(f.a,{content:{...form,leadIds:[...form.leadIds].reverse()}});assert.equal(f.s.campaignPreview(f.a,c.id).experiment?.companies,2);
 }finally{f.close();}
});

test('both experiment arms can be approved and queued without self-conflict or losing fixed identities',()=>{
 const f=fixture();try{const o=operational(f),a=o.approve(),first=a.p.fingerprint;
  const ar=prepareQueue(f.s,f.a,a.c.id,{confirmed:true,fingerprint:first})[0];const b=o.approve(f.ha2.id),br=prepareQueue(f.s,f.a,b.c.id,{confirmed:true,fingerprint:b.p.fingerprint})[0];
  assert.equal(f.s.campaignPreview(f.a,a.c.id).fingerprint,first);assert.equal(f.s.campaignPreview(f.a,a.c.id).approved,true);assert.deepEqual(experimentState(f.s,f.a,f.p).items[0].problems,[]);
  assert.equal(ar.snapshot.content.experimentId,o.plan.experimentId);assert.equal(br.snapshot.content.hypothesisId,f.ha2.id);assert.deepEqual(ar.snapshot.content.steps,o.content().steps);
  assert.equal(f.s.campaignHistory(f.a,a.c.id)[0].experiment?.planVersionId,o.plan.id);
  assert.equal(f.s.exportBackup().data.mailTests!.length,0);assert.equal(rehearseRestore(f.s.exportBackup()).restartVerified,true);
 }finally{f.close();}
});

test('one campaign identity per arm survives draft revisions; saved binding cannot be removed or switched',()=>{
 const f=fixture();try{const o=operational(f),a=o.approve();
  assert.throws(()=>f.s.saveCampaign(f.a,{content:o.content()}),/bereits eine Kampagne/);
  assert.throws(()=>f.s.saveCampaign(f.a,{id:a.c.id,revision:1,content:o.content(f.ha2.id)}),/bleibt fest/);
  const {experimentId,...unbound}=o.content();assert.throws(()=>f.s.saveCampaign(f.a,{id:a.c.id,revision:1,content:unbound}),/reserviert|bleibt fest/);
  const next=f.s.saveCampaign(f.a,{id:a.c.id,revision:1,content:{...o.content(),steps:[{subject:'Revised',body:'Another reviewed text',gapDays:0}]}});assert.equal(next.approvedHash,null);assert.equal(next.revision,2);
  assert.throws(()=>f.s.approveCampaign(f.a,next.id,{confirmed:true,fingerprint:a.p.fingerprint}),/geändert/);
  o.close();assert.throws(()=>f.s.saveCampaign(f.a,{id:next.id,revision:2,content:unbound}),/bleibt fest/);
 }finally{f.close();}
});

test('reserved companies cannot bypass experiments through unbound drafts, unlinking or a new contact',()=>{
 const f=fixture();try{const o=operational(f),{experimentId,...unbound}=o.content();
  assert.throws(()=>f.s.saveCampaign(f.a,{content:unbound}),/reserviert/);
  const id=unbound.leadIds[0];linkAccount(f.s,f.a,id,null,1);assert.throws(()=>f.s.saveCampaign(f.a,{content:{...unbound,leadIds:[id]}}),/reserviert/);
  const csv={csv:'email\nnew@company0.example',delimiter:';',filename:'new.csv',mapping:{email:0,company:-1,role:-1,firstName:-1,lastName:-1}};f.s.importLeads(f.a,{...csv,fingerprint:f.s.previewLeads(f.a,csv).fingerprint});
  const added=f.s.campaignLeads(f.a).find(l=>l.email==='new@company0.example')!;assert.throws(()=>f.s.saveCampaign(f.a,{content:{...unbound,leadIds:[added.id]}}),/reserviert/);
  assert.equal(f.s.campaigns(f.a).length,0);
 }finally{f.close();}
});

test('a pre-existing unbound draft becomes blocked when its companies are allocated',()=>{
 const f=fixture();try{
  const c=f.s.saveCampaign(f.a,{content:{name:'Earlier draft',leadIds:f.leads.map(l=>l.id),dailyLimit:1,startDate:'2026-10-01',startHour:0,endHour:24,weekdays:[1],timezone:'UTC',steps:[{subject:'Test',body:'Test',gapDays:0}]}});
  const before=f.s.campaignPreview(f.a,c.id);const o=operational(f);const after=f.s.campaignPreview(f.a,c.id);assert.match(after.problems.join(' '),/reserviert/);assert.notEqual(after.fingerprint,before.fingerprint);assert.throws(()=>f.s.approveCampaign(f.a,c.id,{confirmed:true,fingerprint:after.fingerprint}));o.close();assert.doesNotMatch(f.s.campaignPreview(f.a,c.id).problems.join(' '),/reserviert/);
 }finally{f.close();}
});

test('closing and contact drift after reservation block final provider authorization; no authorization event is written',()=>{
 for(const mode of ['close','unlink','account','hypothesis']){const f=fixture();try{const o=operational(f),{c,p}=o.approve();let run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint})[0];
  const mailboxId=randomUUID(),sender='sender@example.com',mail=f.s.reserveMailTest(f.a,{id:randomUUID(),mailboxId,clientVersion:1,sender,recipient:'owner@example.com',subject:'Test',body:'Test'});f.s.finishMailTest(f.a,mail.id,'sent','synthetic','OK');
  f.s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+f.a,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:mail.id,mailboxId,clientVersion:1,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
  run=activateLiveQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN',mailboxId,sender})[0];run=controlQueue(f.s,f.a,run.id,{revision:run.revision,confirmed:true,action:'start'})[0];
  const at=new Date('2026-10-05T12:00:00Z'),q=claimOutbound(f.s,f.a,run.id,{mailboxId,sender},at)!;assert.ok(q,mode);
  if(mode==='close')o.close();else if(mode==='unlink')linkAccount(f.s,f.a,o.content().leadIds[0],null,1);else if(mode==='account')saveAccount(f.s,f.a,f.accounts[0].accountId,{name:'Changed',domain:'company0.example'},1);else f.review(f.ha.entityId,'withdraw');
  assert.equal(f.s.campaignPreview(f.a,c.id).approved,false,mode);assert.throws(()=>authorizeOutbound(f.s,f.a,run.id,q.id,{revision:q.runRevision,mailboxId,sender},at),/geändert/,mode);
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='QUEUE_SEND_AUTHORIZED'").get()!.n,0);
 }finally{f.close();}}
});

test('experiment bindings survive closure, restart, checkpoint and restore; forged or stripped bindings fail validation',()=>{
 const f=fixture();try{const o=operational(f),{c,p}=o.approve();prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint});const active=f.s.exportBackup();o.close();
  const backup=f.s.exportBackup();assert.throws(()=>f.s.restore(active),/Schließungen/);assert.equal(rehearseRestore(backup).restartVerified,true);f.s.restore(backup);f.reopen();assert.equal(f.s.campaignHistory(f.a,c.id)[0].experiment?.state,'closed');assert.equal(f.s.campaignPreview(f.a,c.id).approved,false);
  const checkpoint=saveCheckpoint(join(f.dir,'checkpoint'),f.dir);assert.equal(validateBackup(JSON.parse(readFileSync(checkpoint.filename,'utf8'))).version,34);
  for(const mutate of [(b:any)=>{b.version=17;},(b:any)=>{const row=b.data.queueRuns[0],c=JSON.parse(row.snapshot);delete c.content.experimentId;row.snapshot=JSON.stringify(c);},(b:any)=>{const row=b.data.campaigns[0],c=JSON.parse(row.content);delete c.experimentId;row.content=JSON.stringify(c);},(b:any)=>{const row=b.data.campaignHistory[0],c=JSON.parse(row.content);c.experimentId=randomUUID();row.content=JSON.stringify(c);},(b:any)=>{const row=b.data.campaigns[0],c=JSON.parse(row.content);c.leadIds.pop();row.content=JSON.stringify(c);}]){const bad=structuredClone(backup);mutate(bad);assert.throws(()=>validateBackup(resign(bad)));}
 }finally{f.close();}
});

test('schema17 migration preserves old unbound fingerprint and backs up plans before compatibility barrier',()=>{
 const f=fixture();try{
  const c=f.s.saveCampaign(f.a,{content:{name:'Legacy',leadIds:[],dailyLimit:1,startDate:'2026-10-01',startHour:0,endHour:24,weekdays:[1],timezone:'UTC',steps:[{subject:'Test',body:'Test',gapDays:0}]}}),before=f.s.campaignPreview(f.a,c.id).fingerprint;f.persist();const rows=f.s.exportBackup().data.experiments;f.s.db.exec('PRAGMA user_version=17');f.reopen();assert.equal(f.s.snapshot().database.schema,34);assert.equal(f.s.campaignPreview(f.a,c.id).fingerprint,before);
  const name=readdirSync(f.backups).find(n=>n.includes('before-upgrade'))!,b=validateBackup(JSON.parse(readFileSync(join(f.backups,name),'utf8')));assert.equal(b.version,17);assert.deepEqual(b.data.experiments,JSON.parse(JSON.stringify(rows)));
 }finally{f.close();}
});


test('closed bound approval releases companies only after its open queue is explicitly ended',()=>{
 const f=fixture();try{const o=operational(f),{c,p}=o.approve(),run=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint})[0];o.close();
  assert.equal(f.s.campaign(c.clientId,c.id).approvedHash,p.fingerprint,'historical approval is retained');
  assert.throws(()=>f.persist(),/offenen Warteschlange/);
  controlQueue(f.s,f.a,run.id,{revision:run.revision,action:'cancel',confirmed:true});
  const next=f.persist();assert.notEqual(next.experimentId,o.plan.experimentId);assert.equal(f.s.campaignPreview(f.a,c.id).approved,false);
  assert.throws(()=>prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint}),/geprüften Kampagnenplan/);
 }finally{f.close();}
});

function resultFixture(followups=false,styled=false){
 const f=fixture(),o=operational(f),mailboxId=randomUUID(),sender='sender@example.com';
 const testMail=f.s.reserveMailTest(f.a,{id:randomUUID(),mailboxId,clientVersion:1,sender,recipient:'owner@example.com',subject:'Connection',body:'Synthetic'});f.s.finishMailTest(f.a,testMail.id,'sent','connection','OK');
 f.s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+f.a,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:testMail.id,mailboxId,clientVersion:1,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
 const runs=[f.ha.id,f.ha2.id].map(h=>{const pair=()=>{if(!followups&&!styled)return o.approve(h);const content=o.content(h);if(followups)content.steps.push({subject:'Follow-up',body:'Second synthetic touch',gapDays:7});if(styled){content.sequence={name:'Synthetic sequence',style:'Direct'};content.steps=content.steps.map((s,i)=>({...s,variant:{name:'Variant '+(i+1),style:''}}));}const c=f.s.saveCampaign(f.a,{content}),p=f.s.campaignPreview(f.a,c.id);f.s.approveCampaign(f.a,c.id,{confirmed:true,fingerprint:p.fingerprint});return {c,p};};const {c,p}=pair();let r=prepareQueue(f.s,f.a,c.id,{confirmed:true,fingerprint:p.fingerprint}).find(r=>r.campaignId===c.id)!;r=activateLiveQueue(f.s,f.a,r.id,{revision:r.revision,confirmed:true,phrase:'ECHTEN VERSAND AKTIVIEREN',mailboxId,sender}).find(v=>v.id===r.id)!;return r;});
 const items=(arm=0)=>f.s.db.prepare('SELECT * FROM queue_items WHERE runId=? ORDER BY recipient,step').all(runs[arm].id);
 function observe(item:any,status='sent',at=new Date().toISOString()){
  f.s.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id,f.a,mailboxId,sender,item.recipient,item.subject,item.body,`<${item.id}@workbench.local>`,status,status==='sent'?'provider_'+item.id:'','Synthetic observation',at,at);
 }
 function reply(item:any,kind='reply',providerId=randomUUID(),receivedAt=new Date().toISOString()){
  recordConversation(f.s,f.a,String(item.id),{mailboxId,clientVersion:1,rows:[{providerId,threadId:'thread_'+providerId,sender:String(item.recipient),subject:'Private subject excluded',excerpt:'Private excerpt excluded',receivedAt,kind,evidence:'{}'}]});
  return String(f.s.db.prepare("SELECT id FROM evidence_events WHERE clientId=? AND source='incoming' AND providerId=?").get(f.a,providerId)!.id);
 }
 function assess(eventId:string,patch:any={},model=false){const h=interpretationHistory(f.s,f.a,eventId),content={...emptyInterpretation(),rationale:'Private rationale excluded',replyType:'interest',requiresHumanReview:false,...patch};return model?appendInterpretation(f.s,f.a,eventId,h.revision,h.basisHash,content,{origin:'model',actor:'Synthetic model',provider:'synthetic',model:'test',promptVersion:'v1'}):saveHumanInterpretation(f.s,f.a,eventId,{expectedRevision:h.revision,expectedBasisHash:h.basisHash,reviewer:'Test',content});}
 return {f,o,runs,items,observe,reply,assess,result:()=>experimentResults(f.s,f.a,f.p,o.plan.experimentId)};
}

test('result report is read-only, keeps zero denominators absent and rejects foreign ownership',()=>{
 const f=fixture();try{const plan=f.persist(),before=f.s.exportBackup().data,r=experimentResults(f.s,f.a,f.p,plan.experimentId);assert.equal(r.arms.length,2);assert.ok(r.arms.every(a=>a.assignedCompanies===2&&a.assignedContacts===4&&a.positiveRate.percent===null));assert.deepEqual(f.s.exportBackup().data,before);assert.equal(r.observations.length,0);assert.equal(r.signalComparison.windowDays,7);assert.throws(()=>experimentResults(f.s,f.b,f.p,plan.experimentId));assert.throws(()=>experimentResults(f.s,f.a,f.q,plan.experimentId));assert.throws(()=>experimentResults(f.s,f.a,f.p,randomUUID()));}finally{f.close();}
});

test('results separate raw replies, automatic inputs and human assessments; counts deduplicate companies and contacts',()=>{
 const x=resultFixture(),{f}=x;try{const [a,b]=x.items(),[c]=x.items(1);x.observe(a);x.observe(b);x.observe(c);const event=x.reply(a);x.assess(event,{meetingIntent:'yes'});x.assess(x.reply(b),{replyType:'rejection'});x.reply(a,'automatic');x.reply(c,'reply');
  const r=x.result(),arm=r.arms.find(v=>v.hypothesisId===f.ha.id)!;assert.equal(arm.acceptedMessages,2);assert.equal(arm.acceptedContacts,2);assert.equal(arm.acceptedCompanies,1);assert.equal(arm.incomingMessages,3);assert.equal(arm.reportedReplies,2);assert.equal(arm.reportedAutomatic,1);assert.equal(arm.humanReplyContacts,2);assert.equal(arm.humanReplyCompanies,1);assert.equal(arm.positiveContacts,1);assert.deepEqual(arm.positiveRate,{numerator:1,denominator:1,percent:100});assert.equal(arm.meetingIntentCompanies,1);
  assert.equal(r.arms.find(v=>v.hypothesisId===f.ha2.id)!.humanReplyCompanies,0);assert.doesNotMatch(JSON.stringify(r),/Private subject|Private excerpt|Private rationale/);
  const before=f.s.exportBackup().data;x.result();assert.deepEqual(f.s.exportBackup().data,before);
 }finally{f.close();}
});

test('latest human correction, review requirement, model proposal and withdrawal change metrics without rewriting evidence',()=>{
 const x=resultFixture(),{f}=x;try{const item=x.items()[0];x.observe(item);const id=x.reply(item);const raw=f.s.exportBackup().data.evidenceEvents;
  const arm=()=>x.result().arms.find(a=>a.hypothesisId===f.ha.id)!;
  x.assess(id,{},true);assert.equal(arm().positiveContacts,0);x.assess(id);assert.equal(arm().positiveContacts,1);x.assess(id,{replyType:'out_of_office'});assert.equal(arm().humanReplyContacts,0);x.assess(id,{requiresHumanReview:true});assert.equal(arm().positiveContacts,0);x.assess(id,{withdrawn:true});assert.equal(arm().positiveContacts,0);x.assess(id,{meetingIntent:'yes'});assert.equal(arm().meetingIntentContacts,1);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);
 }finally{f.close();}
});

test('unknown reconciliation and duplicate inbox fetch do not inflate accepted or response counts',()=>{
 const x=resultFixture(),{f}=x;try{const [a,b,c]=x.items();x.observe(a,'unknown');x.observe(b,'failed');x.observe(c,'sending');let arm=x.result().arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.unresolvedMessages,2);assert.equal(arm.failedMessages,1);assert.equal(arm.acceptedMessages,0);
  f.s.db.prepare("UPDATE mail_tests SET status='sent',providerId='confirmed',result='Found',updatedAt=? WHERE id=?").run(new Date().toISOString(),a.id);
  const providerId=randomUUID(),id=x.reply(a,'reply',providerId);x.reply(a,'reply',providerId);x.assess(id);const r=x.result();arm=r.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.acceptedMessages,1);assert.equal(arm.unresolvedMessages,1);assert.equal(arm.incomingMessages,1);assert.equal(arm.positiveContacts,1);assert.equal(r.observations.filter(o=>o.sourceId===a.id&&o.counted).length,1);assert.equal(r.observations.filter(o=>o.sourceId===a.id).length,2);
 }finally{f.close();}
});

test('historical allocation survives account drift, closed experiment, restart and backup restore',()=>{
 const x=resultFixture(),{f}=x;try{const a=x.items()[0];x.observe(a);x.assess(x.reply(a));const before=x.result();linkAccount(f.s,f.a,String(a.leadId),null,1);x.o.close();const closed=x.result();assert.deepEqual(closed.arms,before.arms);assert.equal(closed.state,'closed');
  const backup=f.s.exportBackup();validateBackup(backup);assert.equal(rehearseRestore(backup).restartVerified,true);f.s.restore(backup);f.reopen();assert.deepEqual(x.result().arms,before.arms);assert.deepEqual(x.result().observations,before.observations);
 }finally{f.close();}
});

test('known rehearsal evidence and unknown historical fingerprint are explicitly excluded',()=>{
 const x=resultFixture(),{f}=x;try{const a=x.items()[0],b=x.items(1)[0];x.observe(a);x.observe(b);
  const snap=JSON.parse(String(f.s.db.prepare('SELECT snapshot FROM queue_runs WHERE id=?').get(x.runs[0].id)!.snapshot));snap.mode='rehearsal';f.s.db.prepare('UPDATE queue_runs SET snapshot=? WHERE id=?').run(JSON.stringify(snap),x.runs[0].id);
  const event=f.s.db.prepare("SELECT * FROM evidence_events WHERE sourceId=?").get(b.id)!;const context={...JSON.parse(String(event.context)),campaignFingerprint:'f'.repeat(64)};const keys=Object.keys(event);f.s.db.prepare(`INSERT INTO evidence_events (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>k==='id'?randomUUID():k==='sourceId'?randomUUID():k==='context'?JSON.stringify(context):event[k]));
  const r=x.result();assert.equal(r.arms.find(a=>a.hypothesisId===f.ha.id)!.acceptedMessages,0);assert.equal(r.arms.find(a=>a.hypothesisId===f.ha2.id)!.acceptedMessages,1);assert.ok(r.excluded.some(e=>e.reason.includes('Probelauf')));assert.ok(r.excluded.some(e=>e.reason.includes('historische')));
 }finally{f.close();}
});

test('fresh restore attributes retained observations without source queues; existing dispatch history remains protected',()=>{
 const x=resultFixture(),{f}=x;try{const a=x.items()[0];x.observe(a);const before=x.result();const backup=f.s.exportBackup();backup.data.queueItems=[];backup.data.queueRuns=[];backup.data.mailTests=[];resign(backup);assert.throws(()=>f.s.restore(backup),/Versandhistorie/);const restored=new Store(join(f.dir,'restored.sqlite'),join(f.dir,'restored-backups'),false);try{restored.restore(backup);const after=experimentResults(restored,f.a,f.p,x.o.plan.experimentId);assert.deepEqual(after.arms,before.arms);assert.ok(after.warnings.some(w=>w.includes('Queue-Datensatz')));}finally{restored.close();}}finally{f.close();}
});

test('result API requires authentication and ownership and returns the same fixed calculation',async()=>{
 const f=fixture(),plan=f.persist(),token='c'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/products/${f.p}/experiments/${plan.experimentId}/results`;try{
  assert.equal((await fetch(server.url+path)).status,401);assert.equal((await fetch(server.url+path.replace(f.a,f.b),{headers:{Authorization:'Bearer '+token}})).status,404);
  const response=await fetch(server.url+path,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);const r=await response.json();assert.equal(r.calculationVersion,'experiment-results-v8');assert.equal(r.experimentId,plan.experimentId);assert.equal(r.arms.length,2);
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});


test('follow-up messages and repeated replies do not inflate unique contact or company denominators',()=>{
 const x=resultFixture(true),{f}=x;try{const [first,follow,second]=x.items();assert.equal(first.leadId,follow.leadId);x.observe(first);x.observe(follow);x.observe(second);x.assess(x.reply(first));x.assess(x.reply(follow));const a=x.result().arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(a.acceptedMessages,3);assert.equal(a.acceptedContacts,2);assert.equal(a.acceptedCompanies,1);assert.equal(a.incomingMessages,2);assert.equal(a.positiveContacts,1);assert.equal(a.positiveCompanies,1);assert.equal(a.positiveRate.percent,100);}finally{f.close();}
});


test('results expose only approved historical message versions, preserve raw evidence and never infer a legacy variant',()=>{
 const x=resultFixture(true,true),{f}=x;try{
  const item=x.items()[0];x.observe(item);x.assess(x.reply(item));const before=x.result(),raw=f.s.exportBackup().data.evidenceEvents;
  assert.equal(before.messageSequences.length,2);const sequence=before.messageSequences.find(s=>s.hypothesisId===f.ha.id)!;assert.equal(sequence.variants.length,2);assert.equal(sequence.countedObservations,2);assert.match(sequence.sequenceId,/^sq1_/);assert.doesNotMatch(JSON.stringify(before.messageSequences),/CSV workflow|Second synthetic touch/);
  const c=f.s.campaign(f.a,x.runs[0].campaignId),content=JSON.parse(c.content);content.sequence.style='Changed draft style';content.steps[0].body='New private template';f.s.saveCampaign(f.a,{id:c.id,revision:c.revision,content});
  assert.deepEqual(x.result().messageSequences,before.messageSequences);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);
  const backup=f.s.exportBackup();validateBackup(backup);f.s.restore(backup);f.reopen();assert.deepEqual(x.result().messageSequences,before.messageSequences);
 }finally{f.close();}
 const legacy=resultFixture();try{assert.deepEqual(legacy.result().messageSequences,[]);}finally{legacy.f.close();}
});


function recordedDialogue(x:ReturnType<typeof resultFixture>,eventId:string,status='sent'){
 const {f}=x,event=f.s.db.prepare('SELECT * FROM evidence_events WHERE id=?').get(eventId)!,incoming=f.s.db.prepare('SELECT * FROM incoming WHERE id=?').get(event.sourceId)!,mail=f.s.db.prepare('SELECT * FROM mail_tests WHERE id=?').get(incoming.mailId)!;
 x.assess(eventId,{technicalQuestion:'no',materialRequest:'no',meetingIntent:'no'});
 const preview=conversationPreview(f.s,f.a,String(mail.recipient));saveConversationCase(f.s,f.a,{recipient:mail.recipient,expectedId:preview.current?.id||null,basisHash:preview.basisHash,status:'dialogue_ready',dueDate:null,actor:'Test',reason:'Reviewed',confirmed:true});
 // Synthetic clock/Google capture only; production reservations and finish paths stay intact.
 f.s.db.prepare("UPDATE mail_tests SET createdAt=? WHERE clientId=? AND NOT EXISTS(SELECT 1 FROM events e WHERE e.id=mail_tests.id AND e.type='DIALOGUE_RESERVED')").run(new Date(Date.now()-120000).toISOString(),f.a);
 const setup=threadContextSetup(f.s,f.a,String(incoming.id)),capture={threadId:incoming.threadId,messages:[{providerId:mail.providerId,messageId:mail.messageId,from:mail.sender,to:mail.recipient,cc:'',subject:String(mail.subject),sentAt:new Date(Date.parse(String(incoming.receivedAt))-1000).toISOString(),direction:'sent',text:String(mail.body),textStatus:'plain',issues:[]},{providerId:incoming.providerId,messageId:'<'+incoming.providerId+'@example.com>',from:mail.recipient,to:mail.sender,cc:'',subject:String(incoming.subject),sentAt:incoming.receivedAt,direction:'received',text:String(incoming.excerpt),textStatus:'plain',issues:[]}]};
 saveThreadContext(f.s,f.a,String(incoming.id),{basisHash:setup.basisHash,expectedId:setup.expectedId,capture});
 const writing=replyWritingSetup(f.s,f.a,String(incoming.id),f.p,[f.fact.id]),run=reserveReplyWriting(f.s,f.a,String(incoming.id),{productId:f.p,factIds:[f.fact.id],basisHash:writing.basisHash,confirmed:true}),output={outcome:'draft',subject:'Re: CSV',body:'CSV export is available.',factIds:[f.fact.id],missingKnowledge:[],rationale:'Approved fact'};
 finishReplyWriting(f.s,f.a,String(incoming.id),run.id,{status:'completed',text:JSON.stringify(output),usage:{}});
 const draft=saveReplyDraft(f.s,f.a,String(incoming.id),run.id,{expectedId:null,subject:output.subject,body:output.body,factIds:output.factIds,actor:'Test',reason:'Reviewed',confirmed:true}).drafts[0];
 const ids=f.s.db.prepare("SELECT id FROM mail_tests WHERE clientId=? AND mailboxId=? AND status='sent' ORDER BY id").all(f.a,mail.mailboxId).map(m=>m.id).join(',');
 f.s.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('delivery-progress:'+f.a,JSON.stringify({trackingVersion:1,syncVersion:1,scopeVersion:2,status:'complete',mailSet:ids,mailboxId:mail.mailboxId,clientVersion:1,cutoff:Math.floor(Date.now()/1000),unmatched:0,unresolvedTracking:true}));
 const d=dialoguePreview(f.s,f.a,String(incoming.id),draft.id),reserved=reserveDialogue(f.s,f.a,String(incoming.id),{draftId:draft.id,basisHash:d.basisHash,confirmed:true,mailboxId:mail.mailboxId,sender:mail.sender,capture});authorizeDialogue(f.s,f.a,reserved.id,{mailboxId:mail.mailboxId,sender:mail.sender});finishDialogue(f.s,f.a,reserved.id,{status,providerId:status==='sent'?'dialogue_'+reserved.id:'',result:'Synthetic only'});return reserved;
}

test('measurement attributes a real reserved dialogue and its reply without changing outreach denominators or raw evidence',()=>{
 const x=resultFixture(),{f}=x;try{const first=x.items()[0];x.observe(first);const original=x.reply(first),dialogue=recordedDialogue(x,original),reply=x.reply(dialogue);x.assess(reply,{meetingIntent:'yes'});const raw=f.s.exportBackup().data.evidenceEvents!,report=x.result(),a=report.arms.find(a=>a.hypothesisId===f.ha.id)!;
 assert.equal(a.acceptedMessages,1);assert.equal(a.acceptedCompanies,1);assert.equal(a.dialogueAcceptedMessages,1);assert.equal(a.dialogueIncomingMessages,1);assert.equal(a.incomingMessages,2);assert.equal(a.positiveCompanies,1);assert.equal(a.meetingIntentCompanies,1);const o=report.observations.find(o=>o.eventId===reply)!;assert.equal(o.attribution.kind,'dialogue');assert.equal(o.attribution.rootMailId,first.id);assert.ok(o.attribution.path.includes(dialogue.id));assert.ok(o.attribution.path.includes(original));assert.equal(JSON.parse(raw.find(e=>e.id===reply)!.context).campaignId,null);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);validateBackup(f.s.exportBackup());
 f.reopen();assert.deepEqual(x.result().arms,report.arms);f.s.restore(f.s.exportBackup());assert.deepEqual(x.result().arms,report.arms);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);
 }finally{f.close();}
});

test('multi-round dialogue measurement follows retained lineage and keeps unique companies stable',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const x=resultFixture(),{f}=x;try{const first=x.items()[0];x.observe(first);const d1=recordedDialogue(x,x.reply(first));t.mock.timers.tick(120000);const d2=recordedDialogue(x,x.reply(d1)),last=x.reply(d2);x.assess(last);const report=x.result(),a=report.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(a.dialogueAcceptedMessages,2);assert.equal(a.dialogueIncomingMessages,2);assert.equal(a.acceptedCompanies,1);assert.equal(a.positiveCompanies,1);const trace=report.observations.find(o=>o.eventId===last)!.attribution;assert.equal(trace.rootMailId,first.id);assert.ok(trace.path.includes(d1.id)&&trace.path.includes(d2.id));validateBackup(f.s.exportBackup());}finally{f.close();}
});

test('uncertain and failed dialogue sends stay separate from acquisition success',()=>{
 for(const status of ['unknown','failed']){const x=resultFixture(),{f}=x;try{x.observe(x.items()[0]);recordedDialogue(x,x.reply(x.items()[0]),status);const a=x.result().arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(a.acceptedMessages,1);assert.equal(a.dialogueAcceptedMessages,0);assert.equal(a.dialogueFailedMessages,status==='failed'?1:0);assert.equal(a.dialogueUnresolvedMessages,status==='unknown'?1:0);validateBackup(f.s.exportBackup());}finally{f.close();}}
});

test('broken or foreign dialogue lineage is visible and cannot be guessed into an experiment',()=>{
 for(const mode of ['missing','mailbox','recipient','thread','foreign','cycle']){const x=resultFixture(),{f}=x;try{x.observe(x.items()[0]);const d=recordedDialogue(x,x.reply(x.items()[0])),reply=x.reply(d),e=f.s.db.prepare("SELECT * FROM events WHERE id=? AND type='DIALOGUE_RESERVED'").get(d.id)!,body=JSON.parse(String(e.text));if(mode==='missing')body.incomingId=randomUUID();if(mode==='mailbox')body.mailboxId=randomUUID();if(mode==='recipient')body.recipient='foreign@example.com';if(mode==='thread')body.threadId='wrong';if(mode==='cycle'){body.incomingId=f.s.db.prepare('SELECT sourceId FROM evidence_events WHERE id=?').get(reply)!.sourceId;body.threadId=f.s.db.prepare('SELECT threadId FROM incoming WHERE id=?').get(body.incomingId)!.threadId;}f.s.db.prepare('UPDATE events SET text=?,clientId=? WHERE id=?').run(JSON.stringify(body),mode==='foreign'?f.b:f.a,d.id);
 const result=x.result();assert.equal(result.arms.find(a=>a.hypothesisId===f.ha.id)!.dialogueAcceptedMessages,0);assert.ok(result.unattributed.some(e=>e.eventId===reply));assert.ok(!result.observations.some(e=>e.eventId===reply));
 }finally{f.close();}}
});

test('model findings are provisional, deduplicated, and removed from their bucket by human corrections',()=>{
 const x=resultFixture(),{f}=x;try{const item=x.items()[0];x.observe(item);const one=x.reply(item),two=x.reply(item);x.assess(one,{meetingIntent:'yes'},true);x.assess(two,{},true);const arm=()=>x.result().arms.find(a=>a.hypothesisId===f.ha.id)!;
 assert.equal(arm().positiveCompanies,0);assert.equal(arm().modelPositiveCompanies,1);assert.equal(arm().modelPositiveContacts,1);assert.equal(arm().modelPositiveRate.numerator,1);assert.equal(arm().modelMeetingIntentCompanies,1);x.assess(one,{replyType:'rejection'});assert.equal(arm().modelMeetingIntentCompanies,0);x.assess(two,{withdrawn:true},true);assert.equal(arm().modelPositiveCompanies,0);x.assess(two,{requiresHumanReview:true},true);assert.equal(arm().modelPositiveCompanies,0);x.assess(two);assert.equal(arm().positiveCompanies,1);assert.equal(arm().modelPositiveCompanies,0);
 }finally{f.close();}
});

test('unattributed customer records are disclosed without contaminating counts and attribution rejects foreign evidence',()=>{
 const x=resultFixture(),{f}=x;try{const before=f.s.exportBackup().data,result=x.result();assert.ok(result.unattributed.length>0);assert.ok(result.arms.every(a=>a.acceptedCompanies===0&&a.modelPositiveRate.percent===null));const events=before.evidenceEvents!;assert.throws(()=>evidenceAttribution(f.s,f.b,events),/Fremdkunde/);const resolve=evidenceAttribution(f.s,f.a,events);assert.throws(()=>resolve({...events[0],clientId:f.b}),/Fremdkunde/);assert.deepEqual(f.s.exportBackup().data,before);}finally{f.close();}
});

function recordMeeting(x:ReturnType<typeof resultFixture>,eventId:string,meetingId:string=randomUUID(),status='booked',withdrawn=false){
 const b=meetingBasis(x.f.s,x.f.a,eventId),previous=b.rows.find(r=>r.meetingId===meetingId);
 return saveMeeting(x.f.s,x.f.a,eventId,{meetingId,expectedRevision:previous?.revision||0,eventHash:b.eventHash,reference:previous?.reference||'fixture-'+meetingId,confirmed:true,content:{status,scheduledAt:'2026-01-01T10:00:00.000Z',observedAt:new Date().toISOString(),actor:'Operator',evidence:'Private synthetic attendance note',withdrawn}}).rows.find(r=>r.meetingId===meetingId)!;
}
test('meeting results deduplicate companies and identities across corrections, cancellations and withdrawals',()=>{
 const x=resultFixture(),{f}=x;try{const [first,second]=x.items();x.observe(first);x.observe(second);const one=x.reply(first),two=x.reply(second);x.assess(one,{meetingIntent:'yes'});const raw=f.s.exportBackup().data.evidenceEvents;
 const m1=recordMeeting(x,one),m2=recordMeeting(x,two);const arm=()=>x.result().arms.find(a=>a.hypothesisId===f.ha.id)!;
 assert.equal(arm().acceptedContacts,2);assert.equal(arm().acceptedCompanies,1);assert.equal(arm().recordedMeetings,2);assert.equal(arm().meetingCompanies,1);assert.equal(arm().meetingRate.percent,100);assert.equal(arm().attendanceUnverifiedMeetings,2);assert.equal(arm().heldConfirmedMeetings,0);
 recordMeeting(x,one,m1.meetingId,'rescheduled');assert.equal(arm().recordedMeetings,2);recordMeeting(x,one,m1.meetingId,'held_confirmed');recordMeeting(x,two,m2.meetingId,'cancelled');assert.equal(arm().heldConfirmedCompanies,1);assert.equal(arm().cancelledMeetings,1);assert.equal(arm().attendanceUnverifiedMeetings,0);assert.equal(arm().heldConfirmedRate.percent,100);
 recordMeeting(x,one,m1.meetingId,'held_confirmed',true);assert.equal(arm().heldConfirmedMeetings,0);assert.equal(arm().recordedMeetings,1);assert.equal(arm().meetingCompanies,1);assert.equal(arm().meetingIntentCompanies,1);assert.equal(arm().heldConfirmedRate.percent,0);
 const report=x.result();assert.equal(report.meetingObservations.length,2);assert.equal(report.meetingObservations.filter(m=>m.counted).length,1);assert.doesNotMatch(JSON.stringify(report),/Private synthetic attendance note|fixture-/);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);validateBackup(f.s.exportBackup());f.s.restore(f.s.exportBackup());f.reopen();assert.deepEqual(x.result().arms,report.arms);
 }finally{f.close();}
});
test('meeting on dialogue response inherits original experiment but unaccepted contacts cannot inflate outcomes',()=>{
 const x=resultFixture(),{f}=x;try{const [first,second]=x.items();x.observe(first);const d=recordedDialogue(x,x.reply(first)),reply=x.reply(d);recordMeeting(x,reply,randomUUID(),'held_confirmed');x.observe(second);recordMeeting(x,x.reply(second),randomUUID(),'no_show');f.s.db.prepare("UPDATE mail_tests SET status='unknown',updatedAt=? WHERE id=?").run(new Date().toISOString(),second.id);const report=x.result(),a=report.arms.find(a=>a.hypothesisId===f.ha.id)!;
 assert.equal(a.acceptedCompanies,1);assert.equal(a.recordedMeetings,1);assert.equal(a.heldConfirmedCompanies,1);assert.equal(a.meetingsWithoutAcceptedContact,1);assert.equal(a.noShowMeetings,0);assert.equal(a.heldConfirmedRate.percent,100);assert.equal(report.meetingObservations.find(m=>m.eventId===reply)!.attribution.rootMailId,first.id);assert.equal(report.meetingObservations.find(m=>m.eventId===reply)!.attribution.kind,'dialogue');
 }finally{f.close();}
});

test('customer report uses the displayed snapshot, exact rates and a matching digest without private evidence',async()=>{
 const x=resultFixture(true),{f}=x;try{const [first,follow,second]=x.items();x.observe(first);x.observe(follow);x.observe(second);const event=x.reply(first);x.assess(event);recordMeeting(x,event,randomUUID(),'held_confirmed');const source=x.result(),before=f.s.exportBackup().data,bundle=await buildCustomerReport(source),arm=bundle.data.arms.find(a=>a.hypothesis===source.arms.find(a=>a.hypothesisId===f.ha.id)!.name)!;
 assert.equal(arm.metrics.find(m=>m.key==='acceptedMessages')!.value,3);assert.equal(arm.metrics.find(m=>m.key==='acceptedCompanies')!.value,1);assert.equal(arm.rates.find(m=>m.key==='positiveRate')!.percent,100);assert.equal(arm.rates.find(m=>m.key==='heldConfirmedRate')!.numerator,1);assert.equal(bundle.data.generatedAt,source.generatedAt);
 assert.equal(bundle.digest,createHash('sha256').update(JSON.stringify(bundle.data)).digest('hex'));assert.deepEqual(JSON.parse(bundle.json),{data:bundle.data,sha256:bundle.digest});assert.ok(bundle.html.includes(bundle.digest));assert.deepEqual(await buildCustomerReport(source),bundle);assert.deepEqual(f.s.exportBackup().data,before);
 for(const privateText of [event,f.a,f.p,String(first.id),String(first.recipient),'Private excerpt excluded','Private rationale excluded','Private synthetic attendance note'])assert.ok(!bundle.html.includes(privateText)&&!bundle.json.includes(privateText),privateText);
 x.assess(event,{withdrawn:true});assert.equal(customerReportData(x.result()).arms.find(a=>a.hypothesis===source.arms.find(a=>a.hypothesisId===f.ha.id)!.name)!.rates.find(m=>m.key==='positiveRate')!.numerator,0);assert.equal(arm.rates.find(m=>m.key==='positiveRate')!.numerator,1,'downloaded snapshot cannot change retrospectively');
 }finally{f.close();}
});
test('customer report keeps missing denominators and unavailable signals distinct from measured zero',async()=>{
 const x=resultFixture();try{const b=await buildCustomerReport(x.result());assert.ok(b.data.arms.every(a=>a.rates.every(r=>r.percent===null)));assert.match(b.html,/Nicht berechenbar · Nenner 0/);assert.match(b.html,/Technische Pixelabrufe/);assert.match(b.html,/Dafür wird keine Nullquote/);assert.match(b.html,/separates einheitliches Zeitfenster/);assert.match(b.html,/keinen Gewinner/);assert.equal(b.data.dataQuality.unattributedCustomerObservations,x.result().unattributed.length);}finally{x.f.close();}
});
test('customer HTML escapes hostile metadata, has no active content and exports only its allowlist',async()=>{
 const x=resultFixture();try{const r=x.result(),injection='</title><script>alert("test")</script><img src="https://invalid.example/track"> & \'quoted\'';r.name=injection;r.clientName=injection;r.productName=injection;r.arms[0].personaName=injection;r.arms[0].angle=injection;r.warnings.push(injection);r.methodology.push(injection);(r as any).credential='DO-NOT-EXPORT-CREDENTIAL';(r.arms[0] as any).email='DO-NOT-EXPORT-ADDRESS';const b=await buildCustomerReport(r);assert.ok(b.html.includes('&lt;script&gt;'));assert.ok(b.html.includes('&amp;'));assert.doesNotMatch(b.html,/<script|<img|<iframe|<a[ >]|<[^>]*\s(?:href|src)=/i);assert.match(b.html,/default-src 'none'/);assert.match(b.html,/style-src 'unsafe-inline'/);assert.ok(!b.html.includes(injection));assert.doesNotMatch(b.json+b.html,/DO-NOT-EXPORT/);assert.equal(JSON.parse(b.json).data.experiment,injection);}finally{x.f.close();}
});
test('customer report refuses unsupported or contradictory result data',async()=>{
 const x=resultFixture();try{for(const mutate of [(r:any)=>r.calculationVersion='invented',(r:any)=>r.arms[0].acceptedCompanies=-1,(r:any)=>r.arms[0].positiveRate={numerator:2,denominator:1,percent:200},(r:any)=>r.arms[0].positiveRate={numerator:0,denominator:0,percent:0},(r:any)=>r.generatedAt='not a date',(r:any)=>r.arms[0].personaName={},(r:any)=>r.arms=[],(r:any)=>r.signalComparison.windowDays=8,(r:any)=>r.signalComparison.arms.reverse(),(r:any)=>r.signalComparison.arms[0].opens=-1,(r:any)=>r.signalComparison.arms[0].opens=10]){const r=x.result();mutate(r);await assert.rejects(()=>buildCustomerReport(r));}}finally{x.f.close();}
});
test('report names come from the fixed product and persona versions, not later edits',()=>{
 const x=resultFixture(),{f}=x;try{const before=x.result();f.save(f.input('persona',{...persona,name:'Later persona'},f.pa.entityId));saveProduct(f.s,f.a,f.p,{...product,name:'Later product'},1);const after=x.result();assert.equal(after.clientName,'A');assert.equal(after.productName,product.name);assert.ok(after.arms.every(a=>a.personaName===persona.name));assert.deepEqual(after.arms,before.arms);const data=customerReportData(after);assert.equal(data.product,product.name);assert.ok(data.arms.every(a=>a.persona===persona.name));}finally{f.close();}
});


test('signal source traces fixed campaign and dialogue lineage while experiment outcome counts remain unchanged',()=>{
 const x=resultFixture(),{f}=x;try{const first=x.items()[0];x.observe(first);const dialogue=recordedDialogue(x,x.reply(first)),raw=f.s.exportBackup().data.evidenceEvents!,before=x.result();
 for(const [index,mailId] of [first.id,dialogue.id].entries()){const event=raw.find(e=>e.sourceId===mailId&&JSON.parse(e.payload).status==='sent')!,basis=signalBasis(f.s,f.a,event.id),at=new Date().toISOString(),input={actor:'Synthetic operator',eventHash:basis.eventHash,file:{format:'eiz-signal-import',version:1,source:{provider:'synthetic',stream:'campaign'},message:basis.message,events:[{externalId:'signal-'+index,kind:'open',occurredAt:at,capturedAt:at,linkId:null,flags:[]}]}};const p=previewSignals(f.s,f.a,event.id,input);importSignals(f.s,f.a,event.id,{...input,digest:p.digest,confirmed:true});}
 const report=signalOverview(f.s,f.a);assert.equal(report.rows.length,2);assert.deepEqual(report.rows.map(r=>r.attribution!.kind).sort(),['campaign','dialogue']);assert.ok(report.rows.every(r=>r.attribution!.rootMailId===first.id&&r.attribution!.context!.productId===f.p&&r.attribution!.context!.campaignId===x.runs[0].campaignId));assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);assert.deepEqual(x.result().arms,before.arms);assert.equal(x.result().signalComparison.observations.length,1,'dialogue signals do not enter the campaign comparison');validateBackup(f.s.exportBackup());
 }finally{f.close();}
});

function importExperimentSignals(x:ReturnType<typeof resultFixture>,mailId:string,events:any[],stream='synthetic',relay=false){
 const {f}=x,event=f.s.db.prepare("SELECT id FROM evidence_events WHERE sourceId=? AND source='mail_tests' AND json_extract(payload,'$.status')='sent' ORDER BY sourceRevision LIMIT 1").get(mailId)!;
 const basis=signalBasis(f.s,f.a,String(event.id)),file={format:'eiz-signal-import' as const,version:1 as const,source:{provider:relay?'eiz-relay-v1':'synthetic',stream},message:basis.message,events};
 if(relay){const identity={baseURL:'https://relay.example.com',stream:randomUUID(),instanceId:randomUUID()},messageRef=randomUUID();bindRelay(f.s,f.a,{stream:identity.stream,messageRef,eventId:basis.eventId,eventHash:basis.eventHash,actor:'Synthetic',confirmed:true});configureRelay(f.s,f.a,{identity,enabled:true,clientVersion:f.s.client(f.a).version});const context=relayContext(f.s,f.a,{identity}),rows=events.map(({externalId,...event},i)=>({...event,id:randomUUID(),messageRef,cursor:i+1}));acceptRelayPage(f.s,f.a,{identity,revision:context.revision,page:{format:'eiz-relay-page',version:1,stream:identity.stream,instanceId:identity.instanceId,after:0,through:rows.length,next:rows.length,complete:true,rows}});return;}
 const input={eventHash:basis.eventHash,actor:'Synthetic operator',file},preview=previewSignals(f.s,f.a,basis.eventId,input);importSignals(f.s,f.a,basis.eventId,{...input,digest:preview.digest,confirmed:true});
}
const signalAt=(externalId:string,occurredAt:string,kind='open',flags:string[]=[])=>({externalId,occurredAt,capturedAt:occurredAt,kind,flags,linkId:kind==='click'?'link-1':null});

test('signal comparison joins fixed arms, uses half-open windows and preserves journal and previous outcomes',()=>{
 const x=resultFixture(),{f}=x;try{
  const a=x.items()[0],b=x.items(1)[0],start='2024-01-01T00:00:00.000Z';x.observe(a,'sent',start);x.observe(b,'sent',start);
  importExperimentSignals(x,String(a.id),[signalAt('at-start',start),signalAt('second','2024-01-02T01:00:00.000Z'),signalAt('third','2024-01-03T01:00:00.000Z'),signalAt('same-time','2024-01-03T01:00:00.000Z'),signalAt('click','2024-01-04T00:00:00.000Z','click'),signalAt('proxy','2024-01-05T00:00:00.000Z','open',['proxy']),signalAt('before','2023-12-31T23:59:59.999Z'),signalAt('at-end','2024-01-08T00:00:00.000Z')]);
  importExperimentSignals(x,String(b.id),[signalAt('other-arm','2024-01-02T00:00:00.000Z')]);
  const before=f.s.exportBackup().data,r=x.result(),a1=r.signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!,a2=r.signalComparison.arms.find(a=>a.hypothesisId===f.ha2.id)!;
  assert.equal(a1.opens,5);assert.equal(a1.clicks,1);assert.equal(a1.flaggedSignals,1);assert.equal(a1.unflaggedSignals,5);assert.equal(a1.repeatedOpenMessages,1);assert.equal(a1.observedCompanies,1);assert.equal(a1.withoutRegistration,1);assert.equal(a1.excludedSignals,2);assert.equal(a2.opens,1);assert.equal(a2.repeatedOpenMessages,0);assert.equal(r.signalComparison.excluded.length,2);assert.equal(r.signalComparison.observations.filter(o=>o.status==='counted').length,7);assert.deepEqual(f.s.exportBackup().data,before);
  const longer=experimentResults(f.s,f.a,f.p,x.o.plan.experimentId,14);assert.equal(longer.signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.opens,6);assert.equal(longer.signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.excludedSignals,1);assert.deepEqual(longer.arms,r.arms);
  const compact=customerReportData(r);assert.equal(compact.signalComparison.arms[r.arms.findIndex(a=>a.hypothesisId===f.ha.id)].metrics.find(m=>m.key==='opens')!.value,5);assert.ok(!JSON.stringify(compact).includes(String(a.id)));assert.ok(!JSON.stringify(compact).includes(r.signalComparison.excluded[0].signalId));
 }finally{f.close();}
});

test('signal withdrawal, duplicate IDs and separate sources cannot invent a repeated-open pattern',()=>{
 const x=resultFixture(),{f}=x;try{const a=x.items()[0];x.observe(a,'sent','2024-01-01T00:00:00.000Z');const one=[signalAt('a','2024-01-02T00:00:00.000Z'),signalAt('b','2024-01-02T00:00:00.000Z')];importExperimentSignals(x,String(a.id),one);importExperimentSignals(x,String(a.id),one);importExperimentSignals(x,String(a.id),[signalAt('c','2024-01-03T00:00:00.000Z'),signalAt('d','2024-01-04T00:00:00.000Z')],'other',true);
  let arm=x.result().signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.opens,4);assert.equal(arm.repeatedOpenMessages,0);assert.equal(arm.importedSignals,2);assert.equal(arm.relaySignals,2);
  const id=signalOverview(f.s,f.a).rows.find(r=>r.origin==='relay_pull'&&r.signal.occurredAt==='2024-01-03T00:00:00.000Z')!.id;withdrawSignal(f.s,f.a,id,{confirmed:true,actor:'Synthetic',reason:'Source corrected'});arm=x.result().signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.opens,3);assert.equal(arm.withdrawnSignals,1);assert.equal(signalOverview(f.s,f.a).rows.length,4);
  const saved=x.result().signalComparison;validateBackup(f.s.exportBackup());f.s.restore(f.s.exportBackup());f.reopen();assert.deepEqual(x.result().signalComparison,saved);
 }finally{f.close();}
});

test('first accepted evidence anchors signal windows across later status observations; recent mail stays pending',()=>{
 const x=resultFixture(),{f}=x;try{const [a,b]=x.items();x.observe(a,'sent','2024-01-01T00:00:00.000Z');importExperimentSignals(x,String(a.id),[signalAt('one','2024-01-02T00:00:00.000Z')]);f.s.db.prepare('UPDATE mail_tests SET result=?,updatedAt=? WHERE id=?').run('Later reconciliation',new Date().toISOString(),a.id);x.observe(b);const arm=x.result().signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.acceptedMessages,2);assert.equal(arm.matureMessages,1);assert.equal(arm.pendingMessages,1);assert.equal(arm.opens,1);
  const first=signalOverview(f.s,f.a).rows[0].eventId,mail={eventId:first,mailId:String(a.id),hypothesisId:f.ha.id,contactId:'person',accountId:'company',acceptedAt:'2024-01-01T00:00:00.000Z'};
  assert.equal(experimentSignals(f.s,f.a,[f.ha.id],[mail],'2024-01-07T23:59:59.999Z').arms[0].pendingMessages,1);
  assert.equal(experimentSignals(f.s,f.a,[f.ha.id],[mail],'2024-01-08T00:00:00.000Z').arms[0].matureMessages,1);
  assert.equal(experimentSignals(f.s,f.a,[f.ha.id],[{...mail,acceptedAt:'2099-01-01T00:00:00.000Z'}],new Date().toISOString()).arms[0].invalidTimeMessages,1);
 }finally{f.close();}
});

test('registration proof and absent signals remain distinct from missing tracking and truncated lifetime',()=>{
 const x=resultFixture(),{f}=x;try{
  const [a,b]=x.items();x.observe(a,'sending');x.observe(b,'sent','2024-01-01T00:00:00.000Z');configureTracking(f.s,f.a,{identity:{baseURL:'https://tracking.example.com',stream:randomUUID(),instanceId:randomUUID()},enabled:true,hosts:[],clientVersion:f.s.client(f.a).version});const plan=prepareTracking(f.s,f.a,{mailId:a.id})!;
  registeredTracking(f.s,f.a,{mailId:a.id,planHash:trackingHash(plan)});f.s.db.prepare("UPDATE mail_tests SET status='sent',providerId='registered-mail',updatedAt=? WHERE id=?").run(new Date().toISOString(),a.id);const raw=f.s.db.prepare("SELECT id,occurredAt FROM evidence_events WHERE sourceId=? AND json_extract(payload,'$.status')='sent'").get(a.id)!;
  const m={eventId:String(raw.id),mailId:String(a.id),hypothesisId:f.ha.id,contactId:'person',accountId:'company',acceptedAt:String(raw.occurredAt)},future=new Date(Date.parse(m.acceptedAt)+31*86400000).toISOString();
  let arm=experimentSignals(f.s,f.a,[f.ha.id],[m],future,30).arms[0];assert.equal(arm.registeredMessages,1);assert.equal(arm.registeredWithoutSignal,1);assert.equal(arm.observedMessages,0);assert.equal(experimentSignals(f.s,f.a,[f.ha.id],[{...m,acceptedAt:new Date(Date.parse(plan.registrations[0].expiresAt)-29*86400000).toISOString()}],future,30).arms[0].expiresBeforeWindowEnd,1);assert.equal(arm.clickEnabledMessages,0);
  const company=experimentSignals(f.s,f.a,[f.ha.id],[m],future,30).companyComparison.arms[0];assert.equal(company.registeredMessages,1);assert.equal(company.registeredWithoutSignal,1);assert.equal(company.matureCompanies,1);
  arm=experimentSignals(f.s,f.a,[f.ha.id],[{...m,mailId:String(b.id)}],future,30).arms[0];assert.equal(arm.registeredMessages,0);assert.equal(arm.withoutRegistration,1);
  const json=JSON.stringify(x.result());assert.ok(!json.includes(plan.registrations[0].token));assert.ok(!json.includes('https://tracking.example.com'));
 }finally{f.close();}
});

test('signal window API rejects unsupported values and returns requested scope',async()=>{
 const x=resultFixture(),{f}=x,token='e'.repeat(64),server=await startServer(f.s,token,600000),path=`/api/clients/${f.a}/products/${f.p}/experiments/${x.o.plan.experimentId}/results`,headers={Authorization:'Bearer '+token};try{
  for(const invalid of ['0','8','NaN','Infinity','-7',''])assert.equal((await fetch(server.url+path+'?signalDays='+invalid,{headers})).status,400);
  const r=await(await fetch(server.url+path+'?signalDays=30',{headers})).json();assert.equal(r.signalComparison.windowDays,30);assert.equal(r.calculationVersion,'experiment-results-v8');assert.throws(()=>experimentResults(f.s,f.a,f.p,x.o.plan.experimentId,1));
 }finally{await server.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('company response windows use historical allocation and current reviews without changing totals or raw evidence',async()=>{
 const x=resultFixture(true),{f}=x;try{
  const [first,follow,second]=x.items();x.observe(first,'sent','2024-01-01T00:00:00.000Z');x.observe(follow,'sent','2024-01-05T00:00:00.000Z');x.observe(second,'sent','2024-01-06T00:00:00.000Z');
  const a=x.reply(first,'reply',randomUUID(),'2024-01-02T00:00:00.000Z'),early=x.reply(second,'reply',randomUUID(),'2024-01-05T00:00:00.000Z'),late=x.reply(second,'reply',randomUUID(),'2024-01-08T00:00:00.000Z');for(const event of [a,early,late])x.assess(event,{meetingIntent:'yes'});
  const before=f.s.exportBackup().data,r=x.result(),arm=r.responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.contactedCompanies,1);assert.equal(arm.matureCompanies,1);assert.equal(arm.incomingMessages,1);assert.equal(arm.excludedMessages,2);assert.equal(arm.positiveRate.percent,100);assert.deepEqual(f.s.exportBackup().data,before);
  const longer=experimentResults(f.s,f.a,f.p,x.o.plan.experimentId,14);assert.equal(longer.responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.incomingMessages,2);assert.deepEqual(longer.arms,r.arms);
  const bundle=await buildCustomerReport(r);assert.equal(bundle.data.responseComparison.windowDays,7);assert.ok(bundle.html.includes('Antwortvergleich'));for(const id of [a,first.id,f.a,r.responseComparison.companies[0].accountId])assert.ok(!bundle.html.includes(String(id))&&!bundle.json.includes(String(id)));
  linkAccount(f.s,f.a,String(first.leadId),null,1);assert.deepEqual(x.result().responseComparison,r.responseComparison);
  validateBackup(f.s.exportBackup());f.s.restore(f.s.exportBackup());f.reopen();assert.deepEqual(x.result().responseComparison,r.responseComparison);
 }finally{f.close();}
});

test('company-window reports reflect late human correction and withdrawal while preserving a downloaded snapshot',()=>{
 const x=resultFixture(),{f}=x;try{const first=x.items()[0];x.observe(first,'sent','2024-01-01T00:00:00.000Z');const id=x.reply(first,'reply',randomUUID(),'2024-01-02T00:00:00.000Z'),raw=f.s.exportBackup().data.evidenceEvents;
  const arm=()=>x.result().responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;
  x.assess(id,{meetingIntent:'yes'},true);assert.equal(arm().modelPositiveCompanies,1);assert.equal(arm().positiveCompanies,0);assert.equal(arm().unreviewedMessages,1);
  x.assess(id,{meetingIntent:'yes'});const saved=x.result();assert.equal(arm().positiveCompanies,1);assert.equal(arm().meetingIntentCompanies,1);assert.equal(saved.responseComparison.observations[0].assessmentRevision,2);
  x.assess(id,{withdrawn:true});assert.equal(arm().positiveCompanies,0);assert.equal(arm().unreviewedMessages,1);assert.equal(saved.responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.positiveCompanies,1);
  x.assess(id,{replyType:'out_of_office'});assert.equal(arm().automaticMessages,1);assert.equal(arm().humanReplyCompanies,0);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);
 }finally{f.close();}
});

test('customer response-window exports reject incoherent counters, denominators and scopes',()=>{
 const x=resultFixture();try{for(const mutate of [(r:any)=>r.responseComparison.windowDays=14,(r:any)=>r.responseComparison.arms.reverse(),(r:any)=>r.responseComparison.arms[0].matureCompanies=1,(r:any)=>r.responseComparison.arms[0].incomingMessages=-1,(r:any)=>r.responseComparison.arms[0].positiveRate={numerator:0,denominator:1,percent:0}]){const r=x.result();mutate(r);assert.throws(()=>customerReportData(r));}}finally{x.f.close();}
});

test('company windows count replies through the recorded dialogue chain without expanding acquisition denominators',t=>{
 const x=resultFixture(),{f}=x;try{
  const [first,unconfirmed]=x.items(),now=Date.now();x.observe(first,'sent',new Date(now-10*86400000).toISOString());
  const root=x.reply(first,'reply',randomUUID(),new Date(now-9*86400000).toISOString());x.assess(root);const dialogue=recordedDialogue(x,root),follow=x.reply(dialogue);x.assess(follow,{meetingIntent:'yes'});x.observe(unconfirmed,'unknown');
  t.mock.timers.enable({apis:['Date'],now:now+21*86400000});
  const r=experimentResults(f.s,f.a,f.p,x.o.plan.experimentId,30),a=r.responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;
  assert.equal(a.contactedCompanies,1);assert.equal(a.matureCompanies,1);assert.equal(a.incomingMessages,2);assert.equal(a.humanReplyCompanies,1);assert.equal(a.meetingIntentCompanies,1);assert.ok(r.responseComparison.observations.some(o=>o.eventId===follow&&o.counted));assert.equal(r.observations.find(o=>o.eventId===follow)!.attribution.kind,'dialogue');
 }finally{t.mock.timers.reset();f.close();}
});

function windowMeeting(x:ReturnType<typeof resultFixture>,eventId:string,meetingId:string,patch:any={}){
 const {f}=x,basis=meetingBasis(f.s,f.a,eventId),previous=basis.rows.find(r=>r.meetingId===meetingId);
 return saveMeeting(f.s,f.a,eventId,{meetingId,expectedRevision:previous?.revision||0,eventHash:basis.eventHash,reference:'synthetic-window-'+meetingId,confirmed:true,content:{status:'booked',scheduledAt:'2024-01-03T00:00:00.000Z',observedAt:'2024-01-02T00:00:00.000Z',actor:'Synthetic operator',evidence:'Private window meeting evidence',withdrawn:false,...patch}});
}

test('meeting comparison uses latest revisions, fixed companies and identical response denominators through restore',async()=>{
 const x=resultFixture(),{f}=x;try{
  const [a,b]=x.items();x.observe(a,'sent','2024-01-01T00:00:00.000Z');x.observe(b,'sent','2024-01-01T00:00:00.000Z');const event=x.reply(a,'reply',randomUUID(),'2024-01-02T00:00:00.000Z'),other=x.reply(b,'reply',randomUUID(),'2024-01-02T00:00:00.000Z'),one=randomUUID(),two=randomUUID();windowMeeting(x,event,one);windowMeeting(x,other,two,{status:'cancelled'});
  const arm=()=>x.result().meetingComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm().recordedMeetings,2);assert.equal(arm().meetingCompanies,1);assert.equal(arm().attendanceUnverifiedMeetings,1);assert.equal(arm().heldConfirmedMeetings,0);
  windowMeeting(x,event,one,{status:'held_confirmed',observedAt:'2024-02-01T00:00:00.000Z'});assert.equal(arm().heldConfirmedCompanies,1);const saved=x.result();assert.equal(saved.meetingComparison.observations.find(m=>m.meetingId===one)!.revision,2);assert.equal(arm().matureCompanies,saved.responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.matureCompanies);
  const report=await buildCustomerReport(saved);assert.equal(report.data.meetingComparison.windowDays,7);assert.ok(report.html.includes('Terminvergleich'));for(const privateValue of [one,event,String(a.recipient),'Private window meeting evidence',f.a])assert.ok(!report.json.includes(privateValue)&&!report.html.includes(privateValue));
  const raw=f.s.exportBackup().data.evidenceEvents;windowMeeting(x,event,one,{status:'rescheduled',scheduledAt:'2024-01-09T00:00:00.000Z'});assert.equal(arm().recordedMeetings,1);assert.equal(arm().excludedMeetings,1);assert.equal(saved.meetingComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.heldConfirmedMeetings,1);
  windowMeeting(x,event,one,{status:'held_confirmed',observedAt:'2024-02-01T00:00:00.000Z',withdrawn:true});assert.equal(arm().withdrawnMeetings,1);assert.equal(arm().heldConfirmedMeetings,0);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);
  const before=x.result().meetingComparison;validateBackup(f.s.exportBackup());f.s.restore(f.s.exportBackup());f.reopen();assert.deepEqual(x.result().meetingComparison,before);
 }finally{f.close();}
});

test('meeting window can expand without changing all-history outcomes or manufacturing booked-at metrics',()=>{
 const x=resultFixture(),{f}=x;try{const a=x.items()[0];x.observe(a,'sent','2024-01-01T00:00:00.000Z');const event=x.reply(a,'reply',randomUUID(),'2024-01-02T00:00:00.000Z');windowMeeting(x,event,randomUUID(),{scheduledAt:'2024-01-08T00:00:00.000Z',status:'no_show',observedAt:'2024-01-08T01:00:00.000Z'});
  const short=x.result(),long=experimentResults(f.s,f.a,f.p,x.o.plan.experimentId,14),get=(r:typeof short)=>r.meetingComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;
  assert.equal(get(short).excludedMeetings,1);assert.equal(get(long).noShowMeetings,1);assert.equal(get(long).heldConfirmedMeetings,0);assert.deepEqual(short.arms,long.arms);assert.equal(long.meetingComparison.windowDays,long.responseComparison.windowDays);
 }finally{f.close();}
});

test('customer meeting-window export rejects different denominators, conflicting statuses and incorrect rates',()=>{
 const x=resultFixture();try{for(const mutate of [(r:any)=>r.meetingComparison.windowDays=14,(r:any)=>r.meetingComparison.arms.reverse(),(r:any)=>r.meetingComparison.arms[0].matureCompanies=1,(r:any)=>r.meetingComparison.arms[0].recordedMeetings=1,(r:any)=>r.meetingComparison.arms[0].heldConfirmedRate={numerator:0,denominator:1,percent:0},(r:any)=>r.meetingComparison.arms[0].withdrawnMeetings=-1]){const r=x.result();mutate(r);assert.throws(()=>customerReportData(r));}}finally{x.f.close();}
});


test('company signals share response windows while preserving the separate message comparison and private evidence',async()=>{
 const x=resultFixture(),{f}=x;try{
  const [a,b]=x.items();x.observe(a,'sent','2024-01-01T00:00:00.000Z');x.observe(b,'sent','2024-01-07T00:00:00.000Z');
  importExperimentSignals(x,String(a.id),[signalAt('one','2024-01-02T00:00:00.000Z'),signalAt('two','2024-01-03T00:00:00.000Z'),signalAt('three','2024-01-04T00:00:00.000Z')]);
  importExperimentSignals(x,String(b.id),[signalAt('inside','2024-01-07T23:59:59.999Z'),signalAt('outside','2024-01-08T00:00:00.000Z')]);
  const raw=f.s.exportBackup().data,r=x.result(),arm=r.companySignalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;
  assert.equal(arm.opens,4);assert.equal(arm.observedCompanies,1);assert.equal(arm.messagesInWindow,2);assert.equal(arm.repeatedOpenCompanies,1);assert.equal(arm.matureCompanies,r.responseComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.matureCompanies);assert.equal(r.signalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.opens,5);
  const exported=await buildCustomerReport(r);assert.equal(exported.data.version,5);assert.ok(exported.html.includes('Unternehmenssignale'));for(const privateValue of [f.a,String(a.id),r.companySignalComparison.observations[0].signalId])assert.ok(!exported.json.includes(privateValue));assert.deepEqual(f.s.exportBackup().data,raw);
  const long=experimentResults(f.s,f.a,f.p,x.o.plan.experimentId,14);assert.equal(long.companySignalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.opens,5);assert.deepEqual(long.arms,r.arms);
 }finally{f.close();}
});

test('company signal withdrawal and restoration preserve journal identity and deduplicate imports',()=>{
 const x=resultFixture(),{f}=x;try{const a=x.items()[0];x.observe(a,'sent','2024-01-01T00:00:00.000Z');const events=[signalAt('one','2024-01-02T00:00:00.000Z')];importExperimentSignals(x,String(a.id),events);importExperimentSignals(x,String(a.id),events);let r=x.result();assert.equal(r.companySignalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!.opens,1);
  const raw=f.s.exportBackup().data.evidenceEvents;withdrawSignal(f.s,f.a,r.companySignalComparison.observations[0].signalId,{confirmed:true,actor:'Synthetic',reason:'Source corrected'});r=x.result();const arm=r.companySignalComparison.arms.find(a=>a.hypothesisId===f.ha.id)!;assert.equal(arm.opens,0);assert.equal(arm.withdrawnSignals,1);assert.deepEqual(f.s.exportBackup().data.evidenceEvents,raw);validateBackup(f.s.exportBackup());f.s.restore(f.s.exportBackup());f.reopen();assert.deepEqual(x.result().companySignalComparison,r.companySignalComparison);
 }finally{f.close();}
});

test('customer company signals reject inconsistent scope, coverage and observed company counters',()=>{
 const x=resultFixture();try{for(const mutate of [(r:any)=>r.companySignalComparison.windowDays=14,(r:any)=>r.companySignalComparison.arms.reverse(),(r:any)=>r.companySignalComparison.arms[0].matureCompanies=1,(r:any)=>r.companySignalComparison.arms[0].registeredMessages=1,(r:any)=>r.companySignalComparison.arms[0].opens=1,(r:any)=>r.companySignalComparison.arms[0].observedCompanies=1,(r:any)=>r.companySignalComparison.arms[0].repeatedOpenCompanies=1,(r:any)=>r.companySignalComparison.arms[0].withdrawnSignals=-1]){const r=x.result();mutate(r);assert.throws(()=>customerReportData(r));}}finally{x.f.close();}
});

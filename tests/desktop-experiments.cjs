const assert=require('node:assert/strict');
const {writeFileSync,readFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkExperiments=async(win,dataDir,js,until,click,url,headers,clientId)=>{
  // Readiness travels across Electron IPC: return a boolean, never a DOM node.
  const rawUntil=until;until=code=>rawUntil(`Boolean(${code})`);
  const rawJs=js;js=async code=>{try{return await rawJs(code);}catch(error){writeFileSync(join(dataDir,'experiment-failed-expression.txt'),code);throw error;}};
  const api=async(path,body)=>{const r=await fetch(url+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
  const base=`/api/clients/${clientId}`,product=await api(base+'/catalog',{kind:'product',id:null,expectedRevision:0,value:{name:'Experimentprodukt',description:'Synthetic CSV product',website:'',bookingUrl:'',archived:false}}),path=base+`/products/${product.productId}`;
  const meta={entityId:null,expectedRevision:0,productRevision:1,action:'save',actor:'Smoke',reason:'Synthetic experiment'};
  const source=await api(path+'/knowledge',{...meta,kind:'source',content:{title:'Synthetic',locator:'Test source',capturedAt:'2026-10-01T00:00:00.000Z',text:'The product exports CSV.',withdrawn:false}});
  const claim={category:'feature',text:'CSV export',sourceId:source.id,quote:'The product exports CSV.'},draft=await api(path+'/knowledge',{...meta,kind:'claim',content:claim}),fact=await api(path+'/knowledge',{...meta,kind:'claim',content:claim,entityId:draft.entityId,expectedRevision:1,action:'approve'});
  const persona={code:'IT',name:'IT-Leitung',responsibility:'Schnittstellen',titles:['Head of IT']},pd=await api(path+'/strategy',{...meta,kind:'persona',content:persona}),pa=await api(path+'/strategy',{...meta,kind:'persona',content:persona,entityId:pd.entityId,expectedRevision:1,action:'approve'});
  const hypotheses=[];
  for(const angle of ['Schnittstellen vereinfachen','Datenübergaben nachvollziehen']){const content={name:angle,personaId:pa.id,segment:'Mittelstand',pain:'Manuelle Übergaben',angle,benefit:'Relevanz prüfen',cta:'Ablauf vergleichen',style:'Direkt',knowledgeIds:[fact.id]},d=await api(path+'/strategy',{...meta,kind:'hypothesis',content});hypotheses.push(await api(path+'/strategy',{...meta,kind:'hypothesis',content,entityId:d.entityId,expectedRevision:1,action:'approve'}));}
  const csv={csv:'email;company;role\n'+Array.from({length:8},(_,i)=>`p${i}@experiment${Math.floor(i/2)}.example;Experimentfirma ${Math.floor(i/2)};Head of IT`).join('\n'),filename:'synthetic-experiments.csv',delimiter:';',mapping:{email:0,company:1,role:2,firstName:-1,lastName:-1}};
  const imported=await api(base+'/lead-preview',csv);await api(base+'/lead-import',{...csv,fingerprint:imported.fingerprint});
  const leads=(await api(base+'/campaign-leads')).filter(l=>l.email.includes('@experiment'));
  for(let i=0;i<4;i++){const a=await api(base+'/catalog',{kind:'account',id:null,expectedRevision:0,value:{name:'Experimentfirma '+i,domain:`experiment${i}.example`}});for(const lead of leads.filter(l=>l.email.endsWith(`@experiment${i}.example`)))await api(base+'/catalog',{kind:'link',id:lead.id,expectedRevision:0,value:a.accountId});}
  const client=(await api('/api/state')).clients.find(c=>c.id===clientId);
  await js(`Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.startsWith('Kunden')).click()`);await until(`document.querySelector('.client-row')`);
  await js(`Array.from(document.querySelectorAll('.client-row')).find(b=>b.querySelector('strong').textContent===${JSON.stringify(client.name)}).click()`);
  const selectProduct=async value=>js(`(()=>{const el=document.querySelector('[aria-label="Produkt auswählen"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.querySelector('[aria-label="Produkt auswählen"]')`);
  await until(`Array.from(document.querySelector('[aria-label="Produkt auswählen"]').options).some(o=>o.value==='${product.productId}')`);await selectProduct(product.productId);
  await until(`document.querySelector('[aria-label="Experimenthypothese ${hypotheses[0].id}"]')`);
  await js(`(()=>{for(const [label,value] of ${JSON.stringify([['Experimentname','Pilotvergleich IT'],['Experimentverantwortliche Person','Smoke'],['Experimentbegründung','Zwei freigegebene Angles vergleichen'],['Experimentkontakte filtern','@experiment']])}){const el=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  for(const h of hypotheses)await js(`document.querySelector('[aria-label="Experimenthypothese ${h.id}"]').click()`);
  await click('Erste 1.000 gefilterte ungesperrte Kontakte auswählen');await click('Zuteilung vorschauen');await until(`document.querySelector('.experiment-preview')?.innerText.includes('4 Unternehmen')`);
  const before=await api(base+'/campaigns');
  await js(`window.__experimentFetch=window.fetch;window.__experimentPosts=0;window.fetch=(...args)=>{if(String(args[0]).endsWith('/experiments')&&args[1]?.method==='POST')window.__experimentPosts++;return window.__experimentFetch(...args);};void 0;`);
  try{
    await js(`document.querySelector('[aria-label="Experimentplan bestätigen"]').click()`);await until(`!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Experimentplan speichern').disabled`);
    await js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Experimentplan speichern');b.click();b.click();})()`);
    await until(`document.querySelector('.experiment-panel').innerText.includes('Experimentplan dauerhaft gespeichert')`);assert.equal(await js('window.__experimentPosts'),1);
  }finally{await js(`window.fetch=window.__experimentFetch;void 0;`);}
  let saved=await api(path+'/experiments');assert.equal(saved.items.length,1);assert.equal(saved.items[0].content.allocation.groups.length,4);assert.deepEqual(await api(base+'/campaigns'),before,'planning does not mutate campaigns');
  win.show();await js(`document.querySelector('.experiment-panel').scrollIntoView({behavior:'instant',block:'start'})`);await new Promise(r=>setTimeout(r,700));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'experiments.png'),shot.toPNG());
  const boundCampaign=await require('./desktop-campaign-experiment.cjs').checkCampaignExperiment({win,dataDir,js,until,click,api,base,product,plan:saved.items[0],hypothesis:hypotheses[0],fact});
  await js(`Array.from(document.querySelectorAll('.experiment-panel details.source')).find(d=>d.querySelector('summary').textContent.includes('Pilotvergleich IT')).open=true;document.querySelector('[aria-label="Experiment schließen ${saved.items[0].experimentId}"]').click()`);
  await click('Experiment endgültig schließen');await until(`document.querySelector('.experiment-panel').innerText.includes('Experimentplan geschlossen')`);
  await click('Kampagnenvorschau prüfen');await until(`document.querySelector('.lead-preview .campaign-experiment-summary')?.innerText.includes('Geschlossen')`);
  const stopped=await api(base+`/campaigns/${boundCampaign}/preview`);assert.equal(stopped.approved,false);assert.match(stopped.problems.join(' '),/geschlossen/);
  writeFileSync(join(dataDir,'campaign-experiment-result.json'),JSON.stringify({passed:true,explicitArmAdoption:true,contactsFixed:true,textPreserved:true,hypothesisFixed:true,approvedThroughUI:true,closedPlanBlocksApproval:true,lateResponseIgnored:true,liveProvider:false},null,2));
  const target=join(dataDir,'experiment-export.json');const download=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{win.webContents.session.removeListener('will-download',handler);reject(Error('Experiment download timed out'));},15000);function handler(_e,item){item.setSavePath(target);item.once('done',(_e,status)=>{clearTimeout(timer);status==='completed'?resolve():reject(Error(status));});}win.webContents.session.once('will-download',handler);});
  await Promise.all([click('Experimentpläne als JSON herunterladen'),download]);const exported=JSON.parse(readFileSync(target,'utf8'));assert.equal(exported.rows.length,2);assert.equal(exported.rows[1].state,'closed');
  const plans=await api(path+'/experiments');assert.equal(plans.items[0].state,'closed');
  await require('./desktop-experiment-results.cjs').checkExperimentResults({win,dataDir,js,until,click,api,path,plan:plans.items[0],selectProduct});
  await selectProduct(product.productId);await until(`document.querySelector('.experiment-panel')?.innerText.includes('Pilotvergleich IT')`);
  await js(`window.__experimentFetch=window.fetch;window.fetch=(...args)=>String(args[0]).endsWith('/experiments')?new Promise(resolve=>{window.__releaseExperiment=()=>resolve(new Response(${JSON.stringify(JSON.stringify(plans))}));}):window.__experimentFetch(...args);void 0;`);
  try{await click('Experimentplanung aktualisieren');await until(`typeof window.__releaseExperiment==='function'`);await selectProduct('');await until(`!document.querySelector('.experiment-panel')`);await js(`window.__releaseExperiment();void 0;`);assert.equal(await js(`!!document.querySelector('.experiment-panel')`),false);}finally{await js(`window.fetch=window.__experimentFetch;delete window.__releaseExperiment;void 0;`);}
  writeFileSync(join(dataDir,'experiments-result.json'),JSON.stringify({passed:true,companies:4,contacts:8,arms:2,explicitPreviewAndSave:true,doubleSubmitRequests:1,closedHistoryExported:true,planningDoesNotMutateCampaigns:true,lateResponseIgnored:true,liveProvider:false},null,2));
};

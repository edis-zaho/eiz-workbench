const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkCampaignExperiment=async({win,dataDir,js,until,click,api,base,product,plan,hypothesis,fact})=>{
  // Explicit synthetic operating frame for the four contacts/two companies in an arm.
  let brief=await api(base+'/brief');brief=await api(base+'/rules',{...brief.content,rules:{...brief.content.rules,companyCap:2,dailyLimit:20},revision:brief.revision});
  const current=await api(base+'/brief');await api(base+'/approve',{revision:current.revision,clientVersion:current.clientVersion,confirmed:true});
  await until(`document.querySelector('[aria-label="Kampagnenname"]')`);
  const select=async(label,value)=>{await until(`document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]')&&!document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]').matches(':disabled')`);return js(`(()=>{const el=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
  await click('Kampagnenliste aktualisieren');
  await until(`Array.from(document.querySelector('[aria-label="Kampagnenprodukt"]').options).some(o=>o.value==='${product.productId}:1')`);
  await select('Kampagnenprodukt',product.productId+':1');
  await until(`Array.from(document.querySelector('[aria-label="Kampagnen-Testgruppe"]')?.options||[]).some(o=>o.value==='${plan.experimentId}:${hypothesis.id}')`);
  // A delayed response for a previous product must never reinsert its group selector.
  const plans=await api(base+`/products/${product.productId}/experiments`);
  await js(`window.__c2Fetch=window.fetch;window.fetch=(...args)=>String(args[0]).endsWith('/experiments')?new Promise(resolve=>{window.__c2Release=()=>resolve(new Response(${JSON.stringify(JSON.stringify(plans))}));}):window.__c2Fetch(...args);void 0;`);
  try{await click('Testgruppen aktualisieren');await until(`typeof window.__c2Release==='function'`);await select('Kampagnenprodukt','');await until(`!document.querySelector('.campaign-experiment')`);await js(`window.__c2Release();void 0;`);assert.equal(await js(`!!document.querySelector('.campaign-experiment')`),false);}finally{await js(`window.fetch=window.__c2Fetch;delete window.__c2Release;void 0;`);}
  await select('Kampagnenprodukt',product.productId+':1');
  await until(`Array.from(document.querySelector('[aria-label="Kampagnen-Testgruppe"]')?.options||[]).some(o=>o.value==='${plan.experimentId}:${hypothesis.id}')`);
  await js(`(()=>{for(const [label,value] of [['Kampagnenname','Experimentkampagne IT'],['Kampagne Betreff 1','Direkter Prozessvergleich'],['Kampagne Nachricht 1','Wie organisiert ihr heute die Datenübergabe?']]){const el=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}const date=document.querySelector('.campaign-panel input[type="date"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(date,'2099-01-01');date.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await select('Kampagnen-Testgruppe',plan.experimentId+':'+hypothesis.id);
  await click('Testgruppe in den Entwurf übernehmen');await until(`document.querySelector('.campaign-experiment').innerText.includes('4 Kontakte')`);
  assert.equal(await js(`document.querySelector('[aria-label="Kampagne Nachricht 1"]').value`),'Wie organisiert ihr heute die Datenübergabe?');
  assert.equal(await js(`document.querySelector('[aria-label="Kampagnenhypothese"]').disabled`),true);
  assert.equal(await js(`document.querySelector('[aria-label="Kampagnenprodukt"]').disabled`),true);
  assert.equal(await js(`Array.from(document.querySelectorAll('.campaign-panel input[type="checkbox"][aria-label^="Kontakt "]')).every(e=>e.matches(':disabled'))`),true);
  await click('Kampagnenentwurf speichern');await until(`document.querySelector('.campaign-panel').innerText.includes('Kampagnenentwurf gespeichert.')`);
  const saved=(await api(base+'/campaigns')).find(c=>c.content.experimentId===plan.experimentId);assert.ok(saved);
  assert.equal(saved.content.hypothesisId,hypothesis.id);assert.deepEqual([...saved.content.leadIds].sort(),plan.content.allocation.groups.filter(g=>g.hypothesisId===hypothesis.id).flatMap(g=>g.leadIds).sort());assert.deepEqual(saved.content.knowledgeIds,[fact.id]);
  assert.equal(await js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Noch ungespeicherte Experimentbindung entfernen')`),false);
  await click('Kampagnenvorschau prüfen');await until(`document.querySelector('.lead-preview .campaign-experiment-summary')?.innerText.includes('2 Unternehmen')`);
  const preview=await api(base+`/campaigns/${saved.id}/preview`);assert.equal(preview.problemCount,0,preview.problems.join(' '));
  await js(`document.querySelector('.campaign-panel .lead-preview input[type="checkbox"]').click()`);await click('Kampagnenplan freigeben');await until(`document.querySelector('.campaign-panel').innerText.includes('Kampagnenplan geprüft. Automatischer Versand bleibt deaktiviert.')`);
  assert.equal((await api(base+`/campaigns/${saved.id}/preview`)).approved,true);
  win.show();await js(`document.querySelector('.campaign-experiment').scrollIntoView({behavior:'instant',block:'start'})`);await new Promise(r=>setTimeout(r,400));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'campaign-experiment.png'),shot.toPNG());
  await require('./desktop-campaign-messaging.cjs').checkCampaignMessaging({win,dataDir,js,until,click,api,base,campaignId:saved.id});
  await require('./desktop-campaign-writing.cjs').checkCampaignWriting({win,dataDir,js,until,click,api,base,campaignId:saved.id});
  return saved.id;
};

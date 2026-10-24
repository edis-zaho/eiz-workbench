const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkCampaignWriting=async({win,dataDir,js,until,click,api,base,campaignId})=>{
 const original=global.fetch,path=base+`/campaigns/${campaignId}`,before=(await api(base+'/campaigns')).find(c=>c.id===campaignId);let calls=0;
 global.fetch=async(input,init)=>{
  if(String(input).startsWith('http://127.0.0.1:'))return original(input,init);
  assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;const b=JSON.parse(init.body),t=JSON.parse(b.input);
  assert.equal(t.promptVersion,'campaign-writing-v1');assert.equal(t.steps.length,2);assert.equal(b.text.format.type,'json_object');assert.equal(b.tools,undefined);assert.ok(!b.input.includes('leadIds'));assert.ok(!/p[0-9]@experiment/.test(b.input));
  const steps=t.steps.map((_,i)=>({subject:'Prozessfrage '+(i+1),body:'Wie nutzt ihr heute CSV bei {{unternehmen}}?',factIds:[t.facts[0].id]}));
  return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({steps})}]}],usage:{input_tokens:120,output_tokens:75}}));
 };
 const fill=async(label,value)=>js(`(()=>{const el=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 try{
  // Earlier smoke steps deliberately removed the key; this isolated fixture needs its own.
  await js(`window.workbench.saveModel({provider:'openai',key:'synthetic-campaign-writing-key',remove:false})`);
  await click('Textauftrag vorbereiten / Verlauf laden');await until(`!!document.querySelector('[aria-label="KI-Textübertragung bestätigen"]')`);
  assert.equal(await js(`Array.from(document.querySelectorAll('.campaign-writing button')).find(b=>b.textContent==='Nachrichten vorschlagen lassen').disabled`),true);
  await js(`document.querySelector('[aria-label="KI-Textübertragung bestätigen"]').click()`);
  await js(`(()=>{const b=Array.from(document.querySelectorAll('.campaign-writing button')).find(b=>b.textContent==='Nachrichten vorschlagen lassen');b.click();b.click();})()`);
  await until(`!!document.querySelector('[aria-label="KI-Text Nachricht 1"]')`);assert.equal(calls,1);
  assert.deepEqual((await api(base+'/campaigns')).find(c=>c.id===campaignId).content,before.content);
  await fill('Textprüfung Name','Pilotbetreiber');await fill('Textprüfung Begründung','Faktenbezug und Ansprache geprüft.');await fill('KI-Text Nachricht 1','Wie sieht euer CSV-Ablauf bei {{unternehmen}} aus?');
  const runs=await api(path+'/writing-runs');assert.equal(runs.length,1);
  await js(`document.querySelector('[aria-label="KI-Texte geprüft ${runs[0].id}"]').click()`);
  win.show();await js(`document.querySelector('.campaign-writing-run').scrollIntoView({behavior:'instant',block:'start'})`);await new Promise(r=>setTimeout(r,350));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'campaign-writing.png'),shot.toPNG());
  await js(`window.__writingFetch=window.fetch;window.__writingAdopts=0;window.fetch=(...args)=>{if(String(args[0]).includes('/writing-runs/')&&String(args[0]).endsWith('/adopt'))window.__writingAdopts++;return window.__writingFetch(...args);};void 0;`);
  await js(`(()=>{const b=Array.from(document.querySelectorAll('.campaign-writing button')).find(b=>b.textContent==='Geprüfte Texte in Kampagnenentwurf übernehmen');b.click();b.click();})()`);
  await until(`document.querySelector('.campaign-panel').innerText.includes('KI-Texte als Kampagnenentwurf gespeichert.')`);assert.equal(await js('window.__writingAdopts'),1);
  const after=(await api(base+'/campaigns')).find(c=>c.id===campaignId);assert.equal(after.approved,false);assert.equal(after.content.steps[0].body,'Wie sieht euer CSV-Ablauf bei {{unternehmen}} aus?');assert.deepEqual(after.content.leadIds,before.content.leadIds);assert.equal(after.content.steps[1].gapDays,before.content.steps[1].gapDays);assert.equal(after.content.hypothesisId,before.content.hypothesisId);
  await click('Textauftrag vorbereiten / Verlauf laden');await until(`document.querySelector('.campaign-writing-run')?.innerText.includes('Als Entwurf übernommen')`);
  await click('Kampagnenvorschau prüfen');await until(`!!document.querySelector('.campaign-panel .lead-preview input[type="checkbox"]')`);
  await js(`document.querySelector('.campaign-panel .lead-preview input[type="checkbox"]').click()`);await click('Kampagnenplan freigeben');await until(`document.querySelector('.campaign-panel').innerText.includes('Kampagnenplan geprüft. Automatischer Versand bleibt deaktiviert.')`);
  assert.equal((await api(path+'/preview')).approved,true);
  writeFileSync(join(dataDir,'campaign-writing-result.json'),JSON.stringify({passed:true,providerCalls:calls,doubleSubmitGuard:true,contactListExcluded:true,editableSuggestion:true,adoptionRequests:1,draftOnly:true,nonTextFieldsPreserved:true,historyRetained:true,separateApproval:true,liveProvider:false},null,2));
 }finally{global.fetch=original;await js(`if(window.__writingFetch)window.fetch=window.__writingFetch;void 0;`);await js(`window.workbench.saveModel({provider:'openai',key:'',remove:true})`);}
};

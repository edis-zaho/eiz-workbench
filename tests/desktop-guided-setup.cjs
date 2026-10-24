const assert=require('node:assert/strict');
exports.checkWorkspace=async({js,click,fill,until})=>{
 assert.equal(await js(`!!document.querySelector('[aria-label="Arbeitsbereiche"]')`),true,'customer workspace must offer focused work areas');
 assert.equal(await js(`document.querySelector('[data-area="setup"]').hidden`),false);
 assert.equal(await js(`document.querySelector('[data-area="mailbox"]').hidden`),true,'mail diagnostics must not dominate initial setup');
 await click('Produkt & Zielgruppe');
 await fill('[aria-label="Produktname"]','Unsaved product');
 await click('Gmail');
 assert.equal(await js(`document.querySelector('[data-area="product"]').hidden`),true);
 assert.equal(await js(`document.querySelector('[data-area="mailbox"]').hidden`),false);
 await click('Produkt & Zielgruppe');
 assert.equal(await js(`document.querySelector('[aria-label="Produktname"]').value`),'Unsaved product','switching work areas preserves an unfinished form');
 await click('KI und Budget einrichten');
 await until(`!!document.querySelector('[aria-label="Modellvorlage"]')`);
 assert.equal(await js(`document.querySelector('[aria-label="Produktname"]')?.checkVisibility()||false`),false,'customer forms are hidden during model setup');
 await click('← Zurück zum Arbeitsbereich');
 await until(`!!document.querySelector('[aria-label="Arbeitsbereiche"]')`);
 assert.equal(await js(`document.querySelector('[aria-label="Produktname"]').value`),'Unsaved product','model setup must preserve unsaved product input');
 assert.equal(await js(`document.querySelector('[aria-label="Produktname"]').checkVisibility()`),true,'return to the same work area');
};
exports.checkSharedModel=async({js,click,model,clientId,profile})=>{
 await click('3 · Verwenden & testen');
 await click('Dieses Modell für alle Aufgaben verwenden');
 await new Promise(r=>setTimeout(r,250));
 const state=await model('list'),routes=state.routes.find(r=>r.clientId===clientId).content.tasks;
 for(const task of ['analysis','writing','knowledge','campaign-writing','reply-analysis','reply-writing']){
  assert.equal(routes[task].id,profile.id);
  assert.equal(routes[task].revision,profile.revision);
 }
};
exports.checkTemplate=async({js,click,fill,until,model})=>{
 await click('Modelle & Kosten');
 await until(`!!document.querySelector('[aria-label="Modellvorlage"]')`);
 await fill('[aria-label="Modellvorlage"]','openai-mini');
 assert.equal(await js(`document.querySelector('[aria-label="Modellkennung"]').value`),'gpt-4.1-mini-2025-04-14');
 await click('Modellprofil speichern');
 await until(`document.body.innerText.includes('Profil gespeichert.')`);
 await js(`window.scrollTo(0,document.documentElement.scrollHeight)`);
 assert.ok(await js(`window.scrollY`)>0,'exercise the next-step button from the bottom of the form');
 await click('Weiter zum Kostenlimit');
 await until(`window.scrollY===0`);
 await click('Preisdaten der Vorlage übernehmen');
 await until(`document.body.innerText.includes('Preisdaten der Vorlage gespeichert.')`);
 const state=await model('list'),p=state.profiles.find(p=>p.binding.model==='gpt-4.1-mini-2025-04-14');
 const price=state.records.find(r=>r.kind==='price'&&r.id===p.id).content;
 assert.equal(price.bindingHash,p.binding.hash);
 assert.equal(price.inputUpperBound,1047576);
 assert.equal(price.prices.inputMicrosPerMillion,400000);
 assert.equal(price.prices.outputMicrosPerMillion,1600000);
 assert.equal(price.prices.checkedAt,'2026-10-20T00:00:00.000Z','saving a template must not falsely refresh the research date');
 assert.equal(p.credentialPresent,false,'a template does not silently acquire credentials');
 await click('Startbudget eintragen');
 await click('Budget speichern');
 await until(`document.body.innerText.includes('Budget gespeichert.')`);
 const updated=await model('list'),budget=updated.records.find(r=>r.kind==='budget'&&r.id==='USD').content;
 assert.equal(budget.perRun,1000000);
 assert.equal(budget.perDay,5000000);
 assert.equal(budget.perMonth,25000000);
};

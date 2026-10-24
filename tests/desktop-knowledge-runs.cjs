const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkKnowledgeRuns=async(win,dataDir,js,until,click,url,headers,clientId,productId,fill)=>{
  const original=global.fetch,base=`/api/clients/${clientId}/products/${productId}/knowledge-runs`;let calls=0;
  global.fetch=async(input,init)=>{
    if(String(input).startsWith('http://127.0.0.1:'))return original(input,init);
    assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;
    const body=JSON.parse(init.body),data=JSON.parse(body.input);
    assert.equal(body.text.format.type,'json_object');assert.equal(data.product.id,productId);assert.equal(data.sources.length,1);
    assert.equal(body.tools,undefined);
    return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({suggestions:[{category:'feature',text:'CSV-Daten lassen sich exportieren.',sourceId:data.sources[0].id,quote:'Das Produkt exportiert CSV.'}]})}]}],usage:{input_tokens:90,output_tokens:45}}));
  };
  try{
    await until(`Boolean(document.querySelector('.knowledge-suggestions input[type="checkbox"]')) && !document.querySelector('.knowledge-suggestions fieldset').disabled`);
    await js(`document.querySelector('[aria-label="KI-Quelle CSV Datenblatt"]').click();`);
    await js(`document.querySelector('[aria-label="KI-Quellenübertragung bestätigen"]').click();`);
    await js(`(()=>{const b=[...document.querySelectorAll('.knowledge-suggestions button')].find(x=>x.innerText==='Wissensvorschläge anfordern');b.click();b.click();})()`);
    await until(`Boolean(document.querySelector('[aria-label="KI-Aussage 1"]'))`);assert.equal(calls,1);
    await fill({'KI-Entwurf Betreiber':'Synthetic reviewer','KI-Entwurf Begründung':'Zitat geprüft, Formulierung angepasst.','KI-Aussage 1':'Ein CSV-Export ist möglich.'});
    await js(`window.__adoptFetch=window.fetch;window.__adoptCalls=0;window.fetch=(...args)=>{if(String(args[0]).endsWith('/adopt'))window.__adoptCalls++;return window.__adoptFetch(...args);};void 0;`);
    await js(`(()=>{const b=[...document.querySelectorAll('.knowledge-suggestions button')].find(x=>x.innerText==='Vorschlag 1 als Entwurf übernehmen');b.click();b.click();})()`);
    await until(`document.querySelector('.knowledge-suggestions')?.innerText.includes('Bereits als Entwurf übernommen')`);
    assert.equal(await js('window.__adoptCalls'),1);await js(`window.fetch=window.__adoptFetch;void 0;`);
    const runs=await(await original(url+base,{headers})).json(),knowledge=await(await original(url+`/api/clients/${clientId}/products/${productId}/knowledge`,{headers})).json();
    const adopted=knowledge.items.find(r=>r.entityId===runs[0].suggestions[0].entityId);assert.equal(adopted.state,'draft');assert.equal(adopted.content.text,'Ein CSV-Export ist möglich.');assert.equal(adopted.usable,false);assert.ok(adopted.reason.includes(runs[0].id));
    await js(`document.querySelector('.knowledge-suggestions').scrollIntoView({block:'start',behavior:'instant'});`);
    await new Promise(resolve=>setTimeout(resolve,500));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'knowledge-suggestions.png'),shot.toPNG());
    await js(`document.querySelector('.knowledge-run').scrollIntoView({block:'start',behavior:'instant'});`);
    await new Promise(resolve=>setTimeout(resolve,500));const detail=await win.webContents.capturePage();if(!detail.isEmpty())writeFileSync(join(dataDir,'knowledge-suggestion-detail.png'),detail.toPNG());
    // Old-product history must never appear after navigation, even when the request finishes late.
    await js(`window.__runFetch=window.fetch;window.fetch=(...args)=>String(args[0]).endsWith('/knowledge-runs')?new Promise(resolve=>{window.__releaseRuns=()=>resolve(new Response(JSON.stringify(${JSON.stringify(runs)})));}):window.__runFetch(...args);void 0;`);
    await click('Vorschläge und Modellstand neu laden');await until(`typeof window.__releaseRuns==='function'`);
    await fill({'Produkt auswählen':''});await until(`!document.querySelector('.knowledge-suggestions')`);
    await js(`window.__releaseRuns();window.fetch=window.__runFetch;void 0;`);
    assert.equal(await js(`Boolean(document.querySelector('.knowledge-suggestions'))`),false);
    await fill({'Produkt auswählen':productId});await until(`Boolean(document.querySelector('.knowledge-panel fieldset')) && !document.querySelector('.knowledge-panel fieldset').disabled`);
    writeFileSync(join(dataDir,'knowledge-runs-result.json'),JSON.stringify({passed:true,providerCalls:calls,adoptionRequests:1,draftOnly:true,lateProductResponseIgnored:true,liveProvider:false},null,2));
  }finally{global.fetch=original;await js(`if(window.__adoptFetch)window.fetch=window.__adoptFetch;delete window.__releaseRuns;void 0;`);}
};

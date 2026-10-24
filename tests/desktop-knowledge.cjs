const assert=require('node:assert/strict');
const {readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.checkKnowledge=async(win,dataDir,js,until,click,url,headers,clientId,productId)=>{
  const path=`/api/clients/${clientId}/products/${productId}/knowledge`;
  const fill=async(values)=>js(`(()=>{for(const [label,value] of ${JSON.stringify(Object.entries(values))}){const el=document.querySelector('[aria-label="'+label+'"]');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));}})()`);
  await fill({'Produkt auswählen':productId});await until(`document.querySelector('.knowledge-panel')?.innerText.includes('Produktversion 2')`);
  await fill({'Wissen Betreiber':'Smoke Betreiber','Wissen Begründung':'Synthetische Quelle geprüft.','Wissen Quellentitel':'CSV Datenblatt','Wissen Fundstelle':'https://example.com/product','Wissen Quellentext':'Das Produkt exportiert CSV. Keine automatische Anbindung.'});
  await js(`window.__knowledgeFetch=window.fetch;window.__knowledgePosts=0;window.fetch=(...args)=>{if(String(args[0]).endsWith('/knowledge')&&args[1]?.method==='POST')window.__knowledgePosts++;return window.__knowledgeFetch(...args);};void 0;`);
  try{
    await js(`document.querySelector('.knowledge-panel form').requestSubmit();document.querySelector('.knowledge-panel form').requestSubmit();`);
    await until(`document.querySelector('.knowledge-panel [role="status"]')?.innerText.includes('Version 1 gespeichert')`);
    assert.equal(await js('window.__knowledgePosts'),1,'knowledge same-tick double submit is locked');
    let saved=await(await fetch(url+path,{headers})).json();const source=saved.items.find(r=>r.kind==='source');
    await fill({'Wissen Begründung':'Aussage aus dem Datenblatt abgeleitet.','Wissen Aussage':'CSV-Export ist verfügbar.','Wissen Belegquelle':source.id,'Wissen Beleg':'Das Produkt exportiert CSV.'});
    await click('Aussage als Entwurf speichern');await until(`document.querySelector('[aria-label="Wissen Aussage bearbeiten"]').options.length===2`);
    saved=await(await fetch(url+path,{headers})).json();const claim=saved.items.find(r=>r.kind==='claim');assert.equal(claim.state,'draft');
    await fill({'Wissen Aussage bearbeiten':claim.entityId,'Wissen Begründung':'Beleg und Aussage inhaltlich geprüft.'});await click('Geprüfte Aussage freigeben');
    await until(`document.querySelector('.knowledge-panel')?.innerText.includes('1 aktuell freigegebene Aussagen')`);
    await fill({'Wissen Aussage bearbeiten':claim.entityId,'Wissen Begründung':'Synthetischer Widerruf.'});await click('Aussage widerrufen');
    await until(`document.querySelector('.knowledge-panel [role="status"]')?.innerText.includes('Widerruf dokumentiert')`);
    saved=await(await fetch(url+path,{headers})).json();assert.equal(saved.rows.length,4);assert.equal(saved.items.find(r=>r.entityId===claim.entityId).usable,false);
    await fill({'Wissen Aussage bearbeiten':claim.entityId});
    await js(`document.querySelector('.knowledge-panel').scrollIntoView({behavior:'instant',block:'start'});`);win.show();await wait(700);
    const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'knowledge.png'),shot.toPNG());
    await js(`document.querySelector('.knowledge-grid').scrollIntoView({behavior:'instant',block:'start'});`);await wait(700);
    const detail=await win.webContents.capturePage();if(!detail.isEmpty())writeFileSync(join(dataDir,'knowledge-detail.png'),detail.toPNG());
    const target=join(dataDir,'product-knowledge.json');
    const download=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{win.webContents.session.removeListener('will-download',onDownload);reject(new Error('Knowledge export timed out'));},15000);function onDownload(_event,item){item.setSavePath(target);item.once('done',(_event,status)=>{clearTimeout(timer);status==='completed'?resolve():reject(new Error(status));});}win.webContents.session.once('will-download',onDownload);});
    await Promise.all([click('Produktwissen als JSON herunterladen'),download]);
    const archive=JSON.parse(readFileSync(target,'utf8'));assert.equal(archive.productId,productId);assert.equal(archive.rows.length,4);assert.ok(archive.rows.every(r=>r.clientId===clientId));
    await require('./desktop-source-import.cjs').checkSourceImport(win,dataDir,js,until,click,url,headers,clientId,productId,fill);
    await require('./desktop-knowledge-runs.cjs').checkKnowledgeRuns(win,dataDir,js,until,click,url,headers,clientId,productId,fill);
    // An in-flight response from the old product must not populate a different product screen.
    await js(`window.fetch=(...args)=>String(args[0]).endsWith('/knowledge')?new Promise(resolve=>{window.__knowledgeRelease=()=>resolve(new Response('{}'));}):window.__knowledgeFetch(...args);void 0;`);
    await click('Wissen neu laden');await until(`typeof window.__knowledgeRelease==='function'`);
    await fill({'Produkt auswählen':''});await until(`!document.querySelector('.knowledge-panel')`);
    await js(`window.__knowledgeRelease();void 0;`);await wait(100);
    assert.ok(!(await js('document.body.innerText')).includes('Produktwissen konnte nicht geladen'),'old product response ignored');
  }finally{await js(`window.fetch=window.__knowledgeFetch;delete window.__knowledgeRelease;void 0;`);}
};

const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkSourceImport=async(win,dataDir,js,until,click,url,headers,clientId,productId,fill)=>{
  const path=`/api/clients/${clientId}/products/${productId}/knowledge`;
  const before=await(await fetch(url+path,{headers})).json();
  const file=async(name,text)=>js(`(()=>{const el=document.querySelector('[aria-label="Produktquelle Datei"]'),dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'text/plain'}));el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await file('Produktblatt.md','# Produktblatt\nDas Produkt exportiert CSV. Diese Angaben sind synthetisch.');
  await until(`document.querySelector('.source-preview')?.innerText.includes('Produktblatt.md')`);
  assert.equal((await(await fetch(url+path,{headers})).json()).rows.length,before.rows.length,'preview does not save');
  await js(`document.querySelector('.product-source-import').scrollIntoView({behavior:'instant',block:'start'});`);
  await new Promise(resolve=>setTimeout(resolve,500));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'source-import.png'),shot.toPNG());
  await click('Als neue Quelle in den Editor übernehmen');await until(`document.querySelector('[aria-label="Wissen Quellentitel"]').value==='Produktblatt.md'`);
  assert.equal((await(await fetch(url+path,{headers})).json()).rows.length,before.rows.length,'editor adoption does not save');
  await fill({'Wissen Betreiber':'Synthetic importer','Wissen Begründung':'Datei geprüft und als eigene Produktquelle übernommen.'});await click('Quelle als neue Version speichern');
  await until(`document.querySelector('.knowledge-panel [role="status"]')?.innerText.includes('Version 1 gespeichert')`);
  const saved=await(await fetch(url+path,{headers})).json();assert.equal(saved.rows.length,before.rows.length+1);assert.ok(saved.items.some(r=>r.content.locator==='Datei Produktblatt.md'));
  await file('unsupported.pdf','%PDF synthetic only');await until(`document.querySelector('.product-source-import [role="alert"]')?.innerText.includes('UTF-8-Textdatei')`);
  await js(`window.__importFetch=window.fetch;window.__importCalls=0;window.fetch=(...args)=>{if(String(args[0]).endsWith('/source-preview')&&JSON.parse(args[1].body).kind==='website'){window.__importCalls++;return Promise.resolve(new Response(JSON.stringify({clientId:${JSON.stringify(clientId)},productId:${JSON.stringify(productId)},productRevision:2,kind:'website',source:{title:'Synthetische Produktseite',locator:'https://example.com/final',capturedAt:'2026-10-01T12:00:00.000Z',text:'Synthetische öffentliche Produktinformationen. Kein echter Websiteabruf im Desktop-Test.',withdrawn:false}})));}return window.__importFetch(...args);};void 0;`);
  try{
    await fill({'Produktquelle Website':'https://example.com/product'});
    await js(`(()=>{const b=[...document.querySelectorAll('.product-source-import button')].find(x=>x.innerText==='Produktseite als Vorschau laden');b.click();b.click();})()`);
    await until(`document.querySelector('.source-preview')?.innerText.includes('Synthetische Produktseite')`);assert.equal(await js('window.__importCalls'),1);
    await js(`window.fetch=(...args)=>String(args[0]).endsWith('/source-preview')?new Promise(resolve=>{window.__releaseImport=()=>resolve(new Response(JSON.stringify({clientId:${JSON.stringify(clientId)},productId:${JSON.stringify(productId)},productRevision:2,kind:'website',source:{title:'Verspätete alte Quelle',locator:'https://example.com',capturedAt:'2026-10-01T12:00:00.000Z',text:'Old source.',withdrawn:false}})));}):window.__importFetch(...args);void 0;`);
    await click('Produktseite als Vorschau laden');await until(`typeof window.__releaseImport==='function'`);
    await fill({'Produkt auswählen':''});await until(`!document.querySelector('.product-source-import')`);
    await js(`window.__releaseImport();window.fetch=window.__importFetch;void 0;`);
    await fill({'Produkt auswählen':productId});await until(`Boolean(document.querySelector('.knowledge-panel fieldset')) && !document.querySelector('.knowledge-panel fieldset').disabled`);
    assert.ok(!(await js('document.body.innerText')).includes('Verspätete alte Quelle'));
    writeFileSync(join(dataDir,'source-import-result.json'),JSON.stringify({passed:true,filePreviewAndSave:true,noImplicitSave:true,unsupportedFormatRejected:true,websitePreviewSimulated:true,websiteDoubleClickRequests:1,stalePreviewIgnored:true,liveWebsite:false},null,2));
  }finally{await js(`window.fetch=window.__importFetch;delete window.__releaseImport;void 0;`);}
};

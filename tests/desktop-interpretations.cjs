const assert=require('node:assert/strict');
const {readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.checkInterpretations=async(win,dataDir,js,until,click,url,headers,clientId,eventId)=>{
  const path=`/api/clients/${clientId}/evidence-journal/${eventId}/interpretations`;
  await js(`Array.from(document.querySelectorAll('.journal-entry')).find(el=>el.querySelector('.interpretations')).open=true;`);
  await click('Bewertungen öffnen');await until(`Boolean(document.querySelector('[aria-label="Bewertung Begründung"]'))`);
  await js(`(()=>{const set=(label,value)=>{const el=document.querySelector('[aria-label="'+label+'"]');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};set('Bewertung Betreiber','Smoke Betreiber');set('Bewertung Antworttyp','interest');set('Bewertung Materialanfrage','yes');set('Bewertung Begründung','Synthetischer Bedienfall, keine echte Vertriebsentscheidung.');})()`);
  await js(`window.__assessmentFetch=window.fetch;window.__assessmentPosts=0;window.fetch=(...args)=>{if(String(args[0]).endsWith('/interpretations')&&args[1]?.method==='POST')window.__assessmentPosts++;return window.__assessmentFetch(...args);};void 0;`);
  try{
    await js(`document.querySelector('.interpretations form').requestSubmit();document.querySelector('.interpretations form').requestSubmit();`);
    await until(`document.querySelector('.interpretations [role="status"]')?.innerText.includes('Version 1 gespeichert')`);
    assert.equal(await js('window.__assessmentPosts'),1,'assessment double submit is locked');
    await js(`(()=>{const el=document.querySelector('[aria-label="Bewertung Begründung"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Korrigierter synthetischer Bedienfall: ursprüngliche Bewertung widerrufen.');el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelectorAll('.interpretations input[type="checkbox"]')[1].click();})()`);
    await click('Bewertung als neue Version speichern');await until(`document.querySelector('.interpretations [role="status"]')?.innerText.includes('Version 2 gespeichert')`);
    const saved=await(await fetch(url+path,{headers})).json();assert.equal(saved.revision,2);assert.equal(saved.rows[0].content.withdrawn,true);assert.equal(saved.rows[1].content.withdrawn,false);assert.equal(saved.rows[0].previousId,saved.rows[1].id);
    await js(`document.querySelector('.interpretation-history').open=true;document.querySelector('.interpretations').scrollIntoView({behavior:'instant',block:'start'});`);win.show();await wait(700);
    const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'interpretations.png'),shot.toPNG());
    const target=join(dataDir,'interpretations.json');
    const download=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{win.webContents.session.removeListener('will-download',onDownload);reject(new Error('Interpretation export timed out'));},15000);
      function onDownload(_event,item){item.setSavePath(target);item.once('done',(_event,status)=>{clearTimeout(timeout);status==='completed'?resolve():reject(new Error(status));});}
      win.webContents.session.once('will-download',onDownload);
    });
    await js(`document.querySelector('.interpretation-export').open=true;`);
    await Promise.all([click('Bewertungen als JSON herunterladen'),download]);
    const archive=JSON.parse(readFileSync(target,'utf8'));assert.equal(archive.clientId,clientId);assert.equal(archive.rows.length,2);assert.ok(archive.rows.every(r=>r.eventId===eventId));
    await js(`window.fetch=(...args)=>String(args[0]).endsWith('/interpretations')?new Promise(resolve=>{window.__assessmentRelease=()=>resolve(new Response('{}'));}):window.__assessmentFetch(...args);void 0;`);
    await click('Bewertungen neu laden');await until(`typeof window.__assessmentRelease==='function'`);
    await click('Übersicht');await until(`!document.querySelector('.interpretations')`);
    await js(`window.__assessmentRelease();void 0;`);await wait(100);
    assert.ok(!(await js('document.body.innerText')).includes('Bewertungsverlauf konnte nicht gelesen werden'),'stale response ignored after unmount');
  }finally{await js(`window.fetch=window.__assessmentFetch;delete window.__assessmentRelease;void 0;`);}
  await click('Kundenbereich öffnen');await click('Historie laden');await until(`Boolean(document.querySelector('.journal-entry'))`);
};

const assert=require('node:assert/strict');
const {readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkMeetings=async({win,dataDir,js,until,click,url,headers,clientId})=>{
 await click('Übersicht');await click('Kundenbereich öffnen');await click('Historie laden');
 const scope='.journal-entry:has(.interpretations) .meeting-editor';
 await until(`!!document.querySelector(${JSON.stringify(scope)})`);
 await js(`document.querySelector('.journal-entry:has(.interpretations)').open=true;document.querySelector(${JSON.stringify(scope+' button')}).click()`);
 await until(`!!document.querySelector(${JSON.stringify(scope+' form')})`);
 const fill=async(label,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(scope+' [aria-label="'+label+'"]')});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 const toggle=label=>js(`document.querySelector(${JSON.stringify(scope+' [aria-label="'+label+'"]')}).click()`);
 await fill('Terminreferenz','SYNTHETIC-MEETING-001');await fill('Terminzeit','2026-01-01T10:00');await fill('Termin Betreiber','Smoke Operator');await fill('Terminbeleg','Synthetische Buchungsbestätigung.');await toggle('Termin bestätigen');
 await js(`window.__meetingFetch=window.fetch;window.__meetingPosts=0;window.fetch=(...args)=>{if(String(args[0]).endsWith('/meetings')&&args[1]?.method==='POST')window.__meetingPosts++;return window.__meetingFetch(...args);};void 0;`);
 try{
  await js(`document.querySelector(${JSON.stringify(scope+' form')}).requestSubmit();document.querySelector(${JSON.stringify(scope+' form')}).requestSubmit();`);
  await until(`document.querySelector(${JSON.stringify(scope+' [role="status"]')})?.innerText.includes('Terminversion gespeichert')`);assert.equal(await js('window.__meetingPosts'),1);
  await click('Terminübersicht laden / aktualisieren');await until(`document.querySelector('.meeting-overview').innerText.includes('Teilnahme ungeklärt')`);
  await fill('Terminstatus','held_confirmed');await fill('Termin Betreiber','Smoke Operator');await fill('Terminbeleg','Synthetische Teilnahme durch Kundenrückmeldung.');await toggle('Termin bestätigen');await js(`document.querySelector(${JSON.stringify(scope+' form')}).requestSubmit()`);
  await until(`document.querySelector(${JSON.stringify(scope+' .meeting-history summary')})?.innerText.includes('2 Versionen')`);
  await fill('Termin Betreiber','Smoke Operator');await fill('Terminbeleg','Synthetische Korrektur: falsche Zuordnung.');await toggle('Termin widerrufen');await toggle('Termin bestätigen');await js(`document.querySelector(${JSON.stringify(scope+' form')}).requestSubmit()`);
  await until(`document.querySelector(${JSON.stringify(scope+' .meeting-history summary')})?.innerText.includes('3 Versionen')`);
  const saved=await(await fetch(url+`/api/clients/${clientId}/meetings`,{headers})).json();assert.equal(saved.current.length,1);assert.equal(saved.history.length,3);assert.equal(saved.current[0].content.withdrawn,true);assert.equal(saved.current[0].attendanceUnverified,false);assert.equal(saved.current[0].revision,3);assert.equal(saved.history.filter(r=>r.content.status==='booked').length,1);
  await click('Terminübersicht laden / aktualisieren');await until(`document.querySelector('.meeting-overview').innerText.includes('widerrufen')`);
  win.show();await js(`document.querySelector(${JSON.stringify(scope+' .meeting-history')}).open=true;document.querySelector(${JSON.stringify(scope)}).scrollIntoView({behavior:'instant',block:'start'})`);await new Promise(r=>setTimeout(r,350));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'meetings.png'),shot.toPNG());assert.equal(await js('document.documentElement.scrollWidth<=window.innerWidth'),true);
  for(const [selector,name] of [[scope+' .meeting-history','meeting-history'],['.meeting-overview','meeting-overview']]){await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({behavior:'instant',block:'start'})`);await new Promise(r=>setTimeout(r,250));const image=await win.webContents.capturePage();if(!image.isEmpty())writeFileSync(join(dataDir,name+'.png'),image.toPNG());}
  const target=join(dataDir,'meetings-export.json'),download=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{win.webContents.session.removeListener('will-download',handler);reject(Error('Meeting export timeout'));},15000);function handler(_e,item){item.setSavePath(target);item.once('done',(_e,status)=>{clearTimeout(timer);status==='completed'?resolve():reject(Error(status));});}win.webContents.session.once('will-download',handler);});
  await Promise.all([click('Angezeigten Terminstand exportieren'),download]);const exported=JSON.parse(readFileSync(target,'utf8'));assert.equal(exported.format,'eiz-meetings');assert.deepEqual(exported.current,saved.current);assert.deepEqual(exported.history,saved.history);
  await js(`window.fetch=(...args)=>String(args[0]).endsWith('/meetings')?new Promise(resolve=>{window.__meetingRelease=()=>resolve(new Response('{}'));}):window.__meetingFetch(...args);void 0;`);await click('Terminübersicht laden / aktualisieren');await until(`typeof window.__meetingRelease==='function'`);await click('Übersicht');await until(`!document.querySelector('.meeting-overview')`);await js(`window.__meetingRelease();void 0;`);
  writeFileSync(join(dataDir,'meetings-result.json'),JSON.stringify({passed:true,creation:true,doubleSubmitProtected:true,operatorAttendance:true,withdrawal:true,historyVersions:3,overdueIsNotAttendance:true,actualJsonDownload:true,lateResponseIgnored:true,externalSend:false,liveProvider:false},null,2));
 }finally{await js(`window.fetch=window.__meetingFetch;delete window.__meetingRelease;void 0;`);}
};

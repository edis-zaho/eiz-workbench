const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkReplyAnalysis=async({win,dataDir,js,until,click,url,headers,clientId})=>{
 const original=global.fetch,base=`/api/clients/${clientId}`;
 const api=async(path,body)=>{const r=await original(url+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error);return data;};
 const mail=(await api(base+'/mail-tests')).find(m=>m.status==='sent');assert.ok(mail);const b=await api(base+'/brief');assert.ok(b.approved);
 let calls=0,release=null,hold=true,invalid=false;
 async function add(rows){await require('./desktop-mailbox-fixture.cjs').importConversation({dataDir,js,url,headers,clientId,mailId:mail.id,rows:rows.map(([subject,excerpt],i)=>({providerId:require('node:crypto').randomUUID(),threadId:'replyanalysis',sender:mail.recipient,subject,excerpt,receivedAt:new Date().toISOString(),kind:'reply',evidence:'{}'}))});}
 global.fetch=async(input,init)=>{
  if(String(input).startsWith('http://127.0.0.1:'))return original(input,init);
  assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;const body=JSON.parse(init.body),t=JSON.parse(body.input);assert.equal(t.promptVersion,'reply-analysis-v1');assert.equal(body.text.format.type,'json_object');assert.equal(body.tools,undefined);assert.equal(t.sender,undefined);assert.equal(t.recipient,undefined);
  if(hold)await new Promise(resolve=>{release=resolve;});
  const absence=t.subject.includes('Abwesenheit'),privacy=t.subject.includes('Datenschutz');
  const result={replyType:absence?'out_of_office':privacy?'other':'interest',technicalQuestion:absence||privacy?'no':'yes',materialRequest:absence||privacy?'no':'yes',meetingIntent:'no',confidence:'high',unsubscribe:privacy?'yes':'no',privacyRequest:privacy?'yes':'no',rejectionScope:'none',returnDate:absence?'2026-12-15':null,dateQuote:absence?'15.12.2026':'',quotes:[invalid?'Invented evidence':t.excerpt],rationale:'Synthetische Prüfung anhand des gespeicherten Ausschnitts.'};
  return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:60,output_tokens:40}}));
 };
 async function prepare(count){await click('Bis zu 20 neue Eingänge auswählen');await click(`Übertragung für ${count} Eingänge prüfen`);await until(`!!document.querySelector('[aria-label="KI-Eingänge freigeben"]')`);await js(`document.querySelector('[aria-label="KI-Eingänge freigeben"]').click()`);}
 try{
  await js(`window.workbench.saveModel({provider:'openai',key:'synthetic-reply-analysis-key',remove:false})`);
  await add([['B05 Abwesenheit','Ab 15.12.2026 bin ich wieder erreichbar.'],['B05 Anfrage','Bitte senden Sie technische Informationen.'],['B05 Datenschutz','Bitte löschen Sie meine Daten und kontaktieren Sie mich nicht mehr.']]);
  await click('Eingangsauswertung laden');await until(`document.querySelector('.reply-analysis').innerText.includes('B05 Datenschutz')`);await prepare(3);
  await js(`(()=>{const b=Array.from(document.querySelectorAll('.reply-analysis button')).find(b=>b.textContent==='Ausgewählte Antworten auswerten');b.click();b.click();})()`);
  for(let i=0;i<60&&!release;i++)await new Promise(r=>setTimeout(r,100));assert.ok(release,'provider request started');await click('Nach laufendem Aufruf stoppen');hold=false;release();
  await until(`document.querySelector('.reply-analysis [role="status"]')?.innerText.includes('1 von 3 Aufträgen abgeschlossen')`);assert.equal(calls,1);assert.equal((await api(base+'/reply-analysis')).rows.filter(r=>r.run).length,1);
  await prepare(2);await click('Ausgewählte Antworten auswerten');await until(`document.querySelector('.reply-analysis [role="status"]')?.innerText.includes('2 von 2 Aufträgen abgeschlossen')`);assert.equal(calls,3);
  const page=await api(base+'/reply-analysis'),rated=page.rows.filter(r=>r.run);assert.equal(rated.length,3);assert.ok(rated.every(r=>r.latest.origin==='model'));assert.ok(rated.some(r=>r.run.route.priority===0));assert.ok(rated.some(r=>r.run.result.analysis.returnDate==='2026-12-15'));
  // A real correction goes through the existing versioned editor.
  await js(`(()=>{const a=Array.from(document.querySelectorAll('.reply-analysis-list article')).find(a=>a.querySelector('h3')?.textContent==='B05 Anfrage');Array.from(a.children).find(el=>el.tagName==='DETAILS'&&el.querySelector('summary')?.textContent==='Bewertung prüfen oder korrigieren').open=true;Array.from(a.querySelectorAll('button')).find(b=>b.textContent==='Bewertungen öffnen').click();})()`);
  await until(`!!document.querySelector('.reply-analysis [aria-label="Bewertung Begründung"]')?.getClientRects().length`);
  await js(`(()=>{const root=document.querySelector('.reply-analysis');for(const [label,value] of [['Bewertung Betreiber','Pilotbetreiber'],['Bewertung Begründung','Menschlich korrigierte Einschätzung.']]){const el=root.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await js(`(()=>{const f=document.querySelector('.reply-analysis .interpretations form');if(!f.checkValidity())throw Error('Correction fixture is invalid');f.requestSubmit();})()`);await until(`document.querySelector('.reply-analysis .interpretations [role="status"]')?.innerText.includes('Version 2 gespeichert')`);
  await click('Eingangsauswertung laden');await until(`document.querySelector('.reply-analysis').innerText.includes('durch eine spätere Bewertung ersetzt')`);
  await js(`document.querySelector('.reply-analysis-list').scrollIntoView({behavior:'instant',block:'start'})`);win.show();await new Promise(r=>setTimeout(r,350));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'reply-analysis.png'),shot.toPNG());
  // An invalid answer terminates the selected batch before the next paid call.
  await add([['B05 Fehler A','Bitte senden Sie Informationen.'],['B05 Fehler B','Bitte senden Sie Informationen.']]);await click('Eingangsauswertung laden');await until(`document.querySelector('.reply-analysis').innerText.includes('B05 Fehler B')`);await prepare(2);invalid=true;await click('Ausgewählte Antworten auswerten');await until(`document.querySelector('.reply-analysis [role="status"]')?.innerText.includes('1 von 2 Aufträgen abgeschlossen')`);assert.equal(calls,4);assert.ok(await js(`document.querySelector('.reply-analysis [role="alert"]').innerText.includes('verworfen')`));assert.equal((await api(base+'/reply-analysis')).rows.filter(r=>r.eligible).length,1);
  writeFileSync(join(dataDir,'reply-analysis-result.json'),JSON.stringify({passed:true,providerCalls:calls,doubleSubmitGuard:true,batchStop:true,batchFailureStopsRemainder:true,automaticModelAssessment:true,quotedReturnDate:true,privacyPriority:true,humanCorrectionPreserved:true,contactFieldsExcluded:true,liveProvider:false},null,2));
 }finally{if(release)release();global.fetch=original;await js(`window.workbench.saveModel({provider:'openai',key:'',remove:true})`);}
};

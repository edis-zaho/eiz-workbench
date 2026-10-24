const assert=require('node:assert/strict');
const {writeFileSync,readFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkThreadContext=async({win,dataDir,js,until,click,url,headers,clientId,mail})=>{
 const previous=global.fetch,base=`/api/clients/${clientId}`;
 mail=(await(await previous(url+base+'/mail-tests',{headers})).json()).find(m=>m.id===mail.id);assert.ok(mail?.providerId);
 const incoming=(await(await previous(url+base+'/incoming',{headers})).json()).find(i=>i.mailId===mail.id);assert.ok(incoming);
 const body=text=>({size:Buffer.byteLength(text),data:Buffer.from(text).toString('base64url')});
 const anchor={id:mail.providerId,threadId:incoming.threadId,labelIds:['SENT'],internalDate:String(Date.parse(incoming.receivedAt)-1000),payload:{mimeType:'text/plain',body:body(mail.body),headers:[{name:'From',value:mail.sender},{name:'To',value:mail.recipient},{name:'Message-ID',value:mail.messageId},{name:'Subject',value:mail.subject}]}};
 const literal='<script>window.__threadInjected=true</script> Vollständiger synthetischer Antworttext.';
 const reply={id:incoming.providerId,threadId:incoming.threadId,labelIds:['INBOX'],internalDate:String(Date.parse(incoming.receivedAt)),payload:{mimeType:'text/plain',body:body(literal),headers:[{name:'From',value:incoming.sender},{name:'To',value:mail.sender},{name:'Message-ID',value:'<synthetic-context@example.com>'},{name:'In-Reply-To',value:mail.messageId},{name:'Subject',value:incoming.subject}]}};
 let reads=0;global.fetch=async(input,init)=>{const target=String(input);if(target===`https://gmail.googleapis.com/gmail/v1/users/me/messages/${mail.providerId}?format=metadata`){reads++;return new Response(JSON.stringify(anchor));}if(target===`https://gmail.googleapis.com/gmail/v1/users/me/threads/${incoming.threadId}?format=full`){reads++;assert.equal(init.method,undefined);return new Response(JSON.stringify({id:incoming.threadId,messages:[anchor,reply]}));}return previous(input,init);};
 try{
  await click('Gesprächsfälle laden');await until(`document.querySelector('.conversations').innerText.includes(${JSON.stringify(incoming.recipient)})`);await click('Fall prüfen: '+incoming.recipient);await until(`!!document.querySelector('.thread-context')`);
  await click('Gespeicherten Kontext laden');await until(`document.querySelector('.thread-context').innerText.includes('Noch kein vollständiger Gesprächsabruf')`);
  assert.equal(reads,0);await js(`document.querySelector('[aria-label="Gesprächskontext Abruf bestätigen"]').click()`);
  await js(`(()=>{const b=Array.from(document.querySelectorAll('.thread-context button')).find(b=>b.textContent==='Gespräch von Google einlesen');b.click();b.click();})()`);await until(`document.querySelector('.thread-context [role="status"]')?.innerText.includes('lokal gespeichert')`);
  assert.equal(reads,2,'one identity GET and one full thread GET despite double click');assert.equal(await js('window.__threadInjected'),undefined);assert.ok(await js(`document.querySelector('.thread-timeline pre:last-child').textContent.includes('synthetisch') || document.querySelector('.thread-timeline').textContent.includes('synthetisch')`));
  const state=await(await previous(url+base+`/thread-context/${incoming.id}`,{headers})).json();assert.equal(state.latest.revision,1);assert.equal(state.hasGaps,false);assert.equal(state.capture.messages[1].text,literal);
  win.show();await js(`document.querySelector('.thread-context').scrollIntoView({behavior:'instant',block:'start'})`);await new Promise(r=>setTimeout(r,350));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'thread-context.png'),shot.toPNG());
  const target=join(dataDir,'thread-context-export.json');const download=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{win.webContents.session.removeListener('will-download',handler);reject(Error('Thread export timed out'));},15000);function handler(_e,item){item.setSavePath(target);item.once('done',(_e,status)=>{clearTimeout(timer);status==='completed'?resolve():reject(Error(status));});}win.webContents.session.once('will-download',handler);});await Promise.all([click('Gesprächskontext exportieren'),download]);const out=JSON.parse(readFileSync(target,'utf8'));assert.equal(out.snapshots.length,1);assert.equal(JSON.parse(out.snapshots[0].payload).messages[1].text,literal);
  writeFileSync(join(dataDir,'thread-context-result.json'),JSON.stringify({passed:true,nativeGmailRead:true,explicitConsent:true,doubleClickProtected:true,fullTextStored:true,literalTextEscaped:true,historyExport:true,liveProvider:false},null,2));
 }finally{global.fetch=previous;}
};

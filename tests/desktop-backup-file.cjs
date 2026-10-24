const assert=require('node:assert/strict');
const {writeFileSync,appendFileSync}=require('node:fs');
const {join}=require('node:path');
exports.checkNativeBackup=async({win,dataDir,js,until,click,url,headers})=>{
 const {dialog}=require('electron'),pick=dialog.showOpenDialog,confirm=dialog.showMessageBox;
 // Quiesce synthetic automation before asserting snapshot equality across user dialogs.
 const state=await(await fetch(url+'/api/state',{headers})).json();for(const c of state.clients){if(c.status!=='paused'){const r=await fetch(url+`/api/clients/${c.id}/pause`,{method:'POST',headers,body:JSON.stringify({paused:true,version:c.version})});assert.equal(r.status,200);}}
 const before=(await(await fetch(url+'/api/backup',{method:'POST',headers})).json()).backup,file=join(dataDir,'native-restore.json'),text=JSON.stringify(before);
 writeFileSync(file,text);await click('Sicherungen');await until(`document.body.innerText.includes('Sicherung auswählen')`);
 let mode='cancel',confirmations=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
 dialog.showMessageBox=async(_win,options)=>{assert.equal(options.title,'Daten wiederherstellen');assert.match(options.detail,/Testdatenbank/);confirmations++;if(mode==='change')appendFileSync(file,' ');return {response:mode==='cancel'?0:1};};
 try{
  await click('Sicherung auswählen');await until(`document.body.innerText.includes('Wiederherstellung abgebrochen.')`);
  let current=(await(await fetch(url+'/api/backup',{method:'POST',headers})).json()).backup;assert.deepEqual(current.data,before.data);
  mode='change';await click('Sicherung auswählen');await until(`document.body.innerText.includes('Datei wurde seit der Prüfung geändert')`);
  current=(await(await fetch(url+'/api/backup',{method:'POST',headers})).json()).backup;assert.deepEqual(current.data,before.data);
  writeFileSync(file,text);mode='restore';await click('Sicherung auswählen');await until(`document.body.innerText.includes('Sicherung wiederhergestellt. Kunden sind pausiert')`);
  current=(await(await fetch(url+'/api/backup',{method:'POST',headers})).json()).backup;assert.ok(current.data.clients.every(c=>c.status==='paused'));assert.deepEqual(current.data.evidenceEvents,before.data.evidenceEvents);assert.ok(current.data.mailSync.every(m=>m.enabled===0));assert.equal(confirmations,3);
  win.show();await new Promise(r=>setTimeout(r,250));const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'native-backup.png'),shot.toPNG());
  writeFileSync(join(dataDir,'native-backup-result.json'),JSON.stringify({passed:true,nativeCheckBeforeConfirmation:true,cancelPreservesData:true,changedFileRejected:true,restorePausesClients:true,rawEvidencePreserved:true,liveProvidersUsed:false},null,2));
 }finally{dialog.showOpenDialog=pick;dialog.showMessageBox=confirm;}
};

const assert = require('node:assert/strict');
const {readFileSync,writeFileSync} = require('node:fs');
const {join} = require('node:path');
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));

exports.checkJournalExport = async (win,dataDir,js,until,click,expectedRows) => {
  await until(`Boolean(document.querySelector('.journal-export'))`);
  const target=join(dataDir,'journal-export.csv');
  const downloaded=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{win.webContents.session.removeListener('will-download',onDownload);reject(new Error('Journal CSV download timed out'));},15000);
    function onDownload(_event,item) {
      item.setSavePath(target);
      item.once('done',(_event,status)=>{clearTimeout(timeout);status==='completed'?resolve():reject(new Error('Journal download: '+status));});
    }
    win.webContents.session.once('will-download',onDownload);
  });
  await js(`window.__journalFetch=window.fetch;window.__journalCalls=0;window.__journalCreate=URL.createObjectURL;window.__journalRevoke=URL.revokeObjectURL;window.__journalUrls=[];window.__journalRevoked=[];URL.createObjectURL=(...args)=>{const url=window.__journalCreate(...args);window.__journalUrls.push(url);return url;};URL.revokeObjectURL=url=>{window.__journalRevoked.push(url);window.__journalRevoke(url);};window.fetch=(...args)=>{if(String(args[0]).endsWith('/journal-export'))window.__journalCalls++;return window.__journalFetch(...args);};void 0;`);
  try {
    await Promise.all([js(`document.querySelector('.journal-export form').requestSubmit();document.querySelector('.journal-export form').requestSubmit();`),downloaded]);
    assert.equal(await js('window.__journalCalls'),1,'double submit produces one journal request');
    const csv=readFileSync(target,'utf8'),rows=csv.split('\r\n').slice(1).map(line=>line.split(','));
    assert.equal(rows.length,expectedRows,'all fixture observations downloaded');
    assert.ok(csv.startsWith('id,clientId,source,sourceId,sourceRevision,eventType,origin,'));
    assert.ok(rows.some(row=>row[10]==='unknown'));assert.ok(rows.some(row=>row[10]==='sent'));
    assert.equal(rows.filter(row=>row[2]==='incoming').length,1);
    assert.ok(!csv.includes('providerId'));assert.ok(!csv.includes('messageId'));
    await until(`document.querySelector('.journal-export [role="status"]')?.innerText.includes('Export erstellt.')`);
    await until(`window.__journalUrls.length===1 && window.__journalRevoked.includes(window.__journalUrls[0])`);
    win.show();await js(`document.querySelector('.journal-export').scrollIntoView({behavior:'instant',block:'start'})`);await wait(700);
    const shot=await win.webContents.capturePage();if(!shot.isEmpty())writeFileSync(join(dataDir,'journal-export.png'),shot.toPNG());

    // A malformed server response must be rejected before creating a Blob or rendering notes.
    await js(`window.fetch=(...args)=>String(args[0]).endsWith('/journal-export')?Promise.resolve(new Response(JSON.stringify({csv:'invalid',rowCount:1,filename:'ereignishistorie.csv',notes:[{}]}))):window.__journalFetch(...args);void 0;`);
    await click('Journal-CSV herunterladen');await until(`document.querySelector('.journal-export [role="alert"]')?.innerText.includes('Ungültige Server-Antwort')`);
    assert.equal(await js('window.__journalUrls.length'),1,'malformed response cannot download');

    // Pending responses must be invalidated by navigation/unmount.
    await js(`window.fetch=(...args)=>String(args[0]).endsWith('/journal-export')?new Promise(resolve=>{window.__journalRelease=()=>resolve(new Response(JSON.stringify({csv:'stale',rowCount:1,filename:'ereignishistorie.csv',notes:[]})));}):window.__journalFetch(...args);void 0;`);
    await click('Journal-CSV herunterladen');await until(`typeof window.__journalRelease==='function'`);
    await click('Übersicht');await until(`!document.querySelector('.journal-export')`);
    await js(`window.__journalRelease();void 0;`);await wait(100);
    assert.equal(await js('window.__journalUrls.length'),1,'late response cannot download after navigation');
  } finally {
    await js(`window.fetch=window.__journalFetch;URL.createObjectURL=window.__journalCreate;URL.revokeObjectURL=window.__journalRevoke;delete window.__journalRelease;void 0;`);
  }
  await click('Kundenbereich öffnen');await until(`Boolean(document.querySelector('.journal-export'))`);
};

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../core/store';
import {claimDeliveryPage,finishDeliveryPage,failDeliveryPage,deliveryProgress,assertDeliveryFresh} from '../core/delivery-progress';
import {configureDeliveryAuto,deliveryAuto,dueDeliveryAuto} from '../core/delivery-auto';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'eiz-progress-'));let s=new Store(join(dir,'db'),join(dir,'backup'),false);const c=s.createClient({name:'A',website:'',email:'',notes:''}),mailboxId=randomUUID();const mail=s.reserveMailTest(c.id,{id:randomUUID(),mailboxId,clientVersion:c.version,sender:'me@example.com',recipient:'you@example.org',subject:'Test',body:'Test'});s.finishMailTest(c.id,mail.id,'sent','sent1','OK');return {get s(){return s;},c,mailboxId,input:{mailboxId,clientVersion:c.version},reopen(){s.close();s=new Store(join(dir,'db'),join(dir,'backup'),false);},close(){s.close();rmSync(dir,{recursive:true,force:true});}};}
const page=(claim:any,nextPageToken:string)=>({...claim,baselineHistoryId:claim.baselineHistoryId||'100',historyId:'200',matches:[],checked:0,unmatched:0,skipped:0,nextPageToken});
function finishRun(f:ReturnType<typeof fixture>,claim:any){finishDeliveryPage(f.s,f.c.id,page(claim,''));if(deliveryProgress(f.s,f.c.id).status==='partial'){makeDue(f);const next=claimDeliveryPage(f.s,f.c.id,{...f.input,automatic:claim.automatic});finishDeliveryPage(f.s,f.c.id,page(next,''));}}
function makeDue(f:ReturnType<typeof fixture>){const r=deliveryAuto(f.s,f.c.id);r.nextAt=0;f.s.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(r),'delivery-auto:'+f.c.id);}
test('Vollprüfung benötigt Nachholabgleich; Cursor bleibt bei Teilseite und Fehler unverändert',()=>{const f=fixture();try{
 let claim=claimDeliveryPage(f.s,f.c.id,f.input);finishDeliveryPage(f.s,f.c.id,page(claim,''));let state=deliveryProgress(f.s,f.c.id);assert.equal(state.status,'partial');assert.equal(state.phase,'history');assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));
 f.reopen();claim=claimDeliveryPage(f.s,f.c.id,f.input);assert.equal(claim.historyId,'100');finishDeliveryPage(f.s,f.c.id,{...page(claim,'next'),historyId:'150'});assert.equal(deliveryProgress(f.s,f.c.id).historyId,'100');
 claim=claimDeliveryPage(f.s,f.c.id,f.input);failDeliveryPage(f.s,f.c.id,{...claim,error:'offline'});claim=claimDeliveryPage(f.s,f.c.id,f.input);assert.equal(claim.pageToken,'next');assert.equal(claim.historyId,'100');finishDeliveryPage(f.s,f.c.id,page(claim,''));assertDeliveryFresh(f.s,f.c.id,f.mailboxId);
 claim=claimDeliveryPage(f.s,f.c.id,f.input);assert.equal(claim.phase,'history');assert.equal(claim.historyId,'200');assert.equal(claim.pageToken,'');
 }finally{f.close();}});
test('Abgelaufene Historie erzwingt Vollprüfung; offene Zuordnungen bleiben im Delta erhalten',()=>{const f=fixture();try{
 let claim=claimDeliveryPage(f.s,f.c.id,f.input);finishRun(f,claim);claim=claimDeliveryPage(f.s,f.c.id,f.input);finishDeliveryPage(f.s,f.c.id,{...page(claim,''),checked:1,unmatched:1});claim=claimDeliveryPage(f.s,f.c.id,f.input);finishDeliveryPage(f.s,f.c.id,page(claim,''));assert.equal(deliveryProgress(f.s,f.c.id).unmatched,1);assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));
 claim=claimDeliveryPage(f.s,f.c.id,f.input);failDeliveryPage(f.s,f.c.id,{...claim,error:'expired',historyExpired:true});f.reopen();claim=claimDeliveryPage(f.s,f.c.id,f.input);assert.equal(claim.phase,'full');assert.equal(claim.historyId,undefined);
 }finally{f.close();}});
test('Automatik braucht Freigabe, setzt Seiten nach Neustart fort und plant Folgelauf',()=>{const f=fixture();try{
 const input={...f.input,automatic:true};assert.throws(()=>claimDeliveryPage(f.s,f.c.id,input));
 configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:true});assert.equal(dueDeliveryAuto(f.s).length,1);
 let claim=claimDeliveryPage(f.s,f.c.id,input);assert.equal(dueDeliveryAuto(f.s).length,0);finishDeliveryPage(f.s,f.c.id,page(claim,'second'));assert.equal(dueDeliveryAuto(f.s).length,0);
 f.reopen();makeDue(f);claim=claimDeliveryPage(f.s,f.c.id,input);assert.equal(claim.pageToken,'second');finishRun(f,claim);assert.ok(deliveryAuto(f.s,f.c.id).nextAt>Date.now()+290000);
 configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:false});assert.equal(dueDeliveryAuto(f.s).length,0);assert.throws(()=>claimDeliveryPage(f.s,f.c.id,input));
 configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:true});const backup=f.s.exportBackup();f.s.restore(backup);assert.equal(deliveryAuto(f.s,f.c.id).enabled,false);
 }finally{f.close();}});
test('Automatik wartet bei Fehlern und hält nach fünf Fehlversuchen an',()=>{const f=fixture();try{
 configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:true});for(let i=1;i<=5;i++){makeDue(f);const claim=claimDeliveryPage(f.s,f.c.id,{...f.input,automatic:true});failDeliveryPage(f.s,f.c.id,{...claim,error:'offline'});const r=deliveryAuto(f.s,f.c.id);assert.equal(r.failures,i);assert.equal(r.enabled,i<5);assert.ok(r.nextAt>Date.now());assert.equal(dueDeliveryAuto(f.s).length,0);}
 }finally{f.close();}});
test('Anhalten und neue Freigabe werden durch alte laufende Seite nicht überschrieben',()=>{const f=fixture();try{
 configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:true});const claim=claimDeliveryPage(f.s,f.c.id,{...f.input,automatic:true});configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:false});configureDeliveryAuto(f.s,f.c.id,{...f.input,enabled:true});failDeliveryPage(f.s,f.c.id,{...claim,error:'alter Fehler'});assert.equal(deliveryAuto(f.s,f.c.id).failures,0);
 f.s.db.prepare("UPDATE clients SET status='paused' WHERE id=?").run(f.c.id);assert.equal(dueDeliveryAuto(f.s).length,0);assert.throws(()=>claimDeliveryPage(f.s,f.c.id,{...f.input,automatic:true}));
 f.s.db.prepare("UPDATE clients SET status='setup',version=version+1 WHERE id=?").run(f.c.id);assert.equal(dueDeliveryAuto(f.s).length,0);
 }finally{f.close();}});
test('Seitenfortschritt überlebt Neustart; nur abgeschlossener aktueller Lauf erfüllt Teilprüfung',()=>{const f=fixture();try{
 assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));let claim=claimDeliveryPage(f.s,f.c.id,f.input);const query=claim.query;
 assert.throws(()=>claimDeliveryPage(f.s,f.c.id,f.input),/läuft bereits/);
 finishDeliveryPage(f.s,f.c.id,page(claim,'page2'));assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));f.reopen();claim=claimDeliveryPage(f.s,f.c.id,f.input);assert.equal(claim.pageToken,'page2');assert.equal(claim.query,query);
 finishRun(f,claim);assertDeliveryFresh(f.s,f.c.id,f.mailboxId);assert.equal(deliveryProgress(f.s,f.c.id).sendAllowed,false);assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,randomUUID()));
 const backup=f.s.exportBackup();f.s.restore(backup);assert.equal(deliveryProgress(f.s,f.c.id).status,'never');assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));
}finally{f.close();}});
test('Fehler behalten Seite; alte Worker und wiederholte Tokens werden abgewiesen',()=>{const f=fixture();try{
 let claim=claimDeliveryPage(f.s,f.c.id,f.input);finishDeliveryPage(f.s,f.c.id,page(claim,'next'));claim=claimDeliveryPage(f.s,f.c.id,f.input);
 assert.throws(()=>finishDeliveryPage(f.s,f.c.id,page(claim,'next')),/Suchfortschritt/);failDeliveryPage(f.s,f.c.id,{...claim,error:'offline'});assert.equal(deliveryProgress(f.s,f.c.id).lastError,'offline');const retry=claimDeliveryPage(f.s,f.c.id,f.input);assert.equal(retry.pageToken,'next');assert.throws(()=>finishDeliveryPage(f.s,f.c.id,page(claim,'')),/nicht mehr aktiv/);finishDeliveryPage(f.s,f.c.id,page(retry,''));
}finally{f.close();}});
test('Veraltete abgeschlossene Läufe und nicht zugeordnete Berichte blockieren Teilprüfung',()=>{const f=fixture();try{
 let claim=claimDeliveryPage(f.s,f.c.id,f.input);finishDeliveryPage(f.s,f.c.id,{...page(claim,''),checked:1,unmatched:1});assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));
 claim=claimDeliveryPage(f.s,f.c.id,f.input);finishRun(f,claim);const key='delivery-progress:'+f.c.id,r=JSON.parse(String(f.s.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value));r.cutoff-=601;f.s.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(r),key);assert.throws(()=>assertDeliveryFresh(f.s,f.c.id,f.mailboxId));
}finally{f.close();}});

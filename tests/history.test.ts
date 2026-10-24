import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {historyPage}=createRequire(import.meta.url)('../electron/history-page.cjs');
const {scanDeliveries}=createRequire(import.meta.url)('../electron/delivery-scan.cjs');
test('Änderungshistorie dedupliziert neue und umetikettierte Nachrichten und reicht Seiten weiter',async()=>{
 const result=await historyPage({historyId:'90071992547409930',pageToken:'a+b'}, {},async(url:string)=>{assert.ok(url.includes('startHistoryId=90071992547409930'));assert.ok(url.includes('pageToken=a%2Bb'));return {historyId:'90071992547409935',nextPageToken:'next',history:[{id:'90071992547409931',messagesAdded:[{message:{id:'a'}}],labelsAdded:[{message:{id:'a'}},{message:{id:'b'}}],messagesDeleted:[{message:{id:'gone'}}]}]};});
 assert.deepEqual(result.messages,[{id:'a'},{id:'b'}]);assert.equal(result.nextPageToken,'next');
});
test('Nur 404 der Historienabfrage fordert Vollprüfung; ungültige oder übergroße Seiten scheitern',async()=>{
 await assert.rejects(()=>historyPage({historyId:'100'}, {},async()=>{throw Object.assign(Error('gone'),{status:404});}),(e:any)=>e.historyExpired===true);
 await assert.rejects(()=>historyPage({historyId:'100'}, {},async()=>{throw Object.assign(Error('limit'),{status:429});}),(e:any)=>!e.historyExpired);
 await assert.rejects(()=>historyPage({historyId:'100'}, {},async()=>({historyId:'99'})),/Ungültige/);
 await assert.rejects(()=>historyPage({historyId:'100'}, {},async()=>({historyId:'101',history:[{id:'101',messagesAdded:Array.from({length:101},(_,i)=>({message:{id:'m'+i}}))}]})),/100 Nachrichten/);
});
test('Erstprüfung erfasst Basis vor Suchabruf; Delta nutzt keine Nachrichtensuche',async()=>{
 const mailbox={id:'box',email:'me@example.com',accessToken:'synthetic',scopes:['https://www.googleapis.com/auth/gmail.readonly']},mails=[{mailboxId:'box',sender:mailbox.email,status:'sent'}],urls:string[]=[];
 const result=await scanDeliveries(mails,mailbox,async(url:string)=>{urls.push(url);return url.endsWith('/profile')?{emailAddress:mailbox.email,historyId:'100'}:{messages:[]};},{syncVersion:1,scopeVersion:2,phase:'full',query:'after:1'});
 assert.ok(urls[0].endsWith('/profile'));assert.equal(result.baselineHistoryId,'100');
 const delta=await scanDeliveries(mails,mailbox,async(url:string)=>{assert.ok(url.includes('/history?'));return {historyId:'101'};},{syncVersion:1,scopeVersion:2,phase:'history',historyId:'100',query:'after:1'});assert.equal(delta.historyId,'101');assert.equal(delta.checked,0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url),{createRelayClient,origin,readStatus}=require('../electron/relay-client.cjs');
const safe={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from('TEST:'+Buffer.from(s).toString('base64')),decryptString:(b:Buffer)=>{assert.ok(b.toString().startsWith('TEST:'));return Buffer.from(b.toString().slice(5),'base64').toString();}};
const stream=randomUUID(),instanceId=randomUUID(),readKey='a'.repeat(64),baseURL='https://tracking.example.com';
const status=(extra={})=>({instanceId,stream,registered:4,observations:12,limits:{tokensPerStream:100,eventsPerStream:200},...extra});
function fixture(t:any,transport:any=async()=>status()){
 const dir=mkdtempSync(join(tmpdir(),'eiz-relay-client-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const client=createRelayClient(dir,safe,transport),input={clientId:randomUUID(),revision:null,baseURL,stream,readKey};return {dir,client,input};
}
test('Relay: Abbruch vor Netzwerk und ausschließlich bestätigte verschlüsselte Persistenz',async t=>{
 let calls=0;const {dir,client,input}=fixture(t,async()=>{calls++;return status();});
 assert.deepEqual(client.status(input.clientId),{revision:null,connection:null});
 assert.equal((await client.connect(input,async(target:{baseURL:string;stream:string})=>{assert.deepEqual(target,{baseURL,stream});return false;})).cancelled,true);assert.equal(calls,0);assert.equal(existsSync(join(dir,'relay-connections.enc')),false);
 const result=await client.connect(input,async()=>true);assert.equal(calls,1);assert.equal(result.connection.instanceId,instanceId);assert.ok(!JSON.stringify(result).includes(readKey));assert.ok(!readFileSync(join(dir,'relay-connections.enc'),'utf8').includes(readKey));
 const restarted=createRelayClient(dir,safe,async()=>status());assert.deepEqual(restarted.status(input.clientId).connection,result.connection);
 assert.equal(client.status(randomUUID()).connection,null);
});
test('Relay: Kundenisolation und keine automatische Neuzuordnung bei Schlüsselwechsel',async t=>{
 const {client,input}=fixture(t);const saved=await client.connect(input,async()=>true);
 await assert.rejects(client.connect({...input,clientId:randomUUID()},async()=>true),/anderen Kunden/);
 await assert.rejects(client.connect({...input,clientId:randomUUID(),stream:randomUUID()},async()=>true),/anderen Kunden/);
 await assert.rejects(client.connect({...input,revision:saved.revision},async()=>true),/bewusst trennen/);
 await assert.rejects(client.check(input.clientId,null),/neu laden/);
});
test('Relay: Instanzwechsel blockiert, Prüfung schreibt keine falsche Identität',async t=>{
 let response=status();const {client,input,dir}=fixture(t,async()=>response);const saved=await client.connect(input,async()=>true),before=readFileSync(join(dir,'relay-connections.enc'));
 response=status({instanceId:randomUUID()});await assert.rejects(client.check(input.clientId,saved.revision),/Dienstkennung hat sich geändert/);assert.deepEqual(readFileSync(join(dir,'relay-connections.enc')),before);
 response=status({observations:16});const checked=await client.check(input.clientId,saved.revision);assert.equal(checked.connection.observations,16);assert.notEqual(checked.revision,saved.revision);
});
test('Relay: Trennung benötigt Bestätigung, alte Revision kann keine Verbindung reaktivieren',async t=>{
 const {client,input,dir}=fixture(t);const saved=await client.connect(input,async()=>true);
 assert.equal((await client.disconnect(input.clientId,saved.revision,async()=>false)).cancelled,true);
 const removed=await client.disconnect(input.clientId,saved.revision,async()=>true);assert.equal(removed.connection,null);assert.notEqual(removed.revision,saved.revision);
 assert.ok(!safe.decryptString(readFileSync(join(dir,'relay-connections.enc'))).includes(readKey));
 await assert.rejects(client.connect(input,async()=>true),/neu laden/);
 assert.ok((await client.connect({...input,revision:removed.revision},async()=>true)).connection);
});
test('Relay: konkurrierende Bestätigungen und globale Streamzuordnung sind geschützt',async t=>{
 let release:any;const wait=new Promise(r=>release=r),{client,input}=fixture(t);const pending=client.connect(input,()=>wait);
 await assert.rejects(client.connect(input,async()=>true),/bereits/);
 await client.connect({...input,clientId:randomUUID()},async()=>true);
 release(true);await assert.rejects(pending,/anderen Kunden/);assert.equal(client.status(input.clientId).connection,null);
});
test('Relay: beschädigter Speicher und fehlende sichere Verschlüsselung verhindern Überschreiben',async t=>{
 const {client,input,dir}=fixture(t);writeFileSync(join(dir,'relay-connections.enc'),'CORRUPT');await assert.rejects(client.connect(input,async()=>true),/beschädigt/);assert.equal(readFileSync(join(dir,'relay-connections.enc'),'utf8'),'CORRUPT');
 assert.throws(()=>createRelayClient(dir,{isEncryptionAvailable:()=>false}).status(input.clientId),/nicht verfügbar/);
 assert.throws(()=>createRelayClient(dir,{...safe,getSelectedStorageBackend:()=> 'basic_text'}).status(input.clientId),/nicht verfügbar/);
});
test('Relay: fremde Streams, unvollständige Statusdaten und falsche Zähler werden nicht gespeichert',async t=>{
 let response:any;const {client,input,dir}=fixture(t,async()=>response);
 for(response of [status({stream:randomUUID()}),status({observations:201}),status({extra:readKey}),status({registered:-1}),{instanceId}])await assert.rejects(client.connect(input,async()=>true));
 assert.equal(existsSync(join(dir,'relay-connections.enc')),false);
});
test('Relay: Dienstadresse erlaubt keine privaten Namen, IPs, Pfade oder Credential-URLs',()=>{
 assert.equal(origin(baseURL+'/'),baseURL);
 for(const value of ['http://example.com','https://127.0.0.1','https://[::1]','https://localhost','https://a.local','https://a.internal','https://a.home','https://x.example.com:444','https://user:pass@example.com','https://example.com/a','https://example.com/?key=a','https://example.com/#hash','https://example.com\n'])assert.throws(()=>origin(value));
});
test('Relay: HTTPS pinnt öffentliches DNS, überträgt Schlüssel nur im Header und folgt keinen Redirects',async()=>{
 const dns=require('node:dns/promises'),https=require('node:https'),oldDNS=dns.lookup,oldRequest=https.request;
 let ips=[{address:'8.8.8.8',family:4}],code=200,body=JSON.stringify(status()),type='application/json',encoding:any=undefined,calls=0,seen:any;
 dns.lookup=async()=>ips;
 https.request=(url:any,options:any,callback:any)=>{
  calls++;seen={url,options};const req:any=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
   const res:any=new EventEmitter();res.statusCode=code;res.headers={'content-type':type,'content-encoding':encoding};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(body));res.emit('end');
  });return req;
 };
 try{
  assert.deepEqual(await readStatus(baseURL,stream,readKey),status());assert.equal(seen.url.href,baseURL+'/v1/status');assert.equal(seen.options.headers.Authorization,'Bearer '+readKey);assert.equal(seen.options.agent,false);
  seen.options.lookup('tracking.example.com',{all:true},(e:any,a:any)=>{assert.equal(e,null);assert.deepEqual(a,ips);});
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','172.31.0.1','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','::1']){const before=calls;ips=[{address:'8.8.8.8',family:4},{address:ip,family:4}];await assert.rejects(readStatus(baseURL,stream,readKey),/fehlgeschlagen/);assert.equal(calls,before);}
  ips=[{address:'8.8.8.8',family:4}];code=302;body=readKey;const before=calls;await assert.rejects(readStatus(baseURL,stream,readKey),e=>{assert.ok(!(e as Error).message.includes(readKey));return true;});assert.equal(calls,before+1);
  code=200;body='x'.repeat(8193);await assert.rejects(readStatus(baseURL,stream,readKey),/fehlgeschlagen/);
  body=JSON.stringify(status());encoding='gzip';await assert.rejects(readStatus(baseURL,stream,readKey));encoding=undefined;type='text/html';await assert.rejects(readStatus(baseURL,stream,readKey));
 }finally{dns.lookup=oldDNS;https.request=oldRequest;}
});

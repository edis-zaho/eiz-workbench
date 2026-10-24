const fs=require('node:fs');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const dns=require('node:dns/promises');
const https=require('node:https');
const {isIP}=require('node:net');
const id=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const key=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function exact(v,names){if(!object(v)||Object.keys(v).length!==names.length||names.some(n=>!Object.hasOwn(v,n)))throw Error('Ungültige Trackingangaben.');}
function origin(value){
 if(typeof value!=='string'||value.length>300||/\s/.test(value))throw Error('Bitte eine öffentliche HTTPS-Dienstadresse ohne Pfad eingeben.');
 let u;try{u=new URL(value);}catch{throw Error('Ungültige Trackingadresse.');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||isIP(u.hostname)||!u.hostname.includes('.')||!u.hostname.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(u.hostname))throw Error('Nur öffentliche HTTPS-Dienstadressen ohne Pfad, Zugangsdaten oder Sonderport sind erlaubt.');
 return u.origin;
}
function publicIP(ip){
 if(isIP(ip)!==4)return false;
 const [a,b,c]=ip.split('.').map(Number);
 return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===88&&c===99))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
function statusValue(v,stream){
 exact(v,['instanceId','stream','registered','observations','limits']);exact(v.limits,['tokensPerStream','eventsPerStream']);
 if(!id(v.instanceId)||v.stream!==stream||![v.registered,v.observations,v.limits.tokensPerStream,v.limits.eventsPerStream].every(n=>Number.isSafeInteger(n)&&n>=0)||v.registered>v.limits.tokensPerStream||v.observations>v.limits.eventsPerStream)throw Error('Trackingdienst liefert keinen gültigen Status für diesen Datenstrom.');
 return v;
}
async function readJSON(base,readKey,path,limit,body){
 origin(base);if(!key(readKey))throw Error('Ungültiger Trackingzugang.');
 const signal=AbortSignal.timeout(15000);
 try{
  const addresses=await new Promise((resolve,reject)=>{
   const abort=()=>reject(Error());signal.addEventListener('abort',abort,{once:true});
   dns.lookup(new URL(base).hostname,{family:4,all:true}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  signal.throwIfAborted();
  if(!addresses.length||addresses.some(a=>a.family!==4||!publicIP(a.address)))throw Error();
  const value=await new Promise((resolve,reject)=>{
   const req=https.request(new URL(path,base),{method:body===undefined?'GET':'POST',signal,agent:false,maxHeaderSize:8192,headers:{Authorization:`Bearer ${readKey}`,Accept:'application/json','Accept-Encoding':'identity',...(body===undefined?{}:{'Content-Type':'application/json'})},lookup:(_h,o,cb)=>o.all?cb(null,[addresses[0]]):cb(null,addresses[0].address,4)},res=>{
    // Never forward a credential through redirects or accept compressed/unbounded bodies.
    if(res.statusCode!==200||!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type']||'')||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(Error());return;}
    let size=0;const chunks=[];
    res.on('data',chunk=>{size+=chunk.length;if(size>limit){req.destroy();reject(Error());return;}chunks.push(chunk);});
    res.on('error',reject);res.on('aborted',()=>reject(Error()));res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error());}});
   });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return value;
 }catch{throw Error('Trackingprüfung fehlgeschlagen. Adresse, Zugangsschlüssel, Datenstrom und öffentliche HTTPS-Erreichbarkeit prüfen. Es wurden keine Signale übernommen.');}
}
async function readStatus(base,stream,readKey){if(!id(stream))throw Error('Ungültiger Datenstrom.');return statusValue(await readJSON(base,readKey,'/v1/status',8192),stream);}
async function readPage(base,stream,readKey,cursor){
 if(!id(stream)||!object(cursor)||Object.keys(cursor).some(k=>!['after','through'].includes(k))||!Number.isSafeInteger(cursor.after)||cursor.after<0||cursor.through!==undefined&&(!Number.isSafeInteger(cursor.through)||cursor.through<cursor.after))throw Error('Ungültiger Abholfortschritt.');
 return readJSON(base,readKey,'/v1/events?after='+cursor.after+(cursor.through===undefined?'':'&through='+cursor.through),512*1024);
}
exports.createRelayClient=(directory,safeStorage,transport=readStatus,pageTransport=readPage,writeTransport=registerBound)=>{
 const file=join(directory,'relay-connections.enc'),busy=new Set();
 function read(){
  if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('Sichere Betriebssystem-Verschlüsselung ist nicht verfügbar.');
  if(!fs.existsSync(file))return {version:1,clients:{}};
  try{
   if(fs.statSync(file).size>2*1024*1024)throw Error();
   const d=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));exact(d,['version','clients']);
   if(d.version!==1||!object(d.clients)||Object.keys(d.clients).length>1000)throw Error();
   for(const [clientId,r] of Object.entries(d.clients)){
    if(!id(clientId)||!id(r?.revision))throw Error();
    exact(r,['revision','connection']);
    if(r.connection!==null){const c=r.connection;exact(c,['baseURL','stream','readKey','instanceId','checkedAt','registered','observations','limits',...(Object.hasOwn(c,'writeKey')?['writeKey']:[])]);if(Object.hasOwn(c,'writeKey')&&(!key(c.writeKey)||c.writeKey===c.readKey))throw Error();if(origin(c.baseURL)!==c.baseURL||!id(c.stream)||!key(c.readKey)||typeof c.checkedAt!=='string'||!/^\d{4}-/.test(c.checkedAt)||new Date(c.checkedAt).toISOString()!==c.checkedAt)throw Error();statusValue({instanceId:c.instanceId,stream:c.stream,registered:c.registered,observations:c.observations,limits:c.limits},c.stream);}
   }return d;
  }catch{throw Error('Tracking-Schlüsselspeicher ist beschädigt oder nicht entschlüsselbar. Die vorhandene Datei wurde nicht verändert.');}
 }
 function current(d,clientId,revision){if(!id(clientId)||revision!==null&&!id(revision))throw Error('Ungültiger Kunde oder Verbindungsstand.');if((d.clients[clientId]?.revision??null)!==revision)throw Error('Trackingverbindung wurde geändert. Bitte neu laden.');}
 function view(d,clientId){if(!id(clientId))throw Error('Ungültiger Kunde.');const r=d.clients[clientId],c=r?.connection;return {revision:r?.revision??null,connection:c?{baseURL:c.baseURL,stream:c.stream,instanceId:c.instanceId,checkedAt:c.checkedAt,registered:c.registered,observations:c.observations,limits:c.limits,canRegister:!!c.writeKey}:null};}
 function write(d,clientId,connection){if(!d.clients[clientId]&&Object.keys(d.clients).length>=1000)throw Error('Maximal 1.000 Trackingzuordnungen.');d.clients[clientId]={revision:randomUUID(),connection};const encrypted=safeStorage.encryptString(JSON.stringify(d));fs.writeFileSync(file+'.tmp',encrypted,{flush:true});fs.renameSync(file+'.tmp',file);return view(d,clientId);}
 async function locked(clientId,action){if(busy.has(clientId))throw Error('Für diesen Kunden läuft bereits eine Trackingprüfung.');busy.add(clientId);try{return await action();}finally{busy.delete(clientId);}}
 function unique(d,clientId,stream,readKey){if(Object.entries(d.clients).some(([other,r])=>other!==clientId&&r.connection&&(r.connection.stream===stream||r.connection.readKey===readKey)))throw Error('Datenstrom oder Leseschlüssel ist bereits einem anderen Kunden zugeordnet.');}
 return {
  async withConnection(clientId,revision,work){return locked(clientId,async()=>{
   const d=read();current(d,clientId,revision);const c=d.clients[clientId]?.connection;if(!c)throw Error('Trackingdienst ist nicht verbunden.');
   const assertCurrent=()=>current(read(),clientId,revision);
   return work({identity:{baseURL:c.baseURL,stream:c.stream,instanceId:c.instanceId},assertCurrent,register:async registration=>{assertCurrent();if(!c.writeKey)throw Error('Tracking-Schreibschlüssel fehlt.');const result=await writeTransport(c.baseURL,c.stream,c.instanceId,c.writeKey,registration);assertCurrent();return result;},readPage:async cursor=>{assertCurrent();const page=await pageTransport(c.baseURL,c.stream,c.readKey,cursor);assertCurrent();return page;}});
  });},
  async setWriter(clientId,revision,writeKey){return locked(clientId,async()=>{const d=read();current(d,clientId,revision);const c=d.clients[clientId]?.connection;if(!c||!key(writeKey)||writeKey===c.readKey)throw Error('Gültigen separaten Schreibschlüssel eingeben.');return write(d,clientId,{...c,writeKey});});},
  status(clientId){return view(read(),clientId);},
  async connect(input,confirm){
   exact(input,['clientId','revision','baseURL','stream','readKey']);const {clientId,revision,stream,readKey}=input,baseURL=origin(input.baseURL);
   if(!id(stream)||!key(readKey))throw Error('Datenstrom muss eine UUID und Leseschlüssel muss 64 kleine Hexadezimalzeichen enthalten.');
   return locked(clientId,async()=>{
    const before=read();current(before,clientId,revision);unique(before,clientId,stream,readKey);
    if(before.clients[clientId]?.connection)throw Error('Vor einem neuen Zugang die bestehende Verbindung bewusst trennen.');
    if(!await confirm({baseURL,stream}))return {cancelled:true,...view(read(),clientId)};
    current(read(),clientId,revision);
    const result=statusValue(await transport(baseURL,stream,readKey),stream),latest=read();current(latest,clientId,revision);unique(latest,clientId,stream,readKey);
    return {cancelled:false,...write(latest,clientId,{baseURL,stream,readKey,...result,checkedAt:new Date().toISOString()})};
   });
  },
  async check(clientId,revision){return locked(clientId,async()=>{
   const d=read();current(d,clientId,revision);const c=d.clients[clientId]?.connection;if(!c)throw Error('Trackingdienst ist nicht verbunden.');
   const result=statusValue(await transport(c.baseURL,c.stream,c.readKey),c.stream);
   if(result.instanceId!==c.instanceId)throw Error('Dienstkennung hat sich geändert, beispielsweise nach einer Wiederherstellung. Verbindung bewusst trennen und erneut prüfen. Keine Signale übernommen.');
   const latest=read();current(latest,clientId,revision);return write(latest,clientId,{...c,...result,checkedAt:new Date().toISOString()});
  });},
  async disconnect(clientId,revision,confirm){return locked(clientId,async()=>{
   const d=read();current(d,clientId,revision);const c=d.clients[clientId]?.connection;
   if(!c||!await confirm({baseURL:c.baseURL,stream:c.stream}))return {cancelled:true,...view(read(),clientId)};
   const latest=read();current(latest,clientId,revision);return {cancelled:false,...write(latest,clientId,null)};
  });}
 };
};
exports.readStatus=readStatus;
exports.origin=origin;

exports.readPage=readPage;

async function registerBound(baseURL,stream,instanceId,writeKey,registration){
 const v=await readJSON(baseURL,writeKey,'/v1/register-bound',8192,{stream,instanceId,registration});
 exact(v,['registered','repeated','revoked']);if(v.registered!==true||typeof v.repeated!=='boolean'||v.revoked!==false)throw Error('Trackingregistrierung nicht bestätigt oder bereits widerrufen.');return v;
}
exports.registerBound=registerBound;

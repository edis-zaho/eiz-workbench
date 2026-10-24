const { createServer } = require('node:http');
const { randomBytes, createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {scanDeliveries}=require('./delivery-scan.cjs');
const {readConversation}=require('./inbox.cjs');
const {readThreadContext}=require('./thread-context.cjs');
const {findSent,READ_SCOPE}=require('./reconcile.cjs');
const SEND_SCOPE='https://www.googleapis.com/auth/gmail.send';
const SCOPES=['openid','email',SEND_SCOPE];
const TOKEN='https://oauth2.googleapis.com/token';
const USERINFO='https://openidconnect.googleapis.com/v1/userinfo';
const SEND='https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const PROFILE='https://gmail.googleapis.com/gmail/v1/users/me/profile';
const emailOK=s=>typeof s==='string'&&s.length<=254&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
function error(message,kind='failed'){return Object.assign(new Error(message),{kind});}
function configFromJSON(text){
  if(typeof text!=='string'||text.length>20000)throw error('Ungültige Google-Konfigurationsdatei.');
  let c;try{c=JSON.parse(text).installed;}catch{}
  if(!c||typeof c.client_id!=='string'||!/^[-a-zA-Z0-9]+\.apps\.googleusercontent\.com$/.test(c.client_id)||typeof c.client_secret!=='string'||!c.client_secret||c.client_secret.length>512||/\s/.test(c.client_secret))throw error('Bitte die JSON-Konfiguration eines Google-OAuth-Clients vom Typ Desktop-App auswählen. Kein API-Schlüssel und kein Dienstkonto.');
  return {clientId:c.client_id,clientSecret:c.client_secret};
}
function createGoogleVault(directory,safeStorage){
  const filename=join(directory,'google-mail.enc');
  function read(){if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw error('Windows-Verschlüsselung ist nicht verfügbar.');if(!existsSync(filename))return {config:null,mailboxes:{}};try{const d=JSON.parse(safeStorage.decryptString(readFileSync(filename)));if(!d||!d.mailboxes||typeof d.mailboxes!=='object'||Array.isArray(d.mailboxes))throw Error();return d;}catch{throw error('Google-Zugangsspeicher kann nicht gelesen werden. Vorhandene Datei bleibt erhalten.');}}
  function save(d){read();writeFileSync(filename+'.tmp',safeStorage.encryptString(JSON.stringify(d)),{flush:true});renameSync(filename+'.tmp',filename);}
  return {read,save};
}
async function jsonRequest(url,options,fetcher=fetch){
  let response;try{response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw error('Google ist nicht erreichbar. Verbindung prüfen.');}
  if(!response.ok){if([400,401].includes(response.status))throw error('Google-Zugang abgelehnt oder abgelaufen. Bitte erneut verbinden.');if(response.status===403)throw error('Google verweigert den Zugriff. Gmail API, Berechtigungen und Workspace-Richtlinien prüfen.');if(response.status===429)throw error('Google-Limit erreicht. Bitte später erneut prüfen.');throw Object.assign(error(`Google-Anfrage fehlgeschlagen (HTTP ${response.status}).`),{status:response.status});}
  try{return await response.json();}catch{throw error('Google lieferte keine verwertbare Antwort.');}
}
async function identity(accessToken,fetcher){const user=await jsonRequest(USERINFO,{headers:{Authorization:`Bearer ${accessToken}`}},fetcher);if(typeof user.sub!=='string'||!user.sub||user.email_verified!==true||!emailOK(user.email))throw error('Google hat keine bestätigte E-Mail-Adresse geliefert.');return {sub:user.sub,email:user.email.toLowerCase()};}
function tokenShape(t){if(typeof t.access_token!=='string'||!t.access_token||t.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(t.expires_in)||t.expires_in<=0)throw error('Google lieferte keine gültigen Zugangsdaten.');return t;}
async function startOAuth(config,openExternal,{fetcher=fetch,timeoutMs=300000,readAccess=false}={}){
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  let settle,timer,finished=false;
  const callback=new Promise((resolve,reject)=>{settle={resolve,reject};});
  // Avoid an unhandled rejection while the external browser is being opened.
  callback.catch(()=>{});
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    const url=new URL(req.url||'/','http://127.0.0.1');
    if(req.method!=='GET'||url.pathname!=='/'||req.headers.host!==`127.0.0.1:${server.address()?.port}`){res.writeHead(404);res.end('Nicht gefunden.');return;}
    const received=Buffer.from(url.searchParams.get('state')||''),expected=Buffer.from(state);
    if(received.length!==expected.length||!timingSafeEqual(received,expected)){res.writeHead(400);res.end('Anmeldung passt nicht zur gestarteten Verbindung.');return;}
    if(finished){res.writeHead(409);res.end('Anmeldung bereits abgeschlossen.');return;}
    finished=true;clearTimeout(timer);res.end('Anmeldung empfangen. Bitte zur Workbench zurueckkehren und dort das Ergebnis pruefen.');server.close();
    if(url.searchParams.has('error'))settle.reject(error('Google-Anmeldung wurde abgebrochen oder nicht genehmigt.'));
    else{const code=url.searchParams.get('code');if(!code||code.length>4096)settle.reject(error('Google lieferte keinen gültigen Anmeldecode.'));else settle.resolve(code);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const redirect=`http://127.0.0.1:${server.address().port}`;
  const cancel=()=>{if(finished)return;finished=true;clearTimeout(timer);server.close();settle.reject(error('Google-Anmeldung abgebrochen.'));};
  timer=setTimeout(()=>{cancel();},timeoutMs);timer.unref?.();
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  Object.entries({client_id:config.clientId,redirect_uri:redirect,response_type:'code',scope:[...SCOPES,...(readAccess?[READ_SCOPE]:[])].join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).forEach(([k,v])=>url.searchParams.set(k,v));
  const result=(async()=>{try{await openExternal(url.href);const code=await callback;const tokens=tokenShape(await jsonRequest(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'}).toString()},fetcher));if(typeof tokens.refresh_token!=='string'||!tokens.refresh_token)throw error('Kein dauerhafter Google-Zugang erhalten. Erneut verbinden und Zugriff erlauben.');if(!String(tokens.scope||'').split(' ').includes(SEND_SCOPE))throw error('Die Berechtigung zum E-Mail-Versand wurde nicht erteilt.');if(readAccess&&!String(tokens.scope||'').split(' ').includes(READ_SCOPE))throw error('Der lesende Gmail-Zugriff wurde nicht erteilt. Bestehende Verbindung bleibt erhalten.');return {scopes:String(tokens.scope||'').split(' '),...await identity(tokens.access_token,fetcher),refreshToken:tokens.refresh_token,accessToken:tokens.access_token,expiresAt:Date.now()+tokens.expires_in*1000};}finally{cancel();}})();
  return {result,cancel};
}
function makeRawMail(mail){
  if(mail.presentation){const p=mail.presentation;if(p.fromEmail!==mail.sender||p.to!==mail.recipient||p.subject!==mail.subject||p.bodyText!==mail.body||mail.tracking)throw error('Freigegebene Maildarstellung passt nicht zum Auftrag.');return require('./mail-mime.cjs').encodeMime(p,mail.messageId);}
  if(!emailOK(mail.sender)||!emailOK(mail.recipient)||typeof mail.subject!=='string'||!mail.subject.trim()||mail.subject.length>120||/[\r\n\0]/.test(mail.subject)||typeof mail.body!=='string'||!mail.body.trim()||mail.body.length>4000||mail.body.includes('\0')||!/^<[a-f0-9-]{36}@workbench\.local>$/.test(mail.messageId))throw error('Ungültige Testnachricht.');
  const subject=Array.from(mail.subject).reduce((chunks,c)=>{if(Buffer.byteLength(chunks[chunks.length-1]+c)>30)chunks.push(c);else chunks[chunks.length-1]+=c;return chunks;},['']).map(s=>`=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
  const body=Buffer.from(mail.body.replace(/\r?\n/g,'\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
  if(mail.tracking){
    let html;try{html=require('./tracking.cjs').renderTracking(mail,mail.tracking);}catch(e){throw error(e.message);}
    const boundary='eiz-'+createHash('sha256').update(mail.messageId).digest('hex');
    const encoded=Buffer.from(html).toString('base64').match(/.{1,76}/g).join('\r\n');
    return Buffer.from(`From: ${mail.sender}\r\nTo: ${mail.recipient}\r\nSubject: ${subject}\r\nMessage-ID: ${mail.messageId}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n--${boundary}--\r\n`).toString('base64url');
  }
  return Buffer.from(`From: ${mail.sender}\r\nTo: ${mail.recipient}\r\nSubject: ${subject}\r\nMessage-ID: ${mail.messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`).toString('base64url');
}
async function sendOnce(mail,accessToken,fetcher=fetch){
  const raw=makeRawMail(mail);let response;
  try{response=await fetcher(SEND,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({raw}),signal:AbortSignal.timeout(30000)});}catch{throw error('Versandergebnis unklar. In Gmail unter Gesendet prüfen. Nicht automatisch erneut senden.','unknown');}
  if(!response.ok)throw error([400,401,403,404].includes(response.status)?`Google hat die Testnachricht abgelehnt (HTTP ${response.status}). Berechtigungen und Gmail API prüfen.`:'Versandergebnis unklar. In Gmail prüfen; keine automatische Wiederholung.',[400,401,403,404].includes(response.status)?'failed':'unknown');
  let data;try{data=await response.json();}catch{}if(typeof data?.id!=='string'||!data.id)throw error('Google-Antwort unvollständig. Versand in Gmail prüfen.','unknown');return {providerId:data.id};
}
function createGoogleService({directory,safeStorage,openExternal,fetcher=fetch}){
  const vault=createGoogleVault(directory,safeStorage);let busy=false,pending,cancelRequested=false;
  async function exclusive(fn){if(busy)throw error('Ein Postfachvorgang läuft bereits.');busy=true;cancelRequested=false;try{return await fn();}finally{busy=false;pending=undefined;}}
  function status(clientId){const d=vault.read(),m=d.mailboxes[clientId];return {configured:!!d.config,busy,mailbox:m?{id:m.id,email:m.email,connectedAt:m.connectedAt,checkedAt:m.checkedAt||null,sendAccess:!!m.scopes?.includes(SEND_SCOPE),readAccess:!!m.scopes?.includes(READ_SCOPE)}:null};}
  async function access(clientId){const d=vault.read(),m=d.mailboxes[clientId];if(!m||!d.config)throw error('Bitte zuerst ein Google-Postfach verbinden.');if(m.expiresAt<Date.now()+60000){const t=tokenShape(await jsonRequest(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:d.config.clientId,client_secret:d.config.clientSecret,refresh_token:m.refreshToken,grant_type:'refresh_token'}).toString()},fetcher));m.accessToken=t.access_token;m.expiresAt=Date.now()+t.expires_in*1000;if(t.refresh_token)m.refreshToken=t.refresh_token;if(typeof t.scope==='string')m.scopes=t.scope.split(' ');vault.save(d);}const user=await identity(m.accessToken,fetcher);if(user.sub!==m.sub||user.email!==m.email)throw error('Google-Konto stimmt nicht mit dem gespeicherten Postfach überein. Bitte neu verbinden.');m.checkedAt=new Date().toISOString();vault.save(d);return m;}
  return {status,async revoke(clientId){return exclusive(async()=>{const d=vault.read(),m=d.mailboxes[clientId];delete d.mailboxes[clientId];vault.save(d);if(!m)return {localDisconnected:true,remoteRevoked:null};let r;try{r=await fetcher('https://oauth2.googleapis.com/revoke',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:m.refreshToken}).toString(),signal:AbortSignal.timeout(30000)});}catch{return {localDisconnected:true,remoteRevoked:false};}return {localDisconnected:true,remoteRevoked:r.ok};});},cancel(){cancelRequested=true;pending?.cancel();},configure(text){if(busy)throw error('Bitte laufenden Postfachvorgang abwarten.');const d=vault.read(),config=configFromJSON(text);if(Object.keys(d.mailboxes).length&&JSON.stringify(d.config)!==JSON.stringify(config))throw error('Vor Wechsel der Google-Konfiguration alle Postfächer lokal trennen.');d.config=config;vault.save(d);return {configured:true};},connect(clientId,approve,readAccess=false){return exclusive(async()=>{const d=vault.read();if(!d.config)throw error('Bitte zuerst die Google-Desktop-Konfiguration importieren.');pending=await startOAuth(d.config,openExternal,{fetcher,readAccess});const account=await pending.result;if(cancelRequested)throw error('Google-Anmeldung abgebrochen.');if(readAccess&&d.mailboxes[clientId]&&d.mailboxes[clientId].sub!==account.sub)throw error('Lesezugriff muss fuer das bereits zugeordnete Google-Konto erteilt werden.');if(Object.entries(d.mailboxes).some(([id,m])=>id!==clientId&&m.sub===account.sub))throw error('Dieses Konto ist bereits einem anderen Kunden zugeordnet.');if(!await approve(account.email)||cancelRequested)return {cancelled:true};d.mailboxes[clientId]={...account,id:d.mailboxes[clientId]?.sub===account.sub?d.mailboxes[clientId].id:randomUUID(),connectedAt:new Date().toISOString(),checkedAt:new Date().toISOString()};vault.save(d);return status(clientId);});},check(clientId){return exclusive(async()=>{await access(clientId);return status(clientId);});},verifyRead(clientId){return exclusive(async()=>{const m=await access(clientId);if(!m.scopes?.includes(READ_SCOPE))throw error('Lesender Gmail-Zugriff fehlt. Bitte für dieses Postfach freigeben.');const profile=await jsonRequest(PROFILE,{headers:{Authorization:`Bearer ${m.accessToken}`}},fetcher);if(typeof profile.emailAddress!=='string'||profile.emailAddress.toLowerCase()!==m.email||!/^\d+$/.test(String(profile.historyId||'')))throw error('Gmail-Profil passt nicht zum verbundenen Postfach. Bitte neu verbinden.');return {mailboxId:m.id,email:m.email,checkedAt:new Date().toISOString(),readVerified:true};});},disconnect(clientId){if(busy)throw error('Bitte laufenden Postfachvorgang abwarten.');const d=vault.read();delete d.mailboxes[clientId];vault.save(d);return status(clientId);},disconnectAll(){if(busy)throw error('Postfachvorgang läuft.');const d=vault.read();d.mailboxes={};vault.save(d);},withMailbox(clientId,fn){return exclusive(async()=>fn(await access(clientId)));},scanDeliveries:(mails,mailbox,progress)=>scanDeliveries(mails,mailbox,(url,options)=>jsonRequest(url,options,fetcher),progress),readThreadContext:(mail,incoming,mailbox)=>readThreadContext(mail,incoming,mailbox,(url,options)=>jsonRequest(url,options,fetcher)),readConversation:(mail,mailbox)=>readConversation(mail,mailbox,(url,options)=>jsonRequest(url,options,fetcher)),findSent:(mail,mailbox)=>findSent(mail,mailbox,(url,options)=>jsonRequest(url,options,fetcher)),sendOnce:(mail,token)=>sendOnce(mail,token,fetcher)};
}
module.exports={configFromJSON,createGoogleVault,startOAuth,makeRawMail,sendOnce,createGoogleService,SEND_SCOPE};

const {makeRawMail}=require('./google.cjs');
function rawReply(mail){
 if(typeof mail.threadId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(mail.threadId)||typeof mail.inReplyTo!=='string'||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(mail.inReplyTo)||mail.inReplyTo.length>254)throw Object.assign(Error('Ungültige Gesprächsreferenz.'),{kind:'failed'});
 if(mail.presentation){if(mail.presentation.inReplyTo!==mail.inReplyTo)throw Error('Antwortreferenz geändert.');return makeRawMail(mail);}
 const raw=Buffer.from(makeRawMail(mail),'base64url').toString('utf8');
 return Buffer.from(`In-Reply-To: ${mail.inReplyTo}\r\nReferences: ${mail.inReplyTo}\r\n${raw}`,'utf8').toString('base64url');
}
async function sendReplyOnce(mail,token,fetcher=fetch){
 const raw=rawReply(mail);let response;
 try{response=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw,threadId:mail.threadId}),signal:AbortSignal.timeout(30000)});}catch{throw Object.assign(Error('Antwortversand unklar. Gmail abgleichen; nicht erneut senden.'),{kind:'unknown'});}
 if(!response.ok)throw Object.assign(Error(`Antwortversand HTTP ${response.status}. Gmail und Berechtigungen prüfen.`),{kind:[400,401,403,404].includes(response.status)?'failed':'unknown'});
 let d;try{d=await response.json();}catch{}
 if(!d||typeof d.id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(d.id)||d.threadId!==mail.threadId)throw Object.assign(Error('Google-Annahme oder Gesprächszuordnung unklar. Gmail abgleichen.'),{kind:'unknown'});
 return {providerId:d.id};
}
async function dispatchDialogue({google,request,data,stopping=()=>false,send=sendReplyOnce}){
 if(data.confirmed!==true)throw Error('Antwortversand nicht bestätigt.');
 const base=`/api/clients/${data.clientId}/dialogue/${data.incomingId}`;
 return google.withMailbox(data.clientId,async mailbox=>{
  if(stopping())throw Error('Workbench wird beendet.');
  if(!mailbox.scopes?.includes('https://www.googleapis.com/auth/gmail.send'))throw Error('Google-Versandberechtigung fehlt.');
  const p=await request(base+'/preview',{draftId:data.draftId});
  if(p.basisHash!==data.basisHash||mailbox.id!==p.snapshot.mailboxId||mailbox.email!==p.snapshot.sender)throw Error('Vorschau oder Postfach geändert.');
  const source=await request(`/api/clients/${data.clientId}/thread-context/${data.incomingId}/setup`,{},'GET');
  const capture=await google.readThreadContext(source.mail,source.incoming,mailbox);
  if(stopping())throw Error('Workbench wird beendet.');
  const mail=await request(base+'/reserve',{draftId:data.draftId,basisHash:data.basisHash,confirmed:true,mailboxId:mailbox.id,sender:mailbox.email,capture,...(data.autoAttemptId?{autoAttemptId:data.autoAttemptId}:{})});
  const path=`/api/clients/${data.clientId}/dialogue-send/${mail.id}`;let result,prepared={mail,check:()=>{}};
  try{if(stopping())throw Error('Workbench wird beendet.');if(google.prepareTracking)prepared=await google.prepareTracking(mail);await request(path+'/authorize',{mailboxId:mailbox.id,sender:mailbox.email});prepared.check();if(stopping())throw Error('Workbench wird beendet.');}
  catch(e){result={status:'failed',providerId:'',result:('Vor Gmail angehalten: '+e.message).slice(0,2000)};}
  if(!result)try{const r=await send(prepared.mail,mailbox.accessToken);result={status:'sent',providerId:r.providerId,result:'Von Google im Gespräch angenommen. Zustellung nicht bestätigt.'};}catch(e){result={status:e.kind==='failed'?'failed':'unknown',providerId:'',result:(e.message||'Versandergebnis unklar.').slice(0,2000)};}
  try{await request(path+'/finish',result);return {mailId:mail.id,status:result.status,saved:true};}catch{try{await request(path+'/finish',{status:'unknown',providerId:'',result:'Lokaler Versandabschluss nicht bestätigt. Gmail abgleichen; keine Wiederholung.'});}catch{}return {mailId:mail.id,status:'unknown',saved:false};}
 });
}
module.exports={rawReply,sendReplyOnce,dispatchDialogue};

const {sendReplyOnce}=require('./dialogue.cjs');
const {historyPage}=require('./history-page.cjs');
const implemented=Object.freeze({send:true,read:true,incrementalSync:true,threadedReply:true,reconcileSent:true});
function createGmailProvider({google,fetcher=fetch,stop=async()=>{},syncStatus=()=>null}){
 function status(clientId){
  const legacy=google.status(clientId),m=legacy.mailbox,sync=syncStatus(clientId);
  const granted={send:!!m?.sendAccess,read:!!m?.readAccess};
  const fresh=!!m&&sync?.mailboxId===m.id&&sync?.verified===true&&typeof sync?.lastSyncAt==='string'&&Date.now()-Date.parse(sync.lastSyncAt)>=0&&Date.now()-Date.parse(sync.lastSyncAt)<120000;
  return {identity:m?{providerKind:'gmail',connectionId:m.id,email:m.email,checkedAt:m.checkedAt||null}:null,
   implemented,granted,readiness:!m?'disconnected':!granted.send||!granted.read?'needs-auth':fresh?'ready':'needs-read-check',lastSyncAt:fresh?sync.lastSyncAt:null};
 }
 async function withSession(clientId,use){
  return google.withMailbox(clientId,async m=>{
   const session={
    identity:{providerKind:'gmail',connectionId:m.id,email:m.email,checkedAt:m.checkedAt||null},
    sendOnce:mail=>google.sendOnce(mail,m.accessToken),
    sendReplyOnce:mail=>sendReplyOnce(mail,m.accessToken,fetcher),
    readConversation:mail=>google.readConversation(mail,m),
    readThreadContext:(mail,incoming)=>google.readThreadContext(mail,incoming,m),
    reconcileSent:mail=>google.findSent(mail,m),
    syncPage:progress=>historyPage(progress,{headers:{Authorization:`Bearer ${m.accessToken}`}},async(url,options)=>{
     const r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});
     if(!r.ok)throw Object.assign(Error(`Gmail-Abgleich HTTP ${r.status}`),{status:r.status});return r.json();
    })
   };
   return use(Object.freeze(session));
  });
 }
 async function disconnect(clientId,mode){
  if(!['local','revoke'].includes(mode))throw Error('Ungültige Trennung.');
  await stop(clientId);
  if(mode==='local'){google.disconnect(clientId);return {localDisconnected:true,remoteRevoked:null};}
  try{return await google.revoke(clientId);}
  catch{google.disconnect(clientId);return {localDisconnected:true,remoteRevoked:false};}
 }
 // Compatibility methods keep the already-tested native mailbox lease intact.
 // Tokens in withMailbox never cross IPC; new consumers use withSession instead.
 return {...google,mailStatus:status,status:google.status,withSession,disconnectProvider:disconnect,
  provider:{status,withSession,disconnect}};
}
module.exports={createGmailProvider};

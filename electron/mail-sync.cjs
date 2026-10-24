// One bounded page per invocation. A failed page can be read again; inbox inserts deduplicate.
async function runMailSync({clientId,force=false,google,request,stopping=()=>false}){
 const base=`/api/clients/${clientId}`,state=await request(base+'/mail-sync',{},'GET');
 if(!state.enabled)throw Error('Automatische Synchronisation ist nicht aktiviert.');
 const claim=await request(base+'/mail-sync/claim',{mailboxId:state.mailboxId,force});let checked=0,added=0;const deadline=Date.now()+85000;
 try{
  const mailbox=google.status(clientId).mailbox;if(!mailbox?.readAccess)throw Error('Lesender Gmail-Zugriff fehlt. Synchronisation angehalten.');
  await google.withMailbox(clientId,async active=>{
   if(active.id!==state.mailboxId)throw Error('Postfach wurde geändert. Synchronisation angehalten.');
   for(const mail of claim.messages){
    if(stopping()||Date.now()>=deadline)break;
    const result=await google.readConversation(mail,active),saved=await request(base+`/mail-tests/${mail.id}/conversation`,{...result,mailboxId:active.id,clientVersion:claim.clientVersion});checked++;added+=saved.added;
   }
  });
  return await request(base+'/mail-sync/finish',{mailboxId:state.mailboxId,leaseId:claim.leaseId,success:true,checked,added});
 }catch(e){try{await request(base+'/mail-sync/finish',{mailboxId:state.mailboxId,leaseId:claim.leaseId,success:false,error:e.message||'Synchronisation fehlgeschlagen.'});}catch{}throw e;}
}
module.exports={runMailSync};

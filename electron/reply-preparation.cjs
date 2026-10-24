async function savePreparation({google,vault,request,data}){
 if(!data||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('Ungültiger Kunde.');const {clientId,...input}=data,path=`/api/clients/${clientId}/reply-preparation/policy`;
 if(input.enabled===false)return request(path,input);
 const allowed=['expectedId','enabled','productId','factIds','basisHash','dailyLimit','actor','reason','confirmed'];if(Object.keys(input).length!==allowed.length||allowed.some(k=>!Object.hasOwn(input,k))||input.confirmed!==true)throw Error('Ungültige Übertragungsfreigabe.');
 const setup=await request(`/api/clients/${clientId}/reply-preparation/basis`,{productId:input.productId,factIds:input.factIds});if(setup.basisHash!==input.basisHash)throw Error('Übertragungsrahmen geändert.');vault.key(setup.basis.binding||setup.basis.provider);
 return google.withMailbox(clientId,async mailbox=>{if(!mailbox.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly'))throw Error('Google-Leseberechtigung fehlt.');return request(path,{...input,mailboxId:mailbox.id,sender:mailbox.email});});
}
async function runPreparation({google,vault,request,callModel,clientId,stopping=()=>false}){
 const due=await request('/api/reply-preparation-due',{},'GET');let attempted=0;
 for(const row of due){if(stopping())break;if(clientId&&row.clientId!==clientId)continue;const base=`/api/clients/${row.clientId}`,path=base+'/reply-preparation';let claim,run,modelFinished=false,reason;
  try{claim=await request(path+'/claim',{incomingId:row.incomingId,policyId:row.policyId});}catch{continue;}attempted++;
  try{
   await google.withMailbox(row.clientId,async mailbox=>{const guard=await request(path+`/${claim.id}/source`,{},'GET');if(mailbox.id!==guard.policy.mailboxId||mailbox.email!==guard.policy.sender)throw Error('Freigegebenes Postfach geändert.');if(stopping())throw Error('Workbench wird beendet.');const capture=await google.readThreadContext(guard.source.mail,guard.source.incoming,mailbox);await request(base+`/thread-context/${row.incomingId}`,{basisHash:guard.source.basisHash,expectedId:guard.source.expectedId,capture});});
   const setup=await request(path+`/${claim.id}/context`,{},'GET'),key=setup.binding?undefined:vault.key(setup.provider);if(stopping())throw Error('Workbench wird beendet.');
   run=await request(base+`/reply-writing/${row.incomingId}/reserve`,{productId:setup.context.productId,factIds:setup.context.factIds,basisHash:setup.basisHash,confirmed:true,preparationClaimId:claim.id});
   await request(path+`/${claim.id}/authorize`,{runId:run.id});if(stopping())throw Error('Workbench wird beendet.');
   let outcome;try{const r=await callModel({...run,key,automatic:!!run.binding});outcome={status:'completed',text:r.text,usage:r.usage};}catch(e){outcome={status:e.kind||'unknown',text:'',usage:{}};}
   // No provider retry, including when the local finish response is lost.
   modelFinished=true;await request(base+`/reply-writing/${row.incomingId}/${run.id}/finish`,outcome);reason='Modellauftrag abgeschlossen. Ergebnis und gegebenenfalls separate Textentscheidung im Verlauf prüfen.';
  }catch(e){reason='Vorbereitung angehalten: '+(e.message||'Unbekannte Ursache');if(run&&!modelFinished)try{await request(base+`/reply-writing/${row.incomingId}/${run.id}/finish`,{status:'failed',text:'',usage:{}});}catch{}}
  try{await request(path+`/${claim.id}/finish`,{reason:reason.slice(0,2000)});}catch{}
 }
 return {attempted};
}
module.exports={savePreparation,runPreparation};

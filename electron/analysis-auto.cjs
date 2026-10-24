async function saveAnalysisAuto({google,vault,request,data}){
 if(!data||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId))throw Error('Ungültiger Kunde.');const {clientId,...input}=data,path=`/api/clients/${clientId}/analysis-auto`;
 if(input.enabled===false)return request(path+'/policy',input);
 const keys=['expectedId','enabled','basisHash','dailyLimit','actor','reason','confirmed'];if(Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k))||input.confirmed!==true)throw Error('Ungültige Analysefreigabe.');const b=await request(path+'/basis',{},'GET');if(b.basisHash!==input.basisHash)throw Error('Analysegrundlage geändert.');vault.key(b.basis.binding||b.basis.provider);
 return google.withMailbox(clientId,async mailbox=>{if(!mailbox.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly'))throw Error('Google-Leseberechtigung fehlt.');return request(path+'/policy',{...input,mailboxId:mailbox.id,sender:mailbox.email});});
}
async function runAnalysisAuto({google,vault,request,callModel,clientId,stopping=()=>false}){
 const due=await request('/api/analysis-auto-due',{},'GET');let attempted=0;
 for(const d of due){if(stopping())break;if(clientId&&d.clientId!==clientId)continue;const base=`/api/clients/${d.clientId}`;let run,providerStarted=false,stage='key';
  try{run=await request(base+`/reply-analysis/${d.eventId}/reserve`,{basisHash:d.basisHash,confirmed:true,autoPolicyId:d.policyId});}catch{continue;}attempted++;
  try{const key=run.binding?undefined:vault.key(run.provider);if(stopping()){stage='stopped';throw Error('Workbench wird beendet.');}stage='mailbox';await google.withMailbox(d.clientId,async mailbox=>{if(!mailbox.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly'))throw Error('Google-Leseberechtigung fehlt.');stage='authorization';await request(base+`/analysis-auto/${run.id}/authorize`,{mailboxId:mailbox.id,sender:mailbox.email});});if(stopping()){stage='stopped';throw Error('Workbench wird beendet.');}providerStarted=true;let outcome;try{const r=await callModel({...run,key,automatic:!!run.binding});outcome={status:'completed',text:r.text,usage:r.usage};}catch(e){outcome={status:e.kind||'unknown',text:'',usage:{},failureCode:'provider'};}stage='storage';await request(base+`/reply-analysis/${run.id}/finish`,outcome);
  }catch{try{await request(base+`/reply-analysis/${run.id}/finish`,{status:providerStarted?'unknown':'failed',text:'',usage:{},failureCode:stage});}catch{ /* Durable run blocks retries; expiry releases a lost local completion. */ }}
 }return {attempted};
}
module.exports={saveAnalysisAuto,runAnalysisAuto};

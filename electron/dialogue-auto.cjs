const {dispatchDialogue}=require('./dialogue.cjs');
async function saveDialogueAutoPolicy({google,request,data}){
 const keys=['clientId','expectedId','clientVersion','briefRevision','stopEpoch','rules','actor','reason','confirmed'];
 if(!data||Object.keys(data).length!==keys.length||keys.some(k=>!Object.hasOwn(data,k))||typeof data.clientId!=='string'||!/^[a-f0-9-]{36}$/.test(data.clientId)||data.confirmed!==true)throw Error('Ungültige Automatikfreigabe.');
 const {clientId,...input}=data,path=`/api/clients/${clientId}/dialogue-auto/policy`;
 if(input.rules?.enabled===false)return request(path,{...input,mailboxId:'',sender:''});
 return google.withMailbox(clientId,async mailbox=>{
  if(!['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'].every(scope=>mailbox.scopes?.includes(scope)))throw Error('Google-Lese- und Versandberechtigung erforderlich.');
  return request(path,{...input,mailboxId:mailbox.id,sender:mailbox.email});
 });
}
async function runDialogueAuto({google,request,clientId,stopping=()=>false,dispatch=dispatchDialogue}){
 const due=await request('/api/dialogue-auto-due',{},'GET');let attempted=0;
 for(const row of due){if(stopping())break;if(clientId&&row.clientId!==clientId)continue;const path=`/api/clients/${row.clientId}/dialogue-auto`;let claim;
  try{claim=await request(path+'/claim',{policyId:row.policyId,incomingId:row.incomingId,draftId:row.draftId,basisHash:row.basisHash});}catch{continue;}
  attempted++;let reason;
  try{if(stopping())throw Error('Workbench wird beendet.');const result=await dispatch({google,request,stopping,data:{clientId:row.clientId,incomingId:row.incomingId,draftId:row.draftId,basisHash:row.basisHash,confirmed:true,autoAttemptId:claim.id}});reason=result.saved?`Versandstatus: ${result.status}. Aktuellen Mailstatus im Verlauf prüfen.`:'Abschluss unklar. Gmail abgleichen; keine Wiederholung.';}
  catch(e){reason='Automatik angehalten: '+(e.message||'Ursache unklar.');}
  // A lost finish response must never trigger another Gmail call. The durable claim survives.
  try{await request(path+`/${claim.id}/finish`,{reason:reason.slice(0,2000)});}catch{}
 }
 return {attempted};
}
module.exports={runDialogueAuto,saveDialogueAutoPolicy};

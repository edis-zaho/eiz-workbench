exports.runRelay=async({clientId,relay,request,stopping=()=>false})=>{
 const base=`/api/clients/${clientId}/relay-sync`;let revision;
 try{const status=relay.status(clientId);return await relay.withConnection(clientId,status.revision,async connection=>{
  if(stopping())throw Error('Signalabholung wurde angehalten.');
  const context=await request(base+'/context',{identity:connection.identity});revision=context.revision;
  const page=await connection.readPage({after:context.after,...context.through===undefined?{}:{through:context.through}});
  if(stopping())throw Error('Signalabholung wurde angehalten.');connection.assertCurrent();
  return request(base+'/accept',{identity:connection.identity,revision,page});
 });}catch(e){
  if(/bereits eine Trackingprüfung/.test(e.message))throw e;
  if(!revision){try{const state=await request(base,{},'GET');if(state.policy?.active)revision=state.policy.revision;}catch{}}
  if(revision){try{const reason=/Zuordnung fehlt/.test(e.message)?'unbound':/Kapazität|100.000/.test(e.message)?'capacity':/Relay|Herkunft|Quellenkennung|Zukunft/.test(e.message)?'invalid':/angehalten/.test(e.message)?'interrupted':'connection';await request(base+'/fail',{revision,reason});}catch{}}throw e;
 }
};

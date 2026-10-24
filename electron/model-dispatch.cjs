const {bindingHash}=require('./model-endpoint.cjs');
const {callModel}=require('./model-transport.cjs');
// The native process alone owns credentials, confirmations, dispatch and billing.
function createModelDispatcher({request,vault,confirm,transport=callModel}){
 return async function dispatch(run){
  const base=`/api/clients/${run.clientId}/model-dispatch/${run.id}`;
  const payload={...(run.context!==undefined?{context:run.context}:{}),...(run.prompt?{prompt:run.prompt}:{})};
  let started=false;
  try{
   if(bindingHash(payload)!==run.contextHash)throw Error('Modellinhalt wurde nach Reservierung verändert.');
   const setup=await request(`/api/clients/${run.clientId}/model-setup/${run.purpose}`,{},'GET');
   if(setup.binding.hash!==run.binding.hash)throw Error('Modellziel wurde geändert.');
   if(!run.automatic&&!await confirm({run,payload,quote:setup.quote}))throw Error('Modellübertragung abgebrochen.');
   // Local credential failures must release the still-unstarted reservation.
   const key=vault.key(run.binding);
   const permit=await request(base+'/authorize',{expectedBindingHash:run.binding.hash});
   if(permit.binding.hash!==run.binding.hash)throw Error('Modellziel wurde geändert.');
   started=true;
   const result=await transport({...run,binding:permit.binding,key});
   await request(base+'/finish',{state:'completed',usage:result.usage});
   // Domain validators receive their stable historical usage shape.
   const usage=Object.fromEntries(['inputTokens','outputTokens','reasoningTokens'].map(k=>[k,result.usage?.[k]??null]));
   if(result.status!=='completed'){const e=Error('Modellantwort ist nicht vollständig. Verbrauch wurde erfasst.');e.kind='failed';throw e;}
   return {...result,usage};
  }catch(error){
   try{await request(base+'/finish',{state:started?'unknown':'not-started',usage:null});}catch{}
   // Never retry a request whose response or local completion was lost.
   error.kind=started?'unknown':'failed';throw error;
  }
 };
}
module.exports={createModelDispatcher};

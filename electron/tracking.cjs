const {createHash}=require('node:crypto');
const {origin}=require('./relay-client.cjs');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderTracking(mail,plan){
 if(!plan||plan.mailId!==mail.id||plan.mailHash!==hash([mail.id,mail.clientId,mail.mailboxId,mail.sender,mail.recipient,mail.subject,mail.body,mail.messageId])||origin(plan.identity.baseURL)!==plan.identity.baseURL||!Array.isArray(plan.registrations)||plan.registrations.length<1||plan.registrations.length>6)throw Error('Trackinginhalt passt nicht zur reservierten Nachricht.');
 const base=plan.identity.baseURL,regs=plan.registrations,pixel=regs[0];
 if(regs.some((r,i)=>!/^[a-f0-9]{64}$/.test(r.token)||r.messageRef!==plan.messageRef||r.kind!==(i?'click':'open')||!i&&(r.target!==null||r.linkId!==null)))throw Error('Ungültige Trackingreferenzen.');
 const links=new Map();for(const r of regs.slice(1)){const u=new URL(r.target);if(u.href!==r.target||u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!plan.hosts.includes(u.hostname)||links.has(r.target))throw Error('Ungültiges Trackingziel.');links.set(r.target,r.token);}
 let html='',end=0;const used=new Set();for(const match of mail.body.matchAll(/https?:\/\/[^\s<>"']+/gi)){const target=match[0].replace(/[.,;!?)]+$/,''),token=links.get(target);if(!token)throw Error('Nachrichtenlink ohne bestätigtes Trackingziel.');html+=escape(mail.body.slice(end,match.index))+`<a href="${base}/c/${token}">${escape(target)}</a>`;end=match.index+target.length;used.add(target);}
 if(used.size!==links.size)throw Error('Trackingziel kommt nicht im Nachrichtentext vor.');html+=escape(mail.body.slice(end));
 return `<!doctype html><html><body><div style="white-space:pre-wrap">${html}</div><img src="${base}/o/${pixel.token}.gif" width="1" height="1" alt="" /></body></html>`;
}
function createTracking({relay,request,stopping=()=>false}){return async mail=>{
 const base=`/api/clients/${mail.clientId}/tracking`,plan=await request(base+'/prepare',{mailId:mail.id});if(!plan)return {mail,check:()=>{if(stopping())throw Error('Versand unterbrochen.');}};
 const state=relay.status(mail.clientId);if(!state.connection)throw Error('Trackingdienst nicht verbunden. Kein Versand.');
 return relay.withConnection(mail.clientId,state.revision,async connection=>{
  if(['baseURL','stream','instanceId'].some(k=>connection.identity[k]!==plan.identity[k]))throw Error('Trackingdienst wurde geändert. Kein Versand.');
  renderTracking(mail,plan);
  // Persisted tokens are reused if registration was accepted but its response was lost.
  for(const registration of plan.registrations){if(stopping())throw Error('Trackingvorbereitung unterbrochen.');await connection.register(registration);}
  connection.assertCurrent();if(stopping())throw Error('Trackingvorbereitung unterbrochen.');
  await request(base+'/registered',{mailId:mail.id,planHash:hash(plan)});
  return {mail:{...mail,tracking:plan},check:()=>{connection.assertCurrent();if(stopping())throw Error('Versand unterbrochen.');}};
 });
};}
module.exports={createTracking,renderTracking};

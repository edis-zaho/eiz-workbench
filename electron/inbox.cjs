const {deliveryReport}=require('./delivery.cjs');
const {confirmSource}=require('./gmail-source.cjs');
const {READ_SCOPE}=require('./reconcile.cjs');
const BASE='https://gmail.googleapis.com/gmail/v1/users/me';
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(id);
function header(m,name){const rows=(m.payload?.headers||[]).filter(h=>typeof h.name==='string'&&h.name.toLowerCase()===name);return rows.length===1&&typeof rows[0].value==='string'?rows[0].value.trim():'';}
function address(s){const m=s.match(/^(?:[^<>\r\n]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?$/i);return m?m[1].toLowerCase():'';}
async function readConversation(mail,mailbox,request){
 if(!mailbox.scopes?.includes(READ_SCOPE))throw Error('Bitte lesenden Gmail-Zugriff erteilen.');
 if(mail.mailboxId!==mailbox.id||mail.sender!==mailbox.email||!validId(mail.providerId))throw Error('Nachricht passt nicht zum verbundenen Postfach oder hat keine bestätigte Gmail-ID.');
 const options={headers:{Authorization:`Bearer ${mailbox.accessToken}`}};
 const source=await request(`${BASE}/messages/${encodeURIComponent(mail.providerId)}?format=metadata`,options);
 const sourceReference=confirmSource(mail,source,true),canonicalId=sourceReference.messageId;
 const thread=await request(`${BASE}/threads/${encodeURIComponent(source.threadId)}?format=metadata`,options);
 if(thread.id!==source.threadId||!Array.isArray(thread.messages)||thread.messages.length>200)throw Error('Gespräch ist unvollständig oder überschreitet 200 Nachrichten. Bitte in Gmail prüfen.');
 const rows=[];
 for(const m of thread.messages){
  if(!validId(m.id)||m.threadId!==thread.id||!Array.isArray(m.labelIds)||!Array.isArray(m.payload?.headers))throw Error('Gespräch enthält unvollständige Metadaten.');
  if(m.id===mail.providerId||m.labelIds.includes('SENT')||m.labelIds.includes('DRAFT'))continue;
  const sender=address(header(m,'from'));
  if(sender===mailbox.email)continue;
  const milliseconds=Number(m.internalDate);if(!Number.isFinite(milliseconds)||milliseconds<=0||!Number.isFinite(new Date(milliseconds).getTime()))throw Error('Empfangszeit fehlt.');
  if(milliseconds<Date.parse(mail.createdAt))continue;
  const refs=(header(m,'in-reply-to')+' '+header(m,'references')).match(/<[^<>\s]+>/g)||[];
  const matched=sender===mail.recipient&&refs.includes(canonicalId);
  const auto=header(m,'auto-submitted');
  let delivery;
  if(/^multipart\/report\s*;/i.test(header(m,'content-type'))&&/report-type\s*=\s*"?delivery-status"?(?:\s*;|\s*$)/i.test(header(m,'content-type'))){
   const full=await request(`${BASE}/messages/${encodeURIComponent(m.id)}?format=full`,options);
   if(full.id!==m.id||full.threadId!==thread.id)throw Error('Zustellbericht passt nicht zum Gespräch.');
   delivery=deliveryReport(full.payload,{...mail,providerMessageId:canonicalId});
  }
  rows.push({providerId:m.id,threadId:thread.id,sender,subject:header(m,'subject').slice(0,500),excerpt:typeof m.snippet==='string'?m.snippet.slice(0,2000):'',receivedAt:new Date(milliseconds).toISOString(),kind:delivery?(delivery.type==='review'?'review':'automatic'):!matched?'review':auto&&auto.toLowerCase()!=='no'?'automatic':'reply',evidence:JSON.stringify({...(delivery?{delivery}:{}),from:header(m,'from').slice(0,1000),inReplyTo:header(m,'in-reply-to').slice(0,2000),references:header(m,'references').slice(0,4000),autoSubmitted:auto.slice(0,100),labels:m.labelIds.filter(x=>typeof x==='string').slice(0,50)})});
 }
 return {rows,threadId:thread.id,...(canonicalId!==mail.messageId?{sourceReference}:{})};
}
module.exports={readConversation};

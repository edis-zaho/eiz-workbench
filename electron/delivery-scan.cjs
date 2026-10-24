const {historyPage,validHistory}=require('./history-page.cjs');
const {matchReply}=require('./reply-match.cjs');
const {deliveryReport}=require('./delivery.cjs');
const {READ_SCOPE}=require('./reconcile.cjs');
const BASE='https://gmail.googleapis.com/gmail/v1/users/me';
const QUERY='newer_than:30d {from:mailer-daemon from:postmaster} -in:sent -in:drafts';
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(x);
function unresolved(message,mailbox,reason){const at=Number(message.internalDate);if(!Number.isFinite(at)||at<=0||!Number.isFinite(new Date(at).getTime()))throw Error('Empfangszeit des ungeklärten Eingangs fehlt.');return {mailboxId:mailbox.id,providerId:message.id,threadId:message.threadId,sender:header(message,'from').slice(0,254),subject:header(message,'subject').slice(0,500),excerpt:typeof message.snippet==='string'?message.snippet.slice(0,2000):'',receivedAt:new Date(at).toISOString(),reason,evidence:JSON.stringify({inReplyTo:header(message,'in-reply-to').slice(0,1500),references:header(message,'references').slice(0,3000),contentType:header(message,'content-type').slice(0,200)})};}
function header(message,name){const rows=(message.payload?.headers||[]).filter(h=>h.name?.toLowerCase()===name);return rows.length===1&&typeof rows[0].value==='string'?rows[0].value:'';}
async function scanDeliveries(mails,mailbox,request,progress){
 if(!mailbox.scopes?.includes(READ_SCOPE))throw Error('Lesender Gmail-Zugriff fehlt.');
 if(!Array.isArray(mails)||mails.length>100000||mails.some(m=>m.mailboxId!==mailbox.id||m.sender!==mailbox.email||m.status!=='sent'))throw Error('Ausgangsnachrichten passen nicht zum Postfach oder überschreiten100.000.');
 const query=progress?.query||QUERY,pageToken=progress?.pageToken||'',deadline=Date.now()+85000;
 const result={nextPageToken:'',checked:0,unmatched:0,skipped:0,truncated:false,matches:[],unresolved:[],query};
 if(!mails.length)return result;
 const options={headers:{Authorization:`Bearer ${mailbox.accessToken}`}};
 let baselineHistoryId=progress?.baselineHistoryId;
 if(progress?.syncVersion===1&&progress.phase==='full'&&!baselineHistoryId){const profile=await request(`${BASE}/profile`,options);if(profile?.emailAddress?.toLowerCase()!==mailbox.email||!validHistory(profile.historyId))throw Error('Postfach-Änderungsstand fehlt.');baselineHistoryId=profile.historyId;}
 const list=progress?.phase==='history'?await historyPage(progress,options,request):await request(`${BASE}/messages?maxResults=${progress?25:100}&includeSpamTrash=${progress?'true':'false'}&q=${encodeURIComponent(query)}${pageToken?'&pageToken='+encodeURIComponent(pageToken):''}`,options);
 if(!list||list.messages!==undefined&&!Array.isArray(list.messages))throw Error('Ungültige Rückläufersuche.');
 const candidates=list.messages||[];if(candidates.length>100||candidates.some(m=>!validId(m.id)))throw Error('Ungültige Suchtreffer.');
 if(list.nextPageToken!==undefined&&(typeof list.nextPageToken!=='string'||list.nextPageToken.length>2000))throw Error('Ungültiger Seitentoken.');
 if(progress?.syncVersion===1){result.baselineHistoryId=baselineHistoryId;result.historyId=list.historyId;}
 result.nextPageToken=list.nextPageToken||'';result.truncated=!!list.nextPageToken;
 for(const candidate of new Map(candidates.map(m=>[m.id,m])).values()){
  if(Date.now()>deadline)throw Error('Zeitlimit erreicht. Seite kann erneut geprüft werden.');
  const m=await request(`${BASE}/messages/${candidate.id}?format=metadata`,options);result.checked++;
  if(m.id!==candidate.id||!validId(m.threadId)||!Array.isArray(m.labelIds))throw Error('Suchtreffer konnte nicht bestätigt werden.');
  if(m.labelIds.includes('SENT')||m.labelIds.includes('DRAFT')){result.skipped++;continue;}
  const ct=header(m,'content-type');
  if(!/^multipart\/report\s*;/i.test(ct)||!/report-type\s*=\s*"?delivery-status"?(?:\s*;|\s*$)/i.test(ct)){if(progress?.scopeVersion===2){const reply=matchReply(m,mails,mailbox);if(reply.match)result.matches.push(reply.match);else if(reply.unmatched){result.unmatched++;result.unresolved.push(unresolved(m,mailbox,'Mehrdeutige oder zu lange Nachrichtenreferenzen.'));}else result.skipped++;}else result.skipped++;continue;}
  const full=await request(`${BASE}/messages/${m.id}?format=full`,options);
  if(full.id!==m.id||full.threadId!==m.threadId)throw Error('Zustellbericht passt nicht zum Suchtreffer.');
  const at=Number(m.internalDate);if(!Number.isFinite(at)||at<=0||!Number.isFinite(new Date(at).getTime()))throw Error('Empfangszeit des Zustellberichts fehlt.');
  const matches=mails.filter(mail=>at>=Date.parse(mail.createdAt)).map(mail=>({mail,delivery:deliveryReport(full.payload,mail)})).filter(x=>x.delivery.type!=='review');
  if(matches.length!==1){result.unmatched++;result.unresolved.push(unresolved(m,mailbox,'Zustellbericht lässt sich keiner einzelnen bestätigten Sendung zuordnen.'));continue;}
  const {mail,delivery}=matches[0];
  result.matches.push({mailId:mail.id,row:{providerId:m.id,threadId:m.threadId,sender:header(m,'from').slice(0,254),subject:header(m,'subject').slice(0,500),excerpt:typeof m.snippet==='string'?m.snippet.slice(0,2000):'',receivedAt:new Date(at).toISOString(),kind:'automatic',evidence:JSON.stringify({delivery,discovery:'separate-delivery-scan',query})}});
 }
 return result;
}
module.exports={scanDeliveries,QUERY};

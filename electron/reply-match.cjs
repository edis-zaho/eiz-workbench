function header(message,name){const rows=(message.payload?.headers||[]).filter(h=>typeof h.name==='string'&&h.name.toLowerCase()===name);return rows.length===1&&typeof rows[0].value==='string'?rows[0].value.trim():'';}
function address(s){const m=s.match(/^(?:[^<>\r\n]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?$/i);return m?m[1].toLowerCase():'';}
function matchReply(m,mails,mailbox){
 if(!Array.isArray(m.payload?.headers))throw Error('Nachrichtenheader fehlen.');
 const inReplyTo=header(m,'in-reply-to'),references=header(m,'references');
 const direct=inReplyTo.match(/<[^<>\s]+>/g)||[],refs=references.match(/<[^<>\s]+>/g)||[];
 const exact=mails.filter(mail=>direct.includes(mail.providerMessageId||mail.messageId));
 const candidates=exact.length?exact:mails.filter(mail=>refs.includes(mail.providerMessageId||mail.messageId));
 if(!candidates.length)return {skipped:true};
 if(candidates.length!==1||inReplyTo.length>2000||references.length>4000)return {unmatched:true};
 const mail=candidates[0],at=Number(m.internalDate),sender=address(header(m,'from'));
 if(!Number.isFinite(at)||at<=0||!Number.isFinite(new Date(at).getTime()))throw Error('Empfangszeit der Antwort fehlt.');
 if(at<Date.parse(mail.createdAt)||sender===mailbox.email)return {skipped:true};
 const auto=header(m,'auto-submitted').slice(0,100),kind=sender!==mail.recipient?'review':auto&&auto.toLowerCase()!=='no'?'automatic':'reply';
 return {match:{mailId:mail.id,row:{providerId:m.id,threadId:m.threadId,sender,subject:header(m,'subject').slice(0,500),excerpt:typeof m.snippet==='string'?m.snippet.slice(0,2000):'',receivedAt:new Date(at).toISOString(),kind,evidence:JSON.stringify({discovery:'independent-reply',linkedMessageId:mail.messageId,inReplyTo,references,from:header(m,'from').slice(0,1000),autoSubmitted:auto})}}};
}
module.exports={matchReply};

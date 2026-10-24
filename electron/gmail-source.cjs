const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
function header(m,name){const rows=(m.payload?.headers||[]).filter(h=>typeof h.name==='string'&&h.name.toLowerCase()===name);return rows.length===1&&typeof rows[0].value==='string'?rows[0].value.trim():'';}
function address(s){const m=s.match(/^(?:[^<>\r\n]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?$/i);return m?m[1].toLowerCase():'';}
// Gmail's immutable message id is the receipt returned by send. RFC Message-ID may be rewritten.
// Discover a new alias only from that exact accepted receipt, never from search or a reply header.
function confirmSource(mail,source,allowBinding=false){
 const messageId=header(source,'message-id'),expected=mail.providerMessageId||mail.messageId;
 const rewritten=messageId!==expected;
 const validRewrite=allowBinding&&!mail.providerMessageId&&mail.status==='sent'&&/^<[^<>\s@]+@mail\.gmail\.com>$/.test(messageId)&&Number.isFinite(Date.parse(mail.createdAt))&&Number.isFinite(Number(source.internalDate))&&Number(source.internalDate)>=Date.parse(mail.createdAt)-60000;
 const mismatch=[source.id!==mail.providerId&&'Gmail-Kennung',(!validId(source.threadId)||mail.providerThreadId&&source.threadId!==mail.providerThreadId)&&'Gesprächskennung',(!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)||messageId.length>254||rewritten&&!validRewrite)&&'Message-ID',address(header(source,'from'))!==mail.sender&&'Absender',address(header(source,'to'))!==mail.recipient&&'Empfänger',(!Array.isArray(source.labelIds)||!source.labelIds.includes('SENT')||source.labelIds.includes('DRAFT'))&&'Gesendet-Markierung'].filter(Boolean);
 if(mismatch.length)throw Error(`Ausgangsnachricht konnte nicht eindeutig bestätigt werden (${mismatch.join(', ')}).`);
 return {mailId:mail.id,mailboxId:mail.mailboxId,providerId:source.id,threadId:source.threadId,messageId};
}
module.exports={confirmSource};

// Conservative RFC 3464 subset. Missing or contradictory data stays a review case.
function fields(text){
 const result=new Map();
 for(const line of text.replace(/\r\n/g,'\n').replace(/\n[ \t]+/g,' ').split('\n')){
  const match=line.match(/^([a-zA-Z0-9-]+):\s*(.*)$/);if(!match)continue;
  const key=match[1].toLowerCase();result.set(key,result.has(key)?null:match[2].trim());
 }return result;
}
function decode(part){const data=part?.body?.data;if(typeof data!=='string'||data.length>180000||!/^[\w=-]*$/.test(data))return '';return Buffer.from(data,'base64url').toString('utf8');}
function deliveryReport(payload,mail){
 const uncertain={type:'review',reason:'Zustellbericht nicht eindeutig zugeordnet.'};
 if(payload?.mimeType?.toLowerCase()!=='multipart/report')return uncertain;
 const parts=payload.parts;if(!Array.isArray(parts)||parts.length>20)return uncertain;
 const statuses=parts.filter(p=>p.mimeType?.toLowerCase()==='message/delivery-status');
 const originals=parts.filter(p=>['message/rfc822','text/rfc822-headers'].includes(p.mimeType?.toLowerCase()));
 if(statuses.length!==1||originals.length!==1)return uncertain;
 const original=originals[0];let originalHeaders=fields(decode(original).split(/\r?\n\r?\n/)[0]);
 if(!originalHeaders.size&&original.parts?.length===1){
  const headers=original.parts[0].headers;if(Array.isArray(headers))originalHeaders=fields(headers.map(h=>`${h.name}: ${h.value}`).join('\n'));
 }
 if(originalHeaders.get('message-id')!==(mail.providerMessageId||mail.messageId))return uncertain;
 const raw=decode(statuses[0]);if(!raw)return uncertain;
 const groups=raw.replace(/\r\n/g,'\n').split(/\n\s*\n/).map(fields);
 const recipientGroups=groups.filter(g=>g.has('final-recipient'));
 const matches=recipientGroups.filter(g=>g.get('final-recipient')?.toLowerCase()===`rfc822; ${mail.recipient.toLowerCase()}`);
 if(matches.length!==1)return uncertain;
 const g=matches[0],action=g.get('action')?.toLowerCase(),status=g.get('status');
 if(!status||!/^\d\.\d{1,3}\.\d{1,3}$/.test(status))return uncertain;
 const type=action==='failed'&&status.startsWith('5.')?'failed':action==='delayed'&&status.startsWith('4.')?'delayed':null;
 if(!type)return uncertain;
 return {type,action,status,recipient:mail.recipient,messageId:mail.messageId,diagnostic:(g.get('diagnostic-code')||'').slice(0,1000)};
}
module.exports={deliveryReport};

const {READ_SCOPE}=require('./reconcile.cjs');
const {confirmSource}=require('./gmail-source.cjs');
const BASE='https://gmail.googleapis.com/gmail/v1/users/me';
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
function header(m,name){const rows=(m.payload?.headers||[]).filter(h=>typeof h.name==='string'&&h.name.toLowerCase()===name);if(rows.length>1)throw Error('Mehrdeutige Nachrichtenheader.');const value=rows[0]?.value||'';if(typeof value!=='string'||value.length>2000||/[\r\n\0]/.test(value))throw Error('Ungültiger Nachrichtenheader.');return value.trim();}
function address(s){const m=s.match(/^(?:[^<>\r\n]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?$/i);return m?m[1].toLowerCase():'';}
function plainBody(payload){
 let count=0;const issues=new Set();
 function read(p,depth){if(!p||depth>10||++count>100)throw Error('MIME-Struktur überschreitet das Leselimit.');const type=String(p.mimeType||'').toLowerCase();
  if(p.filename||/^attachment\b/i.test(header({payload:p},'content-disposition'))||type==='message/rfc822'){issues.add('attachment_present');return [];}
  if(type.startsWith('multipart/')){if(!Array.isArray(p.parts))throw Error('Unvollständige MIME-Struktur.');const results=p.parts.map(x=>read(x,depth+1));if(type==='multipart/alternative')return results.find(x=>x.length)||[];return results.flat();}
  if(type==='text/html')return [];
  if(type!=='text/plain'){issues.add('attachment_present');return [];}
  if(p.body?.attachmentId){issues.add('external_body');return [];}
  const data=p.body?.data;if(typeof data!=='string'||data.length>90000||!/^[-_A-Za-z0-9]*={0,2}$/.test(data)||data.replace(/=+$/,'').length%4===1)throw Error('Ungültiger oder zu großer MIME-Text.');
  const bytes=Buffer.from(data,'base64url');if(bytes.toString('base64url')!==data.replace(/=+$/,''))throw Error('Beschädigte Textkodierung.');
  if(!Number.isSafeInteger(p.body.size)||p.body.size!==bytes.length||bytes.length>64000)throw Error('Textgröße stimmt nicht mit Gmail überein.');
  const charset=/charset\s*=\s*"?([^;\s"]+)/i.exec(header({payload:p},'content-type'))?.[1]?.toLowerCase()||'utf-8';if(!['utf-8','utf8','us-ascii','iso-8859-1','windows-1252'].includes(charset)){issues.add('unsupported_charset');return [];}
  let text;try{if(charset==='us-ascii'&&bytes.some(b=>b>127))throw Error();text=new TextDecoder(charset==='us-ascii'?'utf-8':charset,{fatal:true}).decode(bytes);}catch{throw Error('Nachrichtentext kann nicht verlustfrei dekodiert werden.');}
  if(text.includes('\0'))throw Error('Nachricht enthält ungültige Steuerzeichen.');return text.trim()?[text]:[];
 }
 const parts=read(payload,0);const text=parts.join('\n\n');if(text.length>64000)throw Error('Nachricht zu groß.');if(!text)issues.add('no_plain_text');return {text,textStatus:text?'plain':'unavailable',issues:[...issues]};
}
async function readThreadContext(mail,incoming,mailbox,request){
 if(!mailbox.scopes?.includes(READ_SCOPE))throw Error('Lesenden Gmail-Zugriff zuerst freigeben.');if(mail.mailboxId!==mailbox.id||mail.sender!==mailbox.email||!validId(mail.providerId)||incoming.mailboxId!==mailbox.id||!validId(incoming.threadId)||!validId(incoming.providerId))throw Error('Gespräch passt nicht zum verbundenen Postfach.');
 const options={headers:{Authorization:`Bearer ${mailbox.accessToken}`}};
 const source=await request(`${BASE}/messages/${encodeURIComponent(mail.providerId)}?format=metadata`,options);
 const anchor=m=>{if(!m||m.threadId!==incoming.threadId)return false;confirmSource(mail,m);return true;};
 if(!anchor(source))throw Error('Ausgangsnachricht nicht eindeutig bestätigt.');
 const thread=await request(`${BASE}/threads/${encodeURIComponent(incoming.threadId)}?format=full`,options);
 if(thread?.id!==incoming.threadId||!Array.isArray(thread.messages)||!thread.messages.length||thread.messages.length>100||JSON.stringify(thread).length>2000000)throw Error('Gespräch unvollständig oder zu groß.');
 if(!anchor(thread.messages.find(m=>m.id===mail.providerId)))throw Error('Ausgangsnachricht fehlt im vollständigen Gespräch.');
 const seen=new Set();let total=0;
 const messages=thread.messages.map(m=>{
  if(!validId(m.id)||seen.has(m.id)||m.threadId!==thread.id||!Array.isArray(m.labelIds)||!Array.isArray(m.payload?.headers))throw Error('Unvollständige oder doppelte Nachricht.');seen.add(m.id);
  const ms=Number(m.internalDate);if(!Number.isFinite(ms)||ms<=0||!Number.isFinite(new Date(ms).getTime()))throw Error('Nachrichtenzeit fehlt.');
  const from=header(m,'from'),to=header(m,'to'),cc=header(m,'cc'),messageId=header(m,'message-id'),subject=header(m,'subject');const direction=address(from)===mail.sender&&address(to)===mail.recipient&&m.labelIds.includes('SENT')?'sent':address(from)===mail.recipient&&address(to)===mail.sender&&!m.labelIds.includes('SENT')?'received':'other';
  const body=plainBody(m.payload),issues=new Set(body.issues);if(direction==='other')issues.add('unknown_participant');if(cc||header(m,'bcc')||!address(to))issues.add('extra_recipients');if(m.labelIds.includes('DRAFT'))issues.add('draft');if(!/^<[^<>\s]+>$/.test(messageId))issues.add('missing_message_id');
  if(m.id!==mail.providerId&&!((header(m,'references')+' '+header(m,'in-reply-to')).match(/<[^<>\s]+>/g)||[]).includes(mail.providerMessageId||mail.messageId))issues.add('unlinked_message');
  total+=body.text.length;return {providerId:m.id,messageId,from,to,cc,subject,sentAt:new Date(ms).toISOString(),direction,text:body.text,textStatus:body.textStatus,issues:[...issues]};
 }).sort((a,b)=>a.sentAt.localeCompare(b.sentAt)||a.providerId.localeCompare(b.providerId));
 if(total>256000)throw Error('Gesprächstext überschreitet 256.000 Zeichen.');
 const reply=messages.find(m=>m.providerId===incoming.providerId);if(!reply||address(reply.from)!==incoming.sender||Date.parse(reply.sentAt)!==Date.parse(incoming.receivedAt))throw Error('Gewählter Eingang nicht eindeutig bestätigt.');
 for(let i=1;i<messages.length;i++)if(messages[i-1].sentAt===messages[i].sentAt)for(const m of [messages[i-1],messages[i]])if(!m.issues.includes('same_time'))m.issues.push('same_time');
 return {threadId:thread.id,messages};
}
module.exports={plainBody,readThreadContext};

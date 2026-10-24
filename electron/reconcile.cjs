const BASE='https://gmail.googleapis.com/gmail/v1/users/me/messages';
const READ_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
function header(message,name){const rows=(message.payload?.headers||[]).filter(h=>typeof h.name==='string'&&h.name.toLowerCase()===name.toLowerCase());return rows.length===1&&typeof rows[0].value==='string'?rows[0].value.trim():null;}
function address(value){if(typeof value!=='string')return null;const m=value.match(/^(?:[^<>\r\n]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?$/i);return m?m[1].toLowerCase():null;}
async function findSent(mail,mailbox,request){
 if(!mailbox.scopes?.includes(READ_SCOPE))throw new Error('Bitte zuerst den lesenden Gmail-Zugriff freigeben.');
 if(mail.mailboxId!==mailbox.id||mail.sender!==mailbox.email)throw new Error('Die Nachricht gehört zu einem anderen Postfach.');
 if(!/^<[a-f0-9-]{36}@workbench\.local>$/.test(mail.messageId))throw new Error('Ungültige Nachrichtenkennung.');
 const url=new URL(BASE);url.searchParams.set('q',`rfc822msgid:${mail.messageId}`);url.searchParams.set('labelIds','SENT');url.searchParams.set('includeSpamTrash','true');url.searchParams.set('maxResults','2');
 const options={headers:{Authorization:`Bearer ${mailbox.accessToken}`}};
 const list=await request(url.href,options);
 if(list.messages!==undefined&&!Array.isArray(list.messages))throw new Error('Unvollständiges Gmail-Suchergebnis.');
 const rows=list.messages||[];
 if(list.nextPageToken||rows.length>1)return {outcome:'ambiguous',providerId:'',reason:'Mehrere mögliche Treffer. Ergebnis bleibt unklar; nicht erneut senden.'};
 if(!rows.length)return {outcome:'not_found',providerId:'',reason:'Kein Treffer. Das beweist nicht, dass die Nachricht nie gesendet wurde. Nicht automatisch erneut senden.'};
 const id=rows[0].id;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new Error('Ungültige Gmail-Nachrichtenkennung.');
 const detail=new URL(`${BASE}/${encodeURIComponent(id)}`);detail.searchParams.set('format','metadata');for(const name of ['Message-ID','From','To'])detail.searchParams.append('metadataHeaders',name);
 const message=await request(detail.href,options);
 if(mail.threadId&&message.threadId!==mail.threadId)return {outcome:'mismatch',providerId:'',reason:'Treffer gehört zu einem anderen Gespräch.'};
 if(message.id!==id||!Array.isArray(message.labelIds)||!message.labelIds.includes('SENT')||header(message,'Message-ID')!==mail.messageId||address(header(message,'From'))!==mail.sender||address(header(message,'To'))!==mail.recipient)return {outcome:'mismatch',providerId:'',reason:'Treffer passt nicht eindeutig zu Kennung, Absender und Empfänger. Ergebnis bleibt unklar.'};
 return {outcome:'found',providerId:id,reason:'In Gmail unter Gesendet anhand Kennung, Absender und Empfänger bestätigt. Zustellung nicht bestätigt.'};
}
module.exports={findSent,READ_SCOPE};

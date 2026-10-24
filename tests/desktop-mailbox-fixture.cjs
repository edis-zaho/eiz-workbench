const assert=require('node:assert/strict');
const {resolve}=require('node:path');

// Synthetic provider input goes through the real native observation boundary.
// Never give renderer fixtures the worker credential or add a production bypass.
exports.importConversation=async({dataDir,js,url,headers,clientId,mailId,rows})=>{
 assert.ok(process.env.EIZ_SMOKE_DIR);assert.equal(resolve(dataDir),resolve(process.env.EIZ_SMOKE_DIR));
 const previous=global.fetch,path=`/api/clients/${clientId}/mail-tests/${mailId}/conversation`;
 const response=await previous(url+path,{headers});assert.equal(response.status,200);const mail=await response.json();
 assert.ok(rows.length);assert.ok(rows.every(r=>r.kind==='reply'&&r.sender===mail.recipient));
 const vault=require('../electron/google.cjs').createGoogleVault(dataDir,require('electron').safeStorage),saved=vault.read(),seed=structuredClone(saved);
 const subject='synthetic-observation-account',threadId=mail.providerThreadId||rows[0].threadId,messageId=mail.providerMessageId||mail.messageId;
 seed.config={clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic'};
 seed.mailboxes[clientId]={id:mail.mailboxId,email:mail.sender,sub:subject,accessToken:'synthetic-observation-token',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,scopes:['https://www.googleapis.com/auth/gmail.readonly'],connectedAt:new Date().toISOString()};
 const source={id:mail.providerId,threadId,labelIds:['SENT'],internalDate:String(Date.parse(mail.createdAt)),payload:{headers:[{name:'Message-ID',value:messageId},{name:'From',value:mail.sender},{name:'To',value:mail.recipient}]}};
 const replies=rows.map(r=>({id:r.providerId,threadId,labelIds:['INBOX'],internalDate:String(Date.parse(r.receivedAt)),snippet:r.excerpt,payload:{headers:[{name:'From',value:r.sender},{name:'To',value:mail.sender},{name:'Subject',value:r.subject},{name:'In-Reply-To',value:messageId}]}}));
 let reads=0;
 global.fetch=async(input,init)=>{
  const target=String(input);if(target.startsWith(url+'/'))return previous(input,init);
  if(target==='https://openidconnect.googleapis.com/v1/userinfo')return new Response(JSON.stringify({sub:subject,email:mail.sender,email_verified:true}));
  if(target===`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mail.providerId)}?format=metadata`){reads++;return new Response(JSON.stringify(source));}
  if(target===`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`){reads++;return new Response(JSON.stringify({id:threadId,messages:[source,...replies]}));}
  throw Error('Unexpected provider request in synthetic conversation fixture: '+new URL(target).origin);
 };
 try{vault.save(seed);const result=await js(`window.workbench.googleConversation(${JSON.stringify({clientId,id:mailId})})`);assert.equal(reads,2);assert.equal(result.total,rows.length);return result;}
 finally{global.fetch=previous;vault.save(saved);}
};

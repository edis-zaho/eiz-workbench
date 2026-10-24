const {createHash}=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const bindingHash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const builtins={
 openai:{protocol:'openai-responses',origin:'https://api.openai.com',basePath:'/v1',suffix:'/responses',auth:'bearer'},
 gemini:{protocol:'gemini-generate-content',origin:'https://generativelanguage.googleapis.com',basePath:'/v1beta',auth:'google'},
 anthropic:{protocol:'anthropic-messages',origin:'https://api.anthropic.com',basePath:'/v1',suffix:'/messages',auth:'anthropic'}
};
function validateModelEndpoint(b){
 const bad=()=>{throw Error('Ungültige Modellbindung oder Zieladresse.');};
 if(!b||typeof b!=='object')bad();
 const {hash,...fields}=b;
 if(hash!==bindingHash(fields)||!b.profile||!/^[a-f0-9-]{36}$/.test(b.profile.id)||!Number.isSafeInteger(b.profile.revision)||b.profile.revision<1||
 !['openai','gemini','anthropic','custom'].includes(b.provider)||typeof b.model!=='string'||!b.model||b.model.length>160||/[\s\0-\x1f]/.test(b.model)||
 !Number.isSafeInteger(b.maxOutputTokens)||b.maxOutputTokens<1||b.maxOutputTokens>65536||
 b.credentialRef!==null&&(typeof b.credentialRef!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(b.credentialRef))||
 Object.keys(fields).some(k=>!['profile','provider','protocol','model','origin','basePath','credentialRef','maxOutputTokens'].includes(k)))bad();
 let u;try{u=new URL(b.origin);}catch{bad();}
 if(u.origin!==b.origin||u.username||u.password||u.search||u.hash||!/^\/[a-zA-Z0-9/_-]*$/.test(b.basePath)||b.basePath.length>120||b.basePath.includes('//')||
 !(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)))bad();
 const known=builtins[b.provider];
 if(known&&['protocol','origin','basePath'].some(k=>known[k]!==b[k]))bad();
 if(!known&&b.protocol!=='openai-chat-completions')bad();
 const suffix=b.provider==='gemini'?`/models/${encodeURIComponent(b.model)}:generateContent`:known?.suffix||'/chat/completions';
 return {url:b.origin+b.basePath.replace(/\/$/,'')+suffix,auth:known?.auth||'bearer'};
}
module.exports={validateModelEndpoint,bindingHash};

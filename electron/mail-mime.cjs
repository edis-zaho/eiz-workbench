const {createHash}=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const header=s=>typeof s==='string'&&s.length<=254&&!/[\r\n\0\uFFFD]/.test(s);
const email=s=>header(s)&&/^[^\s<>@;]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
const reference=s=>header(s)&&/^<[^<>\s@]+@[^<>\s@]+>$/.test(s);
const encoded=s=>Array.from(s).reduce((a,c)=>{if(Buffer.byteLength(a[a.length-1]+c)>30)a.push(c);else a[a.length-1]+=c;return a;},['']).map(s=>`=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
const body=s=>Buffer.from(s).toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';
function encodeMime(p,id){
 const {hash,...fields}=p||{};
 if(hash!==digest(fields)||!email(p.fromEmail)||!email(p.to)||!header(p.fromName)||!header(p.subject)||!reference(id)||
 typeof p.text!=='string'||p.text.length>6002||typeof p.html!=='string'||p.html.length>100000||
 p.inReplyTo!==undefined&&!reference(p.inReplyTo)||p.references!==undefined&&(!Array.isArray(p.references)||p.references.some(r=>!reference(r))))throw Error('Ungültige oder geänderte Maildarstellung.');
 const boundary='workbench-'+digest({id,hash}),refs=p.inReplyTo?`In-Reply-To: ${p.inReplyTo}\r\nReferences: ${(p.references||[p.inReplyTo]).join(' ')}\r\n`:'';
 return Buffer.from(`From: ${encoded(p.fromName)} <${p.fromEmail}>\r\nTo: ${p.to}\r\nSubject: ${encoded(p.subject)}\r\nMessage-ID: ${id}\r\n${refs}MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body(p.text.replace(/\r?\n/g,'\r\n'))}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body(p.html)}\r\n--${boundary}--\r\n`).toString('base64url');
}
module.exports={encodeMime};

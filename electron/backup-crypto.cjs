const {randomBytes,createCipheriv,createDecipheriv,scrypt}=require('node:crypto');
const {promisify}=require('node:util');
const derive=promisify(scrypt),MAX=256*1024*1024;
function password(v){if(typeof v!=='string'||v.length<12||v.length>1024)throw Error('Sicherungspasswort benötigt 12 bis 1024 Zeichen.');}
function keyOK(key){if(!Buffer.isBuffer(key)||key.length!==32)throw Error('Sicherungsschlüssel fehlt.');}
function seal(bytes,key,metadata){
 keyOK(key);if(bytes.length>MAX)throw Error('Sicherung zu groß.');
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),aad=Buffer.from(JSON.stringify(metadata));
 cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
 return Buffer.from(JSON.stringify({...metadata,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')}));
}
function parse(bytes,mode){
 if(bytes.length>MAX*1.4+4096)throw Error('Sicherung zu groß.');
 let v;try{v=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw Error('Keine verschlüsselte Sicherung.');}
 const fields=['format','version','mode','nonce','tag','data',...(mode==='password'?['salt','N','r','p']:[])];
 if(v?.format!=='eiz-encrypted-backup'||v.version!==1||v.mode!==mode||Object.keys(v).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(v,k)))throw Error('Unbekanntes Sicherungsformat.');
 const b64=(s,length)=>typeof s==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(s)&&Buffer.from(s,'base64').toString('base64')===s&&(length===undefined||Buffer.from(s,'base64').length===length);
 if(!b64(v.nonce,12)||!b64(v.tag,16)||!b64(v.data)||Buffer.byteLength(v.data,'base64')>MAX)throw Error('Beschädigte Sicherung.');
 if(mode==='password'&&(v.N!==32768||v.r!==8||v.p!==1||!b64(v.salt,16)))throw Error('Unzulässige Schlüsselparameter.');
 return v;
}
function open(v,key){
 keyOK(key);const {nonce,tag,data,...metadata}=v,decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(nonce,'base64'));
 decipher.setAAD(Buffer.from(JSON.stringify(metadata)));decipher.setAuthTag(Buffer.from(tag,'base64'));
 try{return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]);}catch{throw Error('Falsches Passwort, falsches Windows-Profil oder beschädigte Sicherung.');}
}
async function encryptPortableBackup(bytes,passphrase){password(passphrase);const salt=randomBytes(16),key=await derive(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:67108864});try{return seal(bytes,key,{format:'eiz-encrypted-backup',version:1,mode:'password',salt:salt.toString('base64'),N:32768,r:8,p:1});}finally{key.fill(0);}}
async function decryptPortableBackup(bytes,passphrase){password(passphrase);const v=parse(bytes,'password'),key=await derive(passphrase,Buffer.from(v.salt,'base64'),32,{N:32768,r:8,p:1,maxmem:67108864});try{return open(v,key);}finally{key.fill(0);}}
function encryptLocalBackup(bytes,key){return seal(bytes,key,{format:'eiz-encrypted-backup',version:1,mode:'windows'});}
function decryptLocalBackup(bytes,key){return open(parse(bytes,'windows'),key);}
module.exports={encryptPortableBackup,decryptPortableBackup,encryptLocalBackup,decryptLocalBackup};

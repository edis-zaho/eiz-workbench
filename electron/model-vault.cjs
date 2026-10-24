const {existsSync,readFileSync,writeFileSync,renameSync}=require('node:fs');
const {join}=require('node:path');
const {validateModelEndpoint}=require('./model-endpoint.cjs');
function createModelVault(directory,safeStorage){
 const file=join(directory,'model-profiles.enc');
 function read(){
  if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('Sichere Betriebssystem-Verschlüsselung nicht verfügbar.');
  if(!existsSync(file))return {};
  try{const d=JSON.parse(safeStorage.decryptString(readFileSync(file)));if(!d||typeof d!=='object'||Array.isArray(d))throw Error();return d;}catch{throw Error('Gebundener Schlüsselspeicher beschädigt; Datei bleibt unverändert.');}
 }
 const write=d=>{writeFileSync(file+'.tmp',safeStorage.encryptString(JSON.stringify(d)),{flush:true});renameSync(file+'.tmp',file);};
 return {
  status(ref){const v=read()[ref];return {present:!!v};},
  save(binding,key){validateModelEndpoint(binding);if(!binding.credentialRef||typeof key!=='string'||!key||key.length>4096||/[\s\0]/.test(key))throw Error('Ungültiger Schlüssel.');const d=read(),old=d[binding.credentialRef];if(old&&old.profileId!==binding.profile.id)throw Error('Schlüsselreferenz gehört zu einem anderen Profil.');d[binding.credentialRef]={hash:binding.hash,profileId:binding.profile.id,key};write(d);return {present:true};},
  key(binding){validateModelEndpoint(binding);if(!binding.credentialRef){if(new URL(binding.origin).protocol==='http:')return '';throw Error('Schlüssel fehlt.');}const v=read()[binding.credentialRef];if(!v||v.hash!==binding.hash)throw Error('Schlüssel fehlt oder Bindung wurde geändert. Bitte bewusst neu verbinden.');return v.key;},
  remove(ref){const d=read();delete d[ref];write(d);return {present:false};}
 };
}
module.exports={createModelVault};

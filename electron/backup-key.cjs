const {existsSync,readFileSync,writeFileSync,renameSync}=require('node:fs');
const {randomBytes}=require('node:crypto');
const {join}=require('node:path');
function localBackupKey(directory,safeStorage){
 if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('Windows-Schlüsselschutz nicht verfügbar.');
 const file=join(directory,'backup-key.enc');
 if(existsSync(file)){const key=Buffer.from(safeStorage.decryptString(readFileSync(file)),'base64');if(key.length!==32)throw Error('Sicherungsschlüssel beschädigt.');return key;}
 const key=randomBytes(32);writeFileSync(file+'.tmp',safeStorage.encryptString(key.toString('base64')),{flush:true});renameSync(file+'.tmp',file);return key;
}
module.exports={localBackupKey};

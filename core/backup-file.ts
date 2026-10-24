import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {AppError} from './store';
import {BACKUP_IMPORT_LIMIT} from './storage';
// Invoked only by the authenticated native file-selection path, never the renderer.
export async function readBackupFile(input:any,requireDigest=false,decode?:(bytes:Buffer,passphrase?:string)=>Promise<Buffer>){
 if(typeof input?.path!=='string'||!isAbsolute(input.path)||input.path.includes('\0'))throw new AppError('Ungültige Sicherungsdatei.');
 if(requireDigest&&(typeof input.fileDigest!=='string'||! /^[a-f0-9]{64}$/.test(input.fileDigest)))throw new AppError('Geprüfter Dateistand fehlt.');
 const file=await open(input.path,'r');
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>(input.path.endsWith('.eizbackup')?Math.ceil(BACKUP_IMPORT_LIMIT*1.4)+4096:BACKUP_IMPORT_LIMIT))throw new AppError('Sicherungsdatei überschreitet256 MiB oder ist keine reguläre Datei.',413);
  // Fixed allocation and final byte probe also bound a file that grows after stat().
  const bytes=Buffer.alloc(stat.size);let offset=0;
  while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,Math.min(1024*1024,bytes.length-offset),offset);if(!bytesRead)throw new AppError('Sicherungsdatei wurde beim Lesen verändert.');offset+=bytesRead;}
  if((await file.read(Buffer.alloc(1),0,1,offset)).bytesRead)throw new AppError('Sicherungsdatei wurde beim Lesen vergrößert.');
  const fileDigest=createHash('sha256').update(bytes).digest('hex');if(requireDigest&&fileDigest!==input.fileDigest)throw new AppError('Datei wurde seit der Prüfung geändert. Bitte erneut auswählen und prüfen.',409);
  let backup:unknown;try{const plain=decode?await decode(bytes,input.passphrase):bytes;if(plain.length>BACKUP_IMPORT_LIMIT)throw new Error();backup=JSON.parse(plain.toString('utf8'));}catch{throw new AppError('Diese Datei enthält keine lesbare JSON-Sicherung.');}
  return {backup,fileDigest,bytes:bytes.length};
 }finally{await file.close();}
}

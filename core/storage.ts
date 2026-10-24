export const BACKUP_IMPORT_LIMIT = 256 * 1024 * 1024;
export function assessStorage(backupBytes:number,freeBytes:number|null){
  const warnings:string[]=[];
  if(backupBytes>BACKUP_IMPORT_LIMIT)warnings.push('Diese Sicherung überschreitet die native Importgrenze von 256 MiB. Vor weiterem Datenwachstum den Sicherungsweg erweitern.');
  else if(backupBytes>=BACKUP_IMPORT_LIMIT*.8)warnings.push('Die Sicherung nähert sich der nativen Importgrenze von 256 MiB. Den Sicherungsweg vor weiterem Datenwachstum erweitern.');
  if(freeBytes===null)warnings.push('Freier Speicher konnte nicht ermittelt werden.');
  else if(freeBytes<Math.max(1024*1024*1024,backupBytes*3))warnings.push('Wenig freier Speicher auf dem Datenlaufwerk. Zusätzlichen Platz schaffen und eine externe Kopie sichern.');
  return {backupBytes,freeBytes,importLimitBytes:BACKUP_IMPORT_LIMIT,withinImportLimit:backupBytes<=BACKUP_IMPORT_LIMIT,warnings,checkedAt:new Date().toISOString()};
}

import {createHash,randomUUID} from 'node:crypto';
import {AppError,type Store} from './store';
import {publicRecords,putPublicRecord,stableHash} from './public-schema';
import type {BackupData} from './types';
const previews=new WeakMap<Store,Map<string,any>>();
const addressHash=(email:string)=>createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
export function validateTombstone(v:any){
 if(!v||!['contact','customer'].includes(v.scope)||!/^[a-f0-9-]{36}$/.test(v.clientId)||!Array.isArray(v.addressHashes)||v.addressHashes.some((x:any)=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x))||!Number.isFinite(Date.parse(v.createdAt))||Object.keys(v).some(k=>!['scope','clientId','addressHashes','createdAt'].includes(k)))throw new AppError('Ungültiger Lösch-/Sperrnachweis.');
}
export function isDeletedAddress(s:Store,email:string){const hash=addressHash(email);return publicRecords(s,'tombstone').some(r=>r.content.addressHashes.includes(hash));}
export function protectRetentionRestore(s:Store,data:BackupData){
 for(const t of publicRecords(s,'tombstone')){
  if((data.leads||[]).some(l=>t.content.addressHashes.includes(addressHash(l.email))))throw new AppError('Sicherung enthält bereits gelöschte Kontaktdaten.');
  if(t.content.scope==='customer'){
   const c=data.clients.find(c=>c.id===t.content.clientId);
   if(c&&(c.name!=='Gelöschter Kunde'||c.email||c.website||c.notes)||(data.mailTests||[]).some(m=>m.clientId===t.content.clientId)||(data.leads||[]).some(l=>l.clientId===t.content.clientId))throw new AppError('Sicherung würde einen gelöschten Kundenbestand reaktivieren.');
  }
 }
}
export function previewContactDeletion(s:Store,clientId:string,leadId:string,scope:'contact'|'customer'='contact'){
 if(!['contact','customer'].includes(scope))throw new AppError('Ungültiger Löschumfang.');
 const lead=s.db.prepare('SELECT * FROM leads WHERE id=? AND clientId=?').get(leadId,clientId);
 if(!lead)throw new AppError('Kontakt fehlt.');
 const backup=s.exportBackup(),withoutLead={...backup.data,leads:backup.data.leads?.filter(l=>l.id!==leadId)};
 const serialized=JSON.stringify({...withoutLead,publicState:withoutLead.publicState?{...withoutLead.publicState,records:withoutLead.publicState.records.filter(r=>r.kind!=='permission')}:undefined});
 const linked=serialized.includes(String(leadId))||serialized.toLowerCase().includes(String(lead.email).toLowerCase());
 const customerCounts=Object.fromEntries(Object.entries(backup.data).filter(([,rows])=>Array.isArray(rows)).map(([name,rows])=>[name,(rows as any[]).filter(r=>r.clientId===clientId||name==='clients'&&r.id===clientId).length]));
 customerCounts.queueItems=Number(s.db.prepare('SELECT COUNT(*) n FROM queue_items WHERE runId IN (SELECT id FROM queue_runs WHERE clientId=?)').get(clientId)!.n);
 const data={clientId,leadId,scope,requiresCustomerDeletion:linked,customerName:s.client(clientId).name,contact:String(lead.email),counts:scope==='customer'?customerCounts:{leads:1},
  localBackups:s.localBackupInventory(),checksum:backup.checksum,
  notice:scope==='customer'?'Alle Daten dieses Kunden einschließlich Quellen, Kampagnen und Nachrichten werden entfernt. Kostenbeträge und minimale Kontaktsperren bleiben.':'Kontakt wird anonymisiert. Ein Hash der Adresse bleibt zur Verhinderung erneuter Ansprache.',
  externalCopies:'Bereits exportierte Dateien, Gmail-Nachrichten und Anbieterprotokolle werden hier nicht gelöscht. Diese Kopien separat bearbeiten.'};
 const hash=stableHash(data),map=previews.get(s)||new Map();map.clear();map.set(hash,data);previews.set(s,map);return {...data,hash};
}
export function applyContactDeletion(s:Store,previewHash:string){
 const old=previews.get(s)?.get(previewHash);if(!old)throw new AppError('Löschvorschau fehlt. Erneut prüfen.');
 const current=previewContactDeletion(s,old.clientId,old.leadId,old.scope);
 if(current.hash!==previewHash)throw new AppError('Daten oder Sicherungen wurden geändert. Neue Löschvorschau prüfen.',409);
 if(old.requiresCustomerDeletion&&old.scope!=='customer')throw new AppError('Verknüpfte Historie: nur eine ausdrücklich bestätigte Löschung des Kundenbestands ist möglich.');
 const c=old.clientId;
 if(s.db.prepare("SELECT id FROM mail_tests WHERE clientId=? AND status='sending'").get(c)||s.db.prepare("SELECT id FROM ai_runs WHERE clientId=? AND status='running'").get(c))throw new AppError('Zuerst laufende Übergaben abschließen; Löschung bleibt gesperrt.');
 const leads=s.db.prepare('SELECT * FROM leads WHERE clientId=?'+(old.scope==='contact'?' AND id=?':'')).all(...(old.scope==='contact'?[c,old.leadId]:[c]));
 const emails=leads.map(l=>String(l.email));
 if(old.scope==='customer')for(const m of s.db.prepare('SELECT recipient FROM mail_tests WHERE clientId=?').all(c))emails.push(String(m.recipient));
 const content={scope:old.scope,clientId:c,addressHashes:[...new Set(emails.map(addressHash))].sort(),createdAt:new Date().toISOString()};
 s.db.exec('PRAGMA foreign_keys=OFF');
 try{s.transaction(()=>{
  if(old.scope==='contact'){
   s.db.prepare("UPDATE leads SET email=?,firstName='',lastName='',company='',role='',source='',blocked=1,blockReason='Datenschutzlöschung' WHERE id=? AND clientId=?").run(`deleted-${old.leadId}@invalid.example`,old.leadId,c);
   s.db.prepare("DELETE FROM public_records WHERE kind='permission' AND id=?").run(old.leadId);
  }else{
   s.db.prepare('DELETE FROM queue_items WHERE runId IN (SELECT id FROM queue_runs WHERE clientId=?)').run(c);
   for(const row of s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
    const table=String(row.name);if(['clients','public_records','meta'].includes(table)||!/^[a-z_]+$/.test(table))continue;
    if(s.db.prepare(`PRAGMA table_info(${table})`).all().some(r=>r.name==='clientId'))s.db.prepare(`DELETE FROM ${table} WHERE clientId=?`).run(c);
   }
   s.db.prepare("DELETE FROM public_records WHERE clientId=? AND kind NOT IN ('model-run','tombstone')").run(c);
   for(const r of publicRecords(s,'model-run').filter(r=>r.clientId===c&&r.content.reconciliation)){
    r.content.reconciliation.note='Prüfnotiz bei Kundenlöschung entfernt.';r.revision++;putPublicRecord(s,r);
   }
   s.db.prepare("DELETE FROM meta WHERE instr(key,?)>0").run(c);
   s.db.prepare("UPDATE clients SET name='Gelöschter Kunde',email='',website='',notes='',status='paused',version=version+1 WHERE id=?").run(c);
  }
  putPublicRecord(s,{kind:'tombstone',id:randomUUID(),clientId:c,revision:1,content});
  if(s.db.prepare('PRAGMA foreign_key_check').all().length)throw new AppError('Löschung würde Datenbezüge beschädigen.');
 });}finally{s.db.exec('PRAGMA foreign_keys=ON');}
 const remaining=s.removeLocalBackups(old.localBackups);
 previews.delete(s);
 s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 return {deleted:true,scope:old.scope,remainingLocalBackups:remaining,externalCopies:old.externalCopies,physicalErasureGuaranteed:false};
}

import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Store } from '../core/store';
import { rehearseRestore } from '../core/recovery';

// SQLite's backup API includes committed WAL contents. Never migrate the original.
export async function checkUpgrade(source: string, destination: string) {
  mkdirSync(destination,{recursive:true});
  const directory=mkdtempSync(join(resolve(destination),'upgrade-'));
  const copy=join(directory,'revenue.sqlite');
  const original=new DatabaseSync(resolve(source),{readOnly:true});
  try { await backup(original,copy); } finally { original.close(); }
  const copied=new DatabaseSync(copy,{readOnly:true});
  let before: Record<string,any[]>={},fromSchema=0;
  try {
    fromSchema=Number(copied.prepare('PRAGMA user_version').get()?.user_version);
    const tables=copied.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for(const {name} of tables) {
      if(typeof name==='string' && /^[a-z_]+$/.test(name)) before[name]=copied.prepare(`SELECT * FROM "${name}"`).all();
    }
  } finally { copied.close(); }
  let store:Store|undefined;
  try {
    store=new Store(copy,join(directory,'backups'),false);
    store.close();store=undefined;
    store=new Store(copy,join(directory,'backups'),false);
    for(const [table,rows] of Object.entries(before)) {
      const actual:Record<string,any>[]=store.db.prepare(`SELECT * FROM "${table}"`).all();
      const id=table==='meta'?'key':table==='briefs'?'clientId':'id';
      const indexed:Map<any,Record<string,any>>=new Map(actual.map(r=>[r[id],r]));
      for(const row of rows) {
        const found=indexed.get(row[id]);assert.ok(found,`Missing ${table} record`);
        const expected={...row};
        if(table==='jobs'&&row.status==='running'){expected.status='held';expected.result='Bei Neustart unterbrochen. Bewusst erneut einplanen.';}
        if(table==='mail_tests'&&row.status==='sending'){expected.status='unknown';expected.result='Beim Neustart unterbrochen. Versand in Gmail prüfen. Keine automatische Wiederholung.';expected.updatedAt=found.updatedAt;}
        if(table==='ai_runs'&&row.status==='running'){expected.status='unknown';expected.result='Beim Neustart unterbrochen. Keine automatische Wiederholung; mögliche API-Kosten beim Anbieter prüfen.';}
        assert.deepEqual({...found},expected,`Changed ${table} record`);
      }
    }
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    const exported=store.exportBackup();
    const rehearsal=rehearseRestore(exported);
    const report={passed:true,checkedAt:new Date().toISOString(),source:resolve(source),copy,directory,fromSchema,toSchema:exported.version,originalOpenedReadOnly:true,allOriginalRecordsCompared:true,reopened:true,countsBefore:Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v.length])),restoreProbe:rehearsal,noProviderCalls:true};
    writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2),{flag:'wx',flush:true});
    return report;
  }finally{store?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.argv[2]||!process.argv[3])throw new Error('Usage: check-upgrade.ts source.sqlite destination');
 console.log(JSON.stringify(await checkUpgrade(process.argv[2],process.argv[3]),null,2));
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../core/store';
import { checkUpgrade } from '../scripts/check-upgrade';

test('Upgradeprobe migriert eine WAL-Kopie von Schema 1 ohne Originaländerung oder Auftragsausführung',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eiz-upgrade-test-'));const filename=join(dir,'original.sqlite');let db:DatabaseSync|undefined;
 try {
  const s=new Store(filename,join(dir,'backups'),false);
  const c=s.createClient({name:'Altprofil',website:'',email:'',notes:'Erhalten'});s.enqueueDiagnostic(c.id,0);
  s.db.exec('DROP TRIGGER evidence_mail_insert; DROP TRIGGER evidence_mail_update; DROP TRIGGER evidence_incoming_insert; DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; DROP TABLE interpretations; DROP TABLE evidence_events; DROP TABLE lead_account_links; DROP TABLE product_revisions; DROP TABLE account_revisions; DROP TABLE products; DROP TABLE accounts; DROP INDEX lead_id_client; DROP TABLE queue_items; DROP TABLE queue_runs; DROP TABLE mail_sync; DROP TABLE thread_contexts; DROP TABLE incoming; DROP TABLE campaign_history; DROP TABLE campaigns; DROP TABLE mail_tests; DROP TABLE leads; DROP TABLE brief_history; DROP TABLE ai_runs; DROP TABLE briefs; PRAGMA user_version=1;');s.close();
  db=new DatabaseSync(filename);db.exec('PRAGMA journal_mode=WAL;');
  db.prepare('UPDATE clients SET notes=?').run('Auch WAL-Daten erhalten');
  const report=await checkUpgrade(filename,join(dir,'reports'));
  assert.equal(report.fromSchema,1);assert.equal(report.toSchema,34);assert.equal(report.restoreProbe.counts.clients,1);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,1);
  assert.equal(db.prepare('SELECT status FROM jobs').get()?.status,'queued');
  assert.equal(db.prepare('SELECT notes FROM clients').get()?.notes,'Auch WAL-Daten erhalten');
 } finally {db?.close();rmSync(dir,{recursive:true,force:true});}
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, validateBackup, AppError } from './store';
import {stableHash} from './public-schema';

// A real restore and restart in an isolated database, never in the active profile.
export function rehearseRestore(input: unknown) {
  const backup = validateBackup(input);
  const directory = mkdtempSync(join(tmpdir(), 'eiz-restore-check-'));
  let store: Store | undefined;
  try {
    const filename = join(directory, 'check.sqlite');
    store = new Store(filename, join(directory, 'backups'), false);
    store.restore(backup);
    store.close(); store = undefined;
    store = new Store(filename, join(directory, 'backups'), false);
    const restored = store.exportBackup();
    const tables = ['threadContexts','experiments','strategies','knowledge','interpretations','evidenceEvents','products','productRevisions','accounts','accountRevisions','leadAccountLinks','queueRuns','queueItems','mailSync','incoming','clients','jobs','events','briefs','aiRuns','briefHistory','leads','mailTests','campaigns','campaignHistory'] as const;
    const counts: Record<string, number> = {};
    for (const key of tables) {
      const expected = backup.data[key] || [];
      const actual = restored.data[key] || [];
      const mutable: Record<string,string[]> = {queueItems:['status','reason'],queueRuns:['status','revision','reason','updatedAt'],mailSync:['enabled','status','nextAttemptAt','lastError','consecutiveFailures','updatedAt'],clients:['status','version','updatedAt'],jobs:['status'],briefs:['revision','approvedAt','approvedClientVersion','updatedAt'],aiRuns:['status'],mailTests:['status','result'],campaigns:['revision','approvedHash','approvedAt','updatedAt']};
      const index = new Map(actual.map((r:any) => [r.id || r.clientId,r]));
      // Only documented safety transitions may change business records.
      for (const row of expected) {
        const r = index.get((row as any).id || (row as any).clientId) as any;
        if (!r) throw new AppError('Sicherungsprüfung: Ein Datensatz fehlt nach dem Neustart.');
        for(const [field,value] of Object.entries(row)) if(!mutable[key]?.includes(field) && r[field]!==value) throw new AppError('Sicherungsprüfung: Ein Inhalt wurde verändert.');
      }
      counts[key] = actual.length;
    }
    const records=restored.data.publicState?.records||[];
    for(const source of backup.data.publicState?.records||[]){
      if(source.kind==='capability')continue;
      const expected=structuredClone(source),actual=records.find(r=>r.kind===source.kind&&r.id===source.id);
      if(expected.kind==='profile'){
        expected.content.enabled=false;expected.content.binding.credentialRef=null;
        const {hash,...binding}=expected.content.binding;expected.content.binding.hash=stableHash(binding);
      }
      if(expected.kind==='routes')expected.content.enabled=false;
      if(expected.kind==='permission'&&expected.content.status==='reviewed'){expected.content.status='unknown';expected.content.reviewedAt=null;}
      if(expected.kind==='dispatch'&&['reserved','started'].includes(expected.content.state))expected.content.state='unknown';
      if(expected.kind==='model-run'&&['reserved','running'].includes(expected.content.state))expected.content.state='unknown';
      if(expected.kind==='transfer'){if(!actual?.content.revokedAt)throw new AppError('Mailfreigabe wurde beim Restore reaktiviert.');expected.content.revokedAt=actual.content.revokedAt;}
      if(stableHash(expected)!==stableHash(actual))throw new AppError('Sicherungsprüfung: Öffentliche Einstellungen wurden unerwartet verändert.');
    }
    counts.publicRecords=records.length;
    if (store.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || store.db.prepare('PRAGMA foreign_key_check').all().length) throw new AppError('Sicherungsprüfung: Datenbankprüfung fehlgeschlagen.');
    return { checkedAt: new Date().toISOString(), sourceVersion: backup.version, sourceCreatedAt: backup.createdAt, checksum: backup.checksum, schema: 34, counts, restartVerified: true, activeProfileChanged: false };
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

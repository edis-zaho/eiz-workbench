import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {RelayStore} from '../relay/store.ts';
import {runBackup, snapshotExisting} from '../relay/deploy/backup.mjs';

function fixture() {
  mkdirSync('qa', {recursive:true});
  const dir = mkdtempSync(resolve('qa/relay-ops-'));
  const source = join(dir, 'live.sqlite'), root = join(dir, 'backups');
  const store = new RelayStore(source);
  const scope = {stream:randomUUID(), readKey:randomBytes(32).toString('hex'), writeKey:randomBytes(32).toString('hex'), clickHosts:['example.com']};
  const token = randomBytes(32).toString('hex');
  store.register(scope, {token, messageRef:randomUUID(),kind:'open',linkId:null,target:null,expiresAt:new Date(Date.now()+86400000).toISOString()});
  store.capture(token, 'open', [scope], []);
  return {dir, source, root, store, scope, token, config:{source,root,bucket:'synthetic-backup-bucket'}};
}

test('operational snapshot includes live WAL and uploads manifest last without application credentials', async () => {
  const f=fixture(), uploads=[];
  try {
    const result=await runBackup(f.config, async(file,destination)=>uploads.push({file,destination,bytes:readFileSync(file)}));
    assert.equal(result.manifest.observations,1);
    assert.equal(result.manifest.instanceId,f.store.instanceId);
    assert.equal(uploads.length,2);
    assert.ok(uploads[0].destination.endsWith('/relay.sqlite'));
    assert.ok(uploads[1].destination.endsWith('/manifest.json'));
    assert.equal(createHash('sha256').update(uploads[0].bytes).digest('hex'),result.manifest.sha256);
    assert.ok(existsSync(join(result.directory,'uploaded.json')));
    const db=new DatabaseSync(uploads[0].file,{readOnly:true});
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM relay_events').get().n,1); } finally {db.close();}
    for(const secret of [f.scope.readKey,f.scope.writeKey,f.token]) assert.ok(!Buffer.concat(uploads.map(x=>x.bytes)).includes(Buffer.from(secret)));
    // Continuing live writes after the point-in-time snapshot remains possible.
    f.store.capture(f.token,'open',[f.scope],[]);
    assert.equal(f.store.status(f.scope).observations,2);
    assert.equal(result.manifest.observations,1);
  } finally {f.store.close();}
});

test('missing or unrelated database cannot create a misleading empty successful backup', async()=>{
  const f=fixture();
  try {
    const missing=join(f.dir,'misspelled.sqlite');
    let uploaded=0;
    await assert.rejects(runBackup({...f.config,source:missing},async()=>{uploaded++;}));
    assert.equal(existsSync(missing),false);
    const unrelated=join(f.dir,'unrelated.sqlite'),db=new DatabaseSync(unrelated);
    db.exec('CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES (\'keep\')');db.close();
    const before=readFileSync(unrelated);
    await assert.rejects(runBackup({...f.config,source:unrelated},async()=>{uploaded++;}));
    assert.equal(uploaded,0);assert.deepEqual(readFileSync(unrelated),before);
    assert.equal(existsSync(join(f.root,'.backup-lock')),false);
  } finally {f.store.close();}
});

test('operational backup restores through the existing CLI with preserved events and a new identity', async()=>{
  const f=fixture();
  try {
    const result=await runBackup(f.config,async()=>{}), restored=join(f.dir,'restored.sqlite');
    const child=spawnSync(process.execPath,['--import','tsx','relay/run.ts','--restore',join(result.directory,'relay.sqlite'),restored],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,0,child.stderr);
    const db=new DatabaseSync(restored,{readOnly:true});
    try {
      assert.notEqual(db.prepare("SELECT value FROM relay_meta WHERE key='instance'").get().value,f.store.instanceId);
      assert.deepEqual(db.prepare('SELECT * FROM relay_events').all(),f.store.db.prepare('SELECT * FROM relay_events').all());
    } finally {db.close();}
  } finally {f.store.close();}
});

test('failed second upload retains snapshot but never records success; next attempt uses a new destination', async()=>{
  const f=fixture();
  try {
    let calls=0;
    await assert.rejects(runBackup(f.config,async()=>{if(++calls===2)throw Error('synthetic upload failure');}));
    const failed=join(f.root,readdirSync(f.root).find(x=>x.startsWith('snapshot-')));
    assert.ok(existsSync(join(failed,'relay.sqlite')));
    assert.equal(existsSync(join(failed,'uploaded.json')),false);
    const done=await runBackup(f.config,async()=>{});
    assert.notEqual(done.directory,failed);
    assert.ok(existsSync(join(done.directory,'uploaded.json')));
  } finally {f.store.close();}
});

test('overlapping backup and unsafe target configuration fail before upload', async()=>{
  const f=fixture();
  try {
    mkdirSync(f.root);mkdirSync(join(f.root,'.backup-lock'));
    let calls=0;
    await assert.rejects(runBackup(f.config,async()=>{calls++;}));
    assert.ok(existsSync(join(f.root,'.backup-lock')));
    for(const config of [{...f.config,bucket:'other-bucket/evil'}, {...f.config,root:f.dir}, {...f.config,source:'relative.sqlite'}])
      await assert.rejects(runBackup(config,async()=>{calls++;}));
    assert.equal(calls,0);
  } finally {f.store.close();}
});

test('snapshot refuses overwrite and CLI failure never prints environment secrets', async()=>{
  const f=fixture();
  try {
    const destination=join(f.dir,'snapshot');mkdirSync(destination);
    writeFileSync(join(destination,'snapshot.pending'),'preserve');
    await assert.rejects(snapshotExisting(f.source,destination));
    assert.equal(readFileSync(join(destination,'snapshot.pending'),'utf8'),'preserve');
    const child=spawnSync(process.execPath,['relay/deploy/backup.mjs'],{encoding:'utf8',windowsHide:true,env:{...process.env,EIZ_RELAY_DATABASE:f.source,EIZ_RELAY_BACKUP_DIR:f.root,EIZ_RELAY_BACKUP_BUCKET:'synthetic-private-secret/invalid'}});
    assert.equal(child.status,1);
    assert.match(child.stderr,/RELAY_BACKUP_FAILED/);
    assert.ok(!child.stderr.includes('synthetic-private-secret'));
    assert.ok(!child.stderr.includes(f.source));
  } finally {f.store.close();}
});

// Node 24+, no application credentials and no network except the explicit GCS upload.
import {DatabaseSync, backup} from 'node:sqlite';
import {createReadStream} from 'node:fs';
import {mkdir, mkdtemp, lstat, chmod, writeFile, rename, rmdir, statfs} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute, join, resolve, basename, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function inspect(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1 ||
      db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('INVALID_RELAY_DATABASE');
  const instanceId = db.prepare("SELECT value FROM relay_meta WHERE key='instance'").get()?.value;
  if (typeof instanceId !== 'string' || !uuid.test(instanceId)) throw Error('INVALID_RELAY_IDENTITY');
  return {
    instanceId,
    registrations: Number(db.prepare('SELECT COUNT(*) AS n FROM relay_tokens').get().n),
    observations: Number(db.prepare('SELECT COUNT(*) AS n FROM relay_events').get().n),
    lastCursor: Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM relay_events').get().n),
  };
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function snapshotExisting(source, directory) {
  // readOnly + lstat prevent accidental initialization at a misspelled path.
  if (!isAbsolute(source) || !isAbsolute(directory)) throw Error('ABSOLUTE_PATHS_REQUIRED');
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw Error('REGULAR_DATABASE_REQUIRED');
  const db = new DatabaseSync(source, {readOnly: true});
  let pending;
  try {
    inspect(db);
    pending = join(directory, 'snapshot.pending');
    await writeFile(pending, '', {flag: 'wx', mode: 0o600});
    await backup(db, pending);
  } finally { db.close(); }
  await chmod(pending, 0o600);
  const snapshot = new DatabaseSync(pending, {readOnly: true});
  let contents;
  try { contents = inspect(snapshot); } finally { snapshot.close(); }
  const file = join(directory, 'relay.sqlite');
  // Exclusive per-run directory; failed snapshots are never named as complete.
  if (await lstat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw Error('SNAPSHOT_EXISTS');
  await rename(pending, file);
  const manifest = {version: 1, createdAt: new Date().toISOString(), ...contents,
    bytes: (await lstat(file)).size, sha256: await sha256(file)};
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return manifest;
}

export function uploadWithGcloud(file, destination) {
  return new Promise((accept, reject) => {
    // Service-account metadata credentials on the VM, no exported JSON key.
    // Fixed executable, argument array, no shell, no credential-bearing child output.
    const child = spawn('/usr/bin/gcloud', ['storage', 'cp', '--quiet', '--if-generation-match=0', file, destination],
      {shell: false, stdio: 'ignore', timeout: 180000, windowsHide: true});
    child.once('error', () => reject(Error('BACKUP_UPLOAD_FAILED')));
    child.once('exit', code => code === 0 ? accept() : reject(Error('BACKUP_UPLOAD_FAILED')));
  });
}

export async function runBackup({source, root, bucket}, upload = uploadWithGcloud) {
  if (!isAbsolute(source) || !isAbsolute(root) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '')) throw Error('INVALID_BACKUP_CONFIGURATION');
  if (resolve(source).startsWith(resolve(root) + sep) || resolve(source) === resolve(root)) throw Error('BACKUP_DIRECTORY_CONTAINS_DATABASE');
  await mkdir(root, {recursive: true, mode: 0o700});
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('REGULAR_BACKUP_DIRECTORY_REQUIRED');
  const space = await statfs(root);
  if (space.bavail * space.bsize < 512 * 1024 * 1024) throw Error('BACKUP_DISK_LOW');
  const lock = join(root, '.backup-lock');
  await mkdir(lock, {mode: 0o700}); // Fail closed on overlap or stale lock after power loss.
  try {
    const directory = await mkdtemp(join(root, 'snapshot-'));
    await chmod(directory, 0o700);
    const manifest = await snapshotExisting(source, directory);
    const prefix = 'gs://' + bucket + '/' + basename(directory);
    await upload(join(directory, 'relay.sqlite'), prefix + '/relay.sqlite');
    await upload(join(directory, 'manifest.json'), prefix + '/manifest.json');
    // Receipt only after BOTH objects succeeded. Failed jobs remain for diagnosis.
    await writeFile(join(directory, 'uploaded.json'), JSON.stringify({version: 1, completedAt: new Date().toISOString(), sha256: manifest.sha256}) + '\n', {flag: 'wx', mode: 0o600});
    return {directory, manifest};
  } finally { await rmdir(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runBackup({source: process.env.EIZ_RELAY_DATABASE || '', root: process.env.EIZ_RELAY_BACKUP_DIR || '', bucket: process.env.EIZ_RELAY_BACKUP_BUCKET || ''});
    console.log('RELAY_BACKUP_UPLOADED');
  } catch {
    // No raw child error, path, URL, environment or record content in logs.
    console.error('RELAY_BACKUP_FAILED: inspect service state, private pending backups, disk space and bucket permissions.');
    process.exitCode = 1;
  }
}

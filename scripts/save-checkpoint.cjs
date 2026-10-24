const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
function saveCheckpoint(destination, profile) {
  if (!destination || !profile) throw new Error('Destination and profile required');
  const db = new DatabaseSync(join(profile, 'revenue.sqlite'), { readOnly: true });
  const data = {}; let version;
  try {
    db.exec('BEGIN');
    version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if(version<1 || version>34) throw new Error('Unsupported profile schema; no backup written');
    for(const [key,table,order,min] of [['threadContexts','thread_contexts','id',23],['experiments','experiment_versions','id',17],['strategies','strategy_versions','id',15],['knowledge','knowledge_versions','id',13],['interpretations','interpretations','id',12],['evidenceEvents','evidence_events','id',11],['products','products','id',9],['productRevisions','product_revisions','id',9],['accounts','accounts','id',9],['accountRevisions','account_revisions','id',9],['leadAccountLinks','lead_account_links','id',9],['queueRuns','queue_runs','id',8],['queueItems','queue_items','id',8],['mailSync','mail_sync','clientId',7],['incoming','incoming','id',6],['clients','clients','id',1],['jobs','jobs','id',1],['events','events','id',1],['briefs','briefs','clientId',2],['aiRuns','ai_runs','id',2],['briefHistory','brief_history','id',2],['leads','leads','id',3],['mailTests','mail_tests','id',4],['campaigns','campaigns','id',5],['campaignHistory','campaign_history','id',5]]) {
      if(version>=min) data[key]=db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    }
    if(version>=34)data.publicState={version:1,records:db.prepare('SELECT * FROM public_records ORDER BY kind,id').all().map(r=>({...r,content:JSON.parse(r.content)}))};
    db.exec('COMMIT');
  } finally { db.close(); }
  const createdAt = new Date().toISOString();
  const checksum = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const backup = {format:'eiz-revenue-backup',version,createdAt,checksum,data};
  mkdirSync(destination,{recursive:true});
  const filename=join(destination,`EiZ-Sicherung-${createdAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.json`);
  writeFileSync(filename,JSON.stringify(backup),{flush:true,flag:'wx'});
  const checked=JSON.parse(readFileSync(filename,'utf8'));
  if(createHash('sha256').update(JSON.stringify(checked.data)).digest('hex')!==checksum)throw new Error('Checksum mismatch');
  return {filename,profile:resolve(profile),version,checksumVerified:true,counts:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.length])),secretsIncluded:false};
}
module.exports={saveCheckpoint};
if(require.main===module){if(process.argv.length!==4)throw Error('Usage: node scripts/save-checkpoint.cjs <destination> <explicit-profile-directory>. Writes a plaintext checkpoint; use synthetic data only.');console.log(saveCheckpoint(process.argv[2],process.argv[3]));}

declare const EIZ_PUBLIC_BUILD:boolean;
import {contactPermissionProblems} from './contact-permission';
import {isDeletedAddress,protectRetentionRestore} from './data-retention';
import {encryptLocalBackup,decryptLocalBackup,decryptPortableBackup} from '../electron/backup-crypto.cjs';
import {taskRoute,bindModelRun,historicalModelRoute,modelSetup} from './model-jobs';
import {mailPresentation,freezeMailPresentation,senderFingerprint} from './mail-presentation';
import {publicRecords,putPublicRecord,migratePublicSchema,exportPublicState,validatePublicState,mergePublicState,restorePublicState} from './public-schema';
import {validateTracking,mergeTracking} from './tracking';
import {validateGmailReferences,preserveGmailReferences} from './gmail-reference';
import {validateRelay,mergeRelay} from './relay-sync';
import {validateMeetings,mergeMeetings} from './meetings';
import {validateSignals,mergeSignals} from './signals';
import {expireAnalysis,protectAnalysisRestore,validateAnalysisAuto} from './analysis-auto';
import {protectApprovalRestore,validateApproval} from './reply-approval';
import {expirePreparation,protectPreparationRestore,validatePreparation} from './reply-preparation';
import {expireAuto,protectAutoRestore,validateAuto} from './dialogue-auto';
import {dialogueRecord,validateDialogue,protectDialogueRestore} from './dialogue-send';
import {validateReplyWriting,mergeReplyWriting} from './reply-writing';
import {migrateThreadContexts,exportThreadContexts,validateThreadContexts,mergeThreadContexts,restoreThreadContexts} from './thread-context';
import {validateWritingRuns,mergeWritingRuns} from './campaign-writing';
import {mergeReplyRuns,validateReplyRuns} from './reply-analysis';
import {mergeConversations,validateConversations} from './conversations';
import {campaignMessaging,validateCampaignMessagingBackup} from './campaign-messaging';
import {campaignExperiment,checkCampaignExperiment,experimentReservationProblems,validateCampaignExperimentBackup} from './campaign-experiment';
import {migrateExperiments,exportExperiments,validateExperimentBackup,protectExperimentRestore,restoreExperiments} from './experiments';
import {campaignStrategy,checkCampaignStrategy,validateCampaignStrategyBackup} from './campaign-strategy';
import {migrateStrategy,exportStrategy,validateStrategyBackup,mergedStrategy,restoreStrategy} from './strategy';
import {campaignKnowledge,checkCampaignKnowledge,validateCampaignKnowledgeBackup} from './campaign-knowledge';
import {migrateKnowledge,exportKnowledge,validateKnowledgeBackup,mergedKnowledge,restoreKnowledge} from './knowledge';
import {validateKnowledgeRuns,mergeKnowledgeRuns} from './knowledge-runs';
import {migrateInterpretations,exportInterpretations,validateInterpretationBackup,mergedInterpretations,restoreInterpretations} from './interpretations';
import { campaignProduct, checkProductAssignment, validateCampaignProductBackup, protectCampaignProductRestore } from './campaign-product';
import {migrateEvidence,exportEvidenceJournal,validateEvidenceBackup,mergedEvidenceForRestore,suspendEvidenceTriggers,restoreEvidenceJournal} from './evidence-journal';
import {validateQueueBackup,reconcileOutbound} from './outbox';
import {validateUnassignedBackup} from './unassigned';
import { companyStop, validateOperations } from './operations';
import { validateIncoming } from './inbox';
import { type SyncState } from './sync';
import { migrateCatalog, exportCatalog, clearCatalog, restoreCatalog, protectCatalogRestore, validateCatalogBackup } from './catalog';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readdirSync,statSync,unlinkSync } from 'node:fs';
import { dirname, join,resolve,sep } from 'node:path';
import type { Backup, BackupData, Client, ClientInput, Job, LedgerEvent } from './types';
import { validateCampaign, personalize, type CampaignRow, type CampaignHistory } from './campaign';
import { validateMailInput, type MailTest, type MailTestInput } from './mail';
import { candidates, validEmail, type Lead, type ImportInput, type Preview } from './leads';
import { emptyBrief, validateBrief, validateRules, validateRoute, approvalProblems, type BriefRecord, type Source, type AIRun } from './brief';

export class AppError extends Error { constructor(message: string, public status = 400) { super(message); } }
const now = () => new Date().toISOString();
const checksum = (data: BackupData) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const string = (value: unknown, max: number, label: string) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError(`${label} ist ungültig.`); return value.trim(); };
export function validateClient(input: unknown): ClientInput {
  if (!input || typeof input !== 'object') throw new AppError('Kundendaten fehlen.');
  const c = input as Record<string, unknown>;
  const name = string(c.name, 160, 'Name'); if (!name) throw new AppError('Bitte einen Kundennamen angeben.');
  let website = string(c.website, 2000, 'Website');
  if (website) {
    try { const url = new URL(website); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); website = url.href; }
    catch { throw new AppError('Bitte eine vollständige Website-Adresse mit https:// angeben.'); }
  }
  const email = string(c.email, 254, 'E-Mail');
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new AppError('Die E-Mail-Adresse ist ungültig.');
  return { name, website, email, notes: string(c.notes, 12000, 'Notizen') };
}

export class Store {
  publicMode=false;
  readonly db: DatabaseSync;
  constructor(readonly filename: string, private backupDirectory: string, seed = true,private backupKey?:Buffer) {
    mkdirSync(dirname(filename), { recursive: true });
    mkdirSync(backupDirectory, { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > 34) { this.db.close(); throw new Error('Diese Datenbank benötigt eine neuere Workbench-Version.'); }
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT NOT NULL, email TEXT NOT NULL, notes TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('setup','paused')), version INTEGER NOT NULL CHECK(version>0), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          CREATE TABLE jobs (id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id), kind TEXT NOT NULL CHECK(kind='diagnostic'), status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','held','cancelled')), dueAt TEXT NOT NULL, createdAt TEXT NOT NULL, completedAt TEXT, attempts INTEGER NOT NULL CHECK(attempts>=0), result TEXT NOT NULL, UNIQUE(id,clientId));
          CREATE TABLE events (id TEXT PRIMARY KEY, clientId TEXT REFERENCES clients(id), jobId TEXT, type TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY(jobId,clientId) REFERENCES jobs(id,clientId), CHECK(jobId IS NULL OR clientId IS NOT NULL));
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE INDEX job_due ON jobs(status,dueAt);
          CREATE INDEX job_client ON jobs(clientId,createdAt);
          CREATE INDEX event_client ON events(clientId,createdAt);
          PRAGMA user_version=1;
        `);
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('app', 'eiz-revenue-workbench');
        if (seed && (typeof EIZ_PUBLIC_BUILD==='undefined'||!EIZ_PUBLIC_BUILD)) this.insertClient({ name: 'Example Company', website: 'https://www.example.com/', email: 'private-owner@example.invalid', notes: 'Erster eigener Kundenbereich. Angebot, Zielgruppen und Betriebsrahmen werden gemeinsam ausgearbeitet. Noch keine Kampagne freigegeben.' });
      });
    }
    if (this.db.prepare("SELECT value FROM meta WHERE key='app'").get()?.value !== 'eiz-revenue-workbench') { this.db.close(); throw new Error('Keine Revenue-Workbench-Datenbank.'); }
    if(version>0 && version<34) this.saveMigrationBackup(version);
    if(version<2) this.transaction(()=>{
      this.db.exec(`CREATE TABLE briefs (clientId TEXT PRIMARY KEY REFERENCES clients(id), revision INTEGER NOT NULL, content TEXT NOT NULL, approvedAt TEXT, approvedClientVersion INTEGER, updatedAt TEXT NOT NULL);
        CREATE TABLE ai_runs (id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id), purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL, clientVersion INTEGER NOT NULL, status TEXT NOT NULL, context TEXT NOT NULL, result TEXT NOT NULL, usage TEXT NOT NULL, createdAt TEXT NOT NULL, review TEXT NOT NULL);
        CREATE TABLE brief_history (id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id), revision INTEGER NOT NULL, content TEXT NOT NULL, action TEXT NOT NULL, clientVersion INTEGER NOT NULL, createdAt TEXT NOT NULL);
        CREATE INDEX ai_client ON ai_runs(clientId,createdAt); PRAGMA user_version=2;`);
    });
    if(version<3) this.transaction(()=>{this.db.exec(`CREATE TABLE leads (id TEXT PRIMARY KEY, clientId TEXT NOT NULL REFERENCES clients(id), email TEXT NOT NULL, firstName TEXT NOT NULL, lastName TEXT NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), blockReason TEXT NOT NULL, UNIQUE(clientId,email)); CREATE INDEX lead_client ON leads(clientId,createdAt); PRAGMA user_version=3;`);});
    if(version<4)this.transaction(()=>this.db.exec(`CREATE TABLE mail_tests (id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),mailboxId TEXT NOT NULL,sender TEXT NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,messageId TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','unknown')),providerId TEXT NOT NULL,result TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);CREATE INDEX mail_client ON mail_tests(clientId,createdAt);PRAGMA user_version=4;`));
    if(version<5)this.transaction(()=>this.db.exec(`CREATE TABLE campaigns(id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),revision INTEGER NOT NULL,content TEXT NOT NULL,approvedHash TEXT,approvedAt TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);CREATE TABLE campaign_history(id TEXT PRIMARY KEY,campaignId TEXT NOT NULL REFERENCES campaigns(id),clientId TEXT NOT NULL REFERENCES clients(id),revision INTEGER NOT NULL,action TEXT NOT NULL,content TEXT NOT NULL,fingerprint TEXT NOT NULL,createdAt TEXT NOT NULL);PRAGMA user_version=5;`));
    if(version<6)this.transaction(()=>this.db.exec(`CREATE TABLE incoming(id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),mailId TEXT NOT NULL REFERENCES mail_tests(id),mailboxId TEXT NOT NULL,providerId TEXT NOT NULL,threadId TEXT NOT NULL,sender TEXT NOT NULL,subject TEXT NOT NULL,excerpt TEXT NOT NULL,receivedAt TEXT NOT NULL,kind TEXT NOT NULL,disposition TEXT NOT NULL,evidence TEXT NOT NULL,createdAt TEXT NOT NULL,recipient TEXT NOT NULL,UNIQUE(clientId,mailId,providerId)); CREATE INDEX incoming_stop ON incoming(clientId,recipient); PRAGMA user_version=6;`));
    if(version<7)this.transaction(()=>this.db.exec(`CREATE TABLE mail_sync(clientId TEXT PRIMARY KEY REFERENCES clients(id),mailboxId TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),status TEXT NOT NULL CHECK(status IN ('idle','running','failed')),lastStartedAt TEXT,lastSuccessAt TEXT,nextAttemptAt TEXT,lastError TEXT NOT NULL,consecutiveFailures INTEGER NOT NULL CHECK(consecutiveFailures>=0),updatedAt TEXT NOT NULL); PRAGMA user_version=7;`));
    if(version<8)this.transaction(()=>this.db.exec(`CREATE TABLE queue_runs(id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),campaignId TEXT NOT NULL REFERENCES campaigns(id),fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,reason TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode='rehearsal'),UNIQUE(campaignId,fingerprint)); CREATE TABLE queue_items(id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES queue_runs(id),leadId TEXT NOT NULL REFERENCES leads(id),recipient TEXT NOT NULL,step INTEGER NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,eligibleDate TEXT,simulatedAt TEXT,localDay TEXT,reason TEXT NOT NULL,UNIQUE(runId,leadId,step)); CREATE INDEX queue_due ON queue_items(runId,status,eligibleDate); CREATE INDEX queue_client ON queue_runs(clientId,status); PRAGMA user_version=8;`));
    if(version<9) { try { this.transaction(()=>migrateCatalog(this)); } catch(error) { this.db.close(); throw error; } }
    if(version<10) this.transaction(()=>this.db.exec('PRAGMA user_version=10'));
    if(version<11) {try{this.transaction(()=>migrateEvidence(this));}catch(error){this.db.close();throw error;}}
    if(version<12) {try{this.transaction(()=>migrateInterpretations(this));}catch(error){this.db.close();throw error;}}
    if(version<13) {try{this.transaction(()=>migrateKnowledge(this));}catch(error){this.db.close();throw error;}}
    if(version<14)this.transaction(()=>this.db.exec('PRAGMA user_version=14'));
    if(version<15){try{this.transaction(()=>migrateStrategy(this));}catch(error){this.db.close();throw error;}}
    if(version<16)this.transaction(()=>this.db.exec('PRAGMA user_version=16'));
    if(version<17){try{this.transaction(()=>migrateExperiments(this));}catch(error){this.db.close();throw error;}}
    if(version<18)this.transaction(()=>this.db.exec('PRAGMA user_version=18'));
    if(version<19)this.transaction(()=>this.db.exec('PRAGMA user_version=19'));
    if(version<20)this.transaction(()=>this.db.exec('PRAGMA user_version=20'));
    if(version<21)this.transaction(()=>this.db.exec('PRAGMA user_version=21'));
    if(version<22)this.transaction(()=>this.db.exec('PRAGMA user_version=22'));
    if(version<23)this.transaction(()=>{migrateThreadContexts(this);this.db.exec('PRAGMA user_version=23');});
    if(version<24)this.transaction(()=>this.db.exec('PRAGMA user_version=24'));
    if(version<25)this.transaction(()=>this.db.exec('PRAGMA user_version=25'));
    if(version<26)this.transaction(()=>this.db.exec('CREATE INDEX IF NOT EXISTS event_type_client ON events(type,clientId); PRAGMA user_version=26'));
    if(version<27)this.transaction(()=>this.db.exec('PRAGMA user_version=27'));
    if(version<28)this.transaction(()=>this.db.exec('PRAGMA user_version=28'));
    if(version<29)this.transaction(()=>this.db.exec('PRAGMA user_version=29'));
    if(version<30)this.transaction(()=>this.db.exec('PRAGMA user_version=30'));
    if(version<31)this.transaction(()=>this.db.exec('PRAGMA user_version=31'));
    if(version<33)this.transaction(()=>this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tracking_mail_event ON events(clientId,type,json_extract(text,'$.mailId')) WHERE type IN ('TRACKING_PREPARED','TRACKING_REGISTERED'); CREATE UNIQUE INDEX IF NOT EXISTS relay_binding_ref ON events(json_extract(text,'$.stream'),json_extract(text,'$.messageRef')) WHERE type='RELAY_BOUND'; PRAGMA user_version=33`));
    if(version<34)this.transaction(()=>migratePublicSchema(this));
    for(const r of publicRecords(this,'dispatch'))if(['reserved','started'].includes(r.content.state)){r.content.state='unknown';r.revision++;putPublicRecord(this,r);}
    for(const r of publicRecords(this,'model-run'))if(r.content.state==='reserved'){r.content.state='unknown';r.revision++;putPublicRecord(this,r);}
    expireAnalysis(this,true);expireAuto(this,true);expirePreparation(this,true);
    this.db.prepare("UPDATE mail_sync SET status='failed',nextAttemptAt=?,lastError='Synchronisation beim Neustart unterbrochen. Neuer kontrollierter Versuch wird eingeplant.',consecutiveFailures=consecutiveFailures+1,updatedAt=? WHERE status='running'").run(now(),now());
    this.db.prepare("UPDATE mail_tests SET status='unknown',result='Beim Neustart unterbrochen. Versand in Gmail prüfen. Keine automatische Wiederholung.',updatedAt=? WHERE status='sending'").run(now());
    this.db.prepare("UPDATE queue_items SET status='unknown',reason='Beim Neustart unterbrochen. Gmail prüfen; keine automatische Wiederholung.' WHERE status='sending'").run();
    this.db.prepare("UPDATE queue_runs SET status='paused',revision=revision+1,reason='Versandergebnis nach Neustart unklar. Gmail prüfen.',updatedAt=? WHERE id IN (SELECT runId FROM queue_items WHERE status='unknown') AND status='active'").run(now());
    this.db.prepare("UPDATE ai_runs SET status='unknown',result='Beim Neustart unterbrochen. Keine automatische Wiederholung; mögliche API-Kosten beim Anbieter prüfen.' WHERE status='running'").run();
    // Only harmless diagnostics exist in this release. Interrupted jobs are held, never silently replayed.
    this.transaction(() => {
      for (const job of this.db.prepare("SELECT * FROM jobs WHERE status='running'").all() as unknown as Job[]) {
        this.db.prepare("UPDATE jobs SET status='held', result=? WHERE id=?").run('Bei Neustart unterbrochen. Bewusst erneut einplanen.', job.id);
        this.event(job.clientId, job.id, 'JOB_HELD', 'Unterbrochener Testauftrag zur Prüfung angehalten.');
      }
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(clientId: string | null, jobId: string | null, type: string, text: string) {
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(randomUUID(), clientId, jobId, type, text, now());
  }
  client(id: string): Client {
    const c = this.db.prepare('SELECT * FROM clients WHERE id=?').get(id) as Client | undefined;
    if (!c) throw new AppError('Kunde nicht gefunden.', 404); return c;
  }
  private insertClient(data: ClientInput) {
    const id = randomUUID(), at = now();
    this.db.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?)').run(id, data.name, data.website, data.email, data.notes, 'setup', 1, at, at);
    this.event(id, null, 'CLIENT_CREATED', 'Kundenbereich angelegt. Versand ist nicht freigegeben.');
    return this.client(id);
  }
  createClient(input: unknown) { const data = validateClient(input); return this.transaction(() => this.insertClient(data)); }
  updateClient(id: string, input: unknown, version: number) {
    const data = validateClient(input);
    return this.transaction(() => {
      const c = this.client(id);
      if (c.version !== version) throw new AppError('Dieser Kunde wurde zwischenzeitlich geändert. Bitte neu laden.', 409);
      this.db.prepare('UPDATE clients SET name=?,website=?,email=?,notes=?,version=version+1,updatedAt=? WHERE id=?').run(data.name, data.website, data.email, data.notes, now(), id);
      this.event(id, null, 'CLIENT_UPDATED', 'Kundenangaben aktualisiert.'); return this.client(id);
    });
  }
  pauseClient(id: string, paused: boolean, version: number) {
    return this.transaction(() => {
      const c = this.client(id);
      if (c.version !== version) throw new AppError('Kundenstatus wurde geändert. Bitte neu laden.', 409);
      this.db.prepare('UPDATE clients SET status=?,version=version+1,updatedAt=? WHERE id=?').run(paused ? 'paused' : 'setup', now(), id);
      this.event(id, null, paused ? 'CLIENT_PAUSED' : 'CLIENT_RESUMED', paused ? 'Verarbeitung dieses Kunden pausiert.' : 'Einrichtung fortgesetzt. Kein Versand freigegeben.');
      return this.client(id);
    });
  }
  enqueueDiagnostic(clientId: string, delaySeconds: number) {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600) throw new AppError('Ungültiger Testzeitpunkt.');
    return this.transaction(() => {
      const c = this.client(clientId); if (c.status === 'paused') throw new AppError('Dieser Kunde ist pausiert.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(id, clientId, 'diagnostic', 'queued', new Date(Date.now() + delaySeconds * 1000).toISOString(), now(), null, 0, '');
      this.event(clientId, id, 'JOB_QUEUED', 'Lokaler Funktionstest eingeplant. Kein API-Aufruf, keine E-Mail.'); return id;
    });
  }
  cancelJob(clientId: string, id: string) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id=? AND clientId=?').get(id, clientId) as Job | undefined;
      if (!job) throw new AppError('Auftrag nicht gefunden.', 404);
      if (!['queued', 'held'].includes(job.status)) throw new AppError('Dieser Auftrag kann nicht mehr abgebrochen werden.', 409);
      this.db.prepare("UPDATE jobs SET status='cancelled',completedAt=?,result=? WHERE id=?").run(now(), 'Vom Betreiber abgebrochen.', id);
      this.event(clientId, id, 'JOB_CANCELLED', 'Testauftrag abgebrochen.');
    });
  }
  runDueJobs(at = now()) {
    const jobs = this.db.prepare("SELECT j.* FROM jobs j JOIN clients c ON c.id=j.clientId WHERE j.status='queued' AND j.dueAt<=? AND c.status<>'paused' ORDER BY j.dueAt,j.id LIMIT 25").all(at) as unknown as Job[];
    let completed = 0;
    for (const job of jobs) this.transaction(() => {
      const claimed = this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM clients WHERE id=? AND status<>'paused')").run(job.id, job.clientId);
      if (!claimed.changes) return;
      this.db.prepare("UPDATE jobs SET status='done',completedAt=?,result=? WHERE id=?").run(at, 'Datenbank, Kundenzuordnung und Hintergrundverarbeitung erfolgreich geprüft.', job.id);
      this.event(job.clientId, job.id, 'JOB_COMPLETED', 'Lokaler Funktionstest erfolgreich abgeschlossen. Keine externe Aktion ausgeführt.'); completed++;
    });
    return completed;
  }
  snapshot(clientId?: string) {
    if (clientId) this.client(clientId);
    const filter = clientId ? ' WHERE clientId=?' : '', args = clientId ? [clientId] : [];
    return {
      clients: this.db.prepare('SELECT * FROM clients ORDER BY createdAt,id').all() as unknown as Client[],
      jobs: this.db.prepare(`SELECT * FROM jobs${filter} ORDER BY createdAt DESC,id LIMIT 100`).all(...args) as unknown as Job[],
      events: this.db.prepare(`SELECT * FROM events${filter} ORDER BY createdAt DESC,rowid DESC LIMIT 100`).all(...args) as unknown as LedgerEvent[],
      jobCounts: Object.fromEntries(this.db.prepare(`SELECT status,COUNT(*) AS count FROM jobs${filter} GROUP BY status`).all(...args).map(r => [r.status, r.count])),
      database: { schema: 34, engine: 'SQLite' },
      latestBackup: this.db.prepare("SELECT value FROM meta WHERE key='latestBackup'").get()?.value as string | undefined || null
    };
  }
  exportBackup(): Backup {
    return this.transaction(() => {
      const data: BackupData = { clients: this.db.prepare('SELECT * FROM clients ORDER BY id').all() as unknown as Client[], jobs: this.db.prepare('SELECT * FROM jobs ORDER BY id').all() as unknown as Job[], events: this.db.prepare('SELECT * FROM events ORDER BY id').all() as unknown as LedgerEvent[] };
      data.briefs = this.db.prepare('SELECT * FROM briefs ORDER BY clientId').all() as any;
      data.aiRuns = this.db.prepare('SELECT * FROM ai_runs ORDER BY id').all() as any;
      data.briefHistory = this.db.prepare('SELECT * FROM brief_history ORDER BY id').all() as any;
      data.leads = this.db.prepare('SELECT * FROM leads ORDER BY id').all() as unknown as Lead[];
      data.incoming = this.db.prepare('SELECT * FROM incoming ORDER BY id').all() as any;
      data.mailSync = this.db.prepare('SELECT * FROM mail_sync ORDER BY clientId').all() as unknown as SyncState[];
      data.mailTests = this.db.prepare('SELECT * FROM mail_tests ORDER BY id').all() as unknown as MailTest[];
      data.campaigns=this.db.prepare('SELECT * FROM campaigns ORDER BY id').all() as unknown as CampaignRow[];
      data.campaignHistory=this.db.prepare('SELECT * FROM campaign_history ORDER BY id').all() as unknown as CampaignHistory[];
      data.queueRuns=this.db.prepare('SELECT * FROM queue_runs ORDER BY id').all() as any;data.queueItems=this.db.prepare('SELECT * FROM queue_items ORDER BY id').all() as any;
      Object.assign(data,exportCatalog(this));
      data.evidenceEvents=exportEvidenceJournal(this);
      data.interpretations=exportInterpretations(this);
      data.knowledge=exportKnowledge(this);
      data.strategies=exportStrategy(this);
      data.experiments=exportExperiments(this);
      data.threadContexts=exportThreadContexts(this);
      data.publicState=exportPublicState(this);
      return { format: 'eiz-revenue-backup', version: 34, createdAt: now(), checksum: checksum(data), data };
    });
  }
  localBackupInventory(){return readdirSync(this.backupDirectory).filter(n=>/^workbench-.*\.(json|eizbackup)$/.test(n)).sort().map(name=>{const x=statSync(join(this.backupDirectory,name));return {name,size:x.size,modified:x.mtimeMs};});}
  removeLocalBackups(files:{name:string;size:number;modified:number}[]){const remaining:string[]=[];for(const f of files){const path=resolve(this.backupDirectory,f.name);if(!path.startsWith(resolve(this.backupDirectory)+sep)||f.name.includes('/')||f.name.includes('\\'))throw new AppError('Ungültiger Sicherungspfad.');try{const stat=statSync(path);if(stat.size!==f.size||stat.mtimeMs!==f.modified)throw new Error();unlinkSync(path);}catch{remaining.push(f.name);}}return remaining;}
  saveBackup(reason = 'manual') {
    const backup = this.exportBackup();
    const filename = join(this.backupDirectory, `workbench-${reason}-${backup.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${this.backupKey?'eizbackup':'json'}`);
    writeFileSync(filename + '.tmp', this.backupKey?encryptLocalBackup(Buffer.from(JSON.stringify(backup)),this.backupKey):JSON.stringify(backup), { flush: true });
    renameSync(filename + '.tmp', filename);
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('latestBackup',?)").run(backup.createdAt);
    return { filename, backup };
  }
  async decodeBackup(bytes:Buffer,passphrase?:string){const v=JSON.parse(bytes.toString('utf8'));if(v?.format!=='eiz-encrypted-backup')return bytes;if(v.mode==='password')return decryptPortableBackup(bytes,passphrase||'');if(!this.backupKey)throw new AppError('Sicherung gehört zu einem anderen Windows-Profil. Passwortexport verwenden.');return decryptLocalBackup(bytes,this.backupKey);}
  restore(input: unknown) {
    const backup = structuredClone(validateBackup(input));protectRetentionRestore(this,backup.data);
    preserveGmailReferences(this,backup.data);
    protectDialogueRestore(this,backup.data);protectAutoRestore(this,backup.data);protectPreparationRestore(this,backup.data);protectApprovalRestore(this,backup.data);protectAnalysisRestore(this,backup.data);
    protectCatalogRestore(this,backup.data);
    protectExperimentRestore(this,backup.data);
    protectCampaignProductRestore(this,backup.data);
    // A restore cannot forget an external effect. Until history merging exists,
    // reject backups that regress any campaign attempt, even a cancelled run.
    if(this.db.prepare("SELECT id FROM mail_tests WHERE status='sending' LIMIT 1").get())throw new AppError('Versand ist noch offen. Vor Wiederherstellung Ergebnis klären.');
    for(const q of this.db.prepare("SELECT q.* FROM queue_items q JOIN mail_tests m ON m.id=q.id").all()){
      const old=(backup.data.queueItems||[]).find(x=>x.id===q.id);
      const mail=this.db.prepare('SELECT * FROM mail_tests WHERE id=?').get(q.id)!;
      const saved=(backup.data.mailTests||[]).find(x=>x.id===q.id);
      if(!old||!saved||Object.keys(mail).some(k=>(saved as any)[k]!==mail[k])||Object.keys(q).some(k=>(old as any)[k]!==q[k]))throw new AppError('Diese Sicherung würde Kampagnen-Versandhistorie zurücksetzen. Aktuelle Sicherung verwenden; bestehende Daten bleiben erhalten.');
    }
    // An older backup must not erase a response/opt-out already observed here.
    const restoredClients=new Set(backup.data.clients.map(c=>c.id));
    // Older backups cannot remove a company suppression already observed here.
    for(const e of this.db.prepare("SELECT * FROM events WHERE type IN ('COMPANY_DOMAIN_BLOCKED','UNASSIGNED_FOUND','UNASSIGNED_DECIDED')").all() as any[]){
      if(!restoredClients.has(e.clientId))continue;
      const existing=backup.data.events.find(x=>x.id===e.id);
      if(existing&&(existing.type!==e.type||existing.clientId!==e.clientId||existing.text!==e.text))throw new AppError('Sicherung widerspricht einer Unternehmenssperre.');
      if(!existing)backup.data.events.push(e);
    }
    for(const row of this.db.prepare('SELECT * FROM incoming').all() as unknown as import('./inbox').Incoming[]){
      if(!restoredClients.has(row.clientId))continue;
      backup.data.mailTests ||= [];backup.data.incoming ||= [];
      const source=this.db.prepare('SELECT * FROM mail_tests WHERE id=? AND clientId=?').get(row.mailId,row.clientId) as unknown as MailTest;
      const existing=backup.data.mailTests.find(m=>m.id===row.mailId);
      if(existing&&(existing.clientId!==row.clientId||existing.mailboxId!==row.mailboxId||existing.recipient!==row.recipient))throw new AppError('Sicherung widerspricht einem bereits bekannten Kontaktstopp.');
      if(!existing)backup.data.mailTests.push(source);
      const index=backup.data.incoming.findIndex(r=>r.id===row.id);
      if(index<0)backup.data.incoming.push(row);
      else if(backup.data.incoming[index].disposition!=='unsubscribe')backup.data.incoming[index]=row;
    }
    backup.checksum=checksum(backup.data);validateBackup(backup);
    const evidence=mergedEvidenceForRestore(this,backup.data);
    const interpretations=mergedInterpretations(this,backup.data,evidence);
    const knowledge=mergedKnowledge(this,backup.data);
    const strategies=mergedStrategy(this,{...backup.data,knowledge});
    backup.data.aiRuns=mergeKnowledgeRuns(this,backup.data,knowledge);
    backup.data.aiRuns=mergeWritingRuns(this,{...backup.data,knowledge,strategies});
    backup.data.aiRuns=mergeReplyRuns(this,{...backup.data,evidenceEvents:evidence,interpretations});
    backup.data.events=mergeConversations(this,{...backup.data,evidenceEvents:evidence,interpretations});
    const threadContexts=mergeThreadContexts(this,backup.data);
    const replyData=mergeReplyWriting(this,{...backup.data,threadContexts,knowledge,strategies,evidenceEvents:evidence,interpretations});
    backup.data.aiRuns=replyData.aiRuns;backup.data.events=replyData.events;
    backup.data.events=mergeMeetings(this,{...backup.data,evidenceEvents:evidence});
    backup.data.events=mergeSignals(this,{...backup.data,evidenceEvents:evidence});
    backup.data.events=mergeTracking(this,{...backup.data,evidenceEvents:evidence});
    backup.data.events=mergeRelay(this,{...backup.data,evidenceEvents:evidence});
    validateTracking({...backup.data,evidenceEvents:evidence},33);
    const publicState=mergePublicState(this,backup.data.publicState||{version:1,records:[]},restoredClients);
    const recovery = this.saveBackup('before-restore');
    this.transaction(() => {
      const previousVersions = new Map((this.db.prepare('SELECT id,version FROM clients').all()).map(c => [String(c.id), Number(c.version)]));
      const previousCampaignRevisions=new Map(this.db.prepare('SELECT id,revision FROM campaigns').all().map(c=>[String(c.id),Number(c.revision)]));
      const previousRevisions = new Map(this.db.prepare('SELECT clientId,revision FROM briefs').all().map(c=>[String(c.clientId),Number(c.revision)]));
      this.db.exec("DELETE FROM meta WHERE key LIKE 'tracking-policy:%' OR key LIKE 'relay-policy:%' OR key LIKE 'delivery-progress:%' OR key LIKE 'delivery-auto:%' OR key LIKE 'conversation-progress:%'");
      suspendEvidenceTriggers(this);
      this.db.exec('DELETE FROM experiment_versions; DELETE FROM strategy_versions; DELETE FROM knowledge_versions; DELETE FROM interpretations; DELETE FROM evidence_events');
      clearCatalog(this);
      this.db.exec('DELETE FROM thread_contexts; DELETE FROM queue_items; DELETE FROM queue_runs; DELETE FROM mail_sync; DELETE FROM incoming; DELETE FROM campaign_history; DELETE FROM campaigns; DELETE FROM mail_tests; DELETE FROM leads; DELETE FROM brief_history; DELETE FROM ai_runs; DELETE FROM briefs; DELETE FROM events; DELETE FROM jobs; DELETE FROM clients;');
      for (const c of backup.data.clients) this.db.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?)').run(c.id,c.name,c.website,c.email,c.notes,'paused',Math.max(c.version, previousVersions.get(c.id) || 0) + 1,c.createdAt,now());
      for (const j of backup.data.jobs) this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(j.id,j.clientId,j.kind,['queued','running'].includes(j.status) ? 'held' : j.status,j.dueAt,j.createdAt,j.completedAt,j.attempts,j.result);
      for (const e of backup.data.events) this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(e.id,e.clientId,e.jobId,e.type,e.text,e.createdAt);
      for (const b of backup.data.briefs||[]) this.db.prepare('INSERT INTO briefs VALUES (?,?,?,?,?,?)').run(b.clientId,Math.max(b.revision,previousRevisions.get(b.clientId)||0)+1,b.content,null,null,now());
      for (const r of backup.data.aiRuns||[]) this.db.prepare('INSERT INTO ai_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.clientId,r.purpose,r.provider,r.model,r.revision,r.clientVersion,r.status==='running'?'unknown':r.status,r.context,r.result,r.usage,r.createdAt,r.review);
      for(const c of backup.data.campaigns||[])this.db.prepare('INSERT INTO campaigns VALUES (?,?,?,?,?,?,?,?)').run(c.id,c.clientId,Math.max(c.revision,previousCampaignRevisions.get(c.id)||0)+1,c.content,null,null,c.createdAt,now());
      for(const h of backup.data.campaignHistory||[])this.db.prepare('INSERT INTO campaign_history VALUES (?,?,?,?,?,?,?,?)').run(h.id,h.campaignId,h.clientId,h.revision,h.action,h.content,h.fingerprint,h.createdAt);
      for (const m of backup.data.mailTests||[])this.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(m.id,m.clientId,m.mailboxId,m.sender,m.recipient,m.subject,m.body,m.messageId,m.status==='sending'?'unknown':m.status,m.providerId,m.status==='sending'?'Aus Sicherung: Versandergebnis prüfen.':m.result,m.createdAt,m.updatedAt);
      for (const lead of backup.data.leads||[]) this.db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(lead.id,lead.clientId,lead.email,lead.firstName,lead.lastName,lead.company,lead.role,lead.source,lead.createdAt,lead.blocked,lead.blockReason);
      for(const r of backup.data.queueRuns||[])this.db.prepare('INSERT INTO queue_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.clientId,r.campaignId,r.fingerprint,r.snapshot,['active','prepared','paused'].includes(r.status)?'paused':r.status,r.revision+1,r.createdAt,now(),'Aus Sicherung wiederhergestellt. Ausführung bleibt aus.','rehearsal');
      for(const q of backup.data.queueItems||[])this.db.prepare('INSERT INTO queue_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(q.id,q.runId,q.leadId,q.recipient,q.step,q.subject,q.body,q.status==='sending'?'unknown':q.status,q.eligibleDate,q.simulatedAt,q.localDay,q.status==='sending'?'Aus Sicherung: Versandergebnis prüfen.':q.reason);
      for(const r of backup.data.incoming||[])this.db.prepare('INSERT INTO incoming VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.clientId,r.mailId,r.mailboxId,r.providerId,r.threadId,r.sender,r.subject,r.excerpt,r.receivedAt,r.kind,r.disposition,r.evidence,r.createdAt,r.recipient);
      restoreThreadContexts(this,threadContexts);
      for(const r of backup.data.mailSync||[])this.db.prepare('INSERT INTO mail_sync VALUES (?,?,?,?,?,?,?,?,?,?)').run(r.clientId,r.mailboxId,0,'idle',r.lastStartedAt,r.lastSuccessAt,null,'Nach Wiederherstellung deaktiviert. Postfach erneut verbinden und bewusst aktivieren.',0,now());
      
      for (const h of backup.data.briefHistory||[]) this.db.prepare('INSERT INTO brief_history VALUES (?,?,?,?,?,?,?)').run(h.id,h.clientId,h.revision,h.content,h.action,h.clientVersion,h.createdAt);
      restorePublicState(this,publicState);
      restoreCatalog(this,backup.data);
      restoreEvidenceJournal(this,evidence);
      restoreInterpretations(this,interpretations);
      restoreKnowledge(this,knowledge);
      restoreStrategy(this,strategies);
      restoreExperiments(this,backup.data.experiments||[]);
      this.event(null, null, 'BACKUP_RESTORED', 'Sicherung wiederhergestellt. Alle Kunden pausiert; offene Aufträge zur Prüfung angehalten.');
    });
    return { clients: backup.data.clients.length, recoveryFile: recovery.filename };
  }
  private saveMigrationBackup(version:number) {
    this.transaction(()=>{
    const data:BackupData={clients:this.db.prepare('SELECT * FROM clients ORDER BY id').all() as any,jobs:this.db.prepare('SELECT * FROM jobs ORDER BY id').all() as any,events:this.db.prepare('SELECT * FROM events ORDER BY id').all() as any};
    if(version>=2){data.briefs=this.db.prepare('SELECT * FROM briefs ORDER BY clientId').all() as any;data.aiRuns=this.db.prepare('SELECT * FROM ai_runs ORDER BY id').all() as any;data.briefHistory=this.db.prepare('SELECT * FROM brief_history ORDER BY id').all() as any;}
    if(version>=3)data.leads=this.db.prepare('SELECT * FROM leads ORDER BY id').all() as any;
    if(version>=4)data.mailTests=this.db.prepare('SELECT * FROM mail_tests ORDER BY id').all() as any;
    if(version>=5){data.campaigns=this.db.prepare('SELECT * FROM campaigns ORDER BY id').all() as any;data.campaignHistory=this.db.prepare('SELECT * FROM campaign_history ORDER BY id').all() as any;}
    if(version>=7)data.mailSync=this.db.prepare('SELECT * FROM mail_sync ORDER BY clientId').all() as any;
    if(version>=6)data.incoming=this.db.prepare('SELECT * FROM incoming ORDER BY id').all() as any;
    if(version>=8){data.queueRuns=this.db.prepare('SELECT * FROM queue_runs ORDER BY id').all() as any;data.queueItems=this.db.prepare('SELECT * FROM queue_items ORDER BY id').all() as any;}
    if(version>=9)Object.assign(data,exportCatalog(this));
    if(version>=11)data.evidenceEvents=exportEvidenceJournal(this);
    if(version>=12)data.interpretations=exportInterpretations(this);
    if(version>=13)data.knowledge=exportKnowledge(this);
    if(version>=15)data.strategies=exportStrategy(this);
    if(version>=17)data.experiments=exportExperiments(this);
    if(version>=23)data.threadContexts=exportThreadContexts(this);
    const backup={format:'eiz-revenue-backup',version,createdAt:now(),checksum:checksum(data),data};
    const path=join(this.backupDirectory,`workbench-before-upgrade-${Date.now()}-${randomUUID()}.${this.backupKey?'eizbackup':'json'}`);
    writeFileSync(path,this.backupKey?encryptLocalBackup(Buffer.from(JSON.stringify(backup)),this.backupKey):JSON.stringify(backup),{flush:true});
    });
  }
  leads(clientId:string,offset=0) {
    this.client(clientId);if(!Number.isSafeInteger(offset)||offset<0)throw new AppError('Ungültige Seite.');
    return {total:Number(this.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE clientId=?').get(clientId)?.n),blocked:Number(this.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE clientId=? AND blocked=1').get(clientId)?.n),rows:this.db.prepare('SELECT * FROM leads WHERE clientId=? ORDER BY createdAt,id LIMIT 50 OFFSET ?').all(clientId,offset) as unknown as Lead[]};
  }
  previewLeads(clientId:string,input:ImportInput) {
    this.client(clientId);let parsed:ReturnType<typeof candidates>;
    try{parsed=candidates(input);}catch(e){throw new AppError(e instanceof Error?e.message:'Ungültige CSV.');}
    const existing=this.db.prepare('SELECT email,blocked FROM leads WHERE clientId=? ORDER BY email').all(clientId);
    const known=new Map(existing.map(l=>[String(l.email),Number(l.blocked)])),seen=new Set<string>();
    const rows=parsed.rows.map(r=>{let status='new';if(r.problem)status='invalid';else if(known.get(r.email)===1||isDeletedAddress(this,r.email))status='blocked';else if(known.has(r.email)||seen.has(r.email))status='duplicate';if(!r.problem)seen.add(r.email);return {...r,status};});
    const fingerprint=createHash('sha256').update(JSON.stringify({clientId,csv:input.csv,delimiter:input.delimiter,mapping:input.mapping,filename:input.filename,existing})).digest('hex');
    return {headers:parsed.headers,total:rows.length,valid:rows.filter(r=>r.status==='new').length,invalid:rows.filter(r=>r.status==='invalid').length,duplicates:rows.filter(r=>r.status==='duplicate').length,blocked:rows.filter(r=>r.status==='blocked').length,rows,fingerprint} satisfies Preview;
  }
  importLeads(clientId:string,input:ImportInput) {
    return this.transaction(()=>{if(this.client(clientId).status==='paused')throw new AppError('Kunde ist pausiert.');const preview=this.previewLeads(clientId,input);if(input.fingerprint!==preview.fingerprint)throw new AppError('Importvorschau ist nicht mehr aktuell. Bitte erneut prüfen.',409);if(!preview.valid)throw new AppError('Keine neuen gültigen Kontakte.');const at=now();const stmt=this.db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?)');for(const l of preview.rows.filter(r=>r.status==='new'))stmt.run(randomUUID(),clientId,l.email,l.firstName,l.lastName,l.company,l.role,input.filename,at,0,'');this.event(clientId,null,'LEADS_IMPORTED',`${preview.valid} Kontakte importiert; ${preview.duplicates} Duplikate, ${preview.invalid} ungültige und ${preview.blocked} gesperrte Zeilen ausgelassen. Kein Versand gestartet.`);return {imported:preview.valid,skipped:preview.total-preview.valid};});
  }
  blockLead(clientId:string,id:string,blocked:boolean,reason:string) {
    if(typeof blocked!=='boolean')throw new AppError('Ungültiger Sperrstatus.');reason=string(reason,1000,'Sperrgrund');if(blocked&&!reason)throw new AppError('Bitte einen Sperrgrund angeben.');
    return this.transaction(()=>{this.client(clientId);const l=this.db.prepare('SELECT * FROM leads WHERE clientId=? AND id=?').get(clientId,id) as unknown as Lead;if(!l)throw new AppError('Kontakt nicht gefunden.',404);this.db.prepare('UPDATE leads SET blocked=?,blockReason=? WHERE clientId=? AND id=?').run(blocked?1:0,blocked?reason:'',clientId,id);this.event(clientId,null,'LEAD_BLOCK_CHANGED',blocked?`Kontakt ${l.email} für diesen Kunden gesperrt: ${reason}`:`Kontaktsperre für ${l.email} durch Betreiber aufgehoben.`);return {ok:true};});
  }
  mailTests(clientId:string){this.client(clientId);return this.db.prepare('SELECT * FROM mail_tests WHERE clientId=? ORDER BY createdAt DESC,id DESC LIMIT 30').all(clientId) as unknown as MailTest[];}
  reserveMailTest(clientId:string,input:unknown){
    let d:MailTestInput;try{d=validateMailInput(input);}catch(e){throw new AppError((e as Error).message);}
    return this.transaction(()=>{const c=this.client(clientId);if(c.status==='paused')throw new AppError('Dieser Kunde ist pausiert.');if(c.version!==d.clientVersion)throw new AppError('Kunde wurde geändert. Testvorschau erneut prüfen.',409);if(this.db.prepare('SELECT id FROM mail_tests WHERE id=?').get(d.id))throw new AppError('Dieser Testauftrag wurde bereits verwendet. Verlauf und Gmail prüfen; kein erneuter Versand.',409);if(isDeletedAddress(this,d.recipient))throw new AppError('Empfänger wurde gelöscht und bleibt gesperrt.');if(companyStop(this,clientId,d.recipient))throw new AppError('Unternehmensdomain ist für diesen Kunden gesperrt.');if(this.db.prepare('SELECT id FROM incoming WHERE clientId=? AND recipient=? LIMIT 1').get(clientId,d.recipient))throw new AppError('Kontakt wegen Eingang im Gespraech angehalten.');if(this.db.prepare('SELECT id FROM leads WHERE clientId=? AND email=? AND blocked=1').get(clientId,d.recipient))throw new AppError('Dieser Empfänger ist für den Kunden gesperrt.');const key=`mail-tests:${clientId}:${now().slice(0,10)}`;const count=Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value||0);if(count>=10)throw new AppError('Tageslimit von 10 Testnachrichten erreicht (UTC).');this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,String(count+1));const at=now();const m:MailTest={id:d.id,clientId,mailboxId:d.mailboxId,sender:d.sender,recipient:d.recipient,subject:d.subject,body:d.body,messageId:`<${d.id}@workbench.local>`,status:'sending',providerId:'',result:'Testversand gestartet. Ergebnis noch offen.',createdAt:at,updatedAt:at};this.db.prepare('INSERT INTO mail_tests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(m.id,m.clientId,m.mailboxId,m.sender,m.recipient,m.subject,m.body,m.messageId,m.status,m.providerId,m.result,m.createdAt,m.updatedAt);this.event(clientId,null,'MAIL_TEST_STARTED',`Einzelner Testversand von ${m.sender} an ${m.recipient} bestätigt.`);const presentation=freezeMailPresentation(this,m);if(this.publicMode&&(input as any).presentationHash!==presentation?.hash)throw new AppError('Mailvorschau wurde geändert.',409);return {...m,...(presentation?{presentation}:{})};});
  }
  finishMailTest(clientId:string,id:string,status:string,providerId:string,result:string){
    if(dialogueRecord(this,clientId,id))throw new AppError('Gesprächsantwort über eigenen Versandweg abschließen.',409);
    if(this.db.prepare('SELECT id FROM queue_items WHERE id=?').get(id))throw new AppError('Kampagnenversand muss über die Warteschlange abgeschlossen werden.',409);
    if(!['sent','failed','unknown'].includes(status))throw new AppError('Ungültiges Versandergebnis.');providerId=string(providerId,255,'Google-Kennung');result=string(result,2000,'Ergebnis');if(status==='sent'&&!providerId)throw new AppError('Google-Kennung fehlt.');return this.transaction(()=>{const changed=this.db.prepare("UPDATE mail_tests SET status=?,providerId=?,result=?,updatedAt=? WHERE clientId=? AND id=? AND status='sending'").run(status,providerId,result,now(),clientId,id);if(!changed.changes)throw new AppError('Testauftrag ist nicht mehr aktiv.',409);this.event(clientId,null,'MAIL_TEST_FINISHED',status==='sent'?'Google hat die Testnachricht angenommen. Zustellung ist damit nicht bestätigt.':result);return this.mailTests(clientId);});
  }
  campaignHistory(clientId:string,id:string){this.campaign(clientId,id);const rows=this.db.prepare('SELECT * FROM campaign_history WHERE clientId=? AND campaignId=? ORDER BY createdAt DESC,rowid DESC LIMIT 20').all(clientId,id) as unknown as CampaignHistory[];return rows.map(row=>({...row,messaging:campaignMessaging(clientId,JSON.parse(row.content)),product:campaignProduct(this,clientId,JSON.parse(row.content).productRef),knowledge:campaignKnowledge(this,clientId,JSON.parse(row.content)),hypothesis:campaignStrategy(this,clientId,JSON.parse(row.content)),experiment:campaignExperiment(this,clientId,JSON.parse(row.content))}));}
  campaignLeads(clientId:string){this.client(clientId);return this.db.prepare('SELECT * FROM leads WHERE clientId=? ORDER BY createdAt,id LIMIT 10001').all(clientId) as unknown as Lead[];}
  campaign(clientId:string,id:string){this.client(clientId);const c=this.db.prepare('SELECT * FROM campaigns WHERE clientId=? AND id=?').get(clientId,id) as unknown as CampaignRow;if(!c)throw new AppError('Kampagne nicht gefunden.',404);return c;}
  campaigns(clientId:string){this.client(clientId);return (this.db.prepare('SELECT * FROM campaigns WHERE clientId=? ORDER BY updatedAt DESC,id').all(clientId) as unknown as CampaignRow[]).map(c=>({...c,content:JSON.parse(c.content),approved:this.campaignPreview(clientId,c.id).approved}));}
  saveCampaign(clientId:string,input:any,hooks?:{before:()=>void;after:(row:CampaignRow)=>void}){let content;try{content=validateCampaign(input?.content);}catch(e){throw new AppError((e as Error).message);}return this.transaction(()=>{hooks?.before();this.client(clientId);const existing=input.id?this.campaign(clientId,input.id):null;checkProductAssignment(this,clientId,content.productRef,existing?JSON.parse(existing.content).productRef:undefined);checkCampaignKnowledge(this,clientId,content);checkCampaignStrategy(this,clientId,content);checkCampaignExperiment(this,clientId,content,existing?.id);if(existing&&existing.revision!==input.revision)throw new AppError('Kampagne wurde geändert. Bitte neu laden.',409);for(const id of content.leadIds)if(!this.db.prepare('SELECT id FROM leads WHERE clientId=? AND id=?').get(clientId,id))throw new AppError('Ein Kontakt gehört nicht zu diesem Kunden.');const id=existing?.id||randomUUID(),at=now();this.db.prepare('INSERT INTO campaigns VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content=excluded.content,approvedHash=NULL,approvedAt=NULL,updatedAt=excluded.updatedAt').run(id,clientId,(existing?.revision||0)+1,JSON.stringify(content),null,null,existing?.createdAt||at,at);this.db.prepare('INSERT INTO campaign_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,clientId,(existing?.revision||0)+1,'saved',JSON.stringify(content),'',at);this.event(clientId,null,'CAMPAIGN_SAVED','Kampagnenentwurf gespeichert. Kein Versand aktiviert.');const saved=this.campaign(clientId,id);hooks?.after(saved);return saved;});}
  campaignPreview(clientId:string,id:string){
    const c=this.campaign(clientId,id),d=validateCampaign(JSON.parse(c.content)),client=this.client(clientId),brief=this.briefState(clientId),problems:string[]=[];
    let product:ReturnType<typeof campaignProduct>=null;try{product=campaignProduct(this,clientId,d.productRef);}catch(e){problems.push((e as Error).message);}
    let knowledge:ReturnType<typeof campaignKnowledge>=[];let knowledgeError='';try{knowledge=campaignKnowledge(this,clientId,d);for(const row of knowledge)if(!row.usable)problems.push('Produktwissen: '+row.inactiveReason);}catch(e){knowledgeError=(e as Error).message;problems.push(knowledgeError);}
    let hypothesis:ReturnType<typeof campaignStrategy>=null;let hypothesisError='';try{hypothesis=campaignStrategy(this,clientId,d);if(hypothesis&&!hypothesis.usable)problems.push('Hypothese: '+hypothesis.inactiveReason);}catch(e){hypothesisError=(e as Error).message;problems.push(hypothesisError);}
    let experiment:ReturnType<typeof campaignExperiment>=null;let experimentError='';try{experiment=campaignExperiment(this,clientId,d);if(experiment)problems.push(...experiment.problems);}catch(e){experimentError=(e as Error).message;problems.push(experimentError);}
    const experimentReservations=experimentReservationProblems(this,clientId,d);problems.push(...experimentReservations);
    const leads=d.leadIds.map(id=>this.db.prepare('SELECT * FROM leads WHERE clientId=? AND id=?').get(clientId,id) as unknown as Lead|undefined);
    if(!leads.length)problems.push('Mindestens einen Kontakt auswählen.');if(client.status==='paused')problems.push('Kunde ist pausiert.');if(!brief.approved)problems.push('Betriebsrahmen zuerst freigeben.');if(d.dailyLimit>brief.content.rules.dailyLimit)problems.push('Tageslimit überschreitet den Betriebsrahmen.');if(d.steps.length>brief.content.rules.maxTouches)problems.push('Zu viele Nachrichten für den Betriebsrahmen.');if(d.steps.slice(1).some(s=>s.gapDays<brief.content.rules.minGapDays))problems.push('Follow-up-Abstand unterschreitet den Betriebsrahmen.');
    const groups=new Map<string,number>();for(const l of leads)if(l){const company=l.company.trim().toLowerCase()||l.email.split('@')[1];groups.set(company,(groups.get(company)||0)+1);}if([...groups.values()].some(n=>n>brief.content.rules.companyCap))problems.push('Kontakte je Unternehmen überschreiten den Betriebsrahmen (Firma, ersatzweise E-Mail-Domain).');
    const messages:{email:string;step:number;subject:string;body:string}[]=[];for(const l of leads){if(!l){problems.push('Ausgewählter Kontakt fehlt.');continue;}if(this.db.prepare('SELECT id FROM incoming WHERE clientId=? AND recipient=? LIMIT 1').get(clientId,l.email)){problems.push(`${l.email}: Kontakt wegen Eingang im Gespraech angehalten.`);continue;}if(companyStop(this,clientId,l.email)){problems.push(`${l.email}: Unternehmensdomain gesperrt.`);continue;}if(l.blocked){problems.push(`${l.email} ist gesperrt.`);continue;}for(const [i,s]of d.steps.entries()){try{const subject=personalize(s.subject,l),body=personalize(s.body,l);if(subject.length>120||/[\r\n\0]/.test(subject)||body.length>4000)throw new Error(`Nachricht für ${l.email} überschreitet das Formatlimit.`);if(messages.length<30)messages.push({email:l.email,step:i+1,subject,body});}catch(e){problems.push((e as Error).message);}}}
    if(this.publicMode)for(const l of leads)if(l)problems.push(...contactPermissionProblems(this,clientId,String(l.id)));
    let senderHash:string|null=null;try{senderHash=senderFingerprint(this,clientId);}catch(e){problems.push((e as Error).message);}for(const msg of messages){try{const p=mailPresentation(this,clientId,{to:msg.email,subject:msg.subject,bodyText:msg.body});if(p)(msg as any).presentation=p;}catch(e){problems.push((e as Error).message);}}
    const fingerprint=createHash('sha256').update(JSON.stringify({...(senderHash?{senderHash}:{}),...(this.publicMode?{permissions:publicRecords(this,'permission').filter(r=>r.clientId===clientId)}:{}),c:{id:c.id,revision:c.revision,content:c.content},clientVersion:client.version,briefRevision:brief.revision,briefApproved:brief.approved,leads,...(d.knowledgeIds?{knowledge:knowledge.map(r=>({id:r.id,usable:r.usable,inactiveReason:r.inactiveReason})),knowledgeError}:{}),...(d.hypothesisId?{hypothesis:hypothesis?{id:hypothesis.id,usable:hypothesis.usable,inactiveReason:hypothesis.inactiveReason}:null,hypothesisError}:{}),...(d.experimentId?{experiment,experimentError}:{}),...(experimentReservations.length?{experimentReservations}:{})})).digest('hex');return {fingerprint,product,knowledge,hypothesis,experiment,messaging:campaignMessaging(clientId,d),problems:[...new Set(problems)].slice(0,100),problemCount:problems.length,contacts:leads.length,messageCount:leads.length*d.steps.length,messages,approved:c.approvedHash===fingerprint&&problems.length===0};
  }
  approveCampaign(clientId:string,id:string,input:any){return this.transaction(()=>{const p=this.campaignPreview(clientId,id);if(input?.confirmed!==true||input.fingerprint!==p.fingerprint)throw new AppError('Vorschau geändert oder nicht bestätigt. Bitte erneut prüfen.',409);if(p.problemCount)throw new AppError('Kampagne hat offene Prüfhinweise.');this.db.prepare('UPDATE campaigns SET approvedHash=?,approvedAt=? WHERE clientId=? AND id=?').run(p.fingerprint,now(),clientId,id);const c=this.campaign(clientId,id);this.db.prepare('INSERT INTO campaign_history VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,clientId,c.revision,'approved',c.content,p.fingerprint,now());this.event(clientId,null,'CAMPAIGN_PLAN_APPROVED','Kampagnenplan geprüft. Automatischer Versand bleibt deaktiviert.');return this.campaignPreview(clientId,id);});}
  mailForReconciliation(clientId:string,id:string) {
    this.client(clientId);
    const row=this.db.prepare('SELECT * FROM mail_tests WHERE clientId=? AND id=?').get(clientId,id) as unknown as MailTest|undefined;
    if(!row)throw new AppError('Testnachricht nicht gefunden.',404);
    if(row.status!=='unknown')throw new AppError('Nur unklare Testsendungen können abgeglichen werden.',409);
    const d=dialogueRecord(this,clientId,id);return {...row,...(d?{threadId:JSON.parse(d.text).threadId}:{})};
  }
  reconcileMail(clientId:string,id:string,input:any) {
    return this.transaction(()=>{
      const mail=this.mailForReconciliation(clientId,id);
      if(!input||input.mailboxId!==mail.mailboxId||input.messageId!==mail.messageId||input.clientVersion!==this.client(clientId).version)throw new AppError('Postfach oder Kundenstand geändert. Bitte erneut prüfen.',409);
      const reasons:Record<string,string>={found:'In Gmail unter Gesendet anhand Kennung, Absender und Empfänger bestätigt. Zustellung nicht bestätigt.',not_found:'Kein Gmail-Treffer. Versand bleibt unklar; keine automatische Wiederholung.',ambiguous:'Mehrere Gmail-Treffer. Versand bleibt unklar; manuell prüfen.',mismatch:'Gmail-Treffer stimmt nicht eindeutig überein. Versand bleibt unklar.'};
      if(!Object.hasOwn(reasons,input.outcome)||typeof input.providerId!=='string'||(input.outcome==='found'?!/^[a-zA-Z0-9_-]{1,200}$/.test(input.providerId):input.providerId!==''))throw new AppError('Ungültiger Abgleich.');
      const status=input.outcome==='found'?'sent':'unknown',at=now();
      this.db.prepare('UPDATE mail_tests SET status=?,providerId=?,result=?,updatedAt=? WHERE clientId=? AND id=?').run(status,input.providerId,reasons[input.outcome],at,clientId,id);
      if(status==='sent')reconcileOutbound(this,clientId,id,reasons[input.outcome]);
      this.event(clientId,null,'MAIL_RECONCILED',JSON.stringify({mailId:id,messageId:mail.messageId,mailboxId:mail.mailboxId,outcome:input.outcome,providerId:input.providerId,checkedAt:at}));
      return {status,result:reasons[input.outcome]};
    });
  }
  close() { this.db.close(); }

  brief(clientId: string): BriefRecord {
    this.client(clientId);
    const row=this.db.prepare('SELECT * FROM briefs WHERE clientId=?').get(clientId) as any;
    return row ? {...row,content:JSON.parse(row.content)} : {clientId,revision:0,content:emptyBrief(),approvedAt:null,approvedClientVersion:null,updatedAt:now()};
  }
  briefState(clientId:string) {
    const b=this.brief(clientId), c=this.client(clientId);
    return {...b,approved:!!b.approvedAt&&b.approvedClientVersion===c.version,clientVersion:c.version,missing:approvalProblems(b.content,this.publicMode),history:this.db.prepare('SELECT * FROM brief_history WHERE clientId=? ORDER BY createdAt DESC,rowid DESC LIMIT 20').all(clientId),runs:this.db.prepare("SELECT id,clientId,purpose,provider,model,revision,clientVersion,status,result,usage,createdAt,review FROM ai_runs WHERE clientId=? AND purpose IN ('analysis','writing') ORDER BY createdAt DESC,rowid DESC LIMIT 30").all(clientId)};
  }
  private revise(b:BriefRecord, expected:number, message:string) {
    if(b.revision!==expected)throw new AppError('Kundenwissen wurde inzwischen geändert. Bitte neu laden.',409);
    this.db.prepare('INSERT INTO briefs VALUES (?,?,?,?,?,?) ON CONFLICT(clientId) DO UPDATE SET revision=excluded.revision,content=excluded.content,approvedAt=NULL,approvedClientVersion=NULL,updatedAt=excluded.updatedAt').run(b.clientId,b.revision+1,JSON.stringify(b.content),null,null,now());
    this.db.prepare('INSERT INTO brief_history VALUES (?,?,?,?,?,?,?)').run(randomUUID(),b.clientId,b.revision+1,JSON.stringify(b.content),'edited',this.client(b.clientId).version,now());
    this.event(b.clientId,null,'BRIEF_CHANGED',message+' Vorherige Freigabe aufgehoben.');
    return this.briefState(b.clientId);
  }
  saveRules(clientId:string,input:any) {
    return this.transaction(()=>{const b=this.brief(clientId);b.content.rules=validateRules(input?.rules);b.content.routes={analysis:validateRoute(input?.routes?.analysis),writing:validateRoute(input?.routes?.writing)};return this.revise(b,input.revision,'Betriebsrahmen gespeichert.');});
  }
  addSource(clientId:string,source:Omit<Source,'id'|'hash'|'reviewed'|'capturedAt'>,revision:number) {
    if(!source||typeof source.text!=='string'||!source.text.trim()||source.text.length>12000||typeof source.title!=='string'||!source.title.trim())throw new AppError('Bitte Titel und Inhalt der Quelle angeben (maximal 12.000 Zeichen).');
    return this.transaction(()=>{const b=this.brief(clientId);const s={...source,id:randomUUID(),capturedAt:now(),reviewed:false,hash:createHash('sha256').update(source.text).digest('hex')}; b.content.sources.push(s);validateBrief(b.content);return this.revise(b,revision,'Neue ungeprüfte Quelle abgelegt.');});
  }
  reviewSource(clientId:string,id:string,revision:number,reviewed:boolean) {
    if(typeof reviewed!=='boolean')throw new AppError('Prüfstatus fehlt.');
    return this.transaction(()=>{const b=this.brief(clientId),s=b.content.sources.find(s=>s.id===id);if(!s)throw new AppError('Quelle nicht gefunden.',404);s.reviewed=reviewed;return this.revise(b,revision,reviewed?'Quelle durch Betreiber geprüft.':'Quellenprüfung zurückgenommen.');});
  }
  removeSource(clientId:string,id:string,revision:number) {
    return this.transaction(()=>{const b=this.brief(clientId);if(!b.content.sources.some(s=>s.id===id))throw new AppError('Quelle nicht gefunden.',404);b.content.sources=b.content.sources.filter(s=>s.id!==id);return this.revise(b,revision,'Quelle aus aktuellem Kundenwissen entfernt.');});
  }
  approveBrief(clientId:string,revision:number,clientVersion:number) {
    return this.transaction(()=>{const b=this.brief(clientId),c=this.client(clientId);if(b.revision!==revision||c.version!==clientVersion)throw new AppError('Stand geändert. Bitte erneut prüfen.',409);if(c.status==='paused')throw new AppError('Pausierten Kunden zuerst fortsetzen.');const missing=approvalProblems(b.content,this.publicMode);if(missing.length)throw new AppError('Für die Freigabe fehlt: '+missing.join(', '));this.db.prepare('UPDATE briefs SET approvedAt=?,approvedClientVersion=? WHERE clientId=?').run(now(),c.version,clientId);this.db.prepare('INSERT INTO brief_history VALUES (?,?,?,?,?,?,?)').run(randomUUID(),clientId,revision,JSON.stringify(b.content),'approved',c.version,now());this.event(clientId,null,'BRIEF_APPROVED',`Betriebsrahmen Revision ${revision} durch Betreiber freigegeben. Noch keine Versandfreigabe.`);return this.briefState(clientId);});
  }
  reserveAI(clientId:string,purpose:'analysis'|'writing',revision:number,expectedBindingHash?:string) {
    if(!['analysis','writing'].includes(purpose))throw new AppError('Unbekannte Modellaufgabe.');
    return this.transaction(()=>{const b=this.brief(clientId),c=this.client(clientId);if(b.revision!==revision)throw new AppError('Kundenwissen wurde geändert. Bitte neu laden.',409);if(c.status==='paused')throw new AppError('Kunde ist pausiert.');const route=taskRoute(this,clientId,purpose,b.content.routes[purpose]);if(!route.model)throw new AppError('Bitte zuerst eine Modellkennung speichern.');if(purpose==='writing'&&(!b.approvedAt||b.approvedClientVersion!==c.version))throw new AppError('Bitte zuerst den aktuellen Betriebsrahmen freigeben.');if(!b.content.sources.length)throw new AppError('Bitte zuerst eine Quelle hinzufügen.');if(this.db.prepare("SELECT id FROM ai_runs WHERE clientId=? AND status='running'").get(clientId))throw new AppError('Für diesen Kunden läuft bereits eine Modellaufgabe.',409);
      const day=new Date().toISOString().slice(0,10),counterKey=`aiUsage:${clientId}:${day}`;
      const count=Math.max(Number(this.db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE clientId=? AND createdAt>=?').get(clientId,day+'T00:00:00.000Z')?.n),Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(counterKey)?.value||0));if(count>=b.content.rules.aiDailyLimit)throw new AppError('Tageslimit für Modellaufrufe erreicht (UTC). Auch fehlgeschlagene Versuche zählen.');
      const context=JSON.stringify({company:{name:c.name,website:c.website},sources:b.content.sources.filter(s=>purpose==='analysis'||s.reviewed),rules:b.content.rules});if(context.length>60000)throw new AppError('Kundenwissen ist für einen Aufruf zu umfangreich (maximal 60.000 Zeichen). Bitte Quellen reduzieren.');const id=randomUUID();
      this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(counterKey,String(count+1));
      this.db.prepare('INSERT INTO ai_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,clientId,purpose,route.provider,route.model,b.revision,c.version,'running',context,'','{}',now(),'unreviewed');this.event(clientId,null,'AI_STARTED',`${purpose==='analysis'?'Analyse':'Textvorschlag'} angefordert: ${route.provider} / ${route.model}.`);return bindModelRun(this,clientId,{id,clientId,purpose,...route,context},expectedBindingHash);
    });
  }
  finishAI(clientId:string,id:string,status:string,result:string,usage:unknown) {
    if(!['completed','failed','unknown'].includes(status)||typeof result!=='string'||result.length>30000)throw new AppError('Ungültiges Modellergebnis.');
    const usageJson=JSON.stringify(usage||{});if(usageJson.length>2000)throw new AppError('Ungültige Nutzungsdaten.');
    return this.transaction(()=>{const run=this.db.prepare('SELECT * FROM ai_runs WHERE id=? AND clientId=?').get(id,clientId) as unknown as AIRun;if(!run||!['analysis','writing'].includes(run.purpose)||run.status!=='running')throw new AppError('Modellauftrag ist nicht mehr aktiv.',409);this.db.prepare('UPDATE ai_runs SET status=?,result=?,usage=? WHERE id=?').run(status,result,usageJson,id);this.event(clientId,null,'AI_FINISHED',status==='completed'?'KI-Vorschlag gespeichert. Keine Regel oder Freigabe geändert.':'Modellaufruf fehlgeschlagen oder Ergebnis unklar. Keine automatische Wiederholung.');return this.briefState(clientId);});
  }
  reviewAI(clientId:string,id:string,review:string) {
    if(!['reviewed','rejected'].includes(review))throw new AppError('Ungültige Auswahl.');return this.transaction(()=>{const run=this.db.prepare("SELECT id FROM ai_runs WHERE id=? AND clientId=? AND status='completed' AND purpose IN ('analysis','writing')").get(id,clientId);if(!run)throw new AppError('Vorschlag nicht gefunden.',404);this.db.prepare('UPDATE ai_runs SET review=? WHERE id=?').run(review,id);this.event(clientId,null,'AI_REVIEWED',review==='reviewed'?'KI-Vorschlag als geprüft markiert. Regeln bleiben unverändert.':'KI-Vorschlag verworfen.');return this.briefState(clientId);});
  }
}

export function validateBackup(input: unknown): Backup {
  const b = input as Backup;
  if (!b || b.format !== 'eiz-revenue-backup' || ![1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34].includes(b.version) || !validDate(b.createdAt) || !b.data || !Array.isArray(b.data.clients) || !Array.isArray(b.data.jobs) || !Array.isArray(b.data.events) || b.checksum !== checksum(b.data)) throw new AppError('Keine gültige, vollständige Revenue-Workbench-Sicherung.');
  if(b.version>=34||b.data.publicState){const state=validatePublicState(b.data.publicState);if(b.version<34&&state.records.length)throw new AppError('Ungültige Sicherungsversion.');const ids=new Set(b.data.clients.map(c=>c.id));for(const r of state.records)if(r.clientId&&!ids.has(r.clientId))throw new AppError('Unbekannter Kunde im öffentlichen Datenstand.');}
  if(b.version>=7&&!Array.isArray(b.data.mailSync))throw new AppError('Synchronisationsstand fehlt.');
  if(b.data.mailSync!==undefined&&(!Array.isArray(b.data.mailSync)||b.data.mailSync.length>b.data.clients.length))throw new AppError('Ungültiger Synchronisationsstand.');
  for(const r of b.data.mailSync||[]){if(!r||!b.data.clients.some(c=>c.id===r.clientId)||typeof r.mailboxId!=='string'||!/^[a-f0-9-]{36}$/.test(r.mailboxId)||![0,1].includes(Number(r.enabled))||!['idle','running','failed'].includes(r.status)||!Number.isInteger(r.consecutiveFailures)||r.consecutiveFailures<0||typeof r.lastError!=='string'||r.lastError.length>1000||!validDate(r.updatedAt)||[r.lastStartedAt,r.lastSuccessAt,r.nextAttemptAt].some(v=>v!==null&&!validDate(v)))throw new AppError('Ungültiger Synchronisationsstand.');}
  if(b.version>=6&&!Array.isArray(b.data.incoming))throw new AppError('Eingangsnachrichten fehlen.');
  if(b.data.incoming!==undefined&&(!Array.isArray(b.data.incoming)||b.data.incoming.length>500000))throw new AppError('Ungueltige Eingangssicherung.');
  for(const r of b.data.incoming||[]){validateIncoming(r);if(!['open','unsubscribe'].includes(r.disposition)||!validDate(r.createdAt)||typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||!b.data.mailTests?.some(m=>m.id===r.mailId&&m.clientId===r.clientId&&m.mailboxId===r.mailboxId&&m.recipient===r.recipient))throw new AppError('Ungueltige Gespraechszuordnung.');}
  if(b.version>=2&&(!Array.isArray(b.data.briefs)||!Array.isArray(b.data.aiRuns)||!Array.isArray(b.data.briefHistory)))throw new AppError('Kundenwissen fehlt in der Sicherung.');
  if(b.version>=5&&!Array.isArray(b.data.campaignHistory))throw new AppError('Kampagnenhistorie fehlt.');
  if(b.data.campaignHistory!==undefined&&(!Array.isArray(b.data.campaignHistory)||b.data.campaignHistory.length>100000))throw new AppError('Ungültige Kampagnenhistorie.');
  for(const h of b.data.campaignHistory||[]){if(!h||typeof h.id!=='string'||!Number.isSafeInteger(h.revision)||h.revision<1||!['saved','approved'].includes(h.action)||!validDate(h.createdAt)||typeof h.fingerprint!=='string'||!b.data.campaigns?.some(c=>c.id===h.campaignId&&c.clientId===h.clientId))throw new AppError('Ungültige Kampagnenhistorie.');try{validateCampaign(JSON.parse(h.content));}catch{throw new AppError('Ungültiger historischer Kampagneninhalt.');}}
  if(b.version>=5&&!Array.isArray(b.data.campaigns))throw new AppError('Kampagnen fehlen.');
  if(b.data.campaigns!==undefined&&(!Array.isArray(b.data.campaigns)||b.data.campaigns.length>10000))throw new AppError('Ungültige Kampagnensicherung.');
  for(const c of b.data.campaigns||[]){if(!c||typeof c.id!=='string'||typeof c.clientId!=='string'||!Number.isSafeInteger(c.revision)||c.revision<1||!validDate(c.createdAt)||!validDate(c.updatedAt))throw new AppError('Ungültige Kampagne.');try{validateCampaign(JSON.parse(c.content));}catch{throw new AppError('Ungültiger Kampagneninhalt.');}}
  if(b.version>=4&&!Array.isArray(b.data.mailTests))throw new AppError('Testversand-Verlauf fehlt.');
  if(b.data.mailTests!==undefined&&(!Array.isArray(b.data.mailTests)||b.data.mailTests.length>100000))throw new AppError('Ungültiger Testversand-Verlauf.');
  for(const m of b.data.mailTests||[]){try{validateMailInput({...m,clientVersion:1});}catch{throw new AppError('Ungültige Testnachricht in Sicherung.');}if(!['sending','sent','failed','unknown'].includes(m.status)||!validDate(m.createdAt)||!validDate(m.updatedAt)||m.messageId!==`<${m.id}@workbench.local>`)throw new AppError('Ungültiger Testauftrag.');string(m.clientId,36,'Kunde');string(m.providerId,255,'Google-Kennung');string(m.result,2000,'Ergebnis');}
  if(b.version>=3&&!Array.isArray(b.data.leads))throw new AppError('Kontakte fehlen in der Sicherung.');
  if(b.data.leads!==undefined&&!Array.isArray(b.data.leads))throw new AppError('Ungültige Kontakte.');
  if((b.data.leads?.length||0)>500000)throw new AppError('Zu viele Kontakte.');
  for(const l of b.data.leads||[]){if(!l||typeof l.email!=='string'||!validEmail(l.email)||l.email!==l.email.toLowerCase()||![0,1].includes(l.blocked)||!validDate(l.createdAt))throw new AppError('Ungültiger Kontakt.');for(const key of ['id','clientId','firstName','lastName','company','role','source','blockReason'] as const)string(l[key],key==='blockReason'?1000:255,'Kontaktfeld');}
  for(const h of b.data.briefHistory||[]){if(!h||typeof h.id!=='string'||typeof h.clientId!=='string'||!Number.isSafeInteger(h.revision)||h.revision<0||!Number.isSafeInteger(h.clientVersion)||h.clientVersion<1||!['edited','approved'].includes(h.action)||!validDate(h.createdAt)||typeof h.content!=='string'||h.content.length>250000)throw new AppError('Ungültige Revisionshistorie.');validateBrief(JSON.parse(h.content));}
  for(const d of b.data.briefs||[]){if(typeof d.clientId!=='string'||!Number.isSafeInteger(d.revision)||d.revision<0||typeof d.content!=='string'||d.content.length>250000)throw new AppError('Ungültiges Kundenwissen.');validateBrief(JSON.parse(d.content));}
  for(const r of b.data.aiRuns||[]){if(!r||!['analysis','writing','knowledge','campaign-writing','reply-analysis','reply-writing'].includes(r.purpose)||!['running','completed','failed','unknown'].includes(r.status)||!['unreviewed','reviewed','rejected'].includes(r.review)||!Number.isSafeInteger(r.revision)||r.revision<0||!Number.isSafeInteger(r.clientVersion)||r.clientVersion<1||!validDate(r.createdAt))throw new AppError('Ungültiger Modellauftrag.');const dispatch=b.version>=34?b.data.publicState?.records.find(x=>x.kind==='dispatch'&&x.id===r.id&&x.clientId===r.clientId)?.content:null;if(dispatch){if(dispatch.binding.provider!==r.provider||dispatch.binding.model!==r.model||dispatch.purpose!==r.purpose)throw new AppError('Modellhistorie widerspricht Auftragsbindung.');}else validateRoute(r);string(r.id,36,'Kennung');string(r.clientId,36,'Kunde');string(r.context,60000,'Modellkontext');string(r.result,30000,'Modellantwort');string(r.usage,2000,'Nutzungsdaten');}
  if (b.data.clients.length > 10000 || b.data.jobs.length > 500000 || b.data.events.length > 1000000) throw new AppError('Sicherung überschreitet die Größenlimits.');
  const checkId = (id: unknown) => { if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new AppError('Ungültige Datensatzkennung.'); };
  for (const c of b.data.clients) { validateClient(c); checkId(c.id); if (!['setup','paused'].includes(c.status) || !Number.isSafeInteger(c.version) || c.version < 1 || !validDate(c.createdAt) || !validDate(c.updatedAt)) throw new AppError('Ungültiger Kundendatensatz.'); }
  for (const j of b.data.jobs) { checkId(j.id); checkId(j.clientId); if (j.kind !== 'diagnostic' || !['queued','running','done','failed','held','cancelled'].includes(j.status) || !validDate(j.dueAt) || !validDate(j.createdAt) || (j.completedAt !== null && !validDate(j.completedAt)) || !Number.isSafeInteger(j.attempts) || j.attempts < 0) throw new AppError('Ungültiger Auftrag.'); string(j.result, 12000, 'Auftragsergebnis'); }
  for (const e of b.data.events) { checkId(e.id); if (e.clientId !== null) checkId(e.clientId); if (e.jobId !== null) checkId(e.jobId); string(e.type, 100, 'Ereignistyp'); string(e.text, b.version>=32&&e.type==='RELAY_PAGE'?512*1024:b.version>=33&&e.type==='TRACKING_PREPARED'?32768:12000, 'Ereignis'); if (!validDate(e.createdAt)) throw new AppError('Ungültiges Ereignisdatum.'); }
  validateGmailReferences(b.data);validateOperations(b.data);validateUnassignedBackup(b.data);if(b.version>=8&&(!Array.isArray(b.data.queueRuns)||!Array.isArray(b.data.queueItems)))throw new AppError('Warteschlangensicherung fehlt.');validateQueueBackup(b.data);
  validateCatalogBackup(b.data,b.version);
  validateCampaignProductBackup(b.data,b.version);
  validateEvidenceBackup(b.data,b.version);
  validateInterpretationBackup(b.data,b.version);
  validateKnowledgeBackup(b.data,b.version);
  validateKnowledgeRuns(b.data);
  validateCampaignKnowledgeBackup(b.data,b.version);
  validateStrategyBackup(b.data,b.version);
  validateCampaignStrategyBackup(b.data,b.version);
  validateExperimentBackup(b.data,b.version);
  validateCampaignExperimentBackup(b.data,b.version);
  validateCampaignMessagingBackup(b.data,b.version);
  validateWritingRuns(b.data,b.version);
  validateReplyRuns(b.data,b.version);
  validateConversations(b.data,b.version);
  validateThreadContexts(b.data,b.version);
  validateReplyWriting(b.data,b.version);
  validateDialogue(b.data,b.version);validateAuto(b.data,b.version);validatePreparation(b.data,b.version);validateApproval(b.data,b.version);validateAnalysisAuto(b.data,b.version);validateMeetings(b.data,b.version);validateSignals(b.data,b.version);validateRelay(b.data,b.version);validateTracking(b.data,b.version);
  return b;
}


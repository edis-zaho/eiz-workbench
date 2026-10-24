import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store,validateBackup} from '../core/store';
import {saveProduct,saveAccount,linkAccount,catalogState,productHistory,CATALOG_TABLES} from '../core/catalog';
import {rehearseRestore} from '../core/recovery';
import {startServer} from '../core/server';

const product={name:'Einkaufsautomatisierung',description:'Version eins',website:'',bookingUrl:'',archived:false};
const drop='DROP TRIGGER evidence_mail_insert; DROP TRIGGER evidence_mail_update; DROP TRIGGER evidence_incoming_insert; DROP TABLE experiment_versions; DROP TABLE strategy_versions; DROP TABLE knowledge_versions; DROP TABLE interpretations; DROP TABLE evidence_events; DROP TABLE lead_account_links; DROP TABLE product_revisions; DROP TABLE account_revisions; DROP TABLE products; DROP TABLE accounts; DROP INDEX lead_id_client; PRAGMA user_version=8;';
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'eiz-catalog-')),filename=join(dir,'test.sqlite'),backups=join(dir,'backups');
 let store=new Store(filename,backups,false);
 const a=store.createClient({name:'A',website:'',email:'',notes:''}).id,b=store.createClient({name:'B',website:'',email:'',notes:''}).id;
 const lead=randomUUID();store.db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(lead,a,'test@example.com','','','Textfeld ist kein Account','','',new Date().toISOString(),0,'');
 return {get store(){return store;},a,b,lead,dir,filename,backups,reopen(){store.close();store=new Store(filename,backups,false);},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const resign=(backup:any)=>{backup.checksum=createHash('sha256').update(JSON.stringify(backup.data)).digest('hex');return backup;};

test('product versions remain distinct across customers and products; stale writes fail',()=>{
 const f=fixture();try{
  const p=saveProduct(f.store,f.a,null,product,0),q=saveProduct(f.store,f.a,null,{...product,name:'Produkt zwei'},0);
  saveProduct(f.store,f.a,p.productId,{...product,description:'Version zwei',archived:true},1);
  assert.throws(()=>saveProduct(f.store,f.a,p.productId,product,1),(e:any)=>e.status===409);
  assert.throws(()=>saveProduct(f.store,f.b,p.productId,product,2),(e:any)=>e.status===404);
  const history=productHistory(f.store,f.a,p.productId);
  assert.deepEqual(history.map(p=>p.description),['Version zwei','Version eins']);
  assert.equal(productHistory(f.store,f.a,q.productId).length,1);
  assert.equal(catalogState(f.store,f.b).products.length,0);
  assert.throws(()=>f.store.db.prepare('UPDATE product_revisions SET name=? WHERE productId=?').run('overwrite',p.productId),/overwritten/);
  f.reopen();assert.equal(productHistory(f.store,f.a,p.productId).length,2);
 }finally{f.close();}
});

test('account assignment is explicit, customer-isolated and revisioned even when removed',()=>{
 const f=fixture();try{
  assert.equal(catalogState(f.store,f.a).accounts.length,0);
  const a=saveAccount(f.store,f.a,null,{name:'Firma',domain:'example.com'},0);
  saveAccount(f.store,f.a,null,{name:'Gleiche Domain',domain:'example.com'},0);
  const foreign=saveAccount(f.store,f.b,null,{name:'Fremd',domain:''},0);
  assert.throws(()=>linkAccount(f.store,f.a,f.lead,foreign.accountId,0),(e:any)=>e.status===404);
  assert.throws(()=>linkAccount(f.store,f.b,f.lead,foreign.accountId,0),(e:any)=>e.status===404);
  linkAccount(f.store,f.a,f.lead,a.accountId,0);
  assert.throws(()=>linkAccount(f.store,f.a,f.lead,null,0),(e:any)=>e.status===409);
  linkAccount(f.store,f.a,f.lead,null,1);
  assert.equal(catalogState(f.store,f.a).links[0].accountId,null);
  assert.equal(f.store.exportBackup().data.leadAccountLinks?.length,2);
  assert.throws(()=>f.store.db.prepare('INSERT INTO lead_account_links VALUES (?,?,?,?,?,?)').run(randomUUID(),f.a,f.lead,foreign.accountId,3,new Date().toISOString()),/FOREIGN KEY/);
 }finally{f.close();}
});

test('schema 8 migration saves complete prior data and creates no inferred products or accounts',()=>{
 const f=fixture();try{
  f.store.db.exec(drop);f.reopen();
  assert.equal(f.store.snapshot().database.schema,34);
  const path=join(f.backups,readdirSync(f.backups).find(p=>p.includes('before-upgrade'))!);
  const previous=validateBackup(JSON.parse(readFileSync(path,'utf8')));
  assert.equal(previous.version,8);assert.ok(Array.isArray(previous.data.queueRuns));assert.ok(Array.isArray(previous.data.queueItems));
  assert.equal(previous.data.leads?.[0].id,f.lead);
  assert.deepEqual(catalogState(f.store,f.a),{products:[],accounts:[],links:[]});
  f.store.restore(previous);assert.equal(f.store.leads(f.a).total,1);
 }finally{f.close();}
});

test('migration failure rolls back schema and leaves a usable pre-migration backup',()=>{
 const f=fixture();f.store.db.exec(drop+' CREATE TABLE accounts(marker TEXT);');f.store.close();
 try{
  assert.throws(()=>new Store(f.filename,f.backups,false),/accounts already exists/);
  const db=new DatabaseSync(f.filename);try{
   assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,8);
   assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='products'").get(),undefined);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get()?.n,1);
  }finally{db.close();}
  const previous=JSON.parse(readFileSync(join(f.backups,readdirSync(f.backups).find(p=>p.includes('before-upgrade'))!),'utf8'));
  assert.equal(validateBackup(previous).version,8);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

test('backup, restore and restart preserve all catalog histories; regressive restores are rejected',()=>{
 const f=fixture();try{
  const old=f.store.exportBackup();const p=saveProduct(f.store,f.a,null,product,0),a=saveAccount(f.store,f.a,null,{name:'Firma',domain:''},0);
  linkAccount(f.store,f.a,f.lead,a.accountId,0);saveAccount(f.store,f.a,a.accountId,{name:'Neuer Name',domain:''},1);
  const backup=f.store.exportBackup();assert.equal(backup.version,34);
  const result=rehearseRestore(backup);assert.equal(result.counts.productRevisions,1);assert.equal(result.counts.accountRevisions,2);assert.equal(result.counts.leadAccountLinks,1);
  assert.throws(()=>f.store.restore(old),/Historie|historie/);
  const corrupt=structuredClone(backup);corrupt.data.productRevisions![0].description='Changed';resign(corrupt);
  assert.throws(()=>f.store.restore(corrupt),/Historie|historie/);
  f.store.restore(backup);f.reopen();
  for(const key of Object.keys(CATALOG_TABLES) as (keyof typeof CATALOG_TABLES)[])assert.deepEqual(f.store.exportBackup().data[key],backup.data[key]);
  assert.equal(productHistory(f.store,f.a,p.productId).length,1);assert.equal(f.store.client(f.a).status,'paused');
 }finally{f.close();}
});

test('malformed and foreign references are rejected even with a recomputed backup checksum',()=>{
 const f=fixture();try{
  saveProduct(f.store,f.a,null,product,0);const original=f.store.exportBackup();
  for(const corrupt of [
   (b:any)=>{b.data.productRevisions[0].clientId=f.b;},
   (b:any)=>{b.data.productRevisions[0].revision=2;},
   (b:any)=>{b.data.productRevisions.push({...b.data.productRevisions[0]});},
   (b:any)=>{b.data.products=[];},
   (b:any)=>{delete b.data.accounts;},
   (b:any)=>{b.data.productRevisions[0].extra='ignored?';},
  ]){const backup=structuredClone(original);corrupt(backup);assert.throws(()=>f.store.restore(resign(backup)));assert.deepEqual(f.store.exportBackup().data,original.data);}
 }finally{f.close();}
});

test('catalog API uses local authorization and rejects cross-customer edits',async()=>{
 const f=fixture(),token='c'.repeat(64),service=await startServer(f.store,token,600000);
 const request=(client:string,body:unknown,auth=true)=>fetch(service.url+`/api/clients/${client}/catalog`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
 try{
  const body={kind:'product',id:null,expectedRevision:0,value:product};
  assert.equal((await request(f.a,body,false)).status,401);
  const result=await request(f.a,body);assert.equal(result.status,200);const saved=await result.json();
  assert.equal((await request(f.b,{...body,id:saved.productId,expectedRevision:1})).status,404);
  assert.equal((await request(f.a,{...body,clientId:f.b})).status,400);
  const state=await(await fetch(service.url+`/api/clients/${f.b}/catalog`,{headers:{Authorization:`Bearer ${token}`}})).json();assert.equal(state.products.length,0);
 }finally{await service.close();rmSync(f.dir,{recursive:true,force:true});}
});

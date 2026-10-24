import { randomUUID } from 'node:crypto';
import { Store, AppError } from './store';
import type { BackupData } from './types';
import { validateProductInput, validateAccountInput, type ProductInput, type AccountInput } from './catalog-input';

export type CatalogIdentity = {id:string;clientId:string;createdAt:string};
export type ProductRevision = ProductInput & {id:string;clientId:string;productId:string;revision:number;createdAt:string};
export type AccountRevision = AccountInput & {id:string;clientId:string;accountId:string;revision:number;createdAt:string};
export type LeadAccountLink = {id:string;clientId:string;leadId:string;accountId:string|null;revision:number;createdAt:string};
// SQLite stores boolean fields as integers; API objects translate at the boundary.
export type StoredProductRevision = Omit<ProductRevision,'archived'> & {archived:number};
export type CatalogBackup = {products:CatalogIdentity[];productRevisions:StoredProductRevision[];accounts:CatalogIdentity[];accountRevisions:AccountRevision[];leadAccountLinks:LeadAccountLink[]};
export const CATALOG_TABLES = {products:'products',productRevisions:'product_revisions',accounts:'accounts',accountRevisions:'account_revisions',leadAccountLinks:'lead_account_links'} as const;
const now=()=>new Date().toISOString();

export function migrateCatalog(store:Store) {
  store.db.exec(`
    CREATE UNIQUE INDEX lead_id_client ON leads(id,clientId);
    CREATE TABLE products(id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),createdAt TEXT NOT NULL,UNIQUE(id,clientId));
    CREATE TABLE product_revisions(id TEXT PRIMARY KEY,clientId TEXT NOT NULL,productId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),name TEXT NOT NULL,description TEXT NOT NULL,website TEXT NOT NULL,bookingUrl TEXT NOT NULL,archived INTEGER NOT NULL CHECK(archived IN (0,1)),createdAt TEXT NOT NULL,UNIQUE(productId,revision),FOREIGN KEY(productId,clientId) REFERENCES products(id,clientId));
    CREATE TABLE accounts(id TEXT PRIMARY KEY,clientId TEXT NOT NULL REFERENCES clients(id),createdAt TEXT NOT NULL,UNIQUE(id,clientId));
    CREATE TABLE account_revisions(id TEXT PRIMARY KEY,clientId TEXT NOT NULL,accountId TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),name TEXT NOT NULL,domain TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(accountId,revision),FOREIGN KEY(accountId,clientId) REFERENCES accounts(id,clientId));
    CREATE TABLE lead_account_links(id TEXT PRIMARY KEY,clientId TEXT NOT NULL,leadId TEXT NOT NULL,accountId TEXT,revision INTEGER NOT NULL CHECK(revision>0),createdAt TEXT NOT NULL,UNIQUE(leadId,revision),FOREIGN KEY(leadId,clientId) REFERENCES leads(id,clientId),FOREIGN KEY(accountId,clientId) REFERENCES accounts(id,clientId));
    CREATE INDEX product_client ON products(clientId);
    CREATE INDEX account_client ON accounts(clientId);
    CREATE INDEX link_client ON lead_account_links(clientId,leadId,revision);
  `);
  for(const table of Object.values(CATALOG_TABLES)) store.db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Catalog history cannot be overwritten'); END;`);
  store.db.exec('PRAGMA user_version=9');
}

export function exportCatalog(store:Store):CatalogBackup {
  return Object.fromEntries(Object.entries(CATALOG_TABLES).map(([key,table])=>[key,store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])) as CatalogBackup;
}

export function clearCatalog(store:Store) {
  store.db.exec('DELETE FROM lead_account_links; DELETE FROM product_revisions; DELETE FROM account_revisions; DELETE FROM products; DELETE FROM accounts;');
}
export function restoreCatalog(store:Store,data:BackupData) {
  for(const [key,table] of Object.entries(CATALOG_TABLES)) {
    for(const row of (data[key as keyof CatalogBackup] || [])) {
      const columns=Object.keys(row); // Validated exact columns, never arbitrary user SQL.
      store.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
    }
  }
}

export function protectCatalogRestore(store:Store,data:BackupData) {
  const current=exportCatalog(store);
  for(const key of Object.keys(CATALOG_TABLES) as (keyof CatalogBackup)[]) {
    const saved=new Map((data[key] || []).map(row=>[row.id,row]));
    for(const row of current[key]) {
      const candidate=saved.get(row.id);
      if(!candidate || Object.entries(row).some(([field,value])=>(candidate as any)[field]!==value)) {
        throw new AppError('Diese Sicherung würde Produkt-, Unternehmens- oder Zuordnungshistorie zurücksetzen. Bitte eine aktuelle Sicherung verwenden.');
      }
    }
  }
}

const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const timestamp=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function bad():never {throw new AppError('Ungültige Produkt-, Unternehmens- oder Zuordnungshistorie in der Sicherung.');}

export function validateCatalogBackup(data:BackupData,version:number) {
  const columns={products:['id','clientId','createdAt'],accounts:['id','clientId','createdAt'],productRevisions:['id','clientId','productId','revision','name','description','website','bookingUrl','archived','createdAt'],accountRevisions:['id','clientId','accountId','revision','name','domain','createdAt'],leadAccountLinks:['id','clientId','leadId','accountId','revision','createdAt']};
  const clients=new Set(data.clients.map(c=>c.id));
  for(const key of Object.keys(CATALOG_TABLES) as (keyof CatalogBackup)[]) {
    const rows=data[key];
    if(rows===undefined&&version<9)continue;
    if(!Array.isArray(rows)||rows.length>100000||(version<9&&rows.length))bad();
    const ids=new Set<string>();
    for(const row of rows) {
      if(!row||typeof row!=='object'||Object.keys(row).length!==columns[key].length||columns[key].some(c=>!Object.hasOwn(row,c))||!uuid(row.id)||ids.has(row.id)||!clients.has(row.clientId)||!timestamp(row.createdAt))bad();
      ids.add(row.id);
    }
  }
  const products=new Map((data.products||[]).map(p=>[p.id,p]));
  const accounts=new Map((data.accounts||[]).map(a=>[a.id,a]));
  const leads=new Map((data.leads||[]).map(l=>[l.id,l]));
  const sequences=new Map<string,number[]>();
  const add=(key:string,revision:number)=>{if(!Number.isSafeInteger(revision)||revision<1)bad();const list=sequences.get(key)||[];list.push(revision);sequences.set(key,list);};
  for(const row of data.productRevisions||[]) {
    if(products.get(row.productId)?.clientId!==row.clientId||![0,1].includes(row.archived))bad();
    try {const clean=validateProductInput({name:row.name,description:row.description,website:row.website,bookingUrl:row.bookingUrl,archived:!!row.archived});for(const [k,v] of Object.entries(clean))if(k!=='archived'&&(row as any)[k]!==v)bad();}catch{bad();}
    add('product:'+row.productId,row.revision);
  }
  for(const row of data.accountRevisions||[]) {
    if(accounts.get(row.accountId)?.clientId!==row.clientId)bad();
    try {const clean=validateAccountInput({name:row.name,domain:row.domain});if(clean.name!==row.name||clean.domain!==row.domain)bad();}catch{bad();}
    add('account:'+row.accountId,row.revision);
  }
  for(const row of data.leadAccountLinks||[]) {
    if(leads.get(row.leadId)?.clientId!==row.clientId||(row.accountId!==null&&accounts.get(row.accountId)?.clientId!==row.clientId))bad();
    add('link:'+row.leadId,row.revision);
  }
  for(const [id] of products)if(!sequences.has('product:'+id))bad();
  for(const [id] of accounts)if(!sequences.has('account:'+id))bad();
  for(const revisions of sequences.values())if(revisions.sort((a,b)=>a-b).some((value,index)=>value!==index+1))bad();
}

function checked<T>(fn:()=>T):T {try{return fn();}catch(e){if(e instanceof AppError)throw e;throw new AppError(e instanceof Error?e.message:'Ungültige Eingabe.');}}
function expected(value:unknown) {if(!Number.isSafeInteger(value)||Number(value)<0)throw new AppError('Ungültiger Bearbeitungsstand.');return Number(value);}
function capacity(store:Store,table:'product_revisions'|'account_revisions'|'lead_account_links') {
  if(Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)>=100000)throw new AppError('Die sichere Größenbegrenzung dieser Historie wurde erreicht. Vor weiteren Änderungen ist eine Erweiterung erforderlich.');
}
function latest(store:Store,table:'product_revisions'|'account_revisions',field:'productId'|'accountId',clientId:string,id:string) {
  const row=store.db.prepare(`SELECT * FROM ${table} WHERE ${field}=? AND clientId=? ORDER BY revision DESC LIMIT 1`).get(id,clientId);
  if(!row)throw new AppError('Datensatz nicht gefunden.',404);return row;
}

export function saveProduct(store:Store,clientId:string,id:string|null,input:unknown,expectedRevision:unknown) {
  store.client(clientId);const data=checked(()=>validateProductInput(input)),revision=expected(expectedRevision);
  return store.transaction(()=>{
    const at=now(),productId=id||randomUUID();
    const previous=id?Number(latest(store,'product_revisions','productId',clientId,id).revision):0;
    if(previous!==revision)throw new AppError('Produkt wurde zwischenzeitlich geändert. Bitte neu laden.',409);
    capacity(store,'product_revisions');
    if(!id)store.db.prepare('INSERT INTO products VALUES (?,?,?)').run(productId,clientId,at);
    store.db.prepare('INSERT INTO product_revisions VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),clientId,productId,revision+1,data.name,data.description,data.website,data.bookingUrl,data.archived?1:0,at);
    return {...data,productId,revision:revision+1};
  });
}

export function saveAccount(store:Store,clientId:string,id:string|null,input:unknown,expectedRevision:unknown) {
  store.client(clientId);const data=checked(()=>validateAccountInput(input)),revision=expected(expectedRevision);
  return store.transaction(()=>{
    const at=now(),accountId=id||randomUUID();
    const previous=id?Number(latest(store,'account_revisions','accountId',clientId,id).revision):0;
    if(previous!==revision)throw new AppError('Unternehmen wurde zwischenzeitlich geändert. Bitte neu laden.',409);
    capacity(store,'account_revisions');
    if(!id)store.db.prepare('INSERT INTO accounts VALUES (?,?,?)').run(accountId,clientId,at);
    store.db.prepare('INSERT INTO account_revisions VALUES (?,?,?,?,?,?,?)').run(randomUUID(),clientId,accountId,revision+1,data.name,data.domain,at);
    return {...data,accountId,revision:revision+1};
  });
}

export function linkAccount(store:Store,clientId:string,leadId:string,accountId:unknown,expectedRevision:unknown) {
  store.client(clientId);const revision=expected(expectedRevision);
  if(accountId!==null&&!uuid(accountId))throw new AppError('Ungültiges Unternehmen.');
  return store.transaction(()=>{
    if(!store.db.prepare('SELECT id FROM leads WHERE id=? AND clientId=?').get(leadId,clientId))throw new AppError('Kontakt nicht gefunden.',404);
    if(accountId!==null)latest(store,'account_revisions','accountId',clientId,accountId as string);
    const previous=store.db.prepare('SELECT revision FROM lead_account_links WHERE leadId=? AND clientId=? ORDER BY revision DESC LIMIT 1').get(leadId,clientId);
    if(Number(previous?.revision||0)!==revision)throw new AppError('Zuordnung wurde zwischenzeitlich geändert. Bitte neu laden.',409);
    capacity(store,'lead_account_links');
    const row={id:randomUUID(),clientId,leadId,accountId:accountId as string|null,revision:revision+1,createdAt:now()};
    store.db.prepare('INSERT INTO lead_account_links VALUES (?,?,?,?,?,?)').run(row.id,clientId,leadId,row.accountId,row.revision,row.createdAt);
    return row;
  });
}

export function catalogState(store:Store,clientId:string) {
  store.client(clientId);
  const products=store.db.prepare('SELECT r.* FROM product_revisions r WHERE clientId=? AND revision=(SELECT MAX(revision) FROM product_revisions WHERE productId=r.productId) ORDER BY name,productId').all(clientId).map(r=>({...r,archived:!!r.archived}));
  const accounts=store.db.prepare('SELECT r.* FROM account_revisions r WHERE clientId=? AND revision=(SELECT MAX(revision) FROM account_revisions WHERE accountId=r.accountId) ORDER BY name,accountId').all(clientId);
  const links=store.db.prepare('SELECT r.* FROM lead_account_links r WHERE clientId=? AND revision=(SELECT MAX(revision) FROM lead_account_links WHERE leadId=r.leadId) ORDER BY leadId').all(clientId);
  return {products,accounts,links};
}
export function productHistory(store:Store,clientId:string,id:string) {
  store.client(clientId);latest(store,'product_revisions','productId',clientId,id);
  const rows=store.db.prepare('SELECT * FROM product_revisions WHERE productId=? AND clientId=? ORDER BY revision DESC').all(id,clientId) as unknown as StoredProductRevision[];
  return rows.map(r=>({...r,archived:!!r.archived}));
}

export function changeCatalog(store:Store,clientId:string,input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('Ungültige Katalogänderung.');
  const data=input as Record<string,unknown>;
  if(Object.keys(data).some(k=>!['kind','id','expectedRevision','value'].includes(k))||(data.id!==null&&!uuid(data.id)))throw new AppError('Ungültige Katalogänderung.');
  if(data.kind==='product')return saveProduct(store,clientId,data.id as string|null,data.value,data.expectedRevision);
  if(data.kind==='account')return saveAccount(store,clientId,data.id as string|null,data.value,data.expectedRevision);
  if(data.kind==='link'&&data.id)return linkAccount(store,clientId,data.id as string,data.value,data.expectedRevision);
  throw new AppError('Unbekannte Katalogänderung.');
}

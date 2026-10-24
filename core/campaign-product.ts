import {Store,AppError} from './store';
import type {BackupData} from './types';
import type {ProductReference,CampaignHistory} from './campaign';
import type {StoredProductRevision} from './catalog';

export function campaignProduct(store:Store,clientId:string,ref?:ProductReference) {
  if(!ref)return null;
  const row=store.db.prepare('SELECT * FROM product_revisions WHERE productId=? AND revision=? AND clientId=?').get(ref.productId,ref.revision,clientId) as unknown as StoredProductRevision|undefined;
  if(!row)throw new AppError('Die zugeordnete Produktversion gehört nicht zu diesem Kunden oder fehlt.');
  return {productId:row.productId,revision:row.revision,name:row.name,description:row.description,website:row.website,bookingUrl:row.bookingUrl,archived:!!row.archived};
}

export function checkProductAssignment(store:Store,clientId:string,next?:ProductReference,previous?:ProductReference) {
  const product=campaignProduct(store,clientId,next);
  if(!product)return;
  const unchanged=previous?.productId===next?.productId&&previous?.revision===next?.revision;
  if(!unchanged){
    const latest=store.db.prepare('SELECT archived FROM product_revisions WHERE productId=? AND clientId=? ORDER BY revision DESC LIMIT 1').get(product.productId,clientId);
    if(product.archived||latest?.archived)throw new AppError('Archivierte Produkte können keiner neuen Kampagnenfassung zugeordnet werden.');
  }
}

export function validateCampaignProductBackup(data:BackupData,version:number) {
  const index=new Map((data.productRevisions||[]).map(row=>[row.productId+':'+row.revision,row]));
  function check(clientId:string,content:string|Record<string,any>) {
    const ref=(typeof content==='string'?JSON.parse(content):content).productRef;
    if(ref===undefined)return;
    // Basic shape is checked by validateCampaign before this relational check.
    if(version<10||index.get(ref.productId+':'+ref.revision)?.clientId!==clientId)throw new AppError('Ungültiger Produktbezug in Kampagne, Historie oder Versandlauf.');
  }
  for(const row of data.campaigns||[])check(row.clientId,row.content);
  for(const row of data.campaignHistory||[])check(row.clientId,row.content);
  const approvals=new Map<string,CampaignHistory[]>();
  for(const row of data.campaignHistory||[])if(row.action==='approved'){
    const key=row.campaignId+':'+row.fingerprint;const rows=approvals.get(key)||[];rows.push(row);approvals.set(key,rows);
  }
  for(const row of data.queueRuns||[]){
    const content=JSON.parse(row.snapshot).content;check(row.clientId,content);
    if(content.productRef!==undefined){
      const approved=approvals.get(row.campaignId+':'+row.fingerprint)||[];
      if(!approved.some(h=>{const ref=JSON.parse(h.content).productRef;return h.clientId===row.clientId&&ref?.productId===content.productRef.productId&&ref?.revision===content.productRef.revision;}))throw new AppError('Produktzuordnung des Versandlaufs stimmt nicht mit seiner freigegebenen Kampagnenfassung überein.');
    }
  }
}

export function protectCampaignProductRestore(store:Store,data:BackupData) {
  const saved=new Map((data.campaignHistory||[]).map(row=>[row.id,row]));
  for(const row of store.db.prepare('SELECT * FROM campaign_history').all() as unknown as CampaignHistory[]) {
    if(JSON.parse(row.content).productRef===undefined)continue;
    const candidate=saved.get(row.id);
    if(!candidate||Object.entries(row).some(([key,value])=>(candidate as any)[key]!==value))throw new AppError('Diese Sicherung würde die bekannte Produktzuordnung einer Kampagnenfassung zurücksetzen. Bitte eine aktuelle Sicherung verwenden.');
  }
}

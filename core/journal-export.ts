import type {EvidenceEvent, EvidenceContext} from './evidence-journal';
export type JournalExportFilter = {
  clientId:string; fromInclusive?:string; toExclusive?:string;
  timeBasis?:'recordedAt'|'occurredAt'; source?:'all'|'mail_tests'|'incoming';
};
const fields = ['id','clientId','source','sourceId','sourceRevision','eventType','origin',
  'occurredAt','recordedAt','timeBasis','mailStatus','reportedKind','runId','campaignId',
  'campaignFingerprint','contactId','productId','productRevision','accountId','accountRevision','linkRevision','accountBasis'] as const;
const contextFields = ['mailId','runId','campaignId','campaignFingerprint','contactId','productId','productRevision','accountId','accountRevision','linkRevision','accountBasis'];
const uuid = (v:unknown) => typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const positive = (v:unknown) => Number.isSafeInteger(v) && Number(v)>0;
const text = (v:unknown,max:number) => typeof v==='string' && v.length<=max && !v.includes('\0');
function invalid():never {throw new Error('Ungültige Journal-Exportdaten.');}
function object(value:any,keys:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))invalid();
}
// Calendar validation precedes Date.parse; an offset date's day is not its UTC day.
function instant(value:unknown):number {
  const m=typeof value==='string'? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value):null;
  if(!m)invalid();
  const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const leap=y%4===0&&(y%100!==0||y%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  const parsed=Date.parse(value as string);
  if(month<1||month>12||day<1||day>days[month-1]||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59||Number(m[8]??0)>23||Number(m[9]??0)>59||!Number.isFinite(parsed))invalid();
  return parsed;
}
function cell(value:unknown):string {
  if(value===null||value===undefined)return '';
  let s=String(value);if(s.includes('\0'))invalid();
  if(/^[\s\u0001-\u001f\u007f-\u009f]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;
  return /[,"\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
function observation(row:EvidenceEvent) {
  if(!uuid(row.id)||!uuid(row.sourceId)||!uuid(row.mailboxId)||!positive(row.sourceRevision)
    ||!['mail_tests','incoming'].includes(row.source)||!['runtime','migration_snapshot','restore_snapshot'].includes(row.origin)
    ||!text(row.providerId,255)||!text(row.context,2000)||!text(row.payload,24000))invalid();
  const recordedAt=instant(row.recordedAt),occurredAt=instant(row.occurredAt);
  let c:EvidenceContext,p:any;
  try{c=JSON.parse(row.context);p=JSON.parse(row.payload);}catch{invalid();}
  object(c,contextFields);
  if(!uuid(c.mailId)||!['first_mail_observation','unknown'].includes(c.accountBasis))invalid();
  for(const k of ['runId','campaignId','contactId','productId','accountId'] as const)if(c[k]!==null&&!uuid(c[k]))invalid();
  for(const k of ['productRevision','accountRevision','linkRevision'] as const)if(c[k]!==null&&!positive(c[k]))invalid();
  if((c.productId===null)!==(c.productRevision===null)||(c.accountId===null)!==(c.accountRevision===null)||(c.runId===null)!==(c.campaignId===null)||(c.runId===null)!==(c.contactId===null))invalid();
  if(c.runId===null&&(c.campaignFingerprint!==null||c.productId!==null||c.accountId!==null||c.linkRevision!==null))invalid();
  if(c.runId!==null&&(typeof c.campaignFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(c.campaignFingerprint)))invalid();
  if(c.accountBasis==='unknown'&&(c.accountId!==null||c.linkRevision!==null)||c.accountBasis==='first_mail_observation'&&c.linkRevision===null)invalid();
  if(row.source==='mail_tests') {
    object(p,['status','messageId','result']);
    if(row.eventType!=='mail_status_observed'||row.timeBasis!=='local_status_time'||c.mailId!==row.sourceId||!['sending','sent','failed','unknown'].includes(p.status)||p.messageId!==`<${row.sourceId}@workbench.local>`||!text(p.result,2000))invalid();
  }else{
    object(p,['threadId','reportedKind','evidence']);
    if(row.eventType!=='incoming_observed'||row.timeBasis!=='provider_received_time'||row.sourceRevision!==1||!text(p.threadId,200)||!/^[a-zA-Z0-9_-]+$/.test(p.threadId)||!/^[a-zA-Z0-9_-]{1,200}$/.test(row.providerId)||!['reply','automatic','review'].includes(p.reportedKind)||!text(p.evidence,10000))invalid();
    try{JSON.parse(p.evidence);}catch{invalid();}
  }
  return {row,context:c,payload:p,recordedAt,occurredAt};
}
export function exportJournalCsv(rows:readonly EvidenceEvent[],filter:JournalExportFilter):{csv:string;rowCount:number} {
  if(!Array.isArray(rows)||!filter||typeof filter!=='object'||Array.isArray(filter)||!uuid(filter.clientId))invalid();
  if(Object.keys(filter).some(k=>!['clientId','fromInclusive','toExclusive','timeBasis','source'].includes(k)))invalid();
  const from=filter.fromInclusive===undefined?-Infinity:instant(filter.fromInclusive);
  const to=filter.toExclusive===undefined?Infinity:instant(filter.toExclusive);
  const basis=filter.timeBasis===undefined?'recordedAt':filter.timeBasis;
  const source=filter.source===undefined?'all':filter.source;
  if(from>=to||!['recordedAt','occurredAt'].includes(basis)||!['all','mail_tests','incoming'].includes(source))invalid();
  // Select the customer before parsing any JSON from foreign rows.
  const owned=rows.filter(row=>row?.clientId===filter.clientId);
  if(owned.length>50000)throw new Error('Exportgrenze von 50000 Journalzeilen überschritten.');
  const ids=new Set<string>();
  const selected=owned.map(row=>{
    if(ids.has(row.id))invalid();ids.add(row.id);
    return observation(row);
  }).filter(item=>item[basis]>=from&&item[basis]<to&&(source==='all'||item.row.source===source));
  selected.sort((a,b)=>a.recordedAt-b.recordedAt||(a.row.id<b.row.id?-1:a.row.id>b.row.id?1:0));
  const lines=selected.map(({row,context,payload})=>{
    const data:Record<string,unknown>={...row,...context,mailStatus:row.source==='mail_tests'?payload.status:null,reportedKind:row.source==='incoming'?payload.reportedKind:null};
    return fields.map(key=>cell(data[key])).join(',');
  });
  return {csv:[fields.join(','),...lines].join('\r\n'),rowCount:selected.length};
}

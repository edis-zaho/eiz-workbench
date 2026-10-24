export const threadIssues=['no_plain_text','unsupported_charset','external_body','attachment_present','unknown_participant','extra_recipients','draft','missing_message_id','unlinked_message','same_time','unobserved_message'] as const;
export type ThreadIssue=typeof threadIssues[number];
export type ThreadMessage={providerId:string;messageId:string;from:string;to:string;cc:string;subject:string;sentAt:string;direction:'sent'|'received'|'other';text:string;textStatus:'plain'|'unavailable';issues:ThreadIssue[]};
export type ThreadCapture={threadId:string;messages:ThreadMessage[]};
export const threadIssueLabels:Record<ThreadIssue,string>={no_plain_text:'Kein Klartext vorhanden',unsupported_charset:'Zeichensatz nicht unterstützt',external_body:'Text separat bei Google gespeichert',attachment_present:'Anhang nicht eingelesen',unknown_participant:'Teilnehmer nicht eindeutig zugeordnet',extra_recipients:'Zusätzliche Empfänger',draft:'Entwurf im Gespräch',missing_message_id:'Message-ID fehlt',unlinked_message:'Antwortreferenz fehlt',same_time:'Gleiche Nachrichtenzeit – Reihenfolge unklar',unobserved_message:'Noch nicht im lokalen Eingangsabgleich erfasst'};
export function validateThreadCapture(v:any):ThreadCapture {
 const exact=(o:any,keys:string[])=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))throw Error('Ungültiger Gesprächskontext.');};
 const text=(v:any,n:number)=>{if(typeof v!=='string'||v.length>n||v.includes('\0'))throw Error('Ungültiger Nachrichtentext.');};
 exact(v,['threadId','messages']);if(typeof v.threadId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(v.threadId)||!Array.isArray(v.messages)||!v.messages.length||v.messages.length>100)throw Error('Gespräch fehlt oder überschreitet 100 Nachrichten.');
 let total=0;const ids=new Set();for(const m of v.messages){exact(m,['providerId','messageId','from','to','cc','subject','sentAt','direction','text','textStatus','issues']);if(typeof m.providerId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(m.providerId)||ids.has(m.providerId))throw Error('Doppelte oder ungültige Nachrichtenkennung.');ids.add(m.providerId);
  for(const k of ['messageId','from','to','cc','subject'])text(m[k],2000);text(m.text,64000);text(m.sentAt,40);if(!Number.isFinite(Date.parse(m.sentAt))||new Date(m.sentAt).toISOString()!==m.sentAt)throw Error('Ungültige Nachrichtenzeit.');
  if(!['sent','received','other'].includes(m.direction)||!['plain','unavailable'].includes(m.textStatus)||!Array.isArray(m.issues)||new Set(m.issues).size!==m.issues.length||m.issues.some((i:any)=>!threadIssues.includes(i)))throw Error('Ungültiger Kontextstatus.');
  if(m.textStatus==='unavailable'&&(m.text!==''||!m.issues.some((i:string)=>['no_plain_text','unsupported_charset','external_body'].includes(i))))throw Error('Fehlender Text nicht gekennzeichnet.');if(m.textStatus==='plain'&&!m.text.trim())throw Error('Leerer Klartext.');
  total+=m.text.length;
 }if(total>256000||JSON.stringify(v).length>512000)throw Error('Gespräch überschreitet das lokale Größenlimit.');
 for(let i=1;i<v.messages.length;i++)if(v.messages[i-1].sentAt>v.messages[i].sentAt)throw Error('Gesprächsreihenfolge ungültig.');return v;
}

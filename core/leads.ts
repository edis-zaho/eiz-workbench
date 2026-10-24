export type Lead = { id:string; clientId:string; email:string; firstName:string; lastName:string; company:string; role:string; source:string; createdAt:string; blocked:number; blockReason:string };
export const leadFields = ['email','firstName','lastName','company','role'] as const;
export type LeadField = typeof leadFields[number];
export type Mapping = Record<LeadField, number>;
export type ImportInput = { csv:string; delimiter:string; mapping:Mapping; filename:string; fingerprint?:string };
export type Candidate = { row:number; email:string; firstName:string; lastName:string; company:string; role:string; problem:string };
export type Preview = { headers:string[]; total:number; valid:number; invalid:number; duplicates:number; blocked:number; rows:(Candidate & {status:string})[]; fingerprint:string };

// Pure parser shared by preview UI and backend; never evaluates cell contents.
export function parseCSV(text:string, delimiter:string):string[][] {
  if(typeof text!=='string'||text.length>5*1024*1024)throw new Error('CSV darf höchstens 5 MB Text enthalten.');
  if(![',',';','\t'].includes(delimiter))throw new Error('Ungültiges Trennzeichen.');
  text=text.replace(/^\uFEFF/,'');
  if(text.includes('\0')||text.includes('\uFFFD'))throw new Error('Bitte die Datei als CSV UTF-8 speichern.');
  const rows:string[][]=[]; let row:string[]=[],cell='',quoted=false,closed=false;
  const field=()=>{if(cell.length>4000)throw new Error('Ein CSV-Feld überschreitet 4.000 Zeichen.');row.push(cell.trim());cell='';closed=false;if(row.length>100)throw new Error('CSV hat mehr als 100 Spalten.');};
  const record=()=>{field();if(row.some(Boolean))rows.push(row);row=[];if(rows.length>10001)throw new Error('Maximal 10.000 Kontakte je Import.');};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c===delimiter){field();continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;record();continue;}
    if(closed){if(c===' '||c==='\t')continue;throw new Error('Ungültiges CSV: Zeichen nach geschlossenem Anführungszeichen.');}
    if(c==='"'){if(cell.length)throw new Error('Ungültige Anführungszeichen in CSV.');quoted=true;}else cell+=c;
  }
  if(quoted)throw new Error('CSV enthält ein nicht geschlossenes Anführungszeichen.');
  if(cell||row.length||closed)record();
  if(rows.length<2)throw new Error('CSV benötigt eine Kopfzeile und mindestens einen Kontakt.');
  return rows;
}
export function validEmail(email:string){return email.length<=254&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)&&!email.split('@')[0].startsWith('.')&&!email.split('@')[0].endsWith('.')&&!email.split('@')[0].includes('..');}
export function candidates(input:ImportInput){
  const rows=parseCSV(input?.csv,input?.delimiter),headers=rows.shift()!;
  if(!input.mapping||typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>255)throw new Error('Dateiname oder Spaltenzuordnung fehlt.');
  const selected=new Set<number>();
  for(const key of leadFields){const n=input.mapping[key];if(!Number.isInteger(n)||n< -1||n>=headers.length||(key==='email'&&n<0))throw new Error('Bitte die E-Mail-Spalte zuordnen und alle Spalten prüfen.');if(n>=0){if(selected.has(n))throw new Error('Eine CSV-Spalte darf nur einem Feld zugeordnet werden.');selected.add(n);}}
  return {headers,rows:rows.map((r,i):Candidate=>{const get=(key:LeadField)=>input.mapping[key]<0?'':r[input.mapping[key]]||'';const email=get('email').toLowerCase();const lead={row:i+2,email,firstName:get('firstName'),lastName:get('lastName'),company:get('company'),role:get('role'),problem:''};lead.problem=r.length!==headers.length?'Spaltenzahl weicht von der Kopfzeile ab':!validEmail(email)?'Ungültige E-Mail-Adresse':leadFields.some(k=>k!=='email'&&lead[k].length>250)?'Kontaktfeld überschreitet 250 Zeichen':'';return lead;})};
}

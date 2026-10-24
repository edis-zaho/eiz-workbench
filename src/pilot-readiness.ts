export type PilotCheck={id:string;ok:boolean;label:string;action:string};
export type ReadProof={mailboxId:string;email:string;checkedAt:string;readVerified:true};
export type PilotProgressSnapshot = {
 clientId:string; clientVersion:number; checkedAt:number; briefApproved:boolean; contactCount:number;
 campaign:null|{id:string;approved:boolean;problemCount:number;fingerprint:string};
 runs:{clientId:string;campaignId:string;fingerprint:string;status:string;snapshot:{mode:string};counts:{status:string;count:number}[]}[];
};
type ProgressStep={id:'brief'|'leads'|'campaigns'|'queue';label:string;state:'unknown'|'open'|'checked'|'simulation'|'live'|'attention';detail:string};
export function pilotProgress(input:{clientId:string;clientVersion:number;paused:boolean;now:number;snapshot?:PilotProgressSnapshot}) {
 const s=input.snapshot;
 const fresh=!!s&&s.clientId===input.clientId&&s.clientVersion===input.clientVersion&&Number.isFinite(s.checkedAt)&&input.now>=s.checkedAt&&input.now-s.checkedAt<60000;
 const steps:ProgressStep[]=[
  {id:'brief',label:'Angebot und Betriebsrahmen',state:'unknown',detail:'Stand neu laden.'},
  {id:'leads',label:'Importierte Kontakte',state:'unknown',detail:'Stand neu laden.'},
  {id:'campaigns',label:'Ausgewählter Kampagnenplan',state:'unknown',detail:'Stand neu laden.'},
  {id:'queue',label:'Lauf der ausgewählten Planfassung',state:'unknown',detail:'Stand neu laden.'}
 ];
 if(!fresh||!s)return {fresh:false,steps,next:'reload'};
 steps[0]={...steps[0],state:s.briefApproved?'checked':'open',detail:s.briefApproved?'Gespeicherter Betriebsrahmen freigegeben.':'Angaben und Grenzen prüfen und den gespeicherten Stand freigeben.'};
 steps[1]={...steps[1],state:s.contactCount>0?'checked':'open',detail:s.contactCount>0?`${s.contactCount>10000?'Mehr als 10.000':s.contactCount} Kontakte importiert. Dies bestätigt keine Kontaktfreigabe.`:'Eigene oder ausdrücklich freigegebene Testkontakte importieren.'};
 const campaign=s.campaign,approved=!!campaign&&campaign.approved&&campaign.problemCount===0;
 steps[2]={...steps[2],state:approved?'checked':'open',detail:!campaign?'Eine Kampagne anlegen oder auswählen.':approved?'Plan nach vorhandener Kampagnenprüfung freigegeben. Live-Freigabe bleibt separat.':`${campaign.problemCount} Prüfhinweise. Vorschau im Kampagnenbereich prüfen und Plan freigeben.`};
 const ownRuns=s.runs.filter(r=>r.clientId===input.clientId);
 const uncertain=ownRuns.some(r=>r.counts.some(c=>c.count>0&&['unknown','sending'].includes(c.status)));
 const selectedRuns=ownRuns.filter(r=>r.campaignId===campaign?.id);
 const current=selectedRuns.find(r=>r.fingerprint===campaign?.fingerprint);
 let next=!s.briefApproved?'brief':!s.contactCount?'leads':'campaigns';
 let queue:Pick<ProgressStep,'state'|'detail'>={state:'open',detail:'Noch kein Lauf dieser Planfassung. Freigegebenen Plan in die Warteschlange übernehmen.'};
 if(uncertain)queue={state:'attention',detail:'Offene oder unklare Übergabe in einer Kampagne dieses Kunden. In der Warteschlange prüfen; nicht erneut senden.'};
 else if(!current&&selectedRuns.length)queue={state:'attention',detail:'Nur Läufe früherer Planfassungen vorhanden. Status und verbleibende Aufträge in der Warteschlange prüfen.'};
 else if(current){
  const runLabel:Record<string,string>={prepared:'vorbereitet',active:'aktiv',paused:'pausiert',completed:'abgeschlossen',cancelled:'abgebrochen'};
  if(current.snapshot.mode==='rehearsal')queue={state:'simulation',detail:`Probelauf ${runLabel[current.status]||'mit unbekanntem Status'} · keine echten E-Mails. Bereits verarbeitete Probeläufe lassen sich nicht live umwandeln.`};
  else if(current.snapshot.mode==='live'){
   const sent=current.counts.find(c=>c.status==='sent')?.count||0;
   queue={state:current.status==='active'&&!input.paused&&approved?'live':'attention',detail:`LIVE-Lauf ${runLabel[current.status]||'mit unbekanntem Status'} · ${sent} von Google angenommen. Das belegt weder Zustellung noch eine Antwort.`};
   if(approved&&['active','completed'].includes(current.status))next='journal';
  }else queue={state:'unknown',detail:'Laufmodus unbekannt. Warteschlange prüfen.'};
 }
 if(uncertain||(!current&&selectedRuns.length))next='campaigns';
 if(input.paused){next='client';queue={state:'attention',detail:'Kunde pausiert. Oben im Kundenbereich prüfen; kein Lauf wird durch diese Übersicht fortgesetzt.'};}
 steps[3]={...steps[3],...queue};
 return {fresh:true,steps,next};
}
export function pilotReadiness(input:{publicMode?:boolean;senderReady?:boolean;sendGranted?:boolean;paused:boolean;mailbox?:{id:string;email:string;readAccess:boolean}|null;proof?:ReadProof;sentTests?:{mailboxId:string;status:string}[];sync?:{mailboxId:string;enabled:boolean;stale:boolean;lastSuccessAt:string|null};progress?:{mailboxId?:string;status:string;stale:boolean;unmatched?:number};unassigned?:{mailboxId:string;status:string}[]}):PilotCheck[]{
 const m=input.mailbox,proof=input.proof,sync=input.sync,progress=input.progress;
 return [
  ...(input.publicMode?[{id:'sender',ok:input.senderReady===true,label:'Absender und Signatur für dieses Postfach gespeichert',action:'Absenderprofil im Postfachbereich speichern.'},{id:'send-grant',ok:input.sendGranted===true,label:'Gmail-Senden erlaubt',action:'Sendeberechtigung verbinden.'}]:[]),
  {id:'customer',ok:!input.paused,label:'Kunde aktiv',action:'Kundenpause aufheben.'},
  {id:'mailbox',ok:!!m,label:'Google-Postfach verbunden',action:'Postfach diesem Kunden zuordnen.'},
  {id:'read-scope',ok:!!m?.readAccess,label:'Gmail-Lesezugriff erteilt',action:'Lesenden Gmail-Zugriff einrichten.'},
  {id:'read-check',ok:!!m&&proof?.readVerified===true&&proof.mailboxId===m.id&&proof.email===m.email&&Number.isFinite(Date.parse(proof.checkedAt))&&Date.now()-Date.parse(proof.checkedAt)<600000&&Date.now()>=Date.parse(proof.checkedAt),label:'Gmail API und Kontozuordnung aktuell geprüft',action:'Oben „Gmail-Lesezugriff live prüfen“ ausführen.'},
  {id:'test',ok:!!m&&!!input.sentTests?.some(t=>t.mailboxId===m.id&&t.status==='sent'),label:'Testnachricht von Google angenommen',action:'Eine eigene oder freigegebene Testadresse verwenden und den Empfang prüfen.'},
  {id:'uncertain-send',ok:!!m&&Array.isArray(input.sentTests)&&!input.sentTests.some(t=>t.mailboxId===m.id&&['unknown','sending'].includes(t.status)),label:'Keine unklaren Testsendungen',action:'Offene Versandergebnisse zuerst in Gmail abgleichen; nicht erneut senden.'},
  {id:'sync',ok:!!m&&sync?.mailboxId===m.id&&sync.enabled&&!!sync.lastSuccessAt&&!sync.stale,label:'Gesprächsabgleich aktuell',action:'Synchronisation aktivieren und einen erfolgreichen Lauf abwarten.'},
  {id:'delivery',ok:!!m&&progress?.mailboxId===m.id&&progress.status==='complete'&&!progress.stale&&(progress.unmatched||0)===0,label:'Rückläuferprüfung aktuell und vollständig',action:'Fortsetzbare Postfachprüfung abschließen; ungeklärte Eingänge prüfen.'},
  {id:'unassigned',ok:!!m&&Array.isArray(input.unassigned)&&!input.unassigned.some(u=>u.mailboxId===m.id&&u.status==='open'),label:'Keine ungeklärten Eingänge',action:'Offene Zuordnungen prüfen und entscheiden.'}
 ];
}

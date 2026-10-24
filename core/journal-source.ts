import {AppError,type Store} from './store';
import type {EvidenceEvent} from './evidence-journal';
import {exportJournalCsv,type JournalExportFilter} from './journal-export';

export function exportClientJournal(store:Store,clientId:string,input:unknown) {
  store.client(clientId);
  const keys=['fromInclusive','toExclusive','timeBasis','source'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))throw new AppError('Ungültiger Journalfilter.');
  const filter={...input,clientId} as JournalExportFilter;
  try{exportJournalCsv([],filter);}catch{throw new AppError('Ungültiger Journalfilter. Zeitraum, Zeitbasis und Quelle prüfen.');}
  return store.transaction(()=>{
    const rows=store.db.prepare('SELECT * FROM evidence_events WHERE clientId=? ORDER BY rowid LIMIT 50001').all(clientId) as unknown as EvidenceEvent[];
    if(rows.length>50000)throw new AppError('Dieser Kunde überschreitet die Exportgrenze von 50000 Journalzeilen. Es wurde kein unvollständiger Export erstellt; ein Export in Teilbeständen ist erforderlich.');
    // Historical references may be absent after an older restore. Existing
    // entities must still belong to the selected customer.
    const foreign=store.db.prepare(`SELECT 1 FROM evidence_events e
      LEFT JOIN mail_tests m ON m.id=json_extract(e.context,'$.mailId')
      LEFT JOIN queue_runs r ON r.id=json_extract(e.context,'$.runId')
      LEFT JOIN campaigns c ON c.id=json_extract(e.context,'$.campaignId')
      LEFT JOIN leads l ON l.id=json_extract(e.context,'$.contactId')
      LEFT JOIN products p ON p.id=json_extract(e.context,'$.productId')
      LEFT JOIN accounts a ON a.id=json_extract(e.context,'$.accountId')
      LEFT JOIN incoming i ON e.source='incoming' AND i.id=e.sourceId
      WHERE e.clientId=? AND (m.clientId!=e.clientId OR r.clientId!=e.clientId OR c.clientId!=e.clientId OR l.clientId!=e.clientId OR p.clientId!=e.clientId OR a.clientId!=e.clientId OR i.clientId!=e.clientId) LIMIT 1`).get(clientId);
    if(foreign)throw new AppError('Die gespeicherten Beobachtungen enthalten widersprüchliche Kundenzuordnungen. Es wurde nichts verändert.');
    let result:ReturnType<typeof exportJournalCsv>;
    try{result=exportJournalCsv(rows,filter);}catch{throw new AppError('Die gespeicherten Beobachtungen enthalten ungültige Exportdaten. Es wurde nichts verändert.');}
    return {...result,filename:'ereignishistorie.csv',notes:[
      'Jede Zeile ist eine technische Beobachtung. Mehrere Statuswechsel derselben Nachricht sind keine zusätzlichen Sendungen.',
      'Versandannahme ist kein Zustellbeweis; ein Eingang oder dessen technischer Typ belegt weder menschliche Antwort noch geschäftliches Interesse.',
      'migration_snapshot und restore_snapshot kennzeichnen übernommene Zustände. Frühere nicht aufgezeichnete Ereignisse werden nicht rekonstruiert.',
      'Produkt- und Unternehmensbezüge stammen aus dem gespeicherten historischen Kontext, fehlende Zuordnungen bleiben leer.',
      `Der Zeitraum filtert nach ${filter.timeBasis==='occurredAt'?'Quellenzeit':'Erfassungszeit'}. Die Reihenfolge folgt der Erfassungszeit und ist kein kausaler Beweis zwischen Quellen.`,
      'Testsendungen sind enthalten. Nachrichtentexte und Providerkennungen werden nicht exportiert; die enthaltenen IDs sind jedoch nicht anonym.'
    ]};
  });
}

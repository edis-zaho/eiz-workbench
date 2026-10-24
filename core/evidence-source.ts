import { Store, AppError } from './store';
import { exportEvidenceCsv, EvidenceKind, EvidenceExportRow, EvidenceExportFilter } from './evidence-export';

const MAX_ROWS = 50000;

/**
 * Validates the user-provided input object for evidence export.
 * @param input The unknown input from the request body.
 * @returns A validated and typed partial filter object.
 */
function validateInput(input: unknown): Omit<EvidenceExportFilter, 'clientId'> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new AppError('Der Anfrage-Body muss ein JSON-Objekt sein.', 400);
    }

    const allowedKeys = new Set(['fromInclusive', 'toExclusive', 'kinds']);
    for (const key in input) {
        if (!allowedKeys.has(key)) {
            throw new AppError('Der Filter enthält ein unerlaubtes Feld.', 400);
        }
    }

    const filter = input as Partial<EvidenceExportFilter>;

    // Validation will be performed by exportEvidenceCsv, but we can do a basic type check.
    if (filter.fromInclusive !== undefined && typeof filter.fromInclusive !== 'string') {
        throw new AppError("Das Feld 'fromInclusive' muss ein ISO-8601-Datumstring sein.", 400);
    }
    if (filter.toExclusive !== undefined && typeof filter.toExclusive !== 'string') {
        throw new AppError("Das Feld 'toExclusive' muss ein ISO-8601-Datumstring sein.", 400);
    }
    if (filter.kinds !== undefined && !Array.isArray(filter.kinds)) {
        throw new AppError("Das Feld 'kinds' muss ein Array von Strings sein.", 400);
    }

    return {
        fromInclusive: filter.fromInclusive,
        toExclusive: filter.toExclusive,
        kinds: filter.kinds,
    };
}

/**
 * Fetches and normalizes sent mail events from the database.
 */
function fetchMailTests(db: Store['db'], clientId: string) {
    const stmt = db.prepare(`
        SELECT
            m.id, m.updatedAt, m.status,
            q.leadId,
            c.id as campaignId,
            l.clientId as leadClientId,
            qr.clientId as runClientId
        FROM mail_tests AS m
        LEFT JOIN queue_items AS q ON q.id = m.id
        LEFT JOIN leads AS l ON l.id = q.leadId AND l.clientId = ?
        LEFT JOIN queue_runs AS qr ON qr.id = q.runId AND qr.clientId = ?
        LEFT JOIN campaigns AS c ON c.id = qr.campaignId AND c.clientId = qr.clientId
        WHERE m.clientId = ?
        LIMIT ${MAX_ROWS + 1}
    `);

    const rows = stmt.all(clientId, clientId, clientId) as any[];
    const normalized: EvidenceExportRow[] = [];

    for (const row of rows) {
        let kind: EvidenceKind | null = null;
        if (row.status === 'sent') kind = 'sent';
        else if (row.status === 'failed' || row.status === 'unknown') kind = 'unknown';
        // 'sending' status is excluded as per spec

        if (kind) {
            normalized.push({
                id: `mail_tests:${row.id}`,
                clientId,
                accountId: null,
                contactId: row.runClientId && row.leadClientId ? row.leadId : null,
                campaignId: row.runClientId ? row.campaignId : null,
                occurredAt: row.updatedAt,
                kind,
                sourceId: `mail_tests:${row.id}`,
            });
        }
    }
    return { rows: normalized, sourceCount: rows.length };
}

/**
 * Fetches and normalizes incoming mail events from the database.
 */
function fetchIncoming(db: Store['db'], clientId: string) {
    const stmt = db.prepare(`
        SELECT
            i.id, i.receivedAt, i.kind, i.mailId,
            q.leadId,
            c.id as campaignId,
            l.clientId as leadClientId,
            qr.clientId as runClientId
        FROM incoming AS i
        LEFT JOIN mail_tests AS m_join ON m_join.id = i.mailId AND m_join.clientId = ?
        LEFT JOIN queue_items AS q ON q.id = m_join.id
        LEFT JOIN leads AS l ON l.id = q.leadId AND l.clientId = ?
        LEFT JOIN queue_runs AS qr ON qr.id = q.runId AND qr.clientId = ?
        LEFT JOIN campaigns AS c ON c.id = qr.campaignId AND c.clientId = qr.clientId
        WHERE i.clientId = ?
        LIMIT ${MAX_ROWS + 1}
    `);

    const rows = stmt.all(clientId, clientId, clientId, clientId) as any[];
    const normalized: EvidenceExportRow[] = [];

    for (const row of rows) {
        let kind: EvidenceKind | null = null;
        if (row.kind === 'reply') kind = 'reply';
        else kind = 'unknown'; // Future/unrecognized technical kinds are not discarded or inferred.

        if (kind) {
            normalized.push({
                id: `incoming:${row.id}`,
                clientId,
                accountId: null,
                contactId: row.runClientId && row.leadClientId ? row.leadId : null,
                campaignId: row.runClientId ? row.campaignId : null,
                occurredAt: row.receivedAt,
                kind,
                sourceId: `incoming:${row.id}`,
            });
        }
    }
    return { rows: normalized, sourceCount: rows.length };
}

/**
 * Exports evidence for a given client, based on filter criteria.
 * This function reads from the database, normalizes data, and returns a CSV export.
 * @param store The application's data store.
 * @param clientId The ID of the client for whom to export evidence.
 * @param input The raw input body from the API request.
 * @returns An object containing the CSV string, filename, row count, and notes.
 */
export function exportClientEvidence(store: Store, clientId: string, input: unknown) {
    const userInput = validateInput(input);
    store.client(clientId); // Throws 404 if not found

    const filter: EvidenceExportFilter = { clientId, ...userInput };
    // Validate even when the database is empty; do not turn bad filters into HTTP 500.
    try { exportEvidenceCsv([], filter); }
    catch { throw new AppError('Ungültiger Exportfilter. Bitte Zeitraum und Ereignisarten prüfen.', 400); }

    const mailRows = fetchMailTests(store.db, clientId);
    const incomingRows = fetchIncoming(store.db, clientId);

    if (mailRows.sourceCount + incomingRows.sourceCount > MAX_ROWS) {
        throw new AppError(`Dieser Kunde überschreitet die Exportgrenze von ${MAX_ROWS} Quellzeilen. Für diesen Datenbestand wird ein Export in Teilbeständen benötigt. Die Zeitraumwahl hebt diese Grenze nicht auf.`, 400);
    }

    const allNormalizedRows = [...mailRows.rows, ...incomingRows.rows];
    let csv: string;
    try { csv = exportEvidenceCsv(allNormalizedRows, filter); }
    catch { throw new AppError('Die gespeicherten Ereignisse enthalten ungültige Exportdaten. Es wurde nichts verändert.', 400); }
    // Count records, never CSV lines (identifiers may contain line breaks).
    const from = filter.fromInclusive === undefined ? -Infinity : Date.parse(filter.fromInclusive);
    const to = filter.toExclusive === undefined ? Infinity : Date.parse(filter.toExclusive);
    const rowCount = allNormalizedRows.filter(row => {
        const time = Date.parse(row.occurredAt);
        return time >= from && time < to && (!filter.kinds || filter.kinds.includes(row.kind));
    }).length;

    return {
        csv,
        filename: 'ereignisse.csv',
        rowCount,
        notes: [
            'Die exportierten Daten sind eine Momentaufnahme gespeicherter Zustände, keine vollständige und unveränderliche Historie aller Ereignisse.',
            "Der Zeitpunkt eines Versandstatus ('sent'/'unknown') kann nachträglich durch manuelle oder automatische Abgleiche aktualisiert werden und muss nicht dem tatsächlichen Sendezeitpunkt entsprechen.",
            "Eine technische Antwort ('reply') ist kein Beleg für geschäftliches Interesse, sondern kann auch eine Abwesenheitsnotiz oder eine Unzustellbarkeitsnachricht sein.",
            "Automatische oder unklare Antworten sowie fehlgeschlagene oder unklare Sendungen werden als 'unknown' klassifiziert.",
            'Die Zuordnung zu Kontakten (contactId) oder Kampagnen (campaignId) kann fehlen, wenn ein Ereignis nicht aus einer Kampagne stammt oder die Zuordnung nicht mehr konsistent ist.',
            'Test-E-Mails, die manuell versendet wurden, sind in diesem Export enthalten.'
        ]
    };
}

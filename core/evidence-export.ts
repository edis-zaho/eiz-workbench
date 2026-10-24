/**
 * The kind of event that occurred.
 * - `sent`: An outgoing message was sent.
 * - `reply`: A contact replied to a message.
 * - `bounce`: The message could not be delivered and bounced.
 * - `unknown`: An event of an undetermined or unclassified kind.
 */
export type EvidenceKind = 'sent' | 'reply' | 'bounce' | 'unknown';

const VALID_KINDS: ReadonlySet<string> = new Set<EvidenceKind>(['sent', 'reply', 'bounce', 'unknown']);

/**
 * Represents a single, normalized evidence record for export.
 * The caller is responsible for normalizing application data into this format.
 */
export interface EvidenceExportRow {
    readonly id: string;
    readonly clientId: string;
    readonly accountId: string | null;
    readonly contactId: string | null;
    readonly campaignId: string | null;
    readonly occurredAt: string; // ISO 8601 date-time string
    readonly kind: EvidenceKind;
    readonly sourceId: string;
}

/**
 * Defines the filtering criteria for the evidence export.
 */
export interface EvidenceExportFilter {
    /** Mandatory client identifier to scope the export. */
    readonly clientId: string;
    /** Optional inclusive start of the time range (ISO 8601 format). */
    readonly fromInclusive?: string;
    /** Optional exclusive end of the time range (ISO 8601 format). */
    readonly toExclusive?: string;
    /** Optional list of event kinds to include. If undefined, all kinds are included. If an empty array, no events will match. */
    readonly kinds?: readonly EvidenceKind[];
}

// Validates a string is a conforming RFC3339-like timestamp with timezone.
// Example: 2023-10-26T10:00:00Z, 2023-10-26T05:00:00-05:00, 2023-10-26T10:00:00.123Z
const ISO_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Validates a given ISO date-time string for format and calendar correctness.
 * @param isoString The date-time string to validate.
 * @param fieldName The name of the field for error messages.
 * @returns The validated instant in milliseconds; callers preserve the original text.
 */
function validateIsoDateTime(isoString: unknown, fieldName: string): number {
    const match = typeof isoString === 'string' ? ISO_DATETIME_REGEX.exec(isoString) : null;
    if (!match) {
        throw new Error(`Filter's '${fieldName}' must be a valid ISO 8601 date-time string with timezone.`);
    }
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const instant = Date.parse(isoString as string);
    // Date.parse alone silently normalizes February 30 and 24:00 into another day.
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
        || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
        || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59 || !Number.isFinite(instant)) {
        throw new Error(`Filter's '${fieldName}' is not a valid calendar date.`);
    }
    return instant;
}

/**
 * Validates the provided export filter.
 * @param filter The filter object to validate.
 */
function validateFilter(filter: EvidenceExportFilter): void {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw new Error('Filter must be a valid object.');
    }
    if (typeof filter.clientId !== 'string' || filter.clientId.trim().length === 0) {
        throw new Error("Filter must include a non-empty 'clientId' string.");
    }

    let from: number | undefined;
    let to: number | undefined;

    if (filter.fromInclusive !== undefined) {
        from = validateIsoDateTime(filter.fromInclusive, 'fromInclusive');
    }
    if (filter.toExclusive !== undefined) {
        to = validateIsoDateTime(filter.toExclusive, 'toExclusive');
    }

    if (from !== undefined && to !== undefined && from > to) {
        throw new Error("Filter's 'fromInclusive' must not be after 'toExclusive'.");
    }

    if (filter.kinds !== undefined) {
        if (!Array.isArray(filter.kinds)) {
            throw new Error("Filter's 'kinds' must be an array of strings.");
        }
        for (const kind of filter.kinds) {
            if (!VALID_KINDS.has(kind)) {
                throw new Error("Filter's 'kinds' contains an invalid value.");
            }
        }
    }
}

/**
 * Validates the array of rows to be exported.
 * @param rows The rows to validate.
 */
function validateRows(rows: readonly EvidenceExportRow[]): number[] {
    if (!Array.isArray(rows)) {
        throw new Error('Input rows must be an array.');
    }
    const times: number[] = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || typeof row !== 'object' || Array.isArray(row) ||
            typeof row.id !== 'string' || row.id.trim().length === 0 ||
            typeof row.clientId !== 'string' || row.clientId.trim().length === 0 ||
            (row.accountId !== null && typeof row.accountId !== 'string') ||
            (row.contactId !== null && typeof row.contactId !== 'string') ||
            (row.campaignId !== null && typeof row.campaignId !== 'string') ||
            typeof row.occurredAt !== 'string' ||
            !VALID_KINDS.has(row.kind) ||
            typeof row.sourceId !== 'string' || row.sourceId.trim().length === 0) {
            throw new Error(`Input row at index ${i} is malformed.`);
        }
        times.push(validateIsoDateTime(row.occurredAt, 'occurredAt'));
    }
    return times;
}

const CSV_HEADER = 'id,clientId,accountId,contactId,campaignId,occurredAt,kind,sourceId';
const CSV_FIELDS: (keyof EvidenceExportRow)[] = ['id', 'clientId', 'accountId', 'contactId', 'campaignId', 'occurredAt', 'kind', 'sourceId'];

/**
 * Escapes a cell value for CSV, including formula injection protection.
 * @param value The raw cell value.
 * @returns The escaped and quoted CSV cell string.
 */
function escapeAndQuoteCell(value: string | null): string {
    if (value === null || value === undefined) {
        return '';
    }

    let valueToQuote = String(value);

    // Formula injection protection
    // Inspect the prefix without trimming away the very control characters we must protect.
    if (/^\s*[=+\-@\t\r\n]/.test(valueToQuote)) {
        valueToQuote = "'" + valueToQuote;
    }

    // Standard CSV quoting
    if (/[\",\r\n]/.test(valueToQuote)) {
        return `"${valueToQuote.replace(/"/g, '""')}"`;
    }

    return valueToQuote;
}

/**
 * Exports an array of evidence rows to a CSV string based on the provided filter.
 * The caller is responsible for providing normalized rows.
 * This function does not perform any data mapping or evidence inference.
 *
 * @param rows A read-only array of `EvidenceExportRow` objects.
 * @param filter An `EvidenceExportFilter` to select which rows to export.
 * @returns A string containing the filtered and sorted data in CSV format.
 */
export function exportEvidenceCsv(rows: readonly EvidenceExportRow[], filter: EvidenceExportFilter): string {
    validateFilter(filter);
    const times = validateRows(rows);
    const from = filter.fromInclusive === undefined ? -Infinity : Date.parse(filter.fromInclusive);
    const to = filter.toExclusive === undefined ? Infinity : Date.parse(filter.toExclusive);

    const filteredRows = rows.map((row, index) => ({ row, time: times[index] })).filter(({ row, time }) => {
        if (row.clientId !== filter.clientId) {
            return false;
        }
        if (time < from) {
            return false;
        }
        if (time >= to) {
            return false;
        }
        if (filter.kinds && !filter.kinds.includes(row.kind)) {
            return false;
        }
        return true;
    });

    // Create a mutable copy for sorting to preserve input array.
    const sortedRows = [...filteredRows];

    // Sort by occurredAt ascending, then by id ascending for stability.
    sortedRows.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (a.row.id < b.row.id) return -1;
        if (a.row.id > b.row.id) return 1;
        return 0;
    });

    const csvRows = sortedRows.map(({ row }) =>
        CSV_FIELDS.map(field => escapeAndQuoteCell(row[field])).join(',')
    );

    return [CSV_HEADER, ...csvRows].join('\r\n');
}

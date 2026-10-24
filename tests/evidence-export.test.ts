import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exportEvidenceCsv, EvidenceExportRow, EvidenceExportFilter } from '../core/evidence-export';

const deepFreeze = <T extends object>(obj: T): T => {
    Object.keys(obj).forEach(prop => {
        const value = (obj as any)[prop];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    });
    return Object.freeze(obj);
};

const FIXTURES: readonly EvidenceExportRow[] = deepFreeze([
    { id: 'c', clientId: 'client-1', accountId: 'acc-1', contactId: null, campaignId: 'camp-a', occurredAt: '2023-01-15T10:00:00Z', kind: 'sent', sourceId: 'src-c' },
    { id: 'd', clientId: 'client-1', accountId: 'acc-1', contactId: 'con-2', campaignId: 'camp-a', occurredAt: '2023-01-15T11:00:00Z', kind: 'reply', sourceId: 'src-d' },
    { id: 'b', clientId: 'client-1', accountId: null, contactId: 'con-1', campaignId: 'camp-b', occurredAt: '2023-01-15T10:00:00Z', kind: 'bounce', sourceId: 'src-b' },
    { id: 'a', clientId: 'client-2', accountId: 'acc-2', contactId: 'con-3', campaignId: 'camp-c', occurredAt: '2023-01-15T09:00:00Z', kind: 'sent', sourceId: 'src-a' },
    { id: 'e', clientId: 'client-1', accountId: 'acc-1', contactId: 'con-2', campaignId: 'camp-a', occurredAt: '2023-01-20T12:00:00Z', kind: 'unknown', sourceId: 'src-e' },
    { id: 'f', clientId: 'client-1', accountId: 'acc-1', contactId: 'con-2', campaignId: 'camp-a', occurredAt: '2023-01-20T12:00:00Z', kind: 'sent', sourceId: 'src-f' }, // Duplicate timestamp
]);

describe('exportEvidenceCsv', () => {

    test('should return only the header for no matching rows', () => {
        const filter: EvidenceExportFilter = { clientId: 'non-existent-client' };
        const expected = 'id,clientId,accountId,contactId,campaignId,occurredAt,kind,sourceId';
        assert.equal(exportEvidenceCsv(FIXTURES, filter), expected);
    });

    test('should filter by clientId', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-2' };
        const result = exportEvidenceCsv(FIXTURES, filter);
        const lines = result.split('\r\n');
        assert.equal(lines.length, 2);
        assert(lines[1].startsWith('a,client-2'));
    });

    test('should filter by inclusive start time', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-1', fromInclusive: '2023-01-15T11:00:00Z' };
        const result = exportEvidenceCsv(FIXTURES, filter);
        const lines = result.split('\r\n');
        assert.equal(lines.length, 4, 'Should include rows at or after fromInclusive');
        assert(lines[1].startsWith('d,'));
        assert(lines[2].startsWith('e,'));
        assert(lines[3].startsWith('f,'));
    });

    test('should filter by exclusive end time', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-1', toExclusive: '2023-01-15T11:00:00Z' };
        const result = exportEvidenceCsv(FIXTURES, filter);
        const lines = result.split('\r\n');
        assert.equal(lines.length, 3, 'Should exclude rows at or after toExclusive');
        assert(lines[1].startsWith('b,'));
        assert(lines[2].startsWith('c,'));
    });

    test('should filter by a full time range with timezone offset', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-1', fromInclusive: '2023-01-15T09:00:00-01:00', toExclusive: '2023-01-15T10:00:01-01:00' };
        const result = exportEvidenceCsv(FIXTURES, filter);
        const lines = result.split('\r\n');
        assert.equal(lines.length, 4, '10:00Z and 11:00Z both precede the exclusive 11:00:01Z end');
        assert(lines[1].startsWith('b,')); // 10:00:00Z
        assert(lines[2].startsWith('c,')); // 10:00:00Z
        assert(lines[3].startsWith('d,')); // 11:00:00Z
    });

    test('should filter by kinds', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-1', kinds: ['sent', 'unknown'] };
        const result = exportEvidenceCsv(FIXTURES, filter);
        const lines = result.split('\r\n');
        assert.equal(lines.length, 4);
        assert(lines[1].startsWith('c,'));
        assert(lines[2].startsWith('e,'));
        assert(lines[3].startsWith('f,'));
    });

    test('should return header only if kinds is an empty array', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-1', kinds: [] };
        const expected = 'id,clientId,accountId,contactId,campaignId,occurredAt,kind,sourceId';
        assert.equal(exportEvidenceCsv(FIXTURES, filter), expected);
    });

    test('should sort by occurredAt, then by id', () => {
        const filter: EvidenceExportFilter = { clientId: 'client-1' };
        const result = exportEvidenceCsv(FIXTURES, filter);
        const lines = result.split('\r\n');
        assert.equal(lines.length, 6);
        assert(lines[1].startsWith('b,client-1,')); // 10:00, id 'b'
        assert(lines[2].startsWith('c,client-1,')); // 10:00, id 'c'
        assert(lines[3].startsWith('d,client-1,')); // 11:00, id 'd'
        assert(lines[4].startsWith('e,client-1,')); // 12:00, id 'e'
        assert(lines[5].startsWith('f,client-1,')); // 12:00, id 'f'
    });

    test('should not modify the original input array', () => {
        const originalRows = JSON.parse(JSON.stringify(FIXTURES));
        const frozenRows = deepFreeze([...originalRows]);
        exportEvidenceCsv(frozenRows, { clientId: 'client-1' });
        assert.deepStrictEqual(originalRows, frozenRows, 'Input array should remain unchanged');
    });

    describe('Input Validation', () => {
        test('throws if filter is invalid', () => {
            assert.throws(() => exportEvidenceCsv(FIXTURES, null as any), { message: 'Filter must be a valid object.' });
            assert.throws(() => exportEvidenceCsv(FIXTURES, {} as any), { message: "Filter must include a non-empty 'clientId' string." });
            assert.throws(() => exportEvidenceCsv(FIXTURES, { clientId: '' }), { message: "Filter must include a non-empty 'clientId' string." });
        });

        test('throws on invalid date strings', () => {
            const baseFilter: EvidenceExportFilter = { clientId: 'client-1' };
            assert.throws(() => exportEvidenceCsv(FIXTURES, { ...baseFilter, fromInclusive: '2023-01-15' }), { message: "Filter's 'fromInclusive' must be a valid ISO 8601 date-time string with timezone." });
            assert.throws(() => exportEvidenceCsv(FIXTURES, { ...baseFilter, toExclusive: 'not-a-date' }), { message: "Filter's 'toExclusive' must be a valid ISO 8601 date-time string with timezone." });
            assert.throws(() => exportEvidenceCsv(FIXTURES, { ...baseFilter, fromInclusive: '2023-02-30T10:00:00Z' }), { message: "Filter's 'fromInclusive' is not a valid calendar date." });
        });

        test('throws if time range is invalid', () => {
            assert.throws(() => exportEvidenceCsv(FIXTURES, { clientId: 'client-1', fromInclusive: '2023-01-16T00:00:00Z', toExclusive: '2023-01-15T00:00:00Z' }), { message: "Filter's 'fromInclusive' must not be after 'toExclusive'." });
        });

        test('throws on invalid kinds array', () => {
            assert.throws(() => exportEvidenceCsv(FIXTURES, { clientId: 'client-1', kinds: ['sent', 'invalid-kind'] as any }), { message: "Filter's 'kinds' contains an invalid value." });
            assert.throws(() => exportEvidenceCsv(FIXTURES, { clientId: 'client-1', kinds: 'sent' as any }), { message: "Filter's 'kinds' must be an array of strings." });
        });

        test('throws on malformed input rows', () => {
            const malformed: any[] = [{ ...FIXTURES[0], id: '' }];
            assert.throws(() => exportEvidenceCsv(malformed, { clientId: 'client-1' }), { message: 'Input row at index 0 is malformed.' });
        });
    });

    describe('CSV Quoting and Escaping', () => {
        const specialCharRow: readonly EvidenceExportRow[] = deepFreeze([
            { id: 'q1', clientId: 'c1', accountId: 'val,with,comma', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's1' },
            { id: 'q2', clientId: 'c1', accountId: 'val"with"quote', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's2' },
            { id: 'q3', clientId: 'c1', accountId: 'val\nwith\nnewline', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's3' },
            { id: 'q4', clientId: 'c1', accountId: '=formula', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's4' },
            { id: 'q5', clientId: 'c1', accountId: '  +start', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's5' },
            { id: 'q6', clientId: 'c1', accountId: '@mention', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's6' },
            { id: 'q7', clientId: 'c1', accountId: '\t-tabbed', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's7' },
            { id: 'q8', clientId: 'c1', accountId: 'safe', contactId: null, campaignId: null, occurredAt: '2023-01-01T00:00:00Z', kind: 'sent', sourceId: 's8' },
        ]);

        test('should correctly quote and escape special characters and formulas', () => {
            const result = exportEvidenceCsv(specialCharRow, { clientId: 'c1' });
            const lines = result.split('\r\n');

            assert.equal(lines.length, 9);
            assert.equal(lines[1], 'q1,c1,"val,with,comma",,,2023-01-01T00:00:00Z,sent,s1');
            assert.equal(lines[2], 'q2,c1,"val""with""quote",,,2023-01-01T00:00:00Z,sent,s2');
            assert.equal(lines[3], 'q3,c1,"val\nwith\nnewline",,,2023-01-01T00:00:00Z,sent,s3');
            assert.equal(lines[4], 'q4,c1,\'=formula,,,2023-01-01T00:00:00Z,sent,s4');
            assert.equal(lines[5], 'q5,c1,\'  +start,,,2023-01-01T00:00:00Z,sent,s5');
            assert.equal(lines[6], 'q6,c1,\'@mention,,,2023-01-01T00:00:00Z,sent,s6');
            assert.equal(lines[7], 'q7,c1,\'\t-tabbed,,,2023-01-01T00:00:00Z,sent,s7');
            assert.equal(lines[8], 'q8,c1,safe,,,2023-01-01T00:00:00Z,sent,s8');
        });
    });
});

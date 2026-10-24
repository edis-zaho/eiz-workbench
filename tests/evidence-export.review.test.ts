import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportEvidenceCsv, type EvidenceExportRow } from '../core/evidence-export';

// Independent acceptance cases authored by Work before accepting the model proposal.
const time = '2026-09-01T12:00:00.000Z';
const header = 'id,clientId,accountId,contactId,campaignId,occurredAt,kind,sourceId';
const row: EvidenceExportRow = { id:'row',clientId:'client',accountId:'account',contactId:'contact',campaignId:'campaign',occurredAt:time,kind:'reply',sourceId:'source' };
const filter = Object.freeze({ clientId:'client' });

test('review: normalized evidence and duplicates survive; another client cannot enter export',()=>{
  const first = Object.freeze({...row,kind:'unknown' as const});
  const foreign = Object.freeze({...row,id:'foreign',clientId:'other'});
  const rows = Object.freeze([first,foreign,first]);
  const expected = `row,client,account,contact,campaign,${time},unknown,source`;
  assert.equal(exportEvidenceCsv(rows,filter),`${header}\r\n${expected}\r\n${expected}`);
});

test('review: spreadsheet protection applies to control characters, not only formulas',()=>{
  const vectors = [
    ['\tplain', "'\tplain"],
    [' \nplain', '"\' \nplain"'],
    ['\rplain', '"\'\rplain"'],
    ['  =1+1', "'  =1+1"],
    ['+42', "'+42"],
    ['-42', "'-42"],
    ['@x', "'@x"],
    ['safe,"quoted"\nline', '"safe,""quoted""\nline"'],
  ];
  for(const [sourceId,expected] of vectors) {
    assert.equal(exportEvidenceCsv([{...row,sourceId}],filter),`${header}\r\nrow,client,account,contact,campaign,${time},reply,${expected}`);
  }
});

test('review: UTC and offset timestamps compare as instants; range end is exclusive',()=>{
  const rows = [
    {...row,id:'z',occurredAt:'2026-09-01T14:00:00+02:00'},
    {...row,id:'A'},
    {...row,id:'before',occurredAt:'2026-09-01T11:59:59.999Z'},
    {...row,id:'end',occurredAt:'2026-09-01T12:00:00.001Z'},
  ];
  const csv=exportEvidenceCsv(rows,{...filter,fromInclusive:time,toExclusive:'2026-09-01T12:00:00.001Z'});
  assert.deepEqual(csv.split('\r\n').slice(1).map(line=>line.split(',')[0]),['A','z']);
  assert.ok(csv.includes('2026-09-01T14:00:00+02:00'));
  assert.equal(exportEvidenceCsv(rows,{...filter,fromInclusive:time,toExclusive:time}),header);
});

test('review: malformed dates, unknown kinds and empty time filters fail explicitly',()=>{
  for(const occurredAt of ['2026-02-30T12:00:00Z','2026-09-01','09/01/2026','2026-09-01T24:00:00Z','2026-09-01T12:00:00+25:00']) {
    assert.throws(()=>exportEvidenceCsv([{...row,occurredAt}],filter));
  }
  assert.throws(()=>exportEvidenceCsv([{...row,kind:'automatic'}] as unknown as EvidenceExportRow[],filter));
  assert.throws(()=>exportEvidenceCsv([row],{...filter,fromInclusive:''}));
  assert.equal(exportEvidenceCsv([row],{...filter,kinds:[]}),header);
});

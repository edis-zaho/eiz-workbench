import {test} from 'node:test';
import assert from 'node:assert/strict';
import {experimentCompanySignals} from '../core/experiment-company-signals';
import {experimentResponses} from '../core/experiment-responses';
const now='2024-01-10T00:00:00.000Z';
const mail=(eventId='first',acceptedAt='2024-01-01T00:00:00.000Z',accountId='company')=>({eventId,mailId:eventId,hypothesisId:'arm',contactId:eventId,accountId,acceptedAt});
type Row=Parameters<typeof experimentCompanySignals>[2][number];
const row=(id:string,at='2024-01-02T00:00:00.000Z',eventId='first',patch:Partial<Row>={}):Row=>({id,eventId,recordedAt:'2024-01-09T00:00:00.000Z',origin:'operator_import',source:{provider:'synthetic',stream:'one'},withdrawn:false,signal:{externalId:id,kind:'open',occurredAt:at,capturedAt:at,flags:[],linkId:null},...patch});
const calc=(mails=[mail()],rows:Row[]=[],coverage:Parameters<typeof experimentCompanySignals>[3]=new Map())=>experimentCompanySignals(experimentResponses(['arm','empty'],mails,[],now,7),mails,rows,coverage,now);

test('company signal windows count late stakeholder messages without waiting for another message window',()=>{
 const mails=[mail(),mail('late','2024-01-07T00:00:00.000Z'),mail('after','2024-01-08T00:00:00.000Z')];
 const r=calc(mails,[row('start','2024-01-01T00:00:00.000Z'),row('late-ok','2024-01-07T23:59:59.999Z','late'),row('end','2024-01-08T00:00:00.000Z','late'),row('before-own','2024-01-06T23:59:59.999Z','late'),row('after','2024-01-08T01:00:00.000Z','after')]),a=r.arms[0];
 assert.equal(a.contactedCompanies,1);assert.equal(a.messagesInWindow,2);assert.equal(a.observedCompanies,1);assert.equal(a.observedMessages,2);assert.equal(a.opens,2);assert.equal(a.excludedSignals,3);assert.ok(r.observations.filter(o=>o.status==='excluded').every(o=>o.reason));assert.equal(r.arms[1].matureCompanies,0);
});

test('company repeated opens require distinct times in one unflagged message and source',()=>{
 const first=row('a'),same=row('duplicate-time'),second=row('b','2024-01-03T00:00:00.000Z'),third=row('c','2024-01-04T00:00:00.000Z'),flagged={...third,id:'flagged',signal:{...third.signal,flags:['proxy'] as Row['signal']['flags']}};
 assert.equal(calc([mail()],[first,same,second,flagged]).arms[0].repeatedOpenCompanies,0);
 assert.equal(calc([mail()],[first,second,{...third,source:{provider:'synthetic',stream:'other'}}]).arms[0].repeatedOpenCompanies,0);
 const click={...third,id:'click',origin:'relay_pull' as const,signal:{...third.signal,kind:'click' as const,linkId:'private-link'}};
 const a=calc([mail()],[first,same,second,third,flagged,click]).arms[0];assert.equal(a.repeatedOpenCompanies,1);assert.equal(a.observedCompanies,1);assert.equal(a.openCompanies,1);assert.equal(a.clickCompanies,1);assert.equal(a.flaggedSignals,1);assert.equal(a.relaySignals,1);assert.equal(a.importedSignals,5);
 assert.equal(calc([mail()],[first,second,{...third,withdrawn:true}]).arms[0].repeatedOpenCompanies,0);
});

test('company registration coverage keeps absence, expiry and click capability separate',()=>{
 const mails=[mail(),mail('late','2024-01-07T00:00:00.000Z'),mail('missing')],coverage=new Map([['first',{click:true,expiresAt:Date.parse('2024-01-08T00:00:00.000Z')}],['late',{click:false,expiresAt:Date.parse('2024-01-07T23:59:59.999Z')}]]) ;
 const a=calc(mails,[row('one')],coverage).arms[0];assert.equal(a.messagesInWindow,3);assert.equal(a.registeredMessages,2);assert.equal(a.registeredWithoutSignal,1);assert.equal(a.withoutRegistration,1);assert.equal(a.expiresBeforeWindowEnd,1);assert.equal(a.clickEnabledMessages,1);
});

test('immature, invalid and future-recorded evidence does not enter company counts; withdrawals and input remain visible',()=>{
 const mails=[mail(),mail('recent','2024-01-09T00:00:00.000Z','recent'),mail('invalid','invalid','invalid')],rows=[row('future-record',undefined,undefined,{recordedAt:'2024-01-11T00:00:00.000Z'}),row('future-capture'),row('withdrawn',undefined,undefined,{withdrawn:true}),row('recent','2024-01-09T01:00:00.000Z','recent'),row('invalid',undefined,'invalid')];rows[1].signal.capturedAt='2024-01-11T00:00:00.000Z';const saved=structuredClone({mails,rows});
 const a=calc(mails,rows).arms[0];assert.equal(a.matureCompanies,1);assert.equal(a.pendingCompanies,1);assert.equal(a.invalidTimeCompanies,1);assert.equal(a.withdrawnSignals,1);assert.equal(a.excludedSignals,4);assert.equal(a.observedCompanies,0);assert.deepEqual({mails,rows},saved);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {experimentResponses} from '../core/experiment-responses';
import {experimentMeetings} from '../core/experiment-meetings';
import type {MeetingContent} from '../core/meeting-input';
const now='2024-02-01T00:00:00.000Z';
const mail=(accountId='company',contactId='person',acceptedAt='2024-01-01T00:00:00.000Z')=>({eventId:accountId+contactId,mailId:accountId+contactId,accountId,contactId,hypothesisId:'arm',acceptedAt});
const meeting=(meetingId:string,scheduledAt='2024-01-03T00:00:00.000Z',status:MeetingContent['status']='booked')=>({meetingId,revisionId:'revision-'+meetingId,revision:1,eventId:'source-'+meetingId,hypothesisId:'arm',accountId:'company',contactId:'person',status,scheduledAt,observedAt:'2024-01-10T00:00:00.000Z',withdrawn:false});
const calculate=(meetings:ReturnType<typeof meeting>[],mails=[mail()],at=now)=>experimentMeetings(experimentResponses(['arm','empty'],mails,[],at,7),mails,meetings,at);

test('meeting windows separate confirmed, cancelled, no-show and unresolved attendance; rates deduplicate companies',()=>{
 const r=calculate([meeting('one',undefined,'held_confirmed'),meeting('two',undefined,'held_confirmed'),meeting('cancelled',undefined,'cancelled'),meeting('no-show',undefined,'no_show'),meeting('booked'),meeting('shifted',undefined,'rescheduled'),meeting('unverified',undefined,'held_unverified')],[mail(),mail('no-meeting')]),a=r.arms[0];
 assert.equal(a.recordedMeetings,7);assert.equal(a.meetingCompanies,1);assert.equal(a.heldConfirmedMeetings,2);assert.equal(a.heldConfirmedCompanies,1);assert.equal(a.cancelledMeetings,1);assert.equal(a.noShowMeetings,1);assert.equal(a.attendanceUnverifiedMeetings,3);assert.deepEqual(a.heldConfirmedRate,{numerator:1,denominator:2,percent:50});assert.equal(r.arms[1].meetingRate.percent,null);
});

test('meeting interval includes start, excludes end and requires confirmed contact before both appointment and observation',()=>{
 const r=calculate([meeting('start','2024-01-01T00:00:00.000Z'),meeting('last','2024-01-07T23:59:59.999Z'),meeting('end','2024-01-08T00:00:00.000Z'),meeting('before','2023-12-31T23:59:59.999Z'),{...meeting('early-observation'),observedAt:'2023-12-31T23:59:59.999Z'},{...meeting('future-observation'),observedAt:'2099-01-01T00:00:00.000Z'}]);
 assert.equal(r.arms[0].recordedMeetings,2);assert.equal(r.arms[0].excludedMeetings,4);assert.deepEqual(r.observations.filter(o=>o.counted).map(o=>o.meetingId),['start','last']);assert.ok(r.observations.filter(o=>!o.counted).every(o=>o.reason));
});

test('pending and invalid company windows cannot enter meeting rates and missing contact cannot borrow another stakeholder',()=>{
 const r=calculate([{...meeting('pending'),accountId:'recent',scheduledAt:'2024-01-30T00:00:00.000Z',observedAt:'2024-01-30T00:00:00.000Z'},{...meeting('invalid'),accountId:'invalid'},{...meeting('missing-person'),contactId:'other'},{...meeting('missing-company'),accountId:'absent'}],[mail(),mail('recent','person','2024-01-28T00:00:00.000Z'),mail('invalid','person','invalid')]);
 assert.equal(r.arms[0].matureCompanies,1);assert.equal(r.arms[0].pendingCompanies,1);assert.equal(r.arms[0].invalidTimeCompanies,1);assert.equal(r.arms[0].excludedMeetings,4);assert.equal(r.arms[0].heldConfirmedRate.denominator,1);assert.equal(r.arms[0].recordedMeetings,0);
});

test('withdrawal never counts as attendance and shifting latest appointment time changes membership without mutating source',()=>{
 const old=meeting('same',undefined,'held_confirmed'),before=structuredClone(old);assert.equal(calculate([old]).arms[0].heldConfirmedMeetings,1);
 const moved={...old,revision:2,revisionId:'next',status:'rescheduled' as const,scheduledAt:'2024-01-10T00:00:00.000Z'};assert.equal(calculate([moved]).arms[0].excludedMeetings,1);
 const withdrawn=calculate([{...old,withdrawn:true}]).arms[0];assert.equal(withdrawn.withdrawnMeetings,1);assert.equal(withdrawn.recordedMeetings,0);assert.equal(withdrawn.heldConfirmedCompanies,0);assert.deepEqual(old,before);
});

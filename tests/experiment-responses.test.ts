import {test} from 'node:test';
import assert from 'node:assert/strict';
import {experimentResponses} from '../core/experiment-responses';
const mail=(accountId='company',contactId='person',acceptedAt='2024-01-01T00:00:00.000Z',hypothesisId='arm')=>({eventId:accountId+contactId+acceptedAt,mailId:accountId+contactId+acceptedAt,accountId,contactId,hypothesisId,acceptedAt});
const assessment={id:'assessment',revision:1,origin:'human',replyType:'interest',meetingIntent:'yes',withdrawn:false,requiresHumanReview:false};
const reply=(eventId:string,occurredAt:string,contactId='person',accountId='company')=>({eventId,occurredAt,contactId,accountId,hypothesisId:'arm',assessment});
const now='2024-02-01T00:00:00.000Z';

test('company response windows include start, exclude end, and do not restart on later stakeholders or follow-ups',()=>{
 const mails=[mail(),mail('company','person','2024-01-05T00:00:00.000Z'),mail('company','second','2024-01-06T00:00:00.000Z')];
 const replies=[reply('start','2024-01-01T00:00:00.000Z'),reply('early-person','2024-01-05T23:59:59.999Z','second'),reply('late-person','2024-01-06T00:00:00.000Z','second'),reply('last','2024-01-07T23:59:59.999Z'),reply('end','2024-01-08T00:00:00.000Z'),reply('missing-person','2024-01-02T00:00:00.000Z','absent')];
 const r=experimentResponses(['arm'],mails,replies,now,7),a=r.arms[0];assert.equal(a.matureCompanies,1);assert.equal(a.incomingMessages,3);assert.equal(a.excludedMessages,3);assert.equal(a.positiveCompanies,1);assert.deepEqual(a.positiveRate,{numerator:1,denominator:1,percent:100});assert.equal(r.companies[0].windowEndsAt,'2024-01-08T00:00:00.000Z');
 assert.deepEqual(r.observations.filter(o=>o.counted).map(o=>o.eventId),['start','late-person','last']);
});

test('unfinished company windows are not negative results and maturity starts exactly at the boundary',()=>{
 const mails=[mail(),mail('recent','person','2024-01-28T00:00:00.000Z')],r=experimentResponses(['arm','empty'],mails,[reply('recent','2024-01-29T00:00:00.000Z','person','recent')],now,7);
 assert.equal(r.arms[0].contactedCompanies,2);assert.equal(r.arms[0].matureCompanies,1);assert.equal(r.arms[0].pendingCompanies,1);assert.equal(r.arms[0].humanReplyRate.denominator,1);assert.equal(r.arms[0].incomingMessages,0);assert.equal(r.arms[1].humanReplyRate.percent,null);
 assert.equal(experimentResponses(['arm'],[mail()],[],'2024-01-07T23:59:59.999Z',7).arms[0].pendingCompanies,1);
 assert.equal(experimentResponses(['arm'],[mail()],[],'2024-01-08T00:00:00.000Z',7).arms[0].matureCompanies,1);
});

test('uncertain company anchors and replies without confirmed contact are explicitly excluded',()=>{
 const r=experimentResponses(['arm'],[mail(),mail('bad','p','not-a-date'),mail('future','p','2099-01-01T00:00:00.000Z')],[reply('before','2023-12-31T23:59:59.999Z'),reply('unknown','2024-01-02T00:00:00.000Z','p','unknown'),reply('bad','2024-01-02T00:00:00.000Z','p','bad'),reply('invalid-time','not-a-date')],now,7);
 assert.equal(r.arms[0].invalidTimeCompanies,2);assert.equal(r.arms[0].matureCompanies,1);assert.equal(r.arms[0].excludedMessages,4);assert.ok(r.observations.every(o=>!o.counted&&o.reason));
 assert.throws(()=>experimentResponses(['arm'],[],[],now,8));assert.throws(()=>experimentResponses(['arm'],[],[],'invalid',7));
});

test('human outcomes stay separate from model estimates, automatic responses, withdrawals and open review',()=>{
 const base=reply('human','2024-01-02T00:00:00.000Z');
 for(const change of [{origin:'model'},{withdrawn:true},{requiresHumanReview:true},{replyType:'unclear'},{replyType:'automatic'},{replyType:'out_of_office'}]){
  const r=experimentResponses(['arm'],[mail()],[{...base,assessment:{...assessment,...change}}],now,7).arms[0];assert.equal(r.humanReplyCompanies,0);assert.equal(r.positiveCompanies,0);assert.equal(r.meetingIntentCompanies,0);assert.equal(r.incomingMessages,1);
  assert.equal(r.modelPositiveCompanies,change.origin==='model'?1:0);assert.equal(r.automaticMessages,['automatic','out_of_office'].includes(change.replyType||'')?1:0);
 }
 const multi=experimentResponses(['arm'],[mail(),mail('second')],[base,reply('again','2024-01-03T00:00:00.000Z')],now,7).arms[0];assert.equal(multi.incomingMessages,2);assert.deepEqual(multi.positiveRate,{numerator:1,denominator:2,percent:50});
});

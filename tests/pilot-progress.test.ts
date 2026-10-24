import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as readiness from '../src/pilot-readiness';

const now=Date.parse('2026-10-12T12:00:00Z');
function evaluate(overrides:Record<string,unknown>={}) {
  assert.ok('pilotProgress' in readiness,'Pilot overview must derive the saved preparation state');
  return (readiness as any).pilotProgress({clientId:'a',clientVersion:2,paused:false,now,snapshot:{clientId:'a',clientVersion:2,checkedAt:now,briefApproved:true,contactCount:3,campaign:{id:'campaign-a',approved:true,problemCount:0,fingerprint:'current'},runs:[]},...overrides});
}
const snapshot=(extra:Record<string,unknown>={})=>({clientId:'a',clientVersion:2,checkedAt:now,briefApproved:true,contactCount:3,campaign:{id:'campaign-a',approved:true,problemCount:0,fingerprint:'current'},runs:[],...extra});
const run=(extra:Record<string,unknown>={})=>({clientId:'a',campaignId:'campaign-a',fingerprint:'current',status:'prepared',snapshot:{mode:'rehearsal'},counts:[],...extra});

test('pilot progress reports missing setup without claiming permission to send',()=>{
  const result=evaluate({snapshot:snapshot({briefApproved:false,contactCount:0,campaign:null})});
  assert.equal(result.next,'brief');
  assert.equal(result.steps.find((s:any)=>s.id==='brief').state,'open');
  assert.equal(result.steps.find((s:any)=>s.id==='leads').state,'open');
  assert.equal(result.steps.find((s:any)=>s.id==='campaigns').state,'open');
  assert.equal(evaluate().steps.find((s:any)=>s.id==='queue').state,'open');
});

test('stale, future, failed and foreign preparation snapshots cannot stay checked',()=>{
  for(const s of [undefined,snapshot({checkedAt:now-60000}),snapshot({checkedAt:now+1}),snapshot({clientId:'b'}),snapshot({clientVersion:1})]){
    const result=evaluate({snapshot:s});
    assert.equal(result.fresh,false);
    assert.ok(result.steps.every((step:any)=>step.state==='unknown'));
    assert.equal(result.next,'reload');
  }
});

test('completed simulation remains distinct from an active live run',()=>{
  const simulated=evaluate({snapshot:snapshot({runs:[run({status:'completed',counts:[{status:'simulated',count:3}]})]})});
  assert.equal(simulated.steps.find((s:any)=>s.id==='queue').state,'simulation');
  const live=evaluate({snapshot:snapshot({runs:[run({status:'active',snapshot:{mode:'live'}})]})});
  assert.equal(live.steps.find((s:any)=>s.id==='queue').state,'live');
  assert.equal(live.next,'journal');
  assert.equal(evaluate({paused:true,snapshot:snapshot({runs:[run({status:'active',snapshot:{mode:'live'}})]})}).next,'client');
});

test('run status belongs to the chosen campaign and current plan fingerprint',()=>{
  for(const r of [run({clientId:'b'}),run({campaignId:'campaign-b'})]){
    assert.equal(evaluate({snapshot:snapshot({runs:[r]})}).steps.find((s:any)=>s.id==='queue').state,'open');
  }
  const old=evaluate({snapshot:snapshot({runs:[run({fingerprint:'old',status:'active',snapshot:{mode:'live'}})]})});
  assert.equal(old.steps.find((s:any)=>s.id==='queue').state,'attention');
  assert.equal(old.next,'campaigns');
  const invalid=evaluate({snapshot:snapshot({campaign:{id:'campaign-a',approved:true,problemCount:1,fingerprint:'current'}})});
  assert.equal(invalid.steps.find((s:any)=>s.id==='campaigns').state,'open');
});

test('uncertain sends in another campaign of this customer take precedence over setup',()=>{
  const r=run({campaignId:'campaign-b',counts:[{status:'unknown',count:1}]});
  assert.equal(evaluate({snapshot:snapshot({runs:[r]})}).steps.find((s:any)=>s.id==='queue').state,'attention');
  assert.equal(evaluate({snapshot:snapshot({runs:[r]})}).next,'campaigns');
  assert.equal(evaluate({snapshot:snapshot({runs:[{...r,clientId:'b'}]})}).steps.find((s:any)=>s.id==='queue').state,'open');
});

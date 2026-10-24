import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createModelDispatcher}=require('../electron/model-dispatch.cjs');
const {bindingHash}=require('../electron/model-endpoint.cjs');
test('lost local completion never repeats external call, credentials follow permit',async()=>{
 let calls=0,secretReads=0;const binding={hash:'binding'};
 const run={id:'one',clientId:'client',purpose:'analysis',binding,context:'public',contextHash:bindingHash({context:'public'})};
 const request=async(p:string)=>{if(p.includes('model-setup'))return {binding,quote:{}};if(p.endsWith('authorize'))return {binding};throw Error('lost completion');};
 const dispatch=createModelDispatcher({request,vault:{key:(b:any)=>{assert.equal(b,binding);secretReads++;return 'synthetic';}},confirm:async()=>true,transport:async()=>{calls++;return {status:'completed',text:'ok',usage:{inputTokens:1}};}});
 await assert.rejects(dispatch(run),/lost completion/);assert.equal(calls,1);assert.equal(secretReads,1);
});
test('cancelled exact transfer performs no fetch and no key read',async()=>{
 let reads=0,fetches=0;
 const run={id:'one',clientId:'client',purpose:'analysis',binding:{hash:'same'},prompt:{system:'s',user:'u'},contextHash:bindingHash({prompt:{system:'s',user:'u'}})};
 const dispatch=createModelDispatcher({request:async(p:string)=>p.includes('model-setup')?{binding:run.binding,quote:{}}:{},vault:{key:()=>{reads++;}},confirm:async()=>false,transport:async()=>{fetches++;}});
 await assert.rejects(dispatch(run),/abgebrochen/);assert.equal(reads,0);assert.equal(fetches,0);
});
test('missing bound credential releases reservation before authorization or network',async()=>{
 const events:string[]=[],run={id:'one',clientId:'client',purpose:'analysis',binding:{hash:'same'},context:'public',contextHash:bindingHash({context:'public'})};
 const dispatch=createModelDispatcher({
  request:async(path:string,body:any)=>{if(path.includes('model-setup'))return {binding:run.binding};if(path.endsWith('authorize'))events.push('authorize');if(path.endsWith('finish'))events.push(body.state);return {binding:run.binding};},
  vault:{key:()=>{throw Error('Key unavailable');}},confirm:async()=>true,
  transport:async()=>{events.push('network');}
 });
 await assert.rejects(dispatch(run),/Key unavailable/);
 assert.deepEqual(events,['not-started']);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {dispatchOutbound}=createRequire(import.meta.url)('../electron/outbound.cjs');
function fixture(options:{claimLost?:boolean;stop?:boolean;sendError?:any;finishLost?:boolean;wrongMailbox?:boolean}={}){
 let locked=false,locks=0,sends=0;const finishes:any[]=[],calls:string[]=[];
 const google={
  async withMailbox(_:string,fn:any){locks++;locked=true;try{return await fn({id:options.wrongMailbox?'other':'mailbox',email:'me@example.com',accessToken:'test-token'});}finally{locked=false;}},
  async sendOnce(mail:any,token:string){assert.equal(locked,true);assert.equal(mail.id,'item');assert.equal(token,'test-token');sends++;if(options.sendError)throw options.sendError;return {providerId:'google-id'};},
 };
 async function request(path:string,body:any){assert.equal(locked,true);calls.push(path);
  if(path.endsWith('/claim-send')){assert.deepEqual(body,{mailboxId:'mailbox',sender:'me@example.com'});if(options.claimLost)throw Error('Reservierungsantwort verloren');return {id:'item',runRevision:4};}
  if(path.endsWith('/authorize-send')){assert.equal(body.revision,4);if(options.stop)throw Error('Notstopp');return {allowed:true};}
  finishes.push(body);if(options.finishLost)throw Error('Speicherantwort verloren');return {};
 }
 return {run:()=>dispatchOutbound({google,request,row:{clientId:'client',runId:'run',mailboxId:'mailbox'}}),get sends(){return sends;},get locks(){return locks;},finishes,calls};
}
test('Desktop dispatcher holds one mailbox lease through final decision, send and persistence',async()=>{
 const f=fixture();assert.deepEqual(await f.run(),{status:'sent',saved:true});assert.equal(f.sends,1);assert.equal(f.locks,1);assert.deepEqual(f.calls.map(p=>p.split('/').at(-1)),['claim-send','authorize-send','finish-send']);
});
test('Wrong mailbox and lost reservation response cannot reach Gmail',async()=>{
 for(const options of [{wrongMailbox:true},{claimLost:true}]){const f=fixture(options);await assert.rejects(f.run());assert.equal(f.sends,0);assert.equal(f.finishes.length,0);}
});
test('Stop accepted before the final decision prevents Gmail call',async()=>{
 const f=fixture({stop:true});assert.equal((await f.run()).status,'failed');assert.equal(f.sends,0);assert.match(f.finishes[0].result,/Vor Gmail angehalten/);
});
test('Accepted Gmail send followed by local failure stays unknown; never a resend or failed send',async()=>{
 const f=fixture({finishLost:true});assert.deepEqual(await f.run(),{status:'unknown',saved:false});assert.equal(f.sends,1);assert.deepEqual(f.finishes.map(r=>r.status),['sent','unknown']);
});
test('Only an explicit provider rejection is failed; unexpected transport errors are unknown',async()=>{
 for(const [error,status] of [[Object.assign(Error('Google rejected'),{kind:'failed'}),'failed'],[Error('socket reset'),'unknown'],[Object.assign(Error('timeout'),{kind:'unknown'}),'unknown']] as const){const f=fixture({sendError:error});assert.equal((await f.run()).status,status);assert.equal(f.sends,1);assert.equal(f.finishes[0].status,status);}
});

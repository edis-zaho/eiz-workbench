import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createGmailProvider}=createRequire(import.meta.url)('../electron/gmail-provider.cjs');
function fixture(){
  let connected=true,read=false,stops=0,revoke=false;
  const mailbox={id:'connection-1',email:'owner@example.test',checkedAt:'2026-10-20T10:00:00Z',accessToken:'secret',scopes:['https://www.googleapis.com/auth/gmail.send']};
  const google={
    status:()=>({configured:true,busy:false,mailbox:connected?{id:mailbox.id,email:mailbox.email,checkedAt:mailbox.checkedAt,readAccess:read,sendAccess:true}:null}),
    withMailbox:async(_:string,fn:any)=>{if(!connected)throw Error('Disconnected');return fn(mailbox);},
    disconnect:()=>{connected=false;},
    revoke:async()=>{connected=false;if(!revoke)throw Error('Revocation failed');return {localDisconnected:true,remoteRevoked:true};},
    sendOnce:async(mail:any,token:string)=>{assert.equal(token,'secret');return {providerId:mail.messageId};},
    readConversation:async()=>({messages:[]}),readThreadContext:async()=>({}),findSent:async()=>({found:false}),
  };
  const provider=createGmailProvider({google,stop:async()=>{stops++;}}).provider;
  return {provider,setRead:()=>{read=true;},setRevoke:()=>{revoke=true;},stops:()=>stops};
}
test('mail status distinguishes read grant and sync evidence and exposes no token',async()=>{
 const f=fixture(),status=f.provider.status('client');
 assert.equal(status.granted.read,false);assert.equal(status.readiness,'needs-auth');
 assert.equal(status.identity.email,'owner@example.test');assert.ok(!JSON.stringify(status).includes('secret'));
 f.setRead();assert.equal(f.provider.status('client').readiness,'needs-read-check');
 const result=await f.provider.withSession('client',async(s:any)=>{assert.equal('accessToken' in s,false);return s.sendOnce({messageId:'rfc-id'});});
 assert.equal(result.providerId,'rfc-id');
});
test('failed remote revocation still removes local authority and stops work',async()=>{
 const f=fixture();const r=await f.provider.disconnect('client','revoke');
 assert.deepEqual(r,{localDisconnected:true,remoteRevoked:false});assert.equal(f.stops(),1);
 assert.equal(f.provider.status('client').readiness,'disconnected');
 const g=fixture();assert.deepEqual(await g.provider.disconnect('client','local'),{localDisconnected:true,remoteRevoked:null});
 const h=fixture();h.setRevoke();assert.deepEqual(await h.provider.disconnect('client','revoke'),{localDisconnected:true,remoteRevoked:true});
});

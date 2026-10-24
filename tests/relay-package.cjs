const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createServer}=require('node:net');
const {mkdtempSync,writeFileSync,mkdirSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const root=resolve(__dirname,'..'),key=()=>randomBytes(32).toString('hex');
async function main(){
 mkdirSync(join(root,'qa'),{recursive:true});const dir=mkdtempSync(join(root,'qa','relay-package-')),file=join(dir,'config.json'),database=join(dir,'relay.sqlite'),snapshot=join(dir,'snapshot.sqlite');
 const scope={stream:randomUUID(),writeKey:key(),readKey:key(),clickHosts:['example.com']};writeFileSync(file,JSON.stringify({version:1,scopes:[scope]}),{mode:0o600});
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const env={...process.env,EIZ_RELAY_CONFIG:file,EIZ_RELAY_DATABASE:database,EIZ_RELAY_PORT:String(port),EIZ_RELAY_HOST:'127.0.0.1'};delete env.EIZ_RELAY_SNAPSHOT;
 const bundle=process.argv[2]?resolve(process.argv[2]):join(root,'output','relay-build','run.cjs');let child,logs='';
 function start(extra={},args=[]){const p=spawn(process.execPath,[bundle,...args],{cwd:dir,env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>{logs+=b;});p.stderr.on('data',b=>{logs+=b;});return p;}
 async function ready(p){for(let i=0;i<100;i++){if(p.exitCode!==null)throw Error('Relay exited before ready');try{const r=await fetch(`http://127.0.0.1:${port}/v1/status`,{headers:{Authorization:'Bearer '+scope.readKey},signal:AbortSignal.timeout(200)});if(r.ok)return await r.json();}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Relay startup timeout');}
 async function stop(p){if(p.exitCode===null){const done=new Promise(r=>p.once('exit',r));p.kill();await done;}}
 async function exited(p){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(Error('Relay helper timeout'));},15000);p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('exit',code=>{clearTimeout(timer);resolve(code);});});}
 try{
  child=start();const first=await ready(child);const token=key(),registration={token,messageRef:randomUUID(),kind:'open',linkId:null,target:null,expiresAt:new Date(Date.now()+86400000).toISOString()};let r=await fetch(`http://127.0.0.1:${port}/v1/register`,{method:'POST',headers:{Authorization:'Bearer '+scope.writeKey,'Content-Type':'application/json'},body:JSON.stringify(registration)});assert.equal(r.status,200);
  r=await fetch(`http://127.0.0.1:${port}/o/${token}.gif`);assert.equal(r.status,200);assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,6).toString(),'GIF89a');await stop(child);
  child=start();const second=await ready(child);assert.equal(second.instanceId,first.instanceId);assert.equal(second.observations,1);await stop(child);
  child=start({EIZ_RELAY_SNAPSHOT:snapshot});assert.equal(await exited(child),0);
  child=start({EIZ_RELAY_DATABASE:snapshot});const restored=await ready(child);assert.equal(restored.observations,1);assert.equal(restored.instanceId,first.instanceId);await stop(child);
  const recovered=join(dir,'recovered.sqlite');child=start({},['--restore',snapshot,recovered]);assert.equal(await exited(child),0);child=start({EIZ_RELAY_DATABASE:recovered});const recovery=await ready(child);assert.notEqual(recovery.instanceId,first.instanceId);assert.equal(recovery.observations,1);await stop(child);
  const generated=join(dir,'generated.json');child=start({},['--init',generated,'example.com']);assert.equal(await exited(child),0);const created=JSON.parse(require('node:fs').readFileSync(generated,'utf8'));assert.match(created.scopes[0].readKey,/^[a-f0-9]{64}$/);assert.notEqual(created.scopes[0].readKey,created.scopes[0].writeKey);assert.ok(!logs.includes(created.scopes[0].readKey));writeFileSync(generated,JSON.stringify({syntheticCredentialsRemoved:true}));
  writeFileSync(file,'{"secret":"'+scope.writeKey+'", broken');child=start();assert.equal(await exited(child),1);assert.ok(logs.includes('Configuration is not valid JSON'));
  for(const s of [scope.readKey,scope.writeKey,token])assert.ok(!logs.includes(s),'No access or URL tokens in logs');
  // Synthetic access keys are discarded, even in the retained QA directory.
  writeFileSync(file,JSON.stringify({syntheticCredentialsRemoved:true}));
  const proof={passed:true,bundle,cliPixel:true,restartPreservesObservation:true,snapshotReopened:true,recoveryRotatesInstance:true,privateConfigurationGenerator:true,sanitizedStartupFailure:true,noCredentialLogs:true,liveProvider:false,at:new Date().toISOString()};writeFileSync(join(dir,'result.json'),JSON.stringify(proof,null,2)+'\n');console.log('RELAY_PACKAGE_PASSED '+dir);
 }finally{if(child)await stop(child);writeFileSync(file,JSON.stringify({syntheticCredentialsRemoved:true}));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

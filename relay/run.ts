import {readFileSync,statSync,writeFileSync,renameSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {resolve} from 'node:path';
import {scopes,RelayError,uuid} from './contract';
import {RelayStore} from './store';
import {startRelay} from './server';
async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw new RelayError(500,'Node.js 24 or newer required');
 if(process.argv[2]==='--init'){
  const destination=process.argv[3];if(!destination)throw new RelayError(400,'Configuration destination required');const config={version:1,scopes:[{stream:randomUUID(),writeKey:randomBytes(32).toString('hex'),readKey:randomBytes(32).toString('hex'),clickHosts:process.argv.slice(4)}]};scopes(config);writeFileSync(destination,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});console.log('Private relay configuration created; protect this file.');return;
 }
 if(process.argv[2]==='--restore'){
  const from=process.argv[3],to=process.argv[4];if(!from||!to||process.argv.length!==5||resolve(from)===resolve(to))throw new RelayError(400,'Restore requires a snapshot and a separate new destination');
  const temporary=to+'.restore-'+randomUUID();const source=new DatabaseSync(from,{readOnly:true});try{if(source.prepare('PRAGMA user_version').get()!.user_version!==1||source.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||!uuid(source.prepare("SELECT value FROM relay_meta WHERE key='instance'").get()?.value))throw new RelayError(400,'Invalid relay snapshot');writeFileSync(to,'EIZ_RECOVERY_IN_PROGRESS',{flag:'wx',mode:0o600});writeFileSync(temporary,'',{flag:'wx',mode:0o600});await backup(source,temporary);}finally{source.close();}
  const restored=new RelayStore(temporary);try{restored.db.prepare("UPDATE relay_meta SET value=? WHERE key='instance'").run(randomUUID());}finally{restored.close();}renameSync(temporary,to);console.log('Relay restored with a new instance identity. Reconcile and restart consumer cursors explicitly.');return;
 }
 if(process.argv.length>2)throw new RelayError(400,'Unknown relay command');
 const file=process.env.EIZ_RELAY_CONFIG,database=process.env.EIZ_RELAY_DATABASE;if(!file||!database)throw new RelayError(500,'Set EIZ_RELAY_CONFIG and EIZ_RELAY_DATABASE');
 if(resolve(file)===resolve(database))throw new RelayError(500,'Configuration and database must be separate files');
 if(statSync(file).size>1048576)throw new RelayError(500,'Configuration exceeds 1 MiB');let parsed:unknown;try{parsed=JSON.parse(readFileSync(file,'utf8'));}catch{throw new RelayError(500,'Configuration is not valid JSON');}
 const config={version:1 as const,scopes:scopes(parsed)},host=process.env.EIZ_RELAY_HOST||'127.0.0.1',port=Number(process.env.EIZ_RELAY_PORT||8080);
 if(!['127.0.0.1','0.0.0.0'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw new RelayError(500,'Invalid listener configuration');
 const store=new RelayStore(database);
 if(process.env.EIZ_RELAY_SNAPSHOT){try{if(resolve(process.env.EIZ_RELAY_SNAPSHOT)===resolve(database)||resolve(process.env.EIZ_RELAY_SNAPSHOT)===resolve(file))throw new RelayError(500,'Snapshot needs a separate new path');await store.snapshot(process.env.EIZ_RELAY_SNAPSHOT);console.log('Relay snapshot completed');}finally{store.close();}return;}
 const app=await startRelay(store,config,{host,port});console.log(`Relay ready on ${host}:${app.port}; TLS termination required for public use`);
 let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();store.close();};process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
}
main().catch(e=>{const code=typeof e?.code==='string'&&/^[A-Z_]{1,40}$/.test(e.code)?e.code:'UNAVAILABLE';console.error('Relay startup failed: '+(e instanceof RelayError?e.message:code)+'. No credentials are logged.');process.exitCode=1;});

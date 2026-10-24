import { join } from 'node:path';
import {openProfileStore} from './profile';
import { startServer } from './server';

async function main() {
  const data = process.env.EIZ_DATA_DIR, token = process.env.EIZ_LOCAL_TOKEN;
  if (!data || !token) throw new Error('Lokale Startkonfiguration fehlt.');
  const workerToken=process.env.EIZ_WORKER_TOKEN;
  if(!workerToken||workerToken.length<32)throw new Error('Desktop-Dienstkennung fehlt.');
  const channel=process.env.EIZ_APP_CHANNEL;
  if(channel!=='public'&&channel!=='internal')throw new Error('Application channel missing.');
  const parent = (process as any).parentPort;
  const backupKey=channel==='public'?await new Promise<Buffer>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Sicherungsschlüssel fehlt.')),10000);parent?.once('message',(event:any)=>{clearTimeout(timer);const d=event.data;if(d?.type!=='backup-key'||typeof d.key!=='string')return reject(new Error('Startkanal ungültig.'));const key=Buffer.from(d.key,'base64');if(key.length!==32)return reject(new Error('Sicherungsschlüssel ungültig.'));resolve(key);});}):undefined;
  const service = await startServer(openProfileStore(data,channel,backupKey), token,1000,workerToken);
  parent?.postMessage({ type: 'ready', url: service.url });
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await service.close(); process.exit(0); };
  parent?.on('message', (event: any) => { if (event.data === 'stop') void stop(); });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(() => { (process as any).parentPort?.postMessage({ type: 'failed' }); process.exit(1); });

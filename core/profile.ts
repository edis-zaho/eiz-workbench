import {join} from 'node:path';
import {Store} from './store';
export function openProfileStore(directory:string,channel:'public'|'internal',backupKey?:Buffer) {
  if(!['public','internal'].includes(channel))throw new Error('Unknown application channel');
  const store=new Store(join(directory,'revenue.sqlite'),join(directory,'backups'),channel==='internal',backupKey);
  store.publicMode=channel==='public';return store;
}

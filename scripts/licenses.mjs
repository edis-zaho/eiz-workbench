// Inventory installed lockfile packages and preserve their supplied notices.
import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),lock=JSON.parse(readFileSync(join(root,'package-lock.json'))),rows=[];
const output=join(root,'third-party-licenses');mkdirSync(output,{recursive:true});
for(const [path,entry] of Object.entries(lock.packages)){
 if(!path)continue;const dir=join(root,path);if(!existsSync(join(dir,'package.json'))){if(entry.optional)continue;throw Error('Install dependencies first: '+path);}
 const p=JSON.parse(readFileSync(join(dir,'package.json'))),label=(p.name+'-'+p.version).replace(/[^a-zA-Z0-9._-]/g,'_'),notices=[];
 for(const f of readdirSync(dir).filter(f=>/^(licen[cs]e|copying|notice)([.-]|$)/i.test(f))){const src=join(dir,f);if(!lstatSync(src).isFile())continue;const target=label+'/'+f;mkdirSync(join(output,label),{recursive:true});writeFileSync(join(output,target),readFileSync(src));notices.push(target);}
 if(p.name==='electron')for(const f of ['LICENSE','LICENSES.chromium.html']){const src=join(dir,'dist',f);if(!existsSync(src))throw Error('Electron runtime notice missing: '+f);const target=label+'/runtime-'+f;writeFileSync(join(output,target),readFileSync(src));notices.push(target);}
 rows.push({name:p.name,version:p.version,license:p.license||entry.license||'REVIEW REQUIRED',development:!!entry.dev,notices});
}
rows.sort((a,b)=>a.name.localeCompare(b.name));
writeFileSync(join(output,'inventory.json'),JSON.stringify(rows,null,2)+'\n');
writeFileSync(join(root,'THIRD_PARTY_NOTICES.md'),'# Third-party notices\n\nGenerated from the installed lockfile packages. Includes build/test dependencies as well as application dependencies; this is an inventory, not a claim that all are bundled at runtime. Original notices are preserved in third-party-licenses/. Electron runtime notices include Chromium and its bundled components. Dependencies retain their own terms.\n\n| Package | Version | Declared license | Supplied notices |\n|---|---|---|---|\n'+rows.map(r=>`| ${r.name} | ${r.version} | ${String(r.license).replaceAll('|','/')} | ${r.notices.map(n=>`[notice](third-party-licenses/${n})`).join(', ')||'No root-level notice supplied; review package metadata'} |`).join('\n')+'\n');
console.log(JSON.stringify({packages:rows.length,unknown:rows.filter(r=>r.license==='REVIEW REQUIRED').map(r=>r.name),withoutRootNotice:rows.filter(r=>!r.notices.length).map(r=>r.name)}));

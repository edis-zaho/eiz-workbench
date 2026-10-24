import {readdirSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const approved=file=>['LICENSE','THIRD_PARTY_NOTICES.md'].includes(file)||/^third-party-licenses\/[A-Za-z0-9._/-]+$/.test(file)||file==='package.json'||/^dist\/(?:index\.html|assets\/[A-Za-z0-9._-]+\.(?:js|css|svg|png|woff2?))$/.test(file)||
 file==='backend/run.cjs'||/^electron\/(?:[a-z0-9-]+\.cjs|model-adapters\/[a-z0-9-]+\.cjs)$/.test(file)||
 /^assets\/[A-Za-z0-9._-]+\.(?:ico|png|svg)$/.test(file);
export function checkPublicPackage(directory){
 const root=resolve(directory),files=[],violations=[];
 function walk(dir){for(const entry of readdirSync(dir)){const path=join(dir,entry),stat=lstatSync(path),file=relative(root,path).replaceAll('\\','/');
  if(stat.isSymbolicLink()){violations.push('Link: '+file);continue;}
  if(stat.isDirectory()){walk(path);continue;}
  files.push(file);if(!approved(file)){violations.push('Nicht in Auslieferungsliste: '+file);continue;}
  if(/\.(?:cjs|js|json|html|css)$/.test(file)){
   const text=readFileSync(path,'utf8');
   if(/private-owner@example\.invalid|private-recipient@example\.invalid|C:[\\/]Users[\\/]private-user|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|sk-proj-[A-Za-z0-9_-]{24,}/i.test(text))violations.push('Persönliche Daten oder Secret-Muster: '+file);
  }
 }}
 walk(root);
 for(const required of ['package.json','backend/run.cjs','dist/index.html','electron/main.cjs','electron/preload.cjs'])if(!files.includes(required))violations.push('Fehlende Laufzeitdatei: '+required);
 try{const p=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));if(p.workbenchChannel!=='public'||p.main!=='electron/main.cjs')violations.push('Falsche Produktidentität');}catch{violations.push('Paketmanifest ungültig');}
 return {passed:violations.length===0,files,violations};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const r=checkPublicPackage(process.argv[2]);console.log(JSON.stringify(r,null,2));if(!r.passed)process.exitCode=1;
}

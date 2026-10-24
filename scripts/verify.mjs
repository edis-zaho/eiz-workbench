import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=join(root,'qa','verification',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(directory,{recursive:true});
const report={status:'running',liveProvidersUsed:false,checks:[]};
const save=()=>writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2));
function command(name,args){const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});writeFileSync(join(directory,name+'.log'),(r.stdout||'')+(r.stderr||''));report.checks.push({name,passed:r.status===0&&!r.error});save();if(r.status!==0||r.error)throw Error(name+' failed; see '+directory);console.log('PASS '+name);}
try{
 if(Number(process.versions.node.split('.')[0])!==24)throw Error('Use Node 24.x');
 if(JSON.parse(readFileSync(join(root,'package.json'))).workbenchChannel!=='public')throw Error('Expected public channel');
 command('types',['node_modules/typescript/bin/tsc','--noEmit']);
 command('tests',['--import','tsx','--test',...readdirSync(join(root,'tests')).filter(f=>f.endsWith('.test.ts')).sort().map(f=>'tests/'+f)]);
 for(const f of readdirSync(join(root,'electron')).filter(f=>f.endsWith('.cjs')))command('syntax-'+f,['--check','electron/'+f]);
 command('build',['scripts/build.mjs']);command('relay-build',['scripts/build-relay.mjs']);
 command('relay-package',['tests/relay-package.cjs']);command('relay-operations',['--import','tsx','--test','tests/relay-ops.test.mjs']);
 report.status='passed';
}catch(e){report.status='failed';report.error=e.message;console.error(e.message);process.exitCode=1;}finally{save();console.log('Report: '+directory);}

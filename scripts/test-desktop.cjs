const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
mkdirSync(join(root,'qa'),{recursive:true});
const profile = mkdtempSync(join(root,'qa','desktop-'));
const child = spawn(require('electron'), [process.argv.includes('--packaged') ? 'tests/packaged.cjs' : '.'], { cwd:root, env:{...process.env,EIZ_SMOKE_DIR:profile}, stdio:'inherit', windowsHide:true });
// Expanded native/UI acceptance includes automatic analysis and cross-customer workboard.
const timeout = setTimeout(()=>{child.kill();console.error('Desktop test timed out');process.exitCode=1;},120000);
child.on('error',error=>{clearTimeout(timeout);console.error(error);process.exitCode=1;});
child.on('exit',code=>{clearTimeout(timeout);try{const result=JSON.parse(readFileSync(join(profile,'smoke-result.json'),'utf8'));if(code!==0||!result.passed)throw new Error('Desktop test failed');console.log('Isolated profile: '+profile);}catch(error){console.error(error);process.exitCode=1;}});

const {join,resolve,isAbsolute}=require('node:path');
function resolveProfileDirectory({appData,channel,testDirectory,testMode=false}) {
  if(!['public','internal'].includes(channel))throw new Error('Unknown application channel');
  if(typeof appData!=='string'||!isAbsolute(appData))throw new Error('Invalid application data directory');
  if(testDirectory!==undefined){
    if(!testMode||typeof testDirectory!=='string'||!isAbsolute(testDirectory))throw new Error('Explicit absolute test directory required in test mode');
    return resolve(testDirectory);
  }
  return join(appData,channel==='public'?'EiZ Workbench':'EiZ Revenue Workbench Next');
}
module.exports={resolveProfileDirectory};

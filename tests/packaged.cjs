// Exercise the exact archived main, preload, UI and worker from the release.
// Only the test harness (excluded from the product) is supplied externally.
const Module = require('node:module');
const { join } = require('node:path');
const { mkdtempSync } = require('node:fs');
process.env.EIZ_SMOKE_DIR ||= mkdtempSync(join(__dirname,'../qa/packaged-'));
const load = Module._load;
Module._load = function(request,parent,isMain) {
  if(request==='../tests/desktop.cjs' && parent?.filename.includes('app.asar')) return require('./desktop.cjs');
  return load.call(this,request,parent,isMain);
};
require(join(__dirname,'..',require('../package.json').build.directories.output,'win-unpacked/resources/app.asar/electron/main.cjs'));

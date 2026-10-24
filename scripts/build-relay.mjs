import {build} from 'esbuild';
await build({entryPoints:['relay/run.ts'],outfile:'output/relay-build/run.cjs',bundle:true,platform:'node',target:'node24',format:'cjs'});

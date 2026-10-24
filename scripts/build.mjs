import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({ entryPoints: ['core/run.ts'], outfile: 'backend/run.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', define:{EIZ_PUBLIC_BUILD:'true'}, minifySyntax:true });
await viteBuild();

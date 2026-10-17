import { build, context } from 'esbuild';
import { rendererPolicy } from './renderer-policy.mjs';
import { bundleLicenses } from './bundle-licenses.mjs';
const options = { entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs', platform: 'node', mainFields: ['module', 'main'], target: 'es2022', external: ['obsidian', 'electron'], metafile: true, plugins: [rendererPolicy, bundleLicenses], define: { 'process.env.NODE_ENV': JSON.stringify(process.argv.includes('--watch') ? 'development' : 'production') }, sourcemap: process.argv.includes('--watch') ? 'inline' : false, minify: !process.argv.includes('--watch'), logLevel: 'info' };
if (process.argv.includes('--watch')) { const ctx = await context(options); await ctx.watch(); } else await build(options);

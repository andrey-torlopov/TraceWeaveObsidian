import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// TraceWeave never renders script elements or preinitializes executable resources.
// Remove React DOM's unused script support, failing closed if the pinned source changes.
// This is a build transform; installed node_modules and React's other behavior stay intact.
const hashes = {
  production: '8a8147c1cebdb19d82fd11bdb76391be9b20d00edf67cc8e8b30f44e850ce693',
  development: 'c10b5e5ad37ca22c88b58bf4ada9a3b655ab79934c0b5cc6bad26f42c774584f',
};
export function restrictRenderer(source, mode) {
  if (createHash('sha256').update(source).digest('hex') !== hashes[mode]) throw new Error('Review the React DOM script policy before updating the pinned renderer');
  let direct = 0, inline = 0;
  source = source.replace(/\b\w+\.createElement\("script"\)/gu, () => { direct++; return 'rejectTraceWeaveScript()'; });
  source = source.replace(/case "script":\s+nextResource = (?:ownerDocument|nextResource)\.createElement\("div"\);[\s\S]*?nextResource = nextResource\.removeChild\(\s+nextResource\.firstChild\s+\);/gu, () => { inline++; return 'case "script": throw Error("TraceWeave does not allow script elements");'; });
  if (direct !== 3 || inline !== 1) throw new Error(`Unexpected React DOM script branches: ${direct}/${inline}`);
  return source + '\nfunction rejectTraceWeaveScript(){throw Error("TraceWeave does not allow script resources");}\n';
}
export const rendererPolicy = {
  name: 'traceweave-renderer-script-policy',
  setup(build) {
    build.onLoad({ filter: /react-dom[\\/]cjs[\\/]react-dom-client\.(production|development)\.js$/ }, async ({ path }) => {
      const mode = path.endsWith('.production.js') ? 'production' : 'development';
      return { contents: restrictRenderer(await readFile(path, 'utf8'), mode), loader: 'js' };
    });
  },
};

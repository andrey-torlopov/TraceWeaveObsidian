import { readFile, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

// Community installations download only three assets. Keep complete license text in main.js.
export const bundleLicenses = {
  name: 'traceweave-bundled-licenses',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length || !result.metafile) return;
      const packages = new Map();
      for (const input of Object.keys(result.metafile.inputs)) {
        const match = input.replaceAll('\\', '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/u);
        if (!match || packages.has(match[1])) continue;
        const folder = match[1], pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
        const files = (await readdir(folder)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(name)).sort();
        if (!files.length) throw new Error(`Bundled dependency has no license file: ${pkg.name}`);
        packages.set(folder, `\n--- ${pkg.name}@${pkg.version} ---\n` + (await Promise.all(files.map(name => readFile(path.join(folder, name), 'utf8')))).join('\n'));
      }
      const notices = await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'UNICODE-LICENSE.txt'].map(name => readFile(name, 'utf8')));
      notices.push(...[...packages].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, text]) => text));
      const license = notices.join('\n');
      if (license.includes('*/')) throw new Error('A bundled notice needs explicit safe comment encoding');
      await appendFile(build.initialOptions.outfile, `\n/*!\nTraceWeave and bundled third-party license notices\n${license}\n*/\n`);
    });
  },
};

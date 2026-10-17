import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version || manifest.id !== 'traceweave') throw new Error('Manifest/package version mismatch');
const target = `release/${manifest.version}`;
await fs.mkdir(target, { recursive: true });
const files = ['main.js', 'manifest.json', 'styles.css', 'README.md', 'README-ru.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'UNICODE-LICENSE.txt', 'CHANGELOG.md'];
async function addDocs(folder) {
  for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.posix.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in release documentation');
    if (entry.isDirectory()) await addDocs(file);
    else if (entry.isFile() && /\.(?:md|png)$/u.test(entry.name)) files.push(file);
    else throw new Error(`Unexpected release documentation: ${file}`);
  }
}
await addDocs('docs');
for (const file of files) { await fs.mkdir(path.dirname(`${target}/${file}`), { recursive: true }); await fs.copyFile(file, `${target}/${file}`); }
const licenseText = [];
const seen = new Set();
async function walk(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const name = path.join(folder, entry.name);
    if (entry.isDirectory() && (entry.name.startsWith('@') || entry.name !== '.bin')) await walk(name);
    else if (entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/iu.test(entry.name)) {
      const text = await fs.readFile(name, 'utf8');
      const hash = createHash('sha256').update(text).digest('hex');
      if (!seen.has(hash)) { seen.add(hash); licenseText.push(`\n--- ${name.replaceAll('\\', '/')} ---\n${text}`); }
    }
  }
}
await walk('node_modules');
await fs.writeFile(`${target}/DEPENDENCY_LICENSES.txt`, licenseText.join('\n'));
files.push('DEPENDENCY_LICENSES.txt');
const checksums = [];
for (const file of files) { const hash = createHash('sha256'); for await (const chunk of createReadStream(`${target}/${file}`)) hash.update(chunk); checksums.push(`${hash.digest('hex')}  ${file}`); }
await fs.writeFile(`${target}/SHA256SUMS`, checksums.join('\n') + '\n'); files.push('SHA256SUMS');
const zip = new yazl.ZipFile();
for (const file of files) zip.addFile(`${target}/${file}`, `traceweave/${file}`, { mtime: new Date('2026-10-16T00:00:00Z'), mode: 0o644 });
zip.end();
await pipeline(zip.outputStream, createWriteStream(`release/traceweave-${manifest.version}.zip`));
console.log(`Ready: release/traceweave-${manifest.version}.zip; GitHub assets: ${target}/main.js, manifest.json, styles.css`);

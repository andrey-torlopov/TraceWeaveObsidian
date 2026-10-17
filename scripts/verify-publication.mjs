import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const extra = process.argv.slice(2).flatMap(value => value === '--package' ? ['main.js', `release/${manifest.version}/DEPENDENCY_LICENSES.txt`] : [value]);
const filenames = [...new Set([...tracked, ...extra])];
const failures = [];
const localPaths = [/\/(?:Users|Volumes|home)\/[A-Za-z0-9_][^\s"'`<>]*/gu, /\/(?:private\/)?var\/folders\/[^\s"'`<>]+/gu, /[A-Z]:\\Users\\[^\s"'`<>]+/gu];
const sensitiveNames = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|\.npmrc|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/u;
for (const relative of filenames) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some(part => part === '..')) throw new Error('Expected repository-relative verification paths');
  if (/^(?:var|node_modules|\.git|\.obsidian|\.twdata|TWData|_TraceWeave)\//u.test(relative) || sensitiveNames.test(relative)) failures.push(`${relative}: private/runtime filename`);
  const filename = path.join(root, relative), stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) { failures.push(`${relative}: only regular files may be published`); continue; }
  const bytes = await fs.readFile(filename);
  if (bytes.includes(0)) continue;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const pattern of localPaths) if (new RegExp(pattern).test(source)) failures.push(`${relative}: machine-specific path`);
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u.test(source)) failures.push(`${relative}: private key`);
  if (!relative.endsWith('.md')) continue;
  const text = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, '');
  const links = [...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/gu)].map(match => match[1] ?? match[2]);
  links.push(...[...text.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)="([^"]+)"/gu)].map(match => match[1]));
  for (const destination of links) {
    if (!destination || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/iu.test(destination)) continue;
    const target = decodeURIComponent(destination.split(/[?#]/u)[0]);
    if (!target) continue;
    try { await fs.access(path.resolve(path.dirname(filename), target)); }
    catch { failures.push(`${relative}: missing local documentation link ${target}`); }
  }
}
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const versions = JSON.parse(await fs.readFile('versions.json', 'utf8'));
if (manifest.version !== pkg.version || manifest.version !== lock.version || manifest.version !== lock.packages[''].version || versions[manifest.version] !== manifest.minAppVersion) failures.push('Release versions/minAppVersion disagree');
if (!pkg.license || pkg.license === 'UNLICENSED' || (await fs.readFile('LICENSE', 'utf8')).trim().length < 100) failures.push('An explicit publication license is required');
if (manifest.id !== 'traceweave' || !manifest.isDesktopOnly) failures.push('Unexpected plugin ID/platform');
if (failures.length) throw new Error('Publication checks failed:\n' + failures.join('\n'));
console.log(`PASS: ${filenames.length} publication files, local documentation links, machine-path guard, license and version alignment. Run Gitleaks separately for credential detection.`);

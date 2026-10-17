import * as fs from 'node:fs/promises';
import path from 'node:path';
const arg = process.argv.indexOf('--vault');
const input = arg >= 0 ? process.argv[arg + 1] : undefined;
if (!input || !path.isAbsolute(input)) throw new Error('Usage: npm run install:local -- --vault /absolute/path/to/test-vault [--config .obsidian]');
const vault = await fs.realpath(input);
const configArg = process.argv.indexOf('--config');
const config = configArg >= 0 ? process.argv[configArg + 1] : '.obsidian';
if (!config || !/^\.[a-zA-Z0-9._-]+$/u.test(config)) throw new Error('Config directory must be a dot-prefixed directory name');
const configPath = path.join(vault, config);
const stat = await fs.lstat(configPath);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Selected vault must already have a real Obsidian config directory');
const target = path.join(configPath, 'plugins', 'traceweave');
for (const segment of [path.join(configPath, 'plugins'), target]) {
  try { if ((await fs.lstat(segment)).isSymbolicLink()) throw new Error('Symlink plugin directories are not supported by installer'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await fs.mkdir(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(file, path.join(target, file));
console.log(`Installed locally: ${target}. Enable TraceWeave in Community plugins. Existing vault settings and data were not changed.`);

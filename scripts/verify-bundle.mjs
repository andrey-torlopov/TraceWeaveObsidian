import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url);
const module = { exports: {} };
const requests = [];
class Plugin {} class PluginSettingTab {} class ItemView {}
const context = vm.createContext({ module, exports: module.exports, require: (id) => {
  requests.push(id);
  if (id === 'obsidian') return { Plugin, PluginSettingTab, ItemView, FileSystemAdapter: class {}, Notice: class {}, Setting: class {}, TFile: class {}, Platform: { isDesktopApp: true } };
  if (id === 'electron') return { shell: { showItemInFolder() {} } };
  if (!isBuiltin(id)) throw new Error(`Unbundled runtime dependency: ${id}`);
  return require(id);
}, console, process, Buffer, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal, structuredClone, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance });
const define = () => { throw new Error('AMD dependency leaked into plugin bundle'); }; define.amd = true; context.define = define;
vm.runInContext(await readFile('main.js', 'utf8'), context, { timeout: 10_000, filename: 'main.js' });
if (typeof module.exports.default !== 'function' || !(module.exports.default.prototype instanceof Plugin)) throw new Error('Plugin default export is invalid');
console.log('PASS: assembled main.js loads standalone with only Obsidian, Electron and Node built-ins; no node_modules or AMD requires.');

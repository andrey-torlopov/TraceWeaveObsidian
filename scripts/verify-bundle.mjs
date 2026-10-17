import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
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
}, console, process, Buffer, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal, structuredClone, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance }, { codeGeneration: { strings: false, wasm: false } });
const define = () => { throw new Error('AMD dependency leaked into plugin bundle'); }; define.amd = true; context.define = define;
const source = await readFile('main.js', 'utf8');
const syntax = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const inspect = node => {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') throw new Error('Runtime code generation is forbidden');
  if (ts.isCallExpression(node)) {
    const call = node.expression;
    if (ts.isIdentifier(call) && call.text === 'eval') throw new Error('Runtime eval is forbidden');
    if (ts.isPropertyAccessExpression(call) && ['createElement', 'createElementNS'].includes(call.name.text) && node.arguments.some(argument => ts.isStringLiteral(argument) && argument.text.toLowerCase() === 'script')) throw new Error('Runtime script creation is forbidden');
  }
  ts.forEachChild(node, inspect);
};
inspect(syntax);
vm.runInContext(source, context, { timeout: 10_000, filename: 'main.js' });
if (typeof module.exports.default !== 'function' || !(module.exports.default.prototype instanceof Plugin)) throw new Error('Plugin default export is invalid');
console.log('PASS: main.js loads standalone with string code generation disabled; no runtime compiler, eval, script creation, unbundled dependencies or AMD requires.');

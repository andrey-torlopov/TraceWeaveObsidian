import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { rendererPolicy, restrictRenderer } from '../scripts/renderer-policy.mjs';

test('renderer policy rejects an unreviewed dependency revision', () => {
  assert.throws(() => restrictRenderer('changed renderer', 'production'), /Review the React DOM/);
});
test('both pinned renderer modes remove script creation and keep their license', async () => {
  for (const mode of ['production', 'development'] as const) {
    const source = await readFile(new URL(`../node_modules/react-dom/cjs/react-dom-client.${mode}.js`, import.meta.url), 'utf8');
    const restricted = restrictRenderer(source, mode);
    assert.match(restricted, /Copyright \(c\) Meta Platforms/);
    assert.doesNotMatch(restricted, /createElement\("script"\)|innerHTML = "<script>/);
  }
});
test('production renderer mounts ordinary content and rejects scripts and executable preloads', async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync,preinit,preinitModule} from 'react-dom';
    const errors=[];
    const root=createRoot(document.getElementById('root'),{onUncaughtError:error=>errors.push(error.message)});
    export const render=tag=>flushSync(()=>root.render(React.createElement(tag,null,'ordinary content')));
    export const stop=()=>flushSync(()=>root.unmount());
    export {preinit,preinitModule,errors};
  `, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'cjs', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [rendererPolicy] });
  const window = new Window({ url: 'http://traceweave.test' });
  window.document.body.innerHTML = '<div id="root"></div>';
  const context = vm.createContext({ module: { exports: {} }, window, document: window.document, navigator: window.navigator, console, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), performance }, { codeGeneration: { strings: false, wasm: false } });
  context.exports = context.module.exports;
  vm.runInContext(result.outputFiles[0].text, context);
  const renderer = context.module.exports as { render(tag: string): void; stop(): void; preinit(src: string, options: { as: string }): void; preinitModule(src: string): void; errors: string[] };
  try {
    renderer.render('p');
    assert.equal(window.document.querySelector('p')?.textContent, 'ordinary content');
    renderer.render('script');
    assert.ok(renderer.errors.some(error => /does not allow script/.test(error)));
    assert.throws(() => renderer.preinit('https://example.invalid/never.js', { as: 'script' }), /does not allow script/);
    assert.throws(() => renderer.preinitModule('https://example.invalid/never.mjs'), /does not allow script/);
    assert.equal(window.document.querySelector('script'), null);
  } finally { renderer.stop(); await window.happyDOM.close(); }
});

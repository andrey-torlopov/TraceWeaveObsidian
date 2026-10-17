import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act } from 'react';
import { applyCommands, createProject } from '../src/domain';
import { setLocale } from '../src/i18n';
import type { Command, Project, ViewState, WorkbenchService, WorkbenchSnapshot } from '../src/types';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const timestamp = '2026-10-17T10:00:00.000Z';

async function fixture(context: TestContext) {
  const window = new Window({ url: 'http://traceweave-i18n.test' }), document = window.document;
  const dimensions = { width: 1280, height: 900 };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get() { return 245; } }, offsetHeight: { configurable: true, get() { return 112; } },
    clientWidth: { configurable: true, get() { return dimensions.width; } }, clientHeight: { configurable: true, get() { return dimensions.height; } },
    getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: dimensions.width, bottom: dimensions.height, ...dimensions, toJSON() { return this; } }) },
  });
  class ResizeObserverMock {
    constructor(private readonly callback: (entries: { target: Element; contentRect: typeof dimensions }[]) => void) {}
    observe(target: Element) { this.callback([{ target, contentRect: dimensions }]); }
    unobserve() {} disconnect() {}
  }
  const globals: Record<string, unknown> = { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement, MutationObserver: window.MutationObserver, ResizeObserver: ResizeObserverMock, DOMMatrixReadOnly: window.DOMMatrixReadOnly, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  setLocale('en');
  const initial = createProject('Lighthouse archive', id(1), timestamp);
  const type = initial.nodeTypes.find(type => type.code === 'evidence')!;
  const project = applyCommands(initial, [
    { kind: 'node.create', id: id(10), title: 'Archive map', typeId: type.id, notePath: 'Archive/Map.md', x: 30, y: 30 },
    { kind: 'node.update', nodeId: id(10), changes: { assessment: 'hypothesis', confidence: 'high', attributes: [{ id: id(20), key: 'Survey date', valueType: 'date', value: { value: '1924', precision: 'year' }, sortOrder: 0 }] } },
    { kind: 'node.create', id: id(11), title: 'Working conclusion', notePath: 'Archive/Conclusion.md', x: 400, y: 100 },
    { kind: 'relation.create', relation: { id: id(30), sourceNodeId: id(10), targetNodeId: id(11), relationType: 'related', label: 'Supports dating', directed: true, bidirectional: false, assessment: 'hypothesis', confidence: 'medium', noteMarkdown: 'Check the original date.', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: timestamp, updatedAt: timestamp, origin: {} } },
    { kind: 'asset.register', blob: { id: id(40), path: 'Исследования/Вложения/inventory.zip', sha256: 'a'.repeat(64), byteSize: 4096, mimeType: 'application/zip', mediaKind: 'file' }, asset: { id: id(41), blobId: id(40), originalName: 'inventory.zip', title: 'Archive inventory', mimeType: 'application/zip', mediaKind: 'file', byteSize: 4096, sha256: 'a'.repeat(64), createdAt: timestamp, deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: 'Synthetic archive.', origin: {} } },
  ], timestamp);
  let state: WorkbenchSnapshot = { projects: [{ id: project.id, title: project.title, status: project.status, revision: project.revision }], project, busy: false, message: '', error: null, canUndo: false, canRedo: false, progress: null };
  const listeners = new Set<() => void>(), commands: Command[] = [], opened: string[] = [], drafts: Record<string, unknown> = {};
  let view: Partial<ViewState> = { mode: 'graph', selectedId: id(10), viewport: { x: 50, y: 50, zoom: 1 } };
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected action outside the localization test.'); };
  const publish = (changes: Partial<WorkbenchSnapshot>) => { state = { ...state, ...changes }; listeners.forEach(listener => listener()); };
  const service: WorkbenchService = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => state,
    createProject: unsupported, openProject: unsupported, createGroup: unsupported, createNote: unsupported, adoptNote: unsupported, relinkNote: unsupported,
    execute: async batch => { commands.push(...batch); publish({ project: applyCommands(state.project as Project, batch, timestamp) }); },
    openNote: async nodeId => { opened.push(nodeId); }, readNote: async () => '# Archive source\n\nA synthetic note used to verify the research workflow.',
    listNotes: () => [{ title: 'Map', path: 'Archive/Map.md' }, { title: 'Conclusion', path: 'Archive/Conclusion.md' }],
    resolveVaultLink: async () => null, openVaultLink: unsupported, importFiles: unsupported, cancelImport: () => { throw new Error('Unexpected import cancellation.'); },
    discoverResources: async () => [], registerResource: unsupported, resourceUrl: assetId => `app://local/${assetId}`, showAsset: unsupported,
    verifyAssets: async () => [{ assetId: id(41), status: 'ok' }], search: async query => state.project!.nodes.filter(node => node.title.toLowerCase().includes(query.toLowerCase())).map(node => ({ nodeId: node.id, field: 'title', snippet: node.title })), createReport: unsupported, openReport: unsupported,
    exportProject: unsupported, exportTraceWeave: unsupported, importArchive: unsupported, undo: unsupported, redo: unsupported, recover: unsupported,
    loadDrafts: async () => ({ ...drafts }), saveDraft: async (key, value) => { if (value === null) delete drafts[key]; else drafts[key] = value; },
    loadView: async () => view, saveView: async value => { view = value; },
  };
  const container = document.createElement('div'); document.body.append(container);
  const { mountWorkbench, flushWorkbenchDrafts } = await import('../src/ui');
  let unmount: (() => void) | null = null;
  const settle = () => act(async () => { await window.happyDOM.waitUntilComplete(); });
  const mount = async () => { await act(async () => { unmount = mountWorkbench(container as unknown as HTMLElement, service); }); await settle(); };
  const button = (name: string) => { const result = [...container.querySelectorAll('button')].find(button => button.textContent === name || button.getAttribute('aria-label') === name || button.firstChild?.textContent === name); assert.ok(result, `Button exists: ${name}`); return result; };
  const click = async (name: string) => { await act(async () => { button(name).click(); }); await settle(); };
  context.after(async () => { await act(async () => { unmount?.(); await flushWorkbenchDrafts(service); }); await window.happyDOM.abort(); for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); setLocale('ru'); });
  await mount();
  const switchLanguage = async (locale: 'ru' | 'en') => { await act(async () => { setLocale(locale); }); await settle(); };
  const input = async (element: InstanceType<typeof window.HTMLInputElement>, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    }); await settle();
  };
  return { window, document, container, commands, opened, service, state: () => state, button, click, settle, switchLanguage, input };
}

test('English graph, node metadata and a live Russian switch preserve research data', async context => {
  const ui = await fixture(context), before = JSON.stringify(ui.state().project);
  assert.ok(ui.container.querySelector('[aria-label="Current research"]'));
  assert.ok(ui.container.querySelector('[aria-label="Zoom in"]'));
  assert.ok(ui.container.querySelector('[title="Fit graph"]'));
  assert.match(ui.container.querySelector('.tw-graph-card')!.textContent!, /Source · Hypothesis/);
  assert.match(ui.container.querySelector('.tw-inspector')!.textContent!, /Confidence: High/);
  assert.match(ui.container.querySelector('.tw-inspector')!.textContent!, /1924 \(year\)/);
  assert.equal(ui.container.querySelectorAll('.react-flow__edge-path[style*="stroke-dasharray"]').length, 1);
  await ui.click('Open note'); assert.deepEqual(ui.opened, [id(10)]);
  await ui.click('Edit Archive map');
  const dialog = ui.container.querySelector('[role="dialog"][aria-label="Document metadata"]'); assert.ok(dialog);
  assert.match(dialog.textContent!, /Assessment/); assert.match(dialog.textContent!, /Hypothesis/); assert.match(dialog.textContent!, /Typed attributes/);
  assert.ok(dialog.querySelector('button[type="submit"]')!.textContent!.includes('Save metadata'));
  await ui.click('Cancel');
  assert.equal(JSON.stringify(ui.state().project), before); assert.deepEqual(ui.commands, []);
  const mountedRoot = ui.container.firstElementChild, mountedGraphCard = ui.container.querySelector('.tw-graph-card');
  await ui.switchLanguage('ru');
  assert.equal(ui.container.firstElementChild, mountedRoot);
  assert.equal(ui.container.querySelector('.tw-graph-card'), mountedGraphCard);
  assert.ok(ui.container.querySelector('[aria-label="Текущее исследование"]'));
  assert.ok(ui.container.querySelector('[aria-label="Приблизить"]'));
  assert.match(ui.container.querySelector('.tw-graph-card')!.textContent!, /Материал · Гипотеза/);
  assert.match(ui.container.querySelector('.tw-inspector')!.textContent!, /Уверенность: Высокая/);
  assert.equal(JSON.stringify(ui.state().project), before); assert.deepEqual(ui.commands, []);
});

test('live locale changes preserve dossier layout, search, filters, open drafts and material selection', async context => {
  const ui = await fixture(context), before = JSON.stringify(ui.state().project);
  await ui.click('Dossier'); await ui.click('Cards');
  const search = ui.container.querySelector('input[type="search"]'); assert.ok(search instanceof ui.window.HTMLInputElement);
  await ui.input(search, 'Archive');
  const typeFilter = ui.container.querySelector('[aria-label="Filter by type"]'); assert.ok(typeFilter instanceof ui.window.HTMLSelectElement);
  const typeId = ui.state().project!.nodeTypes.find(type => type.code === 'evidence')!.id;
  await act(async () => { typeFilter.value = typeId; typeFilter.dispatchEvent(new ui.window.Event('change', { bubbles: true })); }); await ui.settle();
  const dossier = ui.container.querySelector('.tw-dossier'); assert.ok(dossier);
  await ui.switchLanguage('ru');
  assert.equal(ui.container.querySelector('.tw-dossier'), dossier);
  assert.ok(ui.container.querySelector('.tw-dossier-cards')); assert.equal(ui.container.querySelectorAll('.tw-dossier-item').length, 1);
  assert.equal(ui.container.querySelector('input[type="search"]'), search); assert.equal(search.value, 'Archive');
  assert.equal(typeFilter.value, typeId); assert.equal(typeFilter.getAttribute('aria-label'), 'Фильтр по типу');
  await ui.click('Метаданные');
  const dialog = ui.container.querySelector('[role="dialog"]'); assert.ok(dialog);
  const title = dialog.querySelector('input'); assert.ok(title instanceof ui.window.HTMLInputElement);
  await ui.input(title, 'Unsaved title in the same editor');
  await ui.switchLanguage('en');
  assert.equal(ui.container.querySelector('[role="dialog"]'), dialog);
  assert.equal(dialog.getAttribute('aria-label'), 'Document metadata');
  assert.equal(dialog.querySelector('input'), title); assert.equal(title.value, 'Unsaved title in the same editor');
  assert.equal(JSON.stringify(ui.state().project), before); assert.deepEqual(ui.commands, []);
  await ui.click('Cancel'); await ui.click('Discard changes');
  await ui.click('Materials');
  const material = [...ui.container.querySelectorAll('button')].find(button => button.closest('.tw-file-list') && button.textContent!.includes('Archive inventory')); assert.ok(material);
  await act(async () => { material.click(); }); await ui.settle();
  const preview = ui.container.querySelector('.tw-material-preview'); assert.ok(preview);
  const materialsSearch = ui.container.querySelector('input[aria-label="Search materials"]'); assert.ok(materialsSearch instanceof ui.window.HTMLInputElement);
  await ui.input(materialsSearch, 'inventory');
  await ui.switchLanguage('ru');
  assert.equal(ui.container.querySelector('.tw-material-preview'), preview);
  assert.match(preview.textContent!, /Открыть оригинал/); assert.equal(materialsSearch.value, 'inventory');
  assert.equal(JSON.stringify(ui.state().project), before); assert.deepEqual(ui.commands, []);
});

test('English dossier, materials, archive verification and creation dialogs use real localized components', async context => {
  const ui = await fixture(context), before = JSON.stringify(ui.state().project);
  await ui.click('Dossier'); await ui.click('Cards');
  assert.match(ui.container.querySelector('.tw-dossier')!.textContent!, /Source · Hypothesis/);
  assert.ok(ui.container.querySelector('[aria-label="Dossier sort order"]'));
  await ui.click('+ Relation');
  assert.ok(ui.container.querySelector('[role="dialog"][aria-label="New relation"]'));
  assert.match(ui.container.querySelector('[role="dialog"]')!.textContent!, /Label \(optional\)/);
  assert.match(ui.container.querySelector('[role="dialog"]')!.textContent!, /Bidirectional/);
  await ui.click('Cancel');
  await ui.click('+ Document');
  assert.ok(ui.container.querySelector('[role="dialog"][aria-label="New document"]'));
  assert.match(ui.container.querySelector('[role="dialog"]')!.textContent!, /Document type/);
  await ui.click('Cancel');
  await ui.click('Materials');
  assert.ok(ui.container.querySelector('[aria-label="Search materials"]'));
  const material = [...ui.container.querySelectorAll('button')].find(button => button.closest('.tw-file-list') && button.textContent!.includes('Archive inventory')); assert.ok(material);
  await act(async () => { material.click(); }); await ui.settle();
  assert.match(ui.container.querySelector('.tw-material-preview')!.textContent!, /4.0 KiB/);
  assert.match(ui.container.querySelector('.tw-material-preview')!.textContent!, /This format has no built-in preview/);
  await ui.click('Verify originals');
  assert.match(ui.container.querySelector('.tw-callout')!.textContent!, /Original verified/);
  await ui.click('Scan materials folder');
  assert.ok(ui.container.querySelector('[role="dialog"][aria-label="File library"]'));
  assert.match(ui.container.querySelector('[role="dialog"]')!.textContent!, /No files found/);
  await ui.click('Close dialog');
  assert.equal(JSON.stringify(ui.state().project), before); assert.deepEqual(ui.commands, []);
});

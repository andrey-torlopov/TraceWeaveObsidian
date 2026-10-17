import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import * as locale from '../src/i18n';
import type { SettingDefinitionItem } from 'obsidian';

interface SettingsTab {
  updates: number;
  hides: number;
  renderedDefinitions: SettingDefinitionItem[];
  focusedControl: boolean;
  getSettingDefinitions(): SettingDefinitionItem[];
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): Promise<void>;
  hide(): void;
}

/** Obsidian 1.14.4 preserves a row keyed by control.key while that control contains focus. */
function renderSettingsDefinitions(previous: SettingDefinitionItem[], next: SettingDefinitionItem[], focusedControl: boolean): SettingDefinitionItem[] {
  const key = (item: SettingDefinitionItem) => 'control' in item && item.control ? `ctrl:${item.control.key}` : 'name' in item ? `name:${item.name}` : '';
  const previousRows = new Map(previous.map(item => [key(item), item]));
  return next.map(item => 'control' in item && item.control && focusedControl ? previousRows.get(key(item)) ?? item : item);
}
interface TestView { getDisplayText(): string; onOpen(): Promise<void>; onClose(): Promise<void> }
interface TestService {
  host: { openNote(path: string): Promise<void> };
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}
interface TestPlugin {
  onload(): Promise<void>;
  onunload(): void;
  openWorkbench(): Promise<void>;
  languagePreference: string;
  service: TestService;
  settingTabs: SettingsTab[];
  views: Map<string, (leaf: object) => TestView>;
  commands: Map<string, { checkCallback?: (checking: boolean) => boolean }>;
}

/** Compile only the real host entry. Every imported boundary is a deterministic, in-memory host. */
async function pluginHarness(options: { deferLoad?: boolean; deferInitialize?: boolean; deferView?: boolean; deferSave?: boolean } = {}) {
  const events: string[] = [], notices: string[] = [], timers = new Map<number, () => void>(), cleared: number[] = [];
  const vaultEvents = new Map<string, (...args: unknown[]) => void>();
  let timerId = 0, activeFile: { path: string; extension: string } | null = null;
  let flushFailure: unknown, saveFailure: unknown, storedData: unknown = {};
  let onLayoutReady: (() => void) | undefined;
  let releaseLoad!: () => void, releaseInitialize!: () => void, releaseView!: () => void, releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
  const saving = new Promise<void>(resolve => { releaseSave = resolve; });
  let markViewStarted!: () => void;
  const viewStarted = new Promise<void>(resolve => { markViewStarted = resolve; });
  const loadingData = new Promise<void>(resolve => { releaseLoad = resolve; });
  const initializing = new Promise<void>(resolve => { releaseInitialize = resolve; });
  const openingView = new Promise<void>(resolve => { releaseView = resolve; });
  if (!options.deferLoad) releaseLoad();
  if (!options.deferInitialize) releaseInitialize();
  if (!options.deferView) releaseView();
  if (!options.deferSave) releaseSave();
  let repositoryOptions: { configDir: string } | undefined, linkConfig = '';
  let disposed!: () => void;
  const disposal = new Promise<void>(resolve => { disposed = resolve; });
  const timerWindow = {
    setTimeout: (callback: () => void) => { const id = timerId++; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { cleared.push(id); timers.delete(id); },
  };
  class FileSystemAdapter {
    getBasePath() { return '/synthetic-test-vault'; }
    getResourcePath(relative: string) { return 'app://synthetic/' + relative; }
  }
  const app = {
    vault: {
      adapter: new FileSystemAdapter(), configDir: 'Settings',
      on: (event: string, handler: (...args: unknown[]) => void) => { vaultEvents.set(event, handler); return {}; },
      getFileByPath: () => null, getFolderByPath: () => null, getMarkdownFiles: () => [],
      createFolder: async () => {}, create: async () => {},
    },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: {
      on: () => ({}), onLayoutReady: (callback: () => void) => { onLayoutReady = callback; }, getActiveFile: () => activeFile,
      getLeavesOfType: () => [], openLinkText: async () => { events.push('open-note'); },
      getLeaf: () => ({ openFile: async () => {}, setViewState: async () => { events.push('set-view'); markViewStarted(); await openingView; } }),
      revealLeaf: async () => { events.push('reveal-view'); },
    },
  };
  class Plugin {
    app = app;
    manifest = { name: 'TraceWeave' };
    settingTabs: SettingsTab[] = [];
    views = new Map<string, (leaf: object) => TestView>();
    commands = new Map<string, object>();
    async loadData() { await loadingData; return { language: 'ru', retainedSetting: true }; }
    async saveData(value: unknown) { events.push('save-data'); markSaveStarted(); await saving; if (saveFailure !== undefined) throw saveFailure; storedData = value; }
    registerView(type: string, factory: (leaf: object) => TestView) { this.views.set(type, factory); }
    addRibbonIcon() { return { setAttribute: () => {} }; }
    addCommand(command: { id: string }) { this.commands.set(command.id, command); }
    removeCommand(id: string) { this.commands.delete(id); }
    registerEvent() {}
    addSettingTab(tab: SettingsTab) { this.settingTabs.push(tab); tab.renderedDefinitions = tab.getSettingDefinitions(); }
  }
  class PluginSettingTab {
    updates = 0;
    hides = 0;
    renderedDefinitions: SettingDefinitionItem[] = [];
    focusedControl = false;
    containerEl = { win: timerWindow };
    getSettingDefinitions(): SettingDefinitionItem[] { return []; }
    update() { this.updates++; this.renderedDefinitions = renderSettingsDefinitions(this.renderedDefinitions, this.getSettingDefinitions(), this.focusedControl); }
    hide() { this.hides++; }
  }
  class ItemView {
    contentEl = { addClass: () => {}, empty: () => {} };
  }
  class ProjectRepository {
    constructor(readonly vaultRoot: string, options: { configDir: string }) { repositoryOptions = options; }
  }
  class LocalWorkbench {
    constructor(readonly repository: ProjectRepository, readonly host: TestService['host']) {}
    async initialize() { events.push('initialize'); await initializing; }
    async dispose() { events.push('dispose'); disposed(); }
    refreshLanguage() { events.push('refresh-language'); }
    async onFileChanged() { events.push('file-changed'); }
    async onRenamed() { events.push('file-renamed'); }
    async adoptNote() { events.push('adopt-note'); }
  }
  class VaultLinks {
    constructor(_root: string, _host: object, configDir: string) { linkConfig = configDir; }
  }
  const boundaries: Record<string, unknown> = {
    obsidian: { FileSystemAdapter, getLanguage: () => 'ru', ItemView, Notice: class { constructor(message: string) { notices.push(message); } }, Platform: { isDesktopApp: true }, Plugin, PluginSettingTab, TFile: class {} },
    electron: { shell: { showItemInFolder: () => {} }, webUtils: { getPathForFile: () => '' } },
    './service': { LocalWorkbench }, './storage/repository': { ProjectRepository },
    './storage/files': { resolveSafe: async (_root: string, relative: string) => '/synthetic-test-vault/' + relative },
    './vault-links': { VaultLinks },
    './storage/migration': { getMigratedPath: async () => null, getOriginalPath: async () => null },
    './report-document': { reportDocumentInfo: () => null }, './ui/report': {}, './i18n': locale,
    './ui': {
      mountWorkbench: () => { events.push('mount'); return () => { events.push('unmount'); }; },
      flushWorkbenchDrafts: async () => { events.push('flush-drafts'); if (flushFailure !== undefined) throw flushFailure; },
    },
  };
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'es2022' });
  const module = { exports: {} as { default?: new () => TestPlugin } }, nativeRequire = createRequire(import.meta.url);
  runInNewContext(compiled.code, {
    module, exports: module.exports, Error,
    require: (id: string) => Object.hasOwn(boundaries, id) ? boundaries[id] : nativeRequire(id),
    window: timerWindow,
  });
  assert.ok(module.exports.default);
  const plugin = new module.exports.default();
  const loading = plugin.onload();
  if (!options.deferLoad) await loading;
  return {
    plugin, events, notices, timers, cleared, vaultEvents, disposal, loading, viewStarted, saveStarted,
    releaseLoad, releaseInitialize, releaseView, releaseSave, layoutReady: () => onLayoutReady?.(),
    fireTimers: () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
    repositoryOptions: () => repositoryOptions, linkConfig: () => linkConfig, storedData: () => storedData,
    failFlush: (error: unknown) => { flushFailure = error; }, failSave: (error: unknown) => { saveFailure = error; },
    setActiveFile: (path: string) => { activeFile = { path, extension: 'md' }; },
  };
}

test('declarative plugin settings are searchable, localized and persist only valid language changes', async t => {
  const harness = await pluginHarness();
  t.after(() => locale.setLocale('ru'));
  const tab = harness.plugin.settingTabs[0];
  assert.equal(tab.getSettingDefinitions().length, 6);
  const language = tab.getSettingDefinitions()[0];
  assert.ok('render' in language && typeof language.render === 'function');
  assert.equal('control' in language, false);
  assert.equal(tab.getControlValue('language'), 'ru');
  await tab.setControlValue('language', 'en');
  assert.equal(tab.getControlValue('language'), 'en');
  assert.deepEqual(structuredClone(harness.storedData()), { language: 'en', retainedSetting: true });
  const localizedLanguage = tab.getSettingDefinitions()[0];
  assert.ok('name' in localizedLanguage);
  assert.equal(localizedLanguage.name, 'Interface language');
  assert.equal(tab.updates, 1);
  assert.deepEqual(harness.events, ['flush-drafts', 'save-data', 'refresh-language']);
  await tab.setControlValue('language', 'invalid');
  await tab.setControlValue('unknown-key', 'ru');
  assert.equal(tab.updates, 1);
  assert.deepEqual(harness.notices, []);
});

test('settings keep the confirmed language and refresh controls after a save failure', async t => {
  const harness = await pluginHarness();
  t.after(() => locale.setLocale('ru'));
  harness.failSave(new Error('Synthetic settings disk error'));
  const tab = harness.plugin.settingTabs[0];
  await tab.setControlValue('language', 'en');
  assert.equal(tab.getControlValue('language'), 'ru');
  assert.equal(tab.updates, 1);
  assert.deepEqual(harness.notices, ['Synthetic settings disk error']);
  assert.equal(harness.events.includes('refresh-language'), false);
});

test('settings do not persist a language change when pending drafts cannot be saved', async t => {
  const harness = await pluginHarness();
  t.after(() => locale.setLocale('ru'));
  harness.failFlush(new Error('Synthetic draft disk error'));
  const tab = harness.plugin.settingTabs[0];
  await tab.setControlValue('language', 'en');
  assert.equal(tab.getControlValue('language'), 'ru');
  assert.equal(tab.updates, 1);
  assert.deepEqual(harness.events, ['flush-drafts']);
  assert.deepEqual(harness.notices, ['Synthetic draft disk error']);
});

test('the host model retains focused control rows while public render rows can update', () => {
  const oldControl = { name: 'Old control name', control: { type: 'dropdown' as const, key: 'language', options: { en: 'English' } } };
  const newControl = { ...oldControl, name: 'New control name' };
  assert.equal(renderSettingsDefinitions([oldControl], [newControl], true)[0], oldControl);
  assert.equal(renderSettingsDefinitions([oldControl], [newControl], false)[0], newControl);
  const oldRender = { name: 'Old rendered name', render: () => {} }, newRender = { name: 'New rendered name', render: () => {} };
  assert.equal(renderSettingsDefinitions([oldRender], [newRender], true)[0], newRender);
});

test('the focused language row refreshes names and descriptions in both directions without a deferred task', async t => {
  const harness = await pluginHarness();
  t.after(() => locale.setLocale('ru'));
  const tab = harness.plugin.settingTabs[0];
  tab.focusedControl = true;
  await tab.setControlValue('language', 'en');
  const activeRow = tab.renderedDefinitions[0];
  assert.ok('name' in activeRow && 'desc' in activeRow);
  assert.equal(activeRow.name, 'Interface language');
  assert.match(String(activeRow.desc), /^Automatic follows the Obsidian language/u);
  await tab.setControlValue('language', 'ru');
  const russianRow = tab.renderedDefinitions[0];
  assert.ok('name' in russianRow && 'desc' in russianRow);
  assert.equal(russianRow.name, 'Язык интерфейса');
  assert.match(String(russianRow.desc), /^Автоматически — по языку Obsidian/u);
  assert.equal(tab.updates, 2);
  assert.equal(harness.timers.size, 0);
});

test('language changes leave no deferred settings work after hide or unload', async t => {
  t.after(() => locale.setLocale('ru'));
  for (const action of ['hide', 'unload']) {
    const harness = await pluginHarness(), tab = harness.plugin.settingTabs[0];
    await tab.setControlValue('language', 'en');
    assert.equal(harness.timers.size, 0);
    if (action === 'hide') tab.hide();
    else { harness.plugin.onunload(); await harness.disposal; }
    assert.equal(harness.timers.size, 0);
    harness.fireTimers();
    assert.equal(tab.updates, 1);
    if (action === 'hide') assert.equal(tab.hides, 1);
  }
});

test('a language save finishing after hide or unload never refreshes hidden settings', async t => {
  t.after(() => locale.setLocale('ru'));
  for (const action of ['hide', 'unload']) {
    const harness = await pluginHarness({ deferSave: true }), tab = harness.plugin.settingTabs[0];
    const change = tab.setControlValue('language', 'en');
    await harness.saveStarted;
    if (action === 'hide') tab.hide();
    else harness.plugin.onunload();
    harness.releaseSave();
    await change;
    if (action === 'unload') await harness.disposal;
    assert.equal(tab.updates, 0);
    assert.equal(harness.timers.size, 0);
    assert.deepEqual(harness.notices, []);
  }
});

test('host propagates a custom config directory and prevents opening or adopting its notes', async () => {
  const harness = await pluginHarness();
  assert.equal(harness.repositoryOptions()?.configDir, 'Settings');
  assert.equal(harness.linkConfig(), 'Settings');
  await assert.rejects(harness.plugin.service.host.openNote('settings/private.md'), /служебный файл/i);
  harness.setActiveFile('Settings/private.md');
  assert.equal(harness.plugin.commands.get('adopt-active-note')?.checkCallback?.(true), false);
  harness.setActiveFile('Notes/public.md');
  assert.equal(harness.plugin.commands.get('adopt-active-note')?.checkCallback?.(true), true);
  await harness.plugin.service.host.openNote('Notes/public.md');
  assert.equal(harness.events.includes('open-note'), true);
});

test('vault debounce and plugin unload clear the owning window timers and dispose after flushing', async () => {
  const harness = await pluginHarness();
  const changed = harness.vaultEvents.get('modify'); assert.ok(changed);
  changed({ path: 'Notes/public.md' });
  changed({ path: 'Notes/public.md' });
  changed({ path: 'Settings/private.md' });
  assert.deepEqual(harness.cleared, [0]);
  assert.equal(harness.timers.size, 1);
  harness.plugin.onunload();
  await harness.disposal;
  assert.deepEqual(harness.cleared, [0, 1]);
  assert.equal(harness.timers.size, 0);
  assert.deepEqual(harness.events, ['flush-drafts', 'dispose']);
});

test('workbench leaves unmount their renderer when closed and use the manifest display name', async () => {
  const harness = await pluginHarness();
  const factory = harness.plugin.views.get('traceweave-workbench'); assert.ok(factory);
  const view = factory({});
  assert.equal(view.getDisplayText(), 'TraceWeave');
  await view.onOpen();
  await view.onClose();
  assert.deepEqual(harness.events, ['mount', 'unmount']);
});

test('disabling during settings load prevents late registration of plugin UI and handlers', async () => {
  const harness = await pluginHarness({ deferLoad: true });
  harness.plugin.onunload();
  harness.releaseLoad();
  await harness.loading;
  assert.equal(harness.plugin.views.size, 0);
  assert.equal(harness.plugin.commands.size, 0);
  assert.equal(harness.plugin.settingTabs.length, 0);
  assert.equal(harness.vaultEvents.size, 0);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.notices, []);
});

test('disabling during initialization prevents late creation and reveal of workbench leaves', async () => {
  const harness = await pluginHarness({ deferInitialize: true });
  const opening = harness.plugin.openWorkbench();
  harness.plugin.onunload();
  harness.releaseInitialize();
  await opening;
  await harness.disposal;
  assert.deepEqual(harness.events, ['initialize', 'flush-drafts', 'dispose']);
  assert.deepEqual(harness.notices, []);
});

test('disabling during view setup prevents a late reveal', async () => {
  const harness = await pluginHarness({ deferView: true });
  const opening = harness.plugin.openWorkbench();
  await harness.viewStarted;
  assert.equal(harness.events.includes('set-view'), true);
  harness.plugin.onunload();
  harness.releaseView();
  await opening;
  await harness.disposal;
  assert.equal(harness.events.includes('reveal-view'), false);
  assert.deepEqual(harness.notices, []);
});

test('a retained layout-ready callback does no work and shows no notice after disable', async () => {
  const harness = await pluginHarness();
  harness.plugin.onunload();
  await harness.disposal;
  harness.layoutReady();
  await Promise.resolve();
  assert.deepEqual(harness.events, ['flush-drafts', 'dispose']);
  assert.deepEqual(harness.notices, []);
});

test('file notifications waiting for initialization never enqueue work after disable', async () => {
  const harness = await pluginHarness({ deferInitialize: true });
  harness.vaultEvents.get('rename')?.({ path: 'Notes/new.md' }, 'Notes/old.md');
  harness.vaultEvents.get('modify')?.({ path: 'Notes/new.md' });
  harness.fireTimers();
  harness.setActiveFile('Notes/new.md');
  harness.plugin.commands.get('adopt-active-note')?.checkCallback?.(false);
  harness.plugin.onunload();
  harness.releaseInitialize();
  await harness.disposal;
  assert.deepEqual(harness.events, ['initialize', 'flush-drafts', 'dispose']);
  assert.deepEqual(harness.notices, []);
  harness.vaultEvents.get('modify')?.({ path: 'Notes/late.md' });
  assert.equal(harness.timers.size, 0);
});

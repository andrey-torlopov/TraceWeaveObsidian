import { FileSystemAdapter, ItemView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, type App, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import { LocalWorkbench } from './service';
import { ProjectRepository } from './storage/repository';
import { resolveSafe } from './storage/files';
import { mountWorkbench, flushWorkbenchDrafts } from './ui';
import { VaultLinks } from './vault-links';
import * as path from 'node:path';
import { getMigratedPath, getOriginalPath } from './storage/migration';
import { loadReportDocument, reportDocumentInfo } from './report-document';
import { mountReportPreview } from './ui/report';

const VIEW_TYPE = 'traceweave-workbench';
const REPORT_VIEW_TYPE = 'traceweave-report';
const isTechnicalPath = (relative: string) => relative.split('/').some(part => part.startsWith('.') || ['_traceweave', 'twdata'].includes(part.toLowerCase()));
interface ElectronBridge { shell: { showItemInFolder(path: string): void }; webUtils?: { getPathForFile(file: File): string } }
class TraceWeaveView extends ItemView {
  private unmount: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, readonly service: LocalWorkbench) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'TraceWeave'; }
  getIcon() { return 'git-fork'; }
  async onOpen() { this.contentEl.addClass('tw-obsidian-host'); this.unmount = mountWorkbench(this.contentEl, this.service); }
  async onClose() { this.unmount?.(); this.unmount = null; this.contentEl.empty(); }
}
class TraceWeaveReportView extends ItemView {
  private relative = '';
  private unmount: (() => void) | null = null;
  private generation = 0;
  private closed = false;
  constructor(leaf: WorkspaceLeaf, readonly service: LocalWorkbench, readonly ready: () => Promise<void>, readonly reveal: (relative: string) => Promise<void>) { super(leaf); }
  getViewType() { return REPORT_VIEW_TYPE; }
  getDisplayText() { return 'Снимок TraceWeave'; }
  getIcon() { return 'file-check'; }
  getState() { return { path: this.relative }; }
  async setState(state: unknown, result: ViewStateResult) {
    this.relative = state && typeof state === 'object' && 'path' in state && typeof state.path === 'string' ? state.path : '';
    await this.renderReport();
    result.history = true;
    await super.setState(state, result);
  }
  async onOpen() { this.closed = false; this.contentEl.addClass('tw-obsidian-host'); if (this.relative) await this.renderReport(); }
  async onClose() { this.closed = true; this.generation++; this.unmount?.(); this.unmount = null; this.contentEl.empty(); }
  private async renderReport() {
    const generation = ++this.generation, relative = this.relative;
    this.unmount?.(); this.unmount = null; this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Проверка неизменяемого снимка…' });
    try {
      await this.ready();
      const document = await loadReportDocument(this.service.repository, relative);
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty();
      this.unmount = mountReportPreview(this.contentEl, { ...document, service: this.service });
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: error instanceof Error ? error.message : 'Не удалось открыть снимок.' });
      if (reportDocumentInfo(relative)) this.contentEl.createEl('button', { text: 'Показать файл снимка' }).addEventListener('click', () => {
        void this.reveal(relative).catch(failure => new Notice(failure instanceof Error ? failure.message : 'Файл недоступен.'));
      });
    }
  }
}
class TraceWeaveSettings extends PluginSettingTab {
  constructor(app: App, readonly owner: TraceWeavePlugin) { super(app, owner); }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('Скрытые служебные данные .twdata').setDesc('Связи, история, настройки и снимки находятся в .twdata/. Обычные заметки создаются в Исследования/Заметки, материалы — в Исследования/Вложения. Подключённые заметки из других папок остаются на своих местах.');
    new Setting(this.containerEl).setName('Копирование и синхронизация').setDesc('Файловый backup должен включать скрытую .twdata. Obsidian Sync исключает dot-папки и не переносит служебные данные TraceWeave; одного переноса заметок недостаточно.');
    new Setting(this.containerEl).setName('Обычные заметки vault').setDesc('В исследовании выберите «Подключить заметку из vault» или используйте контекстное меню Markdown-файла. Заметка подключается без копирования и редактируется обычным редактором Obsidian.');
    new Setting(this.containerEl).setName('Просмотр неизвестных типов').setDesc('Список материалов TraceWeave не зависит от настройки Obsidian Show all file types. Для видимости в стандартном проводнике включите её самостоятельно.');
    new Setting(this.containerEl).setName('Режим').setDesc('Локальный desktop, один активный писатель. Текст редактируется в обычном редакторе Obsidian. Облачное одновременное редактирование и внешние хранилища в эту версию не входят.');
  }
}
export default class TraceWeavePlugin extends Plugin {
  service!: LocalWorkbench;
  private ready: Promise<void> | null = null;
  private unloaded = false;
  private eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  async onload() {
    if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice('TraceWeave требует desktop-версию Obsidian.'); return; }
    const adapter = this.app.vault.adapter, root = adapter.getBasePath();
    const electron = require('electron') as ElectronBridge;
    const links = new VaultLinks(root, {
      find: (link, source) => this.app.vault.getFileByPath(path.posix.normalize(path.posix.join(path.posix.dirname(source), link))) ?? this.app.metadataCache.getFirstLinkpathDest(link, source),
      resourceUrl: relative => adapter.getResourcePath(relative),
      open: async (relative, subpath) => {
        if (isTechnicalPath(relative)) throw new Error('Служебный файл не является обычным файлом Obsidian.');
        const file = this.app.vault.getFileByPath(relative);
        if (file && !subpath) await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
        else await this.app.workspace.openLinkText(relative + subpath, '', 'tab');
      },
      reveal: async relative => { electron.shell.showItemInFolder(await resolveSafe(root, relative)); },
      migrated: relative => getMigratedPath(root, relative),
      original: relative => getOriginalPath(root, relative),
    });
    const repo = new ProjectRepository(root, { createNote: async (relative, text) => {
      const parent = relative.slice(0, relative.lastIndexOf('/'));
      if (parent && !this.app.vault.getFolderByPath(parent)) await this.app.vault.createFolder(parent);
      await this.app.vault.create(relative, text);
    } });
    this.service = new LocalWorkbench(repo, {
      listNotes: () => this.app.vault.getMarkdownFiles().map(f => ({ path: f.path, title: f.basename })),
      openNote: async relative => {
        if (reportDocumentInfo(relative)) {
          const leaf = this.app.workspace.getLeaf('tab');
          await leaf.setViewState({ type: REPORT_VIEW_TYPE, active: true, state: { path: relative } });
          await this.app.workspace.revealLeaf(leaf);
          return;
        }
        if (isTechnicalPath(relative)) throw new Error('Служебный файл нельзя открыть как обычную заметку Obsidian.');
        const file = this.app.vault.getFileByPath(relative);
        if (file) await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
        else { await resolveSafe(root, relative); await this.app.workspace.openLinkText(relative, '', 'tab'); }
      },
      resourceUrl: relative => adapter.getResourcePath(relative),
      resolveVaultLink: (source, link) => links.resolve(source, link),
      openVaultLink: (source, link) => links.open(source, link),
      showFile: async relative => { electron.shell.showItemInFolder(await resolveSafe(root, relative)); },
      filePath: async file => {
        const filename = electron.webUtils?.getPathForFile(file) || (file as File & { path?: string }).path;
        if (!filename) throw new Error('Obsidian не предоставил путь к выбранному локальному файлу. Перетащите файл с диска или зарегистрируйте его из папки материалов.');
        return filename;
      },
    });
    this.registerView(VIEW_TYPE, leaf => new TraceWeaveView(leaf, this.service));
    this.registerView(REPORT_VIEW_TYPE, leaf => new TraceWeaveReportView(leaf, this.service, () => this.ensureReady(), async relative => { electron.shell.showItemInFolder(await resolveSafe(root, relative)); }));
    this.addRibbonIcon('git-fork', 'Открыть TraceWeave', () => { void this.openWorkbench(); });
    this.addCommand({ id: 'open-workbench', name: 'Открыть исследование', callback: () => { void this.openWorkbench(); } });
    this.addCommand({ id: 'adopt-active-note', name: 'Подключить текущую заметку к исследованию', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile(); if (!file || file.extension !== 'md' || isTechnicalPath(file.path)) return false;
      if (!checking) void this.ensureReady().then(() => this.service.adoptNote(file.path)).then(() => this.openWorkbench()).catch(error => this.notify(error)); return true;
    } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md' || isTechnicalPath(file.path)) return;
      menu.addItem(item => item.setTitle('Подключить к TraceWeave').setIcon('git-fork').onClick(() => { void this.ensureReady().then(() => this.service.adoptNote(file.path)).then(() => this.openWorkbench()).catch(error => this.notify(error)); }));
    }));
    this.addSettingTab(new TraceWeaveSettings(this.app, this));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (isTechnicalPath(oldPath) || isTechnicalPath(file.path)) return;
      void this.ensureReady().then(() => this.service.onRenamed(file.path, oldPath)).catch(error => this.notify(error));
    }));
    const changed = (file: { path: string }) => {
      if (!file.path.toLowerCase().endsWith('.md') || isTechnicalPath(file.path)) return;
      clearTimeout(this.eventTimers.get(file.path));
      this.eventTimers.set(file.path, setTimeout(() => { this.eventTimers.delete(file.path); void this.ensureReady().then(() => this.service.onFileChanged(file.path)).catch(error => this.notify(error)); }, 400));
    };
    this.registerEvent(this.app.vault.on('modify', changed)); this.registerEvent(this.app.vault.on('delete', changed)); this.registerEvent(this.app.vault.on('create', changed));
    this.app.workspace.onLayoutReady(() => { void this.ensureReady().catch(error => this.notify(error)); });
  }
  private notify(error: unknown) { new Notice(error instanceof Error ? error.message : 'TraceWeave: операция не завершена.', 10_000); }
  private ensureReady() { if (this.unloaded) return Promise.reject(new Error('Плагин закрыт.')); if (!this.ready) this.ready = this.service.initialize(); return this.ready; }
  async openWorkbench() {
    try {
      await this.ensureReady();
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const leaf = existing ?? this.app.workspace.getLeaf('tab');
      if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) { this.notify(error); }
  }
  onunload() {
    this.unloaded = true; this.eventTimers.forEach(clearTimeout); this.eventTimers.clear();
    if (this.service) void (async () => { try { await this.ready; } catch (error) { this.notify(error); } try { await flushWorkbenchDrafts(this.service); } finally { await this.service.dispose(); } })().catch(error => this.notify(error));
  }
}

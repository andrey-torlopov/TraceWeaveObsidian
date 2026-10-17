import { FileSystemAdapter, getLanguage, ItemView, Notice, Platform, Plugin, PluginSettingTab, TFile, type App, type EventRef, type SettingDefinitionItem, type WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import * as electron from 'electron';
import { LocalWorkbench } from './service';
import { ProjectRepository } from './storage/repository';
import { resolveSafe } from './storage/files';
import { mountWorkbench, flushWorkbenchDrafts } from './ui';
import { VaultLinks } from './vault-links';
import * as path from 'node:path';
import { getMigratedPath, getOriginalPath } from './storage/migration';
import { loadReportDocument, reportDocumentInfo } from './report-document';
import { mountReportPreview } from './ui/report';
import { resolveLocale, setLocale, t } from './i18n';
import { validateReportFolder } from './readable-report';

const VIEW_TYPE = 'traceweave-workbench';
const REPORT_VIEW_TYPE = 'traceweave-report';
type LanguagePreference = 'auto' | 'ru' | 'en';
const isLanguagePreference = (value: unknown): value is LanguagePreference => value === 'auto' || value === 'ru' || value === 'en';
const isTechnicalPath = (relative: string, configDir: string) => {
  const candidate = relative.normalize('NFC').toLowerCase(), config = configDir.normalize('NFC').toLowerCase();
  return candidate === config || candidate.startsWith(config + '/') || relative.split('/').some(part => part.startsWith('.') || ['_traceweave', 'twdata'].includes(part.toLowerCase()));
};
class TraceWeaveView extends ItemView {
  private unmount: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, readonly service: LocalWorkbench, private readonly displayName: string) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.displayName; }
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
  getDisplayText() { return t('Снимок TraceWeave', 'TraceWeave snapshot'); }
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
  async refreshLanguage() { if (this.relative && !this.closed) await this.renderReport(); }
  private async renderReport() {
    const generation = ++this.generation, relative = this.relative;
    this.unmount?.(); this.unmount = null; this.contentEl.empty();
    this.contentEl.createEl('p', { text: t('Проверка неизменяемого снимка…', 'Verifying the immutable snapshot…') });
    try {
      await this.ready();
      const document = await loadReportDocument(this.service.repository, relative);
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty();
      this.unmount = mountReportPreview(this.contentEl, { ...document, service: this.service });
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: error instanceof Error ? error.message : t('Не удалось открыть снимок.', 'Could not open the snapshot.') });
      if (reportDocumentInfo(relative)) this.contentEl.createEl('button', { text: t('Показать файл снимка', 'Reveal snapshot file') }).addEventListener('click', () => {
        void this.reveal(relative).catch(failure => new Notice(failure instanceof Error ? failure.message : t('Файл недоступен.', 'The file is unavailable.')));
      });
    }
  }
}
class TraceWeaveSettings extends PluginSettingTab {
  private refreshGeneration = 0;
  private disposed = false;
  private reportFolderDraft: string | null = null;
  constructor(app: App, readonly owner: TraceWeavePlugin) { super(app, owner); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: t('Язык интерфейса', 'Interface language'), desc: t('Автоматически — по языку Obsidian: русский или английский. Смена языка сохраняет заметки, связи и черновики.', 'Automatic follows the Obsidian language: Russian or English. Switching language preserves notes, relationships and drafts.'), render: setting => {
        // Obsidian preserves a focused declarative control's entire row during update().
        // A render definition lets this locale-dependent row rebuild with its translated name and options.
        setting.addDropdown(dropdown => dropdown.addOption('auto', t('Автоматически', 'Automatic')).addOption('ru', 'Русский').addOption('en', 'English').setValue(this.owner.languagePreference).onChange(value => { void this.setControlValue('language', value); }));
      } },
      { name: t('Папка отчётов', 'Reports folder'), desc: t('Путь относительно корня хранилища Obsidian, например Отчёты/Исследования. Пустое поле — корень хранилища. Нажмите «Сохранить», чтобы применить путь.', 'Path relative to the Obsidian vault root, for example Reports/Research. Leave blank to use the vault root. Click “Save” to apply the path.'), render: setting => {
        setting.addText(text => text.setPlaceholder(t('Корень хранилища', 'Vault root')).setValue(this.reportFolderDraft ?? this.owner.reportsFolder).onChange(value => { this.reportFolderDraft = value; }));
        setting.addButton(button => button.setButtonText(t('Сохранить', 'Save')).onClick(() => { void this.setControlValue('reportsFolder', this.reportFolderDraft ?? this.owner.reportsFolder); }));
      } },
      { name: t('Скрытые служебные данные .twdata', 'Hidden application data in .twdata'), desc: t('Связи, история, настройки и снимки находятся в .twdata/. Обычные заметки создаются в Исследования/Заметки, материалы — в Исследования/Вложения. Подключённые заметки из других папок остаются на своих местах.', 'Relationships, history, settings and snapshots are stored in .twdata/. New notes use Исследования/Заметки and materials use Исследования/Вложения. Existing notes from other folders stay in place.') },
      { name: t('Копирование и синхронизация', 'Backup and synchronization'), desc: t('Файловый backup должен включать скрытую .twdata. Obsidian Sync исключает dot-папки и не переносит служебные данные TraceWeave; одного переноса заметок недостаточно.', 'File backups must include the hidden .twdata folder. Obsidian Sync excludes dot-folders and does not transfer TraceWeave metadata; copying notes alone is insufficient.') },
      { name: t('Обычные заметки vault', 'Existing vault notes'), desc: t('В исследовании выберите «Подключить заметку из vault» или используйте контекстное меню Markdown-файла. Заметка подключается без копирования и редактируется обычным редактором Obsidian.', 'Choose “Link vault note” in a research project or use a Markdown file’s context menu. The note is linked in place and remains editable in the standard Obsidian editor.') },
      { name: t('Просмотр неизвестных типов', 'Unknown file types'), desc: t('Список материалов TraceWeave не зависит от настройки Obsidian Show all file types. Для видимости в стандартном проводнике включите её самостоятельно.', 'The TraceWeave materials library works independently of Obsidian’s “Show all file types” setting. Enable that setting to display these files in the standard file explorer.') },
      { name: t('Режим', 'Mode'), desc: t('Локальный desktop, один активный писатель. Текст редактируется в обычном редакторе Obsidian. Облачное одновременное редактирование и внешние хранилища в эту версию не входят.', 'Local desktop use with one active writer. Text is edited in the standard Obsidian editor. Concurrent cloud editing and external storage are not supported in this version.') },
    ];
  }
  getControlValue(key: string): unknown { return key === 'language' ? this.owner.languagePreference : key === 'reportsFolder' ? this.owner.reportsFolder : undefined; }
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!(key === 'language' && isLanguagePreference(value)) && !(key === 'reportsFolder' && typeof value === 'string')) return;
    const generation = this.refreshGeneration;
    try {
      if (key === 'language' && isLanguagePreference(value)) await this.owner.changeLanguage(value);
      else if (typeof value === 'string') {
        await this.owner.changeReportsFolder(value);
        if (this.reportFolderDraft === value) this.reportFolderDraft = null;
      }
    }
    catch (error) { new Notice(error instanceof Error ? error.message : t('Не удалось сохранить настройку.', 'Could not save the setting.')); }
    finally {
      if (!this.disposed && generation === this.refreshGeneration) this.update();
    }
  }
  hide(): void { this.refreshGeneration++; super.hide(); }
  disposeRefresh(): void {
    this.disposed = true;
    this.refreshGeneration++;
  }
}
export default class TraceWeavePlugin extends Plugin {
  service!: LocalWorkbench;
  private ready: Promise<void> | null = null;
  private unloaded = false;
  languagePreference: LanguagePreference = 'auto';
  reportsFolder = '';
  private storedData: Record<string, unknown> = {};
  private settingsChanges: Promise<void> = Promise.resolve();
  private ribbon: HTMLElement | null = null;
  private settingsTab: TraceWeaveSettings | null = null;
  private eventTimers = new Map<string, number>();
  private pendingFileOpens = new Set<() => void>();
  async onload() {
    const data: unknown = await this.loadData();
    if (this.unloaded) return;
    this.storedData = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
    this.languagePreference = isLanguagePreference(this.storedData.language) ? this.storedData.language : 'auto';
    setLocale(resolveLocale(this.languagePreference === 'auto' ? getLanguage() : this.languagePreference));
    if (this.storedData.reportsFolder !== undefined) {
      try {
        if (typeof this.storedData.reportsFolder !== 'string') throw new Error(t('Путь должен быть строкой.', 'The path must be a string.'));
        this.reportsFolder = validateReportFolder(this.storedData.reportsFolder, this.app.vault.configDir);
      } catch (error) {
        this.notify(new Error(t('Некорректная папка отчётов в настройках. Используется корень хранилища. ', 'The saved reports folder is invalid. Using the vault root. ') + (error instanceof Error ? error.message : '')));
      }
    }
    if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice(t('TraceWeave требует desktop-версию Obsidian.', 'TraceWeave requires desktop Obsidian.')); return; }
    const adapter = this.app.vault.adapter, root = adapter.getBasePath(), configDir = this.app.vault.configDir;
    const technical = (relative: string) => isTechnicalPath(relative, configDir);
    const links = new VaultLinks(root, {
      find: (link, source) => this.app.vault.getFileByPath(path.posix.normalize(path.posix.join(path.posix.dirname(source), link))) ?? this.app.metadataCache.getFirstLinkpathDest(link, source),
      resourceUrl: relative => adapter.getResourcePath(relative),
      open: async (relative, subpath) => {
        if (technical(relative)) throw new Error(t('Служебный файл не является обычным файлом Obsidian.', 'An application data file is not a regular Obsidian file.'));
        const file = this.app.vault.getFileByPath(relative);
        if (file && !subpath) await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
        else await this.app.workspace.openLinkText(relative + subpath, '', 'tab');
      },
      reveal: async relative => { electron.shell.showItemInFolder(await resolveSafe(root, relative)); },
      migrated: relative => getMigratedPath(root, relative, configDir),
      original: relative => getOriginalPath(root, relative, configDir),
    }, configDir);
    const repo = new ProjectRepository(root, { configDir, createNote: async (relative, text) => {
      const parent = relative.slice(0, relative.lastIndexOf('/'));
      if (parent && !this.app.vault.getFolderByPath(parent)) await this.app.vault.createFolder(parent);
      await this.app.vault.create(relative, text);
    } });
    this.service = new LocalWorkbench(repo, {
      reportsFolder: () => this.reportsFolder,
      listNotes: () => this.app.vault.getMarkdownFiles().map(f => ({ path: f.path, title: f.basename })),
      openNote: async relative => {
        if (this.unloaded) throw new Error(t('Плагин закрыт.', 'The plugin is closed.'));
        if (reportDocumentInfo(relative)) {
          const leaf = this.app.workspace.getLeaf('tab');
          await leaf.setViewState({ type: REPORT_VIEW_TYPE, active: true, state: { path: relative } });
          await this.app.workspace.revealLeaf(leaf);
          return;
        }
        if (technical(relative)) throw new Error(t('Служебный файл нельзя открыть как обычную заметку Obsidian.', 'An application data file cannot be opened as a regular Obsidian note.'));
        let file = this.app.vault.getFileByPath(relative);
        if (!file) {
          await resolveSafe(root, relative);
          // File-system publication can precede Obsidian's create/rename index events.
          // openLinkText would try to create that existing file instead of opening it.
          if (await adapter.exists(relative)) file = await this.waitForIndexedFile(relative);
        }
        if (this.unloaded) throw new Error(t('Плагин закрыт.', 'The plugin is closed.'));
        if (file) await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
        else await this.app.workspace.openLinkText(relative, '', 'tab');
      },
      resourceUrl: relative => adapter.getResourcePath(relative),
      resolveVaultLink: (source, link) => links.resolve(source, link),
      openVaultLink: (source, link) => links.open(source, link),
      showFile: async relative => { electron.shell.showItemInFolder(await resolveSafe(root, relative)); },
      filePath: async file => {
        const filename = electron.webUtils?.getPathForFile(file) || (file as File & { path?: string }).path;
        if (!filename) throw new Error(t('Obsidian не предоставил путь к выбранному локальному файлу. Перетащите файл с диска или зарегистрируйте его из папки материалов.', 'Obsidian did not provide the selected local file path. Drag the file from disk or register it from the resources folder.'));
        return filename;
      },
    });
    this.registerView(VIEW_TYPE, leaf => new TraceWeaveView(leaf, this.service, this.manifest.name));
    this.registerView(REPORT_VIEW_TYPE, leaf => new TraceWeaveReportView(leaf, this.service, () => this.ensureReady(), async relative => { electron.shell.showItemInFolder(await resolveSafe(root, relative)); }));
    this.ribbon = this.addRibbonIcon('git-fork', t('Открыть TraceWeave', 'Open TraceWeave'), () => { void this.openWorkbench(); });
    this.registerLocalizedCommands();
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md' || technical(file.path)) return;
      menu.addItem(item => item.setTitle(t('Подключить к TraceWeave', 'Link to TraceWeave')).setIcon('git-fork').onClick(() => { void this.ensureReady().then(() => { if (!this.unloaded) return this.service.adoptNote(file.path); }).then(() => this.openWorkbench()).catch(error => { if (!this.unloaded) this.notify(error); }); }));
    }));
    this.settingsTab = new TraceWeaveSettings(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const newPath = file.path;
      if (this.unloaded || technical(oldPath) || technical(newPath)) return;
      void this.ensureReady().then(() => { if (!this.unloaded) return this.service.onRenamed(newPath, oldPath); }).catch(error => { if (!this.unloaded) this.notify(error); });
    }));
    const changed = (file: { path: string }) => {
      const relative = file.path;
      if (this.unloaded || !relative.toLowerCase().endsWith('.md') || technical(relative)) return;
      const previous = this.eventTimers.get(relative);
      if (previous !== undefined) window.clearTimeout(previous);
      this.eventTimers.set(relative, window.setTimeout(() => {
        this.eventTimers.delete(relative);
        if (this.unloaded) return;
        void this.ensureReady().then(() => { if (!this.unloaded) return this.service.onFileChanged(relative); }).catch(error => { if (!this.unloaded) this.notify(error); });
      }, 400));
    };
    this.registerEvent(this.app.vault.on('modify', changed)); this.registerEvent(this.app.vault.on('delete', changed)); this.registerEvent(this.app.vault.on('create', changed));
    this.app.workspace.onLayoutReady(() => { if (!this.unloaded) void this.ensureReady().catch(error => { if (!this.unloaded) this.notify(error); }); });
  }
  private registerLocalizedCommands(replace = false) {
    if (replace) { this.removeCommand('open-workbench'); this.removeCommand('adopt-active-note'); }
    this.addCommand({ id: 'open-workbench', name: t('Открыть исследование', 'Open research'), callback: () => { void this.openWorkbench(); } });
    this.addCommand({ id: 'adopt-active-note', name: t('Подключить текущую заметку к исследованию', 'Link current note to research'), checkCallback: checking => {
      const file = this.app.workspace.getActiveFile(); if (this.unloaded || !file || file.extension !== 'md' || isTechnicalPath(file.path, this.app.vault.configDir)) return false;
      if (!checking) void this.ensureReady().then(() => { if (!this.unloaded) return this.service.adoptNote(file.path); }).then(() => this.openWorkbench()).catch(error => { if (!this.unloaded) this.notify(error); }); return true;
    } });
  }
  changeLanguage(language: LanguagePreference): Promise<void> {
    const change = async () => {
      if (this.unloaded) throw new Error(t('Плагин закрыт.', 'The plugin is closed.'));
      // Preserve drafts before applying the preference; the existing React view stays mounted.
      await flushWorkbenchDrafts(this.service);
      if (this.unloaded) return;
      const next = { ...this.storedData, language };
      await this.saveData(next);
      if (this.unloaded) return;
      this.storedData = next;
      this.languagePreference = language;
      setLocale(resolveLocale(language === 'auto' ? getLanguage() : language));
      this.service.refreshLanguage();
      this.registerLocalizedCommands(true);
      this.ribbon?.setAttribute('aria-label', t('Открыть TraceWeave', 'Open TraceWeave'));
      await Promise.all(this.app.workspace.getLeavesOfType(REPORT_VIEW_TYPE).map(leaf => leaf.view instanceof TraceWeaveReportView ? leaf.view.refreshLanguage() : Promise.resolve()));
    };
    return this.enqueueSettingsChange(change);
  }
  changeReportsFolder(value: string): Promise<void> {
    return this.enqueueSettingsChange(async () => {
      if (this.unloaded) throw new Error(t('Плагин закрыт.', 'The plugin is closed.'));
      const reportsFolder = validateReportFolder(value, this.app.vault.configDir);
      const next = { ...this.storedData, reportsFolder };
      await this.saveData(next);
      if (this.unloaded) return;
      this.storedData = next;
      this.reportsFolder = reportsFolder;
    });
  }
  private enqueueSettingsChange(change: () => Promise<void>): Promise<void> {
    this.settingsChanges = this.settingsChanges.then(change, change);
    return this.settingsChanges;
  }
  private waitForIndexedFile(relative: string): Promise<TFile> {
    if (this.unloaded) return Promise.reject(new Error(t('Плагин закрыт.', 'The plugin is closed.')));
    const existing = this.app.vault.getFileByPath(relative);
    if (existing) return Promise.resolve(existing);
    const vault = this.app.vault, ownerWindow = this.app.workspace.containerEl.win;
    return new Promise((resolve, reject) => {
      const refs: EventRef[] = [];
      let timer: number | undefined, finished = false, registered = false;
      const finish = (file: TFile | null, error?: Error) => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) ownerWindow.clearTimeout(timer);
        refs.forEach(ref => vault.offref(ref));
        this.pendingFileOpens.delete(cancel);
        if (file) resolve(file);
        else reject(error ?? new Error(t('Файл сохранён, но Obsidian ещё не добавил его в индекс. Откройте его из проводника: ', 'The file was saved, but Obsidian has not indexed it yet. Open it from the file explorer: ') + relative));
      };
      const cancel = () => finish(null, new Error(t('Плагин закрыт.', 'The plugin is closed.')));
      const check = () => {
        if (!registered || finished) return;
        if (this.unloaded) { cancel(); return; }
        const file = vault.getFileByPath(relative);
        if (file) finish(file);
      };
      this.pendingFileOpens.add(cancel);
      try {
        refs.push(vault.on('create', check));
        refs.push(vault.on('rename', check));
        timer = ownerWindow.setTimeout(() => { check(); if (!finished) finish(null); }, 5000);
        registered = true;
        // Close the race between the first lookup and installing both event listeners.
        check();
      } catch (error) { finish(null, error instanceof Error ? error : new Error(t('Не удалось дождаться индексации файла: ', 'Could not wait for the file to be indexed: ') + relative)); }
    });
  }
  private notify(error: unknown) { new Notice(error instanceof Error ? error.message : t('TraceWeave: операция не завершена.', 'TraceWeave: the operation did not complete.'), 10_000); }
  private ensureReady() { if (this.unloaded) return Promise.reject(new Error(t('Плагин закрыт.', 'The plugin is closed.'))); if (!this.ready) this.ready = this.service.initialize(); return this.ready; }
  async openWorkbench() {
    if (this.unloaded) return;
    try {
      await this.ensureReady();
      if (this.unloaded) return;
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      const leaf = existing ?? this.app.workspace.getLeaf('tab');
      if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
      if (this.unloaded) return;
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) { if (!this.unloaded) this.notify(error); }
  }
  onunload() {
    this.unloaded = true; this.eventTimers.forEach(timer => window.clearTimeout(timer)); this.eventTimers.clear();
    this.pendingFileOpens.forEach(cancel => cancel());
    this.settingsTab?.disposeRefresh();
    if (this.service) void (async () => { try { await this.settingsChanges; await this.ready; } catch (error) { this.notify(error); } try { await flushWorkbenchDrafts(this.service); } finally { await this.service.dispose(); } })().catch(error => this.notify(error));
  }
}

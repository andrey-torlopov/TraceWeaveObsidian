import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyCommands, createProject, searchProject, DomainError } from './domain';
import type { Asset, Command, ID, Project, ReadableReportResult, ResourceCandidate, SnapshotRecord, ViewState, VaultLink, WorkbenchService, WorkbenchSnapshot } from './types';
import { FileStore, resolveSafe, safeRelative } from './storage/files';
import { ProjectRepository, digest, stableJSON, strictJSON } from './storage/repository';
import { exportProject, exportTraceWeaveArchive, stageImport, createReport, verifyReport } from './portability';
import { DATA_ROOT, NOTES_ROOT, RESOURCES_ROOT, hasControlCharacters, isConfigurationPath, isAllowedNotePath, isAllowedResourcePath } from './storage/layout';
import { migrateLegacyVault } from './storage/migration';
import { caseFold } from './casefold';
import { t } from './i18n';
import { exportReadableReport as writeReadableReport } from './readable-report';

export interface Host {
 listNotes(): { path: string; title: string }[];
 openNote(path: string): Promise<void>;
 resourceUrl(path: string): string;
 showFile(path: string): Promise<void>;
 filePath(file: File): Promise<string>;
 reportsFolder?(): string;
 resolveVaultLink?(sourcePath: string, link: string): Promise<VaultLink | null>;
 openVaultLink?(sourcePath: string, link: string): Promise<void>;
}
export class LocalWorkbench implements WorkbenchService {
  private state: WorkbenchSnapshot = Object.freeze({ projects: [], project: null, busy: false, message: '', error: null, canUndo: false, canRedo: false, progress: null });
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private draftTail: Promise<unknown> = Promise.resolve();
  private controller: AbortController | null = null;
  private searchCache = new Map<string, { hash: string; text: string }>();
  files: FileStore;
  paths = { notesRoot: NOTES_ROOT, resourcesRoot: RESOURCES_ROOT };
  constructor(readonly repository: ProjectRepository, readonly host: Host) { this.files = new FileStore(repository.vaultRoot, DATA_ROOT, RESOURCES_ROOT, repository.configDir); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private publish(change: Partial<WorkbenchSnapshot>) { this.state = Object.freeze({ ...this.state, ...change }); this.listeners.forEach(listener => listener()); }
  private project(): Project { if (!this.state.project) throw new DomainError('no_project', t('Сначала откройте исследование.', "Open a research project first.")); return this.state.project; }
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      if (this.disposed) throw new Error(t('Плагин закрыт.', "The plugin is closed."));
      this.publish({ busy: true, error: null });
      try { return await task(); }
      catch (error) { this.publish({ error: error instanceof Error ? error.message : t('Операция не завершена.', "The operation did not complete.") }); throw error; }
      finally { this.publish({ busy: false, progress: null }); }
    });
    this.tail = next.catch(() => undefined); // The caller receives the error; keep the queue usable for recovery.
    return next;
  }
  private async refresh(project: Project | null = this.state.project) {
    const projects = await this.repository.list();
    const stacks = project ? await this.repository.historyState(project) : { undo: [], redo: [] };
    this.publish({ project, projects, canUndo: stacks.undo.length > 0 && project?.status === 'active', canRedo: stacks.redo.length > 0 && project?.status === 'active' });
  }
  async initialize() {
    if (this.repository.metadataRoot === DATA_ROOT) await migrateLegacyVault(this.repository.vaultRoot, { configDir: this.repository.configDir });
    try { await this.repository.initialize(); } catch (error) { this.publish({ error: error instanceof Error ? error.message : t('Требуется восстановление.', "Recovery is required.") }); }
    try { const value = strictJSON<{ notesRoot: string; resourcesRoot: string }>(await this.repository.readText(`${DATA_ROOT}/settings.json`, 16_384)); this.validatePaths(value); this.paths = value; this.files = new FileStore(this.repository.vaultRoot, DATA_ROOT, value.resourcesRoot, this.repository.configDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.refresh();
    if (this.repository.issues.length) this.publish({ error: this.repository.issues.join('\n') });
    if (this.state.projects[0]) { const p = await this.repository.read(this.state.projects[0].id); await this.refresh(p); if (!this.repository.needsRecovery) await this.reconcileProject(); }
  }
  private validatePaths(value: { notesRoot: string; resourcesRoot: string }) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['notesRoot', 'resourcesRoot'].includes(key)) || typeof value.notesRoot !== 'string' || typeof value.resourcesRoot !== 'string' || !isAllowedNotePath(value.notesRoot + '/note.md', false, this.repository.configDir) || !isAllowedResourcePath(value.resourcesRoot, false, this.repository.configDir)) throw new DomainError('unsafe_path', t('Выберите видимые папки вне настроек и служебных данных.', 'Choose visible folders outside configuration and metadata.'));
    for (const [root, allowed] of [[value.notesRoot, NOTES_ROOT], [value.resourcesRoot, RESOURCES_ROOT]]) { safeRelative(root); if (root !== allowed && !root.startsWith(allowed + '/')) throw new Error(t('Созданные плагином файлы должны оставаться в Исследования/Заметки и Исследования/Вложения.', "Files created by the plugin must remain in Исследования/Заметки and Исследования/Вложения.")); }
    const noteKey = value.notesRoot.normalize('NFC').toLowerCase(), resourceKey = value.resourcesRoot.normalize('NFC').toLowerCase();
    if (noteKey === resourceKey || noteKey.startsWith(resourceKey + '/') || resourceKey.startsWith(noteKey + '/')) throw new Error(t('Выберите раздельные папки заметок и материалов.', "Choose separate folders for notes and materials."));
  }
  configurePaths(value: { notesRoot: string; resourcesRoot: string }) { return this.run(async () => { this.validatePaths(value); const files = new FileStore(this.repository.vaultRoot, DATA_ROOT, value.resourcesRoot, this.repository.configDir); await this.repository.atomicText(`${DATA_ROOT}/settings.json`, stableJSON(value)); this.paths = { ...value }; this.files = files; }); }
  /** Transient success text belongs to the old UI locale; preserve errors and all research state. */
  refreshLanguage(): void { this.publish({ message: '' }); }
  async dispose() { this.disposed = true; this.controller?.abort(); await this.tail; await this.draftTail; this.listeners.clear(); await this.repository.dispose(); }
  createProject(title: string) { return this.run(async () => { this.repository.assertWritable(); const project = createProject(title); await this.repository.add(project); await this.refresh(project); this.publish({ message: t('Исследование создано. Заметки остаются обычными Markdown-файлами.', "Research project created. Notes remain ordinary Markdown files.") }); }); }
  openProject(id: ID) { return this.run(async () => { const project = await this.repository.read(id); this.searchCache.clear(); await this.refresh(project); await this.reconcileProject(); }); }
  execute(commands: Command[]) { return this.run(async () => { const p = this.project(); const next = await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) }); await this.refresh(next); this.publish({ message: t('Метаданные сохранены.', "Metadata saved.") }); }); }
  private notePath(p: Project, title: string, id: string) {
    const clean = (value: string) => {
      const sanitized = [...value.normalize('NFC')].map(character => hasControlCharacters(character) || /[<>:"/\\|?*]/u.test(character) ? '-' : character).join('').trim().replace(/[. ]+$/gu, '');
      return [...sanitized].slice(0, 70).join('') || 'Заметка';
    };
    return `${this.paths.notesRoot}/${clean(p.title)}--${p.id.slice(0, 8)}/${clean(title)}--${id.slice(0, 8)}.md`;
  }
  createNote(title: string, typeId?: ID): Promise<ID> { return this.run(async () => {
    const p = this.project(), id = randomUUID(), notePath = this.notePath(p, title, id), after = '';
    const count = p.nodes.filter(n => !n.deletedAt).length;
    const next = await this.repository.execute(p.id, [{ kind: 'node.create', id, title, notePath, noteHash: digest(after), typeId, x: (count % 4) * 280, y: Math.floor(count / 4) * 150 }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), effects: [{ path: notePath, before: null, after }] });
    await this.refresh(next); this.publish({ message: t('Заметка создана. Текст редактируется в штатном редакторе.', "Note created. Edit its text in the native editor.") }); return id;
  }); }
  createGroup(title: string, nodeIds: ID[]): Promise<ID> { return this.run(async () => {
    const p = this.project(), id = randomUUID(), notePath = this.notePath(p, title, id);
    const next = await this.repository.execute(p.id, [{ kind: 'group.create', id, title, notePath, nodeIds, noteHash: digest('') }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), effects: [{ path: notePath, before: null, after: '' }] });
    await this.refresh(next); return id;
  }); }
  private async assertUnbound(notePath: string, nodeId?: string) {
    const relative = caseFold(notePath), resources = caseFold(this.paths.resourcesRoot);
    if (relative === resources || relative.startsWith(resources + '/')) throw new DomainError('original_binding',t('Markdown в папке вложений нельзя подключить как заметку.', "Markdown in the attachments folder cannot be linked as a note."));
    for (const summary of await this.repository.list()) {
      const project = await this.repository.read(summary.id);
      if (project.blobs.some(blob => caseFold(blob.path) === relative)) throw new DomainError('original_binding',t('Этот Markdown зарегистрирован как неизменяемый оригинал. Создайте отдельную копию для заметки.', "This Markdown file is registered as an immutable original. Create a separate copy to use as a note."));
      if (project.nodes.some(n => n.id !== nodeId && caseFold(n.notePath) === relative)) throw new DomainError('already_bound', t('Эта заметка уже принадлежит исследованию. Сначала используйте существующий узел или создайте отдельную копию.', "This note already belongs to a research project. Use the existing node or create a separate copy."));
    }
  }
  adoptNote(notePath: string) { return this.run(async () => {
    const p = this.project(); safeRelative(notePath, this.repository.configDir); if (!isAllowedNotePath(notePath, false, this.repository.configDir)) throw new DomainError('unsafe_note',t('Заметка должна находиться вне скрытых и служебных папок.', "The note must be outside hidden and technical folders.")); await this.assertUnbound(notePath);
    const text = await this.repository.readText(notePath, 5_242_880); const id = randomUUID();
    const title = path.posix.basename(notePath, '.md');
    const next = await this.repository.execute(p.id, [{ kind: 'node.create', id, title, notePath, noteHash: digest(text), x: (p.nodes.length % 4) * 280, y: Math.floor(p.nodes.length / 4) * 150 }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) });
    await this.refresh(next); this.publish({ message: t('Заметка подключена без изменения текста или Properties.', "Note linked without changing its text or Properties.") });
  }); }
  async openNote(nodeId: ID) { const node = this.project().nodes.find(n => n.id === nodeId); if (!node) throw new Error(t('Документ не найден.', "Document not found.")); if (node.missing) throw new Error(t('Файл заметки не найден. Переподключите его.', "The note file was not found. Relink it.")); await this.host.openNote(node.notePath); }
  async readNote(nodeId: ID) { const p = this.project(), node = p.nodes.find(n => n.id === nodeId); if (!node) throw new Error(t('Документ не найден.', "Document not found.")); return this.repository.readText(node.notePath, 5_242_880); }
  listNotes() { const resources = caseFold(this.paths.resourcesRoot); return this.host.listNotes().filter(note => { const relative = caseFold(note.path); return isAllowedNotePath(note.path, false, this.repository.configDir) && relative !== resources && !relative.startsWith(resources + '/'); }); }
  async resolveVaultLink(sourcePath: string, link: string): Promise<VaultLink | null> { if (!this.host.resolveVaultLink) throw new DomainError('host_unavailable', t('Хост не предоставляет разрешение ссылок Obsidian.', "The host does not support resolving Obsidian links.")); return this.host.resolveVaultLink(sourcePath, link); }
  async openVaultLink(sourcePath: string, link: string): Promise<void> { if (!this.host.openVaultLink) throw new DomainError('host_unavailable', t('Хост не предоставляет открытие ссылок Obsidian.', "The host does not support opening Obsidian links.")); await this.host.openVaultLink(sourcePath, link); }
  relinkNote(nodeId: ID, notePath: string) { return this.run(async () => {
    const p = this.project(); safeRelative(notePath, this.repository.configDir); if (!isAllowedNotePath(notePath, false, this.repository.configDir)) throw new DomainError('unsafe_note',t('Заметка должна находиться вне скрытых и служебных папок.', "The note must be outside hidden and technical folders.")); await this.assertUnbound(notePath, nodeId); const text = await this.repository.readText(notePath, 5_242_880);
    const next = await this.repository.execute(p.id, [{ kind: 'node.update', nodeId, changes: { notePath, noteHash: digest(text), missing: false } }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), kind: 'reconcile' });
    await this.refresh(next); this.publish({ message: t('Файл переподключён. Идентичность узла и его связи сохранены.', "File relinked. The node identity and its relationships were preserved.") });
  }); }
  async onRenamed(newPath: string, oldPath: string) { return this.run(async () => {
    safeRelative(newPath, this.repository.configDir); safeRelative(oldPath, this.repository.configDir);
    for (const summary of await this.repository.list()) {
      const p = await this.repository.read(summary.id);
      const affected = p.nodes.filter(n => n.notePath === oldPath || n.notePath.startsWith(oldPath + '/'));
      if (affected.some(node => !isAllowedNotePath(newPath + node.notePath.slice(oldPath.length), false, this.repository.configDir))) throw new DomainError('unsafe_note',t('Заметку нельзя переместить в скрытую или служебную папку.', "A note cannot be moved into a hidden or technical folder."));
      const commands: Command[] = affected.map(n => ({ kind: 'node.update', nodeId: n.id, changes: { notePath: newPath + n.notePath.slice(oldPath.length), missing: false } }));
      const blobs = p.blobs.filter(blob => blob.path === oldPath || blob.path.startsWith(oldPath + '/'));
      let replacement: Project | undefined;
      if (blobs.length) {
        this.repository.assertWritable(p.id); replacement = commands.length ? applyCommands(p,commands) : structuredClone(p);
        for (const blob of blobs) {
          const nextPath = newPath + blob.path.slice(oldPath.length); if (!isAllowedResourcePath(nextPath, false, this.repository.configDir)) throw new DomainError('unsafe_path',t('Оригинал нельзя переместить в скрытую или служебную папку.', "An original cannot be moved into a hidden or technical folder."));
          if (await this.files.verify({...blob,path:nextPath}) !== 'ok') throw new DomainError('original_conflict',t('Оригинал после переименования недоступен или изменён. Привязка не изменена.', "The original is unavailable or changed after renaming. Its binding was not changed."));
          replacement.blobs.find(item => item.id === blob.id)!.path = nextPath;
        }
      }
      if (commands.length || replacement) { const next = await this.repository.execute(p.id, commands, { replace: replacement, baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), kind: 'reconcile' }); if (this.state.project?.id === p.id) await this.refresh(next); }
    }
  }); }
  async onFileChanged(notePath: string) { if (!this.state.project?.nodes.some(n => n.notePath === notePath)) return; return this.run(() => this.reconcileProject()); }
  private async reconcileProject() {
    const p = this.project(); if (this.repository.readOnly) return;
    const commands: Command[] = [];
    for (const node of p.nodes) {
      try {
        const text = await this.repository.readText(node.notePath, 5_242_880), hash = digest(text);
        if (hash !== node.noteHash || node.missing) commands.push({ kind: 'node.update', nodeId: node.id, changes: { noteHash: hash, missing: false } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { if (!node.missing) commands.push({ kind: 'node.update', nodeId: node.id, changes: { missing: true } }); }
        else throw error;
      }
    }
    if (commands.length) {
      const next = await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), kind: 'reconcile' }); this.searchCache.clear(); await this.refresh(next);
      this.publish({ message: next.nodes.some(n => n.missing) ? t('Есть недоступные заметки. Связи сохранены; выберите файл через переподключение.', "Some notes are unavailable. Relationships were preserved; select a file using relink.") : t('Внешние изменения заметок приняты.', "External note changes accepted.") });
    }
  }
  importFiles(files: File[], nodeId?: ID) { return this.run(async () => {
    this.repository.assertWritable(this.project().id); this.controller = new AbortController();
    try {
      for (const file of files) {
        this.controller.signal.throwIfAborted(); const p = this.project(); if (p.status === 'archived') throw new Error(t('Исследование в архиве.', "The research project is archived."));
        const source = await this.host.filePath(file);
        const { blob, originalName } = await this.files.importFile(source, p.id, p.blobs, { signal: this.controller.signal, originalName: file.name, onProgress: (completed, total) => this.publish({ progress: { name: file.name, completed, total } }) });
        const asset = this.asset(blob, originalName);
        const commands: Command[] = [{ kind: 'asset.register', asset, blob }];
        if (nodeId) commands.push({ kind: 'attachment.attach', attachment: { id: randomUUID(), nodeId, assetId: asset.id, role: p.attachments.some(a => a.nodeId === nodeId && a.role === 'primary') ? 'attachment' : 'primary', sortOrder: p.attachments.filter(a => a.nodeId === nodeId).length, caption: null } });
        await this.refresh(await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) }));
      }
      this.publish({ message: t('Все выбранные материалы зарегистрированы.', "All selected materials registered.") });
    } finally { this.controller = null; }
  }); }
  cancelImport() { this.controller?.abort(); }
  private asset(blob: Project['blobs'][number], name: string): Asset { const title = [...name.normalize('NFC').trim()].slice(0, 200).join('').trim() || t('Материал', 'Material'); return { id: randomUUID(), blobId: blob.id, originalName: name, title, mimeType: blob.mimeType, mediaKind: blob.mediaKind, byteSize: blob.byteSize, sha256: blob.sha256, createdAt: new Date().toISOString(), deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: '', origin: { kind: 'manual' } }; }
  async discoverResources(): Promise<ResourceCandidate[]> {
    const p = this.project(), relative = this.paths.resourcesRoot, root = await resolveSafe(this.repository.vaultRoot, relative, false, this.repository.configDir);
    const registered = new Set(p.blobs.map(b => b.path)), found: ResourceCandidate[] = [];
    const walk = async (directory: string, rel: string) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const e of entries) { if (found.length >= 50_000) throw new Error(t('Каталог превышает лимит 50000 файлов.', "The folder exceeds the limit of 50000 files.")); const next = `${rel}/${e.name}`; if (e.isSymbolicLink() || e.name.startsWith('.') || isConfigurationPath(next, this.repository.configDir)) continue; if (e.isDirectory()) await walk(path.join(directory, e.name), next); else if (e.isFile()) found.push({ path: next, byteSize: (await fs.stat(await resolveSafe(this.repository.vaultRoot, next, false, this.repository.configDir))).size, registered: registered.has(next) }); }
    };
    try { await walk(root, relative); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return found;
  }
  registerResource(relative: string, nodeId?: ID) { return this.run(async () => {
    const p = this.project(); this.repository.assertWritable(p.id); if (p.status === 'archived') throw new Error(t('Исследование в архиве.', "The research project is archived.")); if (!relative.startsWith(`${this.paths.resourcesRoot}/`)) throw new Error(t('Файл находится вне настроенной папки материалов.', "The file is outside the configured materials folder."));
    if (p.blobs.some(b => b.path === relative)) throw new Error(t('Файл уже зарегистрирован. Прикрепите его из библиотеки.', "The file is already registered. Attach it from the library."));
    const source = await resolveSafe(this.repository.vaultRoot, relative, false, this.repository.configDir);
    const result = await this.files.importFile(source, p.id, p.blobs); const asset = this.asset(result.blob, path.posix.basename(relative));
    const commands: Command[] = [{ kind: 'asset.register', asset, blob: result.blob }];
    if (nodeId) commands.push({ kind: 'attachment.attach', attachment: { id: randomUUID(), nodeId, assetId: asset.id, role: 'attachment', sortOrder: p.attachments.filter(a => a.nodeId === nodeId).length, caption: null } });
    await this.refresh(await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) }));
  }); }
  resourceUrl(assetId: ID) { const p = this.project(), asset = p.assets.find(a => a.id === assetId), blob = p.blobs.find(b => b.id === asset?.blobId); if (!blob) throw new Error(t('Материал недоступен.', "Material is unavailable.")); return this.host.resourceUrl(blob.path); }
  async showAsset(assetId: ID) { const p = this.project(), asset = p.assets.find(a => a.id === assetId), blob = p.blobs.find(b => b.id === asset?.blobId); if (!blob || !asset) throw new Error(t('Материал не найден.', "Material not found.")); if (asset.mimeType === 'application/pdf') await this.host.openNote(blob.path); else await this.host.showFile(blob.path); }
  async verifyAssets() { const p = this.project(); const results = new Map<string, 'ok' | 'missing' | 'changed'>(); for (const blob of p.blobs) results.set(blob.id, await this.files.verify(blob)); return p.assets.map(a => ({ assetId: a.id, status: results.get(a.blobId) ?? 'missing' as const })); }
  async search(query: string, caseSensitive = false) {
    const p = this.project(); const bodies = new Map<string, string>();
    for (const n of p.nodes.filter(n => !n.deletedAt && !n.missing)) {
      const cached = this.searchCache.get(n.id);
      if (cached && cached.hash === n.noteHash) bodies.set(n.id, cached.text);
      else { const text = await this.repository.readText(n.notePath, 5_242_880); this.searchCache.set(n.id, { hash: digest(text), text }); bodies.set(n.id, text); }
    }
    return searchProject(p, query, bodies, caseSensitive);
  }
  createReport(title: string, nodeIds?: ID[]): Promise<SnapshotRecord> { return this.run(async () => {
    this.repository.assertWritable(this.project().id); await this.reconcileProject(); const p = this.project();
    if (p.status === 'archived') throw new Error(t('Создание нового снимка недоступно в архивном исследовании.', "A new snapshot cannot be created in an archived research project."));
    const snapshot = await createReport(this.repository.vaultRoot, p, title, nodeIds);
    await this.refresh(await this.repository.execute(p.id, [{ kind: 'snapshot.register', snapshot }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) })); return snapshot;
  }); }
  async openReport(id: ID) { const report = this.project().snapshots.find(s => s.id === id); if (!report) throw new Error(t('Снимок не найден.', "Snapshot not found.")); await verifyReport(this.repository.vaultRoot, report); await this.host.openNote(report.path.replace(/snapshot\.json$/u, 'report.md')); }
  exportReadableReport(): Promise<ReadableReportResult> { return this.run(async () => {
    this.repository.assertWritable(this.project().id);
    await this.reconcileProject();
    const project = structuredClone(this.project()), stateHash = digest(stableJSON(project));
    const result = await writeReadableReport(this.repository.vaultRoot, project, this.host.reportsFolder?.() ?? '', {
      configDir: this.repository.configDir,
      resolveLink: this.host.resolveVaultLink?.bind(this.host),
      assertUnchanged: async () => {
        const current = await this.repository.read(project.id);
        if (digest(stableJSON(current)) !== stateHash) throw new DomainError('revision_conflict', t('Исследование изменилось во время экспорта. Повторите создание отчёта.', 'The research changed during export. Create the report again.'));
      },
    });
    this.publish({ message: t(`Отчёт сохранён: ${result.summaryPath}`, `Report saved: ${result.summaryPath}`) });
    try { await this.host.openNote(result.summaryPath); }
    catch (error) { throw new DomainError('report_open', t(`Отчёт создан: ${result.summaryPath}. Не удалось открыть файл: ${error instanceof Error ? error.message : String(error)}`, `Report created: ${result.summaryPath}. Could not open the file: ${error instanceof Error ? error.message : String(error)}`)); }
    return result;
  }); }
  exportProject(): Promise<string> { return this.run(async () => {
    this.repository.assertWritable(this.project().id); await this.reconcileProject(); const p = this.project();
    const relative = `${DATA_ROOT}/exports/${p.id}-${p.revision}-${randomUUID()}.zip`, absolute = await resolveSafe(this.repository.vaultRoot, relative, true, this.repository.configDir);
    await exportProject(this.repository.vaultRoot, p, absolute); await this.host.showFile(relative); this.publish({ message: t('Полная переносимая копия создана.', "Complete portable copy created.") }); return relative;
  }); }
  exportTraceWeave(): Promise<string> { return this.run(async () => {
    this.repository.assertWritable(this.project().id); await this.reconcileProject(); const p = this.project();
    const relative = `${DATA_ROOT}/exports/traceweave-${p.id}-${p.revision}-${randomUUID()}.zip`, absolute = await resolveSafe(this.repository.vaultRoot, relative, true, this.repository.configDir);
    await exportTraceWeaveArchive(this.repository.vaultRoot, p, absolute); await this.host.showFile(relative); this.publish({ message: t('Архив TraceWeave 2.0 создан.', "TraceWeave 2.0 archive created.") }); return relative;
  }); }
  importArchive(file: File) { return this.run(async () => {
    this.repository.assertWritable(); const staged = await stageImport(this.repository.vaultRoot, await this.host.filePath(file));
    try {
      for (const relative of [...staged.project.nodes.map(node => node.notePath), ...staged.project.blobs.map(blob => blob.path)]) safeRelative(relative, this.repository.configDir);
      await staged.commit(); await this.repository.add(staged.project);
    }
    catch (error) { this.publish({ message: t('Импорт не опубликован. Подготовленные файлы сохранены для восстановления; исходные заметки не перезаписаны.', "The import was not committed. Prepared files were kept for recovery; original notes were not overwritten.") }); throw error; }
    await this.refresh(staged.project); const warnings = staged.project.importedData.warnings; this.publish({ message: t('Проект импортирован с новыми ID.', "Project imported with new IDs.") + (Array.isArray(warnings) && warnings.length ? '\n' + warnings.join('\n') : '') });
  }); }
  undo() { return this.run(async () => { const p = this.project(); if (p.status === 'archived') throw new Error(t('История недоступна в архиве.', "History is unavailable in an archived research project.")); await this.refresh(await this.repository.undoRedo(p, 'undo')); }); }
  redo() { return this.run(async () => { const p = this.project(); if (p.status === 'archived') throw new Error(t('История недоступна в архиве.', "History is unavailable in an archived research project.")); await this.refresh(await this.repository.undoRedo(p, 'redo')); }); }
  recover() { return this.run(async () => { await this.repository.recover(); if (this.state.project) await this.refresh(await this.repository.read(this.state.project.id)); else await this.refresh(); if (this.state.project) await this.reconcileProject(); this.publish({ message: t('Проверка завершена. Подтверждённое состояние загружено.', "Verification complete. The committed state was loaded.") }); }); }
  async loadDrafts(projectId?: ID): Promise<Record<string, unknown>> {
    const id = projectId ?? this.state.project?.id; if (!id) return {};
    await this.repository.read(id);
    try { const stored = strictJSON<{ formatVersion: number; drafts: Record<string, unknown> }>(await this.repository.readText(`${this.repository.projectRoot(id)}/drafts.json`, 5_242_880));
      if (stored.formatVersion !== 1 || !stored.drafts || typeof stored.drafts !== 'object' || Array.isArray(stored.drafts) || Object.keys(stored.drafts).some(k => !k.startsWith(id + '/'))) throw new Error(t('Неверный формат локальных черновиков.', "Invalid local draft format."));
      return stored.drafts;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  saveDraft(key: string, value: unknown): Promise<void> {
    const id = key.split('/')[0];
    const next = this.draftTail.then(async () => {
      if (!id || key.length > 1024 || hasControlCharacters(key)) throw new Error(t('Неверный ключ черновика.', "Invalid draft key."));
      const drafts = await this.loadDrafts(id);
      if (value === null) delete drafts[key]; else {
        const validateJSON = (input: unknown, seen = new Set<object>()): void => {
          if (input === null || typeof input === 'string' || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return;
          if (!input || typeof input !== 'object' || seen.has(input)) throw new Error(t('Черновик содержит неподдерживаемое JSON-значение.', "The draft contains an unsupported JSON value."));
          seen.add(input); if (Array.isArray(input)) input.forEach(v => validateJSON(v, seen)); else {
            if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error(t('Черновик должен содержать обычный JSON.', "The draft must contain plain JSON."));
            for (const [name, v] of Object.entries(input)) { if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error(t('Недопустимый ключ JSON.', "Invalid JSON key.")); validateJSON(v, seen); }
          } seen.delete(input);
        };
        validateJSON(value); drafts[key] = value;
      }
      const source = stableJSON({ formatVersion: 1, drafts });
      if (Buffer.byteLength(source) > 5_242_880) throw new Error(t('Локальные черновики превышают 5 MiB. Сохраните изменения перед продолжением.', "Local drafts exceed 5 MiB. Save your changes before continuing."));
      await this.repository.atomicText(`${this.repository.projectRoot(id)}/drafts.json`, source);
    });
    this.draftTail = next.catch(() => undefined); return next;
  }
  async loadView(): Promise<Partial<ViewState>> { return this.state.project ? this.repository.loadView(this.state.project.id) : {}; }
  async saveView(state: ViewState) { if (!this.state.project || this.repository.readOnly || this.disposed) return; await this.repository.saveView(this.state.project.id, state); }
}

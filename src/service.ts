import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { applyCommands, createProject, searchProject, DomainError } from './domain';
import type { Asset, Command, ID, Project, ResourceCandidate, SnapshotRecord, ViewState, VaultLink, WorkbenchService, WorkbenchSnapshot } from './types';
import { FileStore, digestFile, resolveSafe, safeRelative } from './storage/files';
import { ProjectRepository, digest, stableJSON, strictJSON } from './storage/repository';
import { exportProject, exportTraceWeaveArchive, stageImport, createReport, verifyReport } from './portability';
import { DATA_ROOT, NOTES_ROOT, RESOURCES_ROOT, isAllowedNotePath, isAllowedResourcePath } from './storage/layout';
import { migrateLegacyVault } from './storage/migration';
import { caseFold } from './casefold';

export interface Host {
 listNotes(): { path: string; title: string }[];
 openNote(path: string): Promise<void>;
 resourceUrl(path: string): string;
 showFile(path: string): Promise<void>;
 filePath(file: File): Promise<string>;
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
  constructor(readonly repository: ProjectRepository, readonly host: Host) { this.files = new FileStore(repository.vaultRoot); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private publish(change: Partial<WorkbenchSnapshot>) { this.state = Object.freeze({ ...this.state, ...change }); this.listeners.forEach(listener => listener()); }
  private project(): Project { if (!this.state.project) throw new DomainError('no_project', 'Сначала откройте исследование.'); return this.state.project; }
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      if (this.disposed) throw new Error('Плагин закрыт.');
      this.publish({ busy: true, error: null });
      try { return await task(); }
      catch (error) { this.publish({ error: error instanceof Error ? error.message : 'Операция не завершена.' }); throw error; }
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
    if (this.repository.metadataRoot === DATA_ROOT) await migrateLegacyVault(this.repository.vaultRoot);
    try { await this.repository.initialize(); } catch (error) { this.publish({ error: error instanceof Error ? error.message : 'Требуется восстановление.' }); }
    try { const value = strictJSON<{ notesRoot: string; resourcesRoot: string }>(await this.repository.readText(`${DATA_ROOT}/settings.json`, 16_384)); this.validatePaths(value); this.paths = value; this.files = new FileStore(this.repository.vaultRoot, DATA_ROOT, value.resourcesRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.refresh();
    if (this.repository.issues.length) this.publish({ error: this.repository.issues.join('\n') });
    if (this.state.projects[0]) { const p = await this.repository.read(this.state.projects[0].id); await this.refresh(p); if (!this.repository.needsRecovery) await this.reconcileProject(); }
  }
  private validatePaths(value: { notesRoot: string; resourcesRoot: string }) {
    for (const [root, allowed] of [[value.notesRoot, NOTES_ROOT], [value.resourcesRoot, RESOURCES_ROOT]]) { safeRelative(root); if (root !== allowed && !root.startsWith(allowed + '/')) throw new Error('Созданные плагином файлы должны оставаться в Исследования/Заметки и Исследования/Вложения.'); }
    const noteKey = value.notesRoot.normalize('NFC').toLowerCase(), resourceKey = value.resourcesRoot.normalize('NFC').toLowerCase();
    if (noteKey === resourceKey || noteKey.startsWith(resourceKey + '/') || resourceKey.startsWith(noteKey + '/')) throw new Error('Выберите раздельные папки заметок и материалов.');
  }
  configurePaths(value: { notesRoot: string; resourcesRoot: string }) { return this.run(async () => { this.validatePaths(value); await this.repository.atomicText(`${DATA_ROOT}/settings.json`, stableJSON(value)); this.paths = value; this.files = new FileStore(this.repository.vaultRoot, DATA_ROOT, value.resourcesRoot); }); }
  async dispose() { this.disposed = true; this.controller?.abort(); await this.tail; await this.draftTail; this.listeners.clear(); await this.repository.dispose(); }
  createProject(title: string) { return this.run(async () => { this.repository.assertWritable(); const project = createProject(title); await this.repository.add(project); await this.refresh(project); this.publish({ message: 'Исследование создано. Заметки остаются обычными Markdown-файлами.' }); }); }
  openProject(id: ID) { return this.run(async () => { const project = await this.repository.read(id); this.searchCache.clear(); await this.refresh(project); await this.reconcileProject(); }); }
  execute(commands: Command[]) { return this.run(async () => { const p = this.project(); const next = await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) }); await this.refresh(next); this.publish({ message: 'Метаданные сохранены.' }); }); }
  private notePath(p: Project, title: string, id: string) {
    const clean = (value: string) => [...value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, '-').trim().replace(/[. ]+$/gu, '')].slice(0, 70).join('') || 'Заметка';
    return `${this.paths.notesRoot}/${clean(p.title)}--${p.id.slice(0, 8)}/${clean(title)}--${id.slice(0, 8)}.md`;
  }
  createNote(title: string, typeId?: ID): Promise<ID> { return this.run(async () => {
    const p = this.project(), id = randomUUID(), notePath = this.notePath(p, title, id), after = '';
    const count = p.nodes.filter(n => !n.deletedAt).length;
    const next = await this.repository.execute(p.id, [{ kind: 'node.create', id, title, notePath, noteHash: digest(after), typeId, x: (count % 4) * 280, y: Math.floor(count / 4) * 150 }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), effects: [{ path: notePath, before: null, after }] });
    await this.refresh(next); this.publish({ message: 'Заметка создана. Текст редактируется в штатном редакторе.' }); return id;
  }); }
  createGroup(title: string, nodeIds: ID[]): Promise<ID> { return this.run(async () => {
    const p = this.project(), id = randomUUID(), notePath = this.notePath(p, title, id);
    const next = await this.repository.execute(p.id, [{ kind: 'group.create', id, title, notePath, nodeIds, noteHash: digest('') }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), effects: [{ path: notePath, before: null, after: '' }] });
    await this.refresh(next); return id;
  }); }
  private async assertUnbound(notePath: string, nodeId?: string) {
    const relative = caseFold(notePath), resources = caseFold(this.paths.resourcesRoot);
    if (relative === resources || relative.startsWith(resources + '/')) throw new DomainError('original_binding','Markdown в папке вложений нельзя подключить как заметку.');
    for (const summary of await this.repository.list()) {
      const project = await this.repository.read(summary.id);
      if (project.blobs.some(blob => caseFold(blob.path) === relative)) throw new DomainError('original_binding','Этот Markdown зарегистрирован как неизменяемый оригинал. Создайте отдельную копию для заметки.');
      if (project.nodes.some(n => n.id !== nodeId && caseFold(n.notePath) === relative)) throw new DomainError('already_bound', 'Эта заметка уже принадлежит исследованию. Сначала используйте существующий узел или создайте отдельную копию.');
    }
  }
  adoptNote(notePath: string) { return this.run(async () => {
    const p = this.project(); safeRelative(notePath); if (!isAllowedNotePath(notePath)) throw new DomainError('unsafe_note','Заметка должна находиться вне скрытых и служебных папок.'); await this.assertUnbound(notePath);
    const text = await this.repository.readText(notePath, 5_242_880); const id = randomUUID();
    const title = path.posix.basename(notePath, '.md');
    const next = await this.repository.execute(p.id, [{ kind: 'node.create', id, title, notePath, noteHash: digest(text), x: (p.nodes.length % 4) * 280, y: Math.floor(p.nodes.length / 4) * 150 }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) });
    await this.refresh(next); this.publish({ message: 'Заметка подключена без изменения текста или Properties.' });
  }); }
  async openNote(nodeId: ID) { const node = this.project().nodes.find(n => n.id === nodeId); if (!node) throw new Error('Документ не найден.'); if (node.missing) throw new Error('Файл заметки не найден. Переподключите его.'); await this.host.openNote(node.notePath); }
  async readNote(nodeId: ID) { const p = this.project(), node = p.nodes.find(n => n.id === nodeId); if (!node) throw new Error('Документ не найден.'); return this.repository.readText(node.notePath, 5_242_880); }
  listNotes() { const resources = caseFold(this.paths.resourcesRoot); return this.host.listNotes().filter(note => { const relative = caseFold(note.path); return isAllowedNotePath(note.path) && relative !== resources && !relative.startsWith(resources + '/'); }); }
  async resolveVaultLink(sourcePath: string, link: string): Promise<VaultLink | null> { if (!this.host.resolveVaultLink) throw new DomainError('host_unavailable', 'Хост не предоставляет разрешение ссылок Obsidian.'); return this.host.resolveVaultLink(sourcePath, link); }
  async openVaultLink(sourcePath: string, link: string): Promise<void> { if (!this.host.openVaultLink) throw new DomainError('host_unavailable', 'Хост не предоставляет открытие ссылок Obsidian.'); await this.host.openVaultLink(sourcePath, link); }
  relinkNote(nodeId: ID, notePath: string) { return this.run(async () => {
    const p = this.project(); safeRelative(notePath); if (!isAllowedNotePath(notePath)) throw new DomainError('unsafe_note','Заметка должна находиться вне скрытых и служебных папок.'); await this.assertUnbound(notePath, nodeId); const text = await this.repository.readText(notePath, 5_242_880);
    const next = await this.repository.execute(p.id, [{ kind: 'node.update', nodeId, changes: { notePath, noteHash: digest(text), missing: false } }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)), kind: 'reconcile' });
    await this.refresh(next); this.publish({ message: 'Файл переподключён. Идентичность узла и его связи сохранены.' });
  }); }
  async onRenamed(newPath: string, oldPath: string) { return this.run(async () => {
    safeRelative(newPath); safeRelative(oldPath);
    for (const summary of await this.repository.list()) {
      const p = await this.repository.read(summary.id);
      const affected = p.nodes.filter(n => n.notePath === oldPath || n.notePath.startsWith(oldPath + '/'));
      if (affected.some(node => !isAllowedNotePath(newPath + node.notePath.slice(oldPath.length)))) throw new DomainError('unsafe_note','Заметку нельзя переместить в скрытую или служебную папку.');
      const commands: Command[] = affected.map(n => ({ kind: 'node.update', nodeId: n.id, changes: { notePath: newPath + n.notePath.slice(oldPath.length), missing: false } }));
      const blobs = p.blobs.filter(blob => blob.path === oldPath || blob.path.startsWith(oldPath + '/'));
      let replacement: Project | undefined;
      if (blobs.length) {
        this.repository.assertWritable(p.id); replacement = commands.length ? applyCommands(p,commands) : structuredClone(p);
        for (const blob of blobs) {
          const nextPath = newPath + blob.path.slice(oldPath.length); if (!isAllowedResourcePath(nextPath)) throw new DomainError('unsafe_path','Оригинал нельзя переместить в скрытую или служебную папку.');
          if (await this.files.verify({...blob,path:nextPath}) !== 'ok') throw new DomainError('original_conflict','Оригинал после переименования недоступен или изменён. Привязка не изменена.');
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
      this.publish({ message: next.nodes.some(n => n.missing) ? 'Есть недоступные заметки. Связи сохранены; выберите файл через переподключение.' : 'Внешние изменения заметок приняты.' });
    }
  }
  importFiles(files: File[], nodeId?: ID) { return this.run(async () => {
    this.repository.assertWritable(this.project().id); this.controller = new AbortController();
    try {
      for (const file of files) {
        this.controller.signal.throwIfAborted(); const p = this.project(); if (p.status === 'archived') throw new Error('Исследование в архиве.');
        const source = await this.host.filePath(file);
        const { blob, originalName } = await this.files.importFile(source, p.id, p.blobs, { signal: this.controller.signal, originalName: file.name, onProgress: (completed, total) => this.publish({ progress: { name: file.name, completed, total } }) });
        const asset = this.asset(blob, originalName);
        const commands: Command[] = [{ kind: 'asset.register', asset, blob }];
        if (nodeId) commands.push({ kind: 'attachment.attach', attachment: { id: randomUUID(), nodeId, assetId: asset.id, role: p.attachments.some(a => a.nodeId === nodeId && a.role === 'primary') ? 'attachment' : 'primary', sortOrder: p.attachments.filter(a => a.nodeId === nodeId).length, caption: null } });
        await this.refresh(await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) }));
      }
      this.publish({ message: 'Все выбранные материалы зарегистрированы.' });
    } finally { this.controller = null; }
  }); }
  cancelImport() { this.controller?.abort(); }
  private asset(blob: Project['blobs'][number], name: string): Asset { return { id: randomUUID(), blobId: blob.id, originalName: name, title: [...name].slice(0, 200).join(''), mimeType: blob.mimeType, mediaKind: blob.mediaKind, byteSize: blob.byteSize, sha256: blob.sha256, createdAt: new Date().toISOString(), deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: '', origin: { kind: 'manual' } }; }
  async discoverResources(): Promise<ResourceCandidate[]> {
    const p = this.project(), relative = this.paths.resourcesRoot, root = await resolveSafe(this.repository.vaultRoot, relative);
    const registered = new Set(p.blobs.map(b => b.path)), found: ResourceCandidate[] = [];
    const walk = async (directory: string, rel: string) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const e of entries) { if (found.length >= 50_000) throw new Error('Каталог превышает лимит 50000 файлов.'); if (e.isSymbolicLink()) continue; const next = `${rel}/${e.name}`; if (e.isDirectory()) await walk(path.join(directory, e.name), next); else if (e.isFile()) found.push({ path: next, byteSize: (await fs.stat(await resolveSafe(this.repository.vaultRoot, next))).size, registered: registered.has(next) }); }
    };
    try { await walk(root, relative); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return found;
  }
  registerResource(relative: string, nodeId?: ID) { return this.run(async () => {
    const p = this.project(); this.repository.assertWritable(p.id); if (p.status === 'archived') throw new Error('Исследование в архиве.'); if (!relative.startsWith(`${this.paths.resourcesRoot}/`)) throw new Error('Файл находится вне настроенной папки материалов.');
    if (p.blobs.some(b => b.path === relative)) throw new Error('Файл уже зарегистрирован. Прикрепите его из библиотеки.');
    const source = await resolveSafe(this.repository.vaultRoot, relative);
    const result = await this.files.importFile(source, p.id, p.blobs); const asset = this.asset(result.blob, path.posix.basename(relative));
    const commands: Command[] = [{ kind: 'asset.register', asset, blob: result.blob }];
    if (nodeId) commands.push({ kind: 'attachment.attach', attachment: { id: randomUUID(), nodeId, assetId: asset.id, role: 'attachment', sortOrder: p.attachments.filter(a => a.nodeId === nodeId).length, caption: null } });
    await this.refresh(await this.repository.execute(p.id, commands, { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) }));
  }); }
  resourceUrl(assetId: ID) { const p = this.project(), asset = p.assets.find(a => a.id === assetId), blob = p.blobs.find(b => b.id === asset?.blobId); if (!blob) throw new Error('Материал недоступен.'); return this.host.resourceUrl(blob.path); }
  async showAsset(assetId: ID) { const p = this.project(), asset = p.assets.find(a => a.id === assetId), blob = p.blobs.find(b => b.id === asset?.blobId); if (!blob || !asset) throw new Error('Материал не найден.'); if (asset.mimeType === 'application/pdf') await this.host.openNote(blob.path); else await this.host.showFile(blob.path); }
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
    if (p.status === 'archived') throw new Error('Создание нового снимка недоступно в архивном исследовании.');
    const snapshot = await createReport(this.repository.vaultRoot, p, title, nodeIds);
    await this.refresh(await this.repository.execute(p.id, [{ kind: 'snapshot.register', snapshot }], { baseRevision: p.revision, expectedStateHash: digest(stableJSON(p)) })); return snapshot;
  }); }
  async openReport(id: ID) { const report = this.project().snapshots.find(s => s.id === id); if (!report) throw new Error('Снимок не найден.'); await verifyReport(this.repository.vaultRoot, report); await this.host.openNote(report.path.replace(/snapshot\.json$/u, 'report.md')); }
  exportProject(): Promise<string> { return this.run(async () => {
    this.repository.assertWritable(this.project().id); await this.reconcileProject(); const p = this.project();
    const relative = `${DATA_ROOT}/exports/${p.id}-${p.revision}-${randomUUID()}.zip`, absolute = await resolveSafe(this.repository.vaultRoot, relative, true);
    await exportProject(this.repository.vaultRoot, p, absolute); await this.host.showFile(relative); this.publish({ message: 'Полная переносимая копия создана.' }); return relative;
  }); }
  exportTraceWeave(): Promise<string> { return this.run(async () => {
    this.repository.assertWritable(this.project().id); await this.reconcileProject(); const p = this.project();
    const relative = `${DATA_ROOT}/exports/traceweave-${p.id}-${p.revision}-${randomUUID()}.zip`, absolute = await resolveSafe(this.repository.vaultRoot, relative, true);
    await exportTraceWeaveArchive(this.repository.vaultRoot, p, absolute); await this.host.showFile(relative); this.publish({ message: 'Архив TraceWeave 2.0 создан.' }); return relative;
  }); }
  importArchive(file: File) { return this.run(async () => {
    this.repository.assertWritable(); const staged = await stageImport(this.repository.vaultRoot, await this.host.filePath(file));
    try { await staged.commit(); await this.repository.add(staged.project); }
    catch (error) { this.publish({ message: 'Импорт не опубликован. Подготовленные файлы сохранены для восстановления; исходные заметки не перезаписаны.' }); throw error; }
    await this.refresh(staged.project); const warnings = staged.project.importedData.warnings; this.publish({ message: 'Проект импортирован с новыми ID.' + (Array.isArray(warnings) && warnings.length ? '\n' + warnings.join('\n') : '') });
  }); }
  undo() { return this.run(async () => { const p = this.project(); if (p.status === 'archived') throw new Error('История недоступна в архиве.'); await this.refresh(await this.repository.undoRedo(p, 'undo')); }); }
  redo() { return this.run(async () => { const p = this.project(); if (p.status === 'archived') throw new Error('История недоступна в архиве.'); await this.refresh(await this.repository.undoRedo(p, 'redo')); }); }
  recover() { return this.run(async () => { await this.repository.recover(); if (this.state.project) await this.refresh(await this.repository.read(this.state.project.id)); else await this.refresh(); if (this.state.project) await this.reconcileProject(); this.publish({ message: 'Проверка завершена. Подтверждённое состояние загружено.' }); }); }
  async loadDrafts(projectId?: ID): Promise<Record<string, unknown>> {
    const id = projectId ?? this.state.project?.id; if (!id) return {};
    await this.repository.read(id);
    try { const stored = strictJSON<{ formatVersion: number; drafts: Record<string, unknown> }>(await this.repository.readText(`${this.repository.projectRoot(id)}/drafts.json`, 5_242_880));
      if (stored.formatVersion !== 1 || !stored.drafts || typeof stored.drafts !== 'object' || Array.isArray(stored.drafts) || Object.keys(stored.drafts).some(k => !k.startsWith(id + '/'))) throw new Error('Неверный формат локальных черновиков.');
      return stored.drafts;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  saveDraft(key: string, value: unknown | null): Promise<void> {
    const id = key.split('/')[0];
    const next = this.draftTail.then(async () => {
      if (!id || key.length > 1024 || /[\x00-\x1f]/u.test(key)) throw new Error('Неверный ключ черновика.');
      const drafts = await this.loadDrafts(id);
      if (value === null) delete drafts[key]; else {
        const validateJSON = (input: unknown, seen = new Set<object>()): void => {
          if (input === null || typeof input === 'string' || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) return;
          if (!input || typeof input !== 'object' || seen.has(input)) throw new Error('Черновик содержит неподдерживаемое JSON-значение.');
          seen.add(input); if (Array.isArray(input)) input.forEach(v => validateJSON(v, seen)); else {
            if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error('Черновик должен содержать обычный JSON.');
            for (const [name, v] of Object.entries(input)) { if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Недопустимый ключ JSON.'); validateJSON(v, seen); }
          } seen.delete(input);
        };
        validateJSON(value); drafts[key] = value;
      }
      const source = stableJSON({ formatVersion: 1, drafts });
      if (Buffer.byteLength(source) > 5_242_880) throw new Error('Локальные черновики превышают 5 MiB. Сохраните изменения перед продолжением.');
      await this.repository.atomicText(`${this.repository.projectRoot(id)}/drafts.json`, source);
    });
    this.draftTail = next.catch(() => undefined); return next;
  }
  async loadView(): Promise<Partial<ViewState>> { return this.state.project ? this.repository.loadView(this.state.project.id) : {}; }
  async saveView(state: ViewState) { if (!this.state.project || this.repository.readOnly || this.disposed) return; await this.repository.saveView(this.state.project.id, state); }
}

import { localeCode, t } from '../i18n';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, visit, type ParseError } from 'jsonc-parser';
import { applyCommands, validateProject, DomainError } from '../domain';
import type { Command, Project, ProjectSummary, ViewState } from '../types';
import { resolveSafe, requireId, safeRelative } from './files';
import { validateRecord } from './records';
import { DATA_ROOT, LEGACY_METADATA_ROOT, TRANSITIONAL_METADATA_ROOT, isAllowedNotePath } from './layout';

export const METADATA_ROOT = DATA_ROOT;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function strictJSON<T>(source: string): T {
  if (source.startsWith('\uFEFF')) source = source.slice(1);
  const errors: ParseError[] = [], stack: Set<string>[] = [];
  visit(source, {
    onObjectBegin() { stack.push(new Set()); },
    onObjectProperty(name) { const current = stack.at(-1)!; if (current.has(name)) throw new DomainError('invalid_json', t('Повторяющийся ключ JSON.', "Duplicate JSON object key.")); current.add(name); },
    onObjectEnd() { stack.pop(); },
  }, { disallowComments: true, allowTrailingComma: false });
  const value = parse(source, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length) throw new DomainError('invalid_json', t('Некорректный JSON. Файл не изменён.', "Invalid JSON. The file was not changed."));
  return value as T;
}
export function stableJSON(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}
export interface TextEffect { path: string; before: string | null; after: string }
export type HistoryKind = 'command' | 'undo' | 'redo' | 'reconcile' | 'barrier';
interface History { formatVersion: 1; operationId: string; kind: HistoryKind; target?: string; before: Project; after: Project }
interface Journal { formatVersion: 1; projectId: string; operationId: string; beforeHash: string; afterHash: string; state: Project; effects: TextEffect[]; history: History; completed: boolean }
export interface ExecuteOptions { operationId?: string; baseRevision?: number; expectedStateHash?: string; effects?: TextEffect[]; kind?: HistoryKind; target?: string; replace?: Project }
export type FaultPoint = 'after-journal' | 'after-files' | 'after-history' | 'after-state';

export class ProjectRepository {
  readonly metadataRoot: string;
  readonly issues: string[] = [];
  readonly instanceId = randomUUID();
  readonly fault?: (point: FaultPoint) => void;
  readonly noteCreator?: (relative: string, text: string) => Promise<void>;
  readOnly = false;
  private lockOwned = false;
  private readonly pendingProjects = new Set<string>();
  get needsRecovery() { return this.pendingProjects.size > 0; }
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly vaultRoot: string, options: { fault?: (point: FaultPoint) => void; createNote?: (relative: string, text: string) => Promise<void>; metadataRoot?: string } = {}) { this.fault = options.fault; this.noteCreator = options.createNote; this.metadataRoot = options.metadataRoot ?? METADATA_ROOT; if (![DATA_ROOT, TRANSITIONAL_METADATA_ROOT, LEGACY_METADATA_ROOT].includes(this.metadataRoot)) throw new DomainError('layout', t('Неподдерживаемая папка метаданных.', "Unsupported metadata folder.")); }
  projectRoot(id: string) { requireId(id); return `${this.metadataRoot}/projects/${id}`; }
  statePath(id: string) { return `${this.projectRoot(id)}/state.json`; }
  async initialize() {
    await fs.mkdir(await resolveSafe(this.vaultRoot, `${this.metadataRoot}/projects`, true), { recursive: true });
    const lockPath = await resolveSafe(this.vaultRoot, `${this.metadataRoot}/writer.lock`);
    try { await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: this.instanceId }), { flag: 'wx', mode: 0o600 }); this.lockOwned = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const value = strictJSON<{ pid: number; instanceId: string }>(await fs.readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw new DomainError('writer_lock', t('Повреждён writer.lock. Проверьте, что другой Obsidian закрыт; сохраните копию файла перед ручным восстановлением.', "writer.lock is corrupt. Ensure the other Obsidian instance is closed; keep a copy before manual recovery."));
      let alive = true;
      try { process.kill(value.pid, 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else if ((failure as NodeJS.ErrnoException).code !== 'EPERM') throw failure; }
      if (alive) { this.readOnly = true; this.issues.push(t('Другое окно или процесс владеет записью TraceWeave. Доступно чтение.', "Another window or process owns TraceWeave write access. Read-only access is available.")); }
      else {
        const retained = await resolveSafe(this.vaultRoot, `${this.metadataRoot}/recovery/locks/${randomUUID()}.json`, true);
        await fs.rename(lockPath, retained);
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: this.instanceId }), { flag: 'wx', mode: 0o600 }); this.lockOwned = true;
      }
    }
    if (!this.readOnly) await this.recover();
  }
  async dispose() {
    await this.tail;
    if (this.lockOwned) {
      const file = await resolveSafe(this.vaultRoot, `${this.metadataRoot}/writer.lock`);
      let source: string; try { source = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.lockOwned = false; return; } throw error; }
      const lock = strictJSON<{ instanceId: string }>(source);
      if (lock.instanceId === this.instanceId) await fs.unlink(file);
      this.lockOwned = false;
    }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.then(fn); this.tail = next.catch(() => undefined); return next; }
  assertWritable(projectId?: string) { this.assertWriter(); if (projectId && this.pendingProjects.has(projectId)) throw new DomainError('recovery_required', t('Есть незавершённая операция. Сначала выполните восстановление.', "There is an incomplete operation. Run recovery first.")); }
  private assertWriter() { if (this.readOnly || !this.lockOwned) throw new DomainError('read_only', t('Запись этого хранилища недоступна. Закройте другой экземпляр и откройте плагин заново.', "Write access to this vault is unavailable. Close the other instance and reopen the plugin.")); }
  async readText(relative: string, maxBytes = MAX_STATE_BYTES): Promise<string> {
    const filename = await resolveSafe(this.vaultRoot, relative);
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > maxBytes) throw new DomainError('file_limit', t('Файл превышает допустимый размер.', "The file exceeds the size limit.")); return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.readFile()); }
    finally { await file.close(); }
  }
  async read(id: string): Promise<Project> { const raw = await this.readText(this.statePath(id)); const state = strictJSON<Project>(raw); validateProject(state); if (state.id !== id) throw new DomainError('identity', t('ID проекта и его папка различаются.', "The project ID does not match its folder.")); return state; }
  async list(): Promise<ProjectSummary[]> {
    const root = await resolveSafe(this.vaultRoot, `${this.metadataRoot}/projects`);
    const items = await fs.readdir(root, { withFileTypes: true }); const result: ProjectSummary[] = [];
    for (const item of items) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      try { requireId(item.name); const p = await this.read(item.name); result.push({ id: p.id, title: p.title, status: p.status, revision: p.revision }); }
      catch (error) { this.issues.push(t(`Проект ${item.name}: ${error instanceof Error ? error.message : 'не удалось прочитать'}`, `Project ${item.name}: ${error instanceof Error ? error.message : 'could not read'}`)); }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title, localeCode()));
  }
  async atomicText(relative: string, text: string) {
    this.assertWriter();
    const filename = await resolveSafe(this.vaultRoot, relative, true), temporary = `${filename}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(text, 'utf8'); await file.sync(); }
    catch (error) { await file.close(); await fs.rm(temporary, { force: true }); throw error; }
    await file.close();
    try { await fs.rename(temporary, filename); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    const parent = await fs.open(path.dirname(filename), 'r');
    try { await parent.sync(); } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    finally { await parent.close(); }
  }
  async add(project: Project): Promise<Project> {
    return this.exclusive(async () => {
      this.assertWriter(); validateProject(project);
      try { await fs.lstat(await resolveSafe(this.vaultRoot, this.statePath(project.id))); throw new DomainError('already_exists', t('Проект уже существует.', "The project already exists.")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.atomicText(this.statePath(project.id), stableJSON(project)); return project;
    });
  }
  async execute(id: string, commands: Command[], options: ExecuteOptions = {}): Promise<Project> {
    return this.exclusive(async () => {
      this.assertWriter(); if (this.pendingProjects.has(id)) throw new DomainError('recovery_required', t('Есть незавершённая операция. Сначала проверьте восстановление.', "There is an incomplete operation. Check recovery first.")); const source = await this.readText(this.statePath(id)); const before = strictJSON<Project>(source); validateProject(before); if (before.id !== id) throw new DomainError('identity', t('ID проекта и его папка различаются.', "The project ID does not match its folder."));
      const operationId = options.operationId ?? randomUUID(); requireId(operationId);
      const requestHash = digest(stableJSON({ commands, replace: options.replace ?? null, effects: options.effects ?? [], kind: options.kind ?? 'command', target: options.target ?? null }));
      const previous = before.receipts[operationId];
      if (previous) { if (previous.hash !== requestHash) throw new DomainError('idempotency_mismatch', t('ID операции уже использован с другим содержимым.', "The operation ID was already used with different content.")); return before; }
      if (options.expectedStateHash !== undefined && options.expectedStateHash !== digest(stableJSON(before))) throw new DomainError('revision_conflict', t('JSON изменён извне без новой ревизии. Обновите данные перед сохранением.', "JSON was changed externally without a new revision. Refresh the data before saving."));
      if (options.baseRevision !== undefined && options.baseRevision !== before.revision) throw new DomainError('revision_conflict', t('Проект изменился. Обновите представление перед сохранением.', "The project changed. Refresh the view before saving."));
      const timestamp = new Date().toISOString();
      const next = options.replace ? { ...structuredClone(options.replace), id: before.id, receipts: structuredClone(before.receipts), revision: before.revision + 1, updatedAt: timestamp } : applyCommands(before, commands, timestamp);
      if (next.revision !== before.revision + 1) throw new DomainError('revision', t('Команда не изменила ревизию ровно один раз.', "The command did not increment the revision exactly once."));
      next.receipts[operationId] = { hash: requestHash, revision: next.revision, timestamp };
      validateProject(next);
      const effects = options.effects ?? [];
      this.validateEffects(next, effects);
      for (const effect of effects) {
        safeRelative(effect.path);
        if (!isAllowedNotePath(effect.path, this.metadataRoot !== DATA_ROOT)) throw new DomainError('unsafe_note', t('Путь заметки выходит в служебную папку.', "The note path enters a metadata folder."));
        if (Buffer.byteLength(effect.after) > 5_242_880) throw new DomainError('file_limit', t('Заметка превышает 5 MiB.', "The note exceeds 5 MiB."));
        let actual: string | null = null;
        try { actual = await this.readText(effect.path, 5_242_880); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (actual !== effect.before) throw new DomainError('note_conflict', t('Заметка уже существует или изменилась. Исходный файл сохранён.', "The note already exists or has changed. The original file was preserved."));
      }
      const afterSource = stableJSON(next);
      const history: History = { formatVersion: 1, operationId, kind: options.kind ?? (commands.some(c => c.kind === 'snapshot.register') ? 'barrier' : 'command'), target: options.target, before, after: next };
      const journal: Journal = { formatVersion: 1, projectId: id, operationId, beforeHash: digest(source), afterHash: digest(afterSource), state: next, effects, history, completed: false };
      const journalPath = `${this.projectRoot(id)}/journal/${operationId}.json`;
      await this.atomicText(journalPath, stableJSON(journal)); this.pendingProjects.add(id); this.fault?.('after-journal');
      await this.applyEffects(effects); this.fault?.('after-files');
      await this.atomicText(`${this.projectRoot(id)}/history/${operationId}.json`, stableJSON(history)); this.fault?.('after-history');
      if (digest(await this.readText(this.statePath(id))) !== journal.beforeHash) throw new DomainError('revision_conflict', t('JSON проекта изменён извне. Журнал сохранён для сверки.', "Project JSON changed externally. The journal was preserved for comparison."));
      await this.atomicText(`${this.projectRoot(id)}/recovery/previous-state.json`, source);
      await this.atomicText(this.statePath(id), afterSource); this.fault?.('after-state');
      await this.atomicText(journalPath, stableJSON({ ...journal, completed: true }));
      this.pendingProjects.delete(id);
      return next;
    });
  }
  private validateEffects(project: Project, effects: TextEffect[]) {
    if (!Array.isArray(effects) || effects.length > 1000) throw new DomainError('journal', t('Некорректное число файловых изменений.', "Invalid number of file changes."));
    const names = new Set<string>(); let total = 0;
    for (const effect of effects) {
      if (!effect || typeof effect.path !== 'string' || typeof effect.after !== 'string' || (effect.before !== null && typeof effect.before !== 'string')) throw new DomainError('journal', t('Некорректный файловый эффект.', "Invalid file effect."));
      safeRelative(effect.path); const key = effect.path.normalize('NFC').toLowerCase();
      if (names.has(key) || !isAllowedNotePath(effect.path, this.metadataRoot !== DATA_ROOT)) throw new DomainError('journal', t('Небезопасный или повторяющийся путь заметки.', "Unsafe or duplicate note path."));
      names.add(key); total += Buffer.byteLength(effect.after) + (effect.before === null ? 0 : Buffer.byteLength(effect.before));
      if (Buffer.byteLength(effect.after) > 5_242_880 || (effect.before !== null && Buffer.byteLength(effect.before) > 5_242_880) || total > 33_554_432 || !project.nodes.some(n => n.notePath === effect.path && n.noteHash === digest(effect.after))) throw new DomainError('journal', t('Файловый эффект не соответствует документу и его контрольной сумме.', "The file effect does not match the document and its checksum."));
    }
  }
  private async applyEffects(effects: TextEffect[]) {
    for (const effect of effects) {
      let actual: string | null = null;
      try { actual = await this.readText(effect.path, 5_242_880); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (actual === effect.after) continue;
      if (actual !== effect.before) throw new DomainError('note_conflict', t('Внешняя правка не совпадает с журналом; автоматическая перезапись остановлена.', "An external edit does not match the journal; automatic overwriting was stopped."));
      if (effect.before === null && this.noteCreator) {
        await resolveSafe(this.vaultRoot, effect.path);
        await this.noteCreator(effect.path, effect.after);
      } else if (effect.before === null) {
        const filename = await resolveSafe(this.vaultRoot, effect.path, true); const file = await fs.open(filename, 'wx', 0o600);
        try { await file.writeFile(effect.after, 'utf8'); await file.sync(); } finally { await file.close(); }
      } else await this.atomicText(effect.path, effect.after);
    }
  }
  async recover(): Promise<void> {
    this.assertWriter();
    const projects = await fs.readdir(await resolveSafe(this.vaultRoot, `${this.metadataRoot}/projects`), { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      requireId(project.name); const folder = `${this.projectRoot(project.name)}/journal`;
      let files: string[];
      try { files = await fs.readdir(await resolveSafe(this.vaultRoot, folder)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const records: { path: string; journal: Journal }[] = [];
      this.pendingProjects.add(project.name);
      for (const file of files.filter(f => f.endsWith('.json'))) {
        const relative = `${folder}/${file}`, journal = strictJSON<Journal>(await this.readText(relative, 192 * 1024 * 1024));
        validateRecord('journal', journal);
        if (journal.formatVersion !== 1 || journal.projectId !== project.name || journal.operationId + '.json' !== file) throw new DomainError('journal', t('Неверный формат журнала. Требуется ручное восстановление из копии.', "Invalid journal format. Manual recovery from a backup is required."));
        if (!journal.completed) { this.pendingProjects.add(project.name); records.push({ path: relative, journal }); }
      }
      records.sort((a, b) => a.journal.state.revision - b.journal.state.revision);
      for (const { path: relative, journal } of records) {
        validateProject(journal.state); validateProject(journal.history.before); validateProject(journal.history.after); requireId(journal.operationId);
        if (digest(stableJSON(journal.state)) !== journal.afterHash || stableJSON(journal.history.after) !== stableJSON(journal.state) || journal.history.operationId !== journal.operationId || journal.history.before.id !== project.name || journal.state.id !== project.name || journal.state.revision !== journal.history.before.revision + 1 || journal.state.receipts[journal.operationId]?.revision !== journal.state.revision) throw new DomainError('journal', t('Содержимое журнала не соответствует контрольным суммам.', "Journal contents do not match their checksums."));
        this.validateEffects(journal.state, journal.effects);
        if (!Array.isArray(journal.effects)) throw new DomainError('journal', t('Повреждены файловые эффекты журнала.', "The journal's file effects are corrupt."));
        for (const effect of journal.effects) {
          safeRelative(effect.path);
          if (!isAllowedNotePath(effect.path, this.metadataRoot !== DATA_ROOT) || typeof effect.after !== 'string' || (effect.before !== null && typeof effect.before !== 'string') || Buffer.byteLength(effect.after) > 5_242_880 || !journal.state.nodes.some(n => n.notePath === effect.path)) throw new DomainError('journal', t('Небезопасный путь или содержимое заметки в журнале.', "Unsafe note path or content in the journal."));
        }
        const currentSource = await this.readText(this.statePath(project.name)); const hash = digest(currentSource);
        const current = strictJSON<Project>(currentSource); validateProject(current);
        if (hash === journal.afterHash || current.receipts[journal.operationId]?.hash === journal.state.receipts[journal.operationId]?.hash) {
          for (const effect of journal.effects) { const text = await this.readText(effect.path, 5_242_880); if (text !== effect.after) throw new DomainError('recovery_conflict', t('Принятая заметка изменилась после прерванной операции. Сверьте файл с журналом.', "The accepted note changed after an interrupted operation. Compare the file with the journal.")); }
        } else if (hash === journal.beforeHash) {
          await this.applyEffects(journal.effects);
          await this.atomicText(`${this.projectRoot(project.name)}/history/${journal.operationId}.json`, stableJSON(journal.history));
          await this.atomicText(this.statePath(project.name), stableJSON(journal.state));
        } else throw new DomainError('recovery_conflict', t('JSON изменён вне незавершённой операции. Сохранён журнал; автоматическое восстановление остановлено.', "JSON changed outside the incomplete operation. The journal was preserved; automatic recovery was stopped."));
        await this.atomicText(relative, stableJSON({ ...journal, completed: true }));
      }
      this.pendingProjects.delete(project.name);
    }
  }
  async historyState(project: Project): Promise<{ undo: string[]; redo: string[] }> {
    const folder = `${this.projectRoot(project.id)}/history`; let files: string[];
    try { files = await fs.readdir(await resolveSafe(this.vaultRoot, folder)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { undo: [], redo: [] }; throw error; }
    const records: History[] = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const h = strictJSON<History>(await this.readText(`${folder}/${f}`, 192 * 1024 * 1024));
      validateRecord('history', h);
      if (h.formatVersion !== 1 || !h.after || !h.before || h.operationId + '.json' !== f) throw new DomainError('history', t('Повреждён журнал истории.', "The history journal is corrupt."));
      if (project.receipts[h.operationId]?.revision === h.after.revision) records.push(h);
    }
    records.sort((a, b) => a.after.revision - b.after.revision);
    const undo: string[] = [], redo: string[] = []; let last = 0;
    for (const record of records) {
      if (record.before.revision !== last) { undo.length = 0; redo.length = 0; }
      if (record.kind === 'command') { undo.push(record.operationId); redo.length = 0; }
      else if (record.kind === 'undo' && undo.at(-1) === record.target) redo.push(undo.pop()!);
      else if (record.kind === 'redo' && redo.at(-1) === record.target) undo.push(redo.pop()!);
      else { undo.length = 0; redo.length = 0; }
      last = record.after.revision;
    }
    if (last !== project.revision) return { undo: [], redo: [] };
    return { undo: undo.slice(-100), redo: redo.slice(-100) };
  }
  async undoRedo(project: Project, kind: 'undo' | 'redo'): Promise<Project> {
    const stacks = await this.historyState(project), target = stacks[kind].at(-1);
    if (!target) throw new DomainError('history_empty', t('Нет доступного действия истории.', "No history action is available."));
    const h = strictJSON<History>(await this.readText(`${this.projectRoot(project.id)}/history/${target}.json`, 192 * 1024 * 1024));
    validateRecord('history', h);
    return this.execute(project.id, [], { baseRevision: project.revision, expectedStateHash: digest(stableJSON(project)), replace: kind === 'undo' ? h.before : h.after, kind, target });
  }
  async loadView(id: string): Promise<Partial<ViewState>> {
    try { const value = strictJSON<ViewState>(await this.readText(`${this.projectRoot(id)}/view.json`, 64 * 1024)); return value && typeof value === 'object' ? value : {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async saveView(id: string, state: ViewState) { await this.atomicText(`${this.projectRoot(id)}/view.json`, stableJSON(state)); }
}

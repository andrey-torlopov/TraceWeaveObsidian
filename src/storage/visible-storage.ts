import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BlobRecord, Project } from '../types';
import { DomainError } from '../domain';
import { t } from '../i18n';
import { caseFold } from '../casefold';
import { copyChecked, digestFile, FileStore, requireId, resolveSafe, safeRelative, visibleBlobPath } from './files';
import { DEFAULT_VISIBLE_ROOT, isConfigurationPath, isTechnicalPath, safeVisibleName } from './layout';
import { ProjectRepository, stableJSON, strictJSON } from './repository';

export interface VisibleStoragePlan { formatVersion: 2; dataRoot: string; projectFolders: Record<string, string> }
type Settings = VisibleStoragePlan;
function isReservedProjectFolder(root: string, folder: string, configDir?: string): boolean {
  // Use the default-root policy for custom roots too, including case-insensitive filesystems.
  return isTechnicalPath(`${root}/projects/${folder}`, configDir) || isTechnicalPath(`${DEFAULT_VISIBLE_ROOT}/projects/${folder.toLowerCase()}`);
}
export function validateVisibleRoot(value: string, configDir?: string): string {
  if (typeof value !== 'string') throw new DomainError('unsafe_path', t('Папка данных должна быть строкой.', 'The data folder must be a string.'));
  safeRelative(value, configDir);
  const parts = value.split('/');
  if (isTechnicalPath(value, configDir) || /[<>"|?*#]/u.test(value) || parts.some((part, index) => (part.toLowerCase() === 'twdata' && index !== parts.length - 1) || Buffer.byteLength(part) > 200 || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)) || (configDir && isConfigurationPath(configDir, value))) throw new DomainError('unsafe_path', t('Выберите видимую папку вне настроек и служебных данных.', 'Choose a visible folder outside configuration and metadata.'));
  return value;
}
export function validateVisibleStoragePlan(value: unknown, configDir?: string): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid visible storage settings');
  const entry = value as Record<string, unknown>;
  if (entry.formatVersion !== 2 || Object.keys(entry).some(key => !['formatVersion', 'dataRoot', 'projectFolders'].includes(key)) || typeof entry.dataRoot !== 'string' || !entry.projectFolders || typeof entry.projectFolders !== 'object' || Array.isArray(entry.projectFolders)) throw new Error('Invalid visible storage settings');
  validateVisibleRoot(entry.dataRoot, configDir);
  const projectFolders: Record<string, string> = {}, used = new Set<string>();
  for (const [id, folder] of Object.entries(entry.projectFolders)) {
    requireId(id);
    if (typeof folder !== 'string' || folder.includes('/') || folder.startsWith('.') || /[<>:"\\|?*#]/u.test(folder) || Buffer.byteLength(folder) > 180 || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(folder) || isReservedProjectFolder(entry.dataRoot, folder, configDir) || used.has(caseFold(folder))) throw new Error('Invalid or duplicate visible project folder');
    safeRelative(folder); used.add(caseFold(folder)); projectFolders[id] = folder;
  }
  return { formatVersion: 2, dataRoot: entry.dataRoot, projectFolders };
}

/** One persisted registry gives duplicate titles readable folders and keeps them stable after renaming. */
export class VisibleStorage {
  private settings: Settings = { formatVersion: 2, dataRoot: DEFAULT_VISIBLE_ROOT, projectFolders: {} };
  private readonly preparedRoots = new Map<string, { base: string; plan: VisibleStoragePlan }>();
  constructor(readonly repository: ProjectRepository) {}
  get dataRoot(): string { return this.settings.dataRoot; }
  get projectsRoot(): string { return `${this.dataRoot}/projects`; }
  get exportsRoot(): string { return `${this.dataRoot}/exports`; }
  async initialize(): Promise<void> {
    let converted = false;
    try {
      const value = strictJSON<unknown>(await this.repository.readText(`${this.repository.metadataRoot}/settings.json`, 1_048_576));
      const old = value as Record<string, unknown> | null;
      if (old && typeof old === 'object' && !Array.isArray(old) && Object.keys(old).every(key => ['notesRoot', 'resourcesRoot'].includes(key)) && typeof old.notesRoot === 'string' && typeof old.resourcesRoot === 'string') {
        safeRelative(old.notesRoot, this.repository.configDir); safeRelative(old.resourcesRoot, this.repository.configDir); converted = true;
      } else this.settings = validateVisibleStoragePlan(value, this.repository.configDir);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; converted = true; }
    validateVisibleRoot(this.dataRoot, this.repository.configDir);
    if (!this.repository.readOnly) {
      this.repository.assertWritable(); await this.ensureRoot(this.dataRoot);
      if (converted) await this.persist(this.settings);
    }
  }
  private async ensureRoot(root: string): Promise<void> {
    for (const name of ['projects', 'exports']) await fs.mkdir(await resolveSafe(this.repository.vaultRoot, `${root}/${name}`, true, this.repository.configDir), { recursive: true });
  }
  private async persist(settings: Settings): Promise<void> { await this.repository.atomicText(`${this.repository.metadataRoot}/settings.json`, stableJSON(settings)); }
  private async reserve(root: string, preferred: string, used: Set<string>): Promise<string> {
    await this.ensureRoot(root);
    const parent = await resolveSafe(this.repository.vaultRoot, `${root}/projects`, false, this.repository.configDir);
    for (const name of await fs.readdir(parent)) used.add(caseFold(name));
    for (let index = 1; ; index++) {
      const candidate = index === 1 ? preferred : `${preferred} (${index})`;
      if (used.has(caseFold(candidate)) || isReservedProjectFolder(root, candidate, this.repository.configDir)) continue;
      const absolute = path.join(parent, candidate);
      try { await fs.mkdir(absolute); used.add(caseFold(candidate)); return candidate; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  async projectFolder(project: Pick<Project, 'id' | 'title'>): Promise<string> {
    requireId(project.id);
    const existing = this.settings.projectFolders[project.id];
    if (existing) {
      const relative = `${this.projectsRoot}/${existing}`;
      if (!this.repository.readOnly) await fs.mkdir(await resolveSafe(this.repository.vaultRoot, relative, true, this.repository.configDir), { recursive: true });
      return relative;
    }
    this.repository.assertWritable();
    const folder = await this.reserve(this.dataRoot, safeVisibleName(project.title), new Set(Object.values(this.settings.projectFolders).map(caseFold)));
    const next: Settings = { ...this.settings, projectFolders: { ...this.settings.projectFolders, [project.id]: folder } };
    await this.persist(next); this.settings = next;
    return `${this.projectsRoot}/${folder}`;
  }
  async prepareRoot(root: string): Promise<VisibleStoragePlan> {
    validateVisibleRoot(root, this.repository.configDir); this.repository.assertWritable();
    if (root === this.dataRoot) { await this.ensureRoot(root); return structuredClone(this.settings); }
    const base = stableJSON(this.settings), cached = this.preparedRoots.get(root);
    if (cached?.base === base) return structuredClone(cached.plan);
    await this.ensureRoot(root);
    const next: Settings = { formatVersion: 2, dataRoot: root, projectFolders: {} }, used = new Set<string>();
    for (const [id, folder] of Object.entries(this.settings.projectFolders)) next.projectFolders[id] = await this.reserve(root, folder, used);
    this.preparedRoots.set(root, { base, plan: structuredClone(next) });
    return next;
  }
  async commitRoot(plan: VisibleStoragePlan): Promise<void> {
    this.repository.assertWritable(); const next = validateVisibleStoragePlan(plan, this.repository.configDir);
    await this.ensureRoot(next.dataRoot); await this.persist(next); this.settings = next; this.preparedRoots.clear();
  }
  async configureRoot(root: string): Promise<void> { await this.commitRoot(await this.prepareRoot(root)); }
}

export interface ProjectFileMigrationOptions { skipUnavailable?: boolean; preserveInsideDestination?: boolean; onUnavailable?: (blob: BlobRecord, status: 'missing' | 'changed' | 'invalid') => void }
/** Publish the returned state with a repository barrier only after every available copy is verified. */
export async function migrateProjectFiles(project: Project, destinationFolder: string, repository: ProjectRepository, options: ProjectFileMigrationOptions = {}): Promise<Project> {
  repository.assertWritable(project.id); safeRelative(destinationFolder, repository.configDir);
  if (isTechnicalPath(destinationFolder, repository.configDir)) throw new Error('Invalid visible project folder');
  const next = structuredClone(project), files = new FileStore(repository.vaultRoot, undefined, undefined, repository.configDir);
  for (const blob of next.blobs) {
    let status: 'ok' | 'missing' | 'changed' | 'invalid';
    try { status = await files.verify(blob); }
    catch (error) { if (error instanceof Error && /Unsafe relative path|Symbolic links/u.test(error.message)) status = 'invalid'; else throw error; }
    if (status !== 'ok') {
      options.onUnavailable?.(structuredClone(blob), status);
      if (options.skipUnavailable) continue;
      throw new DomainError('original_conflict', t(`Оригинал недоступен или изменён: ${blob.path}.`, `An original is missing or changed: ${blob.path}.`));
    }
    if (options.preserveInsideDestination && blob.path.startsWith(destinationFolder + '/')) continue;
    const name = project.assets.find(asset => asset.blobId === blob.id)?.originalName ?? blob.path.split('/').at(-1)!;
    const relative = visibleBlobPath(destinationFolder, blob, name, repository.configDir);
    if (relative === blob.path) continue;
    const target = await resolveSafe(repository.vaultRoot, relative, true, repository.configDir);
    try {
      const proof = await digestFile(target);
      if (proof.sha256 !== blob.sha256 || proof.byteSize !== blob.byteSize) throw new DomainError('migration_conflict', t(`Целевой файл уже существует с другим содержимым: ${relative}.`, `The destination already contains different content: ${relative}.`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await copyChecked(await resolveSafe(repository.vaultRoot, blob.path, false, repository.configDir), target, blob);
    }
    blob.path = relative;
  }
  return next;
}

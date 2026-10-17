import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, validateProject } from '../domain';
import type { Project } from '../types';
import { ProjectRepository, digest, stableJSON, strictJSON, type History, type Journal } from './repository';
import { digestFile, requireId, resolveSafe, safeRelative } from './files';
import { validateRecord } from './records';
import { LEGACY_METADATA_ROOT, isAllowedNotePath, isConfigurationPath } from './layout';
import { verifyReport } from '../portability';
import { rewriteMovedNoteLinks } from './markdown-paths';

export type MigrationFaultPoint = 'after-prepared' | 'after-files' | 'after-published' | 'after-retained';
interface Proof { sha256: string; byteSize: number }
interface Move extends Proof { from: string; to: string }
interface Marker { format: 'traceweave.layout-migration'; version: 1; id: string; phase: 'prepared' | 'files' | 'published' | 'complete'; moves: Move[]; prepared: Move[]; aliases: { from: string; to: string }[]; externalNotes: string[]; baselines: (Proof & { path: string })[]; retainedRoot: string; planHash: string }
const DATA_ROOT = 'TWData', NOTES_ROOT = 'TWData/notes', RESOURCES_ROOT = 'TWData/resources';
const MARKER = `${DATA_ROOT}/migration.json`;
const oldNotes = 'TraceWeave Notes', oldResources = 'TraceWeave Resources';
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function exists(root: string, relative: string): Promise<boolean> { try { await fs.lstat(await resolveSafe(root, relative)); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function readUTF8(root: string, relative: string): Promise<string> { const absolute = await resolveSafe(root, relative), stat = await fs.lstat(absolute); if (!stat.isFile() || stat.size > 201_326_592) throw new DomainError('migration_limit', t('Технический JSON превышает безопасный лимит чтения.', "Metadata JSON exceeds the safe reading limit.")); return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(absolute)); }
async function atomic(root: string, relative: string, value: string): Promise<void> {
  const target = await resolveSafe(root, relative, true), temporary = `${target}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, target); const directory = await fs.open(path.dirname(target), 'r');
  try { await directory.sync(); } catch (error) { if (!['EINVAL','ENOTSUP','EPERM','EBADF','EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; } finally { await directory.close(); }
}
async function proof(root: string, relative: string): Promise<Proof> { return digestFile(await resolveSafe(root, relative), {}, Number.MAX_SAFE_INTEGER); }
async function verify(root: string, relative: string, expected: Proof): Promise<void> { const actual = await proof(root, relative); if (actual.sha256 !== expected.sha256 || actual.byteSize !== expected.byteSize) throw new DomainError('migration_conflict', t(`Файл изменён во время переноса: ${relative}. Исходные данные сохранены.`, `A file changed during migration: ${relative}. The original data was preserved.`)); }
function planHash(marker: Pick<Marker, 'id' | 'moves' | 'prepared' | 'aliases' | 'externalNotes' | 'baselines' | 'retainedRoot'>): string { return digest(stableJSON({ id: marker.id, moves: marker.moves, prepared: marker.prepared, aliases: marker.aliases, externalNotes: marker.externalNotes, baselines: marker.baselines, retainedRoot: marker.retainedRoot })); }
function validateMarker(value: Marker, configDir?: string): void {
  if (!value || value.format !== 'traceweave.layout-migration' || value.version !== 1 || !['prepared','files','published','complete'].includes(value.phase) || !Array.isArray(value.moves) || !Array.isArray(value.prepared) || !Array.isArray(value.aliases) || !Array.isArray(value.externalNotes) || !Array.isArray(value.baselines)) throw new DomainError('migration', t('Повреждён протокол переноса TWData.', "The TWData migration record is corrupt."));
  requireId(value.id); safeRelative(value.retainedRoot, configDir); if (value.retainedRoot !== `${DATA_ROOT}/recovery/legacy-0.1.0/${value.id}/${LEGACY_METADATA_ROOT}` || value.planHash !== planHash(value)) throw new DomainError('migration', t('Контрольная сумма плана переноса не совпала.', "The migration plan checksum does not match."));
  const targets = new Set<string>(), external = new Set(value.externalNotes);
  for (const relative of external) if (!isAllowedNotePath(relative, false, configDir) || relative.startsWith(DATA_ROOT + '/')) throw new DomainError('migration', t('Небезопасный внешний путь заметки.', "Unsafe external note path."));
  for (const move of [...value.moves, ...value.prepared]) { safeRelative(move.from, configDir); safeRelative(move.to, configDir); const externalEffect = value.prepared.includes(move) && external.has(move.to) && move.from.startsWith(`${DATA_ROOT}/.migration-${value.id}/prepared/`); if ((!move.to.startsWith(DATA_ROOT + '/') && !externalEffect) || targets.has(move.to.toLowerCase()) || !/^[a-f0-9]{64}$/.test(move.sha256) || !Number.isSafeInteger(move.byteSize) || move.byteSize < 0) throw new DomainError('migration', t('Небезопасная запись переноса.', "Unsafe migration record.")); targets.add(move.to.toLowerCase()); }
  for (const baseline of value.baselines) { safeRelative(baseline.path, configDir); if (!baseline.path.startsWith(LEGACY_METADATA_ROOT + '/') || !/^[a-f0-9]{64}$/.test(baseline.sha256)) throw new DomainError('migration', t('Неверная исходная контрольная сумма.', "Invalid original checksum.")); }
  for (const alias of value.aliases) { safeRelative(alias.from, configDir); safeRelative(alias.to, configDir); if ((alias.to !== DATA_ROOT && !alias.to.startsWith(DATA_ROOT + '/'))) throw new DomainError('migration', t('Небезопасная таблица старых путей.', "Unsafe legacy path mapping.")); }
}
async function walk(root: string, relative: string): Promise<string[]> {
  if (!await exists(root, relative)) return [];
  const result: string[] = [], absolute = await resolveSafe(root, relative), stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new DomainError('migration', t('Символические ссылки в переносимых папках не поддерживаются.', "Symbolic links in migrated folders are not supported."));
  if (stat.isFile()) return [relative]; if (!stat.isDirectory()) throw new DomainError('migration', t('В переносимой папке найден специальный файл.', "A special file was found in a migrated folder."));
  for (const entry of (await fs.readdir(absolute)).sort()) result.push(...await walk(root, `${relative}/${entry}`)); return result;
}
async function moveChecked(root: string, move: Move): Promise<void> {
  const sourceExists = await exists(root, move.from), targetExists = await exists(root, move.to);
  if (targetExists) { await verify(root, move.to, move); if (sourceExists) throw new DomainError('migration_conflict', t(`Одновременно существуют исходный и целевой файл: ${move.to}.`, `Both source and destination files exist: ${move.to}.`)); return; }
  if (!sourceExists) throw new DomainError('migration_conflict', t(`Отсутствует файл переноса: ${move.from}.`, `A migration file is missing: ${move.from}.`));
  await verify(root, move.from, move); await fs.rename(await resolveSafe(root, move.from), await resolveSafe(root, move.to, true));
}
async function removeEmptyDirectories(root: string, relative: string): Promise<void> {
  if (!await exists(root, relative)) return; const absolute = await resolveSafe(root, relative); if (!(await fs.lstat(absolute)).isDirectory()) return;
  for (const entry of await fs.readdir(absolute)) await removeEmptyDirectories(root, `${relative}/${entry}`);
  try { await fs.rmdir(absolute); } catch (error) { if (!['ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}

/** Upgrade the layout, retaining IDs/report bytes and originals of notes whose link destinations change. */
export async function migrateLegacyVault(vaultRoot: string, options: { fault?: (point: MigrationFaultPoint) => void; configDir?: string } = {}): Promise<void> {
  safeRelative(DATA_ROOT, options.configDir); if (options.configDir && isConfigurationPath(options.configDir, DATA_ROOT)) throw new DomainError('migration', t('Папки метаданных и настроек не должны пересекаться.', 'The metadata and configuration folders must not overlap.')); safeRelative(LEGACY_METADATA_ROOT, options.configDir); let marker: Marker | null = await exists(vaultRoot, MARKER) ? strictJSON<Marker>(await readUTF8(vaultRoot, MARKER)) : null;
  if (marker) validateMarker(marker, options.configDir);
  if (marker?.phase === 'complete') { if (await exists(vaultRoot, LEGACY_METADATA_ROOT)) throw new DomainError('migration_conflict', t('После переноса вновь появилась старая папка _TraceWeave. Автоматическое объединение запрещено.', "The legacy _TraceWeave folder reappeared after migration. Automatic merging is forbidden.")); return; }
  if (!await exists(vaultRoot, LEGACY_METADATA_ROOT)) {
    if (!marker) return;
    if (marker.phase !== 'published' || !await exists(vaultRoot, marker.retainedRoot)) throw new DomainError('migration_conflict', t('Исходная папка переноса недоступна.', "The migration source folder is unavailable."));
    for (const move of [...marker.moves, ...marker.prepared]) await verify(vaultRoot, move.to, move);
    marker.phase = 'complete'; await atomic(vaultRoot, MARKER, stableJSON(marker)); return;
  }
  const legacy = new ProjectRepository(vaultRoot, { metadataRoot: LEGACY_METADATA_ROOT, configDir: options.configDir });
  try {
    await legacy.initialize(); legacy.assertWritable();
    if (!marker) {
      if ((await walk(vaultRoot, `${DATA_ROOT}/projects`)).length) throw new DomainError('migration_conflict', t('TWData уже содержит проекты. Автоматическое объединение со старым хранилищем запрещено.', "TWData already contains projects. Automatic merging with the legacy store is forbidden."));
      const id = randomUUID(), stage = `${DATA_ROOT}/.migration-${id}`;
      let configured = { notesRoot: oldNotes, resourcesRoot: oldResources };
      if (await exists(vaultRoot, `${LEGACY_METADATA_ROOT}/settings.json`)) { configured = strictJSON(await readUTF8(vaultRoot, `${LEGACY_METADATA_ROOT}/settings.json`)); safeRelative(configured.notesRoot); safeRelative(configured.resourcesRoot); }
      const customManagedNotes = new Set<string>(), customManagedBlobs = new Set<string>(), allStates: Project[] = [], oldJournals: Journal[] = [], projectDirectories: string[] = [];
      const collectOwnership = (p: Project): void => {
        allStates.push(p);
        for (const node of p.nodes) { const parent = path.posix.basename(path.posix.dirname(node.notePath)), name = path.posix.basename(node.notePath); if (node.notePath.startsWith(configured.notesRoot + '/') && parent.endsWith(`--${p.id.slice(0,8)}`) && name.endsWith(`--${node.id.slice(0,8)}.md`)) customManagedNotes.add(node.notePath); }
        for (const blob of p.blobs) if (blob.path.startsWith(configured.resourcesRoot + '/')) customManagedBlobs.add(blob.path);
      };
      for (const entry of await fs.readdir(await resolveSafe(vaultRoot, `${LEGACY_METADATA_ROOT}/projects`), { withFileTypes: true })) {
        if (entry.name === '.DS_Store' && entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DomainError('migration', t('Неожиданный объект в каталоге старых проектов.', "Unexpected entry in the legacy projects folder.")); requireId(entry.name); const p = await legacy.read(entry.name); projectDirectories.push(p.id); collectOwnership(p);
        for (const file of await walk(vaultRoot, legacy.projectRoot(p.id))) if (/\/(history|journal)\/[^/]+\.json$/u.test(file)) { const record = strictJSON<History | Journal>(await readUTF8(vaultRoot, file)), kind = file.includes('/journal/') ? 'journal' : 'history'; validateRecord(kind, record); if (!('history' in record)) { collectOwnership(record.before); collectOwnership(record.after); } else { oldJournals.push(record); collectOwnership(record.state); collectOwnership(record.history.before); collectOwnership(record.history.after); } }
      }
      const mapped = (relative: string): string => {
        for (const [from, to] of [[LEGACY_METADATA_ROOT, DATA_ROOT], [oldNotes, NOTES_ROOT], [oldResources, RESOURCES_ROOT]]) if (relative.startsWith(from + '/')) return to + relative.slice(from.length);
        if (configured.notesRoot !== oldNotes && customManagedNotes.has(relative)) return `${NOTES_ROOT}/custom${relative.slice(configured.notesRoot.length)}`;
        if (configured.resourcesRoot !== oldResources && customManagedBlobs.has(relative)) return `${RESOURCES_ROOT}/custom${relative.slice(configured.resourcesRoot.length)}`;
        return relative;
      };
      const noteHashes = new Map<string, string>();
      const transform = (input: Project): Project => { const p = structuredClone(input); for (const node of p.nodes) { if (node.noteHash) node.noteHash = noteHashes.get(node.notePath + '\0' + node.noteHash) ?? node.noteHash; node.notePath = mapped(node.notePath); } for (const blob of p.blobs) blob.path = mapped(blob.path); for (const snapshot of p.snapshots) snapshot.path = mapped(snapshot.path); const retained = p.importedData.retainedSource as { path?: string } | undefined; if (retained?.path) retained.path = mapped(retained.path); validateProject(p); return p; };
      const moves = new Map<string, Move>(), prepared: Move[] = [], baselines: Marker['baselines'] = [], targetNames = new Set<string>();
      const claim = async (from: string, to: string): Promise<void> => { if (from === to || moves.has(from) || !await exists(vaultRoot, from)) return; if (targetNames.has(to.toLowerCase()) || await exists(vaultRoot, to)) throw new DomainError('migration_conflict', t(`Целевой файл уже существует: ${to}.`, `The destination file already exists: ${to}.`)); const p = await proof(vaultRoot, from); moves.set(from, { from, to, ...p }); targetNames.add(to.toLowerCase()); };
      const prepare = async (relative: string, value: unknown): Promise<void> => {
        const to = mapped(relative); if (targetNames.has(to.toLowerCase()) || await exists(vaultRoot, to)) throw new DomainError('migration_conflict', t(`Целевой файл уже существует: ${to}.`, `The destination file already exists: ${to}.`));
        if (await exists(vaultRoot, relative)) baselines.push({ path: relative, ...await proof(vaultRoot, relative) }); const source = `${stage}/prepared/${prepared.length}.json`, content = stableJSON(value); await atomic(vaultRoot, source, content); prepared.push({ from: source, to, sha256: digest(content), byteSize: Buffer.byteLength(content) }); targetNames.add(to.toLowerCase());
      };
      const track = async (p: Project): Promise<void> => { for (const n of p.nodes) if (mapped(n.notePath) !== n.notePath) await claim(n.notePath, mapped(n.notePath)); for (const b of p.blobs) if (mapped(b.path) !== b.path) { const known = moves.get(b.path); if (known) { if (known.sha256 !== b.sha256 || known.byteSize !== b.byteSize) throw new DomainError('migration_conflict', t('Историческая запись оригинала имеет другую контрольную сумму.', "A historical original record has a different checksum.")); } else { await verify(vaultRoot, b.path, b); await claim(b.path, mapped(b.path)); } } };
      for (const directory of [oldNotes, oldResources]) for (const file of await walk(vaultRoot, directory)) await claim(file, mapped(file));
      for (const state of allStates) await track(state);
      for (const projectId of projectDirectories) for (const file of await walk(vaultRoot, legacy.projectRoot(projectId))) if (file.includes('/reports/') || file.includes('/sources/') || /\/(view|drafts)\.json$/u.test(file)) await claim(file, mapped(file));
      const aliases = [{ from: oldNotes, to: NOTES_ROOT }, { from: oldResources, to: RESOURCES_ROOT }, { from: LEGACY_METADATA_ROOT, to: DATA_ROOT }, ...[...moves.values()].map(move => ({ from: move.from, to: move.to }))];
      for (const move of moves.values()) if (move.to.startsWith(NOTES_ROOT + '/') && move.from.endsWith('.md')) aliases.push({ from: move.from.slice(0,-3), to: move.to.slice(0,-3) });
      const destinations = new Map(aliases.map(alias => [alias.from, alias.to]));
      const rewrite = (oldPath: string, text: string): string => { const nextPath = mapped(oldPath); const next = rewriteMovedNoteLinks(text, oldPath, nextPath, destinations); if (Buffer.byteLength(next) > 5_242_880) throw new DomainError('file_limit', t('Перенос ссылок превысил лимит заметки 5 MiB.', "Relocating links exceeded the 5 MiB note limit.")); noteHashes.set(oldPath + '\0' + digest(text), digest(next)); return next; };
      for (const move of [...moves.values()]) if (move.to.startsWith(NOTES_ROOT + '/') && /\.md$/iu.test(move.from)) {
        if (move.byteSize > 5_242_880) { if (allStates.some(p => p.nodes.some(n => n.notePath === move.from))) throw new DomainError('file_limit', t('Управляемая заметка превышает лимит переноса 5 MiB.', "A managed note exceeds the 5 MiB migration limit.")); continue; }
        const text = await readUTF8(vaultRoot, move.from), rewritten = rewrite(move.from, text); if (rewritten === text) continue;
        const retained = `${DATA_ROOT}/recovery/legacy-0.1.0/${id}/notes/${move.from}`; targetNames.delete(move.to.toLowerCase()); targetNames.add(retained.toLowerCase()); moves.set(move.from, { ...move, to: retained });
        const source = `${stage}/prepared/${prepared.length}.md`; await atomic(vaultRoot, source, rewritten); prepared.push({ from: source, to: move.to, sha256: digest(rewritten), byteSize: Buffer.byteLength(rewritten) }); targetNames.add(move.to.toLowerCase());
      }
      for (const journal of oldJournals) for (const effect of journal.effects) { rewrite(effect.path, effect.after); if (effect.before !== null) rewrite(effect.path, effect.before); }
      const externalNotes: string[] = []; let scannedNotes = 0, scannedBytes = 0;
      const scanOrdinary = async (relative = ''): Promise<void> => {
        for (const entry of await fs.readdir(relative ? await resolveSafe(vaultRoot, relative) : vaultRoot, { withFileTypes: true })) {
          if (isConfigurationPath(relative ? `${relative}/${entry.name}` : entry.name, options.configDir) || entry.name.startsWith('.') || entry.isSymbolicLink() || (!relative && [DATA_ROOT, LEGACY_METADATA_ROOT, oldNotes, oldResources].includes(entry.name))) continue;
          const candidate = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { await scanOrdinary(candidate); continue; }
          if (!entry.isFile() || !isAllowedNotePath(candidate) || moves.has(candidate)) continue;
          const stat = await fs.stat(await resolveSafe(vaultRoot, candidate)); scannedNotes++; scannedBytes += stat.size;
          if (scannedNotes > 50000 || scannedBytes > 67_108_864 || stat.size > 5_242_880) throw new DomainError('migration_limit', t('Проверка обратных ссылок превышает безопасный лимит: 50000 заметок, 64 MiB текста, 5 MiB на заметку. Исходные файлы не изменены.', "Backlink checking exceeds the safe limit: 50000 notes, 64 MiB of text, 5 MiB per note. Original files were not changed."));
          const text = await readUTF8(vaultRoot, candidate), rewritten = rewrite(candidate, text); if (rewritten === text) continue;
          const retained = `${DATA_ROOT}/recovery/legacy-0.1.0/${id}/external-notes/${candidate}`, originalProof = await proof(vaultRoot, candidate); if (originalProof.sha256 !== digest(text)) throw new DomainError('migration_conflict', t('Обычная заметка изменилась во время сверки ссылок.', "An ordinary note changed while checking links."));
          moves.set(candidate, { from: candidate, to: retained, ...originalProof }); targetNames.add(retained.toLowerCase()); const source = `${stage}/prepared/${prepared.length}.md`; await atomic(vaultRoot, source, rewritten); prepared.push({ from: source, to: candidate, sha256: digest(rewritten), byteSize: Buffer.byteLength(rewritten) }); targetNames.add(candidate.toLowerCase()); externalNotes.push(candidate);
        }
      };
      await scanOrdinary();
      const projectsRoot = await resolveSafe(vaultRoot, `${LEGACY_METADATA_ROOT}/projects`);
      for (const entry of await fs.readdir(projectsRoot, { withFileTypes: true })) {
        if (entry.name === '.DS_Store' && entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DomainError('migration', t('Неожиданный объект в каталоге старых проектов.', "Unexpected entry in the legacy projects folder.")); requireId(entry.name); const p = await legacy.read(entry.name); for (const snapshot of p.snapshots) await verifyReport(vaultRoot, snapshot); await track(p); await prepare(legacy.statePath(p.id), transform(p));
        for (const file of await walk(vaultRoot, legacy.projectRoot(p.id))) {
          if (file === legacy.statePath(p.id)) continue;
          if (/\/(history|journal)\/[^/]+\.json$/u.test(file)) {
            const record = strictJSON<History | Journal>(await readUTF8(vaultRoot, file)); const kind = file.includes('/journal/') ? 'journal' : 'history'; validateRecord(kind, record);
            if (!('history' in record)) { await track(record.before); await track(record.after); record.before = transform(record.before); record.after = transform(record.after); }
            else { if (!record.completed) throw new DomainError('migration', t('Старый журнал ещё не восстановлен.', "The legacy journal has not been recovered yet.")); record.state = transform(record.state); record.history.before = transform(record.history.before); record.history.after = transform(record.history.after); record.effects = record.effects.map((e: { path: string; before: string | null; after: string }) => ({ ...e, path: mapped(e.path), before: e.before === null ? null : rewrite(e.path, e.before), after: rewrite(e.path, e.after) })); record.beforeHash = digest(stableJSON(record.history.before)); record.afterHash = digest(stableJSON(record.state)); }
            validateRecord(kind, record); await prepare(file, record);
          } else if (file.endsWith('/recovery/previous-state.json')) { const state = strictJSON<Project>(await readUTF8(vaultRoot, file)); validateProject(state); await prepare(file, transform(state)); }
          else if (file.includes('/reports/') || file.includes('/sources/') || /\/(view|drafts)\.json$/u.test(file)) await claim(file, mapped(file));
        }
      }
      const settingsPath = `${LEGACY_METADATA_ROOT}/settings.json`; await prepare(settingsPath, { notesRoot: NOTES_ROOT, resourcesRoot: RESOURCES_ROOT });
      marker = { format: 'traceweave.layout-migration', version: 1, id, phase: 'prepared', moves: [...moves.values()], prepared, aliases, externalNotes, baselines, retainedRoot: `${DATA_ROOT}/recovery/legacy-0.1.0/${id}/${LEGACY_METADATA_ROOT}`, planHash: '' }; marker.planHash = planHash(marker); validateMarker(marker, options.configDir); await atomic(vaultRoot, MARKER, stableJSON(marker)); options.fault?.('after-prepared');
    }
    for (const baseline of marker.baselines) await verify(vaultRoot, baseline.path, baseline);
    if (marker.phase === 'prepared') { for (const move of marker.moves) await moveChecked(vaultRoot, move); marker.phase = 'files'; await atomic(vaultRoot, MARKER, stableJSON(marker)); options.fault?.('after-files'); }
    if (marker.phase === 'files') { for (const move of marker.prepared) await moveChecked(vaultRoot, move); marker.phase = 'published'; await atomic(vaultRoot, MARKER, stableJSON(marker)); options.fault?.('after-published'); }
    for (const move of [...marker.moves, ...marker.prepared]) await verify(vaultRoot, move.to, move);
    await removeEmptyDirectories(vaultRoot, oldNotes); await removeEmptyDirectories(vaultRoot, oldResources);
    if (await exists(vaultRoot, oldNotes) || await exists(vaultRoot, oldResources)) throw new DomainError('migration_conflict', t('Старая управляемая папка изменилась во время переноса. Новые файлы сохранены; завершение остановлено.', "The legacy managed folder changed during migration. New files were preserved; completion was stopped."));
    if (!await exists(vaultRoot, marker.retainedRoot)) await fs.rename(await resolveSafe(vaultRoot, LEGACY_METADATA_ROOT), await resolveSafe(vaultRoot, marker.retainedRoot, true));
    const retainedLock = `${marker.retainedRoot}/writer.lock`; if (await exists(vaultRoot, retainedLock)) { const lock = strictJSON<{ instanceId: string }>(await readUTF8(vaultRoot, retainedLock)); if (lock.instanceId === legacy.instanceId) await fs.unlink(await resolveSafe(vaultRoot, retainedLock)); }
    options.fault?.('after-retained'); marker.phase = 'complete'; await atomic(vaultRoot, MARKER, stableJSON(marker));
    await removeEmptyDirectories(vaultRoot, `${DATA_ROOT}/.migration-${marker.id}`);
  } finally { await legacy.dispose(); }
}

export async function getMigratedPath(vaultRoot: string, oldPath: string, configDir?: string): Promise<string | null> { return aliasPath(vaultRoot, oldPath, false, configDir); }
export async function getOriginalPath(vaultRoot: string, newPath: string, configDir?: string): Promise<string | null> { return aliasPath(vaultRoot, newPath, true, configDir); }
export async function legacyAliases(vaultRoot: string, markerPath = MARKER, configDir?: string): Promise<{ from: string; to: string }[]> {
  if (!await exists(vaultRoot, markerPath)) return []; const marker = strictJSON<Marker>(await readUTF8(vaultRoot, markerPath)); validateMarker(marker, configDir); if (marker.phase !== 'complete') throw new DomainError('migration', t('Предыдущий перенос ещё не завершён.', "The previous migration is not complete.")); return marker.aliases;
}
async function aliasPath(vaultRoot: string, value: string, reverse: boolean, configDir?: string): Promise<string | null> {
  safeRelative(value, configDir); if (!await exists(vaultRoot, MARKER)) return null; const marker = strictJSON<Marker>(await readUTF8(vaultRoot, MARKER)); validateMarker(marker, configDir); if (marker.phase !== 'complete') return null;
  if (reverse) return marker.aliases.find(alias => alias.to === value)?.from ?? null;
  const aliases = [...marker.aliases].sort((a,b) => (reverse ? b.to.length - a.to.length : b.from.length - a.from.length));
  const match = aliases.find(alias => { const prefix = reverse ? alias.to : alias.from; return value === prefix || value.startsWith(prefix + '/'); }); if (!match) return null;
  const from = reverse ? match.to : match.from, to = reverse ? match.from : match.to; return to + value.slice(from.length);
}

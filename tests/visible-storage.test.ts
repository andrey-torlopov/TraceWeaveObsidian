import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyCommands, createProject } from '../src/domain';
import { FileStore, visibleBlobPath } from '../src/storage/files';
import { ProjectRepository, digest } from '../src/storage/repository';
import { VisibleStorage, migrateProjectFiles, validateVisibleRoot, validateVisibleStoragePlan } from '../src/storage/visible-storage';
import { isAllowedResourcePath, isAllowedSnapshotPath, isTechnicalPath } from '../src/storage/layout';
import { migrateLegacyVault } from '../src/storage/migration';
import type { Asset } from '../src/types';

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-visible-storage-')), repository = new ProjectRepository(root);
  await repository.initialize();
  t.after(async () => { await repository.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repository, storage: new VisibleStorage(repository) };
}
function assetFor(blob: Awaited<ReturnType<FileStore['importFile']>>['blob'], originalName: string): Asset {
  return { id: randomUUID(), blobId: blob.id, originalName, title: originalName, mimeType: blob.mimeType, mediaKind: blob.mediaKind, byteSize: blob.byteSize, sha256: blob.sha256, createdAt: '2026-10-18T00:00:00.000Z', deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: '', origin: { kind: 'manual' } };
}

test('visible folders reserve readable collisions, retain user files and stay stable after project renames and restart', async t => {
  const { root, repository, storage } = await fixture(t); await storage.initialize();
  await fs.mkdir(path.join(root, 'TWData/projects/Research')); await fs.writeFile(path.join(root, 'TWData/projects/Research/user.txt'), 'User file');
  const first = createProject('Research'), second = createProject('Research');
  assert.equal(await storage.projectFolder(first), 'TWData/projects/Research (2)');
  assert.equal(await storage.projectFolder(second), 'TWData/projects/Research (3)');
  assert.equal(await storage.projectFolder({ ...first, title: 'Renamed' }), 'TWData/projects/Research (2)');
  const reopened = new VisibleStorage(repository); await reopened.initialize(); assert.equal(await reopened.projectFolder(first), 'TWData/projects/Research (2)');
  assert.equal(await fs.readFile(path.join(root, 'TWData/projects/Research/user.txt'), 'utf8'), 'User file');
  await reopened.configureRoot('Research Files'); assert.equal(await reopened.projectFolder(first), 'Research Files/projects/Research (2)');
  assert.equal(reopened.exportsRoot, 'Research Files/exports');
  await fs.mkdir(path.join(root, 'Research Files/projects/lowercase'));
  assert.equal(await reopened.projectFolder(createProject('Lowercase')), 'Research Files/projects/Lowercase (2)');
  await fs.symlink(os.tmpdir(), path.join(root, 'Research Files/projects/Linked title'));
  assert.equal(await reopened.projectFolder(createProject('Linked title')), 'Research Files/projects/Linked title (2)');
});

test('legacy folder settings upgrade without moving notes; long Unicode and Windows reserved titles persist safely', async t => {
  const { root, repository, storage } = await fixture(t);
  await fs.mkdir(path.join(root, 'Ordinary')); await fs.writeFile(path.join(root, 'Ordinary/Note.md'), 'Keep note bytes');
  await repository.atomicText('.twdata/settings.json', JSON.stringify({ notesRoot: 'Исследования/Заметки', resourcesRoot: 'Исследования/Вложения' }));
  await storage.initialize(); assert.equal(storage.dataRoot, 'TWData');
  const first = createProject('Я'.repeat(100)), second = createProject('Я'.repeat(100));
  const a = await storage.projectFolder(first), b = await storage.projectFolder(second); assert.notEqual(a, b); assert.ok(b.endsWith(' (2)'));
  assert.equal(await storage.projectFolder(createProject('CON')), 'TWData/projects/_CON');
  const reopened = new VisibleStorage(repository); await reopened.initialize(); assert.equal(await reopened.projectFolder(second), b);
  assert.equal(await fs.readFile(path.join(root, 'Ordinary/Note.md'), 'utf8'), 'Keep note bytes');
  assert.equal(JSON.parse(await repository.readText('.twdata/settings.json')).formatVersion, 2);
});

test('visible roots and technical paths reject metadata/configuration/symlinks and preserve malformed settings', async t => {
  const { root, repository, storage } = await fixture(t);
  for (const value of ['', '../Outside', '/absolute', '.twdata', 'nested/.hidden', '_TraceWeave', 'TWData/resources', 'TWData/projects', 'Configuration/private', 'Data#hash', 'Data?query', 'CON']) assert.throws(() => validateVisibleRoot(value, 'Configuration'));
  assert.equal(validateVisibleRoot('Archive/TWData'), 'Archive/TWData');
  assert.equal(isTechnicalPath('TWData/exports/Research/summary.md'), false);
  assert.equal(isTechnicalPath('TWData/projects/Research/images/photo.png'), false);
  assert.equal(isTechnicalPath(`TWData/projects/${randomUUID()}/state.json`), true);
  assert.equal(isTechnicalPath('TWData/settings.json'), true);
  assert.equal(isAllowedResourcePath('TWData/projects/Research/video/clip.mp4'), true);
  const snapshot = randomUUID(); assert.equal(isAllowedSnapshotPath(`TWData/exports/Research/snapshots/${snapshot}/snapshot.json`, randomUUID(), snapshot), true);
  assert.equal(isAllowedSnapshotPath(`../exports/Research/snapshots/${snapshot}/snapshot.json`, randomUUID(), snapshot), false);
  await fs.symlink(os.tmpdir(), path.join(root, 'Linked')); await assert.rejects(() => storage.configureRoot('Linked/data'), /Symbolic links/u);
  await repository.atomicText('.twdata/settings.json', '{"formatVersion":2,"dataRoot":".twdata","projectFolders":{}}');
  await assert.rejects(() => storage.initialize()); assert.ok((await repository.readText('.twdata/settings.json')).includes('".twdata"'));
});

test('new file imports categorize verified media, use readable names, deduplicate and never delete sibling files', async t => {
  const { root, storage } = await fixture(t); await storage.initialize(); const project = createProject('Materials'), folder = await storage.projectFolder(project), files = new FileStore(root);
  const png = path.join(root, 'Photo.png'); await fs.writeFile(png, Buffer.from([137,80,78,71,13,10,26,10,0,1]));
  const imported = await files.importFile(png, project.id, [], { projectFolder: folder }); assert.ok(imported.blob.path.startsWith(folder + '/images/Photo--')); assert.ok(imported.blob.path.endsWith('.png'));
  await fs.writeFile(path.join(root, folder, 'images/user.txt'), 'Keep sibling');
  const duplicate = await files.importFile(png, project.id, [imported.blob], { projectFolder: folder }); assert.equal(duplicate.blob.id, imported.blob.id);
  assert.equal(await fs.readFile(path.join(root, folder, 'images/user.txt'), 'utf8'), 'Keep sibling');
  const spoof = path.join(root, 'Pretend.png'); await fs.writeFile(spoof, '<script>Not a PNG</script>');
  const unknown = await files.importFile(spoof, project.id, [], { projectFolder: folder }); assert.ok(unknown.blob.path.includes('/other/')); assert.equal(unknown.blob.mimeType, 'application/octet-stream');
});

test('original migration is idempotent, preserves old files and metadata until barrier, refuses conflicting targets', async t => {
  const { root, repository, storage } = await fixture(t); await storage.initialize(); const initial = createProject('Migration'), files = new FileStore(root), source = path.join(root, 'Document.txt');
  await fs.writeFile(source, 'Original bytes'); const imported = await files.importFile(source, initial.id), asset = assetFor(imported.blob, 'Document.txt');
  const project = await repository.add(applyCommands(initial, [{ kind: 'asset.register', asset, blob: imported.blob }])), folder = await storage.projectFolder(project);
  const replacement = await migrateProjectFiles(project, folder, repository); assert.ok(replacement.blobs[0].path.includes('/documents/Document--'));
  assert.equal((await repository.read(project.id)).blobs[0].path, project.blobs[0].path);
  assert.equal(await fs.readFile(path.join(root, project.blobs[0].path), 'utf8'), 'Original bytes');
  assert.deepEqual(await migrateProjectFiles(project, folder, repository), replacement);
  await repository.execute(project.id, [], { replace: replacement, baseRevision: project.revision, kind: 'barrier' });
  assert.deepEqual(await repository.historyState(await repository.read(project.id)), { undo: [], redo: [] });
  const conflictingFolder = 'TWData/projects/Conflict', conflict = visibleBlobPath(conflictingFolder, imported.blob, 'Document.txt');
  await fs.mkdir(path.dirname(path.join(root, conflict)), { recursive: true }); await fs.writeFile(path.join(root, conflict), 'User target');
  await assert.rejects(() => migrateProjectFiles(project, conflictingFolder, repository), /другим содержимым/u);
  assert.equal(await fs.readFile(path.join(root, conflict), 'utf8'), 'User target');
});

test('startup migration can skip unavailable originals without blessing altered bytes or hiding graph diagnostics', async t => {
  const { root, repository, storage } = await fixture(t); await storage.initialize(); const initial = createProject('Unavailable'), source = path.join(root, 'Source.txt'); await fs.writeFile(source, 'Expected');
  const imported = await new FileStore(root).importFile(source, initial.id), project = await repository.add(applyCommands(initial, [{ kind: 'asset.register', asset: assetFor(imported.blob, 'Source.txt'), blob: imported.blob }])), folder = await storage.projectFolder(project);
  await fs.writeFile(path.join(root, imported.blob.path), 'Altered'); const statuses: string[] = [];
  const replacement = await migrateProjectFiles(project, folder, repository, { skipUnavailable: true, onUnavailable: (_blob, status) => statuses.push(status) });
  assert.deepEqual(statuses, ['changed']); assert.equal(replacement.blobs[0].path, imported.blob.path); assert.equal(replacement.blobs[0].sha256, digest('Expected'));
  await assert.rejects(() => migrateProjectFiles(project, folder, repository), /недоступен или изменён/u);
  await fs.unlink(path.join(root, imported.blob.path)); statuses.length = 0;
  await migrateProjectFiles(project, folder, repository, { skipUnavailable: true, onUnavailable: (_blob, status) => statuses.push(status) }); assert.deepEqual(statuses, ['missing']);
});

test('preparing a new root and failing file migration leaves the exact settings registry unchanged and retries its own reserved folders', async t => {
  const { root, repository, storage } = await fixture(t); await storage.initialize();
  const source = path.join(root, 'Original.txt'); await fs.writeFile(source, 'Expected'); const initial = createProject('Stable');
  const imported = await new FileStore(root).importFile(source, initial.id), project = await repository.add(applyCommands(initial, [{ kind: 'asset.register', asset: assetFor(imported.blob, 'Original.txt'), blob: imported.blob }]));
  await storage.projectFolder(project); const before = await repository.readText('.twdata/settings.json'), plan = await storage.prepareRoot('New Place');
  assert.equal(await repository.readText('.twdata/settings.json'), before); assert.equal(storage.dataRoot, 'TWData');
  await fs.writeFile(path.join(root, imported.blob.path), 'Unexpected');
  await assert.rejects(() => migrateProjectFiles(project, `${plan.dataRoot}/projects/${plan.projectFolders[project.id]}`, repository));
  assert.equal(await repository.readText('.twdata/settings.json'), before); assert.equal(storage.dataRoot, 'TWData');
  assert.deepEqual(await storage.prepareRoot('New Place'), plan);
  await fs.writeFile(path.join(root, imported.blob.path), 'Expected');
  const replacement = await migrateProjectFiles(project, `${plan.dataRoot}/projects/${plan.projectFolders[project.id]}`, repository);
  assert.ok(replacement.blobs[0].path.startsWith('New Place/projects/Stable/documents/'));
  await storage.commitRoot(plan); assert.equal(storage.dataRoot, 'New Place'); assert.equal(await storage.projectFolder(project), 'New Place/projects/Stable');
});

test('new visible TWData with projects and exports never activates the old metadata migration', async t => {
  const { root, storage } = await fixture(t); await storage.initialize(); await storage.projectFolder(createProject('Visible'));
  await fs.writeFile(path.join(root, 'TWData/exports/summary.md'), 'Visible report');
  await migrateLegacyVault(root); assert.equal(await fs.readFile(path.join(root, 'TWData/exports/summary.md'), 'utf8'), 'Visible report');
  await assert.rejects(() => fs.stat(path.join(root, '.twdata/layout-migration.json')), { code: 'ENOENT' });
});

test('metadata-like research titles get safe stable folders in default and custom roots and reject unsafe registry mappings', async t => {
  const { root, repository, storage } = await fixture(t); await storage.initialize();
  const source = path.join(root, 'Material.txt'); await fs.writeFile(source, 'Material bytes');
  for (const dataRoot of ['TWData', 'Research Files']) {
    await storage.configureRoot(dataRoot);
    for (const title of ['state.json', 'settings.json', 'STATE.JSON', '_TraceWeave', 'writer.lock']) {
      const project = createProject(title), folder = await storage.projectFolder(project);
      assert.ok(path.posix.basename(folder).startsWith(`${title} (`), folder); assert.ok(folder.endsWith(')'), folder); assert.equal(isTechnicalPath(folder), false);
      const imported = await new FileStore(root, undefined, storage.projectsRoot).importFile(source, project.id, [], { projectFolder: folder });
      assert.ok(imported.blob.path.startsWith(folder + '/documents/')); assert.equal(await new FileStore(root).verify(imported.blob), 'ok');
      assert.equal(await storage.projectFolder({ ...project, title: 'Renamed' }), folder);
      const restarted = new VisibleStorage(repository); await restarted.initialize(); assert.equal(await restarted.projectFolder(project), folder);
      assert.throws(() => validateVisibleStoragePlan({ formatVersion: 2, dataRoot, projectFolders: { [project.id]: title } }), /Invalid or duplicate/u);
    }
  }
});

test('startup preservation keeps a verified user filename inside its project folder while strict migration relocates it', async t => {
  const { root, repository, storage } = await fixture(t); await storage.initialize();
  const project = createProject('Renamed original'), folder = await storage.projectFolder(project), source = path.join(root, 'Original.txt'); await fs.writeFile(source, 'Verified bytes');
  const imported = await new FileStore(root).importFile(source, project.id, [], { projectFolder: folder }), canonicalPath = imported.blob.path;
  const renamed = `${folder}/User organization/My chosen filename.txt`; await fs.mkdir(path.dirname(path.join(root, renamed)), { recursive: true }); await fs.rename(path.join(root, canonicalPath), path.join(root, renamed));
  imported.blob.path = renamed;
  const registered = await repository.add(applyCommands(project, [{ kind: 'asset.register', asset: assetFor(imported.blob, 'Original.txt'), blob: imported.blob }]));
  const preserved = await migrateProjectFiles(registered, folder, repository, { preserveInsideDestination: true }); assert.deepEqual(preserved, registered);
  await assert.rejects(() => fs.stat(path.join(root, canonicalPath)), { code: 'ENOENT' });
  const strict = await migrateProjectFiles(registered, folder, repository); assert.equal(strict.blobs[0].path, canonicalPath); assert.equal(await fs.readFile(path.join(root, canonicalPath), 'utf8'), 'Verified bytes');
  const other = await migrateProjectFiles(registered, 'Other Data/projects/Changed root', repository, { preserveInsideDestination: true }); assert.ok(other.blobs[0].path.startsWith('Other Data/projects/Changed root/documents/Original--'));
  await fs.writeFile(path.join(root, renamed), 'Changed bytes');
  await assert.rejects(() => migrateProjectFiles(registered, folder, repository, { preserveInsideDestination: true }), /недоступен или изменён/u);
  assert.equal((await repository.read(project.id)).blobs[0].sha256, digest('Verified bytes'));
});

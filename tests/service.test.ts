import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalWorkbench, type Host } from '../src/service';
import { ProjectRepository, digest, stableJSON } from '../src/storage/repository';
import type { Project, Relation, ViewState } from '../src/types';

class FilesystemHost implements Host {
  reportsFolder?: () => string;
  newNoteFolder = 'Notes';
  readonly created: string[] = [];
  readonly opened: string[] = []; readonly shown: string[] = []; readonly sources = new Map<string, string>();
  constructor(readonly root: string) {}
  listNotes(): { path: string; title: string }[] {
    const notes: { path: string; title: string }[] = [];
    const walk = (prefix: string): void => { for (const entry of readdirSync(path.join(this.root, prefix), { withFileTypes: true })) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) walk(relative); else if (entry.isFile() && /\.md$/iu.test(entry.name)) notes.push({ path: relative, title: entry.name.slice(0, -3) }); } };
    walk(''); return notes;
  }
  async createNote(title: string): Promise<string> {
    const name = title.normalize('NFC').replace(/[<>:"/\\|?*]/gu, '-').trim() || 'Note';
    await fs.mkdir(path.join(this.root, this.newNoteFolder), { recursive: true });
    for (let index = 1; ; index++) {
      const relative = `${this.newNoteFolder}/${name}${index === 1 ? '' : ` (${index})`}.md`;
      try { await fs.writeFile(path.join(this.root, relative), '', { flag: 'wx' }); this.created.push(relative); return relative; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  async openNote(relative: string) { await fs.stat(path.join(this.root, relative)); this.opened.push(relative); }
  resourceUrl(relative: string) { return `app://local/${encodeURIComponent(relative)}`; }
  async showFile(relative: string) { this.shown.push(relative); }
  async filePath(file: File) { const source = this.sources.get(file.name); if (!source) throw new Error('Missing synthetic source'); return source; }
}
async function withService<T>(run: (service: LocalWorkbench, host: FilesystemHost, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-service-')), repository = new ProjectRepository(root), host = new FilesystemHost(root), service = new LocalWorkbench(repository, host);
  try { await service.initialize(); return await run(service, host, root); } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}
const current = (service: LocalWorkbench): Project => { const project = service.getSnapshot().project; assert.ok(project); return project; };
const relation = (source: string, target: string): Relation => ({ id: randomUUID(), sourceNodeId: source, targetNodeId: target, relationType: 'related', label: 'Основание', directed: true, bidirectional: false, assessment: 'hypothesis', confidence: 'medium', noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z', origin: { kind: 'manual' } });
async function fileTree(root: string, prefix = ''): Promise<string[]> { const files: string[] = []; for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) files.push(...await fileTree(root, relative)); else files.push(relative); } return files.sort(); }

test('adoption is byte-preserving, creates no frontmatter or per-note metadata, and prevents cross-project double binding', async () => {
  await withService(async (service, host, root) => {
    const body = '---\nчужое_свойство: "сохранить"\n---\n\n# e\u0301\n\n```json\n{"id":"not-traceweave"}\n```\n';
    await fs.mkdir(path.join(root, 'Existing')); await fs.writeFile(path.join(root, 'Existing/Оригинал.md'), body);
    await service.createProject('Исследование'); await service.adoptNote('Existing/Оригинал.md');
    assert.equal(await fs.readFile(path.join(root, 'Existing/Оригинал.md'), 'utf8'), body); const p = current(service); assert.equal(p.nodes[0].noteHash, digest(body));
    assert.deepEqual((await fileTree(root)).filter(item => !(item.startsWith('.twdata/') || item.startsWith('Исследования/'))), ['Existing/Оригинал.md']);
    await service.openNote(p.nodes[0].id); assert.deepEqual(host.opened, ['Existing/Оригинал.md']);
    await service.createProject('Второе исследование'); await assert.rejects(() => service.adoptNote('Existing/Оригинал.md'), /уже принадлежит/); assert.equal(current(service).nodes.length, 0);
  });
});

test('new notes and groups are empty Markdown, all metadata is centralized, subscriptions detach cleanly', async () => {
  await withService(async (service, host, root) => {
    let notifications = 0; const unsubscribe = service.subscribe(() => notifications++);
    await service.createProject('Исследование / опасное имя'); const id = await service.createNote('Аудио: интервью?'); const p = current(service), node = p.nodes.find(n => n.id === id)!;
    assert.equal(await fs.readFile(path.join(root, node.notePath), 'utf8'), ''); assert.equal(node.notePath, 'Notes/Аудио- интервью-.md'); assert.ok(Number.isFinite(Date.parse(node.createdAt))); assert.ok(Number.isFinite(Date.parse(node.updatedAt)));
    const groupId = await service.createGroup('Группа', [id]); const group = current(service).nodes.find(n => n.id === groupId)!;
    assert.equal(await fs.readFile(path.join(root, group.notePath), 'utf8'), ''); assert.equal(current(service).memberships[0].memberNodeId, id);
    assert.ok(notifications > 0); unsubscribe(); const count = notifications; await service.saveView({ mode: 'graph', selectedId: id, collapsedGroupIds: [groupId], expandedNodeIds: [] }); assert.equal(notifications, count);
    assert.equal((await service.loadView() as Partial<ViewState>).selectedId, id);
    const files = await fileTree(root); assert.deepEqual(files.filter(item => item.startsWith('Notes/')), [node.notePath, group.notePath].sort()); assert.ok(files.every(item => item.startsWith('.twdata/') || item.startsWith('Notes/') || item.startsWith('TWData/')));
    assert.ok(service.listNotes().every(item => item.path.startsWith('Notes/'))); assert.equal(host.opened.length, 0);
  });
});

test('active note bindings reject hidden and transitional service folders even when files exist',async()=>{
  await withService(async(service,_host,root)=>{
    await service.createProject('Visible notes');const id=await service.createNote('Allowed'),before=current(service).revision;
    for(const relative of ['.twdata/forbidden.md','TWData/notes/legacy.md','Outside/.hidden/forbidden.md']){await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),'Keep');await assert.rejects(()=>service.adoptNote(relative),/скрытых/);await assert.rejects(()=>service.relinkNote(id,relative),/скрытых/);assert.ok(!service.listNotes().some(note=>note.path===relative));assert.equal(await fs.readFile(path.join(root,relative),'utf8'),'Keep');}
    assert.equal(current(service).revision,before);
  });
});

test('the note picker excludes Markdown originals under the configured resource folder using Unicode folding',async()=>{
  await withService(async(service,host)=>{
    await service.createProject('Picker');await service.configureDataFolder('ẞources');host.listNotes=()=>[{path:'Ordinary/Note.md',title:'Note'},{path:'Notes/Note.md',title:'Managed'},{path:'ssOURCES/PROJECTS/original.md',title:'Original'},{path:'ẞources/projects/nested/original.md',title:'Nested'},{path:'ẞources/exports/summary.md',title:'Report'}];assert.deepEqual(service.listNotes().map(note=>note.title),['Note','Managed']);
  });
});

test('adopt and relink reject registered Markdown originals across projects after a resource folder rename',async()=>{
  await withService(async(service,host,root)=>{
    await service.createProject('Original owner');const source=path.join(root,'source.md'),body='\uFEFF---\noriginal: true\n---\n\nImmutable Markdown original.\n';await fs.writeFile(source,body);host.sources.set('source.md',source);await service.importFiles([new File([],'source.md')]);await fs.unlink(source);const owner=current(service),original=structuredClone(owner.blobs[0]);
    await fs.rename(path.join(root,'TWData/projects'),path.join(root,'Moved originals'));await service.onRenamed('Moved originals','TWData/projects');const movedOwner=current(service),moved=structuredClone(movedOwner.blobs[0]);assert.equal(moved.id,original.id);assert.ok(moved.path.startsWith('Moved originals/'));
    await service.createProject('New owner');const nodeId=await service.createNote('Existing binding'),before=structuredClone(current(service));await assert.rejects(()=>service.adoptNote(moved.path),/оригинал/);await assert.rejects(()=>service.relinkNote(nodeId,moved.path),/оригинал/);assert.deepEqual(current(service),before);assert.deepEqual(await service.repository.read(owner.id),movedOwner);assert.deepEqual(await fs.readFile(path.join(root,moved.path)),Buffer.from(body));
    const unregistered='Исследования/Вложения/plain.md';await fs.mkdir(path.dirname(path.join(root,unregistered)),{recursive:true});await fs.writeFile(path.join(root,unregistered),'Unregistered resource Markdown');await assert.rejects(()=>service.adoptNote(unregistered),/папке вложений/);await assert.rejects(()=>service.relinkNote(nodeId,unregistered),/папке вложений/);assert.deepEqual(current(service),before);
  });
});

test('folder rename and native edits preserve IDs/relations, including notes in trash and archived projects', async () => {
  await withService(async (service, _host, root) => {
    await fs.mkdir(path.join(root, 'Original')); await fs.writeFile(path.join(root, 'Original/А.md'), 'Первый'); await fs.writeFile(path.join(root, 'Original/Б.md'), 'Второй');
    await service.createProject('Исследование'); await service.adoptNote('Original/А.md'); await service.adoptNote('Original/Б.md');
    const [a, b] = current(service).nodes; const link = relation(a.id, b.id); await service.execute([{ kind: 'relation.create', relation: link }]);
    await service.execute([{ kind: 'elements.trash', nodeIds: [b.id], relationIds: [], groupMode: 'group_only' }]);
    await service.execute([{ kind: 'project.update', changes: { status: 'archived' } }]);
    await fs.rename(path.join(root, 'Original'), path.join(root, 'Renamed')); await service.onRenamed('Renamed', 'Original');
    assert.deepEqual(current(service).nodes.map(node => node.id), [a.id, b.id]); assert.deepEqual(current(service).nodes.map(node => node.notePath), ['Renamed/А.md', 'Renamed/Б.md']);
    assert.equal(current(service).relations[0].targetNodeId, b.id); assert.equal(current(service).relations[0].deletedAt !== null, true);
    await fs.writeFile(path.join(root, 'Renamed/А.md'), 'Внешняя правка'); await fs.writeFile(path.join(root, 'Renamed/Б.md'), 'Правка корзины'); await service.onFileChanged('Renamed/А.md');
    assert.equal(current(service).status, 'archived'); assert.equal(current(service).nodes[0].noteHash, digest('Внешняя правка')); assert.equal(current(service).nodes[1].noteHash, digest('Правка корзины'));
    await assert.rejects(() => service.createNote('Нельзя'), /архивирован/);
  });
});

test('renaming a common research folder reconciles note and verified original paths in one revision',async()=>{
  await withService(async(service,host,root)=>{
    host.newNoteFolder='Workspace/Notes';await service.configureDataFolder('Workspace/Data');await service.createProject('Folder move');const nodeId=await service.createNote('Note'),source=path.join(root,'source.bin'),bytes=Buffer.from([0,255,128,44]);await fs.writeFile(source,bytes);host.sources.set('source.bin',source);await service.importFiles([new File([],'source.bin')],nodeId);await fs.unlink(source);
    await service.execute([{kind:'project.update',changes:{status:'archived'}}]);const before=current(service);await fs.rename(path.join(root,'Workspace'),path.join(root,'Перенесённые исследования'));await service.onRenamed('Перенесённые исследования','Workspace');const after=current(service);
    assert.equal(after.revision,before.revision+1);assert.equal(after.status,'archived');assert.equal(after.nodes[0].id,before.nodes[0].id);assert.equal(after.blobs[0].id,before.blobs[0].id);assert.ok(after.nodes[0].notePath.startsWith('Перенесённые исследования/'));assert.ok(after.blobs[0].path.startsWith('Перенесённые исследования/'));assert.deepEqual(await fs.readFile(path.join(root,after.blobs[0].path)),bytes);assert.deepEqual(after.assets,before.assets);assert.deepEqual(after.attachments,before.attachments);assert.equal((await service.verifyAssets())[0].status,'ok');
    await fs.rename(path.join(root,'Перенесённые исследования'),path.join(root,'Испорченные'));await fs.writeFile(path.join(root,after.blobs[0].path.replace('Перенесённые исследования/','Испорченные/')),'Tampered');await assert.rejects(()=>service.onRenamed('Испорченные','Перенесённые исследования'),/изменён/);assert.equal(current(service).revision,after.revision+1);assert.equal(current(service).nodes[0].missing,true);assert.equal(current(service).nodes[0].notePath,after.nodes[0].notePath);assert.equal((await service.repository.read(after.id)).blobs[0].path,after.blobs[0].path);assert.deepEqual(service.getSnapshot().diagnostics?.affectedNodeIds,[nodeId]);assert.equal(service.getSnapshot().diagnostics?.assets[0].status,'missing');
  });
});

test('missing notes retain graph identity, explicit relink preserves relationships and refuses occupied targets', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Исследование'); const a = await service.createNote('А'), b = await service.createNote('Б'); const link = relation(a, b); await service.execute([{ kind: 'relation.create', relation: link }]);
    const p = current(service), oldPath = p.nodes[0].notePath; await fs.unlink(path.join(root, oldPath)); await service.onFileChanged(oldPath);
    assert.equal(current(service).nodes[0].missing, true); assert.equal(current(service).relations[0].id, link.id);
    assert.equal(await service.openNote(a), 'missing'); assert.deepEqual(_host.opened, []); await assert.rejects(() => fs.access(path.join(root, oldPath)), { code: 'ENOENT' }); await assert.rejects(() => service.relinkNote(a, p.nodes[1].notePath), /уже принадлежит/);
    await fs.mkdir(path.join(root, 'Recovered')); await fs.writeFile(path.join(root, 'Recovered/А.md'), 'Восстановленный текст'); await service.relinkNote(a, 'Recovered/А.md');
    assert.equal(current(service).nodes[0].id, a); assert.equal(current(service).nodes[0].missing, false); assert.equal(current(service).nodes[0].noteHash, digest('Восстановленный текст')); assert.equal(current(service).relations[0].sourceNodeId, a);
    assert.equal(await service.readNote(a), 'Восстановленный текст'); assert.deepEqual(current(service).snapshots, []);
  });
});

test('generic files without extensions, archives and binary material are visible and originals survive detach/undo', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Файлы'); const nodeId = await service.createNote('Материалы'); const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-source-'));
    try {
      const bytes = Buffer.from([0, 255, 1, 128, 0, 65]);
      for (const name of ['without-extension', 'evidence.7z', 'unknown.weird']) { const absolute = path.join(sourceRoot, name); await fs.writeFile(absolute, bytes); host.sources.set(name, absolute); }
      await service.importFiles([...host.sources.keys()].map(name => new File([], name)), nodeId);
      const p = current(service); assert.equal(p.assets.length, 3); assert.equal(p.blobs.length, 1); assert.equal(p.attachments.filter(item => item.role === 'primary').length, 1); assert.ok(p.assets.every(item => item.mediaKind === 'file'));
      assert.deepEqual(await fs.readFile(path.join(root, p.blobs[0].path)), bytes); assert.deepEqual((await service.verifyAssets()).map(item => item.status), ['ok', 'ok', 'ok']);
      await service.showAsset(p.assets[0].id); assert.equal(host.shown[0], p.blobs[0].path); assert.ok(service.resourceUrl(p.assets[0].id).startsWith('app://local/'));
      const attachment = p.attachments[0]; await service.execute([{ kind: 'attachment.detach', attachmentId: attachment.id }]); assert.equal(current(service).assets.length, 3); assert.deepEqual(await fs.readFile(path.join(root, p.blobs[0].path)), bytes);
      await service.undo(); assert.equal(current(service).attachments.length, 3); await service.redo(); assert.equal(current(service).attachments.length, 2); assert.deepEqual(await fs.readFile(path.join(root, p.blobs[0].path)), bytes);
      await fs.writeFile(path.join(root, p.blobs[0].path), 'tampered'); assert.deepEqual((await service.verifyAssets()).map(item => item.status), ['changed', 'changed', 'changed']);
    } finally { await fs.rm(sourceRoot, { recursive: true, force: true }); }
  });
});

test('resources added outside Obsidian extension whitelist appear unregistered and register explicitly', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Обнаружение'); const p = current(service), folder = `TWData/projects/${p.title}`;
    await fs.mkdir(path.join(root, folder), { recursive: true }); await fs.writeFile(path.join(root, folder, 'direct.bin'), Buffer.from([0, 1, 255]));
    const found = await service.discoverResources(); assert.deepEqual(found, [{ path: `${folder}/direct.bin`, byteSize: 3, registered: false }]); assert.equal(current(service).assets.length, 0);
    await service.registerResource(found[0].path); assert.equal(current(service).assets.length, 1); assert.equal(current(service).attachments.length, 0); assert.equal(current(service).nodes.length, 0);
    const registered = await service.discoverResources(); assert.ok(registered.some(item => item.registered)); assert.ok(registered.some(item => item.path === found[0].path)); assert.deepEqual(await fs.readFile(path.join(root, found[0].path)), Buffer.from([0, 1, 255]));
    await assert.rejects(() => service.registerResource('Elsewhere/secret.bin'), /вне.*папки/);
  });
});

test('resource discovery includes the visible project root and configured roots copy originals safely', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Direct research'); const original = Buffer.from([0, 255, 17]);
    await fs.writeFile(path.join(root, 'TWData/projects/direct.bin'), original);
    const initial = await service.discoverResources(); assert.ok(initial.some(item => item.path === 'TWData/projects/direct.bin' && !item.registered));
    await service.registerResource('TWData/projects/direct.bin'); const first = structuredClone(current(service).blobs[0]);
    assert.ok(first.path.startsWith('TWData/projects/Direct research/other/'));
    assert.deepEqual(await fs.readFile(path.join(root, first.path)), original);
    await service.configureDataFolder('Research evidence');
    const migrated = current(service).blobs[0]; assert.equal(migrated.id, first.id); assert.ok(migrated.path.startsWith('Research evidence/projects/Direct research/other/'));
    assert.deepEqual(await fs.readFile(path.join(root, migrated.path)), original); assert.deepEqual(await fs.readFile(path.join(root, first.path)), original);
    const other = Buffer.from([128, 0, 44]); await fs.writeFile(path.join(root, 'Research evidence/projects/without-extension'), other);
    await service.registerResource('Research evidence/projects/without-extension'); assert.equal(current(service).assets.length, 2);
    assert.deepEqual(await fs.readFile(path.join(root, 'Research evidence/projects/without-extension')), other);
    const before = await fileTree(root); await assert.rejects(() => service.registerResource('Research evidence/projects-other/outside.bin'), /вне.*папки/); await assert.rejects(() => service.registerResource('Outside/direct.bin'), /вне.*папки/); assert.deepEqual(await fileTree(root), before);
  });
});

test('a renamed visible original keeps its path, proof and attachment after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-original-rename-'));
  const host = new FilesystemHost(root); let service = new LocalWorkbench(new ProjectRepository(root), host);
  try {
    await service.initialize(); await service.createProject('Rename original'); const nodeId = await service.createNote('Owner');
    const source = path.join(root, 'source.bin'), bytes = Buffer.from([0, 128, 255, 42]);
    await fs.writeFile(source, bytes); host.sources.set('source.bin', source); await service.importFiles([new File([], 'source.bin')], nodeId); await fs.unlink(source);
    const before = structuredClone(current(service)), blob = before.blobs[0];
    const renamed = `${path.posix.dirname(blob.path)}/Переименованный файл.bin`;
    await fs.rename(path.join(root, blob.path), path.join(root, renamed)); await service.onRenamed(renamed, blob.path);
    const afterRename = structuredClone(current(service)); assert.equal(afterRename.blobs[0].path, renamed);
    await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), host); await service.initialize(); await service.openProject(before.id);
    const restored = current(service); assert.deepEqual(restored, afterRename); assert.equal(restored.blobs[0].id, blob.id);
    assert.deepEqual(await fs.readFile(path.join(root, renamed)), bytes); assert.deepEqual(restored.attachments, before.attachments);
    await assert.rejects(() => fs.access(path.join(root, blob.path)), { code: 'ENOENT' }); assert.equal((await service.diagnoseProject()).assets[0].status, 'ok');
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('search updates after native Markdown edits and root service restarts from centralized JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-service-restart-')); const host = new FilesystemHost(root); let service = new LocalWorkbench(new ProjectRepository(root), host);
  try {
    await service.initialize(); await service.createProject('Поиск'); const id = await service.createNote('А'); const p = current(service), notePath = p.nodes[0].notePath;
    await fs.writeFile(path.join(root, notePath), 'Точный поиск %_ Кириллица'); await service.onFileChanged(notePath); assert.equal((await service.search('%_'))[0].nodeId, id); assert.equal((await service.search('кириллица')).length, 1);
    await fs.writeFile(path.join(root, notePath), 'Новый термин'); await service.onFileChanged(notePath); assert.equal((await service.search('Кириллица')).length, 0); assert.equal((await service.search('термин')).length, 1);
    const revision = current(service).revision; await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), host); await service.initialize(); assert.equal(current(service).nodes[0].id, id); assert.equal(current(service).revision, revision); assert.equal((await service.search('термин'))[0].nodeId, id);
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('immutable report captures original note body and locks prior metadata history', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Отчёт'); const id = await service.createNote('Вывод'); const notePath = current(service).nodes[0].notePath;
    await fs.writeFile(path.join(root, notePath), 'Первый текст'); await service.onFileChanged(notePath);
    const snapshot = await service.createReport('Зафиксировано', [id]); const before = await fs.readFile(path.join(root, snapshot.path), 'utf8');
    await fs.writeFile(path.join(root, notePath), 'Изменённый текст'); await service.onFileChanged(notePath);
    assert.equal(await fs.readFile(path.join(root, snapshot.path), 'utf8'), before); assert.ok(before.includes('Первый текст')); assert.ok(!before.includes('Изменённый текст'));
    assert.equal(service.getSnapshot().canUndo, false); await assert.rejects(() => service.undo(), /Нет доступного/);
    assert.ok(snapshot.path.startsWith('TWData/exports/Отчёт/snapshots/'));  await service.openReport(snapshot.id);
  });
});

test('visible data roots persist centrally while native notes keep their host location', async () => {
  await withService(async (service, host, root) => {
    assert.equal(service.getDataFolder(), 'TWData');
    await service.configureDataFolder('Research/Data');
    await service.createProject('Folders'); const nodeId = await service.createNote('Native note'), node = current(service).nodes.find(item => item.id === nodeId)!;
    assert.equal(node.notePath, 'Notes/Native note.md'); assert.equal(host.created[0], node.notePath);
    const settings = JSON.parse(await fs.readFile(path.join(root, '.twdata/settings.json'), 'utf8'));
    assert.deepEqual(settings, { formatVersion: 2, dataRoot: 'Research/Data', projectFolders: { [current(service).id]: 'Folders' } });
    assert.equal(service.paths.resourcesRoot, 'Research/Data/projects');
    const second = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.dispose();
    try { await second.initialize(); assert.equal(second.getDataFolder(), 'Research/Data'); assert.equal(current(second).nodes[0].id, nodeId); assert.equal(current(second).nodes[0].notePath, node.notePath); } finally { await second.dispose(); }
  });
});

test('hidden, malformed, configuration and symlink data roots leave durable settings unchanged', async () => {
  await withService(async (service, _host, root) => {
    await service.configureDataFolder('Research/Data');
    const original = await fs.readFile(path.join(root, '.twdata/settings.json'));
    await fs.mkdir(path.join(root, 'Real')); await fs.symlink(path.join(root, 'Real'), path.join(root, 'Alias'));
    for (const value of ['', '../Outside', 'Research/../Outside', '/absolute', '.hidden', 'Research/.private', '_TraceWeave', 'TWData/projects', 'Alias/Data']) await assert.rejects(() => service.configureDataFolder(value));
    assert.deepEqual(await fs.readFile(path.join(root, '.twdata/settings.json')), original); assert.equal(service.getDataFolder(), 'Research/Data');
    await service.createProject('Settings remain usable'); await service.createNote('Visible note'); assert.equal(current(service).nodes[0].notePath, 'Notes/Visible note.md');
  });
});

test('import preserves filename whitespace while producing valid normalized asset titles', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Filenames'); const source = path.join(root, 'source.bin'); await fs.writeFile(source, Buffer.from([1, 128, 255]));
    const names = [' leading.bin', 'trailing.bin ', '   ', '😀'.repeat(220) + '.bin'];
    for (const name of names) host.sources.set(name, source);
    await service.importFiles(names.map(name => new File([], name)));
    const project = current(service);
    assert.deepEqual(project.assets.map(asset => asset.originalName), names);
    assert.deepEqual(project.assets.map(asset => asset.title), ['leading.bin', 'trailing.bin', 'Материал', '😀'.repeat(200)]);
    assert.equal(project.blobs.length, 1); assert.deepEqual((await service.verifyAssets()).map(asset => asset.status), ['ok', 'ok', 'ok', 'ok']);
  });
});

test('a visible custom Obsidian configuration directory cannot be listed, adopted or read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-custom-config-')), host = new FilesystemHost(root);
  const service = new LocalWorkbench(new ProjectRepository(root, { configDir: 'Configuration' }), host);
  try {
    await fs.mkdir(path.join(root, 'Configuration')); await fs.writeFile(path.join(root, 'Configuration/private.md'), 'Private settings');
    await fs.writeFile(path.join(root, 'Ordinary.md'), 'Ordinary'); await service.initialize(); await service.createProject('Config protection');
    assert.deepEqual(service.listNotes().map(note => note.path), ['Ordinary.md']);
    await assert.rejects(() => service.adoptNote('Configuration/private.md'), /Unsafe relative path/);
    await assert.rejects(() => service.repository.readText('Configuration/private.md'), /Unsafe relative path/);
    await assert.rejects(() => service.repository.atomicText('Configuration/private.md', 'Changed'), /Unsafe relative path/);
    await service.adoptNote('Ordinary.md');
    await assert.rejects(() => service.relinkNote(current(service).nodes[0].id, 'configuration/private.md'), /Unsafe relative path/);
    assert.equal(await fs.readFile(path.join(root, 'Configuration/private.md'), 'utf8'), 'Private settings');
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('archive import validates every final note destination before publishing into a custom configuration folder', async () => {
  const sourceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-import-source-')));
  const source = new LocalWorkbench(new ProjectRepository(sourceRoot), new FilesystemHost(sourceRoot));
  try {
    await source.initialize();
    await source.createProject('Portable source'); await source.createNote('Original note'); const archive = await source.exportProject();
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-import-custom-config-'))), host = new FilesystemHost(root);
    host.sources.set('backup.zip', path.join(sourceRoot, archive));
    const service = new LocalWorkbench(new ProjectRepository(root, { configDir: 'Исследования/Заметки' }), host);
    try {
      await fs.mkdir(path.join(root, 'Исследования/Заметки'), { recursive: true }); await fs.writeFile(path.join(root, 'Исследования/Заметки/private.md'), 'Private configuration');
      await service.initialize(); await assert.rejects(() => service.importArchive(new File([], 'backup.zip')), /Unsafe relative path/);
      assert.deepEqual(await fs.readdir(path.join(root, 'Исследования/Заметки')), ['private.md']);
      assert.equal(await fs.readFile(path.join(root, 'Исследования/Заметки/private.md'), 'utf8'), 'Private configuration');
      assert.deepEqual(await service.repository.list(), []);
    } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  } finally { await source.dispose(); await fs.rm(sourceRoot, { recursive: true, force: true }); }
});

test('external JSON edits at the same revision are detected before overwriting metadata', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Первоначальный заголовок'); const p = current(service), external = structuredClone(p); external.title = 'Изменён извне';
    await fs.writeFile(path.join(root, service.repository.statePath(p.id)), stableJSON(external));
    await assert.rejects(() => service.execute([{ kind: 'project.update', changes: { descriptionMarkdown: 'Локальная правка' } }]), /JSON изменён извне/);
    assert.equal(current(service).revision, p.revision); assert.equal((await service.repository.read(p.id)).title, 'Изменён извне'); assert.equal((await service.repository.read(p.id)).descriptionMarkdown, '');
    await service.openProject(p.id); await service.execute([{ kind: 'project.update', changes: { descriptionMarkdown: 'После обновления' } }]); assert.equal(current(service).title, 'Изменён извне'); assert.equal(current(service).descriptionMarkdown, 'После обновления');
  });
});

test('drafts remain centralized, durable and scoped to their original project across project switches', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Первый'); const first = current(service), firstKey = `${first.id}/new-relation`;
    await service.saveDraft(firstKey, { label: 'Несохранённая связь', quote: 'Точный текст' }); assert.deepEqual(await service.loadDrafts(), { [firstKey]: { label: 'Несохранённая связь', quote: 'Точный текст' } });
    await service.createProject('Второй'); const second = current(service), secondKey = `${second.id}/new-node`; assert.deepEqual(await service.loadDrafts(), {});
    await service.saveDraft(secondKey, { title: 'Черновик второго' }); await service.saveDraft(firstKey, { label: 'Первый после смены проекта' });
    assert.deepEqual(await service.loadDrafts(second.id), { [secondKey]: { title: 'Черновик второго' } }); assert.deepEqual(await service.loadDrafts(first.id), { [firstKey]: { label: 'Первый после смены проекта' } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; await assert.rejects(() => service.saveDraft(firstKey, cyclic), /JSON/); assert.deepEqual(await service.loadDrafts(first.id), { [firstKey]: { label: 'Первый после смены проекта' } });
    await assert.rejects(() => service.saveDraft('../escape', { malicious: true }));
    const restarted = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.dispose(); try { await restarted.initialize(); assert.deepEqual(await restarted.loadDrafts(first.id), { [firstKey]: { label: 'Первый после смены проекта' } }); await restarted.saveDraft(firstKey, null); assert.deepEqual(await restarted.loadDrafts(first.id), {}); assert.deepEqual(await restarted.loadDrafts(second.id), { [secondKey]: { title: 'Черновик второго' } }); } finally { await restarted.dispose(); }
    assert.ok((await fileTree(root)).every(filename => (filename.startsWith('.twdata/') || filename.startsWith('TWData/'))));
  });
});

test('a read-only second service refuses imports/reports before creating orphan files', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Single writer'); const p = current(service), sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-readonly-source-'));
    let second: LocalWorkbench | null = null;
    try {
      const source = path.join(sourceRoot, 'opaque.bin'); await fs.writeFile(source, Buffer.from([0, 255, 128]));
      const host = new FilesystemHost(root); host.sources.set('opaque.bin', source); host.sources.set('not-even-opened.zip', path.join(sourceRoot, 'nonexistent.zip'));
      second = new LocalWorkbench(new ProjectRepository(root), host); await second.initialize(); assert.equal(second.repository.readOnly, true); const before = await fileTree(root);
      await assert.rejects(() => second!.importFiles([new File([], 'opaque.bin')]), /недоступна/); assert.deepEqual(await fileTree(root), before);
      await assert.rejects(() => second!.createReport('Should not exist'), /недоступна/); assert.deepEqual(await fileTree(root), before);
      await assert.rejects(() => second!.exportReadableReport(), /недоступна/); assert.deepEqual(await fileTree(root), before);
      await assert.rejects(() => second!.registerResource(`TWData/projects/${p.title}/nonexistent.bin`), /недоступна/); assert.deepEqual(await fileTree(root), before);
      await assert.rejects(() => second!.importArchive(new File([], 'not-even-opened.zip')), /недоступна/); assert.deepEqual(await fileTree(root), before);
      assert.equal((await service.repository.read(p.id)).revision, 0);
    } finally { await second?.dispose(); await fs.rm(sourceRoot, { recursive: true, force: true }); }
  });
});

test('readable report exports all active research into the configured vault folder without changing source state', async () => {
  await withService(async (service, host, root) => {
    host.reportsFolder = () => '../obsolete-option-must-not-control-new-export';
    await service.createProject('Отчёт для телефона');
    const first = await service.createNote('Первый'), second = await service.createNote('Второй');
    for (const node of current(service).nodes) {
      await fs.writeFile(path.join(root, node.notePath), `Полный текст: ${node.title}`);
      await service.onFileChanged(node.notePath);
    }
    await service.execute([{ kind: 'relation.create', relation: relation(first, second) }]);
    const sourcePath = path.join(root, 'recording.bin'), bytes = Buffer.from([0, 255, 35, 18]);
    await fs.writeFile(sourcePath, bytes); host.sources.set('recording.bin', sourcePath);
    await service.importFiles([new File([], 'recording.bin')], first);
    const before = structuredClone(current(service));
    const report = await service.exportReadableReport();
    assert.equal(report.directory, 'TWData/exports/Отчёт для телефона');
    assert.equal(report.summaryPath, report.directory + '/summary.md');
    assert.equal(report.canvasPath, report.directory + '/scheme.canvas');
    assert.equal(host.opened.at(-1), report.summaryPath);
    assert.deepEqual(current(service), before);
    const text = await fs.readFile(path.join(root, report.summaryPath), 'utf8');
    assert.ok(text.includes('Полный текст: Первый')); assert.ok(text.includes('Полный текст: Второй'));
    assert.ok(text.includes('Основание'));
    const canvas = JSON.parse(await fs.readFile(path.join(root, report.canvasPath), 'utf8'));
    assert.equal(canvas.nodes.length, 2); assert.equal(canvas.edges.length, 1);
    const outputFiles = (await fileTree(root)).filter(file => file.startsWith(report.directory + '/Attachments/'));
    assert.equal(outputFiles.length, 1); assert.deepEqual(await fs.readFile(path.join(root, outputFiles[0])), bytes);
    await service.configureDataFolder('Reports/For phone');
    const afterRootChange = structuredClone(current(service));
    const nested = await service.exportReadableReport();
    assert.equal(nested.directory, 'Reports/For phone/exports/Отчёт для телефона');
    const repeated = await service.exportReadableReport();
    assert.equal(repeated.directory, 'Reports/For phone/exports/Отчёт для телефона (2)');
    assert.equal(await fs.readFile(path.join(root, report.summaryPath), 'utf8'), text);
    assert.deepEqual(current(service), afterRootChange);
    await fs.writeFile(path.join(root, before.nodes[0].notePath), 'Later source edit');
    await service.onFileChanged(before.nodes[0].notePath);
    assert.equal(await fs.readFile(path.join(root, report.summaryPath), 'utf8'), text);
    assert.deepEqual(await fs.readFile(path.join(root, before.blobs[0].path)), bytes);
  });
});

test('readable export failures preserve source files and describe an already saved report when opening fails', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Opening failure'); await service.createNote('Note');
    host.openNote = async () => { throw new Error('Synthetic editor failure'); };
    await assert.rejects(() => service.exportReadableReport(), /Отчёт создан: TWData\/exports\/Opening failure\/summary\.md.*Synthetic editor failure/u);
    assert.ok((await fs.readFile(path.join(root, 'TWData/exports/Opening failure/summary.md'), 'utf8')).includes('Note'));
    const before = await fileTree(root);
    await assert.rejects(() => service.configureDataFolder('../outside'));
    assert.deepEqual(await fileTree(root), before);
  });
});

test('node creation links the chosen vault note title and type without modifying its bytes', async () => {
  await withService(async (service, host, root) => {
    await fs.mkdir(path.join(root, 'Existing')); const body = '---\ncustom: preserved\n---\n\n# Original body\n';
    await fs.writeFile(path.join(root, 'Existing/Source.md'), body); await service.createProject('Explicit binding');
    const type = current(service).nodeTypes.find(item => item.code === 'person')!;
    await service.adoptNote('Existing/Source.md', 'Person in the source', type.id);
    const node = current(service).nodes[0];
    assert.equal(node.title, 'Person in the source'); assert.equal(node.typeId, type.id); assert.equal(node.notePath, 'Existing/Source.md');
    assert.deepEqual(host.created, []); assert.equal(await fs.readFile(path.join(root, node.notePath), 'utf8'), body);
    assert.equal(await service.openNote(node.id), 'opened'); assert.deepEqual(host.opened, [node.notePath]);
  });
});

test('recreating a missing note preserves its node identity, relationships and attachments', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Repair'); const first = await service.createNote('First'), second = await service.createNote('Second');
    const edge = relation(first, second); await service.execute([{ kind: 'relation.create', relation: edge }]);
    const source = path.join(root, 'source.bin'); await fs.writeFile(source, Buffer.from([1, 2, 3])); host.sources.set('source.bin', source); await service.importFiles([new File([], 'source.bin')], first);
    const before = structuredClone(current(service)), oldPath = before.nodes[0].notePath;
    await fs.unlink(path.join(root, oldPath)); assert.equal(await service.openNote(first), 'missing');
    assert.deepEqual(await fs.readdir(path.join(root, 'Notes')), ['Second.md']); assert.deepEqual(host.opened, []);
    host.newNoteFolder = 'Native configured folder'; await fs.mkdir(path.join(root, host.newNoteFolder)); await fs.writeFile(path.join(root, host.newNoteFolder, 'First.md'), 'Unrelated note');
    await service.recreateNote(first); const after = current(service), recreated = after.nodes.find(node => node.id === first)!;
    assert.equal(recreated.id, first); assert.equal(recreated.notePath, 'Native configured folder/First (2).md'); assert.equal(recreated.missing, false); assert.equal(recreated.createdAt, before.nodes[0].createdAt);
    assert.deepEqual(after.relations, before.relations); assert.deepEqual(after.attachments, before.attachments); assert.deepEqual(after.assets, before.assets);
    assert.equal(await fs.readFile(path.join(root, recreated.notePath), 'utf8'), ''); assert.equal(await fs.readFile(path.join(root, host.newNoteFolder, 'First.md'), 'utf8'), 'Unrelated note');
    assert.equal(await service.openNote(first), 'opened'); assert.equal(host.opened.at(-1), recreated.notePath);
    const tree = await fileTree(root); await assert.rejects(() => service.recreateNote(first), /снова доступна/); assert.deepEqual(await fileTree(root), tree);
  });
});

test('diagnostics verifies all files including unassigned assets and same-size changes', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Diagnosis'); const first = await service.createNote('First'), second = await service.createNote('Second');
    for (const [name, bytes, nodeId] of [['first.bin', [1, 2, 3], first], ['second.bin', [4, 5, 6], second], ['unassigned.bin', [7, 8, 9], undefined]] as const) {
      const source = path.join(root, name); await fs.writeFile(source, Buffer.from(bytes)); host.sources.set(name, source); await service.importFiles([new File([], name)], nodeId);
    }
    const original = structuredClone(current(service)), firstBlob = original.blobs.find(blob => blob.id === original.assets[0].blobId)!, secondBlob = original.blobs.find(blob => blob.id === original.assets[1].blobId)!, unassignedBlob = original.blobs.find(blob => blob.id === original.assets[2].blobId)!;
    await fs.unlink(path.join(root, original.nodes[1].notePath)); await fs.unlink(path.join(root, firstBlob.path)); await fs.writeFile(path.join(root, secondBlob.path), Buffer.from([6, 5, 4]));
    const diagnostics = await service.diagnoseProject();
    assert.deepEqual(diagnostics.notes.map(item => item.status), ['ok', 'missing']); assert.deepEqual(diagnostics.assets.map(item => item.status), ['missing', 'changed', 'ok']);
    assert.deepEqual(new Set(diagnostics.affectedNodeIds), new Set([first, second])); assert.equal(diagnostics.assets[2].assetId, original.assets[2].id); assert.ok(Number.isFinite(Date.parse(diagnostics.checkedAt)));
    assert.equal(current(service).nodes[1].missing, true); assert.deepEqual(current(service).relations, original.relations); assert.deepEqual(current(service).attachments, original.attachments);
    await fs.writeFile(path.join(root, unassignedBlob.path), Buffer.from([9, 8, 7])); await service.onFileChanged(unassignedBlob.path);
    assert.deepEqual(service.getSnapshot().diagnostics?.assets.map(item => item.status), ['missing', 'changed', 'changed']);
    await fs.writeFile(path.join(root, original.nodes[1].notePath), 'Restored note'); await fs.writeFile(path.join(root, firstBlob.path), Buffer.from([1, 2, 3])); await fs.writeFile(path.join(root, secondBlob.path), Buffer.from([4, 5, 6])); await fs.writeFile(path.join(root, unassignedBlob.path), Buffer.from([7, 8, 9]));
    const restored = await service.diagnoseProject(); assert.ok(restored.notes.every(item => item.status === 'ok')); assert.ok(restored.assets.every(item => item.status === 'ok')); assert.deepEqual(restored.affectedNodeIds, []);
  });
});

test('diagnostics marks symlink note and original bindings invalid without reading their targets', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Unsafe bindings'); const nodeId = await service.createNote('Note'); const source = path.join(root, 'source.bin'); await fs.writeFile(source, Buffer.from([1, 2, 3])); host.sources.set('source.bin', source); await service.importFiles([new File([], 'source.bin')], nodeId);
    const project = current(service), node = project.nodes[0], blob = project.blobs[0], outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-diagnostics-outside-'));
    try {
      const outsideNote = path.join(outside, 'outside.md'), outsideOriginal = path.join(outside, 'outside.bin'); await fs.writeFile(outsideNote, 'Outside must remain untouched'); await fs.writeFile(outsideOriginal, Buffer.from([1, 2, 3]));
      await fs.unlink(path.join(root, node.notePath)); await fs.symlink(outsideNote, path.join(root, node.notePath)); await fs.unlink(path.join(root, blob.path)); await fs.symlink(outsideOriginal, path.join(root, blob.path));
      const diagnostics = await service.diagnoseProject(); assert.equal(diagnostics.notes[0].status, 'invalid'); assert.equal(diagnostics.assets[0].status, 'invalid'); assert.deepEqual(diagnostics.affectedNodeIds, [nodeId]);
      assert.equal(await service.openNote(nodeId), 'missing'); assert.deepEqual(host.opened, []); assert.equal(await fs.readFile(outsideNote, 'utf8'), 'Outside must remain untouched');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});

test('read-only diagnosis reports a deleted note without metadata writes or native file creation', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Read-only diagnosis'); const nodeId = await service.createNote('Note'), project = structuredClone(current(service));
    await fs.unlink(path.join(root, project.nodes[0].notePath));
    const host = new FilesystemHost(root), second = new LocalWorkbench(new ProjectRepository(root), host);
    try {
      await second.initialize(); assert.equal(second.repository.readOnly, true); const statePath = path.join(root, service.repository.statePath(project.id)), stateBefore = await fs.readFile(statePath), tree = await fileTree(root);
      const diagnostics = await second.diagnoseProject(); assert.equal(diagnostics.notes[0].status, 'missing'); assert.deepEqual(diagnostics.affectedNodeIds, [nodeId]);
      assert.equal(await second.openNote(nodeId), 'missing'); await assert.rejects(() => second.createNote('Forbidden'), /недоступна/); await assert.rejects(() => second.recreateNote(nodeId), /недоступна/); await assert.rejects(() => second.configureDataFolder('Forbidden'), /недоступна/);
      assert.deepEqual(await fs.readFile(statePath), stateBefore); assert.deepEqual(await fileTree(root), tree); assert.deepEqual(host.created, []); assert.deepEqual(host.opened, []);
    } finally { await second.dispose(); }
  });
});

test('a metadata commit failure retains the ordinary native note and never creates an internal copy', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Commit failure'); const before = structuredClone(current(service)), execute = service.repository.execute.bind(service.repository);
    service.repository.execute = async () => { throw new Error('Synthetic metadata commit failure'); };
    try { await assert.rejects(() => service.createNote('Retained ordinary note'), /Synthetic metadata commit failure/); } finally { service.repository.execute = execute; }
    assert.deepEqual(current(service), before); assert.deepEqual(host.created, ['Notes/Retained ordinary note.md']); assert.equal(await fs.readFile(path.join(root, host.created[0]), 'utf8'), '');
    assert.deepEqual((await fileTree(root)).filter(filename => filename.endsWith('.md')), host.created);
    await fs.writeFile(path.join(root, host.created[0]), 'Can edit normally'); await service.adoptNote(host.created[0]); assert.equal(current(service).nodes[0].noteHash, digest('Can edit normally'));
  });
});

test('changing the data root validates every project before committing any binding or settings', async () => {
  await withService(async (service, host, root) => {
    const projects: Project[] = [];
    for (const [title, name, bytes] of [['First project', 'first.bin', [1, 2, 3]], ['Second project', 'second.bin', [4, 5, 6]]] as const) {
      await service.createProject(title); const source = path.join(root, name); await fs.writeFile(source, Buffer.from(bytes)); host.sources.set(name, source); await service.importFiles([new File([], name)]); projects.push(structuredClone(current(service)));
    }
    const settingsPath = path.join(root, '.twdata/settings.json'), settings = await fs.readFile(settingsPath), states = await Promise.all(projects.map(project => fs.readFile(path.join(root, service.repository.statePath(project.id)))));
    const order = await service.repository.list(), last = projects.find(project => project.id === order.at(-1)!.id)!; await fs.writeFile(path.join(root, last.blobs[0].path), 'Changed original');
    await assert.rejects(() => service.configureDataFolder('New data root'), /недоступен|изменён/);
    assert.equal(service.getDataFolder(), 'TWData'); assert.deepEqual(await fs.readFile(settingsPath), settings);
    for (const [index, project] of projects.entries()) assert.deepEqual(await fs.readFile(path.join(root, service.repository.statePath(project.id))), states[index]);
  });
});

test('a note deleted between service validation and native opening returns the repair flow', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Open race'); const nodeId = await service.createNote('Note'), relative = current(service).nodes[0].notePath;
    host.openNote = async target => { await fs.unlink(path.join(root, target)); throw new Error('The note file was not found: ' + target); };
    assert.equal(await service.openNote(nodeId), 'missing'); assert.equal(current(service).nodes[0].missing, true); assert.deepEqual(await fs.readdir(path.dirname(path.join(root, relative))), []);
  });
});

test('diagnostics treats oversized and invalid UTF-8 notes as unavailable without rewriting either file', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Unreadable notes'); await service.createNote('Oversized'); await service.createNote('Invalid UTF8');
    const project = current(service), oversized = Buffer.alloc(5_242_881, 97), invalid = Buffer.from([0xff, 0xfe, 0xfa]);
    await fs.writeFile(path.join(root, project.nodes[0].notePath), oversized); await fs.writeFile(path.join(root, project.nodes[1].notePath), invalid);
    const diagnostics = await service.diagnoseProject(); assert.deepEqual(diagnostics.notes.map(note => note.status), ['invalid', 'invalid']); assert.deepEqual(new Set(diagnostics.affectedNodeIds), new Set(project.nodes.map(node => node.id)));
    assert.ok(current(service).nodes.every(node => node.missing)); assert.deepEqual(await fs.readFile(path.join(root, project.nodes[0].notePath)), oversized); assert.deepEqual(await fs.readFile(path.join(root, project.nodes[1].notePath)), invalid);
  });
});

test('archived projects permit diagnosis and opening but reject explicit note replacement', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Archived bindings'); const nodeId = await service.createNote('Original'); await fs.writeFile(path.join(root, 'Replacement.md'), 'Replacement body');
    await service.execute([{ kind: 'project.update', changes: { status: 'archived' } }]); const before = structuredClone(current(service));
    assert.equal(await service.openNote(nodeId), 'opened'); await assert.rejects(() => service.relinkNote(nodeId, 'Replacement.md'), /архивирован/); assert.equal((await service.diagnoseProject()).notes[0].status, 'ok'); assert.deepEqual(current(service), before);
    await fs.unlink(path.join(root, before.nodes[0].notePath)); await assert.rejects(() => service.recreateNote(nodeId), /архивирован/); assert.equal(await fs.readFile(path.join(root, 'Replacement.md'), 'utf8'), 'Replacement body');
  });
});

test('diagnostics remains available without metadata writes when a journal needs recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-blocked-diagnostics-')); let fail = false;
  const repository = new ProjectRepository(root, { fault: point => { if (fail && point === 'after-journal') { fail = false; throw new Error('Synthetic pending journal'); } } }), host = new FilesystemHost(root), service = new LocalWorkbench(repository, host);
  try {
    await service.initialize(); await service.createProject('Pending recovery'); const nodeId = await service.createNote('Note'), project = current(service);
    fail = true; await assert.rejects(() => service.execute([{ kind: 'node.update', nodeId, changes: { title: 'Pending title' } }]), /Synthetic pending journal/); assert.equal(repository.needsRecovery, true);
    await fs.unlink(path.join(root, project.nodes[0].notePath)); const statePath = path.join(root, repository.statePath(project.id)), before = await fs.readFile(statePath), tree = await fileTree(root);
    const diagnostics = await service.diagnoseProject(); assert.equal(diagnostics.notes[0].status, 'missing'); assert.deepEqual(diagnostics.affectedNodeIds, [nodeId]); assert.deepEqual(await fs.readFile(statePath), before); assert.deepEqual(await fileTree(root), tree);
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a data-root change resumes after interrupted metadata journal publication on restart', async () => {
  for (const failurePoint of ['after-journal', 'after-state'] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-data-root-recovery-')); let fail = false;
    const repository = new ProjectRepository(root, { fault: point => { if (fail && point === failurePoint) { fail = false; throw new Error('Synthetic root change interruption'); } } }), host = new FilesystemHost(root);
    let service = new LocalWorkbench(repository, host);
    try {
      await service.initialize(); await service.createProject('Recoverable root'); const nodeId = await service.createNote('Unmoved note'), source = path.join(root, 'source.bin'), bytes = Buffer.from([0, 255, 42]);
      await fs.writeFile(source, bytes); host.sources.set('source.bin', source); await service.importFiles([new File([], 'source.bin')], nodeId); const before = structuredClone(current(service));
      fail = true; await assert.rejects(() => service.configureDataFolder('Recovered/Data'), /Synthetic root change interruption/); assert.equal(repository.needsRecovery, true);
      await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.initialize();
      assert.equal(service.repository.needsRecovery, false); assert.equal(service.getDataFolder(), 'Recovered/Data'); const after = current(service);
      assert.equal(after.nodes[0].id, nodeId); assert.equal(after.nodes[0].notePath, before.nodes[0].notePath); assert.equal(after.blobs[0].id, before.blobs[0].id); assert.ok(after.blobs[0].path.startsWith('Recovered/Data/projects/Recoverable root/'));
      assert.deepEqual(await fs.readFile(path.join(root, after.blobs[0].path)), bytes); assert.deepEqual(await fs.readFile(path.join(root, before.blobs[0].path)), bytes);
      assert.equal((await service.diagnoseProject()).assets[0].status, 'ok'); await assert.rejects(() => fs.access(path.join(root, '.twdata/layout-change.json')), { code: 'ENOENT' });
      assert.equal(JSON.parse(await fs.readFile(path.join(root, '.twdata/settings.json'), 'utf8')).dataRoot, 'Recovered/Data');
    } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('diagnostics marks nodes referenced by missing evidence even without direct attachments', async () => {
  await withService(async (service, host, root) => {
    await service.createProject('Evidence dependencies'); const first = await service.createNote('First'), second = await service.createNote('Second'), third = await service.createNote('Third');
    const source = path.join(root, 'source.bin'); await fs.writeFile(source, Buffer.from([2, 4, 6])); host.sources.set('source.bin', source); await service.importFiles([new File([], 'source.bin')]);
    const asset = current(service).assets[0], evidence = () => ({ id: randomUUID(), sourceKind: 'asset' as const, assetId: asset.id, sourceNodeId: null, url: null, label: 'Evidence original', quote: null, locator: null, note: null, accessedAt: null });
    await service.execute([{ kind: 'relation.create', relation: { ...relation(first, second), evidence: [evidence()] } }, { kind: 'node.update', nodeId: third, changes: { evidence: [evidence()] } }]);
    const before = structuredClone(current(service)); assert.equal(before.attachments.length, 0); await fs.unlink(path.join(root, before.blobs[0].path));
    const result = await service.diagnoseProject(); assert.equal(result.assets[0].status, 'missing'); assert.deepEqual(new Set(result.affectedNodeIds), new Set([first, second, third])); assert.deepEqual(current(service).relations, before.relations); assert.deepEqual(current(service).nodes.map(node => node.evidence), before.nodes.map(node => node.evidence));
  });
});

test('a host without native note creation rejects the request before creating any plugin-owned note', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Required native host'); (service.host as Host).createNote = undefined;
    const before = await fileTree(root); await assert.rejects(() => service.createNote('Must not be created'), /штатное создание заметок/); assert.deepEqual(await fileTree(root), before); assert.equal(current(service).nodes.length, 0);
  });
});

async function seedResearchWithOriginal(service: LocalWorkbench, host: FilesystemHost, root: string, title: string, bytes: readonly number[]): Promise<Project> {
  await service.createProject(title); const nodeId = await service.createNote(title + ' note'), name = title + '.bin', source = path.join(root, name);
  await fs.writeFile(source, Buffer.from(bytes)); host.sources.set(name, source); await service.importFiles([new File([], name)], nodeId);
  return structuredClone(current(service));
}

test('a failed settings commit after project barriers finishes the planned root after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-root-settings-fault-')), repository = new ProjectRepository(root), host = new FilesystemHost(root);
  let service = new LocalWorkbench(repository, host);
  try {
    await service.initialize(); const before = await seedResearchWithOriginal(service, host, root, 'Settings fault', [1, 5, 9]), settingsPath = path.join(root, '.twdata/settings.json'), settingsBefore = await fs.readFile(settingsPath);
    const atomic = repository.atomicText.bind(repository); let rejectSettings = true;
    repository.atomicText = async (relative, value) => { if (rejectSettings && relative === '.twdata/settings.json') { rejectSettings = false; throw new Error('Synthetic final settings commit failure'); } await atomic(relative, value); };
    await assert.rejects(() => service.configureDataFolder('NewData'), /Synthetic final settings commit failure/);
    const staged = await repository.read(before.id); assert.ok(staged.blobs[0].path.startsWith('NewData/projects/')); assert.equal(repository.needsRecovery, false); assert.equal(service.getDataFolder(), 'TWData'); assert.deepEqual(await fs.readFile(settingsPath), settingsBefore); await fs.access(path.join(root, '.twdata/layout-change.json'));
    await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.initialize();
    assert.equal(service.getDataFolder(), 'NewData'); const restored = current(service); assert.equal(restored.nodes[0].id, before.nodes[0].id); assert.equal(restored.nodes[0].notePath, before.nodes[0].notePath); assert.equal(restored.blobs[0].path, staged.blobs[0].path);
    assert.deepEqual(await fs.readFile(path.join(root, restored.blobs[0].path)), Buffer.from([1, 5, 9])); assert.deepEqual(await fs.readFile(path.join(root, before.blobs[0].path)), Buffer.from([1, 5, 9])); await assert.rejects(() => fs.access(path.join(root, '.twdata/layout-change.json')), { code: 'ENOENT' });
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a fault in the second project journal resumes every project under one data root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-root-second-project-fault-')); let armed = false, journalCount = 0;
  const repository = new ProjectRepository(root, { fault: point => { if (armed && point === 'after-journal' && ++journalCount === 2) { armed = false; throw new Error('Synthetic second project journal failure'); } } }), host = new FilesystemHost(root);
  let service = new LocalWorkbench(repository, host);
  try {
    await service.initialize(); const before = [await seedResearchWithOriginal(service, host, root, 'First journal', [1, 2, 3]), await seedResearchWithOriginal(service, host, root, 'Second journal', [4, 5, 6])];
    armed = true; await assert.rejects(() => service.configureDataFolder('NewData'), /Synthetic second project journal failure/); assert.equal(journalCount, 2); assert.equal(repository.needsRecovery, true);
    const mixed = await Promise.all(before.map(project => repository.read(project.id))); assert.equal(mixed.filter(project => project.blobs[0].path.startsWith('NewData/')).length, 1); assert.equal(service.getDataFolder(), 'TWData');
    await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.initialize();
    assert.equal(service.repository.needsRecovery, false); assert.equal(service.getDataFolder(), 'NewData');
    for (const [index, project] of before.entries()) {
      const restored = await service.repository.read(project.id); assert.ok(restored.blobs[0].path.startsWith('NewData/projects/')); assert.equal(restored.nodes[0].id, project.nodes[0].id); assert.equal(restored.nodes[0].notePath, project.nodes[0].notePath);
      const expected = Buffer.from(index === 0 ? [1, 2, 3] : [4, 5, 6]); assert.deepEqual(await fs.readFile(path.join(root, restored.blobs[0].path)), expected); assert.deepEqual(await fs.readFile(path.join(root, project.blobs[0].path)), expected);
    }
    await assert.rejects(() => fs.access(path.join(root, '.twdata/layout-change.json')), { code: 'ENOENT' });
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('an external metadata edit while a folder marker is pending is retained and permits read-only diagnosis', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-root-external-conflict-')), repository = new ProjectRepository(root), host = new FilesystemHost(root);
  let service = new LocalWorkbench(repository, host);
  try {
    await service.initialize(); const before = await seedResearchWithOriginal(service, host, root, 'External conflict', [10, 20, 30]);
    const atomic = repository.atomicText.bind(repository); let failAfterMarker = true;
    repository.atomicText = async (relative, value) => { await atomic(relative, value); if (failAfterMarker && relative === '.twdata/layout-change.json') { failAfterMarker = false; throw new Error('Synthetic interruption after folder marker'); } };
    await assert.rejects(() => service.configureDataFolder('NewData'), /Synthetic interruption after folder marker/);
    const external = { ...before, descriptionMarkdown: 'External metadata must survive reconciliation' }, statePath = path.join(root, repository.statePath(before.id)), externalBytes = Buffer.from(stableJSON(external)); await fs.writeFile(statePath, externalBytes);
    await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.initialize();
    assert.equal(service.getDataFolder(), 'TWData'); assert.match(service.getSnapshot().error ?? '', /вне журнала переназначения/u); assert.deepEqual(await fs.readFile(statePath), externalBytes); assert.equal(current(service).descriptionMarkdown, external.descriptionMarkdown);
    const tree = await fileTree(root), diagnostics = await service.diagnoseProject(); assert.equal(diagnostics.notes[0].status, 'ok'); assert.equal(diagnostics.assets[0].status, 'ok'); assert.deepEqual(await fs.readFile(statePath), externalBytes); assert.deepEqual(await fileTree(root), tree);
    await assert.rejects(() => service.execute([{ kind: 'project.update', changes: { title: 'Forbidden overwrite' } }]), /не завершено|восстановление/); assert.deepEqual(await fs.readFile(statePath), externalBytes); await fs.access(path.join(root, '.twdata/layout-change.json')); assert.deepEqual(await fs.readFile(path.join(root, before.blobs[0].path)), Buffer.from([10, 20, 30]));
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a changed destination copy prevents root recovery from blessing new settings or deleting source data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-root-target-conflict-')), repository = new ProjectRepository(root), host = new FilesystemHost(root);
  let service = new LocalWorkbench(repository, host);
  try {
    await service.initialize(); const before = await seedResearchWithOriginal(service, host, root, 'Target conflict', [10, 20, 30]), settingsPath = path.join(root, '.twdata/settings.json'), settingsBefore = await fs.readFile(settingsPath);
    const atomic = repository.atomicText.bind(repository); let rejectSettings = true;
    repository.atomicText = async (relative, value) => { if (rejectSettings && relative === '.twdata/settings.json') { rejectSettings = false; throw new Error('Synthetic settings commit failure'); } await atomic(relative, value); };
    await assert.rejects(() => service.configureDataFolder('NewData'), /Synthetic settings commit failure/); const staged = await repository.read(before.id), tampered = Buffer.from([30, 20, 10]); await fs.writeFile(path.join(root, staged.blobs[0].path), tampered);
    await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.initialize();
    assert.equal(service.getDataFolder(), 'TWData'); assert.match(service.getSnapshot().error ?? '', /Копия материала недоступна или изменена/u); assert.deepEqual(await fs.readFile(settingsPath), settingsBefore); const statePath = path.join(root, service.repository.statePath(before.id)), stateBefore = await fs.readFile(statePath);
    const diagnostics = await service.diagnoseProject(); assert.equal(diagnostics.assets[0].status, 'changed'); assert.deepEqual(diagnostics.affectedNodeIds, [before.nodes[0].id]); assert.deepEqual(await fs.readFile(statePath), stateBefore); assert.deepEqual(await fs.readFile(settingsPath), settingsBefore);
    assert.deepEqual(await fs.readFile(path.join(root, staged.blobs[0].path)), tampered); assert.deepEqual(await fs.readFile(path.join(root, before.blobs[0].path)), Buffer.from([10, 20, 30])); await fs.access(path.join(root, '.twdata/layout-change.json'));
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a conflicting project journal cannot hide a pending folder change or allow unrelated metadata writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-root-journal-conflict-'));
  let armed = false;
  const repository = new ProjectRepository(root, { fault: point => { if (armed && point === 'after-journal') { armed = false; throw new Error('Synthetic folder journal interruption'); } } });
  const host = new FilesystemHost(root); let service = new LocalWorkbench(repository, host);
  try {
    await service.initialize(); const original = await seedResearchWithOriginal(service, host, root, 'Conflict', [8, 7, 6]);
    armed = true; await assert.rejects(() => service.configureDataFolder('NewData'), /Synthetic folder journal interruption/);
    const external = { ...original, descriptionMarkdown: 'Keep this external metadata' }, statePath = path.join(root, repository.statePath(original.id));
    await fs.writeFile(statePath, stableJSON(external));
    await service.dispose(); service = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.initialize();
    assert.equal(service.repository.needsRecovery, true); const stateBefore = await fs.readFile(statePath);
    await assert.rejects(() => service.createProject('Must not be added during folder recovery'), /не завершено|восстановление/);
    await service.openProject(original.id); const diagnostics = await service.diagnoseProject();
    assert.equal(diagnostics.notes[0].status, 'ok'); assert.equal(diagnostics.assets[0].status, 'ok');
    assert.deepEqual(await fs.readFile(statePath), stateBefore); assert.equal((await service.repository.list()).length, 1);
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

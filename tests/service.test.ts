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
  readonly opened: string[] = []; readonly shown: string[] = []; readonly sources = new Map<string, string>();
  constructor(readonly root: string) {}
  listNotes(): { path: string; title: string }[] {
    const notes: { path: string; title: string }[] = [];
    const walk = (prefix: string): void => { for (const entry of readdirSync(path.join(this.root, prefix), { withFileTypes: true })) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) walk(relative); else if (entry.isFile() && /\.md$/iu.test(entry.name)) notes.push({ path: relative, title: entry.name.slice(0, -3) }); } };
    walk(''); return notes;
  }
  async openNote(relative: string) { this.opened.push(relative); }
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
    assert.equal(await fs.readFile(path.join(root, node.notePath), 'utf8'), ''); assert.ok(node.notePath.startsWith('Исследования/Заметки/'));
    const groupId = await service.createGroup('Группа', [id]); const group = current(service).nodes.find(n => n.id === groupId)!;
    assert.equal(await fs.readFile(path.join(root, group.notePath), 'utf8'), ''); assert.equal(current(service).memberships[0].memberNodeId, id);
    assert.ok(notifications > 0); unsubscribe(); const count = notifications; await service.saveView({ mode: 'graph', selectedId: id, collapsedGroupIds: [groupId], expandedNodeIds: [] }); assert.equal(notifications, count);
    assert.equal((await service.loadView() as Partial<ViewState>).selectedId, id);
    const files = await fileTree(root); assert.deepEqual(files.filter(item => item.startsWith('Исследования/Заметки/')), [node.notePath, group.notePath].sort()); assert.ok(files.every(item => (item.startsWith('.twdata/') || item.startsWith('Исследования/'))));
    assert.ok(service.listNotes().every(item => item.path.startsWith('Исследования/Заметки/'))); assert.equal(host.opened.length, 0);
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
    await service.createProject('Picker');await service.configurePaths({notesRoot:'Исследования/Заметки',resourcesRoot:'Исследования/Вложения/ẞources'});host.listNotes=()=>[{path:'Ordinary/Note.md',title:'Note'},{path:'Исследования/Заметки/Note.md',title:'Managed'},{path:'ИССЛЕДОВАНИЯ/ВЛОЖЕНИЯ/ssOURCES/original.md',title:'Original'},{path:'Исследования/Вложения/ẞources/nested/original.md',title:'Nested'}];assert.deepEqual(service.listNotes().map(note=>note.title),['Note','Managed']);
  });
});

test('adopt and relink reject registered Markdown originals across projects after a resource folder rename',async()=>{
  await withService(async(service,host,root)=>{
    await service.createProject('Original owner');const source=path.join(root,'source.md'),body='\uFEFF---\noriginal: true\n---\n\nImmutable Markdown original.\n';await fs.writeFile(source,body);host.sources.set('source.md',source);await service.importFiles([new File([],'source.md')]);await fs.unlink(source);const owner=current(service),original=structuredClone(owner.blobs[0]);
    await fs.rename(path.join(root,'Исследования/Вложения'),path.join(root,'Moved originals'));await service.onRenamed('Moved originals','Исследования/Вложения');const movedOwner=current(service),moved=structuredClone(movedOwner.blobs[0]);assert.equal(moved.id,original.id);assert.ok(moved.path.startsWith('Moved originals/'));
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
    await service.createProject('Folder move');const nodeId=await service.createNote('Note'),source=path.join(root,'source.bin'),bytes=Buffer.from([0,255,128,44]);await fs.writeFile(source,bytes);host.sources.set('source.bin',source);await service.importFiles([new File([],'source.bin')],nodeId);await fs.unlink(source);
    await service.execute([{kind:'project.update',changes:{status:'archived'}}]);const before=current(service);await fs.rename(path.join(root,'Исследования'),path.join(root,'Перенесённые исследования'));await service.onRenamed('Перенесённые исследования','Исследования');const after=current(service);
    assert.equal(after.revision,before.revision+1);assert.equal(after.status,'archived');assert.equal(after.nodes[0].id,before.nodes[0].id);assert.equal(after.blobs[0].id,before.blobs[0].id);assert.ok(after.nodes[0].notePath.startsWith('Перенесённые исследования/'));assert.ok(after.blobs[0].path.startsWith('Перенесённые исследования/'));assert.deepEqual(await fs.readFile(path.join(root,after.blobs[0].path)),bytes);assert.deepEqual(after.assets,before.assets);assert.deepEqual(after.attachments,before.attachments);assert.equal((await service.verifyAssets())[0].status,'ok');
    await fs.rename(path.join(root,'Перенесённые исследования'),path.join(root,'Испорченные'));await fs.writeFile(path.join(root,after.blobs[0].path.replace('Перенесённые исследования/','Испорченные/')),'Tampered');await assert.rejects(()=>service.onRenamed('Испорченные','Перенесённые исследования'),/изменён/);assert.equal(current(service).revision,after.revision);assert.equal((await service.repository.read(after.id)).blobs[0].path,after.blobs[0].path);
  });
});

test('missing notes retain graph identity, explicit relink preserves relationships and refuses occupied targets', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Исследование'); const a = await service.createNote('А'), b = await service.createNote('Б'); const link = relation(a, b); await service.execute([{ kind: 'relation.create', relation: link }]);
    const p = current(service), oldPath = p.nodes[0].notePath; await fs.unlink(path.join(root, oldPath)); await service.onFileChanged(oldPath);
    assert.equal(current(service).nodes[0].missing, true); assert.equal(current(service).relations[0].id, link.id);
    await assert.rejects(() => service.openNote(a), /не найден/); await assert.rejects(() => service.relinkNote(a, p.nodes[1].notePath), /уже принадлежит/);
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
    await service.createProject('Обнаружение'); const p = current(service), folder = `Исследования/Вложения/${p.id}`;
    await fs.mkdir(path.join(root, folder), { recursive: true }); await fs.writeFile(path.join(root, folder, 'direct.bin'), Buffer.from([0, 1, 255]));
    const found = await service.discoverResources(); assert.deepEqual(found, [{ path: `${folder}/direct.bin`, byteSize: 3, registered: false }]); assert.equal(current(service).assets.length, 0);
    await service.registerResource(found[0].path); assert.equal(current(service).assets.length, 1); assert.equal(current(service).attachments.length, 0); assert.equal(current(service).nodes.length, 0);
    const registered = await service.discoverResources(); assert.ok(registered.some(item => item.registered)); assert.ok(registered.some(item => item.path === found[0].path)); assert.deepEqual(await fs.readFile(path.join(root, found[0].path)), Buffer.from([0, 1, 255]));
    await assert.rejects(() => service.registerResource('Elsewhere/secret.bin'), /вне.*папки/);
  });
});

test('resource discovery includes files directly in the chosen root and registration copies them safely', async () => {
  await withService(async (service, _host, root) => {
    await service.createProject('Прямое добавление'); const p = current(service), original = Buffer.from([0, 255, 17]);
    await fs.mkdir(path.join(root, 'Исследования/Вложения'), { recursive: true }); await fs.writeFile(path.join(root, 'Исследования/Вложения/direct.bin'), original);
    const initial = await service.discoverResources(); assert.ok(initial.some(item => item.path === 'Исследования/Вложения/direct.bin' && !item.registered));
    await service.registerResource('Исследования/Вложения/direct.bin'); assert.equal(current(service).assets.length, 1); assert.ok(current(service).blobs[0].path.startsWith(`Исследования/Вложения/${p.id}/`)); assert.deepEqual(await fs.readFile(path.join(root, current(service).blobs[0].path)), original); assert.deepEqual(await fs.readFile(path.join(root, 'Исследования/Вложения/direct.bin')), original);
    await service.configurePaths({ notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/evidence' }); const other = Buffer.from([128, 0, 44]);
    await fs.mkdir(path.join(root, 'Исследования/Вложения/evidence')); await fs.writeFile(path.join(root, 'Исследования/Вложения/evidence/without-extension'), other);
    const custom = await service.discoverResources(); assert.deepEqual(custom, [{ path: 'Исследования/Вложения/evidence/without-extension', byteSize: other.length, registered: false }]);
    await service.registerResource('Исследования/Вложения/evidence/without-extension'); assert.equal(current(service).assets.length, 2); assert.ok(current(service).blobs.some(blob => blob.path.startsWith(`Исследования/Вложения/evidence/${p.id}/`))); assert.deepEqual(await fs.readFile(path.join(root, 'Исследования/Вложения/evidence/without-extension')), other);
    const before = await fileTree(root); await assert.rejects(() => service.registerResource('Исследования/Вложения/evidence-other/outside.bin'), /вне.*папки/); await assert.rejects(() => service.registerResource('Outside/direct.bin'), /вне.*папки/); assert.deepEqual(await fileTree(root), before);
  });
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
    assert.ok(snapshot.path.startsWith('.twdata/')); await service.openReport(snapshot.id);
  });
});

test('configured note/resource roots persist centrally and cannot enter technical folders', async () => {
  await withService(async (service, _host, root) => {
    await service.configurePaths({ notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/custom' });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.twdata/settings.json'), 'utf8')), { notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/custom' });
    await service.createProject('Папки'); const nodeId = await service.createNote('Заметка'), node = current(service).nodes.find(item => item.id === nodeId)!; assert.ok(node.notePath.startsWith('Исследования/Заметки/custom/'));
    for (const value of [{ notesRoot: '_TRACEWEAVE/notes', resourcesRoot: 'Resources' }, { notesRoot: 'Notes', resourcesRoot: 'Resources/.obsidian' }, { notesRoot: 'Notes', resourcesRoot: 'Notes/files' }, { notesRoot: '../Notes', resourcesRoot: 'Resources' }]) await assert.rejects(() => service.configurePaths(value));
    assert.deepEqual(service.paths, { notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/custom' });
    const second = new LocalWorkbench(new ProjectRepository(root), new FilesystemHost(root)); await service.dispose(); try { await second.initialize(); assert.deepEqual(second.paths, service.paths); assert.equal(current(second).nodes[0].id, nodeId); } finally { await second.dispose(); }
  });
});

test('hidden and malformed configured roots are rejected before durable settings change', async () => {
  await withService(async (service, _host, root) => {
    await service.configurePaths({ notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/custom' });
    const original = await fs.readFile(path.join(root, '.twdata/settings.json'));
    for (const value of [
      { notesRoot: 'Исследования/Заметки/.private', resourcesRoot: 'Исследования/Вложения/custom' },
      { notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/.private' },
      { notesRoot: 'Исследования/Заметки/_TraceWeave', resourcesRoot: 'Исследования/Вложения/custom' },
      { notesRoot: 'Исследования/Заметки/custom', resourcesRoot: 'Исследования/Вложения/custom', unexpected: true },
    ]) await assert.rejects(() => service.configurePaths(value));
    assert.deepEqual(await fs.readFile(path.join(root, '.twdata/settings.json')), original);
    await service.createProject('Settings remain usable'); await service.createNote('Visible note');
    assert.ok(current(service).nodes[0].notePath.startsWith('Исследования/Заметки/custom/'));
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
    assert.ok((await fileTree(root)).every(filename => (filename.startsWith('.twdata/') || filename.startsWith('Исследования/'))));
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
      await assert.rejects(() => second!.registerResource(`Исследования/Вложения/${p.id}/nonexistent.bin`), /недоступна/); assert.deepEqual(await fileTree(root), before);
      await assert.rejects(() => second!.importArchive(new File([], 'not-even-opened.zip')), /недоступна/); assert.deepEqual(await fileTree(root), before);
      assert.equal((await service.repository.read(p.id)).revision, 0);
    } finally { await second?.dispose(); await fs.rm(sourceRoot, { recursive: true, force: true }); }
  });
});

test('readable report exports all active research into the configured vault folder without changing source state', async () => {
  await withService(async (service, host, root) => {
    let reportsFolder = '';
    host.reportsFolder = () => reportsFolder;
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
    assert.equal(report.directory, 'Отчёт для телефона');
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
    reportsFolder = 'Reports/For phone';
    const nested = await service.exportReadableReport();
    assert.equal(nested.directory, 'Reports/For phone/Отчёт для телефона');
    const repeated = await service.exportReadableReport();
    assert.equal(repeated.directory, 'Reports/For phone/Отчёт для телефона (2)');
    assert.equal(await fs.readFile(path.join(root, report.summaryPath), 'utf8'), text);
    assert.deepEqual(current(service), before);
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
    await assert.rejects(() => service.exportReadableReport(), /Отчёт создан: Opening failure\/summary\.md.*Synthetic editor failure/u);
    assert.ok((await fs.readFile(path.join(root, 'Opening failure/summary.md'), 'utf8')).includes('Note'));
    const before = await fileTree(root);
    host.reportsFolder = () => '../outside';
    await assert.rejects(() => service.exportReadableReport());
    assert.deepEqual(await fileTree(root), before);
  });
});

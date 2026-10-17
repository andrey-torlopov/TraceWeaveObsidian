import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalWorkbench, type Host } from '../src/service';
import { ProjectRepository, digest, METADATA_ROOT } from '../src/storage/repository';
import { NOTES_ROOT, RESOURCES_ROOT } from '../src/storage/layout';
import type { Project, Relation } from '../src/types';

class VaultNotesHost implements Host {
  readonly opened: string[] = [];
  constructor(readonly root: string) {}
  listNotes(): { path: string; title: string }[] {
    const notes: { path: string; title: string }[] = [];
    const walk = (relative: string) => {
      for (const entry of readdirSync(path.join(this.root, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && entry.name !== '.obsidian') walk(name);
        else if (entry.isFile() && /\.md$/iu.test(entry.name)) notes.push({ path: name, title: entry.name.slice(0, -3) });
      }
    };
    walk(''); return notes;
  }
  async openNote(relative: string) { this.opened.push(relative); }
  resourceUrl(relative: string) { return `app://vault/${encodeURIComponent(relative)}`; }
  async showFile(_relative: string) { throw new Error('This test does not open material files'); }
  async filePath(_file: File): Promise<string> { throw new Error('Ordinary vault notes do not use file upload'); }
}

const current = (service: LocalWorkbench): Project => {
  const project = service.getSnapshot().project; assert.ok(project); return project;
};
async function tree(root: string, relative = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...await tree(root, name)); else names.push(name);
  }
  return names.sort();
}
async function withVault(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-vault-notes-'));
  const host = new VaultNotesHost(root), service = new LocalWorkbench(new ProjectRepository(root), host);
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await service.initialize(); await service.createProject('Обычные заметки');
  return { root, host, service };
}
const relation = (sourceNodeId: string, targetNodeId: string): Relation => ({
  id: randomUUID(), sourceNodeId, targetNodeId, relationType: 'related', label: null,
  directed: false, bidirectional: false, assessment: 'unreviewed', confidence: null,
  noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null,
  createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z', origin: { kind: 'manual' },
});

// These are filesystem/service integration checks. They verify pointer semantics and byte
// preservation, not Obsidian's native link renderer or its automatic link-update setting.
test('ordinary root and nested vault notes adopt in place with all Properties, wikilinks and relative attachments unchanged', async t => {
  const { root, host, service } = await withVault(t);
  await fs.mkdir(path.join(root, 'Исследования/2026/Заметки'), { recursive: true });
  await fs.mkdir(path.join(root, 'Исследования/2026/Материалы'), { recursive: true });
  const binary = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 17]);
  await fs.writeFile(path.join(root, 'Исследования/2026/Материалы/Схема.png'), binary);
  const body = '---\r\naliases: ["Чужое имя"]\r\ncustom: "сохранить"\r\n---\r\n# e\u0301\r\n\r\n[[Главная#Раздел|корневая заметка]]\r\n![[Исследования/2026/Материалы/Схема.png]]\r\n![Схема](../Материалы/Схема.png)\r\n[Файл](../Материалы/Схема.png)\r\n\r\n```md\r\n[[Это пример]]\r\n```\r\n';
  const notePath = 'Исследования/2026/Заметки/Карточка.md';
  await fs.writeFile(path.join(root, notePath), body); await fs.writeFile(path.join(root, 'Главная.md'), '# Раздел\nИсходная заметка');
  const before = await tree(root);
  assert.ok(service.listNotes().some(note => note.path === notePath)); assert.ok(service.listNotes().some(note => note.path === 'Главная.md'));
  await service.adoptNote(notePath); await service.adoptNote('Главная.md');
  const p = current(service), node = p.nodes.find(note => note.notePath === notePath)!;
  assert.equal(await service.readNote(node.id), body); assert.equal(node.noteHash, digest(body));
  assert.deepEqual(await fs.readFile(path.join(root, notePath)), Buffer.from(body));
  assert.deepEqual(await fs.readFile(path.join(root, 'Исследования/2026/Материалы/Схема.png')), binary);
  assert.deepEqual((await tree(root)).filter(name => !name.startsWith(`${METADATA_ROOT}/`)), before.filter(name => !name.startsWith(`${METADATA_ROOT}/`)));
  assert.equal(p.assets.length, 0, 'A textual embed must not implicitly become a copied registered Asset');
  await service.openNote(node.id); assert.deepEqual(host.opened, [notePath]);
  assert.ok(!node.notePath.startsWith('TWData/'), 'Existing notes remain outside the plugin-created data folder');
});

test('native/external edits update the same registered note and search while leaving links and graph relations intact', async t => {
  const { root, service } = await withVault(t);
  await fs.mkdir(path.join(root, 'Личный архив'), { recursive: true });
  const notePath = 'Личный архив/Исходник.md', secondPath = 'Вторая.md';
  await fs.writeFile(path.join(root, notePath), '# Первая\n[[Вторая]]\n'); await fs.writeFile(path.join(root, secondPath), '# Вторая');
  await service.adoptNote(notePath); await service.adoptNote(secondPath);
  const [first, second] = current(service).nodes, link = relation(first.id, second.id); await service.execute([{ kind: 'relation.create', relation: link }]);
  const edited = '---\nowner: пользователь\n---\nНовая фраза %_ для поиска\n[[Вторая]]\n![Схема](../media/map.png)\n';
  await fs.writeFile(path.join(root, notePath), edited); await service.onFileChanged(notePath);
  assert.equal(current(service).nodes.find(node => node.id === first.id)!.notePath, notePath);
  assert.equal(await service.readNote(first.id), edited); assert.equal(current(service).nodes.find(node => node.id === first.id)!.noteHash, digest(edited));
  assert.deepEqual(current(service).relations, [link]); assert.equal((await service.search('Новая фраза %_'))[0]!.nodeId, first.id);
  assert.deepEqual(await fs.readFile(path.join(root, notePath)), Buffer.from(edited));
  assert.deepEqual((await tree(root)).filter(name => !name.startsWith(`${METADATA_ROOT}/`)), [notePath, secondPath].sort());
});

test('renaming an ordinary vault folder preserves identity, relations, relative image pointers and original bytes', async t => {
  const { root, service } = await withVault(t);
  await fs.mkdir(path.join(root, 'Research/Notes'), { recursive: true }); await fs.mkdir(path.join(root, 'Research/Assets'), { recursive: true });
  const body = '---\ntags: [обычная]\n---\n![Local](../Assets/picture.png)\n[[Research/Notes/Second]]\n', bytes = Buffer.from([0, 128, 255, 42]);
  await fs.writeFile(path.join(root, 'Research/Notes/First.md'), body); await fs.writeFile(path.join(root, 'Research/Notes/Second.md'), '# Second'); await fs.writeFile(path.join(root, 'Research/Assets/picture.png'), bytes);
  await service.adoptNote('Research/Notes/First.md'); await service.adoptNote('Research/Notes/Second.md');
  const [first, second] = current(service).nodes, link = relation(first.id, second.id); await service.execute([{ kind: 'relation.create', relation: link }]);
  await fs.rename(path.join(root, 'Research'), path.join(root, 'Archive')); await service.onRenamed('Archive', 'Research');
  const renamed = current(service).nodes.find(node => node.id === first.id)!;
  assert.equal(renamed.notePath, 'Archive/Notes/First.md'); assert.equal(renamed.missing, false); assert.deepEqual(current(service).relations, [link]);
  assert.equal(await service.readNote(first.id), body); assert.deepEqual(await fs.readFile(path.join(root, 'Archive/Assets/picture.png')), bytes);
  const relativeImage = path.resolve(path.dirname(path.join(root, renamed.notePath)), '../Assets/picture.png'); assert.equal(relativeImage, path.join(root, 'Archive/Assets/picture.png'));
  assert.deepEqual(await fs.readFile(relativeImage), bytes);
  // Absolute wikilinks can be updated by Obsidian; the service itself never rewrites note text.
  assert.ok((await service.readNote(first.id)).includes('[[Research/Notes/Second]]'));
});

test('missing ordinary note can explicitly relink without changing identity or replacing the chosen note', async t => {
  const { root, service } = await withVault(t);
  const beforePath = 'Исходная.md', afterPath = 'Перенесено/Новое имя.md', original = '[[Другая]]\nИсходный текст';
  await fs.writeFile(path.join(root, beforePath), original); await service.adoptNote(beforePath); const id = current(service).nodes[0]!.id;
  await fs.mkdir(path.join(root, 'Перенесено')); await fs.rename(path.join(root, beforePath), path.join(root, afterPath));
  const currentBody = '---\nпользователь: true\n---\nИзменено вне запущенного Obsidian\n![image](../media/x.png)'; await fs.writeFile(path.join(root, afterPath), currentBody);
  await service.onFileChanged(beforePath); assert.equal(current(service).nodes[0]!.missing, true);
  await service.relinkNote(id, afterPath); assert.equal(current(service).nodes[0]!.id, id); assert.equal(current(service).nodes[0]!.missing, false); assert.equal(current(service).nodes[0]!.notePath, afterPath);
  assert.equal(await service.readNote(id), currentBody); assert.deepEqual(await fs.readFile(path.join(root, afterPath)), Buffer.from(currentBody));
});

test('outside-filesystem note paths and symlink targets cannot be adopted as vault notes', async t => {
  const { root, service } = await withVault(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-outside-note-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true })); const secret = path.join(outside, 'outside.md'); await fs.writeFile(secret, 'Outside this vault');
  await assert.rejects(service.adoptNote(secret)); await assert.rejects(service.adoptNote('../outside.md'));
  await fs.symlink(secret, path.join(root, 'linked.md')); await assert.rejects(service.adoptNote('linked.md'));
  assert.equal(current(service).nodes.length, 0); assert.equal(await fs.readFile(secret, 'utf8'), 'Outside this vault');
});

test('picker includes ordinary folders and managed notes while excluding metadata, reports and resource Markdown', async t => {
  const { root, service } = await withVault(t), id = await service.createNote('Новая обычная заметка'), managed = current(service).nodes.find(node => node.id === id)!;
  assert.ok(managed.notePath.startsWith(NOTES_ROOT + '/'));
  await fs.mkdir(path.join(root, METADATA_ROOT, 'projects/internal/reports'), { recursive: true }); await fs.writeFile(path.join(root, METADATA_ROOT, 'projects/internal/reports/report.md'), 'Technical report');
  await fs.mkdir(path.join(root, RESOURCES_ROOT), { recursive: true }); await fs.writeFile(path.join(root, RESOURCES_ROOT, 'original.md'), 'Original material');
  await fs.mkdir(path.join(root, '_TraceWeave'), { recursive: true }); await fs.writeFile(path.join(root, '_TraceWeave/old-report.md'), 'Legacy technical file');
  await fs.mkdir(path.join(root, 'Inbox'), { recursive: true }); await fs.writeFile(path.join(root, 'Inbox/Входящая.md'), 'User note');
  const notes = service.listNotes(); assert.ok(notes.some(note => note.path === managed.notePath)); assert.ok(notes.some(note => note.path === 'Inbox/Входящая.md'));
  assert.ok(notes.every(note => !note.path.startsWith(METADATA_ROOT + '/') && !note.path.startsWith(RESOURCES_ROOT + '/') && !note.path.startsWith('_TraceWeave/')));
});

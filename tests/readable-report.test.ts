import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { micromark } from 'micromark';
import { applyCommands, createProject } from '../src/domain';
import type { Asset, Project, Relation, VaultLink } from '../src/types';
import { exportReadableReport, validateReportFolder } from '../src/readable-report';
import { prepareReportMarkdown, relocateReportMarkdown } from '../src/report-markdown';

const NOW = '2026-10-17T10:00:00.000Z', EARLIER = '2026-10-16T08:30:00.000Z';
const uid = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function write(root: string, relative: string, content: string | Uint8Array): Promise<void> { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), content); }
function project(title = 'Исследование'): Project {
  let value = createProject(title, uid(1), EARLIER);
  value = applyCommands(value, [{ kind: 'node.create', id: uid(10), title: 'Поздний узел', notePath: 'Notes/Later.md', x: 451.25, y: -123.75 }], NOW);
  value = applyCommands(value, [{ kind: 'node.create', id: uid(11), title: 'Ранний узел', notePath: 'Notes/Earlier.md', x: -300.5, y: 200.6 }], EARLIER);
  return value;
}
async function notes(root: string): Promise<void> { await write(root, 'Notes/Later.md', 'Late prose\n'); await write(root, 'Notes/Earlier.md', 'Early prose\n'); }
async function asset(root: string, value: Project, number: number, originalName: string, bytes: Uint8Array | string, kind: Asset['mediaKind'] = 'file', mime = 'application/octet-stream'): Promise<Asset> {
  const relative = `Originals/${number}/original${path.posix.extname(originalName)}`, blobId = uid(number + 1000); await write(root, relative, bytes);
  const entry: Asset = { id: uid(number), blobId, originalName, title: `Материал ${number}`, mimeType: mime, mediaKind: kind, byteSize: Buffer.byteLength(bytes), sha256: sha(bytes), createdAt: EARLIER, deletedAt: null, deletionBatchId: null, sourceUrl: 'https://source.example/a%20b', sourceAuthor: 'Автор', sourceCreatedAt: '2020-01-01', noteMarkdown: 'Заметка материала', origin: {} };
  value.assets.push(entry); value.blobs.push({ id: blobId, path: relative, sha256: entry.sha256, byteSize: entry.byteSize, mimeType: mime, mediaKind: kind }); return entry;
}
const relation = (number: number, overrides: Partial<Relation> = {}): Relation => ({ id: uid(number), sourceNodeId: uid(11), targetNodeId: uid(10), relationType: 'related', label: 'Подпись связи', directed: true, bidirectional: false, assessment: 'hypothesis', confidence: 'medium', noteMarkdown: 'Пояснение связи', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: EARLIER, updatedAt: NOW, origin: {}, ...overrides });
async function withVault(action: (root: string) => Promise<void>): Promise<void> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-readable-')); try { await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); } }
async function visible(root: string): Promise<string[]> { return (await fs.readdir(root)).filter(name => name !== 'Notes' && name !== 'Originals'); }

test('readable report has creation chronology, dates, readable metadata and unchanged source/revision', async () => withVault(async root => {
  await notes(root); const value = project(), before = JSON.stringify(value), noteBefore = await fs.readFile(path.join(root, 'Notes/Later.md'));
  value.nodes[0].attributes.push({ id: uid(30), key: 'Факт', valueType: 'boolean', value: true, sortOrder: 0 });
  value.nodes[0].evidence.push({ id: uid(31), sourceKind: 'node', sourceNodeId: uid(11), assetId: null, url: null, label: 'Основание', quote: 'Точная цитата', locator: 'стр. 5', note: 'Комментарий источника', accessedAt: '2026-10-17' });
  value.relations.push(relation(40)); const current = JSON.stringify(value);
  const result = await exportReadableReport(root, value, 'Reports/Готовые');
  assert.equal(result.directory, 'Reports/Готовые/Исследование'); assert.equal(result.summaryPath, result.directory + '/summary.md'); assert.equal(result.canvasPath, result.directory + '/scheme.canvas');
  const summary = await fs.readFile(path.join(root, result.summaryPath), 'utf8');
  assert.ok(summary.indexOf('## 1. Ранний узел') < summary.indexOf('## 2. Поздний узел')); assert.match(summary, /📅 Создано: 2026-10-16 08:30:00 UTC/); assert.match(summary, /Обновлено: 2026-10-17/);
  for (const expected of ['**Факт:** да', 'Основание', 'Точная цитата', 'стр. 5', 'Комментарий источника', 'Подпись связи', 'Пояснение связи', 'Early prose', 'Late prose']) assert.ok(summary.includes(expected), expected);
  assert.match(summary, /\(#\^tw-node-1\)/); assert.ok(!summary.includes(uid(10))); assert.notEqual(before, current); assert.equal(JSON.stringify(value), current);
  assert.deepEqual(await fs.readFile(path.join(root, 'Notes/Later.md')), noteBefore);
  assert.deepEqual((await fs.readdir(path.join(root, result.directory))).sort(), ['Attachments', 'scheme.canvas', 'summary.md']);
  const again = await exportReadableReport(root, value, 'Reports/Готовые'); assert.equal(again.directory, result.directory + ' (2)'); assert.equal(await fs.readFile(path.join(root, result.summaryPath), 'utf8'), summary);
}));

test('all active materials copied with collision-safe readable names, categories and complete metadata', async () => withVault(async root => {
  await notes(root); const value = project();
  const rows = [await asset(root, value, 50, 'Свидетельство.pdf', 'pdf-one', 'file', 'application/pdf'), await asset(root, value, 51, 'Свидетельство.pdf', 'pdf-two', 'file', 'application/pdf'), await asset(root, value, 52, 'pic.png', Buffer.from([137,80,78,71,13,10,26,10,1,2]), 'image', 'image/png'), await asset(root, value, 53, 'clip.mp4', 'video', 'video', 'video/mp4'), await asset(root, value, 54, 'voice.mp3', 'audio', 'audio', 'audio/mpeg'), await asset(root, value, 55, 'bundle.zip', 'archive'), await asset(root, value, 56, 'unknown.bin', 'other')];
  value.attachments.push({ id: uid(60), nodeId: uid(11), assetId: rows[0].id, role: 'primary', sortOrder: 0, caption: 'Подпись вложения' });
  const deleted = await asset(root, value, 57, 'deleted.bin', 'deleted'); deleted.deletedAt = NOW; deleted.deletionBatchId = uid(90);
  const output = await exportReadableReport(root, value, ''), absolute = path.join(root, output.directory), summary = await fs.readFile(path.join(root, output.summaryPath), 'utf8');
  assert.deepEqual((await fs.readdir(path.join(absolute, 'Attachments'))).sort(), ['archives','audio','documents','images','other','video']);
  assert.equal(await fs.readFile(path.join(absolute, 'Attachments/documents/Свидетельство.pdf'), 'utf8'), 'pdf-one'); assert.equal(await fs.readFile(path.join(absolute, 'Attachments/documents/Свидетельство (2).pdf'), 'utf8'), 'pdf-two');
  assert.deepEqual(await fs.readFile(path.join(absolute, 'Attachments/images/pic.png')), Buffer.from([137,80,78,71,13,10,26,10,1,2]));
  for (const expected of ['Подпись вложения', 'Автор источника', 'Дата источника', 'Заметка материала', 'unknown.bin', 'https://source.example/a%20b']) assert.ok(summary.includes(expected), expected);
  assert.ok(!summary.includes('deleted.bin')); assert.ok(!summary.includes('%2520'));
}));

test('Canvas keeps original geometry, z order, groups, labeled endpoints and every arrow mode', async () => withVault(async root => {
  await notes(root); let value = project(); value = applyCommands(value, [{ kind: 'group.create', id: uid(12), title: 'Группа', notePath: 'Notes/Group.md', nodeIds: [uid(11), uid(10)] }], NOW); await write(root, 'Notes/Group.md', 'Групповая заметка');
  value.nodes[0].zIndex = 7; value.nodes[1].zIndex = 2; value.relations.push(relation(40), relation(41, { directed: false }), relation(42, { bidirectional: true }));
  const output = await exportReadableReport(root, value, ''), canvas = JSON.parse(await fs.readFile(path.join(root, output.canvasPath), 'utf8')) as { nodes: { id:string; type:string; x:number; y:number; width:number; height:number; text?:string; label?:string }[]; edges: { fromNode:string; toNode:string; fromEnd:string; toEnd:string; label:string }[] };
  const late = canvas.nodes.find(node => node.id === 'node-2')!; assert.equal(late.x, 451); assert.equal(late.y, -124); assert.equal(late.width, 245); assert.equal(late.height, 112);
  const group = canvas.nodes.find(node => node.type === 'group')!; assert.equal(group.label, 'Группа'); assert.ok(group.x <= -301); assert.ok(canvas.nodes.indexOf(group) < canvas.nodes.indexOf(late));
  assert.ok(late.text?.includes('Исследование/summary.md#^tw-node-2') || late.text?.includes(encodeURI('Исследование') + '/summary.md#^tw-node-2'));
  assert.deepEqual(canvas.edges.map(edge => [edge.fromNode, edge.toNode, edge.fromEnd, edge.toEnd]), [['node-1','node-2','none','arrow'],['node-1','node-2','none','none'],['node-1','node-2','arrow','arrow']]); assert.ok(canvas.edges.every(edge => edge.label.includes('Подпись связи')));
}));

test('Markdown relocates real links and embeds but preserves YAML/code, prevents tracking, and scopes anchors', async () => withVault(async root => {
  await notes(root); const value = project();
  await write(root, 'Notes/Later.md', '# Header\n\ntext ^block\n\nFootnote[^1]\n\n[^1]: Second source\n');
  await write(root, 'Notes/Earlier.md', '---\nlink: "![[Later]]"\n---\n\n# Heading\n\n[[Later#Header|Другой узел]]\n\n[[Later#^block]]\n\n![[../Media/a%20b.png]]\n\n[photo][pic]\n\n[pic]: ../Media/a%20b.png\n\n[![thumbnail](../Media/thumb.png)](../Media/a%20b.png)\n\n![remote](https://track.example/pixel.png)\n\n[bad](javascript:alert%281%29)\n\n<img src="https://track.example/raw.png">\n\nFootnote[^1]\n\n[^1]: First source\n\n`![[Later]]`\n\n```md\n![[Later]]\n![remote](https://track.example/code.png)\n```\n');
  const png = Buffer.from([137,80,78,71,13,10,26,10,1]); await write(root, 'Media/a b.png', png); await write(root, 'Media/thumb.png', png);
  const output = await exportReadableReport(root, value, ''), summary = await fs.readFile(path.join(root, output.summaryPath), 'utf8');
  assert.match(summary, /```yaml\n---\nlink: "!\[\[Later\]\]"/); assert.match(summary, /`!\[\[Later\]\]`/); assert.match(summary, /```md\n!\[\[Later\]\]/);
  assert.match(summary, /\[Другой узел\]\(#2\.1\.\%20header\)/); assert.match(summary, /\(#\^tw-note-2-block\)/); assert.match(summary, /!\[[^\]]+\]\(Attachments\/images\/a%20b\.png\)/);
  assert.match(summary, /\[remote\]\(https:\/\/track\.example\/pixel\.png\)/); assert.ok(!summary.includes('![remote](https://track.example/pixel.png)')); assert.ok(!summary.includes('<img src="https://track.example/raw.png">')); assert.ok(!summary.includes('](javascript:'));
  assert.match(summary, /\[\^tw-note-1-1\]: First source/); assert.match(summary, /\[\^tw-note-2-1\]: Second source/); assert.match(summary, /#### 1\.1\. Heading/);
  assert.deepEqual(await fs.readFile(path.join(root, output.directory, 'Attachments/images/a b.png')), png); assert.deepEqual(await fs.readFile(path.join(root, output.directory, 'Attachments/images/thumb.png')), png);
}));

test('host resolution is authoritative for duplicate names; outside notes are explicit and dangerous files remain links', async () => withVault(async root => {
  await notes(root); const value = project(); await write(root, 'Notes/Earlier.md', '[[Later]]\n\n![[unsafe.html]]\n\n![[fake.png]]\n'); await write(root, 'Outside/Later.md', 'Private outside prose'); await write(root, 'Media/unsafe.html', '<img src="https://tracker/">'); await write(root, 'Media/fake.png', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const resolveLink = async (_source: string, target: string): Promise<VaultLink | null> => ({ path: target === 'Later' ? 'Outside/Later.md' : 'Media/' + target, title: target, resourceUrl: '', mimeType: 'application/octet-stream', mediaKind: 'file', byteSize: 1, isNote: target === 'Later' });
  const output = await exportReadableReport(root, value, '', { resolveLink }), summary = await fs.readFile(path.join(root, output.summaryPath), 'utf8');
  assert.match(summary, /Later \(заметка вне исследования\)/); assert.ok(!summary.includes('Private outside prose')); assert.ok(!summary.includes('![unsafe')); assert.ok(!summary.includes('![fake')); assert.ok(summary.includes('Attachments/other/unsafe.html')); assert.ok(summary.includes('Attachments/other/fake.png') || summary.includes('Attachments/images/fake.png'));
}));

test('missing/changed originals and changed captured notes fail without a partial final report', async () => withVault(async root => {
  await notes(root); const value = project(); await asset(root, value, 50, 'original.bin', 'immutable'); await fs.writeFile(path.join(root, value.blobs[0].path), 'tampered');
  await assert.rejects(() => exportReadableReport(root, value, ''), /скопировать|integrity/iu); assert.deepEqual(await visible(root), []);
  await fs.writeFile(path.join(root, value.blobs[0].path), 'immutable');
  await assert.rejects(() => exportReadableReport(root, value, '', { assertUnchanged: async () => { await fs.appendFile(path.join(root, 'Notes/Earlier.md'), 'change'); } }), /заметка изменилась/iu); assert.deepEqual(await visible(root), []);
  await assert.rejects(() => exportReadableReport(root, value, '', { assertUnchanged: async () => { throw new Error('Revision changed'); } }), /Revision changed/); assert.deepEqual(await visible(root), []);
  await fs.unlink(path.join(root, value.blobs[0].path)); await assert.rejects(() => exportReadableReport(root, value, ''), /скопировать|ENOENT/iu); assert.deepEqual(await visible(root), []);
  await fs.unlink(path.join(root, 'Notes/Later.md')); await assert.rejects(() => exportReadableReport(root, project(), ''), /прочитать заметку/iu); assert.deepEqual(await visible(root), []);
}));

test('report folder rejects traversal, hidden/config paths and symlinks; Unicode names fit filesystem limits', async () => withVault(async root => {
  for (const value of ['/abs', '../outside', 'a/../b', 'a//b', 'a\\b', 'C:/path', '.obsidian', 'Reports/.hidden', 'TWData', '_TraceWeave', 'Reports/x?', 'Reports/x#y', 'Reports/x\0']) assert.throws(() => validateReportFolder(value));
  assert.throws(() => validateReportFolder('PluginConfig/Reports', 'PluginConfig')); assert.equal(validateReportFolder('Reports/Папка 🧪'), 'Reports/Папка 🧪'); assert.equal(validateReportFolder(''), '');
  await notes(root); await fs.symlink(path.join(root, 'Notes'), path.join(root, 'Linked')); await assert.rejects(() => exportReadableReport(root, project(), 'Linked'), /Symbolic/);
  await fs.unlink(path.join(root, 'Notes/Later.md')); await fs.symlink(path.join(root, 'Notes/Earlier.md'), path.join(root, 'Notes/Later.md')); await assert.rejects(() => exportReadableReport(root, project(), ''), /Symbolic/); await fs.unlink(path.join(root, 'Notes/Later.md')); await write(root, 'Notes/Later.md', 'Later');
  const long = project('🧪'.repeat(90)); await asset(root, long, 50, '🧪'.repeat(90) + '.pdf', 'PDF'); const output = await exportReadableReport(root, long, '');
  assert.ok(Buffer.byteLength(path.posix.basename(output.directory)) < 255); const filenames = await fs.readdir(path.join(root, output.directory, 'Attachments/documents')); assert.ok(filenames[0].endsWith('.pdf')); assert.ok(Buffer.byteLength(filenames[0]) < 255);
  const reserved = await exportReadableReport(root, project('TWData'), ''); assert.ok(reserved.directory !== 'TWData');
}));

test('Markdown fragments contain comments/fences and nested label assets without corrupting later sections', async () => {
  for (const source of ['```\nunclosed', '> ```\n> quoted code', '- ```\n  listed code']) {
    const rendered = await relocateReportMarkdown(source, async target => ({ target, embed: false }));
    const html = micromark(rendered + '\n\n## Following node\n\nFollowing prose'); assert.match(html, /<h2>Following node<\/h2>/);
  }
  const commented = await relocateReportMarkdown('%% unfinished', async target => ({ target, embed: false })); assert.match(commented, /%% unfinished\n\n%%/);
  const called: string[] = []; const nested = await relocateReportMarkdown('[![remote](https://track.example/a.png)](https://example.com/a%20b?x=%23a)', async target => { called.push(target); return { target, embed: false }; });
  assert.ok(called.includes('https://track.example/a.png')); assert.ok(!nested.includes('![')); assert.ok(!nested.includes('%2520')); assert.ok(!nested.includes('%2523'));
  const rawHTML = await relocateReportMarkdown('[<img src="https://track.example/a.png">](https://example.com)', async target => ({ target, embed: false })); assert.ok(!rawHTML.includes('<img')); assert.ok(rawHTML.endsWith('(https://example.com/)'));
  const prepared = prepareReportMarkdown('---\nkey: "[[Note]]"\n---\n\nTitle\n=====\n\nText[^1]\n\n[^1]: Source\n', 3); assert.match(prepared.text, /#### 3\.1\. Title/); assert.match(prepared.text, /\[\^tw-note-3-1\]/);
});

test('concurrent reports preserve existing directories and publish separate complete copies', async () => withVault(async root => {
  await notes(root);
  const value = project('Concurrent');
  await fs.mkdir(path.join(root, 'Concurrent'));
  await fs.writeFile(path.join(root, 'Concurrent/keep.txt'), 'Existing user file');
  const outputs = await Promise.all(Array.from({ length: 3 }, () => exportReadableReport(root, value, '')));
  assert.equal(new Set(outputs.map(output => output.directory)).size, 3);
  assert.equal(await fs.readFile(path.join(root, 'Concurrent/keep.txt'), 'utf8'), 'Existing user file');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.traceweave-report-')), []);
  for (const output of outputs) {
    assert.ok((await fs.readFile(path.join(root, output.summaryPath), 'utf8')).includes('Late prose'));
    const canvas = JSON.parse(await fs.readFile(path.join(root, output.canvasPath), 'utf8')) as { nodes: { text?: string }[] };
    assert.ok(canvas.nodes.some(node => decodeURIComponent(node.text ?? '').includes(output.summaryPath)));
  }
}));

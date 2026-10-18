import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import Ajv2020 from 'ajv/dist/2020';
import { applyCommands, createProject, validateProject } from '../src/domain';
import type { Asset, Attribute, BlobRecord, Project, Relation } from '../src/types';
import { ProjectRepository, digest } from '../src/storage/repository';

const NOW = '2026-10-16T10:00:00.000Z';
const schema = JSON.parse(await readFile(new URL('../contracts/obsidian-project.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validator = ajv.compile(schema);
const historySchema = JSON.parse(await readFile(new URL('../contracts/history.schema.json', import.meta.url), 'utf8'));
const historyValidator = ajv.compile(historySchema);
const journalSchema = JSON.parse(await readFile(new URL('../contracts/journal.schema.json', import.meta.url), 'utf8'));
const journalValidator = ajv.compile(journalSchema);
function representative(): Project {
  const p = createProject('Контракт', randomUUID(), NOW), a = randomUUID(), b = randomUUID(), group = randomUUID();
  const blob: BlobRecord = { id: randomUUID(), path: `Исследования/Вложения/${p.id}/original.bin`, sha256: 'a'.repeat(64), byteSize: 3, mimeType: 'application/octet-stream', mediaKind: 'file' };
  const asset: Asset = { id: randomUUID(), blobId: blob.id, originalName: 'Материал.bin', title: 'Материал', mimeType: blob.mimeType, mediaKind: blob.mediaKind, byteSize: blob.byteSize, sha256: blob.sha256, createdAt: NOW, deletedAt: null, deletionBatchId: null, sourceUrl: 'https://example.com/source', sourceAuthor: 'Автор', sourceCreatedAt: NOW, noteMarkdown: 'Описание', origin: { kind: 'manual' } };
  const values: [Attribute['valueType'], Attribute['value']][] = [['text', 'Текст'], ['number', 42], ['boolean', true], ['date', { value: '2024-02-29', precision: 'day' }], ['datetime', NOW], ['url', 'https://example.com/path'], ['geo', { latitude: 61, longitude: 50, accuracyMeters: null }], ['number', null]];
  const relation: Relation = { id: randomUUID(), sourceNodeId: a, targetNodeId: b, relationType: 'related', label: 'Связь', directed: true, bidirectional: true, assessment: 'hypothesis', confidence: 'medium', noteMarkdown: 'Описание связи', evidence: [{ id: randomUUID(), sourceKind: 'asset', sourceNodeId: null, assetId: asset.id, url: null, label: 'Источник', quote: null, locator: 'стр. 1', note: null, accessedAt: NOW }], deletedAt: null, deletionBatchId: null, createdAt: NOW, updatedAt: NOW, origin: { kind: 'manual' } };
  let next = applyCommands(p, [
    { kind: 'node.create', id: a, title: 'Первый', notePath: 'Notes/Первый.md' }, { kind: 'node.create', id: b, title: 'Второй', notePath: 'Notes/Второй.md' },
    { kind: 'node.update', nodeId: a, changes: { attributes: values.map(([valueType, value], sortOrder) => ({ id: randomUUID(), key: `Поле ${sortOrder}`, valueType, value, sortOrder })), iconEmoji: '🧪', tags: ['Кириллица'], evidence: [{ id: randomUUID(), sourceKind: 'url', sourceNodeId: null, assetId: null, url: 'https://example.com/evidence', label: 'Веб-источник', quote: 'Цитата', locator: null, note: null, accessedAt: null }], extensions: { 'example.metadata': { nested: [null, true, 'Текст'] } } } },
    { kind: 'group.create', id: group, title: 'Группа', notePath: 'Groups/Группа.md', nodeIds: [a] }, { kind: 'asset.register', asset, blob },
    { kind: 'attachment.attach', attachment: { id: randomUUID(), nodeId: a, assetId: asset.id, role: 'primary', sortOrder: 0, caption: 'Подпись' } }, { kind: 'relation.create', relation },
    { kind: 'elements.trash', nodeIds: [b], relationIds: [], groupMode: 'group_only' },
  ], NOW);
  const snapshotId = randomUUID(); next = applyCommands(next, [{ kind: 'snapshot.register', snapshot: { id: snapshotId, title: 'Снимок', path: `.twdata/projects/${p.id}/reports/${snapshotId}/snapshot.json`, sourceRevision: next.revision, createdAt: NOW, assetIds: [asset.id] } }], NOW);
  next.receipts[randomUUID()] = { hash: 'b'.repeat(64), revision: next.revision, timestamp: NOW }; next.importedData = { sourceArchive: { arbitraryUnknownMetadata: [1e100, false, null, { retained: true }] } };
  validateProject(next); return next;
}

test('strict local machine schema accepts created and representative persisted projects without mutation', () => {
  for (const project of [createProject('Новый', randomUUID(), NOW), representative()]) {
    const before = JSON.stringify(project); assert.equal(validator(project), true, JSON.stringify(validator.errors)); assert.equal(JSON.stringify(project), before);
    assert.equal(validator(JSON.parse(before)), true, JSON.stringify(validator.errors));
  }
});

test('schema forbids unknown fields at every closed structural level', () => {
  const original = representative();
  const mutate: ((p: Project) => Record<string, unknown>)[] = [p => p as unknown as Record<string, unknown>, p => p.nodes[0] as unknown as Record<string, unknown>, p => p.nodeTypes[0] as unknown as Record<string, unknown>, p => p.relations[0] as unknown as Record<string, unknown>, p => p.nodes[0].attributes[0] as unknown as Record<string, unknown>, p => p.nodes[0].evidence[0] as unknown as Record<string, unknown>, p => p.blobs[0] as unknown as Record<string, unknown>, p => p.assets[0] as unknown as Record<string, unknown>, p => p.attachments[0] as unknown as Record<string, unknown>, p => p.memberships[0] as unknown as Record<string, unknown>, p => p.deletionBatches[0] as unknown as Record<string, unknown>, p => p.snapshots[0] as unknown as Record<string, unknown>, p => Object.values(p.receipts)[0] as unknown as Record<string, unknown>];
  for (const select of mutate) { const project = structuredClone(original); select(project).unexpected = 'must reject'; assert.equal(validator(project), false); assert.ok(validator.errors?.some(error => error.keyword === 'additionalProperties')); }
});

test('schema rejects unsupported versions/features, unsafe paths, malformed typed values and directed state', () => {
  const original = representative();
  const mutations: ((p: Project) => void)[] = [
    p => { (p as unknown as { formatVersion: string }).formatVersion = '2.0'; }, p => { p.requiredFeatures = ['future-feature']; }, p => { p.id = '../escape'; },
    p => { p.nodes[0].notePath = '_TraceWeave/bad.md'; }, p => { p.nodes[0].notePath = '.twdata/notes/bad.md'; }, p => { p.blobs[0].path = '.twdata/resources/bad.bin'; }, p => { p.nodes[0].notePath = 'Notes/.OBSIDIAN/bad.md'; }, p => { p.nodes[0].notePath = '../bad.md'; }, p => { p.nodes[0].notePath = 'Notes/bad.md\0'; },
    p => { p.blobs[0].path = '_TraceWeave/bad.bin'; }, p => { p.snapshots[0].path = 'Notes/snapshot.json'; }, p => { p.nodeTypes[0].iconKey = 'paperclip'; },
    p => { p.nodes[0].attributes[1].value = 'not a number'; }, p => { p.nodes[0].attributes[2].value = 0; }, p => { p.nodes[0].attributes[3].value = { value: '2024-13', precision: 'month' }; },
    p => { p.nodes[0].attributes[6].value = { latitude: 100, longitude: 0, accuracyMeters: null }; }, p => { p.relations[0].directed = false; },
    p => { p.nodes[0].evidence[0].sourceNodeId = p.nodes[1].id; }, p => { p.assets[0].sha256 = 'bad'; }, p => { p.revision = -1; }, p => { p.nodes[0].deletedAt = NOW; p.nodes[0].deletionBatchId = null; },
  ];
  for (const mutate of mutations) { const project = structuredClone(original); mutate(project); assert.equal(validator(project), false, JSON.stringify(project)); }
});

test('schema and domain have distinct documented structural and semantic checks', () => {
  const project = representative(); project.relations[0].sourceNodeId = randomUUID();
  assert.equal(validator(project), true, JSON.stringify(validator.errors)); assert.throws(() => validateProject(project), /Конец связи не существует/);
  assert.ok(schema.description.includes('reference integrity')); assert.ok(schema.description.includes('UTF-8 byte limits'));
});

test('visible project originals and immutable exports share schema/domain guards without allowing legacy metadata as user files', () => {
  const original = representative(), snapshotId = original.snapshots[0].id;
  original.blobs[0].path = 'TWData/projects/Research/documents/Original.txt';
  original.snapshots[0].path = `TWData/exports/Research/snapshots/${snapshotId}/snapshot.json`;
  assert.equal(validator(original), true, JSON.stringify(validator.errors)); validateProject(original);
  for (const value of ['TWData/projects/state.json', `TWData/projects/${original.id}/state.json`, `TWData/projects/${original.id}/reports/snapshot.json`, 'TWData/settings.json', 'TWData/resources/../stolen.bin']) {
    const invalid = structuredClone(original); invalid.blobs[0].path = value;
    assert.equal(validator(invalid), false, value); assert.throws(() => validateProject(invalid), { name: 'DomainError' }, value);
  }
});

test('journal/history schemas accept real committed transaction and undo records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-schema-records-')), repo = new ProjectRepository(root);
  try {
    await repo.initialize(); const p = await repo.add(createProject('Схемы журналов', randomUUID(), NOW)), nodeId = randomUUID(), operationId = randomUUID();
    const committed = await repo.execute(p.id, [{ kind: 'node.create', id: nodeId, title: 'Заметка', notePath: 'Notes/Заметка.md', noteHash: digest('') }], { operationId, effects: [{ path: 'Notes/Заметка.md', before: null, after: '' }] });
    await repo.undoRedo(committed, 'undo');
    for (const kind of ['history', 'journal'] as const) {
      const directory = path.join(root, `.twdata/projects/${p.id}/${kind}`), files = await fs.readdir(directory); assert.equal(files.length, 2);
      for (const file of files) { const record = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')), validate = kind === 'history' ? historyValidator : journalValidator; assert.equal(validate(record), true, JSON.stringify(validate.errors)); }
    }
  } finally { await repo.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('journal/history schemas close every field and require typed IDs/hashes, safe effects and undo targets', () => {
  const state = representative(), operationId = randomUUID();
  const history = { formatVersion: 1, operationId, kind: 'command', before: state, after: state };
  const journal = { formatVersion: 1, projectId: state.id, operationId, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), state, effects: [{ path: state.nodes[0].notePath, before: null, after: '' }], history, completed: false };
  assert.equal(historyValidator(history), true, JSON.stringify(historyValidator.errors)); assert.equal(journalValidator(journal), true, JSON.stringify(journalValidator.errors));
  for (const mutate of [
    (record: Record<string, unknown>) => { record.unexpected = true; },
    (record: Record<string, unknown>) => { record.formatVersion = 2; },
    (record: Record<string, unknown>) => { record.operationId = '../escape'; },
  ]) { for (const [base, validate] of [[history, historyValidator], [journal, journalValidator]] as const) { const record = structuredClone(base) as unknown as Record<string, unknown>; mutate(record); assert.equal(validate(record), false); } }
  assert.equal(historyValidator({ ...history, kind: 'unknown' }), false); assert.equal(historyValidator({ ...history, kind: 'undo' }), false); assert.equal(historyValidator({ ...history, kind: 'redo', target: randomUUID() }), true);
  assert.equal(journalValidator({ ...journal, completed: 'false' }), false); assert.equal(journalValidator({ ...journal, beforeHash: 'bad' }), false);
  for (const effect of [{ path: '_TraceWeave/forbidden.md', before: null, after: '' }, { path: 'Notes/x.md', before: 42, after: '' }, { path: 'Notes/x.md', before: null, after: '', unknown: true }, { path: 'Notes/../../escape.md', before: null, after: '' }]) assert.equal(journalValidator({ ...journal, effects: [effect] }), false);
});

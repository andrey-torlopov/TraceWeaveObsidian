import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands, createProject, DomainError, NODE_ICON_KEYS, projectGraph, searchProject, validateProject, validateRelativePath } from '../src/domain';
import type { Asset, Attribute, BlobRecord, Command, Evidence, Project, Relation } from '../src/types';

const NOW = '2026-10-16T10:00:00.000Z';
const LATER = '2026-10-16T11:00:00.000Z';
const uid = (number: number): string => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const empty = (): Project => createProject('Исследование', uid(1), NOW);
const create = (number: number, overrides: Partial<Extract<Command, { kind: 'node.create' }>> = {}): Command => ({ kind: 'node.create', id: uid(number), title: `Заметка ${number}`, notePath: `Notes/${number}.md`, ...overrides });
const two = (): Project => applyCommands(empty(), [create(10), create(11)], NOW);
const relation = (number: number, source = 10, target = 11, overrides: Partial<Relation> = {}): Relation => ({ id: uid(number), sourceNodeId: uid(source), targetNodeId: uid(target), relationType: 'related', label: null, directed: false, bidirectional: false, assessment: 'unreviewed', confidence: null, noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: NOW, updatedAt: NOW, origin: { kind: 'manual' }, ...overrides });
const attribute = (number: number, valueType: Attribute['valueType'], value: Attribute['value'], key = 'Ключ'): Attribute => ({ id: uid(number), key, valueType, value, sortOrder: 0 });
const source = (number = 50, overrides: Partial<Evidence> = {}): Evidence => ({ id: uid(number), sourceKind: 'node', sourceNodeId: uid(11), assetId: null, url: null, label: 'Источник', quote: null, locator: null, note: null, accessedAt: null, ...overrides });
const blob = (number = 70, overrides: Partial<BlobRecord> = {}): BlobRecord => ({ id: uid(number), path: `Resources/${number}.bin`, sha256: 'a'.repeat(64), byteSize: 42, mimeType: 'application/octet-stream', mediaKind: 'file', ...overrides });
const asset = (number = 71, blobNumber = 70, overrides: Partial<Asset> = {}): Asset => ({ id: uid(number), blobId: uid(blobNumber), originalName: 'Свидетельство.bin', title: 'Свидетельство', mimeType: 'application/octet-stream', mediaKind: 'file', byteSize: 42, sha256: 'a'.repeat(64), createdAt: NOW, deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: '', origin: { kind: 'manual' }, ...overrides });
const expectError = (action: () => unknown, code?: string): void => { assert.throws(action, error => error instanceof DomainError && (code === undefined || error.code === code)); };
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test('project starts with independent system catalogs and normalized Unicode title', () => {
  const project = createProject('  Проект e\u0301  ', uid(1), NOW); const other = empty();
  assert.equal(project.title, 'Проект é'); assert.equal(project.revision, 0); assert.equal(project.formatVersion, '1.0');
  assert.deepEqual(project.nodeTypes.map(type => type.code), ['note', 'person', 'organization', 'phone', 'location', 'evidence', 'conclusion', 'group']);
  assert.ok(project.nodeTypes.every(type => !other.nodeTypes.some(item => item.id === type.id))); validateProject(JSON.parse(JSON.stringify(project)));
});

test('final-state references allow relation and evidence before referenced node creation', () => {
  const project = applyCommands(empty(), [
    { kind: 'relation.create', relation: relation(20) }, create(10),
    { kind: 'node.update', nodeId: uid(10), changes: { evidence: [source()] } }, create(11),
  ], NOW);
  assert.equal(project.revision, 1); assert.equal(project.relations.length, 1); assert.equal(project.nodes[0].evidence[0].sourceNodeId, uid(11));
});

test('invalid last command rolls back a whole batch and preserves a frozen source', () => {
  const project = freeze(two()); const before = JSON.stringify(project);
  expectError(() => applyCommands(project, [{ kind: 'node.update', nodeId: uid(10), changes: { title: 'Изменение' } }, { kind: 'relation.create', relation: relation(20, 10, 10) }], LATER), 'self_relation');
  assert.equal(JSON.stringify(project), before);
  const next = applyCommands(project, [{ kind: 'node.update', nodeId: uid(10), changes: { title: 'Изменение' } }], LATER);
  assert.equal(next.revision, 2); assert.equal(project.nodes[0].title, 'Заметка 10'); assert.equal(next.nodes[0].updatedAt, LATER);
});

test('unknown commands/fields, ID collisions and missing references are rejected', () => {
  expectError(() => applyCommands(empty(), [{ kind: 'node.unknown' } as unknown as Command]), 'unknown_command');
  expectError(() => applyCommands(empty(), [{ ...create(10), typo: true } as unknown as Command]), 'unknown_field');
  expectError(() => applyCommands(empty(), [create(10), create(10)]), 'duplicate_id');
  expectError(() => applyCommands(empty(), [{ kind: 'relation.create', relation: relation(20) }]), 'missing_reference');
  expectError(() => applyCommands(empty(), []));
  const project = empty(); (project as unknown as Record<string, unknown>).unknown = true; expectError(() => validateProject(project), 'unknown_field');
});

for (const path of ['../Note.md', '/Note.md', 'Notes/../Note.md', 'Notes//Note.md', 'C:\\Note.md', '_TraceWeave/note.md', 'Notes/_TRACEWEAVE/note.md', '.obsidian/note.md', 'Notes/.OBSIDIAN/note.md', 'Notes/x.md.', 'Notes/x.md ', 'Notes/x.md\0', 'Notes/x.md?evil']) {
  test(`unsafe note path is rejected: ${JSON.stringify(path)}`, () => expectError(() => applyCommands(empty(), [create(10, { notePath: path })]), 'unsafe_path'));
}

test('note bindings are unique across case/NFC and metadata lives outside ordinary notes', () => {
  expectError(() => applyCommands(empty(), [create(10, { notePath: 'Notes/Test.md' }), create(11, { notePath: 'notes/test.MD' })]), 'duplicate_note');
  expectError(() => applyCommands(empty(), [create(10, { notePath: 'Notes/e\u0301.md' })]), 'unsafe_path');
  validateRelativePath('Notes/Узел 🧪.md', 'note', true);
});

test('relation directions, parallel relations and cycles are preserved', () => {
  const project = applyCommands(two(), [create(12),
    { kind: 'relation.create', relation: relation(20) }, { kind: 'relation.create', relation: relation(21) },
    { kind: 'relation.create', relation: relation(22, 11, 12, { directed: true }) }, { kind: 'relation.create', relation: relation(23, 12, 10, { directed: true, bidirectional: true }) },
    { kind: 'relation.update', relationId: uid(20), changes: { label: 'Связь', directed: true } },
  ], LATER);
  assert.equal(project.relations.length, 4); assert.equal(project.relations[0].label, 'Связь'); assert.equal(project.relations[3].bidirectional, true);
  expectError(() => applyCommands(two(), [{ kind: 'relation.create', relation: relation(20, 10, 11, { bidirectional: true }) }]));
});

test('creating a related relation restores its catalog entry atomically without changing imported history', () => {
  const imported = two(); imported.relationTypes = [{ code: 'historical', name: 'Архивная связь', defaultDirected: true }]; imported.relations = [relation(20, 10, 11, { relationType: 'historical', directed: true, label: 'Импортировано' })];
  const original = JSON.stringify(imported); freeze(imported); const next = applyCommands(imported, [{ kind: 'relation.create', relation: relation(21) }], LATER);
  assert.deepEqual(next.relationTypes, [imported.relationTypes[0], { code: 'related', name: 'Связано с', defaultDirected: false }]); assert.deepEqual(next.relations[0], imported.relations[0]); assert.equal(next.relations[1].relationType, 'related'); assert.equal(next.revision, imported.revision + 1); assert.equal(JSON.stringify(imported), original);
  const again = applyCommands(next, [{ kind: 'relation.create', relation: relation(22) }], LATER); assert.equal(again.relationTypes.filter(type => type.code === 'related').length, 1);
  expectError(() => applyCommands(imported, [{ kind: 'relation.create', relation: relation(21, 10, 10) }], LATER), 'self_relation'); assert.equal(JSON.stringify(imported), original);
});

test('custom type updates remain local and cannot corrupt group semantics', () => {
  const project = empty(); const group = project.nodeTypes.find(type => type.code === 'group')!;
  expectError(() => applyCommands(project, [{ kind: 'type.upsert', type: { ...group, code: 'ordinary' } }]));
  const next = applyCommands(project, [{ kind: 'type.upsert', type: { id: uid(90), code: 'vehicle', name: 'Автомобиль', color: '#112233', iconKey: 'briefcase', isHidden: false, isSystem: false } }, create(10, { typeId: uid(90) })], NOW);
  assert.equal(next.nodes[0].typeId, uid(90)); assert.equal(project.nodeTypes.length, 8);
});

test('node icons use the exact portable archive2 catalog and reject unsupported keys', () => {
  const project = empty(), noteType = project.nodeTypes.find(type => type.code === 'note')!;
  for (const iconKey of NODE_ICON_KEYS) assert.doesNotThrow(() => applyCommands(project, [{ kind: 'type.upsert', type: { ...noteType, iconKey } }], NOW));
  for (const iconKey of ['paperclip', 'lightbulb', 'group', 'car', 'javascript:alert(1)']) expectError(() => applyCommands(project, [{ kind: 'type.upsert', type: { ...noteType, iconKey } }], NOW), 'invalid_icon');
  assert.ok(project.nodeTypes.every(type => (NODE_ICON_KEYS as readonly string[]).includes(type.iconKey)));
});

test('typed attributes accept all supported values and normalize keys/tags without touching text', () => {
  const attributes = [attribute(100, 'text', ' x '), attribute(101, 'number', 2.5, 'Число'), attribute(102, 'boolean', false, 'Признак'), attribute(103, 'date', { value: '2024-02-29', precision: 'day' }, 'Дата'), attribute(104, 'datetime', NOW, 'Время'), attribute(105, 'url', 'https://example.com/a?x=1', 'Адрес'), attribute(106, 'geo', { latitude: 90, longitude: -180, accuracyMeters: null }, 'Место'), attribute(107, 'number', null, 'Неизвестно')];
  const project = applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { attributes, tags: ['  Тег  '], extensions: { 'example.info': { checked: true } } } }], NOW);
  assert.equal(project.nodes[0].attributes[0].value, ' x '); assert.deepEqual(project.nodes[0].tags, ['Тег']);
});

for (const bad of [
  attribute(100, 'number', Infinity), attribute(100, 'number', Number.MAX_SAFE_INTEGER + 1), attribute(100, 'boolean', 'true'),
  attribute(100, 'date', { value: '2023-02-29', precision: 'day' }), attribute(100, 'date', { value: '2024-02-99', precision: 'day' }), attribute(100, 'date', { value: '2024-13', precision: 'month' }),
  attribute(100, 'url', 'javascript:alert(1)'), attribute(100, 'datetime', '2026-02-30T00:00:00Z'),
  attribute(100, 'geo', { latitude: 91, longitude: 0, accuracyMeters: null }), attribute(100, 'geo', { latitude: 0, longitude: 0, accuracyMeters: 0 }),
]) test(`invalid attribute ${bad.valueType} ${JSON.stringify(bad.value)} fails`, () => expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { attributes: [bad] } }])));

test('Unicode attribute key and tag duplicates are rejected', () => {
  expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { attributes: [attribute(100, 'text', '', 'Ключ'), attribute(101, 'text', '', 'КЛЮЧ')] } }]));
  expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { tags: ['Тег', 'тег'] } }]));
  expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { extensions: { data: 'x'.repeat(16384) } } }]));
});

test('evidence requires exactly one resolvable source and allows stable references into trash', () => {
  const project = applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { evidence: [source()] } }], NOW);
  const deleted = applyCommands(project, [{ kind: 'elements.trash', nodeIds: [uid(11)], relationIds: [], groupMode: 'group_only' }], LATER);
  assert.equal(deleted.nodes[0].evidence[0].sourceNodeId, uid(11));
  expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { evidence: [source(50, { sourceNodeId: uid(99) })] } }]), 'missing_reference');
  expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { evidence: [source(50, { url: 'https://example.com' })] } }]));
  expectError(() => applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { evidence: [source(50, { sourceKind: 'url', sourceNodeId: null, url: 'file:///etc/passwd' })] } }]));
});

test('group move uses absolute positions, shifts every member once and preserves relations', () => {
  const initial = applyCommands(two(), [{ kind: 'nodes.move', positions: [{ nodeId: uid(10), x: 10, y: 20 }, { nodeId: uid(11), x: 30, y: 40 }] }, { kind: 'relation.create', relation: relation(20) }, { kind: 'group.create', id: uid(30), title: 'Группа', notePath: 'Groups/30.md', nodeIds: [uid(10), uid(11)] }], NOW);
  const group = initial.nodes.find(node => node.id === uid(30))!;
  const moved = applyCommands(initial, [{ kind: 'nodes.move', positions: [{ nodeId: uid(30), x: group.x + 100, y: group.y - 50 }, { nodeId: uid(10), x: 110, y: -30 }] }], LATER);
  assert.deepEqual(moved.nodes.slice(0, 2).map(node => [node.x, node.y]), [[110, -30], [130, -10]]); assert.deepEqual(moved.relations, initial.relations);
  expectError(() => applyCommands(initial, [{ kind: 'nodes.move', positions: [{ nodeId: uid(30), x: group.x + 100, y: group.y - 50 }, { nodeId: uid(10), x: 999, y: 999 }] }]), 'ambiguous_move');
  const ungrouped = applyCommands(moved, [{ kind: 'group.ungroup', groupId: uid(30) }], LATER); assert.equal(ungrouped.memberships.length, 0); assert.equal(ungrouped.nodes[2].typeId, ungrouped.nodeTypes.find(type => type.code === 'note')!.id); assert.equal(ungrouped.nodes[0].x, 110);
});

test('unique membership and one group level are enforced including empty membership calls', () => {
  const grouped = applyCommands(two(), [{ kind: 'group.create', id: uid(30), title: 'Группа', notePath: 'Groups/30.md', nodeIds: [uid(10)] }], NOW);
  expectError(() => applyCommands(grouped, [{ kind: 'group.create', id: uid(31), title: 'Вторая', notePath: 'Groups/31.md', nodeIds: [uid(10)] }]), 'membership_conflict');
  expectError(() => applyCommands(grouped, [{ kind: 'group.create', id: uid(31), title: 'Вторая', notePath: 'Groups/31.md', nodeIds: [uid(30)] }]), 'invalid_group');
  expectError(() => applyCommands(grouped, [{ kind: 'group.members', groupId: uid(10), nodeIds: [] }]), 'invalid_group');
  const changed = applyCommands(grouped, [{ kind: 'group.members', groupId: uid(30), nodeIds: [uid(11)] }], NOW); assert.equal(changed.memberships[0].memberNodeId, uid(11));
});

test('trash batch includes incident relations and memberships and strict restore is atomic', () => {
  const grouped = applyCommands(two(), [{ kind: 'relation.create', relation: relation(20) }, { kind: 'group.create', id: uid(30), title: 'Группа', notePath: 'Groups/30.md', nodeIds: [uid(10)] }], NOW);
  const deleted = applyCommands(grouped, [{ kind: 'elements.trash', nodeIds: [uid(10)], relationIds: [], groupMode: 'group_only' }], LATER); const batch = deleted.deletionBatches[0];
  assert.deepEqual(batch.relationIds, [uid(20)]); assert.equal(deleted.memberships.length, 0); assert.equal(deleted.relations[0].deletedAt, LATER);
  const conflicting = applyCommands(deleted, [{ kind: 'elements.trash', nodeIds: [uid(11)], relationIds: [], groupMode: 'group_only' }], LATER); const frozen = freeze(conflicting); const before = JSON.stringify(frozen);
  expectError(() => applyCommands(frozen, [{ kind: 'trash.restore', batchId: batch.id }]), 'deleted_reference'); assert.equal(JSON.stringify(frozen), before);
  const restored = applyCommands(deleted, [{ kind: 'trash.restore', batchId: batch.id }], LATER); assert.ok(restored.nodes.every(node => node.deletedAt === null)); assert.equal(restored.relations[0].deletedAt, null); assert.equal(restored.memberships.length, 1);
  expectError(() => applyCommands(restored, [{ kind: 'trash.restore', batchId: batch.id }]), 'restore_conflict');
});

test('group-only trash frees members; group-with-members restores whole composition', () => {
  const grouped = applyCommands(two(), [{ kind: 'group.create', id: uid(30), title: 'Группа', notePath: 'Groups/30.md', nodeIds: [uid(10), uid(11)] }], NOW);
  const only = applyCommands(grouped, [{ kind: 'elements.trash', nodeIds: [uid(30)], relationIds: [], groupMode: 'group_only' }], NOW); assert.ok(only.nodes.slice(0, 2).every(node => node.deletedAt === null)); assert.equal(only.memberships.length, 0);
  const all = applyCommands(grouped, [{ kind: 'elements.trash', nodeIds: [uid(30)], relationIds: [], groupMode: 'group_with_members' }], NOW); assert.ok(all.nodes.every(node => node.deletedAt !== null));
  const restored = applyCommands(all, [{ kind: 'trash.restore', batchId: all.deletionBatches[0].id }], LATER); assert.equal(restored.memberships.length, 2);
});

test('materials share immutable blobs and attachments, with one primary per node', () => {
  const registered = applyCommands(two(), [{ kind: 'asset.register', asset: asset(), blob: blob() }, { kind: 'asset.register', asset: asset(72), blob: blob() },
    { kind: 'attachment.attach', attachment: { id: uid(80), nodeId: uid(10), assetId: uid(71), role: 'primary', sortOrder: 0, caption: null } },
    { kind: 'attachment.attach', attachment: { id: uid(81), nodeId: uid(11), assetId: uid(71), role: 'primary', sortOrder: 0, caption: null } },
    { kind: 'attachment.attach', attachment: { id: uid(82), nodeId: uid(10), assetId: uid(72), role: 'primary', sortOrder: 1, caption: 'Второй' } },
    { kind: 'asset.update', assetId: uid(71), changes: { title: ' Обновлено ', sourceUrl: 'https://example.com', noteMarkdown: 'Описание' } },
  ], NOW);
  assert.equal(registered.blobs.length, 1); assert.equal(registered.assets.length, 2); assert.equal(registered.attachments.filter(item => item.nodeId === uid(10) && item.role === 'primary')[0].id, uid(82));
  assert.equal(registered.assets[0].title, 'Обновлено');
  const updatedPair = applyCommands(registered, [{ kind: 'attachment.attach', attachment: { id: uid(83), nodeId: uid(10), assetId: uid(71), role: 'attachment', sortOrder: 3, caption: 'Новая подпись' } }, { kind: 'attachment.primary', attachmentId: uid(80) }], NOW);
  assert.equal(updatedPair.attachments.length, 3); assert.equal(updatedPair.attachments[0].id, uid(80)); assert.equal(updatedPair.attachments[0].caption, 'Новая подпись');
  const detached = applyCommands(updatedPair, [{ kind: 'attachment.detach', attachmentId: uid(80) }], LATER); assert.equal(detached.assets.length, 2); assert.equal(detached.blobs.length, 1); assert.ok(detached.attachments.some(item => item.nodeId === uid(11)));
  expectError(() => applyCommands(registered, [{ kind: 'asset.register', asset: asset(73), blob: blob(70, { sha256: 'b'.repeat(64) }) }]), 'blob_conflict');
});

test('snapshot registration retains immutable original refs in centralized folder', () => {
  const project = applyCommands(two(), [{ kind: 'asset.register', asset: asset(), blob: blob() }], NOW);
  const snapshot = { id: uid(90), title: 'Отчёт', path: `TWData/projects/${project.id}/reports/${uid(90)}/snapshot.json`, sourceRevision: project.revision, createdAt: NOW, assetIds: [uid(71)] };
  const next = applyCommands(project, [{ kind: 'snapshot.register', snapshot }], LATER); assert.deepEqual(next.snapshots[0], snapshot);
  expectError(() => applyCommands(project, [{ kind: 'snapshot.register', snapshot: { ...snapshot, path: 'Notes/snapshot.json' } }]), 'unsafe_path');
  expectError(() => applyCommands(next, [{ kind: 'snapshot.register', snapshot }]), 'duplicate_id');
});

test('archive guard permits explicit unarchive and host path reconciliation only', () => {
  const archived = applyCommands(two(), [{ kind: 'project.update', changes: { status: 'archived' } }], NOW);
  expectError(() => applyCommands(archived, [{ kind: 'node.update', nodeId: uid(10), changes: { title: 'Нельзя' } }]), 'project_archived');
  const reconciled = applyCommands(archived, [{ kind: 'node.update', nodeId: uid(10), changes: { notePath: 'Renamed/10.md', noteHash: 'b'.repeat(64), missing: true } }], LATER); assert.equal(reconciled.status, 'archived'); assert.equal(reconciled.nodes[0].missing, true);
  expectError(() => applyCommands(archived, [{ kind: 'project.update', changes: { title: 'Нельзя', status: 'active' } }]), 'project_archived');
  const unarchived = applyCommands(archived, [{ kind: 'project.update', changes: { status: 'active' } }, { kind: 'node.update', nodeId: uid(10), changes: { title: 'Можно' } }], LATER); assert.equal(unarchived.nodes[0].title, 'Можно');
});

test('search is literal, Unicode-aware, complete for large bodies, and excludes trash', () => {
  const project = applyCommands(two(), [{ kind: 'node.update', nodeId: uid(10), changes: { title: 'Кириллица 100%_', attributes: [attribute(100, 'text', 'Данные', 'Свойство')] } }], NOW);
  const body = 'x'.repeat(5 * 1024 * 1024 - 20) + ' КОНЕЦ e\u0301';
  assert.equal(searchProject(project, '%_').length, 1); assert.equal(searchProject(project, 'кириллица')[0].nodeId, uid(10)); assert.equal(searchProject(project, 'кириллица', {}, true).length, 0);
  assert.equal(searchProject(project, 'конец é', new Map([[uid(10), body]]))[0].field, 'body'); assert.equal(searchProject(project, 'свойство')[0].field, `attribute:${uid(100)}`);
  const deleted = applyCommands(project, [{ kind: 'elements.trash', nodeIds: [uid(10)], relationIds: [], groupMode: 'group_only' }], NOW); assert.equal(searchProject(deleted, 'Кириллица').length, 0);
});

test('group projection preserves all external source IDs without mutating stored endpoints', () => {
  const project = applyCommands(two(), [create(12), { kind: 'group.create', id: uid(30), title: 'Группа', notePath: 'Groups/30.md', nodeIds: [uid(10), uid(11)] },
    { kind: 'relation.create', relation: relation(20) }, { kind: 'relation.create', relation: relation(21, 10, 12) }, { kind: 'relation.create', relation: relation(22, 11, 12) },
  ], NOW); const before = JSON.stringify(project); const view = projectGraph(project, [uid(30)]);
  assert.deepEqual(view.nodes.map(node => node.id), [uid(12), uid(30)]); assert.equal(view.relations.length, 1); assert.deepEqual(view.relations[0].relationIds, [uid(21), uid(22)]); assert.equal(JSON.stringify(project), before);
  assert.equal(projectGraph(project).relations.length, 3); assert.ok(project.relations.every(item => item.sourceNodeId !== uid(30)));
});

test('unsupported versions/features, invalid JSON numbers and corrupt receipts never load', () => {
  for (const mutate of [
    (project: Project) => { (project as unknown as { formatVersion: string }).formatVersion = '2.0'; },
    (project: Project) => { project.requiredFeatures = ['future']; },
    (project: Project) => { project.revision = Infinity; },
    (project: Project) => { project.receipts[uid(100)] = { hash: 'bad', revision: 0, timestamp: NOW }; },
    (project: Project) => { project.importedData = { nested: { unsafe: undefined } }; },
  ]) { const project = empty(); mutate(project); expectError(() => validateProject(project)); }
});

test('opaque compatibility metadata survives every command without aliasing caller objects', () => {
  const project = two(); project.importedData = { sourceArchive: { formatVersion: '2.0', unknown: ['сохранить'] } }; project.nodes[0].origin = { kind: 'import', extra: { value: 42 } };
  const commands: Command[] = [{ kind: 'node.update', nodeId: uid(10), changes: { extensions: { 'custom.name': { mutable: true } } } }];
  const next = applyCommands(freeze(project), freeze(commands), LATER); assert.deepEqual(next.importedData, project.importedData); assert.deepEqual(next.nodes[0].origin, project.nodes[0].origin);
  (next.nodes[0].extensions['custom.name'] as { mutable: boolean }).mutable = false; assert.equal((commands[0] as Extract<Command, { kind: 'node.update' }>).changes.extensions!['custom.name'] && ((commands[0] as Extract<Command, { kind: 'node.update' }>).changes.extensions!['custom.name'] as { mutable: boolean }).mutable, true);
});

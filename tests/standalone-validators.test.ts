import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/domain';
import { obsidianProject, history, journal, archiveOrigin, archiveProject } from '../src/generated/validators';

const id = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-17T10:00:00.000Z';
test('standalone local schemas keep strict recovery and project boundaries', () => {
  const project = createProject('Standalone', id, timestamp);
  assert.equal(obsidianProject(project), true);
  assert.equal(obsidianProject({ ...project, unexpected: true }), false);
  const record = { formatVersion: 1, operationId: id, kind: 'command', before: project, after: project };
  assert.equal(history(record), true);
  assert.equal(history({ ...record, kind: 'invented' }), false);
  assert.equal(journal({}), false);
});
test('standalone archive custom rules preserve normalization and JSON-byte limits', () => {
  assert.equal(archiveOrigin({ kind: 'manual' }), true);
  assert.equal(archiveOrigin({ kind: 'manual', ignored: true }), false);
  assert.equal(archiveProject({}), false);
  assert.ok(archiveProject.errors?.length);
});

function archiveFixture(): import('../src/archive-types').ArchiveProject {
  return {
    format: 'research-graph.project', formatVersion: '2.0',
    investigation: { id, title: 'Archive', descriptionMarkdown: '', status: 'active', revision: 0, createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
    blobs: [], nodeTypes: [], relationTypes: [],
    nodes: [{ id, investigationId: id, typeId: id, title: 'Node', subtitle: null, bodyMarkdown: '', assessment: 'unreviewed', confidence: null, tags: [], extensions: {}, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, deletionBatchId: null, origin: { kind: 'manual' }, iconEmoji: null }],
    attributes: [], layouts: [], memberships: [], relations: [], assets: [], attachments: [], evidence: [], reports: [], snapshots: [], snapshotAssets: [], deletionBatches: [],
  };
}
function rejectedByKeyword(value: unknown, keyword: string): void {
  assert.equal(archiveProject(value), false);
  assert.ok(archiveProject.errors?.some(error => error.keyword === keyword), JSON.stringify(archiveProject.errors));
}

test('standalone UTF-8 keyword accepts the exact byte limit and rejects one extra byte', () => {
  const project = archiveFixture();
  project.nodes[0]!.iconEmoji = '😀'.repeat(32);
  assert.equal(Buffer.byteLength(project.nodes[0]!.iconEmoji), 128);
  assert.equal(archiveProject(project), true);
  project.nodes[0]!.iconEmoji += 'x';
  assert.equal(Buffer.byteLength(project.nodes[0]!.iconEmoji), 129);
  rejectedByKeyword(project, 'x-maxUtf8Bytes');
});

test('standalone JSON UTF-8 keyword counts serialized object overhead and accepts exactly 16 KiB', () => {
  const project = archiveFixture(), overhead = Buffer.byteLength(JSON.stringify({ 'test.data': '' }));
  const available = 16_384 - overhead;
  project.nodes[0]!.extensions = { 'test.data': 'é'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2) };
  assert.equal(Buffer.byteLength(JSON.stringify(project.nodes[0]!.extensions)), 16_384);
  assert.equal(archiveProject(project), true);
  project.nodes[0]!.extensions['test.data'] += 'x';
  assert.equal(Buffer.byteLength(JSON.stringify(project.nodes[0]!.extensions)), 16_385);
  rejectedByKeyword(project, 'x-maxJsonUtf8Bytes');
});

test('standalone normalization keyword enforces NFC and trim while retaining composed text', () => {
  const project = archiveFixture();
  project.nodes[0]!.title = 'café';
  assert.equal(archiveProject(project), true);
  for (const title of ['cafe\u0301', ' café', 'café ', '\tcafé']) {
    project.nodes[0]!.title = title;
    rejectedByKeyword(project, 'x-normalize');
  }
});

test('standalone calendar keyword rejects normalized nonexistent days and accepts supported precisions', () => {
  const project = archiveFixture();
  const attribute: import('../src/archive-types').ArchiveAttributeDate = { id, nodeId: id, key: 'Date', normalizedKey: 'date', valueType: 'date', value: null, sortOrder: 0 };
  project.attributes = [attribute];
  for (const value of [{ value: '2024', precision: 'year' }, { value: '2024-02', precision: 'month' }, { value: '2024-02-29', precision: 'day' }, { value: '2000-02-29', precision: 'day' }] as const) {
    attribute.value = value;
    assert.equal(archiveProject(project), true, JSON.stringify(archiveProject.errors));
  }
  for (const value of ['2025-02-29', '1900-02-29', '2026-04-31']) {
    attribute.value = { value, precision: 'day' };
    rejectedByKeyword(project, 'x-realCalendarDate');
  }
});

test('standalone archive formats retain URL parsing and date parsing checks', () => {
  const project = archiveFixture();
  project.evidence = [{ id, investigationId: id, subjectKind: 'node', subjectId: id, label: '', quote: null, locator: null, accessedAt: null, note: '', sourceKind: 'url', sourceNodeId: null, assetId: null, url: 'https://example.org/source' }];
  assert.equal(archiveProject(project), true);
  project.evidence[0]!.url = 'https://[invalid';
  rejectedByKeyword(project, 'format');
  project.evidence = [];
  project.investigation.createdAt = '2026-13-01T00:00:00.000Z';
  rejectedByKeyword(project, 'format');
});

test('standalone extension rules preserve recursive JSON and reject unsupported namespace and property names', () => {
  const project = archiveFixture();
  project.nodes[0]!.extensions = { 'test.data': { nested: [null, false, 0, 'retained', { value: 'content' }] } };
  project.investigation.importProvenance = { retained: { source: ['opaque', 1, null] } };
  const before = structuredClone(project);
  assert.equal(archiveProject(project), true);
  assert.deepEqual(project, before);
  project.nodes[0]!.extensions = { unnamespaced: {} };
  rejectedByKeyword(project, 'additionalProperties');
  project.nodes[0]!.extensions = { 'test.data': { '\u0000': 'invalid key' } };
  rejectedByKeyword(project, 'propertyNames');
});

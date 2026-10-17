import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommands, createProject } from '../src/domain';
import { canvasPosition, documentPosition, nodeGlyph, projectGraph, relationLabel, safeExternalUrl } from '../src/ui/graphModel';
import type { Project, Relation } from '../src/types';

const timestamp = '2026-10-16T10:00:00.000Z';
const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
function relation(number: number, source: number, target: number, overrides: Partial<Relation> = {}): Relation {
  return { id: id(number), sourceNodeId: id(source), targetNodeId: id(target), relationType: 'related', label: null, directed: false, bidirectional: false, assessment: 'unreviewed', confidence: null, noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: timestamp, updatedAt: timestamp, origin: {}, ...overrides };
}
function fixture(): Project {
  return applyCommands(createProject('Проекция', id(1), timestamp), [
    { kind: 'node.create', id: id(10), title: 'Первая', notePath: 'Notes/1.md' },
    { kind: 'node.create', id: id(11), title: 'Вторая', notePath: 'Notes/2.md' },
    { kind: 'node.create', id: id(12), title: 'Внешняя', notePath: 'Notes/3.md' },
    { kind: 'group.create', id: id(20), title: 'Группа', notePath: 'Notes/group.md', nodeIds: [id(10), id(11)] },
  ], timestamp);
}

test('collapsed group aggregates external relations, hides internal ones and preserves source data', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12) },
    { kind: 'relation.create', relation: relation(31, 11, 12) },
    { kind: 'relation.create', relation: relation(32, 10, 11) },
  ], timestamp);
  const before = JSON.stringify(project);
  const graph = projectGraph(project, [id(20)]);
  assert.deepEqual(graph.nodes.map((node) => node.id), [id(12), id(20)]);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0].projected, true);
  assert.equal(graph.relations[0].source, id(20));
  assert.deepEqual(graph.relations[0].relations.map((edge) => edge.id), [id(30), id(31)]);
  assert.equal(JSON.stringify(project), before);
});

test('expanding returns every original relation including parallel edges and internal connections', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12) },
    { kind: 'relation.create', relation: relation(31, 10, 12) },
    { kind: 'relation.create', relation: relation(32, 10, 11) },
  ], timestamp);
  const graph = projectGraph(project, []);
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.relations.map((edge) => edge.id).sort(), [id(30), id(31), id(32)]);
  assert.deepEqual(graph.relations.slice(0, 2).map((edge) => edge.offset), [-16, 16]);
  assert.ok(graph.relations.every((edge) => !edge.projected));
});

test('aggregation keeps direction semantics separate', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12, { directed: true }) },
    { kind: 'relation.create', relation: relation(31, 12, 11, { directed: true }) },
    { kind: 'relation.create', relation: relation(32, 10, 12, { directed: true, bidirectional: true }) },
    { kind: 'relation.create', relation: relation(33, 10, 12, { relationType: 'supports' }) },
  ], timestamp);
  assert.equal(projectGraph(project, [id(20)]).relations.length, 4);
});

test('undirected reverse edges aggregate together and selection filters retain collapsed parent', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12) },
    { kind: 'relation.create', relation: relation(31, 12, 11) },
  ], timestamp);
  const graph = projectGraph(project, [id(20)], new Set([id(10), id(12)]));
  assert.deepEqual(new Set(graph.nodes.map((node) => node.id)), new Set([id(12), id(20)]));
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0].relations.length, 2);
});

test('trashed nodes and their relationships never leak into graph projection', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12) },
    { kind: 'elements.trash', nodeIds: [id(10)], relationIds: [], groupMode: 'group_only' },
  ], timestamp);
  const graph = projectGraph(project, []);
  assert.equal(graph.relations.length, 0);
  assert.ok(!graph.nodes.some((node) => node.id === id(10)));
});

test('parallel routing offsets are independent of input ordering', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12) },
    { kind: 'relation.create', relation: relation(31, 12, 10) },
    { kind: 'relation.create', relation: relation(32, 10, 12) },
  ], timestamp);
  const before = new Map(projectGraph(project, []).relations.map((edge) => [edge.id, edge.offset]));
  project.relations.reverse();
  const after = new Map(projectGraph(project, []).relations.map((edge) => [edge.id, edge.offset]));
  assert.deepEqual(before, after);
});

test('note icon override is personal, and does not mutate document type presentation', () => {
  const project = fixture();
  const first = project.nodes[0], other = project.nodes[1];
  const before = nodeGlyph(project, other);
  first.iconEmoji = '🧩';
  assert.equal(nodeGlyph(project, first), '🧩');
  assert.equal(nodeGlyph(project, other), before);
});

test('preview links allow explicit HTTP navigation and reject executable/local URL schemes', () => {
  assert.equal(safeExternalUrl('https://example.org/source?q=1'), 'https://example.org/source?q=1');
  assert.equal(safeExternalUrl('http://example.org'), 'http://example.org/');
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'obsidian://open?vault=a', '//example.org/tracker', '../note.md', null, undefined, '']) assert.equal(safeExternalUrl(unsafe), undefined);
});

test('canvas centering never changes stored coordinates and drag displacement is converted exactly once', () => {
  for (const position of [{ x: 0, y: 0 }, { x: -1000, y: 45.5 }, { x: 999999.25, y: -999999.75 }]) {
    assert.deepEqual(documentPosition(canvasPosition(position)), position);
    const canvas = canvasPosition(position);
    assert.deepEqual(documentPosition({ x: canvas.x + 87.25, y: canvas.y - 13.5 }), { x: position.x + 87.25, y: position.y - 13.5 });
  }
});

test('labels never fall back to archived machine types', () => {
  assert.equal(relationLabel({ label: null }), '');
  assert.equal(relationLabel({ label: '   ' }), '');
  assert.equal(relationLabel({ label: '  Свидетельство  ' }), 'Свидетельство');
});

test('group projections separate hypotheses and explicit labels while retaining archived type data', () => {
  const project = applyCommands(fixture(), [
    { kind: 'relation.create', relation: relation(30, 10, 12, { relationType: 'old-one', assessment: 'hypothesis' }) },
    { kind: 'relation.create', relation: relation(31, 11, 12, { relationType: 'old-two', assessment: 'confirmed_by_user' }) },
    { kind: 'relation.create', relation: relation(32, 10, 12, { relationType: 'old-three', assessment: 'hypothesis', label: 'Подпись' }) },
    { kind: 'relation.create', relation: relation(33, 11, 12, { relationType: 'old-four', assessment: 'hypothesis' }) },
  ], timestamp);
  const graph = projectGraph(project, [id(20)]);
  assert.equal(graph.relations.length, 3);
  const hypotheses = graph.relations.find((edge) => edge.relations.length === 2)!;
  assert.deepEqual(hypotheses.relations.map((edge) => edge.relationType), ['old-one', 'old-four']);
  assert.ok(graph.relations.every((edge) => edge.relations.every((relation) => relation.assessment === edge.relations[0].assessment && relationLabel(relation) === relationLabel(edge.relations[0]))));
});

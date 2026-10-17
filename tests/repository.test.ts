import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createProject, DomainError } from '../src/domain';
import { ProjectRepository, digest, stableJSON, strictJSON, type FaultPoint } from '../src/storage/repository';
import type { Command, Project } from '../src/types';

const NOW = '2026-10-16T10:00:00.000Z';
const project = (): Project => createProject('Проверка файлового репозитория', randomUUID(), NOW);
const note = (id: string, notePath = 'Notes/Новая заметка.md', body = ''): Command => ({ kind: 'node.create', id, title: 'Новая заметка', notePath, noteHash: digest(body) });
const rejectsCode = (action: () => Promise<unknown>, code: string): Promise<void> => assert.rejects(action, error => error instanceof DomainError && error.code === code);
async function withRepository<T>(run: (repo: ProjectRepository, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-repository-')); const repo = new ProjectRepository(root);
  try { await repo.initialize(); return await run(repo, root); } finally { await repo.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}
async function paths(root: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }); const result: string[] = [];
  for (const entry of entries) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) result.push(...await paths(root, relative)); else result.push(relative); }
  return result.sort();
}

test('strict JSON rejects duplicate keys/comments/trailing comma and canonical hash ignores key order', () => {
  for (const text of ['{"a":1,"a":2}', '{"x":{"a":1,"a":2}}', '{/* comment */"a":1}', '{"a":1,}', 'NaN']) assert.throws(() => strictJSON(text), DomainError);
  assert.deepEqual(strictJSON('{"a":1,"nested":{"a":2}}'), { a: 1, nested: { a: 2 } });
  assert.deepEqual(strictJSON('\uFEFF{"a":1}'), { a: 1 });
  for (const text of ['\uFEFF{"a":1,"a":2}', '\uFEFF{/* comment */"a":1}', '\uFEFF\uFEFF{"a":1}']) assert.throws(() => strictJSON(text), DomainError);
  assert.equal(digest(stableJSON({ z: 1, a: { q: 2, p: 3 } })), digest(stableJSON({ a: { p: 3, q: 2 }, z: 1 })));
});

test('Markdown BOM survives read, atomic save and guarded transactional editing byte for byte', async () => {
  await withRepository(async (repo, root) => {
    const relative = 'Notes/BOM.md', original = '\uFEFF---\ntitle: Исходник\n---\n\nОбычная заметка.\n', changed = original + 'Добавленная строка.\n';
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), original);
    const raw = await fs.readFile(path.join(root, relative)); assert.deepEqual(raw.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf])); assert.equal(await repo.readText(relative), original); assert.equal(digest(await repo.readText(relative)), digest(raw.toString('utf8')));
    await repo.atomicText(relative, await repo.readText(relative)); assert.deepEqual(await fs.readFile(path.join(root, relative)), raw);
    const p = await repo.add(project()), id = randomUUID(); const adopted = await repo.execute(p.id, [note(id, relative, original)]);
    const saved = await repo.execute(p.id, [{ kind: 'node.update', nodeId: id, changes: { noteHash: digest(changed) } }], { baseRevision: adopted.revision, effects: [{ path: relative, before: original, after: changed }] });
    assert.equal(saved.nodes[0].noteHash, digest(changed)); assert.deepEqual(await fs.readFile(path.join(root, relative)), Buffer.from(changed)); assert.equal(await repo.readText(relative), changed);
  });
});

test('transaction persists centrally, restart loads it, and idempotency precedes stale revision', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()), nodeId = randomUUID(), operationId = randomUUID(); const commands = [note(nodeId)];
    const effects = [{ path: 'Notes/Новая заметка.md', before: null, after: '' }];
    const committed = await repo.execute(p.id, commands, { operationId, baseRevision: 0, effects });
    assert.equal(committed.revision, 1); assert.equal(await fs.readFile(path.join(root, effects[0].path), 'utf8'), '');
    const replay = await repo.execute(p.id, commands, { operationId, baseRevision: 0, effects }); assert.equal(replay.revision, 1); assert.equal(replay.nodes.length, 1);
    await rejectsCode(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Другое тело' } }], { operationId, baseRevision: 0, effects }), 'idempotency_mismatch');
    await rejectsCode(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Другое действие' } }], { operationId: randomUUID(), baseRevision: 0 }), 'revision_conflict');
    assert.equal((await repo.read(p.id)).revision, 1);
    const entries = await paths(root); assert.deepEqual(entries.filter(item => !item.startsWith('.twdata/')), ['Notes/Новая заметка.md']);
    assert.ok(entries.some(item => item.includes('/history/'))); assert.ok(entries.some(item => item.includes('/journal/')));
    assert.ok(!entries.some(item => /\.tmp$/.test(item)));
    await repo.dispose(); const restarted = new ProjectRepository(root); try { await restarted.initialize(); assert.equal((await restarted.read(p.id)).nodes[0].id, nodeId); assert.equal((await restarted.execute(p.id, commands, { operationId, baseRevision: 0, effects })).revision, 1); } finally { await restarted.dispose(); }
  });
});

for (const faultPoint of ['after-journal', 'after-files', 'after-history', 'after-state'] as const) {
  test(`real filesystem recovery after ${faultPoint} finishes exactly once`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-fault-')); let shouldFail = true;
    const repo = new ProjectRepository(root, { fault(point: FaultPoint) { if (point === faultPoint && shouldFail) { shouldFail = false; throw new Error(`Injected failure ${point}`); } } });
    let restarted: ProjectRepository | null = null;
    try {
      await repo.initialize(); const p = await repo.add(project()), nodeId = randomUUID(), operationId = randomUUID(), body = 'Содержимое\n'; const commands = [note(nodeId, 'Notes/Новая заметка.md', body)], effects = [{ path: 'Notes/Новая заметка.md', before: null, after: body }];
      await assert.rejects(() => repo.execute(p.id, commands, { operationId, baseRevision: 0, effects }), new RegExp(`Injected failure ${faultPoint}`));
      await repo.dispose(); restarted = new ProjectRepository(root); await restarted.initialize();
      const recovered = await restarted.read(p.id); assert.equal(recovered.revision, 1); assert.equal(recovered.nodes.length, 1); assert.equal(recovered.receipts[operationId].revision, 1);
      assert.equal(await fs.readFile(path.join(root, effects[0].path), 'utf8'), body);
      assert.equal((await restarted.execute(p.id, commands, { operationId, baseRevision: 0, effects })).revision, 1);
      const history = await restarted.historyState(recovered); assert.deepEqual(history.undo, [operationId]);
      await restarted.recover(); assert.equal((await restarted.read(p.id)).revision, 1);
      const entries = await paths(root); assert.deepEqual(entries.filter(item => !item.startsWith('.twdata/')), ['Notes/Новая заметка.md']);
    } finally { await repo.dispose(); await restarted?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
}

test('recovery preserves external note edits and leaves failed journal available', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-conflict-')); const repo = new ProjectRepository(root, { fault(point) { if (point === 'after-files') throw new Error('Injected failure'); } }); let restarted: ProjectRepository | null = null;
  try {
    await repo.initialize(); const p = await repo.add(project()), operationId = randomUUID();
    await assert.rejects(() => repo.execute(p.id, [note(randomUUID(), 'Notes/Новая заметка.md', 'Операция')], { operationId, effects: [{ path: 'Notes/Новая заметка.md', before: null, after: 'Операция' }] }), /Injected failure/);
    await fs.writeFile(path.join(root, 'Notes/Новая заметка.md'), 'Внешняя правка'); await repo.dispose(); restarted = new ProjectRepository(root);
    await assert.rejects(() => restarted!.initialize(), error => error instanceof DomainError && ['note_conflict', 'recovery_conflict'].includes(error.code));
    assert.equal(await fs.readFile(path.join(root, 'Notes/Новая заметка.md'), 'utf8'), 'Внешняя правка'); assert.equal((await restarted.read(p.id)).revision, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, `.twdata/projects/${p.id}/journal/${operationId}.json`), 'utf8')).completed, false);
  } finally { await repo.dispose(); await restarted?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('stale external JSON blocks commit without erasing external state', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()); const original = await repo.read(p.id); const externallyEdited = { ...original, title: 'Внешнее изменение', revision: 1 };
    await fs.writeFile(path.join(root, repo.statePath(p.id)), stableJSON(externallyEdited));
    await rejectsCode(() => repo.execute(p.id, [note(randomUUID())], { baseRevision: 0 }), 'revision_conflict');
    assert.equal((await repo.read(p.id)).title, 'Внешнее изменение');
  });
});

test('invalid last command and note collisions cause zero journal/file mutations', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()); const before = await paths(root);
    await assert.rejects(() => repo.execute(p.id, [note(randomUUID()), { kind: 'project.update', changes: { title: '' } }], { effects: [{ path: 'Notes/Новая заметка.md', before: null, after: '' }] }), DomainError);
    assert.deepEqual(await paths(root), before); assert.equal((await repo.read(p.id)).revision, 0);
    await fs.mkdir(path.join(root, 'Notes')); await fs.writeFile(path.join(root, 'Notes/Новая заметка.md'), 'Чужое содержимое');
    await rejectsCode(() => repo.execute(p.id, [note(randomUUID())], { effects: [{ path: 'Notes/Новая заметка.md', before: null, after: '' }] }), 'note_conflict');
    assert.equal(await fs.readFile(path.join(root, 'Notes/Новая заметка.md'), 'utf8'), 'Чужое содержимое'); assert.equal((await repo.read(p.id)).revision, 0);
  });
});

test('single writer lock makes a second instance read-only until first release', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()); const second = new ProjectRepository(root);
    try { await second.initialize(); assert.equal(second.readOnly, true); assert.equal((await second.read(p.id)).id, p.id); await rejectsCode(() => second.add(project()), 'read_only'); }
    finally { await second.dispose(); }
    assert.equal((await repo.read(p.id)).id, p.id);
  });
});

test('undo/redo survives restart, moves metadata only, and never deletes originals or notes', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()); const noteId = randomUUID();
    const created = await repo.execute(p.id, [note(noteId)], { effects: [{ path: 'Notes/Новая заметка.md', before: null, after: '' }] });
    const changed = await repo.execute(p.id, [{ kind: 'node.update', nodeId: noteId, changes: { title: 'Изменено' } }]);
    const undone = await repo.undoRedo(changed, 'undo'); assert.equal(undone.nodes[0].title, 'Новая заметка'); assert.equal(undone.revision, 3);
    const redone = await repo.undoRedo(undone, 'redo'); assert.equal(redone.nodes[0].title, 'Изменено'); assert.equal(redone.revision, 4);
    const undoTitle = await repo.undoRedo(redone, 'undo'); const undoCreate = await repo.undoRedo(undoTitle, 'undo'); assert.equal(undoCreate.nodes.length, 0);
    assert.equal(await fs.readFile(path.join(root, 'Notes/Новая заметка.md'), 'utf8'), ''); assert.equal(created.revision, 1);
    const restored = await repo.undoRedo(undoCreate, 'redo'); assert.equal(restored.nodes[0].id, noteId);
    const restarted = new ProjectRepository(root); await repo.dispose(); try { await restarted.initialize(); assert.equal((await restarted.historyState(await restarted.read(p.id))).undo.length, 1); } finally { await restarted.dispose(); }
  });
});

test('view state is centralized and cannot alter project revision', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()); assert.deepEqual(await repo.loadView(p.id), {});
    await repo.saveView(p.id, { mode: 'dossier', selectedId: null, expandedNodeIds: [], collapsedGroupIds: [], viewport: { x: 50, y: -50, zoom: 0.5 } });
    assert.equal((await repo.loadView(p.id)).mode, 'dossier'); assert.equal((await repo.read(p.id)).revision, 0);
    assert.ok((await paths(root)).filter(item => !item.startsWith('.twdata/')).length === 0);
  });
});

test('new writes require recovery while an interrupted transaction remains unfinished', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-pending-')); let failed = false;
  const repo = new ProjectRepository(root, { fault(point) { if (!failed && point === 'after-journal') { failed = true; throw new Error('Injected failure'); } } });
  try {
    await repo.initialize(); const p = await repo.add(project());
    await assert.rejects(() => repo.execute(p.id, [note(randomUUID())]), /Injected failure/);
    await rejectsCode(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'После незавершённой записи' } }]), 'recovery_required');
    assert.equal((await repo.read(p.id)).revision, 0); await repo.recover(); assert.equal((await repo.read(p.id)).revision, 1);
    assert.equal((await repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'После восстановления' } }])).revision, 2);
  } finally { await repo.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

for (const corruption of ['technical-effect-path', 'state-digest'] as const) {
  test(`recovery refuses a corrupted journal before mutation: ${corruption}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-journal-invalid-')); const repo = new ProjectRepository(root, { fault(point) { if (point === 'after-journal') throw new Error('Injected failure'); } }); let restarted: ProjectRepository | null = null;
    try {
      await repo.initialize(); const p = await repo.add(project()), operationId = randomUUID();
      await assert.rejects(() => repo.execute(p.id, [note(randomUUID())], { operationId, effects: [{ path: 'Notes/Новая заметка.md', before: null, after: '' }] }), /Injected failure/);
      const journalPath = path.join(root, `.twdata/projects/${p.id}/journal/${operationId}.json`), journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      if (corruption === 'technical-effect-path') journal.effects[0].path = '_TraceWeave/forbidden.bin'; else journal.state.title = 'Подменённое состояние';
      await fs.writeFile(journalPath, JSON.stringify(journal)); await repo.dispose(); restarted = new ProjectRepository(root);
      await assert.rejects(() => restarted!.initialize(), DomainError);
      assert.equal((await restarted.read(p.id)).revision, 0); assert.ok(!(await fileExists(path.join(root, '_TraceWeave/forbidden.bin')))); assert.ok(!(await fileExists(path.join(root, 'Notes/Новая заметка.md'))));
    } finally { await repo.dispose(); await restarted?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
}
async function fileExists(filename: string): Promise<boolean> { try { await fs.stat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

test('transaction effects must belong to their project and match the committed note hash', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project());
    await assert.rejects(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Без привязки' } }], { effects: [{ path: 'Notes/Непривязанная.md', before: null, after: 'Текст' }] }), DomainError);
    assert.equal((await repo.read(p.id)).revision, 0); assert.ok(!(await fileExists(path.join(root, 'Notes/Непривязанная.md'))));
    await assert.rejects(() => repo.execute(p.id, [note(randomUUID(), 'Notes/Новая заметка.md', 'Другой текст')], { effects: [{ path: 'Notes/Новая заметка.md', before: null, after: 'Фактический текст' }] }), DomainError);
    assert.equal((await repo.read(p.id)).revision, 0); assert.ok(!(await fileExists(path.join(root, 'Notes/Новая заметка.md'))));
  });
});

test('malformed journal remains pending and blocks writes after initialization recovery errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-malformed-journal-')); const repo = new ProjectRepository(root, { fault(point) { if (point === 'after-journal') throw new Error('Injected failure'); } }); let restarted: ProjectRepository | null = null;
  try {
    await repo.initialize(); const p = await repo.add(project()), operationId = randomUUID(); await assert.rejects(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Interrupted' } }], { operationId }), /Injected failure/);
    const journalPath = path.join(root, `.twdata/projects/${p.id}/journal/${operationId}.json`); const valid = await fs.readFile(journalPath, 'utf8'); await fs.writeFile(journalPath, '{invalid'); await repo.dispose();
    restarted = new ProjectRepository(root); await assert.rejects(() => restarted!.initialize(), DomainError); assert.equal(restarted.needsRecovery, true);
    await rejectsCode(() => restarted!.execute(p.id, [{ kind: 'project.update', changes: { title: 'Must not commit' } }]), 'recovery_required'); assert.equal((await restarted.read(p.id)).revision, 0);
    await fs.writeFile(journalPath, valid); await restarted.recover(); assert.equal(restarted.needsRecovery, false); assert.equal((await restarted.read(p.id)).title, 'Interrupted');
  } finally { await repo.dispose(); await restarted?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid UTF-8 in notes and state is rejected without replacement characters or rewriting source', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()), invalidNote = Buffer.from([0x23, 0x20, 0xc3, 0x28]); await fs.mkdir(path.join(root, 'Notes')); await fs.writeFile(path.join(root, 'Notes/Invalid.md'), invalidNote);
    await assert.rejects(() => repo.readText('Notes/Invalid.md'), TypeError); assert.deepEqual(await fs.readFile(path.join(root, 'Notes/Invalid.md')), invalidNote);
    const invalidState = Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xff]), Buffer.from('"}')]); await fs.writeFile(path.join(root, repo.statePath(p.id)), invalidState);
    await assert.rejects(() => repo.read(p.id), TypeError); await assert.rejects(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Must not replace corrupt bytes' } }]), TypeError); assert.deepEqual(await fs.readFile(path.join(root, repo.statePath(p.id))), invalidState);
  });
});

test('a non-boolean journal completion marker cannot hide an unfinished operation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-completion-marker-')); const repo = new ProjectRepository(root, { fault(point) { if (point === 'after-journal') throw new Error('Injected failure'); } }); let restarted: ProjectRepository | null = null;
  try {
    await repo.initialize(); const p = await repo.add(project()), operationId = randomUUID(); await assert.rejects(() => repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Interrupted' } }], { operationId }), /Injected failure/);
    const filename = path.join(root, `.twdata/projects/${p.id}/journal/${operationId}.json`), journal = JSON.parse(await fs.readFile(filename, 'utf8')); journal.completed = 'false'; await fs.writeFile(filename, JSON.stringify(journal)); await repo.dispose();
    restarted = new ProjectRepository(root); await assert.rejects(() => restarted!.initialize(), DomainError); assert.equal(restarted.needsRecovery, true);
    await rejectsCode(() => restarted!.execute(p.id, [{ kind: 'project.update', changes: { title: 'Must stay blocked' } }]), 'recovery_required'); assert.equal((await restarted.read(p.id)).revision, 0);
  } finally { await repo.dispose(); await restarted?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('unknown history fields are rejected before undo without changing project or history files', async () => {
  await withRepository(async (repo, root) => {
    const p = await repo.add(project()), operationId = randomUUID(), changed = await repo.execute(p.id, [{ kind: 'project.update', changes: { title: 'Committed' } }], { operationId });
    const filename = path.join(root, `.twdata/projects/${p.id}/history/${operationId}.json`), record = JSON.parse(await fs.readFile(filename, 'utf8')); record.unexpected = 'must not discard'; const text = JSON.stringify(record); await fs.writeFile(filename, text);
    await rejectsCode(() => repo.historyState(changed), 'history'); await rejectsCode(() => repo.undoRedo(changed, 'undo'), 'history');
    assert.equal((await repo.read(p.id)).revision, changed.revision); assert.equal((await repo.read(p.id)).title, 'Committed'); assert.equal(await fs.readFile(filename, 'utf8'), text);
  });
});

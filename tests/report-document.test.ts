import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from '../src/domain';
import { ProjectRepository, digest } from '../src/storage/repository';
import { createReport } from '../src/portability';
import { loadReportDocument, reportDocumentInfo } from '../src/report-document';

test('registered hidden report opens immutable text without creating a visible note or altering its source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-report-document-')), repository = new ProjectRepository(root);
  try {
    await repository.initialize(); const initial = await repository.add(createProject('Report test')), nodeId = randomUUID();
    const original = '---\ntags: [original]\n---\n\n# Captured text\n';
    const project = await repository.execute(initial.id, [{ kind: 'node.create', id: nodeId, title: 'Source', notePath: 'Folder/source.md', noteHash: digest(original) }], { effects: [{ path: 'Folder/source.md', before: null, after: original }] });
    const snapshot = await createReport(root, project, 'Saved report', [nodeId]);
    await repository.execute(initial.id, [{ kind: 'snapshot.register', snapshot }]);
    const relative = snapshot.path.replace(/snapshot\.json$/u, 'report.md'), before = await fs.readFile(path.join(root, relative));
    const loaded = await loadReportDocument(repository, relative);
    assert.equal(loaded.title, 'Saved report'); assert.equal(loaded.sourcePath, relative); assert.ok(loaded.text.includes('Captured text'));
    assert.deepEqual(await fs.readFile(path.join(root, relative)), before); assert.equal(await fs.readFile(path.join(root, 'Folder/source.md'), 'utf8'), original);
    assert.deepEqual((await fs.readdir(root)).filter(name => !name.startsWith('.')), ['Folder']);
    const readText = repository.readText.bind(repository);
    repository.readText = async (requested, maxBytes) => {
      if (requested === relative) await fs.appendFile(path.join(root, relative), 'Changed between verification and read');
      return readText(requested, maxBytes);
    };
    await assert.rejects(() => loadReportDocument(repository, relative), /изменился во время чтения/);
    repository.readText = readText; await fs.writeFile(path.join(root, relative), before);
    await fs.appendFile(path.join(root, relative), 'Tampered report'); await assert.rejects(() => loadReportDocument(repository, relative), /integrity|hash|changed|сним|контрол/iu);
  } finally { await repository.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('report reader rejects technical records, traversal and an unregistered snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-report-scope-')), repository = new ProjectRepository(root);
  try {
    await repository.initialize(); const project = await repository.add(createProject('Scope'));
    for (const relative of ['.twdata/settings.json', '.twdata/projects/a/state.json', '.twdata/../private.md', 'TWData/report.md']) {
      assert.equal(reportDocumentInfo(relative), null); await assert.rejects(() => loadReportDocument(repository, relative), /только Markdown/);
    }
    await assert.rejects(() => loadReportDocument(repository, `.twdata/projects/${project.id}/reports/${randomUUID()}/report.md`), /отсутствует/);
  } finally { await repository.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('registered visible snapshots retain the immutable reader after source edits and reject tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-visible-report-reader-')), repository = new ProjectRepository(root);
  try {
    await repository.initialize(); const initial = await repository.add(createProject('Visible research')), nodeId = randomUUID(), source = 'Notes/Source.md', original = '# Captured ordinary note\n\n[[Other]]\n';
    const project = await repository.execute(initial.id, [{ kind: 'node.create', id: nodeId, title: 'Source', notePath: source, noteHash: digest(original) }], { effects: [{ path: source, before: null, after: original }] });
    await repository.add(createProject('Another research'));
    for (const parent of ['TWData/exports/Visible research', 'Custom/Research data/exports/Visible research (2)']) {
      const snapshot = await createReport(root, project, 'Visible saved snapshot', [nodeId], '.twdata', parent);
      await repository.execute(initial.id, [{ kind: 'snapshot.register', snapshot }]);
      const relative = snapshot.path.replace(/snapshot\.json$/u, 'report.md'), info = reportDocumentInfo(relative);
      assert.deepEqual(info, { directory: snapshot.path.replace(/\/snapshot\.json$/u, ''), projectId: null, snapshotId: snapshot.id });
      const before = await fs.readFile(path.join(root, relative));
      await fs.writeFile(path.join(root, source), 'Later source edits must not change the saved snapshot');
      const revision = (await repository.read(initial.id)).revision, loaded = await loadReportDocument(repository, relative);
      assert.equal(loaded.title, 'Visible saved snapshot'); assert.equal(loaded.sourcePath, relative); assert.match(loaded.text, /Captured ordinary note/);
      assert.doesNotMatch(loaded.text, /Later source edits/); assert.deepEqual(await fs.readFile(path.join(root, relative)), before);
      assert.equal((await repository.read(initial.id)).revision, revision, 'reading a snapshot must not mutate the graph');
      const copied = `${parent}/Unregistered/snapshots/${snapshot.id}`;
      await fs.cp(path.join(root, info!.directory), path.join(root, copied), { recursive: true, errorOnExist: true });
      await assert.rejects(loadReportDocument(repository, `${copied}/report.md`), /отсутствует/u, 'the same snapshot ID in another folder must not bypass exact registration');
      await fs.appendFile(path.join(root, relative), 'Tampered visible snapshot');
      await assert.rejects(loadReportDocument(repository, relative), /integrity|hash|changed|сним|контрол/iu);
      await fs.writeFile(path.join(root, relative), before);
      await fs.writeFile(path.join(root, source), original);
    }
  } finally { await repository.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('visible snapshot reader requires exact registration and rejects unsafe or configuration paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-visible-report-scope-')), repository = new ProjectRepository(root, { configDir: 'Settings' });
  try {
    await repository.initialize(); await repository.add(createProject('Scope')); const id = randomUUID();
    for (const relative of [`../exports/Research/snapshots/${id}/report.md`, `/absolute/exports/Research/snapshots/${id}/report.md`, `TWData/exports/.hidden/snapshots/${id}/report.md`, `TWData/projects/${id}/history/exports/Research/snapshots/${id}/report.md`, `TWData/exports/Research/snapshots/not-a-uuid/report.md`, `TWData/exports/Research/snapshots/${id}/snapshot.json`, 'TWData/exports/Research/summary.md']) {
      assert.equal(reportDocumentInfo(relative), null, relative); await assert.rejects(loadReportDocument(repository, relative), /только Markdown/u);
    }
    await assert.rejects(loadReportDocument(repository, `TWData/exports/Research/snapshots/${id}/report.md`), /отсутствует/u);
    await assert.rejects(loadReportDocument(repository, `Settings/exports/Research/snapshots/${id}/report.md`), /Unsafe relative path/u);
  } finally { await repository.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

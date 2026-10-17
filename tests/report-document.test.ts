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

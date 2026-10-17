import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyCommands, createProject, DomainError, validateProject, validateRelativePath } from '../src/domain';
import { getLocale, setLocale } from '../src/i18n';
import { createReport } from '../src/portability';
import { loadReportDocument } from '../src/report-document';
import { ProjectRepository, digest, strictJSON } from '../src/storage/repository';
import { validateRecord } from '../src/storage/records';
import { VaultLinks } from '../src/vault-links';

afterEach(() => setLocale('ru'));

test('domain messages follow the locale while error codes and stored type names remain unchanged', () => {
  assert.equal(getLocale(), 'ru');
  const project = createProject('Моё исследование');
  const before = JSON.stringify(project);
  assert.throws(() => applyCommands(project, []), (error: unknown) => error instanceof DomainError && error.code === 'validation_failed' && error.message === 'Пакет должен содержать 1–200 команд.');

  setLocale('en');
  assert.throws(() => applyCommands(project, []), (error: unknown) => error instanceof DomainError && error.code === 'validation_failed' && error.message === 'A batch must contain 1–200 commands.');
  assert.throws(() => validateRelativePath('../outside.md'), (error: unknown) => error instanceof DomainError && error.code === 'unsafe_path' && error.message === 'path: unsafe path component.');
  const missingId = randomUUID();
  assert.throws(() => applyCommands(project, [{ kind: 'node.update', nodeId: missingId, changes: { title: 'User content' } }]), (error: unknown) => error instanceof DomainError && error.code === 'node_not_found' && error.message === `Node ${missingId} is missing or in the trash.`);
  validateProject(project);
  assert.equal(JSON.stringify(project), before);
  assert.equal(createProject('English title').nodeTypes.find(type => type.code === 'note')!.name, 'Заметка');
});

test('JSON recovery diagnostics use English without changing schema or error codes', () => {
  setLocale('en');
  assert.throws(() => strictJSON('{"same": 1, "same": 2}'), (error: unknown) => error instanceof DomainError && error.code === 'invalid_json' && error.message === 'Duplicate JSON object key.');
  assert.throws(() => validateRecord('journal', {}), (error: unknown) => error instanceof DomainError && error.code === 'journal' && error.message.startsWith('Invalid journal record:') && error.message.endsWith('The original file was preserved.'));
  setLocale('ru');
  assert.throws(() => strictJSON('{"same": 1, "same": 2}'), /Повторяющийся ключ JSON/);
});

test('unavailable vault links are localized and never invoke open or reveal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-i18n-links-'));
  let opened = false;
  const links = new VaultLinks(root, { find: () => null, resourceUrl: () => '', open: async () => { opened = true; }, reveal: async () => { opened = true; } });
  try {
    setLocale('en');
    await assert.rejects(() => links.open('Folder/source.md', 'https://example.com/private.md'), { message: 'The link does not point to an available file in this vault.' });
    setLocale('ru');
    await assert.rejects(() => links.open('Folder/source.md', 'https://example.com/private.md'), { message: 'Ссылка не указывает на доступный файл этого хранилища.' });
    assert.equal(opened, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('new reports use the selected language and saved report bytes survive locale changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-i18n-report-'));
  const repository = new ProjectRepository(root);
  try {
    await repository.initialize();
    const initial = await repository.add(createProject('User research'));
    const nodeId = randomUUID(), text = '# Исходная заметка\n\nUser-written text stays unchanged.\n';
    let project = await repository.execute(initial.id, [{ kind: 'node.create', id: nodeId, title: 'Пользовательское название', notePath: 'Notes/source.md', noteHash: digest(text) }], { effects: [{ path: 'Notes/source.md', before: null, after: text }] });

    setLocale('en');
    const english = await createReport(root, project, 'Evidence report');
    project = await repository.execute(project.id, [{ kind: 'snapshot.register', snapshot: english }]);
    const relative = english.path.replace(/snapshot\.json$/u, 'report.md');
    const before = await fs.readFile(path.join(root, relative));
    assert.match(before.toString('utf8'), /Captured: .* · revision 1/u);
    assert.ok(before.toString('utf8').includes('## Пользовательское название'));
    assert.ok(before.toString('utf8').includes(text));

    setLocale('ru');
    const reopened = await loadReportDocument(repository, relative);
    assert.equal(reopened.text, before.toString('utf8'));
    assert.deepEqual(await fs.readFile(path.join(root, relative)), before);
    const russian = await createReport(root, project, 'Новый отчёт');
    const russianMarkdown = await fs.readFile(path.join(root, russian.path.replace(/snapshot\.json$/u, 'report.md')), 'utf8');
    assert.match(russianMarkdown, /Снимок: .* · ревизия 2/u);
    assert.equal(await fs.readFile(path.join(root, 'Notes/source.md'), 'utf8'), text);
    await assert.rejects(() => loadReportDocument(repository, '.twdata/settings.json'), /Можно открыть только Markdown/);
    setLocale('en');
    await assert.rejects(() => loadReportDocument(repository, '.twdata/settings.json'), { message: 'Only Markdown from a registered TraceWeave snapshot can be opened.' });
  } finally { await repository.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

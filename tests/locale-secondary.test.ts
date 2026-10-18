import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { getLocale, localeCode, setLocale } from '../src/i18n';
import { LocalWorkbench, type Host } from '../src/service';
import { ProjectRepository } from '../src/storage/repository';
import { VaultNotePicker } from '../src/ui/VaultNotePicker';
import { SafeMarkdown } from '../src/ui/markdown';
import { mountReportPreview } from '../src/ui/report';
import { MetadataDraftStore } from '../src/ui/drafts';
import type { VaultLink, WorkbenchService } from '../src/types';

function useLocale(t: TestContext, language: 'ru' | 'en') {
  const previous = getLocale(); setLocale(language); t.after(() => setLocale(previous));
}

for (const language of ['en', 'ru'] as const) {
  const english = language === 'en';

  test(`${language}: vault picker localizes controls and sorts without changing user note names or paths`, t => {
    useLocale(t, language);
    const notes = [
      { title: 'Ёлка — исходное имя', path: 'Заметки/Ёлка.md' },
      { title: 'Alpha', path: 'Notes/Alpha.md' },
      { title: 'Якорь', path: 'Заметки/Якорь.md' },
    ];
    const html = renderToStaticMarkup(React.createElement(VaultNotePicker, { notes, value: notes[0]!.path, onChange: () => {} }));
    assert.ok(html.includes(english ? 'Find notes by name or path' : 'Поиск заметок по имени или пути'));
    assert.ok(html.includes(english ? 'Any folder in this vault' : 'Любая папка этого vault'));
    assert.ok(html.includes(english ? 'Selected note:' : 'Выбрана заметка:'));
    for (const note of notes) { assert.ok(html.includes(note.title)); assert.ok(html.includes(note.path)); }
    const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path, localeCode()));
    const positions = sorted.map(note => html.indexOf(`<strong>${note.title}</strong>`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    const unavailable = renderToStaticMarkup(React.createElement(VaultNotePicker, { notes: [], value: 'Missing.md', onChange: () => {} }));
    assert.ok(unavailable.includes(english ? 'No Markdown notes are available to link.' : 'Нет доступных Markdown-заметок для подключения.'));
    assert.ok(unavailable.includes(english ? 'File is currently unavailable' : 'Файл сейчас недоступен'));
  });

  test(`${language}: safe Markdown translates its fallback while preserving user text and blocking image requests`, t => {
    useLocale(t, language);
    const html = renderToStaticMarkup(React.createElement(SafeMarkdown, { text: '# Пользовательский текст\n\n![Мой снимок](https://tracker.invalid/pixel.png)' }));
    assert.ok(html.includes('Пользовательский текст')); assert.ok(html.includes('Мой снимок'));
    assert.ok(html.includes(english ? 'open the note in Obsidian' : 'откройте заметку в Obsidian'));
    assert.doesNotMatch(html, /<img|src=|tracker\.invalid/);
  });

  test(`${language}: report and vault embeds translate chrome, keep snapshot text, and open only requested originals`, async t => {
    useLocale(t, language);
    const window = new Window({ url: 'http://traceweave-locale.test' }), document = window.document;
    const globals: Record<string, unknown> = { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const container = document.createElement('div'); document.body.append(container);
    let cleanup: (() => void) | undefined;
    t.after(async () => {
      await act(async () => cleanup?.()); await window.happyDOM.abort();
      for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    });
    const opened: string[] = [], resolved: string[] = [];
    const targets: Record<string, VaultLink> = {
      'report.pdf': { path: 'Shared/report.pdf', title: 'Исходный PDF', resourceUrl: 'app://vault/report.pdf', mimeType: 'application/pdf', mediaKind: 'file', byteSize: 128, isNote: false, openMode: 'native' },
      'original.bin': { path: 'Shared/original.bin', title: 'Исходный бинарный файл', resourceUrl: 'app://vault/original.bin', mimeType: 'application/octet-stream', mediaKind: 'file', byteSize: 64, isNote: false, openMode: 'reveal' },
    };
    const service = {
      resolveVaultLink: async (_source: string, link: string) => { resolved.push(link); return targets[link] ?? null; },
      openVaultLink: async (_source: string, link: string) => { opened.push(link); },
    } as unknown as WorkbenchService;
    await act(async () => {
      cleanup = mountReportPreview(container as unknown as HTMLElement, { title: 'Мой снимок', sourcePath: '.twdata/report.md', text: '# Сохранённый текст\n\n![[report.pdf|Скан]]\n\n![[original.bin|Архивный оригинал]]\n\n![Внешний](https://tracker.invalid/pixel.png)', service });
    });
    assert.equal(container.querySelector('main')?.getAttribute('aria-label'), english ? 'Report: Мой снимок' : 'Отчёт: Мой снимок');
    assert.equal(container.querySelector('.tw-eyebrow')?.textContent, english ? 'TRACEWEAVE · REPORT' : 'TRACEWEAVE · ОТЧЁТ');
    assert.ok(container.textContent?.includes(english ? 'read only' : 'только чтение'));
    assert.ok(container.textContent?.includes('Сохранённый текст'));
    assert.ok(container.textContent?.includes(english ? 'external loading is disabled' : 'внешняя загрузка отключена'));
    assert.ok(container.textContent?.includes(english ? 'Inline preview is not available' : 'встроенный просмотр недоступен'));
    const buttons = [...container.querySelectorAll('button')];
    const pdf = buttons.find(button => button.textContent === (english ? 'Open PDF: Скан' : 'Открыть PDF: Скан'));
    const binary = buttons.find(button => button.textContent === (english ? 'Show file: Архивный оригинал' : 'Показать файл: Архивный оригинал'));
    assert.ok(pdf && binary);
    await act(async () => { pdf.click(); binary.click(); });
    assert.deepEqual(opened, ['report.pdf', 'original.bin']);
    assert.deepEqual(resolved, ['report.pdf', 'original.bin']);
    assert.equal(container.querySelector('form,input,textarea,select,img,iframe,object'), null);
  });

  test(`${language}: service localizes notifications and errors without translating managed paths or user titles`, async t => {
    useLocale(t, language);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-locale-'));
    const host: Host = { listNotes: () => [], createNote: async title => { const relative = `Notes/${title}.md`; await fs.mkdir(path.join(root, 'Notes'), { recursive: true }); await fs.writeFile(path.join(root, relative), '', { flag: 'wx' }); return relative; }, openNote: async () => {}, showFile: async () => {}, resourceUrl: relative => `app://vault/${relative}`, filePath: async () => { throw new Error('No uploads in this fixture'); } };
    const service = new LocalWorkbench(new ProjectRepository(root), host);
    t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    await service.initialize();
    await assert.rejects(service.readNote('missing'), error => error instanceof Error && error.message === (english ? 'Open a research project first.' : 'Сначала откройте исследование.'));
    await service.createProject('Моё исследование');
    assert.equal(service.getSnapshot().project?.title, 'Моё исследование');
    assert.equal(service.getSnapshot().message, english ? 'Research project created. Notes remain ordinary Markdown files.' : 'Исследование создано. Заметки остаются обычными Markdown-файлами.');
    const id = await service.createNote('Моя заметка'), note = service.getSnapshot().project!.nodes.find(node => node.id === id)!;
    assert.equal(note.title, 'Моя заметка'); assert.equal(note.notePath, 'Notes/Моя заметка.md');
    assert.equal(service.getSnapshot().message, english ? 'Note created. Edit its text in the native editor.' : 'Заметка создана. Текст редактируется в штатном редакторе.');
    await assert.rejects(service.openNote('missing'), error => error instanceof Error && error.message === (english ? 'Document not found.' : 'Документ не найден.'));
    await assert.rejects(service.execute([{ kind: 'node.update', nodeId: 'missing', changes: { title: 'Rejected' } }]));
    const before = service.getSnapshot(); assert.ok(before.error);
    service.refreshLanguage();
    assert.deepEqual(service.getSnapshot(), { ...before, message: '' });
    assert.equal(service.getSnapshot().project, before.project);
    assert.equal((await service.repository.read(before.project!.id)).revision, before.project!.revision);
  });

  test(`${language}: invalid persisted drafts expose localized errors without accepting foreign project data`, async t => {
    useLocale(t, language);
    const store = new MetadataDraftStore();
    await assert.rejects(store.hydrate({ loadDrafts: async () => ({ 'other/node/title': { format: 'traceweave.metadata-draft', value: 'Foreign title' } }), saveDraft: async () => {} }, 'project'), error => error instanceof Error && error.message === (english ? 'The draft belongs to another research project.' : 'Черновик относится к другому исследованию.'));
    assert.equal(store.has('other/node/title'), false);
    assert.equal(store.status('project').hydrated, false);
    assert.equal(store.status('project').error, english ? 'The draft belongs to another research project.' : 'Черновик относится к другому исследованию.');
  });
}

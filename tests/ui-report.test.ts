import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { Window } from 'happy-dom';
import { mountReportPreview } from '../src/ui/report';
import type { VaultLink, WorkbenchService } from '../src/types';

const sourcePath = '.twdata/projects/00000000-0000-4000-8000-000000000001/reports/00000000-0000-4000-8000-000000000002/report.md';
const file = (name: string, mimeType = 'application/octet-stream', mediaKind: VaultLink['mediaKind'] = 'file'): VaultLink => ({ path: `${sourcePath.slice(0, sourcePath.lastIndexOf('/'))}/files/${name}`, title: name, resourceUrl: `app://local/${encodeURIComponent(name)}`, mimeType, mediaKind, byteSize: 128, isNote: mediaKind === 'text', openMode: 'reveal' });

async function fixture(t: TestContext) {
  const window = new Window({ url: 'http://traceweave-report.test' }), document = window.document;
  const globals: Record<string, unknown> = { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const stylesheet = document.createElement('style'); stylesheet.textContent = await readFile(new URL('../styles.css', import.meta.url), 'utf8'); document.head.append(stylesheet);
  const container = document.createElement('div'); document.body.append(container);
  const targets = new Map<string, VaultLink>(), resolved: { source: string; link: string }[] = [], opened: { source: string; link: string }[] = [], forbidden: PropertyKey[] = [];
  const reader = {
    resolveVaultLink: async (source: string, link: string) => { resolved.push({ source, link }); return targets.get(link) ?? null; },
    openVaultLink: async (source: string, link: string) => { opened.push({ source, link }); },
  };
  const service = new Proxy(reader, { get(target, key, receiver) {
    if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
    forbidden.push(key); throw new Error(`Отчёт попытался обратиться к недоступному действию: ${String(key)}`);
  } }) as unknown as WorkbenchService;
  let cleanup: (() => void) | null = null;
  const mount = async (text: string) => { await act(async () => { cleanup = mountReportPreview(container as unknown as HTMLElement, { title: 'Снимок исследования', text, sourcePath, service }); }); };
  const dispose = async () => { await act(async () => { cleanup?.(); cleanup = null; }); };
  t.after(async () => { await dispose(); await window.happyDOM.abort(); for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  return { window, document, container, targets, resolved, opened, forbidden, mount, dispose };
}

test('hidden report renders its complete immutable Markdown as a bounded read-only preview', async (t) => {
  const ui = await fixture(t);
  ui.targets.set('files/picture.png', file('picture.png', 'image/png', 'image'));
  ui.targets.set('files/evidence.pdf', file('evidence.pdf', 'application/pdf'));
  ui.targets.set('files/opaque.bin', file('opaque.bin'));
  ui.targets.set('files/source.md', file('source.md', 'text/markdown', 'text'));
  ui.targets.set('/Shared/public.pdf', { ...file('public.pdf', 'application/pdf'), path: 'Shared/public.pdf', openMode: 'native' });
  const text = '---\nsnapshot-field: preserved\n---\n\n# Зафиксированные выводы\n\nТекст неизменяемого снимка.\n\n![[files/picture.png|Карта]]\n\n![[files/evidence.pdf|PDF снимка]]\n\n![[files/opaque.bin|Бинарный оригинал]]\n\n![[files/source.md|Текстовый оригинал]]\n\n![Обычный PDF](/Shared/public.pdf)\n\n![Внешняя картинка](https://tracker.invalid/pixel.png)\n\n<script>alert(1)</script>\n\n[Явный источник](https://example.org/source)\n\nПоследняя строка полного отчёта.';
  await ui.mount(text);
  assert.equal(ui.container.querySelector('.tw-report-heading h1')?.textContent, 'Снимок исследования');
  assert.match(ui.container.textContent!, /только чтение/);
  assert.match(ui.container.textContent!, /snapshot-field: preserved/);
  assert.match(ui.container.textContent!, /Последняя строка полного отчёта/);
  assert.equal(ui.container.querySelector('form,input,textarea,select,[contenteditable="true"]'), null);
  assert.equal(ui.container.querySelector('script,iframe,object,link[rel="preload"]'), null);
  assert.equal(ui.container.querySelectorAll('img').length, 1);
  assert.ok(ui.container.querySelector('img')!.getAttribute('src')!.startsWith('app://'));
  assert.ok(ui.resolved.every((entry) => entry.source === sourcePath));
  assert.equal(ui.resolved.some((entry) => entry.link.startsWith('https:')), false);
  const content = ui.container.querySelector('.tw-report-content')!;
  const contentStyle = ui.window.getComputedStyle(content);
  assert.equal(contentStyle.overflow, 'auto'); assert.equal(contentStyle.minHeight, '0');
  const buttons = [...ui.container.querySelectorAll('button')];
  const hiddenPDF = buttons.find((button) => button.textContent === 'Показать файл: PDF снимка');
  const binary = buttons.find((button) => button.textContent === 'Показать файл: Бинарный оригинал');
  const hiddenNote = buttons.find((button) => button.textContent === 'Показать файл: Текстовый оригинал');
  assert.ok(hiddenPDF && binary && hiddenNote);
  assert.ok(buttons.some((button) => button.textContent === 'Открыть PDF: Обычный PDF'));
  await act(async () => { hiddenPDF.click(); binary.click(); hiddenNote.click(); });
  assert.deepEqual(ui.opened, [{ source: sourcePath, link: 'files/evidence.pdf' }, { source: sourcePath, link: 'files/opaque.bin' }, { source: sourcePath, link: 'files/source.md' }]);
  assert.deepEqual(ui.forbidden, []);
  assert.ok(text.includes('snapshot-field: preserved')); // The rendering never transforms the captured source.
});

test('closing the report view stops every audio/video player and releases its source', async (t) => {
  const ui = await fixture(t);
  ui.targets.set('files/interview.mp3', file('interview.mp3', 'audio/mpeg', 'audio'));
  ui.targets.set('files/film.mp4', file('film.mp4', 'video/mp4', 'video'));
  await ui.mount('![[files/interview.mp3|Интервью]]\n\n![[files/film.mp4|Видео]]');
  const audio = ui.container.querySelector('audio'), video = ui.container.querySelector('video'); assert.ok(audio && video);
  let paused = 0, released = 0;
  for (const player of [audio, video]) {
    assert.equal(player.getAttribute('autoplay'), null); assert.equal(player.getAttribute('preload'), 'none');
    player.pause = () => { paused++; }; player.load = () => { released++; };
  }
  await ui.dispose();
  assert.equal(paused, 2); assert.equal(released, 2);
  assert.equal(audio.getAttribute('src'), null); assert.equal(video.getAttribute('src'), null);
  assert.equal(ui.container.childElementCount, 0); assert.deepEqual(ui.forbidden, []);
});

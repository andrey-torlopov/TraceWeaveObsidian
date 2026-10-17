import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act } from 'react';
import { readFile } from 'node:fs/promises';

test('mounted React Flow survives selection, metadata editing, host updates and draft recovery', async () => {
  const window = new Window({ url: 'http://traceweave.test' });
  const document = window.document;
  document.body.innerHTML = '<div id="workbench" style="width:1280px;height:900px"></div>';
  const stylesheet = document.createElement('style'); stylesheet.textContent = await readFile(new URL('../styles.css', import.meta.url), 'utf8'); document.head.append(stylesheet);
  const size = (element: { classList: { contains(value: string): boolean }; querySelector?(selector: string): { classList: { contains(value: string): boolean } } | null }): { width: number; height: number } => {
    if (element.classList.contains('react-flow__handle')) return { width: 9, height: 9 };
    const card = element.classList.contains('react-flow__node') ? element.querySelector?.('.tw-graph-card') : element.classList.contains('tw-graph-card') ? element : null;
    return card ? card.classList.contains('is-circle') ? { width: 64, height: 64 } : card.classList.contains('is-expanded') ? { width: 365, height: 448 } : { width: 245, height: 112 } : { width: 1280, height: 900 };
  };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get() { return size(this).width; } },
    offsetHeight: { configurable: true, get() { return size(this).height; } },
    clientWidth: { configurable: true, get() { return size(this).width; } },
    clientHeight: { configurable: true, get() { return size(this).height; } },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: function () { const { width, height } = size(this); return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() { return this; } }; } });
  class ResizeObserverMock {
    constructor(private readonly callback: (entries: { target: Element; contentRect: { width: number; height: number } }[]) => void) {}
    observe(target: Element) { this.callback([{ target, contentRect: size(target) }]); }
    unobserve() {} disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserverMock });
  const globals: Record<string, unknown> = { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement, MutationObserver: window.MutationObserver, ResizeObserver: ResizeObserverMock, DOMMatrixReadOnly: window.DOMMatrixReadOnly, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const messages: string[] = [], originalError = console.error;
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(' ')); };
  const button = (name: string) => {
    const result = [...document.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === name || element.textContent === name);
    assert.ok(result, `Кнопка «${name}» существует`); return result;
  };
  const harness = () => (window as unknown as globalThis.Window).twHarness;
  const titleInput = () => { const input = document.querySelector('form input'); assert.ok(input instanceof window.HTMLInputElement); return input; };
  const typeTitle = (value: string) => {
    const input = titleInput();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const control = (direction: 'zoomin' | 'zoomout') => { const element = document.querySelector(`.react-flow__controls-${direction}`); assert.ok(element instanceof window.HTMLButtonElement); return element; };
  const center = () => {
    const node = document.querySelector('.react-flow__node')!;
    const [x, y] = (node.getAttribute('style')!.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)?.slice(1).map(Number) ?? []);
    const dimensions = size(node);
    return { x: x + dimensions.width / 2, y: y + dimensions.height / 2 };
  };
  const assertAllInView = () => {
    const viewport = document.querySelector('.react-flow__viewport')!.getAttribute('style')!;
    const [, tx, ty, zoom] = viewport.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/)!.map(Number);
    for (const node of document.querySelectorAll('.react-flow__node')) {
      const [, x, y] = node.getAttribute('style')!.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)!.map(Number);
      const dimensions = size(node), left = x * zoom + tx, top = y * zoom + ty;
      assert.ok(left >= -.01 && top >= -.01 && left + dimensions.width * zoom <= 1280.01 && top + dimensions.height * zoom <= 900.01, `Узел находится внутри viewport: ${JSON.stringify({ left, top, dimensions, zoom })}`);
    }
  };
  try {
    await act(async () => { await import('./ui-mounted-entry'); });
    await act(async () => { await window.happyDOM.waitUntilComplete(); });
    assert.equal(document.querySelectorAll('.tw-graph-card').length, 2);
    assertAllInView();
    const reportRevision = harness().state().project!.revision;
    await act(async () => { button('Экспорт отчёта').click(); });
    assert.deepEqual(harness().readableReports, [harness().state().project!.id]);
    assert.equal(harness().state().project!.revision, reportRevision);
    assert.ok(document.body.textContent!.includes('Отчёт сохранён: UI smoke/summary.md'));
    await act(async () => { button('Скрыть сообщение').click(); });
    const originalPositions = harness().state().project!.nodes.map(({ id, x, y }) => ({ id, x, y }));
    const originalRevision = harness().state().project!.revision;
    await act(async () => { button('Читать').click(); });
    assert.ok(document.querySelector('.tw-graph-card.is-expanded'));
    const cardStyle = window.getComputedStyle(document.querySelector('.tw-graph-card.is-expanded')!);
    assert.equal(cardStyle.width, '365px'); assert.equal(cardStyle.height, '448px');
    const expandedCenter = center();
    for (let attempt = 0; attempt < 16 && !document.querySelector('.tw-graph-card.is-circle'); attempt++) await act(async () => { control('zoomout').click(); await window.happyDOM.waitUntilComplete(); });
    assert.equal(document.querySelectorAll('.tw-graph-card.is-circle').length, 2);
    assert.deepEqual(center(), expandedCenter);
    assert.equal(document.querySelector('.tw-card-body'), null);
    await act(async () => { button('Показать всё').click(); await window.happyDOM.waitUntilComplete(); });
    await act(async () => { await window.happyDOM.waitUntilComplete(); });
    assert.ok(document.querySelector('.tw-graph-card.is-expanded .tw-card-body'));
    assertAllInView();
    assert.deepEqual(center(), expandedCenter);
    for (let attempt = 0; attempt < 16 && !document.querySelector('.tw-graph-card.is-circle'); attempt++) await act(async () => { control('zoomout').click(); await window.happyDOM.waitUntilComplete(); });
    assert.equal(document.querySelectorAll('.tw-graph-card.is-circle').length, 2);
    await act(async () => { button('Показать весь граф').click(); await window.happyDOM.waitUntilComplete(); });
    await act(async () => { await window.happyDOM.waitUntilComplete(); });
    assert.ok(document.querySelector('.tw-graph-card.is-expanded .tw-card-body')); assertAllInView();
    assert.deepEqual(harness().state().project!.nodes.map(({ id, x, y }) => ({ id, x, y })), originalPositions);
    assert.equal(harness().state().project!.revision, originalRevision);
    assert.equal(harness().commands.filter((command) => command.kind === 'nodes.move').length, 0);
    assert.equal(document.querySelectorAll('.tw-edge-label').length, 1);
    assert.equal(document.querySelector('.tw-edge-label')!.textContent, 'Проверяемая связь');
    assert.equal(document.querySelectorAll('.react-flow__edge-path[style*="stroke-dasharray"]').length, 1);
    assert.equal(document.body.textContent!.includes('legacy-hidden-kind'), false);
    await act(async () => { button('Редактировать Первый').click(); });
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(document.querySelectorAll('.tw-graph-card').length, 2);
    await act(async () => { for (let index = 0; index < 8; index++) harness().pulse(); });
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => { typeTitle('Изменённый первый'); });
    await act(async () => { await harness().flush(); });
    assert.ok(Object.keys(harness().drafts).some((key) => key.endsWith('/title')));
    await act(async () => { button('Отмена').click(); });
    assert.ok(document.querySelector('[role="alertdialog"]'));
    await act(async () => { button('Продолжить редактирование').click(); });
    assert.equal(titleInput().value, 'Изменённый первый');
    await act(async () => { button('Сохранить метаданные').click(); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(harness().state().project!.nodes[0].title, 'Изменённый первый');
    await act(async () => { (document.querySelector('.react-flow__node')! as unknown as { click(): void }).click(); });
    await act(async () => { button('Редактировать Изменённый первый').click(); });
    await act(async () => { typeTitle('Черновик после перезапуска'); });
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => { await harness().flush(); harness().restart(); });
    assert.equal(document.querySelectorAll('.tw-graph-card').length, 2);
    await act(async () => { button('Редактировать Изменённый первый').click(); });
    assert.equal(titleInput().value, 'Черновик после перезапуска');
    assert.equal(harness().state().project!.nodes[0].title, 'Изменённый первый');
    await act(async () => { button('Отмена').click(); });
    await act(async () => { button('Отбросить изменения').click(); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const legacyEdge = document.querySelector('g.react-flow__edge[data-id="00000000-0000-4000-8000-00000000001e"]');
    assert.ok(legacyEdge);
    await act(async () => { legacyEdge.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await act(async () => { button('Изменить связь').click(); });
    assert.equal(document.body.textContent!.includes('Тип отношения'), false);
    assert.equal(document.body.textContent!.includes('legacy-hidden-kind'), false);
    await act(async () => { typeTitle('Явная подпись'); });
    await act(async () => { button('Сохранить связь').click(); });
    assert.equal(harness().state().project!.relations[0].relationType, 'legacy-hidden-kind');
    assert.equal(harness().state().project!.relations[0].label, 'Явная подпись');
    await act(async () => { (document.querySelector('.react-flow__node')! as unknown as { click(): void }).click(); });
    await act(async () => { button('+ Связь').click(); });
    assert.equal(document.body.textContent!.includes('Тип отношения'), false);
    await act(async () => { button('Сохранить связь').click(); });
    assert.equal(harness().state().project!.relations.at(-1)!.relationType, 'related');
    assert.equal(harness().state().project!.relations.at(-1)!.label, null);
    await act(async () => { button('Подключить заметку из vault').click(); });
    assert.ok(document.querySelector('[role="dialog"][aria-label="Подключить заметку из vault"]'));
    const search = document.querySelector('.tw-vault-note-picker input');
    assert.ok(search instanceof window.HTMLInputElement);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'Another folder/Places');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('[role="option"]').length, 1);
    assert.match(document.querySelector('[role="option"]')!.textContent!, /Another folder\/Places\/Map.md/);
    await act(async () => { (document.querySelector('[role="option"]')! as unknown as { click(): void }).click(); });
    await act(async () => { button('Подключить').click(); });
    assert.deepEqual(harness().adopted, ['Another folder/Places/Map.md']);
    const threeNodeRevision = harness().state().project!.revision;
    await act(async () => { button('Показать всё').click(); await window.happyDOM.waitUntilComplete(); });
    await act(async () => { await window.happyDOM.waitUntilComplete(); });
    assert.equal(document.querySelectorAll('.tw-graph-card').length, 3); assertAllInView();
    assert.equal(harness().state().project!.revision, threeNodeRevision);
    await act(async () => { button('Группа').click(); });
    await act(async () => { typeTitle('Тестовая группа'); });
    await act(async () => { button('Создать').click(); });
    assert.equal(document.querySelectorAll('.tw-graph-card').length, 4);
    await act(async () => { button('Свернуть группу (1)').click(); });
    assert.equal(document.querySelectorAll('.tw-graph-card').length, 3);
    assert.equal(document.querySelectorAll('.react-flow__edge-path').length, 3);
    assert.equal(document.querySelectorAll('.react-flow__edge-path[style*="stroke-dasharray"]').length, 1);
    const hypothesis = document.querySelector('.react-flow__edge-path[style*="stroke-dasharray"]')!;
    assert.ok(hypothesis.hasAttribute('marker-start') && hypothesis.hasAttribute('marker-end'));
    assert.deepEqual(messages.filter((message) => /Maximum update depth|same key|React error #185|not wrapped in act/.test(message)), []);
  } finally {
    console.error = originalError;
    await act(async () => { await harness()?.flush(); harness()?.stop(); });
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

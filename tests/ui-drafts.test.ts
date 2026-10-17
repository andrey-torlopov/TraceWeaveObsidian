import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataDraftStore, metadataDrafts } from '../src/ui/drafts';

test('metadata drafts are shared between leaves of the same host service', () => {
  const service = {};
  const first = metadataDrafts(service), reopenedLeaf = metadataDrafts(service);
  first.set('project/node/one/title', 'Несохранённое название');
  first.set('project/node/one/attributes', [{ key: 'Новая дата', value: null }]);
  assert.equal(reopenedLeaf.get('project/node/one/title'), 'Несохранённое название');
  assert.deepEqual(reopenedLeaf.get('project/node/one/attributes'), [{ key: 'Новая дата', value: null }]);
});

test('vaults and project/entity draft scopes stay independent', () => {
  const first = metadataDrafts({}), otherVault = metadataDrafts({});
  first.set('project/node/one/title', 'Документ');
  first.set('project/node/one-more/title', 'Другой документ');
  first.set('other-project/node/one/title', 'Другое исследование');
  first.clearPrefix('project/node/one');
  assert.equal(first.hasPrefix('project/node/one'), false);
  assert.equal(first.get('project/node/one-more/title'), 'Другой документ');
  assert.equal(first.get('other-project/node/one/title'), 'Другое исследование');
  assert.equal(otherVault.hasPrefix('project'), false);
});

test('unknown values and explicit false/empty values are retained in metadata drafts', () => {
  const store = new MetadataDraftStore();
  store.set('confidence', null); store.set('boolean', false); store.set('text', '');
  assert.equal(store.has('confidence'), true);
  assert.equal(store.get('confidence'), null);
  assert.equal(store.get('boolean'), false);
  assert.equal(store.get('text'), '');
});

test('successful save/discard clears only that form and not other open edits', () => {
  const store = new MetadataDraftStore(); let events = 0;
  const unsubscribe = store.subscribe(() => { events++; });
  store.set('p/node/a/title', 'A'); store.set('p/node/a/evidence', []); store.set('p/node/b/title', 'B');
  store.clearPrefix('p/node/a');
  assert.equal(store.hasPrefix('p/node/a'), false);
  assert.equal(store.get('p/node/b/title'), 'B');
  assert.ok(events > 0); const eventsBeforeUnsubscribe = events;
  unsubscribe(); store.set('p/node/b/title', 'B2');
  assert.equal(events, eventsBeforeUnsubscribe);
});

test('durable drafts round trip null values and recover without overwriting canonical fields', async () => {
  const records: Record<string, unknown> = {};
  const host = { loadDrafts: async () => ({ ...records }), saveDraft: async (key: string, value: unknown | null) => { if (value === null) delete records[key]; else records[key] = value; } };
  const original = new MetadataDraftStore(); await original.hydrate(host, 'p');
  original.set('p/node/a/title', 'Черновик'); original.set('p/node/a/confidence', null);
  assert.equal(Object.keys(records).length, 0);
  await original.flush();
  assert.equal(original.status('p').saved, true);
  const restarted = new MetadataDraftStore(); await restarted.hydrate(host, 'p');
  assert.equal(restarted.get('p/node/a/title'), 'Черновик');
  assert.equal(restarted.has('p/node/a/confidence'), true);
  assert.equal(restarted.get('p/node/a/confidence'), null);
  assert.equal(restarted.hasRestoredPrefix('p/node/a'), true);
  restarted.clearPrefix('p/node/a'); await restarted.flush();
  assert.deepEqual(records, {});
});

test('slow hydration never overwrites newly typed fields or resurrects an explicitly discarded form', async () => {
  let resolveLoad!: (value: Record<string, unknown>) => void;
  const persisted: Record<string, unknown> = {};
  const host = { loadDrafts: () => new Promise<Record<string, unknown>>(resolve => { resolveLoad = resolve; }), saveDraft: async (key: string, value: unknown | null) => { if (value === null) delete persisted[key]; else persisted[key] = value; } };
  const store = new MetadataDraftStore(), loading = store.hydrate(host, 'p');
  store.set('p/node/a/title', 'Новый ввод'); store.clearPrefix('p/node/b');
  resolveLoad({ 'p/node/a/title': { format: 'traceweave.metadata-draft', value: 'Старый ввод' }, 'p/node/b/evidence': { format: 'traceweave.metadata-draft', value: ['Старый источник'] } });
  await loading; await store.flush();
  assert.equal(store.get('p/node/a/title'), 'Новый ввод');
  assert.equal(store.hasPrefix('p/node/b'), false);
  assert.equal(Object.hasOwn(persisted, 'p/node/b/evidence'), false);
});

test('failed persistence keeps draft values and exposes exact error until retry succeeds', async () => {
  let fail = true;
  const saved: Record<string, unknown> = {};
  const host = { loadDrafts: async () => ({}), saveDraft: async (key: string, value: unknown) => { if (fail) throw new Error('Лимит черновиков 5 МиБ'); saved[key] = value; } };
  const store = new MetadataDraftStore(); await store.hydrate(host, 'p');
  store.set('p/node/a/attributes', [{ key: 'Важное', value: 'Данные' }]);
  await assert.rejects(store.flush(), /5 МиБ/);
  assert.equal(store.status('p').error, 'Лимит черновиков 5 МиБ');
  assert.deepEqual(store.get('p/node/a/attributes'), [{ key: 'Важное', value: 'Данные' }]);
  fail = false; await store.flush();
  assert.equal(store.status('p').error, null); assert.equal(store.status('p').pending, 0);
  assert.ok(saved['p/node/a/attributes']);
});

test('coalesced field updates persist latest values while failed project does not block another scope', async () => {
  const writes: [string, unknown][] = [];
  const host = { loadDrafts: async () => ({}), saveDraft: async (key: string, value: unknown) => { if (key.startsWith('failed/')) throw new Error('Диск недоступен'); writes.push([key, value]); } };
  const store = new MetadataDraftStore(); await store.hydrate(host, 'p');
  store.set('p/node/a/title', 'Первая'); store.set('p/node/a/title', 'Последняя');
  store.set('failed/node/b/title', 'Сохранить после подключения диска');
  await assert.rejects(store.flush(), /Диск недоступен/);
  assert.deepEqual(writes, [['p/node/a/title', { format: 'traceweave.metadata-draft', value: 'Последняя' }]]);
  assert.equal(store.status('p').saved, true);
  assert.equal(store.status('failed').pending, 1);
});

test('new edits made while a write is pending are saved after the earlier version', async () => {
  let release!: () => void; const writes: unknown[] = []; let first = true;
  const host = { loadDrafts: async () => ({}), saveDraft: async (_key: string, value: unknown) => { writes.push(value); if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } } };
  const store = new MetadataDraftStore(); await store.hydrate(host, 'p');
  store.set('p/node/a/title', 'До записи'); const saving = store.flush();
  store.set('p/node/a/title', 'Во время записи'); release(); await saving; await store.flush();
  assert.deepEqual(writes, [{ format: 'traceweave.metadata-draft', value: 'До записи' }, { format: 'traceweave.metadata-draft', value: 'Во время записи' }]);
  assert.equal(store.status('p').pending, 0);
});

test('unknown persisted draft formats are reported and the form stays gated', async () => {
  const store = new MetadataDraftStore();
  await assert.rejects(store.hydrate({ loadDrafts: async () => ({ 'p/node/a/title': { value: 'Без версии' } }), saveDraft: async () => {} }, 'p'), /Неизвестный формат/);
  assert.equal(store.status('p').hydrated, false);
  assert.match(store.status('p').error!, /Неизвестный формат/);
});

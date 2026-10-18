import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { VaultLinks } from '../src/vault-links';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-vault-links-'));
  const files = new Map<string, { path: string; basename: string; extension: string }>();
  for (const [relative, body] of [
    ['Folder-1/note1.md', '# Note'], ['Folder-2/note2.md', 'Second note'],
    ['Attachment/photo.png', Buffer.from([137,80,78,71,13,10,26,10])],
    ['Attachment/fake.png', '<svg onload="danger()"/>'], ['Attachment/report.pdf', '%PDF-1.4'],
    ['Attachment/opaque.bin', Buffer.from([0,255])], ['TWData/notes/managed.md', 'Managed'],
    ['TWData/projects/state.json', '{}'], ['.obsidian/private.md', 'Private'],
  ] as const) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), body);
    files.set(relative, { path: relative, basename: path.posix.basename(relative, path.posix.extname(relative)), extension: path.posix.extname(relative).slice(1) });
  }
  const opened: string[] = [], revealed: string[] = [];
  const links = new VaultLinks(root, {
    find: (target, source) => files.get(path.posix.normalize(path.posix.join(path.posix.dirname(source), target))) ?? files.get(target) ?? null,
    resourceUrl: relative => `app://local-vault/${encodeURIComponent(relative)}`,
    open: async (relative, subpath) => { opened.push(relative + subpath); }, reveal: async relative => { revealed.push(relative); },
  });
  return { root, links, opened, revealed };
}

test('ordinary vault note resolves local image and parent-relative Markdown links without copying', async () => {
  const { root, links, opened, revealed } = await fixture();
  try {
    const image = await links.resolve('Folder-1/note1.md', '../Attachment/photo.png');
    assert.equal(image?.path, 'Attachment/photo.png'); assert.equal(image.mediaKind, 'image');
    assert.equal((await links.resolve('Folder-1/note1.md', 'Attachment/photo.png'))?.path, image.path);
    assert.equal((await links.resolve('Folder-1/note1.md', '/TWData/notes/managed.md'))?.isNote, true);
    await links.open('Folder-1/note1.md', '../Folder-2/note2.md#Heading');
    await links.open('Folder-1/note1.md', 'Attachment/report.pdf');
    await links.open('Folder-1/note1.md', 'Attachment/opaque.bin');
    assert.deepEqual(opened, ['Folder-2/note2.md#Heading', 'Attachment/report.pdf']);
    assert.deepEqual(revealed, ['Attachment/opaque.bin']);
    assert.equal(await fs.readFile(path.join(root, 'Folder-1/note1.md'), 'utf8'), '# Note');
    assert.equal((await links.resolve('Folder-1/note1.md', 'Attachment/fake.png'))?.mediaKind, 'file');
    await fs.writeFile(path.join(root, 'Attachment/not-indexed.xyz'), 'Not in Vault.getFiles');
    assert.equal((await links.resolve('Folder-1/note1.md', '../Attachment/not-indexed.xyz'))?.path, 'Attachment/not-indexed.xyz');
    for (const name of ['a#1.png', 'a?1.png', 'a&copy;.png']) {
      await fs.copyFile(path.join(root, 'Attachment/photo.png'), path.join(root, 'Attachment', name));
      assert.equal((await links.resolve('Folder-1/note1.md', '../Attachment/' + encodeURIComponent(name)))?.path, 'Attachment/' + name);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('visible research media and reports resolve locally while Canvas and opaque files require an explicit open', async () => {
  const { root, links, opened, revealed } = await fixture();
  const folder = 'TWData/projects/Моё исследование', report = 'TWData/exports/Моё исследование/summary.md';
  const entries = [
    [`${folder}/images/photo.png`, Buffer.from([137,80,78,71,13,10,26,10]), 'image'],
    [`${folder}/audio/interview.mp3`, Buffer.from('ID3synthetic'), 'audio'],
    [`${folder}/video/interview.mp4`, Buffer.from([0,0,0,16,102,116,121,112,109,112,52,50]), 'video'],
    [`${folder}/documents/source.pdf`, '%PDF-1.4', 'file'],
    [`${folder}/other/opaque.xyz`, Buffer.from([0,255,1]), 'file'],
    [report, '# Обзор\n\n[[scheme.canvas]]', 'text'],
    ['TWData/exports/Моё исследование/scheme.canvas', '{"nodes":[],"edges":[]}', 'file'],
  ] as const;
  try {
    for (const [relative, body] of entries) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), body); }
    const resources: string[] = [];
    const bridge = new VaultLinks(root, { ...links.host, find: () => null, resourceUrl: relative => { resources.push(relative); return `app://vault/${encodeURIComponent(relative)}`; } });
    for (const [relative, , kind] of entries) {
      const resolved = await bridge.resolve('Folder-1/note1.md', '/' + encodeURI(relative));
      assert.equal(resolved?.path, relative); assert.equal(resolved?.mediaKind, kind);
      assert.ok(resolved.resourceUrl.startsWith('app://vault/'));
    }
    assert.deepEqual(opened, []); assert.deepEqual(revealed, [], 'resolution must never open or reveal files');
    assert.deepEqual(resources, entries.map(([relative]) => relative));
    const canvas = await bridge.resolve(report, 'scheme.canvas');
    assert.equal(canvas?.path, 'TWData/exports/Моё исследование/scheme.canvas'); assert.equal(canvas.openMode, 'native');
    for (const [relative] of entries) await bridge.open('Folder-1/note1.md', '/' + encodeURI(relative));
    assert.deepEqual(opened, entries.filter(([relative]) => !relative.endsWith('.xyz')).map(([relative]) => relative));
    assert.deepEqual(revealed, [`${folder}/other/opaque.xyz`]);
    assert.equal((await bridge.resolve(report, '../../projects/Моё исследование/images/photo.png'))?.path, `${folder}/images/photo.png`);
    assert.equal((await bridge.resolve(`${folder}/documents/source.md`, '/TWData/exports/Моё исследование/summary.md#^node-1'))?.path, report);
    for (const remote of ['https://example.invalid/photo.png', '//example.invalid/video.mp4', 'data:audio/mp3;base64,AA==', 'https%3A%2F%2Fexample.invalid%2Fsource.pdf']) assert.equal(await bridge.resolve(report, remote), null);
    assert.equal(await fs.readFile(path.join(root, report), 'utf8'), '# Обзор\n\n[[scheme.canvas]]');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('visible TWData paths cannot expose legacy UUID metadata or masquerading technical records', async () => {
  const { root, links, opened, revealed } = await fixture();
  const id = '11111111-1111-4111-8111-111111111111';
  const records = ['TWData/projects/state.json', 'TWData/projects/settings.json', `TWData/projects/${id}/state.json`, `TWData/projects/${id}/history/operation.json`, `TWData/projects/${id}/journal/operation.json`, `TWData/projects/${id}/recovery/previous-state.json`, `TWData/projects/${id}/reports/report.md`, `TWData/projects/${id}/sources/raw.md`, 'TWData/settings.json', '.twdata/settings.json', 'TWData/exports/.hidden/private.md'];
  try {
    for (const relative of records) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), 'Private metadata'); }
    for (const relative of records) {
      assert.equal(await links.resolve('Folder-1/note1.md', '/' + relative), null, relative);
      await assert.rejects(links.open('Folder-1/note1.md', '/' + relative));
      assert.equal(await links.resolve(relative, '/Attachment/photo.png'), null, 'technical source must also be rejected: ' + relative);
    }
    assert.deepEqual(opened, []); assert.deepEqual(revealed, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('vault preview never resolves network, executable URLs, OS traversal, config or technical records', async () => {
  const { root, links, opened, revealed } = await fixture();
  try {
    for (const target of ['https://example.com/p.png', '//example.com/p.png', 'file:///etc/passwd', 'javascript:alert(1)', 'https%3A%2F%2Fexample.com%2Fx', '../../etc/passwd', '../.obsidian/private.md', '../TWData/projects/state.json', '..\\Attachment\\photo.png', 'Attachment/photo.png\0', '%broken']) {
      assert.equal(await links.resolve('Folder-1/note1.md', target), null, target);
      await assert.rejects(() => links.open('Folder-1/note1.md', target));
    }
    await fs.symlink(path.join(root, 'Attachment/photo.png'), path.join(root, 'Attachment/link.png'));
    const dishonestHost = new VaultLinks(root, { find: () => ({ path: 'Attachment/link.png', basename: 'link', extension: 'png' }), resourceUrl: () => 'local:', open: async () => {}, reveal: async () => {} });
    await assert.rejects(() => dishonestHost.resolve('Folder-1/note1.md', 'link.png'), /Symbolic/);
    assert.deepEqual(opened, []); assert.deepEqual(revealed, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('vault links protect the configured directory even when its name is visible', async () => {
  const { root, links } = await fixture();
  try {
    await fs.mkdir(path.join(root, 'Configuration')); await fs.writeFile(path.join(root, 'Configuration/private.md'), 'Private');
    const bridge = new VaultLinks(root, { ...links.host, find: () => ({ path: 'Configuration/private.md', basename: 'private', extension: 'md' }) }, 'Configuration');
    for (const target of ['../Configuration/private.md', '/Configuration/private.md', 'private']) {
      assert.equal(await bridge.resolve('Folder-1/note1.md', target), null);
      await assert.rejects(() => bridge.open('Folder-1/note1.md', target));
    }
    assert.equal(await bridge.resolve('Configuration/private.md', '../Attachment/photo.png'), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('legacy aliases resolve relocated targets using the original source context only when direct lookup fails', async () => {
  const { root, links } = await fixture();
  try {
    const old = 'TraceWeave Resources/id/original.png', current = 'TWData/resources/id/original.png';
    await fs.mkdir(path.dirname(path.join(root, current)), { recursive: true }); await fs.copyFile(path.join(root, 'Attachment/photo.png'), path.join(root, current));
    const bridge = new VaultLinks(root, { ...links.host, migrated: async relative => relative === old ? current : null,
      original: async relative => relative === 'TWData/notes/project/managed.md' ? 'TraceWeave Notes/project/managed.md' : null });
    assert.equal((await bridge.resolve('Folder-1/note1.md', old))?.path, current);
    assert.equal((await bridge.resolve('TWData/notes/project/managed.md', '../../TraceWeave Resources/id/original.png'))?.path, current);
    assert.equal((await bridge.resolve('Folder-1/note1.md', '../Attachment/photo.png'))?.path, 'Attachment/photo.png');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('hidden report preview can resolve only its captured files and never exposes metadata to ordinary notes', async () => {
  const { root, links, opened, revealed } = await fixture();
  const directory = '.twdata/projects/11111111-1111-4111-8111-111111111111/reports/22222222-2222-4222-8222-222222222222';
  const report = `${directory}/report.md`, image = `${directory}/files/image.png`, pdf = `${directory}/files/report.pdf`;
  try {
    await fs.mkdir(path.join(root, directory, 'files'), { recursive: true });
    await fs.writeFile(path.join(root, report), '![Captured](files/image.png)');
    await fs.copyFile(path.join(root, 'Attachment/photo.png'), path.join(root, image));
    await fs.copyFile(path.join(root, 'Attachment/report.pdf'), path.join(root, pdf));
    const bridge = new VaultLinks(root, { ...links.host, find: () => ({ path: 'Attachment/fake.png', basename: 'Wrong current file', extension: 'png' }) });
    const captured = await bridge.resolve(report, 'files/image.png');
    assert.equal(captured?.path, image); assert.equal(captured.mediaKind, 'image'); assert.equal(captured.openMode, 'reveal');
    await bridge.open(report, 'files/report.pdf'); assert.deepEqual(revealed, [pdf]); assert.deepEqual(opened, []);
    assert.equal((await links.resolve(report, 'Folder-2/note2.md'))?.path, 'Folder-2/note2.md');
    await links.open(report, 'Folder-2/note2.md#Heading'); assert.deepEqual(opened, ['Folder-2/note2.md#Heading']);
    for (const destination of ['../../state.json', '../other/report.md', '.twdata/settings.json', '/' + image]) {
      const source = destination === '/' + image ? 'Folder-1/note1.md' : report;
      assert.equal(await bridge.resolve(source, destination), null, destination);
    }
    assert.equal(await bridge.resolve('.twdata/settings.json', 'Attachment/photo.png'), null);
    await fs.unlink(path.join(root, image));
    assert.equal(await bridge.resolve(report, 'files/image.png'), null, 'missing captured file must not resolve to a current file');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('visible immutable snapshot links keep captured originals even when the vault resolver suggests a current file', async () => {
  const { root, links, opened, revealed } = await fixture();
  const directory = 'TWData/exports/Research/snapshots/22222222-2222-4222-8222-222222222222', report = `${directory}/report.md`, captured = `${directory}/files/image.png`;
  try {
    await fs.mkdir(path.join(root, directory, 'files'), { recursive: true });
    await fs.copyFile(path.join(root, 'Attachment/photo.png'), path.join(root, captured));
    const bridge = new VaultLinks(root, { ...links.host, find: () => ({ path: 'Attachment/fake.png', basename: 'Current unrelated file', extension: 'png' }) });
    assert.equal((await bridge.resolve(report, 'files/image.png'))?.path, captured);
    await bridge.open(report, 'files/image.png'); assert.deepEqual(opened, [captured]); assert.deepEqual(revealed, []);
    await fs.unlink(path.join(root, captured));
    assert.equal(await bridge.resolve(report, 'files/image.png'), null, 'a missing capture must never fall back to a current vault file');
    for (const target of ['../../../../projects/state.json', '/TWData/settings.json', '/.twdata/settings.json']) assert.equal(await bridge.resolve(report, target), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

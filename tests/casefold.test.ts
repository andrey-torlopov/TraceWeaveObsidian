import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { caseFold, caseFoldSourceSHA256, caseFoldVersion } from '../src/casefold';
import { applyCommands, createProject, DomainError, searchProject } from '../src/domain';
import { randomUUID } from 'node:crypto';

test('all Unicode17 common/full mappings match their pinned source corpus', async () => {
  const source = await readFile(fileURLToPath(new URL('../contracts/unicode/CaseFolding-17.0.0.txt', import.meta.url)));
  assert.equal(createHash('sha256').update(source).digest('hex'), caseFoldSourceSHA256); assert.equal(caseFoldVersion, '17.0.0');
  let count = 0;
  for (const line of source.toString('utf8').split(/\r?\n/u)) {
    const data = line.split('#')[0].trim(); if (!data) continue;
    const [code, status, mapping] = data.split(';').map(value => value.trim()); if (status !== 'C' && status !== 'F') continue;
    const expected = String.fromCodePoint(...mapping.split(' ').map(value => Number.parseInt(value, 16))).normalize('NFC');
    assert.equal(caseFold(String.fromCodePoint(Number.parseInt(code, 16))), expected, `U+${code}: ${status}`); count++;
  }
  assert.equal(count, 1585);
});

test('full default folding handles ligatures, Cherokee, sigma, NFC and default Turkic semantics', () => {
  for (const [input, expected] of [['Straße', 'strasse'], ['ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ', 'ff fi fl ffi ffl st st'], ['Ꭰꭰ', 'ᎠᎠ'], ['Σσς', 'σσσ'], ['Iİıi', 'ii\u0307ıi'], ['E\u0301', 'é'], ['🧪 100%_', '🧪 100%_']]) assert.equal(caseFold(input), expected);
  assert.equal(caseFold(caseFold('ﬃ Ꭰꭰ Iİıi e\u0301')), caseFold('ﬃ Ꭰꭰ Iİıi e\u0301'));
});

test('attribute keys, tags and literal search use the same full Unicode folding', () => {
  const project = createProject('Unicode'), nodeId = randomUUID(); const p = applyCommands(project, [{ kind: 'node.create', id: nodeId, title: 'ﬃ Ꭰ', notePath: 'Notes/Unicode.md' }]);
  for (const [first, second] of [['ﬀ', 'FF'], ['ꭰ', 'Ꭰ'], ['İ', 'i\u0307']]) {
    assert.throws(() => applyCommands(p, [{ kind: 'node.update', nodeId, changes: { attributes: [{ id: randomUUID(), key: first, valueType: 'text', value: '', sortOrder: 0 }, { id: randomUUID(), key: second, valueType: 'text', value: '', sortOrder: 1 }] } }]), DomainError);
    assert.throws(() => applyCommands(p, [{ kind: 'node.update', nodeId, changes: { tags: [first, second] } }]), DomainError);
  }
  assert.equal(searchProject(p, 'FFI')[0].nodeId, nodeId); assert.equal(searchProject(p, 'ꭰ')[0].nodeId, nodeId); assert.equal(searchProject(p, 'FFI', {}, true).length, 0);
  assert.equal(searchProject(p, 'i\u0307', { [nodeId]: 'İstanbul' })[0].field, 'body'); assert.equal(searchProject(p, 'ıstanbul', { [nodeId]: 'Istanbul' }).length, 0);
});

test('generated casefold implementation uses the source table without runtime lowercase fallback', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/casefold.ts', import.meta.url)), 'utf8'); assert.ok(!source.includes('toLowerCase')); assert.ok(!source.includes('toLocaleLowerCase')); assert.ok(source.includes('?? character'));
});

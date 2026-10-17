import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyCommands, createProject, DomainError } from '../src/domain';
import { ProjectRepository, digest } from '../src/storage/repository';
import { migrateLegacyVault, getMigratedPath, getOriginalPath, type MigrationFaultPoint } from '../src/storage/migration-0.1.0';
import { createReport, verifyReport, exportProject, stageImport } from '../src/portability';
import type { Asset, BlobRecord, Project, Relation } from '../src/types';

async function exists(filename: string): Promise<boolean> { try { await fs.lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function tree(root: string, relative = ''): Promise<string[]> { const files: string[] = []; for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) { const next = relative ? `${relative}/${entry.name}` : entry.name; if (entry.isDirectory()) files.push(...await tree(root, next)); else files.push(next); } return files.sort(); }
async function fixture(): Promise<{ root: string; project: Project; ordinary: string; bytes: Buffer; originalState: string; oldBackup: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-layout-')), repo = new ProjectRepository(root, { metadataRoot: '_TraceWeave' });
  try {
    await repo.initialize(); let p = await repo.add(createProject('Legacy project')); const a = randomUUID(), b = randomUUID(), c = randomUUID(), group = randomUUID();
    const ordinary = 'Existing/Original.md', ordinaryText = '---\nexternal: keep\n---\n\n# Ordinary\n\n![[photo.png]]\n'; await fs.mkdir(path.join(root, 'Existing')); await fs.writeFile(path.join(root, ordinary), ordinaryText); await fs.writeFile(path.join(root, 'Existing/photo.png'), Buffer.from([1,2,3]));
    const aPath = `TraceWeave Notes/${p.id}/${a}.md`, cPath = `TraceWeave Notes/${p.id}/${c}.md`, gPath = `TraceWeave Notes/${p.id}/${group}.md`;
    p = await repo.execute(p.id, [{ kind: 'node.create', id: a, title: 'Managed', notePath: aPath, noteHash: digest('Managed text') }, { kind: 'node.create', id: b, title: 'Ordinary', notePath: ordinary, noteHash: digest(ordinaryText) }, { kind: 'node.create', id: c, title: 'Trash', notePath: cPath, noteHash: digest('Trashed text') }], { effects: [{ path: aPath, before: null, after: 'Managed text' }, { path: cPath, before: null, after: 'Trashed text' }] });
    const bytes = Buffer.from([0,255,128,1,2,3]), blob: BlobRecord = { id: randomUUID(), path: `TraceWeave Resources/${p.id}/original.bin`, sha256: digest(bytes.toString('binary')), byteSize: bytes.length, mimeType: 'application/octet-stream', mediaKind: 'file' };
    await fs.mkdir(path.dirname(path.join(root, blob.path)), { recursive: true }); await fs.writeFile(path.join(root, blob.path), bytes); const { createHash } = await import('node:crypto'); blob.sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset: Asset = { id: randomUUID(), blobId: blob.id, originalName: 'Original.bin', title: 'Original', mimeType: blob.mimeType, mediaKind: blob.mediaKind, byteSize: blob.byteSize, sha256: blob.sha256, createdAt: p.createdAt, deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: '', origin: { kind: 'manual' } };
    p = await repo.execute(p.id, [{ kind: 'asset.register', asset, blob }, { kind: 'attachment.attach', attachment: { id: randomUUID(), nodeId: a, assetId: asset.id, role: 'primary', sortOrder: 0, caption: null } }]);
    p = await repo.execute(p.id, [{ kind: 'group.create', id: group, title: 'Group', notePath: gPath, nodeIds: [a,c], noteHash: digest('') }], { effects: [{ path: gPath, before: null, after: '' }] });
    const relation: Relation = { id: randomUUID(), sourceNodeId: a, targetNodeId: c, relationType: 'related', label: 'Hypothesis', directed: true, bidirectional: false, assessment: 'hypothesis', confidence: null, noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: p.createdAt, updatedAt: p.createdAt, origin: { kind: 'manual' } };
    p = await repo.execute(p.id, [{ kind: 'relation.create', relation }]); const snapshot = await createReport(root, p, 'Immutable', [a,b], '_TraceWeave'); p = await repo.execute(p.id, [{ kind: 'snapshot.register', snapshot }]);
    p = await repo.execute(p.id, [{ kind: 'elements.trash', nodeIds: [c], relationIds: [], groupMode: 'group_only' }]);
    await repo.saveView(p.id, { mode: 'dossier', selectedId: a, collapsedGroupIds: [group], expandedNodeIds: [] }); await repo.atomicText(`${repo.projectRoot(p.id)}/drafts.json`, JSON.stringify({ formatVersion: 1, drafts: { [`${p.id}/draft`]: { title: 'Unsaved' } } }));
    await fs.writeFile(path.join(root, 'TraceWeave Resources/direct.unknown'), 'unregistered'); const oldBackup = `_TraceWeave/exports/old.zip`; await exportProject(root, p, path.join(root, oldBackup), '_TraceWeave');
    return { root, project: p, ordinary, bytes, originalState: await fs.readFile(path.join(root, repo.statePath(p.id)), 'utf8'), oldBackup };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; } finally { await repo.dispose(); }
}

test('layout migration preserves identity, trash, receipts, ordinary notes and immutable snapshot bytes', async () => {
  const f = await fixture(), report = f.project.snapshots[0], beforeSnapshot = await fs.readFile(path.join(f.root, report.path)), beforeReport = await fs.readFile(path.join(f.root, path.dirname(report.path), 'report.md')), ordinary = await fs.readFile(path.join(f.root, f.ordinary));
  const ordinaryStat = await fs.stat(path.join(f.root, f.ordinary)); const repo = new ProjectRepository(f.root, { metadataRoot: 'TWData' });
  try {
    await migrateLegacyVault(f.root); await repo.initialize(); const p = await repo.read(f.project.id);
    assert.equal(p.id, f.project.id); assert.equal(p.revision, f.project.revision); assert.deepEqual(p.receipts, f.project.receipts); assert.deepEqual(p.nodes.map(n => n.id), f.project.nodes.map(n => n.id)); assert.deepEqual(p.relations, f.project.relations); assert.deepEqual(p.deletionBatches, f.project.deletionBatches);
    assert.ok(p.nodes.filter(n => n.notePath !== f.ordinary).every(n => n.notePath.startsWith('TWData/notes/'))); assert.equal(p.nodes.find(n => n.notePath === f.ordinary)?.id, f.project.nodes[1].id); assert.deepEqual(await fs.readFile(path.join(f.root, f.ordinary)), ordinary); assert.equal((await fs.stat(path.join(f.root, f.ordinary))).mtimeMs, ordinaryStat.mtimeMs);
    assert.deepEqual(await fs.readFile(path.join(f.root, p.blobs[0].path)), f.bytes); assert.deepEqual(await fs.readFile(path.join(f.root, p.snapshots[0].path)), beforeSnapshot); assert.deepEqual(await fs.readFile(path.join(f.root, path.dirname(p.snapshots[0].path), 'report.md')), beforeReport); await verifyReport(f.root, p.snapshots[0]);
    assert.deepEqual(await repo.loadView(p.id), { mode: 'dossier', selectedId: f.project.nodes[0].id, collapsedGroupIds: [f.project.nodes[3].id], expandedNodeIds: [] }); assert.ok((await repo.readText(`${repo.projectRoot(p.id)}/drafts.json`)).includes('Unsaved'));
    const marker = JSON.parse(await fs.readFile(path.join(f.root, 'TWData/migration.json'), 'utf8')); assert.equal(marker.phase, 'complete'); assert.equal(await fs.readFile(path.join(f.root, marker.retainedRoot, `projects/${p.id}/state.json`), 'utf8'), f.originalState);
    assert.ok(!await exists(path.join(f.root, '_TraceWeave'))); assert.ok(!await exists(path.join(f.root, 'TraceWeave Notes'))); assert.ok(!await exists(path.join(f.root, 'TraceWeave Resources'))); assert.ok((await tree(f.root)).every(name => name.startsWith('TWData/') || name.startsWith('Existing/')));
    const stacks = await repo.historyState(p); assert.ok(stacks.undo.length > 0); const restored = await repo.execute(p.id, [{ kind: 'trash.restore', batchId: p.deletionBatches[0].id }]); assert.ok(restored.nodes.every(n => !n.deletedAt));
    await migrateLegacyVault(f.root); assert.equal((await repo.read(p.id)).revision, restored.revision);
  } finally { await repo.dispose(); await fs.rm(f.root, { recursive: true, force: true }); }
});

for (const point of ['after-prepared','after-files','after-published','after-retained'] as const) test(`migration resumes without overwrites after ${point}`, async () => {
  const f = await fixture(); let failed = false;
  try {
    await assert.rejects(() => migrateLegacyVault(f.root, { fault(at: MigrationFaultPoint) { if (!failed && at === point) { failed = true; throw new Error('Injected migration failure'); } } }), /Injected migration failure/);
    await migrateLegacyVault(f.root); const repo = new ProjectRepository(f.root, { metadataRoot: 'TWData' }); try { await repo.initialize(); const p = await repo.read(f.project.id); assert.equal(p.revision, f.project.revision); assert.deepEqual(p.receipts, f.project.receipts); assert.deepEqual(await fs.readFile(path.join(f.root, p.blobs[0].path)), f.bytes); await verifyReport(f.root, p.snapshots[0]); assert.ok(!await exists(path.join(f.root, '_TraceWeave'))); } finally { await repo.dispose(); }
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('migration destination conflict preserves old layout and never overwrites user bytes', async () => {
  const f = await fixture(), node = f.project.nodes[0], target = node.notePath.replace('TraceWeave Notes/', 'TWData/notes/');
  try { await fs.mkdir(path.dirname(path.join(f.root, target)), { recursive: true }); await fs.writeFile(path.join(f.root, target), 'User conflict'); await assert.rejects(() => migrateLegacyVault(f.root), error => error instanceof DomainError && error.code === 'migration_conflict'); assert.equal(await fs.readFile(path.join(f.root, target), 'utf8'), 'User conflict'); assert.equal(await fs.readFile(path.join(f.root, node.notePath), 'utf8'), 'Managed text'); assert.equal(await fs.readFile(path.join(f.root, `_TraceWeave/projects/${f.project.id}/state.json`), 'utf8'), f.originalState); }
  finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('migrated immutable reports export/import and old 0.1.0 backups remain readable', async () => {
  const f = await fixture();
  try {
    const oldBackup = await fs.readFile(path.join(f.root, f.oldBackup)); await migrateLegacyVault(f.root); const repo = new ProjectRepository(f.root, { metadataRoot: 'TWData' }); await repo.initialize(); const p = await repo.read(f.project.id), output = path.join(f.root, 'TWData/exports/new.zip'); await exportProject(f.root, p, output, 'TWData'); await repo.dispose();
    const imported = await stageImport(f.root, output); await imported.commit(); await verifyReport(f.root, imported.project.snapshots[0]); assert.ok(imported.project.nodes.every(n => n.notePath.startsWith('Исследования/Заметки/'))); assert.ok(imported.project.blobs.every(b => b.path.startsWith('Исследования/Вложения/')));
    const oldPath = path.join(f.root, 'TWData/exports/old-import.zip'); await fs.writeFile(oldPath, oldBackup); const oldImported = await stageImport(f.root, oldPath); await oldImported.commit(); await verifyReport(f.root, oldImported.project.snapshots[0]); assert.ok(oldImported.project.nodes.every(n => n.notePath.startsWith('Исследования/Заметки/')));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('custom old roots do not make adopted ordinary notes plugin-owned', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-custom-legacy-')), legacy = new ProjectRepository(root, { metadataRoot: '_TraceWeave' });
  try {
    await legacy.initialize(); let p = await legacy.add(createProject('Custom')); const managedId = randomUUID(), ordinaryId = randomUUID(), resourceNoteId = randomUUID(), managed = `Мои заметки/Custom--${p.id.slice(0,8)}/Created--${managedId.slice(0,8)}.md`, ordinary = 'Мои заметки/Семья.md', resourceNote = 'Мои ресурсы/Источники.md';
    for (const relative of [managed, ordinary, resourceNote]) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), `---\nforeign: true\n---\n${relative}`); }
    await legacy.atomicText('_TraceWeave/settings.json', JSON.stringify({ notesRoot: 'Мои заметки', resourcesRoot: 'Мои ресурсы' }));
    p = await legacy.execute(p.id, [{ kind: 'node.create', id: managedId, title: 'Managed', notePath: managed }, { kind: 'node.create', id: ordinaryId, title: 'Ordinary', notePath: ordinary }, { kind: 'node.create', id: resourceNoteId, title: 'Ordinary in resource folder', notePath: resourceNote }]);
    const beforeOrdinary = await fs.readFile(path.join(root, ordinary)), beforeResource = await fs.readFile(path.join(root, resourceNote)); await legacy.dispose(); await migrateLegacyVault(root);
    const repo = new ProjectRepository(root, { metadataRoot: 'TWData' }); try { await repo.initialize(); const migrated = await repo.read(p.id); assert.ok(migrated.nodes[0].notePath.startsWith('TWData/notes/custom/')); assert.equal(migrated.nodes[1].notePath, ordinary); assert.equal(migrated.nodes[2].notePath, resourceNote); assert.deepEqual(await fs.readFile(path.join(root, ordinary)), beforeOrdinary); assert.deepEqual(await fs.readFile(path.join(root, resourceNote)), beforeResource); } finally { await repo.dispose(); }
  } finally { await legacy.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('moved managed Markdown rebases destinations, retains original bytes and migrates historic note hashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-link-migration-')), legacy = new ProjectRepository(root, { metadataRoot: '_TraceWeave' });
  try {
    await legacy.initialize(); let p = await legacy.add(createProject('Links')); const a = randomUUID(), b = randomUUID(), aPath = `TraceWeave Notes/${p.id}/A.md`, bPath = `TraceWeave Notes/${p.id}/B.md`, resource = `TraceWeave Resources/${p.id}/image.png`;
    const text = `---\nexample: "[[${bPath}]]"\n---\n\n![](../../TraceWeave%20Resources/${p.id}/image.png)\n[Ordinary](../../Existing/Original.md)\n[[${bPath.slice(0,-3)}|Alias]]\n\n\`[[${bPath}]]\`\n`;
    for (const [relative, value] of [[aPath,text],[bPath,'B'],[resource,'opaque-image'],['Existing/Original.md','Ordinary immutable body']]) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), value); }
    p = await legacy.execute(p.id, [{ kind: 'node.create', id:a, title:'A', notePath:aPath, noteHash:digest(text) },{ kind:'node.create',id:b,title:'B',notePath:bPath,noteHash:digest('B') }]);
    const operationId = Object.keys(p.receipts)[0]; await legacy.dispose(); await migrateLegacyVault(root); const repo = new ProjectRepository(root, { metadataRoot: 'TWData' });
    try { await repo.initialize(); const migrated = await repo.read(p.id), node = migrated.nodes[0], updated = await fs.readFile(path.join(root,node.notePath),'utf8'); assert.ok(updated.includes(`../../resources/${p.id}/image.png`)); assert.ok(updated.includes('../../../Existing/Original.md')); assert.ok(updated.includes(`[[TWData/notes/${p.id}/B|Alias]]`)); assert.ok(updated.includes(`example: "[[${bPath}]]"`)); assert.ok(updated.includes(`\`[[${bPath}]]\``)); assert.equal(node.noteHash,digest(updated)); assert.equal(await fs.readFile(path.join(root,'Existing/Original.md'),'utf8'),'Ordinary immutable body');
      const marker=JSON.parse(await fs.readFile(path.join(root,'TWData/migration.json'),'utf8')), retained=marker.moves.find((move:{from:string})=>move.from===aPath); assert.ok(retained.to.includes('/recovery/')); assert.equal(await fs.readFile(path.join(root,retained.to),'utf8'),text);
      const history=JSON.parse(await fs.readFile(path.join(root,`TWData/projects/${p.id}/history/${operationId}.json`),'utf8')); assert.equal(history.after.nodes[0].noteHash,node.noteHash); assert.deepEqual(migrated.receipts,p.receipts); assert.equal(await getMigratedPath(root,aPath),node.notePath); assert.equal(await getOriginalPath(root,node.notePath),aPath); assert.equal(await getMigratedPath(root,bPath.slice(0,-3)),`TWData/notes/${p.id}/B`);
    } finally { await repo.dispose(); }
  } finally { await legacy.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

test('external backlinks update only destinations at the same note path and resume after retaining original', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-backlinks-')), legacy = new ProjectRepository(root, { metadataRoot: '_TraceWeave' });
  try {
    await legacy.initialize(); let p = await legacy.add(createProject('Backlinks')); const id = randomUUID(), externalId = randomUUID(), managed = `TraceWeave Notes/${p.id}/Target.md`, external = 'Ordinary/Source.md', untouched = 'Ordinary/Untouched.md';
    const original = `---\nforeign: "[[${managed}]]"\n---\n\n[[${managed.slice(0,-3)}|Target]]\n[Target](../TraceWeave%20Notes/${p.id}/Target.md)\n\n\`[[${managed}]]\`\n`;
    for (const [relative, text] of [[managed,'Target'],[external,original],[untouched,'---\nforeign: yes\n---\n![[photo.png]]\n']]) { await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true}); await fs.writeFile(path.join(root,relative),text); }
    const untouchedBytes=await fs.readFile(path.join(root,untouched)); p = await legacy.execute(p.id,[{kind:'node.create',id,title:'Target',notePath:managed,noteHash:digest('Target')},{kind:'node.create',id:externalId,title:'Source',notePath:external,noteHash:digest(original)}]); await legacy.dispose();
    await assert.rejects(()=>migrateLegacyVault(root,{fault(point){if(point==='after-files')throw new Error('Pause after originals retained');}}),/Pause after originals retained/);
    const partial=JSON.parse(await fs.readFile(path.join(root,'TWData/migration.json'),'utf8')); assert.ok(partial.externalNotes.includes(external)); const retained=partial.moves.find((move:{from:string})=>move.from===external); assert.equal(await fs.readFile(path.join(root,retained.to),'utf8'),original);
    await migrateLegacyVault(root); const repo=new ProjectRepository(root, { metadataRoot: 'TWData' }); try { await repo.initialize(); const next=await repo.read(p.id), updated=await fs.readFile(path.join(root,external),'utf8'); assert.equal(next.nodes[1].notePath,external); assert.equal(next.nodes[1].noteHash,digest(updated)); assert.ok(updated.includes(`[[TWData/notes/${p.id}/Target|Target]]`)); assert.ok(updated.includes(`../TWData/notes/${p.id}/Target.md`)); assert.ok(updated.includes(`foreign: "[[${managed}]]"`)); assert.ok(updated.includes(`\`[[${managed}]]\``)); assert.deepEqual(await fs.readFile(path.join(root,untouched)),untouchedBytes); assert.equal(await getOriginalPath(root,'TWData/notes/new.md'),null); } finally {await repo.dispose();}
  } finally {await legacy.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('BOM managed and external link rewrites retain original bytes and consistent note hashes after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'traceweave-bom-migration-')), legacy = new ProjectRepository(root, { metadataRoot: '_TraceWeave' });
  try {
    await legacy.initialize(); let p = await legacy.add(createProject('BOM links')); const a = randomUUID(), b = randomUUID(), externalId = randomUUID(), managed = `TraceWeave Notes/${p.id}/A.md`, target = `TraceWeave Notes/${p.id}/B.md`, external = 'Ordinary/BOM.md';
    const managedText = `\uFEFF---\nexample: "[[${target}]]"\n---\n\n[[${target.slice(0,-3)}|B]]\n[Ordinary](../../Ordinary/BOM.md)\n`, externalText = `\uFEFF---\nexample: "[[${managed}]]"\n---\n\n[[${managed.slice(0,-3)}|A]]\n\n\`[[${managed}]]\`\n`;
    await fs.mkdir(path.join(root, 'Ordinary')); await fs.writeFile(path.join(root, external), externalText);
    p = await legacy.execute(p.id, [{ kind: 'node.create', id: a, title: 'A', notePath: managed, noteHash: digest(managedText) }, { kind: 'node.create', id: b, title: 'B', notePath: target, noteHash: digest('B') }, { kind: 'node.create', id: externalId, title: 'External', notePath: external, noteHash: digest(externalText) }], { effects: [{ path: managed, before: null, after: managedText }, { path: target, before: null, after: 'B' }] });
    const operation = Object.keys(p.receipts)[0], snapshot = await createReport(root, p, 'BOM original', [a,externalId], '_TraceWeave'); p = await legacy.execute(p.id, [{ kind: 'snapshot.register', snapshot }]); await legacy.dispose();
    await assert.rejects(() => migrateLegacyVault(root, { fault(point) { if (point === 'after-files') throw new Error('BOM migration pause'); } }), /BOM migration pause/); await migrateLegacyVault(root);
    const repo = new ProjectRepository(root, { metadataRoot: 'TWData' }); try {
      await repo.initialize(); const migrated = await repo.read(p.id), marker = JSON.parse(await fs.readFile(path.join(root, 'TWData/migration.json'), 'utf8'));
      for (const [oldPath, original, nodeId] of [[managed,managedText,a],[external,externalText,externalId]]) {
        const node = migrated.nodes.find(n => n.id === nodeId)!, published = await fs.readFile(path.join(root, node.notePath)), text = published.toString('utf8'), retained = marker.moves.find((move: { from: string }) => move.from === oldPath);
        assert.deepEqual(published.subarray(0,3), Buffer.from([0xef,0xbb,0xbf])); assert.notEqual(text,original); assert.equal(await repo.readText(node.notePath),text); assert.equal(node.noteHash,digest(text)); assert.deepEqual(await fs.readFile(path.join(root,retained.to)),Buffer.from(original)); assert.ok(text.includes('example: "[[TraceWeave Notes/'));
      }
      assert.equal(migrated.nodes.find(n=>n.id===externalId)!.notePath,external); const history = JSON.parse(await repo.readText(`TWData/projects/${p.id}/history/${operation}.json`)), journal = JSON.parse(await repo.readText(`TWData/projects/${p.id}/journal/${operation}.json`));
      for (const nodeId of [a,externalId]) assert.equal(history.after.nodes.find((n: { id:string })=>n.id===nodeId).noteHash,migrated.nodes.find(n=>n.id===nodeId)!.noteHash);
      assert.equal(journal.effects[0].after.charCodeAt(0),0xfeff); assert.equal(journal.state.nodes[0].noteHash,digest(journal.effects[0].after)); await verifyReport(root,migrated.snapshots[0]);
      const archive=path.join(root,'TWData/exports/bom.zip'); await exportProject(root,migrated,archive,'TWData'); const staged=await stageImport(root,archive); try { await staged.commit(); for(const title of ['A','External']) { const node=staged.project.nodes.find(n=>n.title===title)!; assert.equal((await fs.readFile(path.join(root,node.notePath),'utf8')).charCodeAt(0),0xfeff); } await verifyReport(root,staged.project.snapshots[0]); } finally { await staged.rollback(); }
    } finally { await repo.dispose(); }
  } finally { await legacy.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

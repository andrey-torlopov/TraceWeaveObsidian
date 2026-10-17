import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createProject, DomainError } from '../src/domain';
import { ProjectRepository, digest, stableJSON } from '../src/storage/repository';
import { FileStore } from '../src/storage/files';
import { DATA_ROOT, NOTES_ROOT, RESOURCES_ROOT, isAllowedNotePath } from '../src/storage/layout';
import { migrateLegacyVault, getMigratedPath, getOriginalPath, type MigrationFaultPoint } from '../src/storage/migration';
import { migrateLegacyVault as migrateToTWData } from '../src/storage/migration-0.1.0';
import { createReport, verifyReport, exportProject, stageImport } from '../src/portability';
import type { Asset, Project } from '../src/types';

async function exists(file:string):Promise<boolean>{try{await fs.lstat(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function files(root:string,relative=''):Promise<string[]>{const out:string[]=[];for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const file=relative?`${relative}/${entry.name}`:entry.name;if(entry.isDirectory())out.push(...await files(root,file));else out.push(file);}return out.sort();}
async function fixture(mode:'direct-0.1.0'|'0.1.1-marker'|'0.1.1-no-marker'='0.1.1-no-marker'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tw-hidden-migration-')),metadataRoot=mode==='0.1.1-no-marker'?'TWData':'_TraceWeave',notesRoot=metadataRoot==='TWData'?'TWData/notes':'TraceWeave Notes',resourcesRoot=metadataRoot==='TWData'?'TWData/resources':'TraceWeave Resources',repo=new ProjectRepository(root,{metadataRoot});
  try{
    await repo.initialize();let p=await repo.add(createProject('Hidden migration'));const a=randomUUID(),b=randomUUID(),externalId=randomUUID(),ordinaryId=randomUUID(),managed=`${notesRoot}/${p.id}/A.md`,target=`${notesRoot}/${p.id}/B.md`,external='Ordinary/Backlink.md',ordinary='Ordinary/Unchanged.md';
    const managedText=`\uFEFF---\nexample: "[[${target}]]"\n---\n\n[[${target.slice(0,-3)}|B]]\n[Outside](../../Ordinary/Unchanged.md)\n`,externalText=`\uFEFF---\nkeep: true\n---\n\n[[${managed.slice(0,-3)}|A]]\n\`[[${managed}]]\`\n`,ordinaryText='---\nforeign: true\n---\n[Unchanged](./Other.md)\n![[photo.png]]\n';
    await fs.mkdir(path.join(root,'Ordinary'));await fs.writeFile(path.join(root,external),externalText);await fs.writeFile(path.join(root,ordinary),ordinaryText);await fs.writeFile(path.join(root,'Ordinary/photo.png'),Buffer.from([1,2,3]));
    p=await repo.execute(p.id,[{kind:'node.create',id:a,title:'A',notePath:managed,noteHash:digest(managedText)},{kind:'node.create',id:b,title:'B',notePath:target,noteHash:digest('B')},{kind:'node.create',id:externalId,title:'Backlink',notePath:external,noteHash:digest(externalText)},{kind:'node.create',id:ordinaryId,title:'Unchanged',notePath:ordinary,noteHash:digest(ordinaryText)}],{effects:[{path:managed,before:null,after:managedText},{path:target,before:null,after:'B'}]});
    const changed=managedText+'Second version\n';p=await repo.execute(p.id,[{kind:'node.update',nodeId:a,changes:{noteHash:digest(changed)}}],{effects:[{path:managed,before:managedText,after:changed}]});
    const binary=Buffer.from([0,128,255,80,75,13,10]),source=path.join(root,'opaque.bin');await fs.writeFile(source,binary);const {blob}=await new FileStore(root,metadataRoot,resourcesRoot).importFile(source,p.id);await fs.unlink(source);
    const asset:Asset={id:randomUUID(),blobId:blob.id,originalName:'opaque.bin',title:'Original',mimeType:blob.mimeType,mediaKind:blob.mediaKind,byteSize:blob.byteSize,sha256:blob.sha256,createdAt:p.createdAt,deletedAt:null,deletionBatchId:null,sourceUrl:null,sourceAuthor:null,sourceCreatedAt:null,noteMarkdown:'',origin:{kind:'manual'}};
    p=await repo.execute(p.id,[{kind:'asset.register',asset,blob}]);const snapshot=await createReport(root,p,'Immutable',[a,externalId],metadataRoot);p=await repo.execute(p.id,[{kind:'snapshot.register',snapshot}]);p=await repo.execute(p.id,[{kind:'elements.trash',nodeIds:[b],relationIds:[],groupMode:'group_only'}]);
    await repo.saveView(p.id,{mode:'dossier',selectedId:a,collapsedGroupIds:[],expandedNodeIds:[],viewport:{x:100,y:200,zoom:0.9}});await repo.atomicText(`${metadataRoot}/settings.json`,JSON.stringify({notesRoot,resourcesRoot}));await repo.atomicText(`${metadataRoot}/.DS_Store`,'Retain system metadata bytes');await repo.atomicText(`${metadataRoot}/projects/.DS_Store`,'Retain projects folder system metadata');await repo.dispose();
    if(mode==='0.1.1-marker'){await migrateToTWData(root);const transitional=new ProjectRepository(root,{metadataRoot:'TWData'});try{await transitional.initialize();p=await transitional.read(p.id);}finally{await transitional.dispose();}}
    const sourceMeta=mode==='direct-0.1.0'?'_TraceWeave':'TWData',snapshotBytes=await fs.readFile(path.join(root,p.snapshots[0].path)),ordinaryBytes=await fs.readFile(path.join(root,ordinary)),originalState=await fs.readFile(path.join(root,`${sourceMeta}/projects/${p.id}/state.json`)),retained=new Map<string,Buffer>();
    if(mode==='0.1.1-marker')for(const file of await files(root,'TWData/recovery'))retained.set(file,await fs.readFile(path.join(root,file)));
    return {root,p,managed,target,external,ordinary,binary,snapshotBytes,ordinaryBytes,originalState,retained};
  }catch(error){await fs.rm(root,{recursive:true,force:true});throw error;}finally{await repo.dispose();}
}

for(const mode of ['direct-0.1.0','0.1.1-marker','0.1.1-no-marker']as const)test(`hidden layout migrates ${mode} preserving identity, originals, historical snapshots and ordinary notes`,async()=>{
  const f=await fixture(mode),repo=new ProjectRepository(f.root);try{
    await migrateLegacyVault(f.root);await repo.initialize();const p=await repo.read(f.p.id);assert.equal(p.id,f.p.id);assert.equal(p.revision,f.p.revision);assert.deepEqual(p.receipts,f.p.receipts);assert.deepEqual(p.deletionBatches,f.p.deletionBatches);assert.equal(p.nodes[0].id,f.p.nodes[0].id);assert.ok(p.nodes[0].notePath.startsWith(NOTES_ROOT+'/'));assert.equal(p.nodes[2].notePath,f.external);assert.equal(p.nodes[3].notePath,f.ordinary);assert.deepEqual(await fs.readFile(path.join(f.root,f.ordinary)),f.ordinaryBytes);
    assert.deepEqual(await fs.readFile(path.join(f.root,p.blobs[0].path)),f.binary);assert.ok(p.blobs[0].path.startsWith(RESOURCES_ROOT+'/'));assert.ok(p.snapshots[0].path.startsWith(DATA_ROOT+'/'));assert.deepEqual(await fs.readFile(path.join(f.root,p.snapshots[0].path)),f.snapshotBytes);await verifyReport(f.root,p.snapshots[0]);
    for(const node of p.nodes.filter(n=>n.title==='A'||n.title==='Backlink')){const text=await repo.readText(node.notePath);assert.equal(text.charCodeAt(0),0xfeff);assert.equal(node.noteHash,digest(text));assert.ok(text.includes(NOTES_ROOT));}
    const marker=JSON.parse(await repo.readText('.twdata/layout-migration.json'));assert.equal(marker.phase,'complete');if(mode==='direct-0.1.0'){const original=(await files(f.root,'.twdata/recovery')).find(file=>file.endsWith(`/_TraceWeave/projects/${p.id}/state.json`));assert.ok(original);assert.deepEqual(await fs.readFile(path.join(f.root,original)),f.originalState);}else assert.deepEqual(await fs.readFile(path.join(f.root,marker.retainedRoot,`projects/${p.id}/state.json`)),f.originalState);
    for(const [old,bytes]of f.retained)assert.deepEqual(await fs.readFile(path.join(f.root,old.replace(/^TWData/u,'.twdata'))),bytes);const retainedSystem=(await files(f.root,'.twdata')).find(file=>file.endsWith('/projects/.DS_Store'));assert.ok(retainedSystem);assert.equal(await fs.readFile(path.join(f.root,retainedSystem),'utf8'),'Retain projects folder system metadata');assert.ok(!marker.aliases.some((alias:{from:string})=>alias.from.includes('/.DS_Store')));assert.ok(!await exists(path.join(f.root,'TWData')));assert.ok(!await exists(path.join(f.root,'_TraceWeave')));assert.ok((await files(f.root)).every(file=>file.startsWith('.twdata/')||file.startsWith('Исследования/')||file.startsWith('Ordinary/')));
    const oldAlias=mode==='direct-0.1.0'||mode==='0.1.1-marker'?f.managed:`TWData/notes/${p.id}/A.md`;assert.equal(await getMigratedPath(f.root,oldAlias),p.nodes[0].notePath);assert.ok(await getOriginalPath(f.root,p.nodes[0].notePath));assert.equal(await getOriginalPath(f.root,`${NOTES_ROOT}/new.md`),null);
    assert.deepEqual((await repo.loadView(p.id) as {viewport:unknown}).viewport,{x:100,y:200,zoom:0.9});const stack=await repo.historyState(p);assert.ok(stack.undo.length>0);for(const name of await fs.readdir(path.join(f.root,repo.projectRoot(p.id),'journal'))){const journal=JSON.parse(await repo.readText(`${repo.projectRoot(p.id)}/journal/${name}`));for(const effect of journal.effects){if(effect.after.startsWith('\uFEFF'))assert.equal(effect.after.charCodeAt(0),0xfeff);const node=journal.state.nodes.find((n:{notePath:string})=>n.notePath===effect.path);assert.equal(node.noteHash,digest(effect.after));}assert.equal(journal.afterHash,digest(stableJSON(journal.state)));}
    const output=path.join(f.root,'.twdata/exports/hidden.zip');await exportProject(f.root,p,output);const staged=await stageImport(f.root,output);try{await staged.commit();await verifyReport(f.root,staged.project.snapshots[0]);assert.ok(staged.project.nodes.every(node=>node.notePath.startsWith(NOTES_ROOT+'/')));}finally{await staged.rollback();}await migrateLegacyVault(f.root);assert.equal((await repo.read(p.id)).revision,p.revision);
  }finally{await repo.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});

for(const point of ['after-prepared','after-files','after-published','after-retained']as const)test(`hidden layout resumes after ${point} without overwrites`,async()=>{
  const f=await fixture();try{await assert.rejects(()=>migrateLegacyVault(f.root,{fault(at:MigrationFaultPoint){if(at===point)throw new Error('Injected hidden migration fault');}}),/Injected hidden migration fault/);await migrateLegacyVault(f.root);const repo=new ProjectRepository(f.root);try{await repo.initialize();const p=await repo.read(f.p.id);assert.equal(p.revision,f.p.revision);assert.deepEqual(p.receipts,f.p.receipts);assert.deepEqual(await fs.readFile(path.join(f.root,p.blobs[0].path)),f.binary);await verifyReport(f.root,p.snapshots[0]);assert.ok(!await exists(path.join(f.root,'TWData')));}finally{await repo.dispose();}}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

for(const problem of ['destination-conflict','unknown-json','symlink','malformed-state','unknown-project-file','system-file-symlink']as const)test(`hidden layout rejects ${problem} before moving source notes`,async()=>{
  const f=await fixture();try{const original=await fs.readFile(path.join(f.root,f.managed));if(problem==='destination-conflict'){const target=f.managed.replace('TWData/notes',NOTES_ROOT);await fs.mkdir(path.dirname(path.join(f.root,target)),{recursive:true});await fs.writeFile(path.join(f.root,target),'User bytes');}else if(problem==='unknown-json')await fs.writeFile(path.join(f.root,'TWData/future.json'),'{}');else if(problem==='symlink')await fs.symlink(path.join(f.root,'Ordinary'),path.join(f.root,'TWData/linked'));else if(problem==='unknown-project-file')await fs.writeFile(path.join(f.root,'TWData/projects/unknown.txt'),'Unknown project file');else if(problem==='system-file-symlink'){await fs.unlink(path.join(f.root,'TWData/projects/.DS_Store'));await fs.symlink(path.join(f.root,f.ordinary),path.join(f.root,'TWData/projects/.DS_Store'));}else await fs.writeFile(path.join(f.root,`TWData/projects/${f.p.id}/state.json`),'{broken');await assert.rejects(()=>migrateLegacyVault(f.root));assert.deepEqual(await fs.readFile(path.join(f.root,f.managed)),original);assert.ok(!await exists(path.join(f.root,'.twdata/layout-migration.json')));}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('hidden migration guards external edits, protected marker paths and reappearing roots',async()=>{
  const f=await fixture();try{await assert.rejects(()=>migrateLegacyVault(f.root,{fault(point){if(point==='after-prepared')throw new Error('Pause');}}),/Pause/);const markerPath=path.join(f.root,'.twdata/layout-migration.json'),raw=await fs.readFile(markerPath,'utf8'),marker=JSON.parse(raw);const external=marker.prepared.find((move:{to:string})=>move.to===f.external);external.to='.obsidian/stolen.md';marker.externalNotes.push(external.to);marker.planHash=digest(stableJSON({id:marker.id,moves:marker.moves,prepared:marker.prepared,aliases:marker.aliases,externalNotes:marker.externalNotes,baselines:marker.baselines,retainedRoot:marker.retainedRoot}));await fs.writeFile(markerPath,JSON.stringify(marker));await assert.rejects(()=>migrateLegacyVault(f.root));assert.ok(!await exists(path.join(f.root,'.obsidian/stolen.md')));await fs.writeFile(markerPath,raw);const before=await fs.readFile(path.join(f.root,f.external));await fs.appendFile(path.join(f.root,f.external),'External edit');await assert.rejects(()=>migrateLegacyVault(f.root),/изменён/);assert.ok((await fs.readFile(path.join(f.root,f.external),'utf8')).endsWith('External edit'));await fs.writeFile(path.join(f.root,f.external),before);await migrateLegacyVault(f.root);await fs.mkdir(path.join(f.root,'TWData'));await assert.rejects(()=>migrateLegacyVault(f.root),error=>error instanceof DomainError&&error.code==='migration_conflict');assert.equal(isAllowedNotePath('.twdata/notes/hidden.md'),false);assert.equal(isAllowedNotePath('TWData/notes/legacy.md'),false);assert.equal(isAllowedNotePath('TWData/notes/legacy.md',true),true);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('migration leaves a visible custom configuration folder and its backlinks unchanged', async () => {
  const f = await fixture();
  try {
    const text = `[[${f.managed}]]\nPrivate configuration\n`;
    await fs.mkdir(path.join(f.root, 'Configuration')); await fs.writeFile(path.join(f.root, 'Configuration/private.md'), text);
    await migrateLegacyVault(f.root, { configDir: 'Configuration' });
    assert.equal(await fs.readFile(path.join(f.root, 'Configuration/private.md'), 'utf8'), text);
    const marker = JSON.parse(await fs.readFile(path.join(f.root, '.twdata/layout-migration.json'), 'utf8')) as { externalNotes: string[] };
    assert.ok(!marker.externalNotes.some(relative => relative.startsWith('Configuration/')));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('resuming migration rejects a plan redirected into the custom configuration folder', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'Configuration')); await fs.writeFile(path.join(f.root, 'Configuration/private.md'), 'Private configuration');
    await assert.rejects(() => migrateLegacyVault(f.root, { configDir: 'Configuration', fault(point) { if (point === 'after-prepared') throw new Error('Pause'); } }), /Pause/);
    const markerPath = path.join(f.root, '.twdata/layout-migration.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { id: string; moves: unknown[]; prepared: { to: string }[]; aliases: unknown[]; externalNotes: string[]; baselines: unknown[]; retainedRoot: string; planHash: string };
    marker.prepared[0].to = 'Configuration/private.md'; marker.externalNotes.push('Configuration/private.md');
    marker.planHash = digest(stableJSON({ id: marker.id, moves: marker.moves, prepared: marker.prepared, aliases: marker.aliases, externalNotes: marker.externalNotes, baselines: marker.baselines, retainedRoot: marker.retainedRoot }));
    await fs.writeFile(markerPath, JSON.stringify(marker));
    await assert.rejects(() => migrateLegacyVault(f.root, { configDir: 'Configuration' }));
    assert.equal(await fs.readFile(path.join(f.root, 'Configuration/private.md'), 'utf8'), 'Private configuration');
    assert.equal(await fs.readFile(path.join(f.root, `TWData/projects/${f.p.id}/state.json`), 'utf8'), f.originalState.toString('utf8'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

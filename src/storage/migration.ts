import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, validateProject } from '../domain';
import type { Project } from '../types';
import { ProjectRepository, digest, stableJSON, strictJSON } from './repository';
import { digestFile, requireId, resolveSafe, safeRelative } from './files';
import { validateRecord } from './records';
import { DATA_ROOT, LEGACY_METADATA_ROOT, TRANSITIONAL_METADATA_ROOT, NOTES_ROOT, RESOURCES_ROOT, isAllowedNotePath } from './layout';
import { verifyReport } from '../portability';
import { rewriteMovedNoteLinks } from './markdown-paths';
import { migrateLegacyVault as migrateToTWData, legacyAliases } from './migration-0.1.0';

export type MigrationFaultPoint = 'after-prepared' | 'after-files' | 'after-published' | 'after-retained';
interface Proof { sha256: string; byteSize: number }
interface Move extends Proof { from: string; to: string }
interface Alias { from: string; to: string }
interface Marker { format: 'traceweave.hidden-layout-migration'; version: 1; id: string; phase: 'prepared' | 'files' | 'published' | 'complete'; moves: Move[]; prepared: Move[]; aliases: Alias[]; externalNotes: string[]; baselines: (Proof & { path: string })[]; retainedRoot: string; planHash: string }
const OLD = TRANSITIONAL_METADATA_ROOT, MARKER = `${DATA_ROOT}/layout-migration.json`;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (value: string, root: string): boolean => value === root || value.startsWith(root + '/');
const mapped = (value: string): string => {
  for (const [from,to] of [[`${OLD}/notes`,NOTES_ROOT],[`${OLD}/resources`,RESOURCES_ROOT],[OLD,DATA_ROOT]]) if (inside(value,from!)) return to + value.slice(from!.length);
  return value;
};
async function exists(root: string, relative: string): Promise<boolean> { try { await fs.lstat(await resolveSafe(root, relative)); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function readUTF8(root: string, relative: string): Promise<string> {
  const absolute = await resolveSafe(root, relative), stat = await fs.lstat(absolute); if (!stat.isFile() || stat.size > 201_326_592) throw new DomainError('migration_limit','Файл переноса превышает безопасный лимит чтения.');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.readFile(absolute));
}
async function atomic(root: string, relative: string, value: string): Promise<void> {
  const target = await resolveSafe(root,relative,true), temporary = `${target}.${randomUUID()}.tmp`, file = await fs.open(temporary,'wx',0o600);
  try { await file.writeFile(value,'utf8'); await file.sync(); } finally { await file.close(); }
  await fs.rename(temporary,target); const parent = await fs.open(path.dirname(target),'r'); try { await parent.sync(); } catch(error) { if (!['EINVAL','ENOTSUP','EPERM','EBADF','EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; } finally { await parent.close(); }
}
async function proof(root: string, relative: string): Promise<Proof> { return digestFile(await resolveSafe(root,relative),{},Number.MAX_SAFE_INTEGER); }
async function verify(root: string, relative: string, expected: Proof): Promise<void> { const actual = await proof(root,relative); if(actual.sha256 !== expected.sha256 || actual.byteSize !== expected.byteSize) throw new DomainError('migration_conflict',`Файл изменён во время переноса: ${relative}. Исходные данные сохранены.`); }
async function walk(root: string, relative: string): Promise<string[]> {
  if(!await exists(root,relative)) return []; const absolute = await resolveSafe(root,relative), stat = await fs.lstat(absolute);
  if(stat.isSymbolicLink()) throw new DomainError('migration','Символические ссылки в переносимых папках не поддерживаются.');
  if(stat.isFile()) return [relative]; if(!stat.isDirectory()) throw new DomainError('migration','В переносимой папке найден специальный файл.');
  const result:string[]=[]; for(const name of (await fs.readdir(absolute)).sort()){ result.push(...await walk(root,`${relative}/${name}`)); if(result.length>100_000)throw new DomainError('migration_limit','Перенос содержит более 100000 файлов.'); } return result;
}
async function moveChecked(root: string, move: Move): Promise<void> {
  const from = await exists(root,move.from), to = await exists(root,move.to);
  if(to){ await verify(root,move.to,move); if(from)throw new DomainError('migration_conflict',`Одновременно существуют исходный и целевой файл: ${move.to}.`); return; }
  if(!from)throw new DomainError('migration_conflict',`Отсутствует файл переноса: ${move.from}.`); await verify(root,move.from,move); await fs.rename(await resolveSafe(root,move.from),await resolveSafe(root,move.to,true));
}
function planHash(marker: Omit<Marker,'format'|'version'|'phase'|'planHash'>): string { return digest(stableJSON({id:marker.id,moves:marker.moves,prepared:marker.prepared,aliases:marker.aliases,externalNotes:marker.externalNotes,baselines:marker.baselines,retainedRoot:marker.retainedRoot})); }
function allowedMetadata(relative: string): boolean { return relative === `${DATA_ROOT}/settings.json` || /^\.twdata\/projects\/[a-f0-9-]{36}\/(?:state\.json|(?:history|journal)\/[a-f0-9-]{36}\.json|recovery\/previous-state\.json)$/u.test(relative); }
function validateMarker(value: Marker): void {
  const fields = ['format','version','id','phase','moves','prepared','aliases','externalNotes','baselines','retainedRoot','planHash'];
  if(!value || Object.keys(value).some(key=>!fields.includes(key)) || value.format !== 'traceweave.hidden-layout-migration' || value.version !== 1 || !['prepared','files','published','complete'].includes(value.phase) || !Array.isArray(value.moves) || !Array.isArray(value.prepared) || !Array.isArray(value.aliases) || !Array.isArray(value.externalNotes) || !Array.isArray(value.baselines))throw new DomainError('migration','Повреждён протокол скрытого переноса.');
  requireId(value.id); if(value.retainedRoot!==`${DATA_ROOT}/recovery/layout-0.1.1/${value.id}/${OLD}` || value.planHash!==planHash(value))throw new DomainError('migration','Контрольная сумма плана переноса не совпала.');
  const targets = new Set<string>(), sources = new Set<string>(), external = new Set(value.externalNotes), recovery = `${DATA_ROOT}/recovery/layout-0.1.1/${value.id}`;
  for(const relative of external)if(!isAllowedNotePath(relative) || inside(relative,OLD))throw new DomainError('migration','Небезопасный внешний путь заметки.');
  for(const move of [...value.moves,...value.prepared]){
    if(!move || Object.keys(move).some(key=>!['from','to','sha256','byteSize'].includes(key)))throw new DomainError('migration','Неизвестное поле переноса.'); safeRelative(move.from);safeRelative(move.to);
    const staged = value.prepared.includes(move), sourceAllowed = staged ? inside(move.from,`${DATA_ROOT}/.migration-${value.id}/prepared`) : inside(move.from,OLD) || external.has(move.from);
    const targetAllowed = staged ? allowedMetadata(move.to) || (inside(move.to,NOTES_ROOT) && isAllowedNotePath(move.to)) || external.has(move.to) : inside(move.to,DATA_ROOT) || (inside(move.from,`${OLD}/notes`) && inside(move.to,NOTES_ROOT)) || (inside(move.from,`${OLD}/resources`) && inside(move.to,RESOURCES_ROOT));
    if(!sourceAllowed || !targetAllowed || move.from.split('/').some(part=>part.toLowerCase()==='.obsidian') || move.to.split('/').some(part=>part.toLowerCase()==='.obsidian') || (!staged && external.has(move.from) && !inside(move.to,recovery+'/external-notes')) || targets.has(move.to.toLowerCase()) || sources.has(move.from.toLowerCase()) || !/^[a-f0-9]{64}$/u.test(move.sha256) || !Number.isSafeInteger(move.byteSize) || move.byteSize<0)throw new DomainError('migration','Небезопасная запись переноса.');targets.add(move.to.toLowerCase());sources.add(move.from.toLowerCase());
  }
  for(const baseline of value.baselines){safeRelative(baseline.path);if(!inside(baseline.path,OLD) || !/^[a-f0-9]{64}$/u.test(baseline.sha256) || !Number.isSafeInteger(baseline.byteSize) || baseline.byteSize<0)throw new DomainError('migration','Неверная исходная контрольная сумма.');}
  for(const alias of value.aliases){safeRelative(alias.from);safeRelative(alias.to);if(alias.from.split('/').some(part=>part.startsWith('.') || part.toLowerCase()==='.obsidian') || ![DATA_ROOT,NOTES_ROOT,RESOURCES_ROOT].some(root=>inside(alias.to,root)))throw new DomainError('migration','Небезопасная таблица старых путей.');}
}
async function loadMarker(root: string): Promise<Marker|null> { if(!await exists(root,MARKER))return null; const marker = strictJSON<Marker>(await readUTF8(root,MARKER));validateMarker(marker);return marker; }

/** Complete the frozen 0.1.0 upgrade first; then move only service data to .twdata. */
export async function migrateLegacyVault(root: string, options: { fault?: (point: MigrationFaultPoint)=>void } = {}): Promise<void> {
  const marker = await loadMarker(root);
  if(marker){await migrateHidden(root,marker,options);return;}
  if(await exists(root,LEGACY_METADATA_ROOT) || await exists(root,`${OLD}/migration.json`))await migrateToTWData(root);
  if(await exists(root,OLD))await migrateHidden(root,null,options);
}
async function migrateHidden(root: string, marker: Marker|null, options: { fault?: (point: MigrationFaultPoint)=>void }): Promise<void> {
  if(marker?.phase==='complete'){if(await exists(root,OLD) || await exists(root,LEGACY_METADATA_ROOT))throw new DomainError('migration_conflict','После переноса вновь появилась старая папка данных. Автоматическое объединение запрещено.');return;}
  if(!await exists(root,OLD)){
    if(!marker || marker.phase!=='published' || !await exists(root,marker.retainedRoot))throw new DomainError('migration_conflict','Исходная папка переноса недоступна.');
    for(const move of [...marker.moves,...marker.prepared])await verify(root,move.to,move);marker.phase='complete';await atomic(root,MARKER,stableJSON(marker));return;
  }
  const repo = new ProjectRepository(root,{metadataRoot:OLD});
  try{
    await repo.initialize();repo.assertWritable();
    if(!marker){
      if((await walk(root,`${DATA_ROOT}/projects`)).length || await exists(root,`${DATA_ROOT}/writer.lock`))throw new DomainError('migration_conflict','.twdata уже содержит данные или активного писателя.');
      const id=randomUUID(),stage=`${DATA_ROOT}/.migration-${id}`,recovery=`${DATA_ROOT}/recovery/layout-0.1.1/${id}`,inventory=await walk(root,OLD),allStates:Project[]=[],journals:any[]=[];
      const projectsPath=await resolveSafe(root,`${OLD}/projects`);
      for(const entry of await fs.readdir(projectsPath,{withFileTypes:true})){
        if(entry.name==='.DS_Store' && entry.isFile() && !entry.isSymbolicLink())continue;
        if(!entry.isDirectory() || entry.isSymbolicLink())throw new DomainError('migration','Неожиданный объект в каталоге проектов.');requireId(entry.name);const p=await repo.read(entry.name);allStates.push(p);for(const snapshot of p.snapshots)await verifyReport(root,snapshot);
      }
      for(const file of inventory)if(/^TWData\/projects\/[^/]+\/(history|journal)\/[^/]+\.json$/u.test(file)){const kind=file.includes('/journal/')?'journal':'history',record=strictJSON<any>(await readUTF8(root,file));validateRecord(kind,record);if(kind==='history')allStates.push(record.before,record.after);else{if(!record.completed)throw new DomainError('migration','Журнал ещё не восстановлен.');journals.push(record);allStates.push(record.state,record.history.before,record.history.after);}}
      const moves=new Map<string,Move>(),prepared:Move[]=[],baselines:Marker['baselines']=[],targets=new Set<string>(),externalNotes:string[]=[],hashes=new Map<string,string>();
      const claim=async(from:string,to:string):Promise<void>=>{if(from===to || moves.has(from) || !await exists(root,from))return;if(targets.has(to.toLowerCase()) || await exists(root,to))throw new DomainError('migration_conflict',`Целевой файл уже существует: ${to}.`);moves.set(from,{from,to,...await proof(root,from)});targets.add(to.toLowerCase());};
      const prepare=async(relative:string,value:unknown):Promise<void>=>{const to=mapped(relative);if(targets.has(to.toLowerCase()) || await exists(root,to))throw new DomainError('migration_conflict',`Целевой файл уже существует: ${to}.`);if(await exists(root,relative))baselines.push({path:relative,...await proof(root,relative)});const from=`${stage}/prepared/${prepared.length}.json`,text=stableJSON(value);await atomic(root,from,text);prepared.push({from,to,sha256:digest(text),byteSize:Buffer.byteLength(text)});targets.add(to.toLowerCase());};
      const metadataFiles=new Set<string>();
      for(const file of inventory){
        const suffix=file.slice(OLD.length+1);if(suffix==='writer.lock')continue;
        const activeJSON=/^projects\/[^/]+\/(?:state\.json|(?:history|journal)\/[^/]+\.json|recovery\/previous-state\.json)$/u.test(suffix);
        if(activeJSON || suffix==='settings.json'){metadataFiles.add(file);continue;}
        const opaque=inside(suffix,'notes') || inside(suffix,'resources') || inside(suffix,'recovery') || inside(suffix,'exports') || /^projects\/[^/]+\/(?:reports|sources)\//u.test(suffix) || suffix==='migration.json';
        if(!opaque && file.endsWith('.json')){
          if(/\/view\.json$/u.test(file)){const view=strictJSON<any>(await readUTF8(root,file));if(!view || Array.isArray(view) || typeof view!=='object' || Object.keys(view).some(k=>!['selectedId','collapsedGroupIds','expandedNodeIds','mode','viewport'].includes(k)))throw new DomainError('migration','Неизвестный формат view.json.');}
          else if(/\/drafts\.json$/u.test(file)){const drafts=strictJSON<any>(await readUTF8(root,file));if(!drafts || drafts.formatVersion!==1 || !drafts.drafts || typeof drafts.drafts!=='object' || Array.isArray(drafts.drafts) || Object.keys(drafts).some(k=>!['formatVersion','drafts'].includes(k)))throw new DomainError('migration','Неизвестный формат drafts.json.');}
          else throw new DomainError('migration',`Неизвестный технический JSON: ${file}. Исходные данные сохранены.`);
        }
        await claim(file,mapped(file));
      }
      const oldAliases=await legacyAliases(root),aliases:Alias[]=[...oldAliases.map(alias=>({from:alias.from,to:mapped(alias.to)})),{from:`${OLD}/notes`,to:NOTES_ROOT},{from:`${OLD}/resources`,to:RESOURCES_ROOT},{from:OLD,to:DATA_ROOT},...[...moves.values()].map(move=>({from:move.from,to:move.to}))].filter(alias=>!alias.from.split('/').some(part=>part.startsWith('.')));
      for(const move of moves.values())if(inside(move.to,NOTES_ROOT) && move.from.endsWith('.md'))aliases.push({from:move.from.slice(0,-3),to:move.to.slice(0,-3)});
      const destinations=new Map(aliases.map(alias=>[alias.from,alias.to]));
      const rewrite=(oldPath:string,text:string):string=>{const result=rewriteMovedNoteLinks(text,oldPath,mapped(oldPath),destinations);if(Buffer.byteLength(result)>5_242_880)throw new DomainError('file_limit','Перенос ссылок превысил лимит заметки 5 MiB.');hashes.set(oldPath+'\0'+digest(text),digest(result));return result;};
      for(const move of [...moves.values()])if(inside(move.to,NOTES_ROOT) && /\.md$/iu.test(move.from)){
        if(move.byteSize>5_242_880)throw new DomainError('file_limit','Управляемая заметка превышает лимит переноса 5 MiB.');const text=await readUTF8(root,move.from),changed=rewrite(move.from,text);if(changed===text)continue;
        const retained=`${recovery}/notes/${move.from}`;targets.delete(move.to.toLowerCase());targets.add(retained.toLowerCase());moves.set(move.from,{...move,to:retained});const from=`${stage}/prepared/${prepared.length}.md`;await atomic(root,from,changed);prepared.push({from,to:move.to,sha256:digest(changed),byteSize:Buffer.byteLength(changed)});targets.add(move.to.toLowerCase());
      }
      for(const journal of journals)for(const effect of journal.effects){rewrite(effect.path,effect.after);if(effect.before!==null)rewrite(effect.path,effect.before);}
      let count=0,total=0;
      const scan=async(relative=''):Promise<void>=>{for(const entry of await fs.readdir(relative?await resolveSafe(root,relative):root,{withFileTypes:true})){
        if(entry.name.startsWith('.') || entry.isSymbolicLink() || (!relative && [OLD,LEGACY_METADATA_ROOT].includes(entry.name)))continue;const file=relative?`${relative}/${entry.name}`:entry.name;if(entry.isDirectory()){await scan(file);continue;}if(!entry.isFile() || !isAllowedNotePath(file) || moves.has(file))continue;
        const stat=await fs.stat(await resolveSafe(root,file));count++;total+=stat.size;if(count>50_000 || total>67_108_864 || stat.size>5_242_880)throw new DomainError('migration_limit','Проверка обратных ссылок превышает лимит 50000 заметок/64 MiB/5 MiB на файл.');const text=await readUTF8(root,file),changed=rewrite(file,text);if(changed===text)continue;const original=await proof(root,file);if(original.sha256!==digest(text))throw new DomainError('migration_conflict','Заметка изменилась во время сверки ссылок.');const to=`${recovery}/external-notes/${file}`;if(targets.has(to.toLowerCase()) || await exists(root,to))throw new DomainError('migration_conflict','Конфликт резервной копии заметки.');moves.set(file,{from:file,to,...original});targets.add(to.toLowerCase());const from=`${stage}/prepared/${prepared.length}.md`;await atomic(root,from,changed);prepared.push({from,to:file,sha256:digest(changed),byteSize:Buffer.byteLength(changed)});targets.add(file.toLowerCase());externalNotes.push(file);
      }};await scan();
      const transform=(input:Project):Project=>{const p=structuredClone(input);for(const node of p.nodes){if(node.noteHash)node.noteHash=hashes.get(node.notePath+'\0'+node.noteHash)??node.noteHash;node.notePath=mapped(node.notePath);}for(const blob of p.blobs)blob.path=mapped(blob.path);for(const snapshot of p.snapshots)snapshot.path=mapped(snapshot.path);const retained=p.importedData.retainedSource as {path?:string}|undefined;if(retained?.path)retained.path=mapped(retained.path);validateProject(p);return p;};
      for(const input of allStates)for(const blob of input.blobs)if(inside(blob.path,`${OLD}/resources`))await verify(root,blob.path,blob);
      for(const file of metadataFiles){
        if(file===`${OLD}/settings.json`){const value=strictJSON<any>(await readUTF8(root,file));if(!value || Object.keys(value).some(k=>!['notesRoot','resourcesRoot'].includes(k)) || typeof value.notesRoot!=='string' || typeof value.resourcesRoot!=='string' || !inside(value.notesRoot,`${OLD}/notes`) || !inside(value.resourcesRoot,`${OLD}/resources`))throw new DomainError('migration','Неизвестный формат настроек.');await prepare(file,{notesRoot:mapped(value.notesRoot),resourcesRoot:mapped(value.resourcesRoot)});continue;}
        if(file.endsWith('/state.json') || file.endsWith('/recovery/previous-state.json')){const p=strictJSON<Project>(await readUTF8(root,file));validateProject(p);await prepare(file,transform(p));continue;}
        const kind=file.includes('/journal/')?'journal':'history',record=strictJSON<any>(await readUTF8(root,file));validateRecord(kind,record);
        if(kind==='history'){record.before=transform(record.before);record.after=transform(record.after);}else{record.state=transform(record.state);record.history.before=transform(record.history.before);record.history.after=transform(record.history.after);record.effects=record.effects.map((effect:{path:string;before:string|null;after:string})=>({...effect,path:mapped(effect.path),before:effect.before===null?null:rewrite(effect.path,effect.before),after:rewrite(effect.path,effect.after)}));record.beforeHash=digest(stableJSON(record.history.before));record.afterHash=digest(stableJSON(record.state));}validateRecord(kind,record);await prepare(file,record);
      }
      if(!metadataFiles.has(`${OLD}/settings.json`))await prepare(`${OLD}/settings.json`,{notesRoot:NOTES_ROOT,resourcesRoot:RESOURCES_ROOT});
      marker={format:'traceweave.hidden-layout-migration',version:1,id,phase:'prepared',moves:[...moves.values()],prepared,aliases,externalNotes,baselines,retainedRoot:`${recovery}/${OLD}`,planHash:''};marker.planHash=planHash(marker);validateMarker(marker);await atomic(root,MARKER,stableJSON(marker));options.fault?.('after-prepared');
    }
    for(const baseline of marker.baselines)await verify(root,baseline.path,baseline);
    if(marker.phase==='prepared'){for(const move of marker.moves)await moveChecked(root,move);marker.phase='files';await atomic(root,MARKER,stableJSON(marker));options.fault?.('after-files');}
    if(marker.phase==='files'){for(const move of marker.prepared)await moveChecked(root,move);marker.phase='published';await atomic(root,MARKER,stableJSON(marker));options.fault?.('after-published');}
    for(const move of [...marker.moves,...marker.prepared])await verify(root,move.to,move);
    const expected=new Set([...marker.baselines.map(item=>item.path),`${OLD}/writer.lock`]);for(const file of await walk(root,OLD))if(!expected.has(file))throw new DomainError('migration_conflict',`В исходной папке появился новый файл: ${file}. Перенос остановлен.`);
    if(!await exists(root,marker.retainedRoot))await fs.rename(await resolveSafe(root,OLD),await resolveSafe(root,marker.retainedRoot,true));
    const lock=`${marker.retainedRoot}/writer.lock`;if(await exists(root,lock)){const value=strictJSON<{instanceId:string}>(await readUTF8(root,lock));if(value.instanceId===repo.instanceId)await fs.unlink(await resolveSafe(root,lock));}
    options.fault?.('after-retained');marker.phase='complete';await atomic(root,MARKER,stableJSON(marker));
  }finally{await repo.dispose();}
}
export async function getMigratedPath(root: string, oldPath: string): Promise<string|null> { return aliasPath(root,oldPath,false); }
export async function getOriginalPath(root: string, newPath: string): Promise<string|null> { return aliasPath(root,newPath,true); }
async function aliasPath(root: string, value: string, reverse: boolean): Promise<string|null> {
  safeRelative(value);const marker=await loadMarker(root);if(!marker || marker.phase!=='complete')return null;
  if(reverse)return marker.aliases.find(alias=>alias.to===value)?.from??null;
  const match=[...marker.aliases].sort((a,b)=>b.from.length-a.from.length).find(alias=>inside(value,alias.from));return match?match.to+value.slice(match.from.length):null;
}

import { t } from './i18n';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { obsidianProject, archiveManifest, archiveProject, archiveSnapshot, archivePresentation, archiveOrigin, legacyInitialManifest, legacyInitialProject, legacyModernManifest, legacyModernProject } from './generated/validators';
import { DATA_ROOT, NOTES_ROOT, RESOURCES_ROOT, LEGACY_METADATA_ROOT, TRANSITIONAL_METADATA_ROOT, isAllowedResourcePath, isAllowedSnapshotPath } from './storage/layout';
import pluginManifest from '../manifest.json';
import type { ValidateFunction } from 'ajv';
import type { ArchiveProject, ArchiveReportDefinition, ArchiveReportSnapshot, ArchiveReportSnapshotAsset, ArchiveSnapshotContent, ArchiveOrigin, ArchiveManifest, ArchivePresentation } from './archive-types';
import { parse, visit, type ParseError } from 'jsonc-parser';
import archiveIndex from '../contracts/archive-index.json';
import { validateProject } from './domain';
import type { Project, ProjectNode, Relation, Evidence, SnapshotRecord, BlobRecord, Asset, NodeType, Attachment } from './types';
import { copyChecked, digestFile, resolveSafe, safeRelative, safeSuffix, verifiedMediaInfo, visibleBlobPath, MAX_ORIGINAL_BYTES } from './storage/files';

const MAX_ENTRIES = 50_000, MAX_ARCHIVE = 10_737_418_240, MAX_TOTAL = 21_474_836_480;
const HASH = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const metadataRoots = [DATA_ROOT, TRANSITIONAL_METADATA_ROOT, LEGACY_METADATA_ROOT];
type ObjectJSON = Record<string, unknown>;
const isRecord = (value: unknown): value is ObjectJSON => value !== null && typeof value === 'object' && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
function objectJSON(value: unknown): ObjectJSON { if (!isRecord(value)) throw new Error('Expected JSON object'); return value; }
interface Proof { path: string; sha256: string; byteSize: number }
interface BundleFile extends Proof { kind: 'project' | 'note' | 'blob' | 'snapshot' | 'report' | 'source'; originalPath?: string }
interface Extracted { absolute: string; proof: Proof }
export interface StagedImport { project: Project; commit(): Promise<void>; rollback(): Promise<void> }
export interface StagedImportOptions { projectFolder?: (project: Project) => Promise<string>; reportsFolder?: (project: Project) => Promise<string> }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const stringify = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function strictJSON(source: string): unknown {
  if (Buffer.byteLength(source)>67_108_864) throw new Error('JSON byte limit'); if(source.startsWith('\uFEFF'))source=source.slice(1); const errors: ParseError[] = [], stack: Set<string>[] = []; let depth=0; const enter=()=>{if(++depth>128)throw new Error('JSON nesting limit');};
  visit(source, { onObjectBegin: () => { enter(); stack.push(new Set()); }, onObjectProperty: name => { const keys = stack.at(-1)!; if (keys.has(name)) throw new Error('Duplicate JSON object key'); keys.add(name); }, onObjectEnd: () => { stack.pop(); depth--; }, onArrayBegin:enter, onArrayEnd:()=>{depth--;} }, { disallowComments: true, allowTrailingComma: false });
  const result: unknown = parse(source, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || result === undefined) throw new Error('Invalid strict JSON');
  const exact: unknown=JSON.parse(source);const scalar=(value:unknown):void=>{if(typeof value==='string'&&/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw new Error('Invalid Unicode scalar');if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid JSON number');if(isArray(value))for(const item of value)scalar(item);else if(isRecord(value))for(const [key,item]of Object.entries(value)){scalar(key);scalar(item);}};scalar(exact);return exact;
}
async function readUTF8(absolute:string):Promise<string>{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.readFile(absolute));}
interface ArchiveDefinitions { Manifest: ArchiveManifest; Project: ArchiveProject; Snapshot: ArchiveReportSnapshot; Presentation: ArchivePresentation; Origin: ArchiveOrigin }
const archiveRules: Record<keyof ArchiveDefinitions, ValidateFunction> = { Manifest: archiveManifest, Project: archiveProject, Snapshot: archiveSnapshot, Presentation: archivePresentation, Origin: archiveOrigin };
function validationErrors(validate: ValidateFunction): string { return validate.errors?.map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ') ?? 'invalid value'; }
function archiveValidator<K extends keyof ArchiveDefinitions>(definition: K, value: unknown): asserts value is ArchiveDefinitions[K] {
  const validate = archiveRules[definition];
  if (!validate(value)) throw new Error(`Archive ${definition} schema rejected: ${validationErrors(validate)}`);
}

function pathKey(value: string): string { return value.normalize('NFC').toLowerCase(); }
function entryLimit(name: string): number { if (/^sources\/[a-f0-9]{64}\.zip$/u.test(name)) return MAX_ARCHIVE; if (name === 'manifest.json') return 16_777_216; if (name === 'project.json' || name.endsWith('/snapshot.json')) return 67_108_864; if (name === 'presentation.json') return 65_536; return MAX_ORIGINAL_BYTES; }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function updateCRC(crc: number, bytes: Buffer): number { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
async function extractZIP(zipPath: string, staging: string): Promise<Map<string, Extracted>> {
  const stat = await fs.lstat(zipPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE) throw new Error('Invalid ZIP or archive byte limit');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
  try {
    const entries = await new Promise<yauzl.Entry[]>((resolve, reject) => {
      const list: yauzl.Entry[] = [], names = new Set<string>(); let total = 0;
      zip.on('error', reject); zip.on('end', () => resolve(list));
      zip.on('entry', (entry: yauzl.Entry) => { try {
        safeRelative(entry.fileName); const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (entry.fileName.endsWith('/') || (mode !== 0 && mode !== 0x8000) || (entry.generalPurposeBitFlag & 1) || ![0,8].includes(entry.compressionMethod)) throw new Error('Unsupported ZIP entry type, encryption or compression');
        const name = pathKey(entry.fileName); if (names.has(name) || list.length >= MAX_ENTRIES) throw new Error('Duplicate ZIP entry or entry count limit'); names.add(name);
        if (entry.uncompressedSize > entryLimit(entry.fileName) || entry.uncompressedSize > MAX_TOTAL - total || (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize > entry.compressedSize * 1000))) throw new Error('ZIP expansion/size limit');
        total += entry.uncompressedSize; list.push(entry); zip.readEntry();
      } catch (error) { reject(error instanceof Error ? error : new Error('ZIP entry rejected', {cause:error})); } }); zip.readEntry();
    });
    if (!(entries.some(e=>e.fileName==='manifest.json')&&entries.some(e=>e.fileName==='project.json'))&&!(entries.some(e=>e.fileName==='metadata/files.json')&&entries.some(e=>e.fileName==='metadata/snapshot.json'))) throw new Error('Archive manifest/project or legacy Obsidian metadata missing');
    const space = await fs.statfs(staging); const declared = entries.reduce((sum, e) => sum + e.uncompressedSize, 0); if (space.bavail * space.bsize < declared + 134_217_728) throw new Error('Insufficient free storage for archive staging');
    const output = new Map<string, Extracted>();
    for (const [index, entry] of entries.entries()) {
      const source = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
      const absolute = path.join(staging, String(index)); let count = 0, crc = 0xffffffff; const digest = createHash('sha256');
      const checker = new Transform({ transform(chunk: Buffer, _enc, callback) { count += chunk.length; if (count > entry.uncompressedSize || count > entryLimit(entry.fileName)) { callback(new Error('ZIP inflated beyond declared bounds')); return; } digest.update(chunk); crc = updateCRC(crc, chunk); callback(null, chunk); } });
      await pipeline(source, checker, createWriteStream(absolute, { flags: 'wx', mode: 0o600 }));
      if (count !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('ZIP size/CRC mismatch');
      output.set(entry.fileName, { absolute, proof: { path: entry.fileName, byteSize: count, sha256: digest.digest('hex') } });
    }
    return output;
  } finally { zip.close(); }
}
async function readJSON(entries: Map<string, Extracted>, name: string): Promise<unknown> { const entry = entries.get(name); if (!entry) throw new Error(`Missing archive file ${name}`); if(entry.proof.byteSize>67_108_864)throw new Error('JSON byte limit'); return strictJSON(await readUTF8(entry.absolute)); }
interface ImportFile extends Proof { kind?: BundleFile['kind']; originalPath?: string }
interface ImportManifest extends ObjectJSON { format: string; formatVersion: string; files: ImportFile[] }
function proofJSON(value: unknown): Proof {
  const item = objectJSON(value);
  if (typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !HASH.test(item.sha256) || typeof item.byteSize !== 'number' || !Number.isSafeInteger(item.byteSize) || item.byteSize < 0) throw new Error('Invalid file proof');
  return { path: item.path, sha256: item.sha256, byteSize: item.byteSize };
}
function importManifest(value: unknown): ImportManifest {
  const manifest = objectJSON(value);
  if (typeof manifest.format !== 'string' || typeof manifest.formatVersion !== 'string' || !isArray(manifest.files) || manifest.files.length > MAX_ENTRIES) throw new Error('Invalid manifest files');
  const files = manifest.files.map(value => {
    const item = objectJSON(value), proof = proofJSON(item);
    if (item.kind !== undefined && (typeof item.kind !== 'string' || !['project','note','blob','snapshot','report','source'].includes(item.kind))) throw new Error('Invalid backup payload kind');
    if (item.originalPath !== undefined && typeof item.originalPath !== 'string') throw new Error('Invalid backup payload path');
    return { ...proof, ...(item.kind === undefined ? {} : {kind: item.kind as BundleFile['kind']}), ...(typeof item.originalPath === 'string' ? {originalPath: item.originalPath} : {}) };
  });
  return { ...manifest, format: manifest.format, formatVersion: manifest.formatVersion, files };
}
function backupFiles(files: ImportFile[]): BundleFile[] { return files.map(file => { if (file.kind === undefined) throw new Error('Invalid backup payload kind'); return { ...file, kind: file.kind }; }); }
function projectJSON(value: unknown): Project { const project = value as Project; validateProject(project); return project; }
function retainedSource(value: unknown): (ObjectJSON & Proof) | undefined { if (value === undefined) return undefined; return { ...objectJSON(value), ...proofJSON(value) }; }
function retainedPathAllowed(value: string, projectId: string): boolean {
  safeRelative(value);
  return metadataRoots.some(root => value.startsWith(`${root}/projects/${projectId}/sources/`)) || (isAllowedResourcePath(value) && value.includes('/projects/') && /\/archives\/source-[a-f0-9]{64}\.zip$/u.test(value));
}
function validateProofs(manifest: ImportManifest, entries: Map<string, Extracted>): void {
  const listed = new Set<string>();
  for (const item of manifest.files) {
    safeRelative(item.path); const proof = entries.get(item.path)?.proof;
    if (listed.has(item.path) || !proof || proof.sha256 !== item.sha256 || proof.byteSize !== item.byteSize) throw new Error('Manifest file hash/size mismatch'); listed.add(item.path);
  }
  if (listed.size !== entries.size - 1 || listed.has('manifest.json') || !listed.has('project.json')) throw new Error('Manifest must enumerate every archive payload exactly once');
}
async function writeExclusive(root: string, relative: string, value: string): Promise<void> { const absolute = await resolveSafe(root, relative, true); await fs.writeFile(absolute, value, { flag: 'wx', mode: 0o600 }); }

export async function exportProject(vaultRoot: string, project: Project, outputPath: string, metadataRoot = DATA_ROOT): Promise<void> {
  validateProject(project); safeRelative(metadataRoot);
  const copy = structuredClone(project), files: { source?: string; data?: Buffer; entry: BundleFile }[] = [], paths = new Set<string>();
  async function add(sourcePath: string, kind: BundleFile['kind'], expected?: { sha256: string; byteSize: number }): Promise<void> {
    if (paths.has(sourcePath)) return; paths.add(sourcePath);
    const source = await resolveSafe(vaultRoot, sourcePath), proof = await digestFile(source, {}, kind === 'note' ? 5_242_880 : kind === 'source' ? MAX_ARCHIVE : entryLimit(sourcePath));
    if (expected && (proof.sha256 !== expected.sha256 || proof.byteSize !== expected.byteSize)) throw new Error('Export original is missing/changed');
    files.push({ source, entry: { path: kind==='source'?`sources/${proof.sha256}.zip`:`files/${files.length}`, originalPath: sourcePath, kind, ...proof } });
  }
  for (const node of copy.nodes) { if (node.missing) throw new Error('Cannot export project with missing notes'); await add(node.notePath, 'note'); const f = files.find(v => v.entry.originalPath === node.notePath)!; node.noteHash = f.entry.sha256; }
  for (const blob of copy.blobs) await add(blob.path, 'blob', blob);
  async function addTree(relative: string): Promise<void> {
    const absolute = await resolveSafe(vaultRoot, relative); const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Report symlink rejected');
    if (stat.isDirectory()) { for (const name of (await fs.readdir(absolute)).sort()) await addTree(`${relative}/${name}`); }
    else if (stat.isFile()) await add(relative, relative.endsWith('/snapshot.json') ? 'snapshot' : 'report'); else throw new Error('Unsupported report file');
  }
  for (const snapshot of copy.snapshots) {
    if (!isAllowedSnapshotPath(snapshot.path, copy.id, snapshot.id)) throw new Error('Invalid report path');
    await verifyReport(vaultRoot,snapshot); await addTree(path.posix.dirname(snapshot.path));
  }
  const retained=retainedSource(copy.importedData.retainedSource);if(retained){if(!retainedPathAllowed(retained.path,copy.id))throw new Error('Invalid retained source path');await add(retained.path,'source',retained);}
  const projectData = Buffer.from(stringify(copy)); if(projectData.length>67_108_864)throw new Error('Project JSON byte limit'); files.unshift({ data: projectData, entry: { path: 'project.json', kind: 'project', byteSize: projectData.length, sha256: hash(projectData) } });
  if (files.length + 1 > MAX_ENTRIES || files.reduce((sum, f) => sum + f.entry.byteSize, 0) > MAX_TOTAL) throw new Error('Export archive limit');
  const manifest = { format: 'traceweave.obsidian-backup', formatVersion: '1.0', requiredFeatures: ['centralized-metadata.v1'], sourceProjectId: copy.id, sourceRevision: copy.revision, exportedAt: new Date().toISOString(), files: files.map(f => f.entry) };
  await writePayloadZIP(vaultRoot,outputPath,[...files.map(f=>({source:f.source,data:f.data,proof:f.entry})),{data:Buffer.from(stringify(manifest)),proof:{path:'manifest.json',byteSize:Buffer.byteLength(stringify(manifest)),sha256:hash(stringify(manifest))}}]);
}

interface ZipPayload { source?: string; data?: Buffer; proof: Proof }
async function writePayloadZIP(vaultRoot:string,outputPath:string,files:ZipPayload[]):Promise<void> {
  let outputRelative = outputPath;
  if (path.isAbsolute(outputPath)) {
    const absoluteOutput = path.resolve(outputPath), canonicalRoot = await fs.realpath(vaultRoot);
    const relative = [path.resolve(vaultRoot), canonicalRoot].map(root => path.relative(root, absoluteOutput)).find(value => value !== '' && value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value));
    if (relative === undefined) throw new Error('Export destination must stay inside the vault');
    // Resolve descendants through resolveSafe below; realpath(outputPath) could hide an unsafe symlink.
    outputRelative = relative.split(path.sep).join('/');
  }
  const destination = await resolveSafe(vaultRoot, outputRelative, true), temporary = `${destination}.${randomUUID()}.pending`;
  try {
    try { await fs.lstat(destination); throw new Error('Export destination already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const zip = new yazl.ZipFile() as yazl.ZipFile & { addReadStreamLazy(name: string, options: { size: number; compress: boolean }, get: (callback: (error: Error | null, stream?: Readable) => void) => void): void }; const completed = pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    for (const f of files) {
      if (f.data) zip.addBuffer(f.data, f.proof.path, { compress: false });
      else {
        zip.addReadStreamLazy(f.proof.path, { size: f.proof.byteSize, compress: false }, callback => {
          let bytes = 0; const digest = createHash('sha256');
          const checker = new Transform({ transform(chunk: Buffer, _enc, done) { bytes += chunk.length; digest.update(chunk); done(null, chunk); }, flush(done) { done(bytes === f.proof.byteSize && digest.digest('hex') === f.proof.sha256 ? undefined : new Error('Source changed during export')); } });
          const source = createReadStream(f.source!); source.on('error', error => checker.destroy(error)); source.pipe(checker); callback(null, checker);
        });
      }
    }
    zip.end(); await completed;
    if ((await fs.stat(temporary)).size > MAX_ARCHIVE) throw new Error('ZIP compressed byte limit');
    await fs.link(temporary, destination); await fs.unlink(temporary);
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function identityMap(value: unknown, map = new Map<string, string>(), collection=''): Map<string, string> {
  map.set('__typed','1');
  if (isArray(value)) for (const item of value) identityMap(item, map, collection);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
    if (['origin','extensions','importedData','importProvenance','producer'].includes(key)) continue;
    if (['id','investigationId','typeId','nodeId','sourceNodeId','targetNodeId','blobId','assetId','subjectId','groupNodeId','memberNodeId','reportDefinitionId','snapshotId','deletionBatchId','objectId','inspector','projectId'].includes(key) && typeof item === 'string' && UUID.test(item) && !map.has(item)) map.set(item, randomUUID());
    if(key==='id'&&typeof item==='string'&&map.has(item)){const kind=({nodes:'node',assets:'asset',relations:'relation',blobs:'blob'} as Record<string,string>)[collection];if(kind)map.set(kind+':'+item,map.get(item)!);}
    identityMap(item, map,key);
  }
  return map;
}
// Only string identities/destinations change, so the input structure is preserved.
function remap<T>(value: T, map: Map<string, string>, key = ''): T {
  const visit = (item: unknown, field: string): unknown => {
    if (['origin','extensions','importedData','importProvenance','producer'].includes(field)) return item;
    if (isArray(item)) return item.map(child => visit(child, field));
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([name,child]) => [name, visit(child,name)]));
    if (typeof item === 'string') {
      if (['id','investigationId','typeId','nodeId','sourceNodeId','targetNodeId','blobId','assetId','subjectId','groupNodeId','memberNodeId','reportDefinitionId','snapshotId','deletionBatchId','objectId','inspector','projectId','nodeIds','relationIds','assetIds','selectedNodeIds','orderedConclusionIds'].includes(field)) { if (UUID.test(item) && !map.has(item)) throw new Error('Unresolved archive UUID reference'); return map.get(item) ?? item; }
      if (['bodyMarkdown','descriptionMarkdown','noteMarkdown','introductionMarkdown','note'].includes(field)) return remapMarkdown(item,map);
    }
    return item;
  };
  return visit(value,key) as T;
}
// Rewrite typed destinations, preserving inline/fenced code and arbitrary prose UUIDs.
export function remapMarkdown(source: string, map: Map<string, string>): string {
  let fence: string | null = null;
  return source.split(/(\r?\n)/u).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (marker) { if (!fence) fence = marker[1]!; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; return line; }
    if (fence) return line;
    return line.split(/(`+[^`]*`+)/u).map((part, index) => index % 2 ? part : part.replace(/(\]\(\s*<?|^ {0,3}\[[^\]]+\]:\s*<?|<)((?:node|asset|relation):)([a-f0-9-]{36})(?=[#\s>)])/gu, (_all, prefix: string, kind: string, id: string) => { const target = map.get(map.has('__typed')?kind+id:id); if (!target) throw new Error('Unresolved Markdown archive reference'); return prefix + kind + target; })).join('');
  }).join('');
}
function validateArchiveReferences(raw: ArchiveProject): void {
  const collectionNames = ['nodeTypes','relationTypes','nodes','attributes','relations','assets','attachments','evidence','reports','snapshots','deletionBatches','blobs'] as const;
  type Collection = typeof collectionNames[number]; type Entry = ArchiveProject[Collection][number];
  const indexes = new Map<Collection, Map<string,Entry>>(), seen = new Set<string>([raw.investigation.id]);
  for (const name of collectionNames) { const index = new Map<string,Entry>(); for (const item of raw[name]) { if (seen.has(item.id) || ('investigationId' in item && item.investigationId !== raw.investigation.id)) throw new Error('Duplicate or foreign archive identity'); seen.add(item.id); index.set(item.id,item); } indexes.set(name,index); }
  const lookup = <K extends Collection>(name: K, id: string): ArchiveProject[K][number] => { const item = indexes.get(name)?.get(id); if (!item) throw new Error(`Missing ${name} reference`); return item; };
  const unique=(values:unknown[],label:string)=>{if(new Set(values).size!==values.length)throw new Error('Duplicate semantic key '+label);};
  for(const name of ['nodeTypes','relationTypes'] as const)unique(raw[name].map((item)=>item.code),name);
  const opaque=(value:unknown):void=>{if(typeof value==='string'&&(seen.has(value)||/(?:node|asset|relation):/u.test(value)))throw new Error('Unsupported identity in opaque extensions');if(isArray(value))for(const item of value)opaque(item);else if(isRecord(value))for(const item of Object.values(value))opaque(item);};
  const layouts = new Set<string>(); for (const item of raw.layouts) { lookup('nodes',item.nodeId); if (item.investigationId !== raw.investigation.id || layouts.has(item.nodeId)) throw new Error('Invalid layout'); layouts.add(item.nodeId); } if (layouts.size !== raw.nodes.length) throw new Error('Every node requires a layout');
  for (const node of raw.nodes) {lookup('nodeTypes',node.typeId);opaque(node.extensions);}
  for(const name of ['nodes','relations','assets'] as const)for(const item of raw[name]){if((item.deletedAt===null)!==(item.deletionBatchId===null))throw new Error('Inconsistent deletion metadata');if(item.deletionBatchId!==null)lookup('deletionBatches',item.deletionBatchId);}
  for (const relation of raw.relations) { const from=lookup('nodes',relation.sourceNodeId),to=lookup('nodes',relation.targetNodeId); if (from.id===to.id||(!relation.deletedAt&&(from.deletedAt||to.deletedAt))||(relation.bidirectional&&!relation.directed)||!raw.relationTypes.some((type) => type.code === relation.relationType)) throw new Error('Invalid relation endpoints/type'); }
  const attrs:string[]=[];
  for (const attribute of raw.attributes) {lookup('nodes',attribute.nodeId);const normalized=attribute.key.normalize('NFC').toLowerCase().replace(/ß/gu,'ss').replace(/ς/gu,'σ').trim();if(attribute.normalizedKey!==normalized)throw new Error('Incorrect normalized attribute key');attrs.push(attribute.nodeId+':'+attribute.normalizedKey);}unique(attrs,'attributes');
  unique(raw.blobs.map((blob)=>blob.sha256+':'+blob.byteSize),'blobs');
  for (const asset of raw.assets) { const blob = lookup('blobs',asset.blobId); if (blob.sha256 !== asset.sha256 || blob.byteSize !== asset.byteSize) throw new Error('Asset/blob integrity mismatch'); }
  const memberIds:string[]=[];
  for(const member of raw.memberships){const group=lookup('nodes',member.groupNodeId),node=lookup('nodes',member.memberNodeId),groupType=lookup('nodeTypes',group.typeId),nodeType=lookup('nodeTypes',node.typeId);if(member.investigationId!==raw.investigation.id||group.id===node.id||groupType.code!=='group'||!groupType.isSystem||nodeType.code==='group'||group.deletedAt||node.deletedAt)throw new Error('Invalid group membership');memberIds.push(node.id);}unique(memberIds,'memberships');
  const pairs:string[]=[],primaries:string[]=[];
  for (const attachment of raw.attachments) { const node=lookup('nodes',attachment.nodeId),asset=lookup('assets',attachment.assetId);if(!node.deletedAt&&asset.deletedAt)throw new Error('Active attachment to trash');pairs.push(node.id+':'+asset.id);if(attachment.role==='primary')primaries.push(node.id); }unique(pairs,'attachments');unique(primaries,'primary attachments');
  for (const evidence of raw.evidence) { lookup(evidence.subjectKind === 'node' ? 'nodes':'relations',evidence.subjectId); if (evidence.sourceKind === 'node') lookup('nodes',evidence.sourceNodeId); if (evidence.sourceKind === 'asset') lookup('assets',evidence.assetId); }
  for (const report of raw.reports) {for (const id of [...report.selectedNodeIds,...report.orderedConclusionIds])lookup('nodes',id);for(const id of report.orderedConclusionIds){const node=lookup('nodes',id);if(lookup('nodeTypes',node.typeId).code!=='conclusion'||(report.scopeMode==='selection'&&!report.selectedNodeIds.includes(id)))throw new Error('Invalid report conclusion scope');}}
  const historicalKinds=new Map<string,string>();for(const [kind,index]of indexes)for(const id of index.keys())historicalKinds.set(id,kind);
  const pinKeys:string[]=[];
  for (const pin of raw.snapshotAssets) { const snapshot = lookup('snapshots',pin.snapshotId); lookup('assets',pin.assetId);const blob=lookup('blobs',pin.blobId),historical=snapshot.content.assets.find((asset) => asset.id === pin.assetId && asset.blobId === pin.blobId); if (pin.investigationId !== raw.investigation.id || !historical || historical.sha256!==blob.sha256 || historical.byteSize!==blob.byteSize) throw new Error('Invalid snapshot pin');pinKeys.push(pin.snapshotId+':'+pin.assetId); }unique(pinKeys,'snapshot pins');
  for(const snapshot of raw.snapshots){
    lookup('reports',snapshot.reportDefinitionId);const content=snapshot.content;if(content.definition.id!==snapshot.reportDefinitionId||content.definition.investigationId!==raw.investigation.id)throw new Error('Historical report identity mismatch');
    type HistoricalCollection = 'nodes' | 'attributes' | 'relations' | 'nodeTypes' | 'relationTypes' | 'attachments' | 'assets';
    type HistoricalEntry = ArchiveSnapshotContent[HistoricalCollection][number];
    const historical=new Map<HistoricalCollection,Map<string,HistoricalEntry>>();
    for(const kind of ['nodes','attributes','relations','nodeTypes','relationTypes','attachments','assets'] as const){const index=new Map<string,HistoricalEntry>();for(const item of content[kind]){if(index.has(item.id)||('investigationId' in item&&item.investigationId!==raw.investigation.id)||item.id===raw.investigation.id||(historicalKinds.has(item.id)&&historicalKinds.get(item.id)!==kind))throw new Error('Duplicate/foreign historical identity');historicalKinds.set(item.id,kind);index.set(item.id,item);}historical.set(kind,index);}
    const local=<K extends HistoricalCollection>(kind:K,id:string): ArchiveSnapshotContent[K][number]=>{const item=historical.get(kind)?.get(id);if(!item)throw new Error('Missing historical '+kind+' reference');return item;};
    for(const node of content.nodes)local('nodeTypes',node.typeId);
    for(const relation of content.relations){local('nodes',relation.sourceNodeId);local('nodes',relation.targetNodeId);if(!content.relationTypes.some((type)=>type.code===relation.relationType))throw new Error('Unknown historical relation type');}
    for(const attribute of content.attributes)local('nodes',attribute.nodeId);
    for(const attachment of content.attachments){local('nodes',attachment.nodeId);local('assets',attachment.assetId);}
    const evidenceIds=new Set<string>();for(const wrapper of content.evidence){const item=wrapper.evidence;if(evidenceIds.has(item.id)||item.investigationId!==raw.investigation.id||(historicalKinds.has(item.id)&&historicalKinds.get(item.id)!=='evidence'))throw new Error('Historical evidence identity mismatch');evidenceIds.add(item.id);historicalKinds.set(item.id,'evidence');local(item.subjectKind==='node'?'nodes':'relations',item.subjectId);if(wrapper.sourceStatus==='outside_scope'&&wrapper.sourceTitle!==null)throw new Error('Outside-scope source title leak');if(wrapper.sourceStatus==='included'){if(item.sourceKind==='node')local('nodes',item.sourceNodeId);if(item.sourceKind==='asset')local('assets',item.assetId);}}
    for(const asset of content.assets)if(!pinKeys.includes(snapshot.id+':'+asset.id))throw new Error('Missing historical blob pin');
    for(const warning of content.warnings){if(warning.objectKind==='evidence'){if(!evidenceIds.has(warning.objectId))throw new Error('Missing historical warning target');}else local(warning.objectKind==='node'?'nodes':warning.objectKind==='asset'?'assets':'relations',warning.objectId);}
  }
  for(const batch of raw.deletionBatches){for(const [name,key]of [['nodes','nodeIds'],['relations','relationIds'],['assets','assetIds']] as const){unique(batch[key],key);for(const id of batch[key]){const item=lookup(name,id);if(item.deletionBatchId!==batch.id||!item.deletedAt)throw new Error('Deletion membership mismatch');}const expected=raw[name].filter((item)=>item.deletionBatchId===batch.id).map((item)=>item.id);if(expected.length!==batch[key].length)throw new Error('Incomplete deletion batch');}const previous:string[]=[];for(const member of batch.previousMemberships){const group=lookup('nodes',member.groupNodeId),node=lookup('nodes',member.memberNodeId);if(member.investigationId!==raw.investigation.id||group.id===node.id||lookup('nodeTypes',group.typeId).code!=='group'||lookup('nodeTypes',node.typeId).code==='group')throw new Error('Invalid previous membership');previous.push(node.id);}unique(previous,'previous members');}

}

export async function stageImport(vaultRoot: string, zipPath: string, metadataRoot = DATA_ROOT, options: StagedImportOptions = {}): Promise<StagedImport> {
  safeRelative(metadataRoot);
  const operation = randomUUID(), stagingRelative = `${metadataRoot}/imports/${operation}`;
  const staging = path.dirname(await resolveSafe(vaultRoot, `${stagingRelative}/staging-file`, true));
  const extractedRoot = path.join(staging, 'extracted'); await fs.mkdir(extractedRoot);
  const planned: { source: string; target: string; proof: { sha256: string; byteSize: number } }[] = [], created: { absolute: string; proof: { sha256: string; byteSize: number } }[] = [];
  let committed = false;
  let visibleFolder: string | undefined;
  const projectFolder = async (project: Project): Promise<string | undefined> => {
    if (visibleFolder === undefined && options.projectFolder) { visibleFolder = await options.projectFolder(project); safeRelative(visibleFolder); if (!isAllowedResourcePath(visibleFolder + '/original')) throw new Error('Invalid visible import folder'); }
    return visibleFolder;
  };
  const snapshotDirectory = async (project: Project, id: string): Promise<string> => {
    if (!options.reportsFolder) return `${metadataRoot}/projects/${project.id}/reports/${id}`;
    const parent = await options.reportsFolder(project), relative = `${parent}/snapshots/${id}`; safeRelative(relative);
    if (!isAllowedSnapshotPath(relative + '/snapshot.json', project.id, id)) throw new Error('Invalid visible snapshot folder');
    return relative;
  };
  const retainedPath = async (project: Project, sha256: string): Promise<string> => {
    const folder = await projectFolder(project);
    return folder ? `${folder}/archives/source-${sha256}.zip` : `${metadataRoot}/projects/${project.id}/sources/legacy-export.zip`;
  };
  try {
    const zipProof=await digestFile(zipPath,{},MAX_ARCHIVE);let entries = await extractZIP(zipPath, extractedRoot);const warnings:string[]=[];let originalSource: {sha256:string;byteSize:number}|undefined;
    if(!entries.has('manifest.json')&&!entries.has('project.json')){entries=await convertObsidianExport(entries,staging,warnings);originalSource=zipProof;}
    const manifest = importManifest(await readJSON(entries,'manifest.json')); validateProofs(manifest,entries);let source = await readJSON(entries,'project.json');
    let project: Project; const targets = new Set<string>();
    function plan(sourcePath: string, target: string, proof: { sha256: string; byteSize: number }): void { safeRelative(target); if (targets.has(pathKey(target))) throw new Error('Duplicate import target'); targets.add(pathKey(target)); planned.push({ source: sourcePath, target, proof }); }
    async function planJSON(value: unknown, target: string): Promise<void> { const bytes = stringify(value), sourcePath = path.join(staging, `prepared-${planned.length}`); await fs.writeFile(sourcePath,bytes,{flag:'wx',mode:0o600}); plan(sourcePath,target,{sha256:hash(bytes),byteSize:Buffer.byteLength(bytes)}); }
    async function planText(text: string, target: string): Promise<void> { const sourcePath = path.join(staging, `prepared-${planned.length}`); await fs.writeFile(sourcePath,text,{flag:'wx',mode:0o600}); plan(sourcePath,target,{sha256:hash(text),byteSize:Buffer.byteLength(text)}); }
    if (manifest.format === 'traceweave.obsidian-backup') {
      if (manifest.formatVersion !== '1.0' || JSON.stringify(manifest.requiredFeatures) !== JSON.stringify(['centralized-metadata.v1']) || manifest.sourceProjectId !== objectJSON(source).id || manifest.sourceRevision !== objectJSON(source).revision) throw new Error('Unsupported backup version/features/source');
      const original = projectJSON(source), map = identityMap(original); if(original.importedData.sourceArchive)identityMap(original.importedData.sourceArchive,map);for(const file of backupFiles(manifest.files))if(file.kind==='snapshot')identityMap(await readJSON(entries,file.path),map); project = remap(original,map); if(original.importedData.sourceArchive)project.importedData.sourceArchive=remap(original.importedData.sourceArchive,map); project.id = map.get(original.id)!; project.revision = original.revision; project.receipts = {};
      project.importedData = { ...project.importedData, sourceProjectId: original.id, sourceRevision: original.revision, importedAt: new Date().toISOString() };
      const payloads = backupFiles(manifest.files); const byOriginal = new Map<string,BundleFile>();
      for (const record of payloads) { if (record.path === 'project.json') { if (record.kind !== 'project') throw new Error('Invalid project payload'); continue; } if (!record.originalPath || byOriginal.has(pathKey(record.originalPath)) || !['note','blob','snapshot','report','source'].includes(record.kind)) throw new Error('Invalid backup payload'); safeRelative(record.originalPath); byOriginal.set(pathKey(record.originalPath),record); }
      const used = new Set<string>();
      function fromOriginal(relative: string, kind: BundleFile['kind'], target: string): BundleFile { const record = byOriginal.get(pathKey(relative)); if (!record || record.kind !== kind) throw new Error('Backup payload missing or kind mismatch'); used.add(record.path); const entry = entries.get(record.path)!; plan(entry.absolute,target,entry.proof); return record; }
      for (let i = 0; i < project.nodes.length; i++) {
        const node = project.nodes[i], old = original.nodes[i]; node.notePath = `${NOTES_ROOT}/${project.id}/${node.id}.md`; node.missing = false;
        const record = byOriginal.get(pathKey(old.notePath)); if (!record || record.kind !== 'note') throw new Error('Missing backed-up note'); used.add(record.path);
        if (record.byteSize > 5_242_880) throw new Error('Note byte limit'); const text = await readUTF8(entries.get(record.path)!.absolute); const mapped = remapMarkdown(text,map); await planText(mapped,node.notePath); node.noteHash = hash(mapped);
      }
      const folder = await projectFolder(project);
      for (let i = 0; i < project.blobs.length; i++) { const blob = project.blobs[i], old = original.blobs[i], name = project.assets.find(asset => asset.blobId === blob.id)?.originalName ?? old.path.split('/').at(-1)!; blob.path = folder ? visibleBlobPath(folder,blob,name) : `${RESOURCES_ROOT}/${project.id}/${blob.id}/original${safeSuffix(old.path)}`; const record = fromOriginal(old.path,'blob',blob.path); if (record.sha256 !== blob.sha256 || record.byteSize !== blob.byteSize) throw new Error('Backup blob metadata mismatch'); }
      const retained=retainedSource(original.importedData.retainedSource);
      if(retained){if(!retainedPathAllowed(retained.path,original.id))throw new Error('Invalid retained legacy source');const target=await retainedPath(project,retained.sha256);const record=fromOriginal(retained.path,'source',target);if(record.sha256!==retained.sha256||record.byteSize!==retained.byteSize)throw new Error('Retained source integrity mismatch');project.importedData.retainedSource={...retained,path:target};}
      for (let i = 0; i < project.snapshots.length; i++) {
        const snapshot = project.snapshots[i], old = original.snapshots[i], oldDir = path.posix.dirname(old.path), targetDir = await snapshotDirectory(project,snapshot.id); snapshot.path = `${targetDir}/snapshot.json`;
        if (!isAllowedSnapshotPath(old.path,original.id,old.id)) throw new Error('Invalid snapshot source path');
        let found = false;
        for (const record of payloads) if (record.originalPath?.startsWith(oldDir + '/')) {
          used.add(record.path); const target = targetDir + record.originalPath.slice(oldDir.length), entry = entries.get(record.path)!;
          if (record.originalPath === old.path) { if (record.kind !== 'snapshot') throw new Error('Invalid snapshot kind'); const value = await readJSON(entries,record.path); await planJSON(remap(value,map),target); found = true; }
          else if (record.originalPath.endsWith('/integrity.json')) { if(record.kind!=='report')throw new Error('Invalid integrity payload'); }
          else if (record.originalPath.endsWith('/report.md')) { await planText(remapMarkdown(await readUTF8(entry.absolute),map),target); }
          else { if (record.kind !== 'report') throw new Error('Invalid snapshot payload'); plan(entry.absolute,target,entry.proof); }
        }
        if (!found) throw new Error('Snapshot JSON missing'); const capturedProof=planned.find(item=>item.target===snapshot.path)?.proof,renderedProof=planned.find(item=>item.target===targetDir+'/report.md')?.proof;if(!capturedProof||!renderedProof)throw new Error('Report payload missing'); await planJSON({snapshotSha256:capturedProof.sha256,reportSha256:renderedProof.sha256,originals:planned.filter(item=>item.target.startsWith(targetDir+'/files/')).map(item=>({...item.proof,path:item.target.slice(targetDir.length+1)}))},targetDir+'/integrity.json');
      }
      if (used.size !== byOriginal.size) throw new Error('Unexpected backup payload');
    } else if (manifest.format === 'research-graph.archive') {
      let presentation:ArchivePresentation,profile='2.0';
      if(manifest.formatVersion==='1.0'){
        profile=validateLegacyArchive(manifest,source);source=migrateLegacyArchive(source);archiveValidator('Project',source);presentation=defaultPresentation();warnings.push(t(`Импортирован архив 1.0 (${profile}); камера и панели установлены по умолчанию. Отсутствующая двусторонность означает false.`, `Imported archive 1.0 (${profile}); the viewport and panels use defaults. Missing bidirectionality means false.`));
      }else{
        if (manifest.formatVersion !== '2.0' || manifest.schemaId !== 'research-graph.archive/2.0' || manifest.schemaSha256 !== archiveIndex.schemas['2.0.schema.json'].sha256) throw new Error('Unsupported TraceWeave archive version/schema');
        archiveValidator('Manifest',manifest); archiveValidator('Project',source);const parsedPresentation=await readJSON(entries,'presentation.json');archiveValidator('Presentation',parsedPresentation);presentation=parsedPresentation;
      }
      archiveValidator('Project',source);
      if (manifest.sourceInvestigationId !== source.investigation.id || manifest.sourceRevision !== source.investigation.revision) throw new Error('Archive source identity mismatch');
      validateArchiveReferences(source);
      const expected = new Set(manifest.formatVersion==='1.0'?['project.json']:['project.json','presentation.json']);
      for (const blob of source.blobs) { expected.add(blob.path); const proof = entries.get(blob.path)?.proof; if (blob.path !== `blobs/${blob.sha256}` || !proof || proof.sha256 !== blob.sha256 || proof.byteSize !== blob.byteSize) throw new Error('Original SHA/size mismatch'); }
      if (expected.size !== entries.size - 1 || [...expected].some(name => !entries.has(name))) throw new Error('Unexpected archive payload');
      const map = identityMap(source), raw = remap(source,map), now = new Date().toISOString(), evidenceFor = (id: string): Evidence[] => raw.evidence.filter((e) => e.subjectId === id).map((e) => ({ id:e.id, sourceKind:e.sourceKind, sourceNodeId:e.sourceNodeId, assetId:e.assetId, url:e.url, label:e.label, quote:e.quote, locator:e.locator, note:e.note, accessedAt:e.accessedAt }));
      const layout = new Map<string,ArchiveProject['layouts'][number]>(raw.layouts.map((v) => [v.nodeId,v]));
      project = { format:'traceweave.obsidian-project',formatVersion:'1.0',requiredFeatures:[],id:raw.investigation.id,title:raw.investigation.title,descriptionMarkdown:raw.investigation.descriptionMarkdown,status:raw.investigation.status,revision:raw.investigation.revision,createdAt:raw.investigation.createdAt,updatedAt:now,
        nodes:raw.nodes.map((n): ProjectNode => ({ id:n.id,title:n.title,notePath:`${NOTES_ROOT}/${raw.investigation.id}/${n.id}.md`,noteHash:hash(n.bodyMarkdown),typeId:n.typeId,iconEmoji:n.iconEmoji ?? null,assessment:n.assessment,confidence:n.confidence,attributes:raw.attributes.filter((a) => a.nodeId===n.id).map((a) => ({id:a.id,key:a.key,valueType:a.valueType,value:a.value,sortOrder:a.sortOrder})),evidence:evidenceFor(n.id),x:layout.get(n.id)!.x,y:layout.get(n.id)!.y,zIndex:layout.get(n.id)!.zIndex,createdAt:n.createdAt,updatedAt:n.updatedAt,deletedAt:n.deletedAt,deletionBatchId:n.deletionBatchId,missing:false,subtitle:n.subtitle,tags:n.tags,origin:n.origin,extensions:n.extensions })),
        nodeTypes:raw.nodeTypes.map((t) => ({id:t.id,code:t.code,name:t.name,color:t.color,iconKey:t.iconKey,isHidden:t.isHidden,isSystem:t.isSystem})),relationTypes:raw.relationTypes.map((t) => ({code:t.code,name:t.name,defaultDirected:t.defaultDirected})),
        relations:raw.relations.map((r): Relation => ({ id:r.id,sourceNodeId:r.sourceNodeId,targetNodeId:r.targetNodeId,relationType:r.relationType,label:r.label,directed:r.directed,bidirectional:r.bidirectional ?? false,assessment:r.assessment,confidence:r.confidence,noteMarkdown:r.noteMarkdown,evidence:evidenceFor(r.id),deletedAt:r.deletedAt,deletionBatchId:r.deletionBatchId,createdAt:r.createdAt,updatedAt:r.updatedAt,origin:r.origin })),
        memberships:raw.memberships.map((m) => ({groupNodeId:m.groupNodeId,memberNodeId:m.memberNodeId,sortOrder:m.sortOrder})),
        blobs:raw.blobs.map((b,i: number): BlobRecord => { const asset = raw.assets.find((a) => a.blobId === b.id); return {id:b.id,path:`${RESOURCES_ROOT}/${raw.investigation.id}/${b.id}/original${safeSuffix(asset?.originalName ?? '')}`,sha256:b.sha256,byteSize:b.byteSize,mimeType:asset?.mimeType ?? b.verifiedMimeType ?? 'application/octet-stream',mediaKind:asset?.mediaKind ?? b.mediaKind ?? 'file'}; }),
        assets:raw.assets.map((a): Asset => ({id:a.id,blobId:a.blobId,originalName:a.originalName,title:a.title,mimeType:a.mimeType,mediaKind:a.mediaKind,byteSize:a.byteSize,sha256:a.sha256,createdAt:a.createdAt,deletedAt:a.deletedAt,deletionBatchId:a.deletionBatchId,sourceUrl:a.sourceUrl,sourceAuthor:a.sourceAuthor,sourceCreatedAt:a.sourceCreatedAt,noteMarkdown:a.noteMarkdown,origin:a.origin})),
        attachments:raw.attachments.map((a) => ({id:a.id,nodeId:a.nodeId,assetId:a.assetId,role:a.role,sortOrder:a.sortOrder,caption:a.caption})),
        deletionBatches:raw.deletionBatches.map((b) => ({id:b.id,nodeIds:b.nodeIds,relationIds:b.relationIds,memberships:b.previousMemberships.map((m) => ({groupNodeId:m.groupNodeId,memberNodeId:m.memberNodeId,sortOrder:m.sortOrder})),createdAt:b.createdAt})),snapshots:[],receipts:{},
        importedData:{sourceFormat:originalSource?'traceweave.obsidian-export/1':`research-graph.archive/${manifest.formatVersion}`,legacyProfile:profile,sourceProjectId:source.investigation.id,sourceRevision:source.investigation.revision,importedAt:now,presentation:remap(presentation,map),sourceArchive:{nodeTypes:raw.nodeTypes,relationTypes:raw.relationTypes,reports:raw.reports,deletionBatches:raw.deletionBatches,snapshotAssets:raw.snapshotAssets}} };
      for (const node of project.nodes) await planText(raw.nodes.find(n => n.id === node.id)!.bodyMarkdown,node.notePath);
      const folder = await projectFolder(project);
      for (let i = 0; i < project.blobs.length; i++) { const blob=project.blobs[i], old=source.blobs[i], entry=entries.get(old.path)!,name=project.assets.find(asset=>asset.blobId===blob.id)?.originalName??blob.path.split('/').at(-1)!; const preview=await verifiedMediaInfo(entry.absolute,blob.path); blob.mimeType=preview.mimeType; blob.mediaKind=preview.mediaKind; for (const asset of project.assets.filter(a=>a.blobId===blob.id)) { asset.mimeType=preview.mimeType; asset.mediaKind=preview.mediaKind; } if(folder)blob.path=visibleBlobPath(folder,blob,name); plan(entry.absolute,blob.path,entry.proof); }
      for (const snapshot of raw.snapshots) {
        const snapshotPath = `${await snapshotDirectory(project,snapshot.id)}/snapshot.json`, definition = raw.reports.find((r) => r.id === snapshot.reportDefinitionId), assetIds = snapshot.content.assets.map((a) => a.id);
        await planJSON(snapshot,snapshotPath);
        const markdown = `# ${definition?.title ?? t('Импортированный отчёт', 'Imported report')}\n\n` + snapshot.content.nodes.map((node) => `## ${node.title}\n\n${node.bodyMarkdown}\n`).join('\n'); await planText(markdown,path.posix.dirname(snapshotPath)+'/report.md');
        for (const blobId of new Set<string>(snapshot.content.assets.map((a) => a.blobId))) { const current = project.blobs.find(b => b.id === blobId)!; if (!current) throw new Error('Snapshot blob missing'); const index=raw.blobs.findIndex((b)=>b.id===blobId),entry=entries.get(source.blobs[index].path)!; plan(entry.absolute,path.posix.dirname(snapshotPath)+`/files/${blobId}${safeSuffix(current.path)}`,entry.proof); }
        const capturedProof=planned.find(item=>item.target===snapshotPath)!.proof,renderedProof=planned.find(item=>item.target===path.posix.dirname(snapshotPath)+'/report.md')!.proof;await planJSON({snapshotSha256:capturedProof.sha256,reportSha256:renderedProof.sha256,originals:planned.filter(item=>item.target.startsWith(path.posix.dirname(snapshotPath)+'/files/')).map(item=>({...item.proof,path:item.target.slice(path.posix.dirname(snapshotPath).length+1)}))},path.posix.dirname(snapshotPath)+'/integrity.json');
        project.snapshots.push({id:snapshot.id,title:definition?.title ?? t('Импортированный отчёт', 'Imported report'),path:snapshotPath,sourceRevision:snapshot.sourceRevision,createdAt:snapshot.createdAt,assetIds});
      }
    } else throw new Error('Unsupported archive. Use full TraceWeave archive 2.0 or plugin backup 1.0; legacy Obsidian exports require explicit reconciliation.');
    if(originalSource){const target=await retainedPath(project,originalSource.sha256);plan(zipPath,target,originalSource);project.importedData.retainedSource={...originalSource,path:target};}
    if(warnings.length)project.importedData.warnings=warnings;
    validateProject(project);
    return {
      project,
      async commit() {
        if (committed) return;
        try {
          for (const item of planned) { const absolute = await resolveSafe(vaultRoot,item.target,true); await copyChecked(item.source,absolute,item.proof,{},MAX_ARCHIVE); created.push({absolute,proof:item.proof}); }
          await fs.rm(staging,{recursive:true,force:true}); committed=true;
        } catch (error) { await rollbackFiles(); throw error; }
      },
      async rollback() { await rollbackFiles(); await fs.rm(staging,{recursive:true,force:true}); committed=false; }
    };
    async function rollbackFiles(): Promise<void> {
      for (const item of created.splice(0).reverse()) { const proof=await digestFile(item.absolute,{},MAX_ARCHIVE); if(proof.sha256!==item.proof.sha256 || proof.byteSize!==item.proof.byteSize) throw new Error('Imported file changed; automatic rollback refused'); await fs.unlink(item.absolute); }
    }
  } catch (error) { await fs.rm(staging,{recursive:true,force:true}); throw error; }
}

export async function createReport(vaultRoot: string, project: Project, title: string, nodeIds?: string[], metadataRoot = DATA_ROOT, outputParent?: string): Promise<SnapshotRecord> {
  validateProject(project); safeRelative(metadataRoot); if (!title.trim() || title.length > 200) throw new Error('Invalid report title');
  const selected = new Set(nodeIds ?? project.nodes.filter(n => !n.deletedAt).map(n => n.id)); if (!selected.size || [...selected].some(id => !project.nodes.some(n=>n.id===id && !n.deletedAt))) throw new Error('Report selection must contain active nodes');
  const id=randomUUID(), relative=outputParent?`${outputParent}/snapshots/${id}`:`${metadataRoot}/projects/${project.id}/reports/${id}`, stage=`${metadataRoot}/reports-staging/${id}`;
  if(!isAllowedSnapshotPath(relative+'/snapshot.json',project.id,id))throw new Error('Invalid report destination');
  const stageRoot=path.dirname(await resolveSafe(vaultRoot,`${stage}/snapshot.json`,true)), destination=path.dirname(await resolveSafe(vaultRoot,`${relative}/snapshot.json`,true));
  // resolveSafe creates parent directories, so promotion claims an absent final leaf explicitly.
  await fs.rmdir(destination);
  try {
    const nodes: CapturedNode[]=[]; let capturedBytes=0;
    for (const node of project.nodes.filter(n=>selected.has(n.id))) { const absolute=await resolveSafe(vaultRoot,node.notePath),proof=await digestFile(absolute,{},5_242_880); capturedBytes+=proof.byteSize; if(capturedBytes>60_000_000)throw new Error('Report text byte limit'); const text=await readUTF8(absolute); if(hash(text)!==proof.sha256) throw new Error('Note changed during snapshot capture'); nodes.push({...structuredClone(node),bodyMarkdown:text,capturedHash:proof.sha256}); }
    const attachments=project.attachments.filter(a=>selected.has(a.nodeId)), assetIds=[...new Set(attachments.map(a=>a.assetId))],assets=project.assets.filter(a=>assetIds.includes(a.id)), blobs=project.blobs.filter(b=>assets.some(a=>a.blobId===b.id));
    const originals: BlobRecord[]=[];
    for (const blob of blobs) { const target=`files/${blob.id}${safeSuffix(blob.path)}`,absolute=await resolveSafe(vaultRoot,`${stage}/${target}`,true); await copyChecked(await resolveSafe(vaultRoot,blob.path),absolute,blob); originals.push({...blob,path:target}); }
    const snapshot={format:'traceweave.obsidian-snapshot',formatVersion:'1.0',id,title:title.trim(),projectId:project.id,sourceRevision:project.revision,createdAt:new Date().toISOString(),nodes,nodeTypes:structuredClone(project.nodeTypes),relations:structuredClone(project.relations.filter(r=>!r.deletedAt && selected.has(r.sourceNodeId)&&selected.has(r.targetNodeId))),relationTypes:structuredClone(project.relationTypes),memberships:project.memberships.filter(m=>selected.has(m.groupNodeId)&&selected.has(m.memberNodeId)),assets:structuredClone(assets),attachments:structuredClone(attachments),blobs:originals};
    const content=stringify(snapshot); if(Buffer.byteLength(content)>67_108_864)throw new Error('Snapshot JSON byte limit'); await writeExclusive(vaultRoot,`${stage}/snapshot.json`,content);
    const captured = t(`Снимок: ${snapshot.createdAt} · ревизия ${project.revision}`, `Captured: ${snapshot.createdAt} · revision ${project.revision}`);
    const markdown=`# ${title.trim()}\n\n${captured}\n\n`+nodes.map(n=>`## ${n.title}\n\n${n.bodyMarkdown}\n\n`+attachments.filter(a=>a.nodeId===n.id).map(a=>{const asset=assets.find(v=>v.id===a.assetId)!,blob=originals.find(b=>b.id===asset.blobId)!;return `[${asset.title.replace(/[[\]]/gu,'')}](${blob.path})\n`;}).join('')).join('\n');
    await writeExclusive(vaultRoot,`${stage}/report.md`,markdown); await writeExclusive(vaultRoot,`${stage}/integrity.json`,stringify({snapshotSha256:hash(content),reportSha256:hash(markdown),originals:originals.map(blob=>({path:blob.path,sha256:blob.sha256,byteSize:blob.byteSize}))}));
    await fs.rename(stageRoot,destination); return {id,title:title.trim(),path:`${relative}/snapshot.json`,sourceRevision:project.revision,createdAt:snapshot.createdAt,assetIds};
  } catch(error) { await fs.rm(stageRoot,{recursive:true,force:true}); throw error; }
}

type CapturedNode = ProjectNode & { bodyMarkdown: string; capturedHash: string };
interface LocalSnapshot { format: 'traceweave.obsidian-snapshot'; formatVersion: '1.0'; nodes: CapturedNode[]; nodeTypes: NodeType[]; relations: Relation[]; assets: Asset[]; attachments: Attachment[]; blobs: BlobRecord[] }
function localSnapshot(value: unknown, project: Project): LocalSnapshot {
  const record = objectJSON(value);
  if (record.format !== 'traceweave.obsidian-snapshot' || record.formatVersion !== '1.0' || !isArray(record.nodes) || !isArray(record.blobs)) throw new Error('Unsupported immutable snapshot format');
  const capturedNodes = record.nodes.map(value => {
    const node = objectJSON(value);
    if (typeof node.bodyMarkdown !== 'string' || typeof node.capturedHash !== 'string' || !HASH.test(node.capturedHash) || hash(node.bodyMarkdown) !== node.capturedHash) throw new Error('Invalid captured snapshot note');
    const { bodyMarkdown: _body, capturedHash: _hash, ...stored } = node;
    return { stored, bodyMarkdown: node.bodyMarkdown, capturedHash: node.capturedHash };
  });
  const nodes = capturedNodes.map(node => node.stored);
  const originalProofs = record.blobs.map(proofJSON);
  const blobs = record.blobs.map(value => {
    const blob = objectJSON(value), proof = proofJSON(blob);
    // Original paths inside a snapshot are relative to its immutable report directory.
    return { ...blob, ...proof, path: `${RESOURCES_ROOT}/${project.id}/${identity(blob)}/original${safeSuffix(proof.path)}` };
  });
  const projected: unknown = { ...project, nodes, nodeTypes: record.nodeTypes, relations: record.relations, relationTypes: record.relationTypes, memberships: record.memberships, assets: record.assets, attachments: record.attachments, blobs, snapshots: [], deletionBatches: [], receipts: {}, importedData: {} };
  if (!obsidianProject(projected)) throw new Error(`Invalid immutable snapshot: ${validationErrors(obsidianProject)}`);
  const validated = projected as Project;
  return { format:'traceweave.obsidian-snapshot',formatVersion:'1.0',nodes:validated.nodes.map((node,index) => ({...node,bodyMarkdown:capturedNodes[index].bodyMarkdown,capturedHash:capturedNodes[index].capturedHash})),nodeTypes:validated.nodeTypes,relations:validated.relations,assets:validated.assets,attachments:validated.attachments,blobs:validated.blobs.map((blob,index) => ({...blob,path:originalProofs[index].path})) };
}
interface RetainedArchive { nodeTypes: { id: string; attributeTemplates: unknown[] }[]; relationTypes: { id: string; code: string }[] }
function retainedArchive(value: unknown): RetainedArchive | undefined {
  if (value === undefined) return undefined;
  const archive = objectJSON(value);
  if (!isArray(archive.nodeTypes) || !isArray(archive.relationTypes)) throw new Error('Invalid retained archive types');
  const nodeTypes = archive.nodeTypes.map(value => { const type = objectJSON(value); if (typeof type.id !== 'string' || !isArray(type.attributeTemplates)) throw new Error('Invalid retained node type'); return {id:type.id,attributeTemplates:type.attributeTemplates}; });
  const relationTypes = archive.relationTypes.map(value => { const type = objectJSON(value); if (typeof type.id !== 'string' || typeof type.code !== 'string') throw new Error('Invalid retained relation type'); return {id:type.id,code:type.code}; });
  return { nodeTypes, relationTypes };
}

/** Server-compatible complete project archive. Vault backup remains the exact local profile. */
export async function exportTraceWeaveArchive(vaultRoot: string, project: Project, outputPath: string, metadataRoot = DATA_ROOT): Promise<void> {
  validateProject(project); safeRelative(metadataRoot);
  const investigationId = project.id, now = new Date().toISOString(), imported = retainedArchive(project.importedData.sourceArchive);
  const normalizedKey = (value:string) => value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC').trim();
  const mimeSet = new Set(['text/plain','text/markdown','image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/wav','audio/ogg','audio/mp4','video/mp4','video/webm','video/quicktime','application/pdf','application/octet-stream']);
  const origin = (value: ObjectJSON): ArchiveOrigin => { const normalized = Object.hasOwn(value,'kind') ? value : {kind:'manual',...value}; archiveValidator('Origin',normalized); return normalized; };
  const nodeType = (value:NodeType) => ({id:value.id,investigationId,code:value.code,name:value.name,iconKey:value.iconKey,color:value.color,isSystem:value.isSystem,isHidden:value.isHidden,attributeTemplates:imported?.nodeTypes?.find((type)=>type.id===value.id)?.attributeTemplates ?? []});
  const relationTypes = project.relationTypes.map(value=>({id:imported?.relationTypes?.find((type)=>type.code===value.code)?.id ?? randomUUID(),investigationId,...value,isHidden:false}));
  const nodeRow = (node:ProjectNode, bodyMarkdown:string) => ({id:node.id,investigationId,typeId:node.typeId,title:node.title,subtitle:node.subtitle,bodyMarkdown,assessment:node.assessment,confidence:node.confidence,tags:node.tags,extensions:node.extensions,createdAt:node.createdAt,updatedAt:node.updatedAt,deletedAt:node.deletedAt,deletionBatchId:node.deletionBatchId,origin:origin(node.origin),iconEmoji:node.iconEmoji});
  const relationRow = (relation:Relation) => ({id:relation.id,investigationId,sourceNodeId:relation.sourceNodeId,targetNodeId:relation.targetNodeId,relationType:relation.relationType,directed:relation.directed,bidirectional:relation.bidirectional,label:relation.label,noteMarkdown:relation.noteMarkdown,assessment:relation.assessment,confidence:relation.confidence,createdAt:relation.createdAt,updatedAt:relation.updatedAt,deletedAt:relation.deletedAt,deletionBatchId:relation.deletionBatchId,origin:origin(relation.origin)});
  const assetRow = (asset:Asset) => { const supported=mimeSet.has(asset.mimeType); return {id:asset.id,investigationId,blobId:asset.blobId,originalName:asset.originalName,title:asset.title,mimeType:supported?asset.mimeType:'application/octet-stream',mediaKind:supported?asset.mediaKind:'file',byteSize:asset.byteSize,sha256:asset.sha256,createdAt:asset.createdAt,deletedAt:asset.deletedAt,deletionBatchId:asset.deletionBatchId,sourceUrl:asset.sourceUrl,sourceAuthor:asset.sourceAuthor,sourceCreatedAt:asset.sourceCreatedAt,noteMarkdown:asset.noteMarkdown,origin:origin(asset.origin)}; };
  const attributesFor=(nodes:ProjectNode[]) => nodes.flatMap(node=>node.attributes.map((value)=>({...value,nodeId:node.id,normalizedKey:normalizedKey(value.key)})));
  const evidenceFor=(nodes:ProjectNode[],relations:Relation[]) => [...nodes.map(node=>({subject:node,kind:'node'})),...relations.map(relation=>({subject:relation,kind:'relation'}))].flatMap(({subject,kind})=>(subject.evidence??[]).map((value)=>({...value,note:value.note??'',investigationId,subjectKind:kind,subjectId:subject.id})));
  const attachmentRows=(values:Attachment[])=>values.map(value=>({...value,investigationId}));
  const sourceBlobs=new Map<string,{source:string;proof:Proof}>();
  async function addOriginal(blob:Pick<BlobRecord,'sha256'|'byteSize'>,absolute:string):Promise<void>{const proof=await digestFile(absolute);if(proof.byteSize!==blob.byteSize||proof.sha256!==blob.sha256)throw new Error('Original changed or missing during archive export');const previous=sourceBlobs.get(blob.sha256);if(previous&&previous.proof.byteSize!==proof.byteSize)throw new Error('Conflicting content address');sourceBlobs.set(blob.sha256,{source:absolute,proof:{path:`blobs/${blob.sha256}`,...proof}});}
  const nodes: ReturnType<typeof nodeRow>[]=[];
  for(const node of project.nodes){const absolute=await resolveSafe(vaultRoot,node.notePath),proof=await digestFile(absolute,{},5_242_880),body=await readUTF8(absolute);if(hash(body)!==proof.sha256)throw new Error('Note changed during archive capture');nodes.push(nodeRow(node,body));}
  for(const blob of project.blobs)await addOriginal(blob,await resolveSafe(vaultRoot,blob.path));
  const reports:ArchiveReportDefinition[]=[],snapshots:ArchiveReportSnapshot[]=[],snapshotAssets:ArchiveReportSnapshotAsset[]=[];
  for(const record of project.snapshots){
    await verifyReport(vaultRoot,record); const absolute=await resolveSafe(vaultRoot,record.path); await digestFile(absolute,{},67_108_864); const captured=objectJSON(strictJSON(await readUTF8(absolute)));let snapshot:ArchiveReportSnapshot;
    if(captured.content&&captured.reportDefinitionId&&captured.formatVersion==='1.0'){
      archiveValidator('Snapshot',captured);snapshot=structuredClone(captured);snapshot.investigationId=investigationId;snapshot.content.definition.investigationId=investigationId;delete snapshot.contentSha256;
      const integrity=reportIntegrity(strictJSON(await readUTF8(path.join(path.dirname(absolute),'integrity.json'))));for(const asset of snapshot.content.assets){const blob=project.blobs.find(b=>b.id===asset.blobId),pinned=integrity.originals.find((item)=>item.sha256===asset.sha256&&item.byteSize===asset.byteSize);if(!blob||!pinned)throw new Error('Historical snapshot blob missing');await addOriginal(blob,path.join(path.dirname(absolute),safeRelative(pinned.path)));}
    }else if(captured.format==='traceweave.obsidian-snapshot'&&captured.formatVersion==='1.0'){
      const local = localSnapshot(captured,project);
      const reportId=randomUUID(),definition:ArchiveReportDefinition={id:reportId,investigationId,title:record.title,introductionMarkdown:'',scopeMode:'selection',selectedNodeIds:local.nodes.map((node)=>node.id),orderedConclusionIds:[],includeGroupMembers:false,includeAttachments:true,includeEvidence:true,createdAt:record.createdAt,updatedAt:record.createdAt};
      const snapshotNodes=local.nodes.map((node)=>nodeRow(node,node.bodyMarkdown)),snapshotRelations=local.relations.map(relationRow),snapshotAssetRows=local.assets.map(assetRow),includedNodes=new Set(snapshotNodes.map((n)=>n.id)),includedAssets=new Set(snapshotAssetRows.map((a)=>a.id));
      const wrapped=evidenceFor(local.nodes,local.relations).map((e)=>{const included=e.sourceKind==='url'||(e.sourceKind==='node'?e.sourceNodeId!==null&&includedNodes.has(e.sourceNodeId):e.assetId!==null&&includedAssets.has(e.assetId));const sourceTitle=e.sourceKind==='node'?snapshotNodes.find((n)=>n.id===e.sourceNodeId)?.title:e.sourceKind==='asset'?snapshotAssetRows.find((a)=>a.id===e.assetId)?.title:null;return{evidence:e,sourceStatus:included?'included':'outside_scope',sourceTitle:included?sourceTitle??null:null};});
      const warnings=wrapped.filter((w)=>w.sourceStatus==='outside_scope').map((w)=>({code:'source_outside_scope',objectKind:'evidence',objectId:w.evidence.id,message:t('Источник находится вне явного состава снимка.', "The source is outside the snapshot's explicit scope.")}));
      const prepared:unknown={id:record.id,reportDefinitionId:reportId,investigationId,sourceRevision:record.sourceRevision,createdAt:record.createdAt,formatVersion:'1.0',importProvenance:null,content:{investigationTitle:project.title,definition,nodes:snapshotNodes,attributes:attributesFor(local.nodes),relations:snapshotRelations,nodeTypes:local.nodeTypes.map(nodeType),relationTypes,attachments:attachmentRows(local.attachments),assets:snapshotAssetRows,evidence:wrapped,warnings}};
      archiveValidator('Snapshot',prepared);snapshot=prepared;
      for(const blob of local.blobs)await addOriginal(blob,path.join(path.dirname(absolute),safeRelative(blob.path)));
    }else throw new Error('Unsupported immutable snapshot format');
    if(!reports.some(report=>report.id===snapshot.reportDefinitionId))reports.push(snapshot.content.definition);snapshots.push(snapshot);
    for(const asset of snapshot.content.assets)snapshotAssets.push({investigationId,snapshotId:snapshot.id,assetId:asset.id,blobId:asset.blobId});
  }
  const raw:unknown={format:'research-graph.project',formatVersion:'2.0',investigation:{id:investigationId,title:project.title,descriptionMarkdown:project.descriptionMarkdown,status:project.status,revision:project.revision,createdAt:project.createdAt,updatedAt:project.updatedAt,archivedAt:project.status==='archived'?project.updatedAt:null},
    blobs:project.blobs.map(blob=>({id:blob.id,investigationId,sha256:blob.sha256,byteSize:blob.byteSize,path:`blobs/${blob.sha256}`})),nodeTypes:project.nodeTypes.map(nodeType),relationTypes,nodes,attributes:attributesFor(project.nodes),layouts:project.nodes.map(node=>({nodeId:node.id,investigationId,x:node.x,y:node.y,zIndex:node.zIndex})),memberships:project.memberships.map(value=>({...value,investigationId})),relations:project.relations.map(relationRow),assets:project.assets.map(assetRow),attachments:attachmentRows(project.attachments),evidence:evidenceFor(project.nodes,project.relations),reports,snapshots,snapshotAssets,deletionBatches:project.deletionBatches.map(batch=>({id:batch.id,investigationId,createdAt:batch.createdAt,nodeIds:batch.nodeIds,relationIds:batch.relationIds,assetIds:project.assets.filter(asset=>asset.deletionBatchId===batch.id).map(asset=>asset.id),previousMemberships:batch.memberships.map(value=>({...value,investigationId}))}))};
  archiveValidator('Project',raw);validateArchiveReferences(raw);
  const presentation=defaultPresentation();archiveValidator('Presentation',presentation);
  const payloads:ZipPayload[]=[];for(const [name,value]of [['project.json',raw],['presentation.json',presentation]]as const){const data=Buffer.from(stringify(value));if(data.length>entryLimit(name))throw new Error('Archive metadata byte limit');payloads.push({data,proof:{path:name,byteSize:data.length,sha256:hash(data)}});}
  payloads.push(...sourceBlobs.values());
  const manifest={format:'research-graph.archive',formatVersion:'2.0',exportedAt:now,sourceInvestigationId:investigationId,sourceRevision:project.revision,projectPath:'project.json',presentationPath:'presentation.json',includesTrash:true,includesSnapshots:true,schemaId:'research-graph.archive/2.0',schemaSha256:archiveIndex.schemas['2.0.schema.json'].sha256,producer:{version:`traceweave-obsidian/${pluginManifest.version}`,releaseTag:null,backendCommit:null,frontendCommit:null,contractsCommit:null},requiredFeatures:['full-project.v1','presentation.v1','node-icon-emoji.v1'],files:payloads.map(value=>value.proof)};archiveValidator('Manifest',manifest);
  const data=Buffer.from(stringify(manifest));if(data.length>entryLimit('manifest.json')||payloads.length+1>MAX_ENTRIES||payloads.reduce((sum,value)=>sum+value.proof.byteSize,0)>MAX_TOTAL)throw new Error('Archive total byte/entry limit');payloads.push({data,proof:{path:'manifest.json',byteSize:data.length,sha256:hash(data)}});
  await writePayloadZIP(vaultRoot,outputPath,payloads);
}


interface ReportIntegrity { snapshotSha256: string; reportSha256: string; originals: Proof[] }
function reportIntegrity(value: unknown): ReportIntegrity {
  const record = objectJSON(value);
  if (typeof record.snapshotSha256 !== 'string' || !HASH.test(record.snapshotSha256) || typeof record.reportSha256 !== 'string' || !HASH.test(record.reportSha256)) throw new Error('Invalid report integrity record');
  if (!isArray(record.originals) || record.originals.length > MAX_ENTRIES) throw new Error('Missing immutable originals manifest');
  return { snapshotSha256: record.snapshotSha256, reportSha256: record.reportSha256, originals: record.originals.map(proofJSON) };
}
export async function verifyReport(vaultRoot:string,record:SnapshotRecord):Promise<void>{
  const directory=path.posix.dirname(record.path),integrityPath=await resolveSafe(vaultRoot,directory+'/integrity.json');await digestFile(integrityPath,{},16_777_216);const integrity=reportIntegrity(strictJSON(await readUTF8(integrityPath)));
  const snapshot=await digestFile(await resolveSafe(vaultRoot,record.path),{},67_108_864),markdown=await digestFile(await resolveSafe(vaultRoot,directory+'/report.md'),{},67_108_864);
  if(snapshot.sha256!==integrity.snapshotSha256||markdown.sha256!==integrity.reportSha256)throw new Error('Immutable report file changed');
  const paths=new Set<string>();
  for(const blob of integrity.originals){safeRelative(blob.path);if(!blob.path.startsWith('files/')||paths.has(pathKey(blob.path))||blob.byteSize>MAX_ORIGINAL_BYTES)throw new Error('Invalid immutable originals manifest');paths.add(pathKey(blob.path));const proof=await digestFile(await resolveSafe(vaultRoot,directory+'/'+blob.path));if(proof.sha256!==blob.sha256||proof.byteSize!==blob.byteSize)throw new Error('Immutable report original changed');}
}

function defaultPresentation():ArchivePresentation{return{formatVersion:1,viewport:{x:0,y:0,zoom:1},inspector:null,details:true,outline:false,cardShrinkFactor:2,iconSizeFactor:1};}
function validateLegacyArchive(manifest: unknown, project: unknown): string {
  const failures: string[] = [];
  for (const [profile, manifestRule, projectRule] of [['legacy-1.0-019',legacyModernManifest,legacyModernProject],['legacy-1.0-initial',legacyInitialManifest,legacyInitialProject]] as const) {
    const validManifest = manifestRule(manifest), validProject = projectRule(project);
    if (validManifest && validProject) return profile;
    failures.push(`${profile}: ${validationErrors(validManifest ? projectRule : manifestRule)}`);
  }
  throw new Error('Unsupported legacy archive: '+failures.join('; '));
}
function migrateLegacyArchive(value: unknown, key=''): unknown {
  if (['origin','extensions','importProvenance','producer'].includes(key)) return value;
  if (isArray(value)) return value.map(item => migrateLegacyArchive(item,key));
  if (isRecord(value)) {
    const copy = Object.fromEntries(Object.entries(value).map(([name,item]) => [name,migrateLegacyArchive(item,name)]));
    if (copy.format === 'research-graph.project') copy.formatVersion = '2.0';
    if (copy.sourceNodeId !== undefined && copy.targetNodeId !== undefined && copy.relationType !== undefined && copy.bidirectional === undefined) copy.bidirectional = false;
    return copy;
  }
  return value;
}
const legacyCollections = ['nodeTypes','relationTypes','nodes','attributes','relations','layouts','memberships','attachments','assets','evidence'] as const;
type LegacyCollection = typeof legacyCollections[number];
type LegacySnapshot = Record<LegacyCollection,ObjectJSON[]> & { investigationId: string; title: string; descriptionMarkdown: string; sourceRevision: number; capturedAt: string };
function legacySnapshot(value: unknown): LegacySnapshot {
  const snapshot = objectJSON(value), allowed = ['formatVersion','investigationId','title','descriptionMarkdown','sourceRevision','capturedAt',...legacyCollections];
  if (Object.keys(snapshot).some(key => !allowed.includes(key)) || snapshot.formatVersion !== 1 || typeof snapshot.investigationId !== 'string' || !UUID.test(snapshot.investigationId) || typeof snapshot.title !== 'string' || typeof snapshot.descriptionMarkdown !== 'string' || typeof snapshot.sourceRevision !== 'number' || typeof snapshot.capturedAt !== 'string') throw new Error('Unsupported legacy Obsidian snapshot format');
  const collections = Object.fromEntries(legacyCollections.map(name => { const items = snapshot[name]; if (!isArray(items)) throw new Error('Missing legacy Obsidian collection '+name); return [name,items.map(objectJSON)]; })) as Record<LegacyCollection,ObjectJSON[]>;
  return { ...collections, investigationId:snapshot.investigationId,title:snapshot.title,descriptionMarkdown:snapshot.descriptionMarkdown,sourceRevision:snapshot.sourceRevision,capturedAt:snapshot.capturedAt };
}
function legacyFileMaps(value: unknown): Record<'documents'|'relations'|'assets',Record<string,string>> {
  const files = objectJSON(value);
  if (files.formatVersion !== 1 || Object.keys(files).some(key => !['formatVersion','documents','relations','assets'].includes(key))) throw new Error('Unsupported legacy Obsidian file map');
  const readMap = (value: unknown): Record<string,string> => Object.fromEntries(Object.entries(objectJSON(value)).map(([id,name]) => { if (typeof name !== 'string') throw new Error('Invalid legacy map identity/path'); return [id,name]; }));
  return { documents:readMap(files.documents), relations:readMap(files.relations), assets:readMap(files.assets) };
}
function identity(value: ObjectJSON, key='id'): string { const id = value[key]; if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid legacy identity'); return id; }
async function convertObsidianExport(entries:Map<string,Extracted>,staging:string,warnings:string[]):Promise<Map<string,Extracted>>{
  const snapshot=legacySnapshot(await readJSON(entries,'metadata/snapshot.json')),files=legacyFileMaps(await readJSON(entries,'metadata/files.json'));
  const usedPaths=new Set<string>();
  for(const [mapName,collection,prefix]of [['documents','nodes','Documents/'],['relations','relations','Relations/'],['assets','assets','Attachments/']]as const){
    const mapping=files[mapName],ids=new Set(snapshot[collection].map(item => identity(item)));if(ids.size!==snapshot[collection].length||ids.size!==Object.keys(mapping).length)throw new Error('Legacy file map must match snapshot identities');
    for(const [id,name]of Object.entries(mapping)){if(!ids.has(id))throw new Error('Invalid legacy map identity/path');safeRelative(name);if(!name.startsWith(prefix)||!entries.has(name)||usedPaths.has(pathKey(name))||(mapName!=='assets'&&!name.endsWith('.md')))throw new Error('Missing, duplicated or unsafe legacy map path');usedPaths.add(pathKey(name));}
  }
  const converted=new Map<string,Extracted>(),blobs:ArchiveProject['blobs']=[],byDigest=new Map<string,ArchiveProject['blobs'][number]>();
  const assets=snapshot.assets.map(asset=>{
    if('blobId'in asset||'deletedAt'in asset||'deletionBatchId'in asset)throw new Error('Unsupported private asset metadata in legacy public export');
    const entry=entries.get(files.assets[identity(asset)])!,proof=proofJSON({path:entry.proof.path,sha256:asset.sha256,byteSize:asset.byteSize});if(entry.proof.sha256!==proof.sha256||entry.proof.byteSize!==proof.byteSize)throw new Error('Legacy original hash/size mismatch');
    let blob=byDigest.get(proof.sha256);if(!blob){blob={id:randomUUID(),investigationId:snapshot.investigationId,sha256:proof.sha256,byteSize:proof.byteSize,path:`blobs/${proof.sha256}`};byDigest.set(proof.sha256,blob);blobs.push(blob);converted.set(blob.path,{absolute:entry.absolute,proof:{...entry.proof,path:blob.path}});}return{...asset,blobId:blob.id,deletedAt:null,deletionBatchId:null};
  });
  const nodes:ObjectJSON[]=[];
  for(const node of snapshot.nodes){const entry=entries.get(files.documents[identity(node)])!;if(entry.proof.byteSize>5_242_880)throw new Error('Legacy rendered note exceeds 5 MiB');const rendered=await readUTF8(entry.absolute);nodes.push({...node,bodyMarkdown:rendered});}
  const layouts=[...snapshot.layouts],layoutIds=new Set(layouts.map(layout=>identity(layout,'nodeId')));
  for(const node of nodes){const id=identity(node);if(!layoutIds.has(id)){layouts.push({nodeId:id,investigationId:snapshot.investigationId,x:0,y:0,zIndex:0});warnings.push(t('В старом экспорте отсутствует раскладка узла ', "The legacy export has no layout for node ")+id+t('; установлены координаты 0,0.', "; coordinates were set to 0,0."));}}
  const raw=migrateLegacyArchive({format:'research-graph.project',formatVersion:'2.0',investigation:{id:snapshot.investigationId,title:snapshot.title,descriptionMarkdown:snapshot.descriptionMarkdown,status:'active',revision:snapshot.sourceRevision,createdAt:snapshot.capturedAt,updatedAt:snapshot.capturedAt,archivedAt:null},blobs,nodeTypes:snapshot.nodeTypes,relationTypes:snapshot.relationTypes,nodes,attributes:snapshot.attributes,layouts,memberships:snapshot.memberships,relations:snapshot.relations,assets,attachments:snapshot.attachments,evidence:snapshot.evidence,reports:[],snapshots:[],snapshotAssets:[],deletionBatches:[]});
  archiveValidator('Project',raw);validateArchiveReferences(raw);
  async function metadata(name:string,value:unknown):Promise<void>{const data=stringify(value);if(Buffer.byteLength(data)>entryLimit(name))throw new Error('Legacy converted metadata byte limit');const absolute=path.join(staging,'converted-'+name);await fs.writeFile(absolute,data,{flag:'wx',mode:0o600});converted.set(name,{absolute,proof:{path:name,sha256:hash(data),byteSize:Buffer.byteLength(data)}});}
  await metadata('project.json',raw);await metadata('presentation.json',defaultPresentation());
  await metadata('manifest.json',{format:'research-graph.archive',formatVersion:'2.0',exportedAt:snapshot.capturedAt,sourceInvestigationId:snapshot.investigationId,sourceRevision:snapshot.sourceRevision,projectPath:'project.json',presentationPath:'presentation.json',includesTrash:true,includesSnapshots:true,schemaId:'research-graph.archive/2.0',schemaSha256:archiveIndex.schemas['2.0.schema.json'].sha256,producer:{version:'traceweave-obsidian-legacy-converter/0.1.0',releaseTag:null,backendCommit:null,frontendCommit:null,contractsCommit:null},requiredFeatures:['full-project.v1','presentation.v1','node-icon-emoji.v1'],files:[...converted.values()].map(entry=>entry.proof)});
  warnings.push(t('Старый Obsidian export импортирован в новый проект. Текущие Documents/*.md сохранены целиком, включая пользовательские изменения и старые сгенерированные разделы. Исходный body из metadata не заменяет текущий Markdown. Топология взята из snapshot; изменения Relations/*.md/README и исходные body сохранены в оригинальном ZIP в служебной папке. Старый формат содержит только активный состав, без корзины и истории отчётов; createdAt/updatedAt нового исследования взяты из capturedAt.', "The legacy Obsidian export was imported into a new project. Current Documents/*.md files were preserved in full, including user edits and previously generated sections. The body from metadata does not replace current Markdown. Topology came from the snapshot; Relations/*.md/README edits and original bodies remain in the original ZIP in the metadata folder. The legacy format contains active content only, without trash or report history; the new project's createdAt/updatedAt values came from capturedAt."));
  return converted;
}

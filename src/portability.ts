import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import Ajv2020 from 'ajv/dist/2020';
import { DATA_ROOT, NOTES_ROOT, RESOURCES_ROOT, LEGACY_METADATA_ROOT, TRANSITIONAL_METADATA_ROOT } from './storage/layout';
import pluginManifest from '../manifest.json';
import type { ValidateFunction } from 'ajv';
import { parse, visit, type ParseError } from 'jsonc-parser';
import archiveSchema from '../contracts/archive2.0.schema.json';
import archiveIndex from '../contracts/archive-index.json';
import legacyModern from '../contracts/legacy-1.0-019.schema.json';
import legacyInitial from '../contracts/legacy-1.0-initial.schema.json';
import { validateProject } from './domain';
import type { Project, ProjectNode, Relation, Evidence, SnapshotRecord, BlobRecord, Asset } from './types';
import { copyChecked, digestFile, resolveSafe, safeRelative, safeSuffix, verifiedMediaInfo, MAX_ORIGINAL_BYTES } from './storage/files';

const MAX_ENTRIES = 50_000, MAX_ARCHIVE = 10_737_418_240, MAX_TOTAL = 21_474_836_480;
const HASH = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const metadataRoots = [DATA_ROOT, TRANSITIONAL_METADATA_ROOT, LEGACY_METADATA_ROOT];
type ObjectJSON = Record<string, any>;
interface Proof { path: string; sha256: string; byteSize: number }
interface BundleFile extends Proof { kind: 'project' | 'note' | 'blob' | 'snapshot' | 'report' | 'source'; originalPath?: string }
interface Extracted { absolute: string; proof: Proof }
export interface StagedImport { project: Project; commit(): Promise<void>; rollback(): Promise<void> }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const stringify = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function strictJSON(source: string): any {
  if (Buffer.byteLength(source)>67_108_864) throw new Error('JSON byte limit'); if(source.startsWith('\uFEFF'))source=source.slice(1); const errors: ParseError[] = [], stack: Set<string>[] = []; let depth=0; const enter=()=>{if(++depth>128)throw new Error('JSON nesting limit');};
  visit(source, { onObjectBegin: () => { enter(); stack.push(new Set()); }, onObjectProperty: name => { const keys = stack.at(-1)!; if (keys.has(name)) throw new Error('Duplicate JSON object key'); keys.add(name); }, onObjectEnd: () => { stack.pop(); depth--; }, onArrayBegin:enter, onArrayEnd:()=>{depth--;} }, { disallowComments: true, allowTrailingComma: false });
  const result = parse(source, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length || result === undefined) throw new Error('Invalid strict JSON');
  const exact=JSON.parse(source);const scalar=(value:unknown):void=>{if(typeof value==='string'&&/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw new Error('Invalid Unicode scalar');if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid JSON number');if(Array.isArray(value))for(const item of value)scalar(item);else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){scalar(key);scalar(item);}};scalar(exact);return exact;
}
async function readUTF8(absolute:string):Promise<string>{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.readFile(absolute));}
let archiveAJV: Ajv2020 | undefined;
const compiledArchiveRules = new Map<string, ValidateFunction>();
function archiveValidator(definition: string, value: unknown): void {
  if (!archiveAJV) {
    archiveAJV = new Ajv2020({ allErrors: false, strict: false, validateFormats: true });
    archiveAJV.addFormat('uuid', { type: 'string', validate: (v: string) => UUID.test(v) });
    archiveAJV.addFormat('date-time', { type: 'string', validate: (v: string) => !Number.isNaN(Date.parse(v)) });
    archiveAJV.addFormat('uri', { type: 'string', validate: (v: string) => { try { new URL(v); return true; } catch { return false; } } });
    archiveAJV.addKeyword({keyword:'x-maxUtf8Bytes',type:'string',schemaType:'number',validate:(limit:number,v:string)=>Buffer.byteLength(v)<=limit});
    archiveAJV.addKeyword({keyword:'x-maxJsonUtf8Bytes',schemaType:'number',validate:(limit:number,v:unknown)=>Buffer.byteLength(JSON.stringify(v))<=limit});
    archiveAJV.addKeyword({keyword:'x-normalize',type:'string',schemaType:'string',validate:(_rule:string,v:string)=>v===v.normalize('NFC').trim()});
    archiveAJV.addKeyword({keyword:'x-realCalendarDate',type:'object',schemaType:'boolean',validate:(_rule:boolean,v:ObjectJSON)=>{if(typeof v.value!=='string')return false;const date=v.value+(v.precision==='year'?'-01-01':v.precision==='month'?'-01':'');return /^\d{4}-\d\d-\d\d$/u.test(date)&&!Number.isNaN(Date.parse(date+'T00:00:00.000Z'))&&new Date(date+'T00:00:00.000Z').toISOString().slice(0,10)===date;}});
    archiveAJV.addSchema(archiveSchema);
  }
  let validate=compiledArchiveRules.get(definition);
  if(!validate){validate=archiveAJV.compile({$ref:`${archiveSchema.$id}#/$defs/${definition}`});compiledArchiveRules.set(definition,validate);}
  if (!validate(value)) throw new Error(`Archive ${definition} schema rejected: ${archiveAJV.errorsText(validate.errors)}`);
}

function pathKey(value: string): string { return value.normalize('NFC').toLowerCase(); }
function entryLimit(name: string): number { if (/^sources\/[a-f0-9]{64}\.zip$/u.test(name)) return MAX_ARCHIVE; if (name === 'manifest.json') return 16_777_216; if (name === 'project.json' || name.endsWith('/snapshot.json')) return 67_108_864; if (name === 'presentation.json') return 65_536; return MAX_ORIGINAL_BYTES; }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function updateCRC(crc: number, bytes: Buffer): number { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return crc; }
async function extractZIP(zipPath: string, staging: string): Promise<Map<string, Extracted>> {
  const stat = await fs.lstat(zipPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE) throw new Error('Invalid ZIP or archive byte limit');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file!)));
  try {
    const entries = await new Promise<yauzl.Entry[]>((resolve, reject) => {
      const list: yauzl.Entry[] = [], names = new Set<string>(); let total = 0;
      zip.on('error', reject); zip.on('end', () => resolve(list));
      zip.on('entry', entry => { try {
        safeRelative(entry.fileName); const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (entry.fileName.endsWith('/') || (mode !== 0 && mode !== 0x8000) || (entry.generalPurposeBitFlag & 1) || ![0,8].includes(entry.compressionMethod)) throw new Error('Unsupported ZIP entry type, encryption or compression');
        const name = pathKey(entry.fileName); if (names.has(name) || list.length >= MAX_ENTRIES) throw new Error('Duplicate ZIP entry or entry count limit'); names.add(name);
        if (entry.uncompressedSize > entryLimit(entry.fileName) || entry.uncompressedSize > MAX_TOTAL - total || (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize > entry.compressedSize * 1000))) throw new Error('ZIP expansion/size limit');
        total += entry.uncompressedSize; list.push(entry); zip.readEntry();
      } catch (error) { reject(error); } }); zip.readEntry();
    });
    if (!(entries.some(e=>e.fileName==='manifest.json')&&entries.some(e=>e.fileName==='project.json'))&&!(entries.some(e=>e.fileName==='metadata/files.json')&&entries.some(e=>e.fileName==='metadata/snapshot.json'))) throw new Error('Archive manifest/project or legacy Obsidian metadata missing');
    const space = await fs.statfs(staging); const declared = entries.reduce((sum, e) => sum + e.uncompressedSize, 0); if (space.bavail * space.bsize < declared + 134_217_728) throw new Error('Insufficient free storage for archive staging');
    const output = new Map<string, Extracted>();
    for (const [index, entry] of entries.entries()) {
      const source = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)));
      const absolute = path.join(staging, String(index)); let count = 0, crc = 0xffffffff; const digest = createHash('sha256');
      const checker = new Transform({ transform(chunk: Buffer, _enc, callback) { count += chunk.length; if (count > entry.uncompressedSize || count > entryLimit(entry.fileName)) { callback(new Error('ZIP inflated beyond declared bounds')); return; } digest.update(chunk); crc = updateCRC(crc, chunk); callback(null, chunk); } });
      await pipeline(source, checker, createWriteStream(absolute, { flags: 'wx', mode: 0o600 }));
      if (count !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('ZIP size/CRC mismatch');
      output.set(entry.fileName, { absolute, proof: { path: entry.fileName, byteSize: count, sha256: digest.digest('hex') } });
    }
    return output;
  } finally { zip.close(); }
}
async function readJSON(entries: Map<string, Extracted>, name: string): Promise<any> { const entry = entries.get(name); if (!entry) throw new Error(`Missing archive file ${name}`); if(entry.proof.byteSize>67_108_864)throw new Error('JSON byte limit'); return strictJSON(await readUTF8(entry.absolute)); }
function validateProofs(manifest: ObjectJSON, entries: Map<string, Extracted>): void {
  if (!Array.isArray(manifest.files) || manifest.files.length > MAX_ENTRIES) throw new Error('Invalid manifest files');
  const listed = new Set<string>();
  for (const item of manifest.files as Proof[]) {
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
    const prefix = `${metadataRoot}/projects/${copy.id}/reports/`; if (!snapshot.path.startsWith(prefix) || !snapshot.path.endsWith('/snapshot.json')) throw new Error('Invalid report path');
    await verifyReport(vaultRoot,snapshot); await addTree(path.posix.dirname(snapshot.path));
  }
  const retained=copy.importedData.retainedSource as ObjectJSON|undefined;if(retained){if(typeof retained.path!=='string'||!retained.path.startsWith(`${metadataRoot}/projects/${copy.id}/sources/`))throw new Error('Invalid retained source path');await add(retained.path,'source',retained as {sha256:string;byteSize:number});}
  const projectData = Buffer.from(stringify(copy)); if(projectData.length>67_108_864)throw new Error('Project JSON byte limit'); files.unshift({ data: projectData, entry: { path: 'project.json', kind: 'project', byteSize: projectData.length, sha256: hash(projectData) } });
  if (files.length + 1 > MAX_ENTRIES || files.reduce((sum, f) => sum + f.entry.byteSize, 0) > MAX_TOTAL) throw new Error('Export archive limit');
  const manifest = { format: 'traceweave.obsidian-backup', formatVersion: '1.0', requiredFeatures: ['centralized-metadata.v1'], sourceProjectId: copy.id, sourceRevision: copy.revision, exportedAt: new Date().toISOString(), files: files.map(f => f.entry) };
  await writePayloadZIP(vaultRoot,outputPath,[...files.map(f=>({source:f.source,data:f.data,proof:f.entry})),{data:Buffer.from(stringify(manifest)),proof:{path:'manifest.json',byteSize:Buffer.byteLength(stringify(manifest)),sha256:hash(stringify(manifest))}}]);
}

interface ZipPayload { source?: string; data?: Buffer; proof: Proof }
async function writePayloadZIP(vaultRoot:string,outputPath:string,files:ZipPayload[]):Promise<void> {
  const outputRelative = path.isAbsolute(outputPath) ? path.relative(path.resolve(vaultRoot), path.resolve(outputPath)).split(path.sep).join('/') : outputPath;
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
  if (Array.isArray(value)) for (const item of value) identityMap(item, map, collection);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (['origin','extensions','importedData','importProvenance','producer'].includes(key)) continue;
    if (['id','investigationId','typeId','nodeId','sourceNodeId','targetNodeId','blobId','assetId','subjectId','groupNodeId','memberNodeId','reportDefinitionId','snapshotId','deletionBatchId','objectId','inspector','projectId'].includes(key) && typeof item === 'string' && UUID.test(item) && !map.has(item)) map.set(item, randomUUID());
    if(key==='id'&&typeof item==='string'&&map.has(item)){const kind=({nodes:'node',assets:'asset',relations:'relation',blobs:'blob'} as Record<string,string>)[collection];if(kind)map.set(kind+':'+item,map.get(item)!);}
    identityMap(item, map,key);
  }
  return map;
}
function remap(value: any, map: Map<string, string>, key = ''): any {
  if (['origin','extensions','importedData','importProvenance','producer'].includes(key)) return value;
  if (Array.isArray(value)) return value.map(v => remap(v, map, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, remap(v,map,k)]));
  if (typeof value === 'string') {
    if (['id','investigationId','typeId','nodeId','sourceNodeId','targetNodeId','blobId','assetId','subjectId','groupNodeId','memberNodeId','reportDefinitionId','snapshotId','deletionBatchId','objectId','inspector','projectId','nodeIds','relationIds','assetIds','selectedNodeIds','orderedConclusionIds'].includes(key)) { if (UUID.test(value) && !map.has(value)) throw new Error('Unresolved archive UUID reference'); return map.get(value) ?? value; }
    if (['bodyMarkdown','descriptionMarkdown','noteMarkdown','introductionMarkdown','note'].includes(key)) return remapMarkdown(value,map);
  }
  return value;
}
// Rewrite typed destinations, preserving inline/fenced code and arbitrary prose UUIDs.
export function remapMarkdown(source: string, map: Map<string, string>): string {
  let fence: string | null = null;
  return source.split(/(\r?\n)/u).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (marker) { if (!fence) fence = marker[1]!; else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = null; return line; }
    if (fence) return line;
    return line.split(/(`+[^`]*`+)/u).map((part, index) => index % 2 ? part : part.replace(/(\]\(\s*<?|^ {0,3}\[[^\]]+\]:\s*<?|<)((?:node|asset|relation):)([a-f0-9-]{36})(?=[#\s>)])/gu, (_all, prefix: string, kind: string, id: string) => { const target = map.get(map.has('__typed')?kind+id:id); if (!target) throw new Error('Unresolved Markdown archive reference'); return prefix + kind + target; })).join('');
  }).join('');
}
function validateArchiveReferences(raw: ObjectJSON): void {
  const collectionNames = ['nodeTypes','relationTypes','nodes','attributes','relations','assets','attachments','evidence','reports','snapshots','deletionBatches','blobs']; const indexes = new Map<string, Map<string,ObjectJSON>>(), seen = new Set<string>([raw.investigation.id]);
  for (const name of collectionNames) { const index = new Map<string,ObjectJSON>(); for (const item of raw[name]) { if (seen.has(item.id) || (item.investigationId !== undefined && item.investigationId !== raw.investigation.id)) throw new Error('Duplicate or foreign archive identity'); seen.add(item.id); index.set(item.id,item); } indexes.set(name,index); }
  const lookup = (name: string, id: string) => { const item = indexes.get(name)?.get(id); if (!item) throw new Error(`Missing ${name} reference`); return item; };
  const unique=(values:unknown[],label:string)=>{if(new Set(values).size!==values.length)throw new Error('Duplicate semantic key '+label);};
  for(const name of ['nodeTypes','relationTypes'])unique(raw[name].map((item:ObjectJSON)=>item.code),name);
  const opaque=(value:unknown):void=>{if(typeof value==='string'&&(seen.has(value)||/(?:node|asset|relation):/u.test(value)))throw new Error('Unsupported identity in opaque extensions');if(Array.isArray(value))for(const item of value)opaque(item);else if(value&&typeof value==='object')for(const item of Object.values(value))opaque(item);};
  const layouts = new Set<string>(); for (const item of raw.layouts) { lookup('nodes',item.nodeId); if (item.investigationId !== raw.investigation.id || layouts.has(item.nodeId)) throw new Error('Invalid layout'); layouts.add(item.nodeId); } if (layouts.size !== raw.nodes.length) throw new Error('Every node requires a layout');
  for (const node of raw.nodes) {lookup('nodeTypes',node.typeId);opaque(node.extensions);}
  for(const name of ['nodes','relations','assets'])for(const item of raw[name]){if((item.deletedAt===null)!==(item.deletionBatchId===null))throw new Error('Inconsistent deletion metadata');if(item.deletionBatchId!==null)lookup('deletionBatches',item.deletionBatchId);}
  for (const relation of raw.relations) { const from=lookup('nodes',relation.sourceNodeId),to=lookup('nodes',relation.targetNodeId); if (from.id===to.id||(!relation.deletedAt&&(from.deletedAt||to.deletedAt))||(relation.bidirectional&&!relation.directed)||!raw.relationTypes.some((type: ObjectJSON) => type.code === relation.relationType)) throw new Error('Invalid relation endpoints/type'); }
  const attrs:string[]=[];
  for (const attribute of raw.attributes) {lookup('nodes',attribute.nodeId);const normalized=attribute.key.normalize('NFC').toLowerCase().replace(/ß/gu,'ss').replace(/ς/gu,'σ').trim();if(attribute.normalizedKey!==normalized)throw new Error('Incorrect normalized attribute key');attrs.push(attribute.nodeId+':'+attribute.normalizedKey);}unique(attrs,'attributes');
  unique(raw.blobs.map((blob:ObjectJSON)=>blob.sha256+':'+blob.byteSize),'blobs');
  for (const asset of raw.assets) { const blob = lookup('blobs',asset.blobId); if (blob.sha256 !== asset.sha256 || blob.byteSize !== asset.byteSize) throw new Error('Asset/blob integrity mismatch'); }
  const memberIds:string[]=[];
  for(const member of raw.memberships){const group=lookup('nodes',member.groupNodeId),node=lookup('nodes',member.memberNodeId),groupType=lookup('nodeTypes',group.typeId),nodeType=lookup('nodeTypes',node.typeId);if(member.investigationId!==raw.investigation.id||group.id===node.id||groupType.code!=='group'||!groupType.isSystem||nodeType.code==='group'||group.deletedAt||node.deletedAt)throw new Error('Invalid group membership');memberIds.push(node.id);}unique(memberIds,'memberships');
  const pairs:string[]=[],primaries:string[]=[];
  for (const attachment of raw.attachments) { const node=lookup('nodes',attachment.nodeId),asset=lookup('assets',attachment.assetId);if(!node.deletedAt&&asset.deletedAt)throw new Error('Active attachment to trash');pairs.push(node.id+':'+asset.id);if(attachment.role==='primary')primaries.push(node.id); }unique(pairs,'attachments');unique(primaries,'primary attachments');
  for (const evidence of raw.evidence) { lookup(evidence.subjectKind === 'node' ? 'nodes':'relations',evidence.subjectId); if (evidence.sourceKind === 'node') lookup('nodes',evidence.sourceNodeId); if (evidence.sourceKind === 'asset') lookup('assets',evidence.assetId); }
  for (const report of raw.reports) {for (const id of [...report.selectedNodeIds,...report.orderedConclusionIds])lookup('nodes',id);for(const id of report.orderedConclusionIds){const node=lookup('nodes',id);if(lookup('nodeTypes',node.typeId).code!=='conclusion'||(report.scopeMode==='selection'&&!report.selectedNodeIds.includes(id)))throw new Error('Invalid report conclusion scope');}}
  const historicalKinds=new Map<string,string>();for(const [kind,index]of indexes)for(const id of index.keys())historicalKinds.set(id,kind);
  const pinKeys:string[]=[];
  for (const pin of raw.snapshotAssets) { const snapshot = lookup('snapshots',pin.snapshotId); lookup('assets',pin.assetId);const blob=lookup('blobs',pin.blobId),historical=snapshot.content.assets.find((asset: ObjectJSON) => asset.id === pin.assetId && asset.blobId === pin.blobId); if (pin.investigationId !== raw.investigation.id || !historical || historical.sha256!==blob.sha256 || historical.byteSize!==blob.byteSize) throw new Error('Invalid snapshot pin');pinKeys.push(pin.snapshotId+':'+pin.assetId); }unique(pinKeys,'snapshot pins');
  for(const snapshot of raw.snapshots){
    lookup('reports',snapshot.reportDefinitionId);const content=snapshot.content;if(content.definition.id!==snapshot.reportDefinitionId||content.definition.investigationId!==raw.investigation.id)throw new Error('Historical report identity mismatch');
    const historical=new Map<string,Map<string,ObjectJSON>>();
    for(const kind of ['nodes','attributes','relations','nodeTypes','relationTypes','attachments','assets']){const index=new Map<string,ObjectJSON>();for(const item of content[kind]){if(index.has(item.id)||(kind!=='attributes'&&item.investigationId!==raw.investigation.id)||item.id===raw.investigation.id||(historicalKinds.has(item.id)&&historicalKinds.get(item.id)!==kind))throw new Error('Duplicate/foreign historical identity');historicalKinds.set(item.id,kind);index.set(item.id,item);}historical.set(kind,index);}
    const local=(kind:string,id:string)=>{const item=historical.get(kind)?.get(id);if(!item)throw new Error('Missing historical '+kind+' reference');return item;};
    for(const node of content.nodes)local('nodeTypes',node.typeId);
    for(const relation of content.relations){local('nodes',relation.sourceNodeId);local('nodes',relation.targetNodeId);if(!content.relationTypes.some((type:ObjectJSON)=>type.code===relation.relationType))throw new Error('Unknown historical relation type');}
    for(const attribute of content.attributes)local('nodes',attribute.nodeId);
    for(const attachment of content.attachments){local('nodes',attachment.nodeId);local('assets',attachment.assetId);}
    const evidenceIds=new Set<string>();for(const wrapper of content.evidence){const item=wrapper.evidence;if(evidenceIds.has(item.id)||item.investigationId!==raw.investigation.id||(historicalKinds.has(item.id)&&historicalKinds.get(item.id)!=='evidence'))throw new Error('Historical evidence identity mismatch');evidenceIds.add(item.id);historicalKinds.set(item.id,'evidence');local(item.subjectKind==='node'?'nodes':'relations',item.subjectId);if(wrapper.sourceStatus==='outside_scope'&&wrapper.sourceTitle!==null)throw new Error('Outside-scope source title leak');if(wrapper.sourceStatus==='included'){if(item.sourceKind==='node')local('nodes',item.sourceNodeId);if(item.sourceKind==='asset')local('assets',item.assetId);}}
    for(const asset of content.assets)if(!pinKeys.includes(snapshot.id+':'+asset.id))throw new Error('Missing historical blob pin');
    for(const warning of content.warnings){if(warning.objectKind==='evidence'){if(!evidenceIds.has(warning.objectId))throw new Error('Missing historical warning target');}else local(warning.objectKind==='node'?'nodes':warning.objectKind==='asset'?'assets':'relations',warning.objectId);}
  }
  for(const batch of raw.deletionBatches){for(const [name,key]of [['nodes','nodeIds'],['relations','relationIds'],['assets','assetIds']]){unique(batch[key!],key!);for(const id of batch[key!]){const item=lookup(name!,id);if(item.deletionBatchId!==batch.id||!item.deletedAt)throw new Error('Deletion membership mismatch');}const expected=raw[name!].filter((item:ObjectJSON)=>item.deletionBatchId===batch.id).map((item:ObjectJSON)=>item.id);if(expected.length!==batch[key!].length)throw new Error('Incomplete deletion batch');}const previous:string[]=[];for(const member of batch.previousMemberships){const group=lookup('nodes',member.groupNodeId),node=lookup('nodes',member.memberNodeId);if(member.investigationId!==raw.investigation.id||group.id===node.id||lookup('nodeTypes',group.typeId).code!=='group'||lookup('nodeTypes',node.typeId).code==='group')throw new Error('Invalid previous membership');previous.push(node.id);}unique(previous,'previous members');}

}

export async function stageImport(vaultRoot: string, zipPath: string, metadataRoot = DATA_ROOT): Promise<StagedImport> {
  safeRelative(metadataRoot);
  const operation = randomUUID(), stagingRelative = `${metadataRoot}/imports/${operation}`;
  const staging = path.dirname(await resolveSafe(vaultRoot, `${stagingRelative}/staging-file`, true));
  const extractedRoot = path.join(staging, 'extracted'); await fs.mkdir(extractedRoot);
  const planned: { source: string; target: string; proof: { sha256: string; byteSize: number } }[] = [], created: { absolute: string; proof: { sha256: string; byteSize: number } }[] = [];
  let committed = false;
  try {
    const zipProof=await digestFile(zipPath,{},MAX_ARCHIVE);let entries = await extractZIP(zipPath, extractedRoot);const warnings:string[]=[];let originalSource: {sha256:string;byteSize:number}|undefined;
    if(!entries.has('manifest.json')&&!entries.has('project.json')){entries=await convertObsidianExport(entries,staging,warnings);originalSource=zipProof;}
    const manifest = await readJSON(entries,'manifest.json'); validateProofs(manifest,entries);let source = await readJSON(entries,'project.json');
    let project: Project; const targets = new Set<string>();
    function plan(sourcePath: string, target: string, proof: { sha256: string; byteSize: number }): void { safeRelative(target); if (targets.has(pathKey(target))) throw new Error('Duplicate import target'); targets.add(pathKey(target)); planned.push({ source: sourcePath, target, proof }); }
    async function planJSON(value: unknown, target: string): Promise<void> { const bytes = stringify(value), sourcePath = path.join(staging, `prepared-${planned.length}`); await fs.writeFile(sourcePath,bytes,{flag:'wx',mode:0o600}); plan(sourcePath,target,{sha256:hash(bytes),byteSize:Buffer.byteLength(bytes)}); }
    async function planText(text: string, target: string): Promise<void> { const sourcePath = path.join(staging, `prepared-${planned.length}`); await fs.writeFile(sourcePath,text,{flag:'wx',mode:0o600}); plan(sourcePath,target,{sha256:hash(text),byteSize:Buffer.byteLength(text)}); }
    if (manifest.format === 'traceweave.obsidian-backup') {
      if (manifest.formatVersion !== '1.0' || JSON.stringify(manifest.requiredFeatures) !== JSON.stringify(['centralized-metadata.v1']) || manifest.sourceProjectId !== source.id || manifest.sourceRevision !== source.revision) throw new Error('Unsupported backup version/features/source');
      validateProject(source); const original: Project = source, map = identityMap(original); if(original.importedData.sourceArchive)identityMap(original.importedData.sourceArchive,map);for(const file of manifest.files as BundleFile[])if(file.kind==='snapshot')identityMap(await readJSON(entries,file.path),map); project = remap(original,map) as Project; if(original.importedData.sourceArchive)project.importedData.sourceArchive=remap(original.importedData.sourceArchive,map); project.id = map.get(original.id)!; project.revision = original.revision; project.receipts = {};
      project.importedData = { ...project.importedData, sourceProjectId: original.id, sourceRevision: original.revision, importedAt: new Date().toISOString() };
      const payloads = manifest.files as BundleFile[]; const byOriginal = new Map<string,BundleFile>();
      for (const record of payloads) { if (record.path === 'project.json') { if (record.kind !== 'project') throw new Error('Invalid project payload'); continue; } if (!record.originalPath || byOriginal.has(pathKey(record.originalPath)) || !['note','blob','snapshot','report','source'].includes(record.kind)) throw new Error('Invalid backup payload'); safeRelative(record.originalPath); byOriginal.set(pathKey(record.originalPath),record); }
      const used = new Set<string>();
      function fromOriginal(relative: string, kind: BundleFile['kind'], target: string): BundleFile { const record = byOriginal.get(pathKey(relative)); if (!record || record.kind !== kind) throw new Error('Backup payload missing or kind mismatch'); used.add(record.path); const entry = entries.get(record.path)!; plan(entry.absolute,target,entry.proof); return record; }
      for (let i = 0; i < project.nodes.length; i++) {
        const node = project.nodes[i]!, old = original.nodes[i]!; node.notePath = `${NOTES_ROOT}/${project.id}/${node.id}.md`; node.missing = false;
        const record = byOriginal.get(pathKey(old.notePath)); if (!record || record.kind !== 'note') throw new Error('Missing backed-up note'); used.add(record.path);
        if (record.byteSize > 5_242_880) throw new Error('Note byte limit'); const text = await readUTF8(entries.get(record.path)!.absolute); const mapped = remapMarkdown(text,map); await planText(mapped,node.notePath); node.noteHash = hash(mapped);
      }
      for (let i = 0; i < project.blobs.length; i++) { const blob = project.blobs[i]!, old = original.blobs[i]!; blob.path = `${RESOURCES_ROOT}/${project.id}/${blob.id}/original${safeSuffix(old.path)}`; const record = fromOriginal(old.path,'blob',blob.path); if (record.sha256 !== blob.sha256 || record.byteSize !== blob.byteSize) throw new Error('Backup blob metadata mismatch'); }
      const retained=original.importedData.retainedSource as ObjectJSON|undefined;
      if(retained){if(typeof retained.path!=='string'||!metadataRoots.some(root=>retained.path.startsWith(`${root}/projects/${original.id}/sources/`)))throw new Error('Invalid retained legacy source');const target=`${metadataRoot}/projects/${project.id}/sources/legacy-export.zip`;const record=fromOriginal(retained.path,'source',target);if(record.sha256!==retained.sha256||record.byteSize!==retained.byteSize)throw new Error('Retained source integrity mismatch');project.importedData.retainedSource={...retained,path:target};}
      for (let i = 0; i < project.snapshots.length; i++) {
        const snapshot = project.snapshots[i]!, old = original.snapshots[i]!, oldDir = path.posix.dirname(old.path), targetDir = `${metadataRoot}/projects/${project.id}/reports/${snapshot.id}`; snapshot.path = `${targetDir}/snapshot.json`;
        if (!metadataRoots.some(root => old.path === `${root}/projects/${original.id}/reports/${old.id}/snapshot.json`)) throw new Error('Invalid snapshot source path');
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
      let presentation:ObjectJSON,profile='2.0';
      if(manifest.formatVersion==='1.0'){
        profile=validateLegacyArchive(manifest,source);source=migrateLegacyArchive(source);archiveValidator('Project',source);presentation=defaultPresentation();warnings.push(`Импортирован архив 1.0 (${profile}); камера и панели установлены по умолчанию. Отсутствующая двусторонность означает false.`);
      }else{
        if (manifest.formatVersion !== '2.0' || manifest.schemaId !== 'research-graph.archive/2.0' || manifest.schemaSha256 !== archiveIndex.schemas['2.0.schema.json'].sha256) throw new Error('Unsupported TraceWeave archive version/schema');
        archiveValidator('Manifest',manifest); archiveValidator('Project',source);presentation=await readJSON(entries,'presentation.json');archiveValidator('Presentation',presentation);
      }
      if (manifest.sourceInvestigationId !== source.investigation.id || manifest.sourceRevision !== source.investigation.revision) throw new Error('Archive source identity mismatch');
      validateArchiveReferences(source);
      const expected = new Set(manifest.formatVersion==='1.0'?['project.json']:['project.json','presentation.json']);
      for (const blob of source.blobs) { expected.add(blob.path); const proof = entries.get(blob.path)?.proof; if (blob.path !== `blobs/${blob.sha256}` || !proof || proof.sha256 !== blob.sha256 || proof.byteSize !== blob.byteSize) throw new Error('Original SHA/size mismatch'); }
      if (expected.size !== entries.size - 1 || [...expected].some(name => !entries.has(name))) throw new Error('Unexpected archive payload');
      const map = identityMap(source), raw = remap(source,map), now = new Date().toISOString(), evidenceFor = (id: string): Evidence[] => raw.evidence.filter((e: ObjectJSON) => e.subjectId === id).map((e: ObjectJSON) => ({ id:e.id, sourceKind:e.sourceKind, sourceNodeId:e.sourceNodeId, assetId:e.assetId, url:e.url, label:e.label, quote:e.quote, locator:e.locator, note:e.note, accessedAt:e.accessedAt }));
      const layout = new Map<string,ObjectJSON>(raw.layouts.map((v: ObjectJSON) => [v.nodeId,v]));
      project = { format:'traceweave.obsidian-project',formatVersion:'1.0',requiredFeatures:[],id:raw.investigation.id,title:raw.investigation.title,descriptionMarkdown:raw.investigation.descriptionMarkdown,status:raw.investigation.status,revision:raw.investigation.revision,createdAt:raw.investigation.createdAt,updatedAt:now,
        nodes:raw.nodes.map((n: ObjectJSON): ProjectNode => ({ id:n.id,title:n.title,notePath:`${NOTES_ROOT}/${raw.investigation.id}/${n.id}.md`,noteHash:hash(n.bodyMarkdown),typeId:n.typeId,iconEmoji:n.iconEmoji ?? null,assessment:n.assessment,confidence:n.confidence,attributes:raw.attributes.filter((a: ObjectJSON) => a.nodeId===n.id).map((a: ObjectJSON) => ({id:a.id,key:a.key,valueType:a.valueType,value:a.value,sortOrder:a.sortOrder})),evidence:evidenceFor(n.id),x:layout.get(n.id)!.x,y:layout.get(n.id)!.y,zIndex:layout.get(n.id)!.zIndex,createdAt:n.createdAt,updatedAt:n.updatedAt,deletedAt:n.deletedAt,deletionBatchId:n.deletionBatchId,missing:false,subtitle:n.subtitle,tags:n.tags,origin:n.origin,extensions:n.extensions })),
        nodeTypes:raw.nodeTypes.map((t: ObjectJSON) => ({id:t.id,code:t.code,name:t.name,color:t.color,iconKey:t.iconKey,isHidden:t.isHidden,isSystem:t.isSystem})),relationTypes:raw.relationTypes.map((t: ObjectJSON) => ({code:t.code,name:t.name,defaultDirected:t.defaultDirected})),
        relations:raw.relations.map((r: ObjectJSON): Relation => ({ id:r.id,sourceNodeId:r.sourceNodeId,targetNodeId:r.targetNodeId,relationType:r.relationType,label:r.label,directed:r.directed,bidirectional:r.bidirectional ?? false,assessment:r.assessment,confidence:r.confidence,noteMarkdown:r.noteMarkdown,evidence:evidenceFor(r.id),deletedAt:r.deletedAt,deletionBatchId:r.deletionBatchId,createdAt:r.createdAt,updatedAt:r.updatedAt,origin:r.origin })),
        memberships:raw.memberships.map((m: ObjectJSON) => ({groupNodeId:m.groupNodeId,memberNodeId:m.memberNodeId,sortOrder:m.sortOrder})),
        blobs:raw.blobs.map((b: ObjectJSON,i: number): BlobRecord => { const asset = raw.assets.find((a: ObjectJSON) => a.blobId === b.id); return {id:b.id,path:`${RESOURCES_ROOT}/${raw.investigation.id}/${b.id}/original${safeSuffix(asset?.originalName ?? '')}`,sha256:b.sha256,byteSize:b.byteSize,mimeType:asset?.mimeType ?? b.verifiedMimeType ?? 'application/octet-stream',mediaKind:asset?.mediaKind ?? b.mediaKind ?? 'file'}; }),
        assets:raw.assets.map((a: ObjectJSON): Asset => ({id:a.id,blobId:a.blobId,originalName:a.originalName,title:a.title,mimeType:a.mimeType,mediaKind:a.mediaKind,byteSize:a.byteSize,sha256:a.sha256,createdAt:a.createdAt,deletedAt:a.deletedAt,deletionBatchId:a.deletionBatchId,sourceUrl:a.sourceUrl,sourceAuthor:a.sourceAuthor,sourceCreatedAt:a.sourceCreatedAt,noteMarkdown:a.noteMarkdown,origin:a.origin})),
        attachments:raw.attachments.map((a: ObjectJSON) => ({id:a.id,nodeId:a.nodeId,assetId:a.assetId,role:a.role,sortOrder:a.sortOrder,caption:a.caption})),
        deletionBatches:raw.deletionBatches.map((b: ObjectJSON) => ({id:b.id,nodeIds:b.nodeIds,relationIds:b.relationIds,memberships:b.previousMemberships.map((m: ObjectJSON) => ({groupNodeId:m.groupNodeId,memberNodeId:m.memberNodeId,sortOrder:m.sortOrder})),createdAt:b.createdAt})),snapshots:[],receipts:{},
        importedData:{sourceFormat:originalSource?'traceweave.obsidian-export/1':`research-graph.archive/${manifest.formatVersion}`,legacyProfile:profile,sourceProjectId:source.investigation.id,sourceRevision:source.investigation.revision,importedAt:now,presentation:remap(presentation,map),sourceArchive:{nodeTypes:raw.nodeTypes,relationTypes:raw.relationTypes,reports:raw.reports,deletionBatches:raw.deletionBatches,snapshotAssets:raw.snapshotAssets}} };
      for (const node of project.nodes) await planText(raw.nodes.find((n: ObjectJSON) => n.id === node.id).bodyMarkdown,node.notePath);
      for (let i = 0; i < project.blobs.length; i++) { const blob=project.blobs[i]!, old=source.blobs[i], entry=entries.get(old.path)!; const preview=await verifiedMediaInfo(entry.absolute,blob.path); blob.mimeType=preview.mimeType; blob.mediaKind=preview.mediaKind; for (const asset of project.assets.filter(a=>a.blobId===blob.id)) { asset.mimeType=preview.mimeType; asset.mediaKind=preview.mediaKind; } plan(entry.absolute,blob.path,entry.proof); }
      for (const snapshot of raw.snapshots) {
        const snapshotPath = `${metadataRoot}/projects/${project.id}/reports/${snapshot.id}/snapshot.json`, definition = raw.reports.find((r: ObjectJSON) => r.id === snapshot.reportDefinitionId), assetIds = snapshot.content.assets.map((a: ObjectJSON) => a.id);
        await planJSON(snapshot,snapshotPath);
        const markdown = `# ${definition?.title ?? 'Imported report'}\n\n` + snapshot.content.nodes.map((node: ObjectJSON) => `## ${node.title}\n\n${node.bodyMarkdown}\n`).join('\n'); await planText(markdown,path.posix.dirname(snapshotPath)+'/report.md');
        for (const blobId of new Set<string>(snapshot.content.assets.map((a: ObjectJSON) => a.blobId))) { const current = project.blobs.find(b => b.id === blobId)!; if (!current) throw new Error('Snapshot blob missing'); const index=raw.blobs.findIndex((b: ObjectJSON)=>b.id===blobId),entry=entries.get(source.blobs[index].path)!; plan(entry.absolute,path.posix.dirname(snapshotPath)+`/files/${blobId}${safeSuffix(current.path)}`,entry.proof); }
        const capturedProof=planned.find(item=>item.target===snapshotPath)!.proof,renderedProof=planned.find(item=>item.target===path.posix.dirname(snapshotPath)+'/report.md')!.proof;await planJSON({snapshotSha256:capturedProof.sha256,reportSha256:renderedProof.sha256,originals:planned.filter(item=>item.target.startsWith(path.posix.dirname(snapshotPath)+'/files/')).map(item=>({...item.proof,path:item.target.slice(path.posix.dirname(snapshotPath).length+1)}))},path.posix.dirname(snapshotPath)+'/integrity.json');
        project.snapshots.push({id:snapshot.id,title:definition?.title ?? 'Imported report',path:snapshotPath,sourceRevision:snapshot.sourceRevision,createdAt:snapshot.createdAt,assetIds});
      }
    } else throw new Error('Unsupported archive. Use full TraceWeave archive 2.0 or plugin backup 1.0; legacy Obsidian exports require explicit reconciliation.');
    if(originalSource){const target=`${metadataRoot}/projects/${project.id}/sources/legacy-export.zip`;plan(zipPath,target,originalSource);project.importedData.retainedSource={...originalSource,path:target};}
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

export async function createReport(vaultRoot: string, project: Project, title: string, nodeIds?: string[], metadataRoot = DATA_ROOT): Promise<SnapshotRecord> {
  validateProject(project); safeRelative(metadataRoot); if (!title.trim() || title.length > 200) throw new Error('Invalid report title');
  const selected = new Set(nodeIds ?? project.nodes.filter(n => !n.deletedAt).map(n => n.id)); if (!selected.size || [...selected].some(id => !project.nodes.some(n=>n.id===id && !n.deletedAt))) throw new Error('Report selection must contain active nodes');
  const id=randomUUID(), relative=`${metadataRoot}/projects/${project.id}/reports/${id}`, stage=`${metadataRoot}/reports-staging/${id}`, stageRoot=path.dirname(await resolveSafe(vaultRoot,`${stage}/snapshot.json`,true)), destination=path.dirname(await resolveSafe(vaultRoot,`${relative}/snapshot.json`,true));
  // resolveSafe creates parent directories, so promotion claims an absent final leaf explicitly.
  await fs.rmdir(destination);
  try {
    const nodes=[] as ObjectJSON[]; let capturedBytes=0;
    for (const node of project.nodes.filter(n=>selected.has(n.id))) { const absolute=await resolveSafe(vaultRoot,node.notePath),proof=await digestFile(absolute,{},5_242_880); capturedBytes+=proof.byteSize; if(capturedBytes>60_000_000)throw new Error('Report text byte limit'); const text=await readUTF8(absolute); if(hash(text)!==proof.sha256) throw new Error('Note changed during snapshot capture'); nodes.push({...structuredClone(node),bodyMarkdown:text,capturedHash:proof.sha256}); }
    const attachments=project.attachments.filter(a=>selected.has(a.nodeId)), assetIds=[...new Set(attachments.map(a=>a.assetId))],assets=project.assets.filter(a=>assetIds.includes(a.id)), blobs=project.blobs.filter(b=>assets.some(a=>a.blobId===b.id));
    const originals: BlobRecord[]=[];
    for (const blob of blobs) { const target=`files/${blob.id}${safeSuffix(blob.path)}`,absolute=await resolveSafe(vaultRoot,`${stage}/${target}`,true); await copyChecked(await resolveSafe(vaultRoot,blob.path),absolute,blob); originals.push({...blob,path:target}); }
    const snapshot={format:'traceweave.obsidian-snapshot',formatVersion:'1.0',id,title:title.trim(),projectId:project.id,sourceRevision:project.revision,createdAt:new Date().toISOString(),nodes,nodeTypes:structuredClone(project.nodeTypes),relations:structuredClone(project.relations.filter(r=>!r.deletedAt && selected.has(r.sourceNodeId)&&selected.has(r.targetNodeId))),relationTypes:structuredClone(project.relationTypes),memberships:project.memberships.filter(m=>selected.has(m.groupNodeId)&&selected.has(m.memberNodeId)),assets:structuredClone(assets),attachments:structuredClone(attachments),blobs:originals};
    const content=stringify(snapshot); if(Buffer.byteLength(content)>67_108_864)throw new Error('Snapshot JSON byte limit'); await writeExclusive(vaultRoot,`${stage}/snapshot.json`,content);
    const markdown=`# ${title.trim()}\n\nCaptured: ${snapshot.createdAt} · revision ${project.revision}\n\n`+nodes.map(n=>`## ${n.title}\n\n${n.bodyMarkdown}\n\n`+attachments.filter(a=>a.nodeId===n.id).map(a=>{const asset=assets.find(v=>v.id===a.assetId)!,blob=originals.find(b=>b.id===asset.blobId)!;return `[${asset.title.replace(/[\[\]]/gu,'')}](${blob.path})\n`;}).join('')).join('\n');
    await writeExclusive(vaultRoot,`${stage}/report.md`,markdown); await writeExclusive(vaultRoot,`${stage}/integrity.json`,stringify({snapshotSha256:hash(content),reportSha256:hash(markdown),originals:originals.map(blob=>({path:blob.path,sha256:blob.sha256,byteSize:blob.byteSize}))}));
    await fs.rename(stageRoot,destination); return {id,title:title.trim(),path:`${relative}/snapshot.json`,sourceRevision:project.revision,createdAt:snapshot.createdAt,assetIds};
  } catch(error) { await fs.rm(stageRoot,{recursive:true,force:true}); throw error; }
}

/** Server-compatible complete project archive. Vault backup remains the exact local profile. */
export async function exportTraceWeaveArchive(vaultRoot: string, project: Project, outputPath: string, metadataRoot = DATA_ROOT): Promise<void> {
  validateProject(project); safeRelative(metadataRoot);
  const investigationId = project.id, now = new Date().toISOString(), imported = project.importedData.sourceArchive as ObjectJSON | undefined;
  const normalizedKey = (value:string) => value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC').trim();
  const mimeSet = new Set(['text/plain','text/markdown','image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/wav','audio/ogg','audio/mp4','video/mp4','video/webm','video/quicktime','application/pdf','application/octet-stream']);
  const origin = (value: ObjectJSON): ObjectJSON => { const normalized = Object.hasOwn(value,'kind') ? value : {kind:'manual',...value}; archiveValidator('Origin',normalized); return normalized; };
  const nodeType = (value:ObjectJSON):ObjectJSON => ({id:value.id,investigationId,code:value.code,name:value.name,iconKey:value.iconKey,color:value.color,isSystem:value.isSystem,isHidden:value.isHidden,attributeTemplates:imported?.nodeTypes?.find((type:ObjectJSON)=>type.id===value.id)?.attributeTemplates ?? []});
  const relationTypes = project.relationTypes.map(value=>({id:imported?.relationTypes?.find((type:ObjectJSON)=>type.code===value.code)?.id ?? randomUUID(),investigationId,...value,isHidden:false}));
  const nodeRow = (node:ObjectJSON, bodyMarkdown:string):ObjectJSON => ({id:node.id,investigationId,typeId:node.typeId,title:node.title,subtitle:node.subtitle,bodyMarkdown,assessment:node.assessment,confidence:node.confidence,tags:node.tags,extensions:node.extensions,createdAt:node.createdAt,updatedAt:node.updatedAt,deletedAt:node.deletedAt,deletionBatchId:node.deletionBatchId,origin:origin(node.origin),iconEmoji:node.iconEmoji});
  const relationRow = (relation:ObjectJSON):ObjectJSON => ({id:relation.id,investigationId,sourceNodeId:relation.sourceNodeId,targetNodeId:relation.targetNodeId,relationType:relation.relationType,directed:relation.directed,bidirectional:relation.bidirectional,label:relation.label,noteMarkdown:relation.noteMarkdown,assessment:relation.assessment,confidence:relation.confidence,createdAt:relation.createdAt,updatedAt:relation.updatedAt,deletedAt:relation.deletedAt,deletionBatchId:relation.deletionBatchId,origin:origin(relation.origin)});
  const assetRow = (asset:ObjectJSON):ObjectJSON => { const supported=mimeSet.has(asset.mimeType); return {id:asset.id,investigationId,blobId:asset.blobId,originalName:asset.originalName,title:asset.title,mimeType:supported?asset.mimeType:'application/octet-stream',mediaKind:supported?asset.mediaKind:'file',byteSize:asset.byteSize,sha256:asset.sha256,createdAt:asset.createdAt,deletedAt:asset.deletedAt,deletionBatchId:asset.deletionBatchId,sourceUrl:asset.sourceUrl,sourceAuthor:asset.sourceAuthor,sourceCreatedAt:asset.sourceCreatedAt,noteMarkdown:asset.noteMarkdown,origin:origin(asset.origin)}; };
  const attributesFor=(nodes:ObjectJSON[]) => nodes.flatMap(node=>node.attributes.map((value:ObjectJSON)=>({...value,nodeId:node.id,normalizedKey:normalizedKey(value.key)})));
  const evidenceFor=(nodes:ObjectJSON[],relations:ObjectJSON[]) => [...nodes.map(node=>({subject:node,kind:'node'})),...relations.map(relation=>({subject:relation,kind:'relation'}))].flatMap(({subject,kind})=>(subject.evidence??[]).map((value:ObjectJSON)=>({...value,note:value.note??'',investigationId,subjectKind:kind,subjectId:subject.id})));
  const attachmentRows=(values:ObjectJSON[])=>values.map(value=>({...value,investigationId}));
  const sourceBlobs=new Map<string,{source:string;proof:Proof}>();
  async function addOriginal(blob:ObjectJSON,absolute:string):Promise<void>{const proof=await digestFile(absolute);if(proof.byteSize!==blob.byteSize||proof.sha256!==blob.sha256)throw new Error('Original changed or missing during archive export');const previous=sourceBlobs.get(blob.sha256);if(previous&&previous.proof.byteSize!==proof.byteSize)throw new Error('Conflicting content address');sourceBlobs.set(blob.sha256,{source:absolute,proof:{path:`blobs/${blob.sha256}`,...proof}});}
  const nodes=[] as ObjectJSON[];
  for(const node of project.nodes){const absolute=await resolveSafe(vaultRoot,node.notePath),proof=await digestFile(absolute,{},5_242_880),body=await readUTF8(absolute);if(hash(body)!==proof.sha256)throw new Error('Note changed during archive capture');nodes.push(nodeRow(node,body));}
  for(const blob of project.blobs)await addOriginal(blob,await resolveSafe(vaultRoot,blob.path));
  const reports:ObjectJSON[]=[],snapshots:ObjectJSON[]=[],snapshotAssets:ObjectJSON[]=[];
  for(const record of project.snapshots){
    await verifyReport(vaultRoot,record); const absolute=await resolveSafe(vaultRoot,record.path); await digestFile(absolute,{},67_108_864); const captured=strictJSON(await readUTF8(absolute));let snapshot:ObjectJSON;
    if(captured.content&&captured.reportDefinitionId&&captured.formatVersion==='1.0'){
      snapshot=structuredClone(captured);snapshot.investigationId=investigationId;snapshot.content.definition.investigationId=investigationId;delete snapshot.contentSha256;
      const integrity=strictJSON(await readUTF8(path.join(path.dirname(absolute),'integrity.json')));for(const asset of snapshot.content.assets){const blob=project.blobs.find(b=>b.id===asset.blobId),pinned=integrity.originals.find((item:ObjectJSON)=>item.sha256===asset.sha256&&item.byteSize===asset.byteSize);if(!blob||!pinned)throw new Error('Historical snapshot blob missing');await addOriginal(blob,path.join(path.dirname(absolute),safeRelative(pinned.path)));}
    }else if(captured.format==='traceweave.obsidian-snapshot'&&captured.formatVersion==='1.0'){
      const reportId=randomUUID(),definition={id:reportId,investigationId,title:record.title,introductionMarkdown:'',scopeMode:'selection',selectedNodeIds:captured.nodes.map((node:ObjectJSON)=>node.id),orderedConclusionIds:[],includeGroupMembers:false,includeAttachments:true,includeEvidence:true,createdAt:record.createdAt,updatedAt:record.createdAt};
      const snapshotNodes=captured.nodes.map((node:ObjectJSON)=>nodeRow(node,node.bodyMarkdown)),snapshotRelations=captured.relations.map(relationRow),snapshotAssetRows=captured.assets.map(assetRow),includedNodes=new Set(snapshotNodes.map((n:ObjectJSON)=>n.id)),includedAssets=new Set(snapshotAssetRows.map((a:ObjectJSON)=>a.id));
      const wrapped=evidenceFor(captured.nodes,captured.relations).map((e:ObjectJSON)=>{const included=e.sourceKind==='url'||(e.sourceKind==='node'?includedNodes.has(e.sourceNodeId):includedAssets.has(e.assetId));const sourceTitle=e.sourceKind==='node'?snapshotNodes.find((n:ObjectJSON)=>n.id===e.sourceNodeId)?.title:e.sourceKind==='asset'?snapshotAssetRows.find((a:ObjectJSON)=>a.id===e.assetId)?.title:null;return{evidence:e,sourceStatus:included?'included':'outside_scope',sourceTitle:included?sourceTitle??null:null};});
      const warnings=wrapped.filter((w:ObjectJSON)=>w.sourceStatus==='outside_scope').map((w:ObjectJSON)=>({code:'source_outside_scope',objectKind:'evidence',objectId:w.evidence.id,message:'Источник находится вне явного состава снимка.'}));
      snapshot={id:record.id,reportDefinitionId:reportId,investigationId,sourceRevision:record.sourceRevision,createdAt:record.createdAt,formatVersion:'1.0',importProvenance:null,content:{investigationTitle:project.title,definition,nodes:snapshotNodes,attributes:attributesFor(captured.nodes),relations:snapshotRelations,nodeTypes:captured.nodeTypes.map(nodeType),relationTypes,attachments:attachmentRows(captured.attachments),assets:snapshotAssetRows,evidence:wrapped,warnings}};
      for(const blob of captured.blobs)await addOriginal(blob,path.join(path.dirname(absolute),safeRelative(blob.path)));
    }else throw new Error('Unsupported immutable snapshot format');
    if(!reports.some(report=>report.id===snapshot.reportDefinitionId))reports.push(snapshot.content.definition);snapshots.push(snapshot);
    for(const asset of snapshot.content.assets)snapshotAssets.push({investigationId,snapshotId:snapshot.id,assetId:asset.id,blobId:asset.blobId});
  }
  const raw:ObjectJSON={format:'research-graph.project',formatVersion:'2.0',investigation:{id:investigationId,title:project.title,descriptionMarkdown:project.descriptionMarkdown,status:project.status,revision:project.revision,createdAt:project.createdAt,updatedAt:project.updatedAt,archivedAt:project.status==='archived'?project.updatedAt:null},
    blobs:project.blobs.map(blob=>({id:blob.id,investigationId,sha256:blob.sha256,byteSize:blob.byteSize,path:`blobs/${blob.sha256}`})),nodeTypes:project.nodeTypes.map(nodeType),relationTypes,nodes,attributes:attributesFor(project.nodes),layouts:project.nodes.map(node=>({nodeId:node.id,investigationId,x:node.x,y:node.y,zIndex:node.zIndex})),memberships:project.memberships.map(value=>({...value,investigationId})),relations:project.relations.map(relationRow),assets:project.assets.map(assetRow),attachments:attachmentRows(project.attachments),evidence:evidenceFor(project.nodes,project.relations),reports,snapshots,snapshotAssets,deletionBatches:project.deletionBatches.map(batch=>({id:batch.id,investigationId,createdAt:batch.createdAt,nodeIds:batch.nodeIds,relationIds:batch.relationIds,assetIds:project.assets.filter(asset=>asset.deletionBatchId===batch.id).map(asset=>asset.id),previousMemberships:batch.memberships.map(value=>({...value,investigationId}))}))};
  archiveValidator('Project',raw);validateArchiveReferences(raw);
  const presentation=defaultPresentation();archiveValidator('Presentation',presentation);
  const payloads:ZipPayload[]=[];for(const [name,value]of [['project.json',raw],['presentation.json',presentation]]as const){const data=Buffer.from(stringify(value));if(data.length>entryLimit(name))throw new Error('Archive metadata byte limit');payloads.push({data,proof:{path:name,byteSize:data.length,sha256:hash(data)}});}
  payloads.push(...sourceBlobs.values());
  const manifest={format:'research-graph.archive',formatVersion:'2.0',exportedAt:now,sourceInvestigationId:investigationId,sourceRevision:project.revision,projectPath:'project.json',presentationPath:'presentation.json',includesTrash:true,includesSnapshots:true,schemaId:'research-graph.archive/2.0',schemaSha256:archiveIndex.schemas['2.0.schema.json'].sha256,producer:{version:`traceweave-obsidian/${pluginManifest.version}`,releaseTag:null,backendCommit:null,frontendCommit:null,contractsCommit:null},requiredFeatures:['full-project.v1','presentation.v1','node-icon-emoji.v1'],files:payloads.map(value=>value.proof)};archiveValidator('Manifest',manifest);
  const data=Buffer.from(stringify(manifest));if(data.length>entryLimit('manifest.json')||payloads.length+1>MAX_ENTRIES||payloads.reduce((sum,value)=>sum+value.proof.byteSize,0)>MAX_TOTAL)throw new Error('Archive total byte/entry limit');payloads.push({data,proof:{path:'manifest.json',byteSize:data.length,sha256:hash(data)}});
  await writePayloadZIP(vaultRoot,outputPath,payloads);
}


export async function verifyReport(vaultRoot:string,record:SnapshotRecord):Promise<void>{
  const directory=path.posix.dirname(record.path),integrityPath=await resolveSafe(vaultRoot,directory+'/integrity.json');await digestFile(integrityPath,{},16_777_216);const integrity=strictJSON(await readUTF8(integrityPath));
  if(!HASH.test(integrity.snapshotSha256)||!HASH.test(integrity.reportSha256))throw new Error('Invalid report integrity record');
  const snapshot=await digestFile(await resolveSafe(vaultRoot,record.path),{},67_108_864),markdown=await digestFile(await resolveSafe(vaultRoot,directory+'/report.md'),{},67_108_864);
  if(snapshot.sha256!==integrity.snapshotSha256||markdown.sha256!==integrity.reportSha256)throw new Error('Immutable report file changed');
  if(!Array.isArray(integrity.originals)||integrity.originals.length>MAX_ENTRIES)throw new Error('Missing immutable originals manifest');const paths=new Set<string>();
  for(const blob of integrity.originals){safeRelative(blob.path);if(!blob.path.startsWith('files/')||paths.has(pathKey(blob.path))||!HASH.test(blob.sha256)||!Number.isSafeInteger(blob.byteSize)||blob.byteSize<0||blob.byteSize>MAX_ORIGINAL_BYTES)throw new Error('Invalid immutable originals manifest');paths.add(pathKey(blob.path));const proof=await digestFile(await resolveSafe(vaultRoot,directory+'/'+blob.path));if(proof.sha256!==blob.sha256||proof.byteSize!==blob.byteSize)throw new Error('Immutable report original changed');}
}

function defaultPresentation():ObjectJSON{return{formatVersion:1,viewport:{x:0,y:0,zoom:1},inspector:null,details:true,outline:false,cardShrinkFactor:2,iconSizeFactor:1};}
const legacyValidators=new Map<string,{manifest:ValidateFunction;project:ValidateFunction;ajv:Ajv2020}>();
function validateLegacyArchive(manifest:ObjectJSON,project:ObjectJSON):string{
  const failures:string[]=[];
  for(const [profile,schema]of [['legacy-1.0-019',legacyModern],['legacy-1.0-initial',legacyInitial]]as const){
    let validator=legacyValidators.get(profile);
    if(!validator){const ajv=new Ajv2020({strict:false,allErrors:false});ajv.addFormat('uuid',UUID);ajv.addFormat('date-time',{type:'string',validate:(v:string)=>!Number.isNaN(Date.parse(v))});ajv.addFormat('uri',{type:'string',validate:(v:string)=>{try{new URL(v);return true;}catch{return false;}}});ajv.addSchema(schema);validator={ajv,manifest:ajv.compile({$ref:schema.$id+'#/$defs/Manifest'}),project:ajv.compile({$ref:schema.$id+'#/$defs/Project'})};legacyValidators.set(profile,validator);}
    if(validator.manifest(manifest)&&validator.project(project))return profile;
    failures.push(profile+': '+validator.ajv.errorsText(validator.manifest.errors??validator.project.errors));
  }
  throw new Error('Unsupported legacy archive: '+failures.join('; '));
}
function migrateLegacyArchive(value:any,key=''):any{
  if(['origin','extensions','importProvenance','producer'].includes(key))return value;
  if(Array.isArray(value))return value.map(item=>migrateLegacyArchive(item,key));
  if(value&&typeof value==='object'){const copy:ObjectJSON=Object.fromEntries(Object.entries(value).map(([name,item])=>[name,migrateLegacyArchive(item,name)]));if(copy.format==='research-graph.project')copy.formatVersion='2.0';if(copy.sourceNodeId!==undefined&&copy.targetNodeId!==undefined&&copy.relationType!==undefined&&copy.bidirectional===undefined)copy.bidirectional=false;return copy;}
  return value;
}
async function convertObsidianExport(entries:Map<string,Extracted>,staging:string,warnings:string[]):Promise<Map<string,Extracted>>{
  const snapshot=await readJSON(entries,'metadata/snapshot.json'),files=await readJSON(entries,'metadata/files.json');
  const allowed=['formatVersion','investigationId','title','descriptionMarkdown','sourceRevision','capturedAt','nodeTypes','relationTypes','nodes','attributes','relations','layouts','memberships','attachments','assets','evidence'];
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||Object.keys(snapshot).some(key=>!allowed.includes(key))||snapshot.formatVersion!==1||!UUID.test(snapshot.investigationId))throw new Error('Unsupported legacy Obsidian snapshot format');
  for(const name of ['nodeTypes','relationTypes','nodes','attributes','relations','layouts','memberships','attachments','assets','evidence'])if(!Array.isArray(snapshot[name]))throw new Error('Missing legacy Obsidian collection '+name);
  if(!files||files.formatVersion!==1||Object.keys(files).some(key=>!['formatVersion','documents','relations','assets'].includes(key)))throw new Error('Unsupported legacy Obsidian file map');
  const usedPaths=new Set<string>();
  for(const [mapName,collection,prefix]of [['documents','nodes','Documents/'],['relations','relations','Relations/'],['assets','assets','Attachments/']]as const){
    const mapping=files[mapName];if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw new Error('Invalid legacy file map');
    const ids=new Set(snapshot[collection].map((item:ObjectJSON)=>item.id));if(ids.size!==snapshot[collection].length||ids.size!==Object.keys(mapping).length)throw new Error('Legacy file map must match snapshot identities');
    for(const [id,name]of Object.entries(mapping)){if(!ids.has(id)||typeof name!=='string')throw new Error('Invalid legacy map identity/path');safeRelative(name);if(!name.startsWith(prefix)||!entries.has(name)||usedPaths.has(pathKey(name))||(mapName!=='assets'&&!name.endsWith('.md')))throw new Error('Missing, duplicated or unsafe legacy map path');usedPaths.add(pathKey(name));}
  }
  const converted=new Map<string,Extracted>(),blobs:ObjectJSON[]=[],byDigest=new Map<string,ObjectJSON>();
  const assets=snapshot.assets.map((asset:ObjectJSON)=>{
    if('blobId'in asset||'deletedAt'in asset||'deletionBatchId'in asset)throw new Error('Unsupported private asset metadata in legacy public export');
    const entry=entries.get(files.assets[asset.id])!;if(entry.proof.sha256!==asset.sha256||entry.proof.byteSize!==asset.byteSize)throw new Error('Legacy original hash/size mismatch');
    let blob=byDigest.get(asset.sha256);if(!blob){blob={id:randomUUID(),investigationId:snapshot.investigationId,sha256:asset.sha256,byteSize:asset.byteSize,path:`blobs/${asset.sha256}`};byDigest.set(asset.sha256,blob);blobs.push(blob);converted.set(blob.path,{absolute:entry.absolute,proof:{...entry.proof,path:blob.path}});}return{...asset,blobId:blob.id,deletedAt:null,deletionBatchId:null};
  });
  const nodes:ObjectJSON[]=[];
  for(const node of snapshot.nodes){const entry=entries.get(files.documents[node.id])!;if(entry.proof.byteSize>5_242_880)throw new Error('Legacy rendered note exceeds 5 MiB');const rendered=await readUTF8(entry.absolute);nodes.push({...node,bodyMarkdown:rendered});}
  const layouts=[...snapshot.layouts],layoutIds=new Set(layouts.map((layout:ObjectJSON)=>layout.nodeId));
  for(const node of nodes)if(!layoutIds.has(node.id)){layouts.push({nodeId:node.id,investigationId:snapshot.investigationId,x:0,y:0,zIndex:0});warnings.push('В старом экспорте отсутствует раскладка узла '+node.id+'; установлены координаты 0,0.');}
  const raw=migrateLegacyArchive({format:'research-graph.project',formatVersion:'2.0',investigation:{id:snapshot.investigationId,title:snapshot.title,descriptionMarkdown:snapshot.descriptionMarkdown,status:'active',revision:snapshot.sourceRevision,createdAt:snapshot.capturedAt,updatedAt:snapshot.capturedAt,archivedAt:null},blobs,nodeTypes:snapshot.nodeTypes,relationTypes:snapshot.relationTypes,nodes,attributes:snapshot.attributes,layouts,memberships:snapshot.memberships,relations:snapshot.relations,assets,attachments:snapshot.attachments,evidence:snapshot.evidence,reports:[],snapshots:[],snapshotAssets:[],deletionBatches:[]});
  archiveValidator('Project',raw);validateArchiveReferences(raw);
  async function metadata(name:string,value:unknown):Promise<void>{const data=stringify(value);if(Buffer.byteLength(data)>entryLimit(name))throw new Error('Legacy converted metadata byte limit');const absolute=path.join(staging,'converted-'+name);await fs.writeFile(absolute,data,{flag:'wx',mode:0o600});converted.set(name,{absolute,proof:{path:name,sha256:hash(data),byteSize:Buffer.byteLength(data)}});}
  await metadata('project.json',raw);await metadata('presentation.json',defaultPresentation());
  await metadata('manifest.json',{format:'research-graph.archive',formatVersion:'2.0',exportedAt:snapshot.capturedAt,sourceInvestigationId:snapshot.investigationId,sourceRevision:snapshot.sourceRevision,projectPath:'project.json',presentationPath:'presentation.json',includesTrash:true,includesSnapshots:true,schemaId:'research-graph.archive/2.0',schemaSha256:archiveIndex.schemas['2.0.schema.json'].sha256,producer:{version:'traceweave-obsidian-legacy-converter/0.1.0',releaseTag:null,backendCommit:null,frontendCommit:null,contractsCommit:null},requiredFeatures:['full-project.v1','presentation.v1','node-icon-emoji.v1'],files:[...converted.values()].map(entry=>entry.proof)});
  warnings.push('Старый Obsidian export импортирован в новый проект. Текущие Documents/*.md сохранены целиком, включая пользовательские изменения и старые сгенерированные разделы. Исходный body из metadata не заменяет текущий Markdown. Топология взята из snapshot; изменения Relations/*.md/README и исходные body сохранены в оригинальном ZIP в служебной папке. Старый формат содержит только активный состав, без корзины и истории отчётов; createdAt/updatedAt нового исследования взяты из capturedAt.');
  return converted;
}

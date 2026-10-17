import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BlobRecord, MediaKind } from '../types';
import { DATA_ROOT, RESOURCES_ROOT, TRANSITIONAL_METADATA_ROOT, LEGACY_METADATA_ROOT, hasControlCharacters, isConfigurationPath, isAllowedResourcePath } from './layout';

export const MAX_ORIGINAL_BYTES = 536_870_912;
export interface CopyOptions { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void; originalName?: string; mimeType?: string }
export function safeRelative(value: string, configDir?: string): string {
  if (!value || value !== value.normalize('NFC') || value.includes('\\') || hasControlCharacters(value) || value.includes(':') || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.trim() !== p || /[. ]$/u.test(p)) || isConfigurationPath(value, configDir)) throw new Error('Unsafe relative path');
  return value;
}
export function requireId(id: string): void { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new Error('Invalid UUID'); }
export function safeSuffix(name: string): string { const suffix = path.extname(name).toLowerCase(); return /^\.[a-z0-9]{1,12}$/u.test(suffix) ? suffix : ''; }
export function mediaInfo(name: string): { mimeType: string; mediaKind: MediaKind } {
  const media: Record<string, [string, MediaKind]> = { '.png': ['image/png','image'], '.jpg': ['image/jpeg','image'], '.jpeg': ['image/jpeg','image'], '.gif': ['image/gif','image'], '.webp': ['image/webp','image'], '.pdf': ['application/pdf','file'], '.mp3': ['audio/mpeg','audio'], '.wav': ['audio/wav','audio'], '.ogg': ['audio/ogg','audio'], '.m4a': ['audio/mp4','audio'], '.flac': ['audio/flac','audio'], '.mp4': ['video/mp4','video'], '.webm': ['video/webm','video'], '.mov': ['video/quicktime','video'], '.txt': ['text/plain','text'], '.md': ['text/markdown','text'] };
  const value = media[path.extname(name).toLowerCase()] ?? ['application/octet-stream','file']; return { mimeType: value[0], mediaKind: value[1] };
}
export async function verifiedMediaInfo(absolute: string, name: string): Promise<{ mimeType: string; mediaKind: MediaKind }> {
  const declared = mediaInfo(name); if (declared.mediaKind === 'file' || declared.mediaKind === 'text') return declared;
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW); const header = Buffer.alloc(256);
  let count: number; try { ({ bytesRead: count } = await handle.read(header, 0, header.length, 0)); } finally { await handle.close(); }
  const bytes = header.subarray(0, count), ascii = (offset: number, value: string) => bytes.subarray(offset,offset+value.length).toString('ascii') === value;
  const signature = declared.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : declared.mimeType === 'image/jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255
    : declared.mimeType === 'image/gif' ? ascii(0,'GIF87a') || ascii(0,'GIF89a')
    : declared.mimeType === 'image/webp' ? ascii(0,'RIFF') && ascii(8,'WEBP')
    : declared.mimeType === 'audio/wav' ? ascii(0,'RIFF') && ascii(8,'WAVE')
    : declared.mimeType === 'audio/mpeg' ? ascii(0,'ID3') || (bytes[0]===255 && ((bytes[1] ?? 0)&224)===224)
    : declared.mimeType === 'audio/ogg' ? ascii(0,'OggS')
    : declared.mimeType === 'audio/flac' ? ascii(0,'fLaC')
    : ['audio/mp4','video/mp4','video/quicktime'].includes(declared.mimeType) ? ascii(4,'ftyp') || (declared.mimeType==='video/quicktime' && (ascii(4,'moov') || ascii(4,'mdat')))
    : declared.mimeType === 'video/webm' ? bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])) : false;
  return signature ? declared : { mimeType: 'application/octet-stream', mediaKind: 'file' };
}
export async function resolveSafe(root: string, relative: string, makeParents = false, configDir?: string): Promise<string> {
  safeRelative(relative, configDir);
  const absoluteRoot = await fs.realpath(root);
  let current = absoluteRoot;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in managed paths');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Path parent is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (makeParents && i < parts.length - 1) await fs.mkdir(current);
    }
  }
  return current;
}
export async function digestFile(absolute: string, options: Pick<CopyOptions, 'signal' | 'onProgress'> = {}, maxBytes = MAX_ORIGINAL_BYTES): Promise<{ sha256: string; byteSize: number }> {
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > maxBytes) throw new Error('File is not regular or exceeds the size limit');
    const hash = createHash('sha256'); let byteSize = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const bytes = chunk as Buffer;
      options.signal?.throwIfAborted(); byteSize += bytes.length; if (byteSize > maxBytes) throw new Error('File exceeds size limit'); hash.update(bytes); options.onProgress?.(byteSize, before.size);
    }
    const after = await handle.stat();
    if (byteSize !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Source file changed during reading');
    options.signal?.throwIfAborted(); return { sha256: hash.digest('hex'), byteSize };
  } finally { await handle.close(); }
}
export async function copyChecked(source: string, destination: string, expected?: { sha256: string; byteSize: number }, options: CopyOptions = {}, maxBytes = MAX_ORIGINAL_BYTES): Promise<{ sha256: string; byteSize: number }> {
  options.signal?.throwIfAborted();
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let created = false;
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > maxBytes) throw new Error('Source is not regular or exceeds size limit');
    const output = await fs.open(destination, 'wx', 0o600); created = true;
    const hash = createHash('sha256'); let byteSize = 0;
    try {
      for await (const value of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        options.signal?.throwIfAborted(); const chunk = value as Buffer; byteSize += chunk.length;
        if (byteSize > maxBytes) throw new Error('Size limit exceeded');
        hash.update(chunk); let offset = 0;
        while (offset < chunk.length) { options.signal?.throwIfAborted(); const written = await output.write(chunk, offset, chunk.length - offset); if (written.bytesWritten === 0) throw new Error('File write made no progress'); offset += written.bytesWritten; }
        options.onProgress?.(byteSize, before.size);
      }
      options.signal?.throwIfAborted(); await output.sync();
    } finally { await output.close(); }
    const result = { sha256: hash.digest('hex'), byteSize }, after = await handle.stat();
    if (byteSize !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during copy');
    if (expected && (result.sha256 !== expected.sha256 || result.byteSize !== expected.byteSize)) throw new Error('File integrity check failed');
    return result;
  } catch (error) { if (created) await fs.rm(destination, { force: true }); throw error; }
  finally { await handle.close(); }
}
export class FileStore {
  constructor(readonly vaultRoot: string, readonly metadataRoot = DATA_ROOT, readonly resourceRoot = RESOURCES_ROOT, readonly configDir?: string) { safeRelative(metadataRoot, configDir); safeRelative(resourceRoot, configDir); const legacy = [TRANSITIONAL_METADATA_ROOT, LEGACY_METADATA_ROOT].includes(metadataRoot), allowed = legacy ? [RESOURCES_ROOT, 'TWData/resources', 'TraceWeave Resources'] : [RESOURCES_ROOT]; if (!isAllowedResourcePath(resourceRoot + "/original", legacy, configDir) || !allowed.some(root => resourceRoot === root || resourceRoot.startsWith(root + '/'))) throw new Error('Resource root must stay within the visible research attachments folder'); }
  async resolve(relative: string): Promise<string> { return resolveSafe(this.vaultRoot, relative, false, this.configDir); }
  async importFile(sourcePath: string, projectId: string, knownBlobs: readonly BlobRecord[] = [], options: CopyOptions = {}): Promise<{ blob: BlobRecord; originalName: string }> {
    requireId(projectId); const originalName = (options.originalName ?? path.basename(sourcePath)).normalize('NFC');
    if (!originalName || hasControlCharacters(originalName) || [...originalName].length > 255) throw new Error('Invalid original filename');
    const id = randomUUID(), relative = `${this.resourceRoot}/${projectId}/${id}/original${safeSuffix(originalName)}`;
    const destination = await resolveSafe(this.vaultRoot, relative, true, this.configDir);
    try {
      const proof = await copyChecked(sourcePath, destination, undefined, options);
      const previous = knownBlobs.find(blob => blob.sha256 === proof.sha256 && blob.byteSize === proof.byteSize);
      if (previous) {
        if (await this.verify(previous, { signal: options.signal }) !== 'ok') throw new Error('Existing original has changed or is unavailable');
        options.signal?.throwIfAborted(); await fs.rm(path.dirname(destination), { recursive: true, force: true }); return { blob: structuredClone(previous), originalName };
      }
      const media = await verifiedMediaInfo(destination, originalName); options.signal?.throwIfAborted();
      return { blob: { id, path: relative, ...proof, ...media }, originalName };
    } catch (error) { await fs.rm(path.dirname(destination), { recursive: true, force: true }); throw error; }
  }

  async verify(blob: BlobRecord, options: Pick<CopyOptions, 'signal'> = {}): Promise<'ok' | 'missing' | 'changed'> {
    try { const absolute=await this.resolve(blob.path),stat=await fs.lstat(absolute); if(!stat.isFile()||stat.size!==blob.byteSize)return 'changed'; const proof = await digestFile(absolute,options); return proof.sha256 === blob.sha256 && proof.byteSize === blob.byteSize ? 'ok' : 'changed'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; if(error instanceof Error&&error.message.includes('Symbolic links'))return 'changed'; throw error; }
  }
}

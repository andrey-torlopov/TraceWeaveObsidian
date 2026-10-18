import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VaultLink } from './types';
import { resolveSafe, safeRelative, verifiedMediaInfo } from './storage/files';
import { reportDocumentInfo } from './report-document';
import { hasControlCharacters, isConfigurationPath, isTechnicalPath } from './storage/layout';

export interface VaultDestination { path: string; basename: string; extension: string }
export interface VaultLinkHost {
  find(path: string, sourcePath: string): VaultDestination | null;
  resourceUrl(path: string): string;
  open(path: string, subpath: string): Promise<void>;
  reveal(path: string): Promise<void>;
  migrated?(oldPath: string): Promise<string | null>;
  original?(newPath: string): Promise<string | null>;
}
function allowed(relative: string, sourcePath?: string, configDir?: string): boolean {
  safeRelative(relative, configDir);
  if (relative.startsWith('.twdata/')) {
    if (!sourcePath) return reportDocumentInfo(relative) !== null;
    const report = reportDocumentInfo(sourcePath);
    return !!report && relative.startsWith(report.directory + '/files/');
  }
  const parts = relative.toLowerCase().split('/');
  if (parts.some(part => part.startsWith('.') || part === '_traceweave')) return false;
  // Retain legacy note/resource bridges while sharing the current visible-data policy.
  return parts[0] === 'twdata' && ['notes', 'resources'].includes(parts[1] ?? '') && parts.length > 2 || !isTechnicalPath(relative, configDir);
}
/** Resolve vault files and explicit local paths; a note cannot turn a preview into an OS path or request. */
export class VaultLinks {
  constructor(readonly root: string, readonly host: VaultLinkHost, readonly configDir?: string) {}
  private allowed(relative: string, sourcePath?: string): boolean { return !isConfigurationPath(relative, this.configDir) && allowed(relative, sourcePath, this.configDir); }
  private target(sourcePath: string, raw: string): { destinations: VaultDestination[]; subpath: string } | null {
    if (!this.allowed(sourcePath) || typeof raw !== 'string' || !raw.trim()) return null;
    const uri = raw.trim(), marker = uri.search(/[?#]/u), suffix = marker < 0 ? '' : uri.slice(marker);
    let linkPath: string, subpath: string;
    try { linkPath = decodeURIComponent(marker < 0 ? uri : uri.slice(0, marker)).normalize('NFC'); subpath = suffix.includes('#') ? decodeURIComponent(suffix.slice(suffix.indexOf('#'))) : ''; } catch { return null; }
    if (hasControlCharacters(linkPath + subpath) || /^[a-z][a-z\d+.-]*:|^\/\/|\\/iu.test(linkPath + subpath)) return null;
    const rooted = linkPath.startsWith('/');
    const target = rooted ? linkPath.slice(1) : linkPath;
    // Parent-relative Markdown links are legitimate, provided they remain inside the vault.
    const candidate = target ? path.posix.normalize(rooted ? target : path.posix.join(path.posix.dirname(sourcePath), target)) : sourcePath;
    if (target) {
      try {
        if (!this.allowed(candidate, sourcePath)) {
          // Plain vault-root wikilinks in captured Markdown still use the public Obsidian resolver.
          if (rooted || /^\.\.?\//u.test(target) || !reportDocumentInfo(sourcePath) || !this.allowed(target, sourcePath)) return null;
        }
      } catch { return null; }
    }
    // Captured originals resolve inside this snapshot, never to a similarly named current vault file.
    const sourceReport = reportDocumentInfo(sourcePath);
    if (target && sourceReport && candidate.startsWith(sourceReport.directory + '/files/') && this.allowed(candidate, sourcePath)) return { destinations: [{ path: candidate, basename: path.posix.basename(candidate, path.posix.extname(candidate)), extension: path.posix.extname(candidate).slice(1) }], subpath };
    const destination = target ? this.host.find(target, rooted ? '' : sourcePath) : this.host.find(sourcePath, '');
    if (destination && !this.allowed(destination.path, sourcePath)) return null;
    const destinations = destination ? [destination] : [];
    // Unknown extensions may be absent from Obsidian's index. Try explicit local paths, never a disk scan.
    for (const relative of [candidate, path.posix.normalize(target)]) {
      if (!relative || relative === '.' || destinations.some(file => file.path === relative)) continue;
      try { if (!this.allowed(relative, sourcePath)) continue; } catch { continue; }
      destinations.push({ path: relative, basename: path.posix.basename(relative, path.posix.extname(relative)), extension: path.posix.extname(relative).slice(1) });
    }
    return { destinations, subpath };
  }
  private async locate(sourcePath: string, raw: string): Promise<{ info: VaultLink; subpath: string } | null> {
    let resolved: ReturnType<VaultLinks['target']>;
    try { resolved = this.target(sourcePath, raw); } catch { return null; }
    let oldSource: string | null | undefined, oldCandidates: VaultDestination[] = [];
    if (!resolved) {
      oldSource = await this.host.original?.(sourcePath);
      const legacy = oldSource ? this.target(oldSource, raw) : null;
      if (!legacy) return null;
      oldCandidates = legacy.destinations;
      resolved = { destinations: [], subpath: legacy.subpath };
    }
    const subpath = resolved.subpath;
    const find = async (files: VaultDestination[]) => {
      for (const file of files) {
        try {
          const absolute = await resolveSafe(this.root, file.path, false, this.configDir), stat = await fs.stat(absolute);
          if (!stat.isFile()) continue;
          const media = await verifiedMediaInfo(absolute, file.path);
          const info: VaultLink = { path: file.path, title: file.basename, resourceUrl: this.host.resourceUrl(file.path), ...media, byteSize: stat.size, isNote: file.extension.toLowerCase() === 'md' };
          if (file.path.startsWith('.twdata/')) info.openMode = 'reveal';
          else if (file.extension.toLowerCase() === 'canvas') info.openMode = 'native';
          return { info, subpath };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return null;
    };
    const direct = await find(resolved.destinations); if (direct) return direct;
    const candidates = [...resolved.destinations];
    oldSource ??= await this.host.original?.(sourcePath);
    if (oldSource && !oldCandidates.length) oldCandidates = this.target(oldSource, raw)?.destinations ?? [];
    for (const old of [...resolved.destinations, ...oldCandidates]) {
      const migrated = await this.host.migrated?.(old.path) ?? await this.host.migrated?.(old.path + '.md');
      if (migrated && this.allowed(migrated, sourcePath) && !candidates.some(file => file.path === migrated)) candidates.push({ path: migrated, basename: path.posix.basename(migrated, path.posix.extname(migrated)), extension: path.posix.extname(migrated).slice(1) });
    }
    return find(candidates.filter(file => !resolved.destinations.some(direct => direct.path === file.path)));
  }
  async resolve(sourcePath: string, raw: string): Promise<VaultLink | null> { return (await this.locate(sourcePath, raw))?.info ?? null; }
  async open(sourcePath: string, raw: string): Promise<void> {
    const resolved = await this.locate(sourcePath, raw);
    if (!resolved) throw new Error(t('Ссылка не указывает на доступный файл этого хранилища.', "The link does not point to an available file in this vault."));
    const { info } = resolved;
    if (info.openMode !== 'reveal' && (info.openMode === 'native' || info.isNote || info.mimeType === 'application/pdf' || ['image', 'audio', 'video'].includes(info.mediaKind))) await this.host.open(info.path, resolved.subpath);
    else await this.host.reveal(info.path);
  }
}

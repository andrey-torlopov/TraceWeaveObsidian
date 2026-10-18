export const DATA_ROOT = '.twdata';
export const NOTES_ROOT = 'Исследования/Заметки';
export const RESOURCES_ROOT = 'Исследования/Вложения';
export const TRANSITIONAL_METADATA_ROOT = 'TWData';
export const LEGACY_METADATA_ROOT = '_TraceWeave';
export const DEFAULT_VISIBLE_ROOT = 'TWData';

export function safeVisibleName(value: string, fallback = 'Research'): string {
  const clean = [...value.normalize('NFC')].map(character => hasControlCharacters(character) || /[<>:"/\\|?*#]/u.test(character) ? '-' : character).join('').trim().replace(/^[.]+|[. ]+$/gu, '');
  let result = '';
  for (const character of clean) { if (new TextEncoder().encode(result + character).length > 140) break; result += character; }
  result = result.trim().replace(/[. ]+$/gu, '') || fallback;
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(result) ? '_' + result : result;
}

/** Character checks stay explicit so control bytes never become invisible regular-expression syntax. */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isConfigurationPath(value: string, configDir?: string): boolean {
  if (!configDir) return false;
  const candidate = value.normalize('NFC').toLowerCase(), reserved = configDir.normalize('NFC').toLowerCase();
  return candidate === reserved || candidate.startsWith(reserved + '/');
}

/** Visible project files and exports are not metadata, even under the former TWData name. */
export function isTechnicalPath(value: string, configDir?: string): boolean {
  if (isConfigurationPath(value, configDir)) return true;
  const parts = value.split('/');
  if (parts.some(part => part.startsWith('.') || part.toLowerCase() === '_traceweave')) return true;
  const index = parts.findIndex(part => part.toLowerCase() === 'twdata');
  if (index < 0 || index === parts.length - 1) return false;
  if (parts[index + 1] === 'projects' && parts.length === index + 3 && ['state.json', 'settings.json', 'writer.lock', 'migration.json', 'layout-migration.json', 'view.json', 'drafts.json'].includes(parts[index + 2] ?? '')) return true;
  if (parts[index + 1] === 'projects' && /^[a-f0-9-]{36}$/u.test(parts[index + 2] ?? '') && ['state.json', 'history', 'journal', 'recovery', 'reports', 'sources', 'view.json', 'drafts.json'].includes(parts[index + 3] ?? '')) return true;
  return !['projects', 'exports'].includes(parts[index + 1] ?? '');
}

export function isAllowedSnapshotPath(value: string, projectId: string, snapshotId: string): boolean {
  if ([DATA_ROOT, TRANSITIONAL_METADATA_ROOT, LEGACY_METADATA_ROOT].some(root => value === `${root}/projects/${projectId}/reports/${snapshotId}/snapshot.json`)) return true;
  if (value !== value.normalize('NFC') || value.includes('\\') || hasControlCharacters(value) || /[:?#]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part || /[. ]$/u.test(part))) return false;
  const marker = '/exports/', index = value.indexOf(marker);
  return index > 0 && !isTechnicalPath(value) && value.endsWith(`/snapshots/${snapshotId}/snapshot.json`) && value.slice(index + marker.length, -(`/snapshots/${snapshotId}/snapshot.json`.length)).length > 0;
}

/** Ordinary vault notes plus the one managed note subtree; technical files are excluded. */
export function isAllowedNotePath(value: string, allowLegacy = false, configDir?: string): boolean {
  if (typeof value !== 'string' || !/\.md$/iu.test(value) || value.includes('\\') || hasControlCharacters(value) || /[:?#]/u.test(value) || isConfigurationPath(value, configDir)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.trim() !== part || /[. ]$/u.test(part))) return false;
  if (parts.some(part => part.startsWith('.') || part.toLowerCase() === '_traceweave')) return false;
  const index = parts.findIndex(part => part.toLowerCase() === 'twdata');
  return index < 0 || (allowLegacy && index === 0 && parts[0] === TRANSITIONAL_METADATA_ROOT && parts[1] === 'notes' && parts.length > 2);
}

export function isAllowedResourcePath(value: string, allowLegacy = false, configDir?: string): boolean {
  if (isConfigurationPath(value, configDir)) return false;
  const parts = value.split('/');
  if (parts.some(part => part.startsWith('.') || part.toLowerCase() === '_traceweave')) return false;
  const index = parts.findIndex(part => part.toLowerCase() === 'twdata');
  return index < 0 || (!isTechnicalPath(value, configDir) && ['projects', 'exports'].includes(parts[index + 1] ?? '') && parts.length > index + 2) || (allowLegacy && index === 0 && parts[0] === TRANSITIONAL_METADATA_ROOT && parts[1] === 'resources' && parts.length > 2);
}

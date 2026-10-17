export const DATA_ROOT = '.twdata';
export const NOTES_ROOT = 'Исследования/Заметки';
export const RESOURCES_ROOT = 'Исследования/Вложения';
export const TRANSITIONAL_METADATA_ROOT = 'TWData';
export const LEGACY_METADATA_ROOT = '_TraceWeave';

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
  return index < 0 || (allowLegacy && index === 0 && parts[0] === TRANSITIONAL_METADATA_ROOT && parts[1] === 'resources' && parts.length > 2);
}

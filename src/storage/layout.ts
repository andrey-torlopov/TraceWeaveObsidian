export const DATA_ROOT = '.twdata';
export const NOTES_ROOT = 'Исследования/Заметки';
export const RESOURCES_ROOT = 'Исследования/Вложения';
export const TRANSITIONAL_METADATA_ROOT = 'TWData';
export const LEGACY_METADATA_ROOT = '_TraceWeave';

/** Ordinary vault notes plus the one managed note subtree; technical files are excluded. */
export function isAllowedNotePath(value: string, allowLegacy = false): boolean {
  if (typeof value !== 'string' || !/\.md$/iu.test(value) || value.includes('\\') || /[\u0000-\u001f\u007f:?#]/u.test(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.trim() !== part || /[. ]$/u.test(part))) return false;
  if (parts.some(part => part.startsWith('.') || part.toLowerCase() === '_traceweave')) return false;
  const index = parts.findIndex(part => part.toLowerCase() === 'twdata');
  return index < 0 || (allowLegacy && index === 0 && parts[0] === TRANSITIONAL_METADATA_ROOT && parts[1] === 'notes' && parts.length > 2);
}

export function isAllowedResourcePath(value: string, allowLegacy = false): boolean {
  const parts = value.split('/');
  if (parts.some(part => part.startsWith('.') || part.toLowerCase() === '_traceweave')) return false;
  const index = parts.findIndex(part => part.toLowerCase() === 'twdata');
  return index < 0 || (allowLegacy && index === 0 && parts[0] === TRANSITIONAL_METADATA_ROOT && parts[1] === 'resources' && parts.length > 2);
}

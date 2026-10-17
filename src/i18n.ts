import type { NodeType } from './types';

export type Locale = 'ru' | 'en';
let locale: Locale = 'ru';
const listeners = new Set<() => void>();

/** Locale updates the mounted UI without changing research data or remounting a view. */
export function setLocale(value: Locale): void {
  if (locale === value) return;
  locale = value;
  listeners.forEach(listener => listener());
}
export function subscribeLocale(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getLocale(): Locale { return locale; }
export function resolveLocale(language: string): Locale { return /^ru(?:[-_]|$)/iu.test(language.trim()) ? 'ru' : 'en'; }
export function localeCode(): string { return locale === 'ru' ? 'ru-RU' : 'en-US'; }
export function t(ru: string, en: string): string { return locale === 'ru' ? ru : en; }

const systemNames: Readonly<Record<string, readonly [string, string]>> = {
  note: ['Заметка', 'Note'], person: ['Персона', 'Person'], organization: ['Организация', 'Organization'],
  phone: ['Телефон', 'Phone'], location: ['Место', 'Place'], evidence: ['Материал', 'Source'],
  conclusion: ['Вывод', 'Conclusion'], group: ['Группа', 'Group'],
};

/** User-defined names, including renamed system types, are research content. */
export function localizedTypeName(type: Pick<NodeType, 'code' | 'name' | 'isSystem'>): string {
  const names = systemNames[type.code];
  return type.isSystem && names && type.name === names[0] ? t(names[0], names[1]) : type.name;
}

import { t } from '../i18n';
import { history, journal } from '../generated/validators';
import { DomainError } from '../domain';

/** Never decide whether recovery is needed from an unvalidated record. */
export function validateRecord(kind: 'journal' | 'history', value: unknown): void {
  const validator = kind === 'journal' ? journal : history;
  if (!validator(value)) throw new DomainError(kind, t(`Повреждён формат ${kind}: ${validator.errors?.[0]?.instancePath || '/'} ${validator.errors?.[0]?.message || ''}. Исходный файл сохранён.`, `Invalid ${kind} record: ${validator.errors?.[0]?.instancePath || '/'} ${validator.errors?.[0]?.message || ''}. The original file was preserved.`));
}

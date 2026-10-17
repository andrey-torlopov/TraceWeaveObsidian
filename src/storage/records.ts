import Ajv2020 from 'ajv/dist/2020';
import projectSchema from '../../contracts/obsidian-project.schema.json';
import historySchema from '../../contracts/history.schema.json';
import journalSchema from '../../contracts/journal.schema.json';
import { DomainError } from '../domain';

const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addSchema(projectSchema);
const history = ajv.compile(historySchema);
const journal = ajv.compile(journalSchema);

/** Never decide whether recovery is needed from an unvalidated record. */
export function validateRecord(kind: 'journal' | 'history', value: unknown): void {
  const validator = kind === 'journal' ? journal : history;
  if (!validator(value)) throw new DomainError(kind, `Повреждён формат ${kind}: ${validator.errors?.[0]?.instancePath || '/'} ${validator.errors?.[0]?.message || ''}. Исходный файл сохранён.`);
}

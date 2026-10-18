import { t } from './i18n';
import type { Asset, Attribute, BlobRecord, Command, Evidence, ID, NodeChanges, Project, ProjectNode, SearchHit } from './types';
import { validEmoji } from './emojiSequences';
import { caseFold } from './casefold';
import { DATA_ROOT, hasControlCharacters, isAllowedNotePath, isAllowedResourcePath, isAllowedSnapshotPath } from './storage/layout';

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}

const MAX_COORDINATE = 1_000_000;
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const ASSESSMENTS = ['unreviewed', 'confirmed_by_user', 'hypothesis', 'refuted_by_user'];
const CONFIDENCE = ['low', 'medium', 'high', null];
const MEDIA = ['image', 'audio', 'video', 'file', 'text'];
/** Frozen archive2.0 NodeType icon vocabulary, shared with the current web product. */
export const NODE_ICON_KEYS = ['user', 'building', 'phone', 'mail', 'globe', 'link', 'map-pin', 'calendar', 'file-text', 'image', 'music', 'video', 'check-circle', 'folder', 'tag', 'circle', 'book', 'briefcase', 'database', 'flag', 'hash', 'search', 'shield', 'star'] as const;
const encoder = new TextEncoder();
const normalized = (value: string): string => value.normalize('NFC').trim();
const folded = (value: string): string => caseFold(normalized(value));
const fail = (message: string, code = 'validation_failed'): never => { throw new DomainError(code, message); };
const check: (condition: unknown, message: string, code?: string) => asserts condition = (condition, message, code) => { if (!condition) fail(message, code); };
const own = (object: object, name: string): boolean => Object.prototype.hasOwnProperty.call(object, name);

function object(value: unknown, name: string): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), t(`${name}: требуется объект.`, `${name}: an object is required.`));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, t(`${name}: требуется JSON-объект.`, `${name}: a JSON object is required.`));
}
function array(value: unknown, name: string): asserts value is unknown[] { check(Array.isArray(value), t(`${name}: требуется массив.`, `${name}: an array is required.`)); }
function keys(value: object, names: readonly string[], name: string): void {
  for (const key of Object.keys(value)) check(names.includes(key), t(`${name}: неизвестное поле ${key}.`, `${name}: unknown field ${key}.`), 'unknown_field');
}
function text(value: unknown, name: string, max: number, min = 0): asserts value is string {
  check(typeof value === 'string', t(`${name}: требуется строка.`, `${name}: a string is required.`));
  const length = [...value].length;
  check(length >= min && length <= max && !value.includes('\0'), t(`${name}: недопустимая длина или нулевой символ.`, `${name}: invalid length or null character.`));
  check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), t(`${name}: неполный Unicode-символ.`, `${name}: incomplete Unicode character.`));
}
function label(value: unknown, name: string, max: number): asserts value is string { text(value, name, max, 1); check(value === normalized(value), t(`${name}: требуется NFC без пробелов по краям.`, `${name}: NFC text without leading or trailing spaces is required.`)); }
export function validateNodeTitle(value: string): string { const title = normalized(value); label(title, 'node.title', 200); return title; }
function nullableText(value: unknown, name: string, max: number): void { if (value !== null) text(value, name, max); }
function bytes(value: unknown, name: string, max: number): void { text(value, name, max); check(encoder.encode(value).byteLength <= max, t(`${name}: превышен лимит UTF-8.`, `${name}: UTF-8 byte limit exceeded.`)); }
function id(value: unknown, name: string): asserts value is ID { check(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value), t(`${name}: требуется UUID в нижнем регистре.`, `${name}: a lowercase UUID is required.`)); }
function code(value: unknown, name: string): void { check(typeof value === 'string' && CODE.test(value), t(`${name}: недопустимый стабильный код.`, `${name}: invalid stable code.`)); }
function finite(value: unknown, name: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): asserts value is number { check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, t(`${name}: недопустимое число.`, `${name}: invalid number.`)); }
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number { finite(value, name, min, max); check(Number.isSafeInteger(value), t(`${name}: требуется безопасное целое число.`, `${name}: a safe integer is required.`)); }
function bool(value: unknown, name: string): asserts value is boolean { check(typeof value === 'boolean', t(`${name}: требуется boolean.`, `${name}: a boolean is required.`)); }
function timestamp(value: unknown, name: string): asserts value is string {
  text(value, name, 40, 20);
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)), t(`${name}: требуется UTC RFC3339.`, `${name}: a UTC RFC3339 timestamp is required.`));
  const date = new Date(value);
  check(date.toISOString().slice(0, 19) === value.slice(0, 19), t(`${name}: несуществующая дата.`, `${name}: nonexistent date.`));
}
function httpUrl(value: unknown, name: string): void {
  text(value, name, 4096, 1);
  try { const url = new URL(value); check((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0, t(`${name}: разрешены только HTTP/HTTPS.`, `${name}: only HTTP/HTTPS URLs are allowed.`)); }
  catch (error) { if (error instanceof DomainError) throw error; fail(t(`${name}: неверный URL.`, `${name}: invalid URL.`)); }
}
function json(value: unknown, name: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), t(`${name}: нечисловое JSON-значение.`, `${name}: non-finite JSON number.`)); return; }
  check(typeof value === 'object' && value !== null, t(`${name}: требуется JSON-значение.`, `${name}: a JSON value is required.`));
  check(!ancestors.has(value), t(`${name}: циклический JSON.`, `${name}: cyclic JSON value.`)); ancestors.add(value);
  if (Array.isArray(value)) for (const item of value) json(item, name, ancestors);
  else { object(value, name); for (const [key, item] of Object.entries(value)) { check(key !== '__proto__' && key !== 'prototype' && key !== 'constructor', t(`${name}: запрещённый ключ.`, `${name}: forbidden key.`)); json(item, name, ancestors); } }
  ancestors.delete(value);
}
function metadata(value: unknown, name: string, maxBytes?: number): void {
  object(value, name); json(value, name);
  if (maxBytes !== undefined) check(encoder.encode(JSON.stringify(value)).byteLength <= maxBytes, t(`${name}: превышен лимит.`, `${name}: limit exceeded.`));
}
/** Paths are vault relative. Never accept platform paths, traversal or reserved host folders. */
export function validateRelativePath(value: unknown, name = 'path', note = false): asserts value is string {
  check(typeof value === 'string' && !hasControlCharacters(value), t(`${name}: небезопасный путь.`, `${name}: unsafe path.`), 'unsafe_path');
  text(value, name, 4096, 1);
  check(value === value.normalize('NFC') && !/[\\:#?]/u.test(value), t(`${name}: небезопасный путь.`, `${name}: unsafe path.`), 'unsafe_path');
  const parts = value.split('/');
  check(parts.every(part => part !== '' && part !== '.' && part !== '..' && part.trim() === part && !/[. ]$/.test(part)), t(`${name}: небезопасный компонент пути.`, `${name}: unsafe path component.`), 'unsafe_path');
  check(!parts.some((part, index) => part.startsWith('.') && !(index === 0 && part === DATA_ROOT)), t(`${name}: скрытая папка запрещена.`, `${name}: a hidden folder is forbidden.`), 'unsafe_path');
  if (note) {
    check(isAllowedNotePath(value, true), t(`${name}: заметка должна находиться вне скрытых и служебных папок.`, `${name}: notes must stay outside hidden and metadata folders.`), 'unsafe_path');
  }
}
function uniqueIds<T extends { id: ID }>(values: T[], name: string): Map<ID, T> {
  const result = new Map<ID, T>();
  for (const item of values) { object(item, name); id(item.id, `${name}.id`); check(!result.has(item.id), t(`${name}: повторный ID ${item.id}.`, `${name}: duplicate ID ${item.id}.`), 'duplicate_id'); result.set(item.id, item); }
  return result;
}
function deletion(value: { deletedAt: string | null; deletionBatchId: ID | null }, name: string): void {
  if (value.deletedAt !== null) timestamp(value.deletedAt, `${name}.deletedAt`);
  if (value.deletionBatchId !== null) id(value.deletionBatchId, `${name}.deletionBatchId`);
  check((value.deletedAt === null) === (value.deletionBatchId === null), t(`${name}: несогласованная корзина.`, `${name}: inconsistent trash state.`));
}
function assessment(value: { assessment: unknown; confidence: unknown }, name: string): void { check(ASSESSMENTS.includes(value.assessment as string), t(`${name}: неверная оценка.`, `${name}: invalid assessment.`)); check(CONFIDENCE.includes(value.confidence as string | null), t(`${name}: неверная уверенность.`, `${name}: invalid confidence.`)); }
function calendarDate(value: unknown, precision: unknown): void {
  check(typeof value === 'string', t('attribute.date: требуется строка.', "attribute.date: a string is required."));
  const pattern = precision === 'year' ? /^\d{4}$/ : precision === 'month' ? /^\d{4}-\d{2}$/ : precision === 'day' ? /^\d{4}-\d{2}-\d{2}$/ : null;
  check(pattern !== null && pattern.test(value), t('attribute.date: неверная точность или форма даты.', "attribute.date: invalid date precision or format."));
  const year = Number(value.slice(0, 4)); check(year >= 1, t('attribute.date: год должен быть положительным.', "attribute.date: the year must be positive."));
  if (precision !== 'year') { const month = Number(value.slice(5, 7)); check(month >= 1 && month <= 12, t('attribute.date: неверный месяц.', "attribute.date: invalid month.")); }
  if (precision === 'day') { const date = new Date(`${value}T00:00:00Z`); check(Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value, t('attribute.date: несуществующий день.', "attribute.date: nonexistent day.")); }
}
function validateAttributes(attributes: Attribute[], name: string): void {
  array(attributes, name); uniqueIds(attributes, name); check(attributes.length <= 1000, t(`${name}: слишком много атрибутов.`, `${name}: too many attributes.`));
  const names = new Set<string>();
  for (const attribute of attributes) {
    keys(attribute, ['id', 'key', 'valueType', 'value', 'sortOrder'], name);
    label(attribute.key, `${name}.key`, 80); const key = folded(attribute.key); check(!names.has(key), t(`${name}: повторный ключ ${attribute.key}.`, `${name}: duplicate key ${attribute.key}.`)); names.add(key);
    integer(attribute.sortOrder, `${name}.sortOrder`);
    check(['text', 'number', 'boolean', 'date', 'datetime', 'url', 'geo'].includes(attribute.valueType), t(`${name}: неизвестный тип значения.`, `${name}: unknown value type.`));
    if (attribute.value === null) continue;
    switch (attribute.valueType) {
      case 'text': text(attribute.value, name, 10000); break;
      case 'number': finite(attribute.value, name); break;
      case 'boolean': bool(attribute.value, name); break;
      case 'url': httpUrl(attribute.value, name); break;
      case 'datetime': timestamp(attribute.value, name); break;
      case 'date': { const value: unknown = attribute.value; object(value, name); keys(value, ['value', 'precision'], name); calendarDate(value.value, value.precision); break; }
      case 'geo': {
        const value: unknown = attribute.value; object(value, name); keys(value, ['latitude', 'longitude', 'accuracyMeters'], name);
        finite(value.latitude, name, -90, 90); finite(value.longitude, name, -180, 180);
        if (value.accuracyMeters !== null) { finite(value.accuracyMeters, name); check(value.accuracyMeters > 0, t(`${name}: точность должна быть положительной.`, `${name}: accuracy must be positive.`)); }
        break;
      }
    }
  }
}
function validateEvidence(evidence: Evidence[], nodes: Map<ID, ProjectNode>, assets: Map<ID, Asset>, name: string): void {
  array(evidence, name); uniqueIds(evidence, name);
  for (const entry of evidence) {
    keys(entry, ['id', 'sourceKind', 'sourceNodeId', 'assetId', 'url', 'label', 'quote', 'locator', 'note', 'accessedAt'], name);
    text(entry.label, `${name}.label`, 500); nullableText(entry.quote, name, 10000); nullableText(entry.locator, name, 10000); nullableText(entry.note, name, 10000);
    if (entry.accessedAt !== null) timestamp(entry.accessedAt, name);
    check(['node', 'asset', 'url'].includes(entry.sourceKind), t(`${name}: неизвестный вид источника.`, `${name}: unknown evidence source kind.`));
    if (entry.sourceKind === 'node') { id(entry.sourceNodeId, name); check(nodes.has(entry.sourceNodeId), t(`${name}: отсутствует узел-источник.`, `${name}: the source node is missing.`), 'missing_reference'); check(entry.assetId === null && entry.url === null, t(`${name}: должен быть один источник.`, `${name}: exactly one source is required.`)); }
    else if (entry.sourceKind === 'asset') { id(entry.assetId, name); check(assets.has(entry.assetId), t(`${name}: отсутствует материал-источник.`, `${name}: the source material is missing.`), 'missing_reference'); check(entry.sourceNodeId === null && entry.url === null, t(`${name}: должен быть один источник.`, `${name}: exactly one source is required.`)); }
    else { httpUrl(entry.url, name); check(entry.assetId === null && entry.sourceNodeId === null, t(`${name}: должен быть один источник.`, `${name}: exactly one source is required.`)); }
  }
}

const SYSTEM_TYPES = [
  ['note', 'Заметка', '#64748B', 'file-text'], ['person', 'Персона', '#3B82F6', 'user'], ['organization', 'Организация', '#8B5CF6', 'building'],
  ['phone', 'Телефон', '#10B981', 'phone'], ['location', 'Место', '#F59E0B', 'map-pin'], ['evidence', 'Материал', '#06B6D4', 'file-text'],
  ['conclusion', 'Вывод', '#EF4444', 'check-circle'], ['group', 'Группа', '#6366F1', 'folder'],
] as const;

export function createProject(title: string, projectId: ID = crypto.randomUUID(), now = new Date().toISOString()): Project {
  const project: Project = {
    format: 'traceweave.obsidian-project', formatVersion: '1.0', requiredFeatures: [], id: projectId, title: normalized(title), descriptionMarkdown: '', status: 'active', revision: 0,
    createdAt: now, updatedAt: now, nodes: [], nodeTypes: SYSTEM_TYPES.map(([code, name, color, iconKey]) => ({ id: crypto.randomUUID(), code, name, color, iconKey, isHidden: false, isSystem: true })),
    relations: [], relationTypes: [{ code: 'related', name: 'Связано с', defaultDirected: false }], memberships: [], blobs: [], assets: [], attachments: [], deletionBatches: [], snapshots: [], receipts: {}, importedData: {},
  };
  validateProject(project); return project;
}

export function validateProject(project: Project): void {
  object(project, 'project');
  keys(project, ['format', 'formatVersion', 'requiredFeatures', 'id', 'title', 'descriptionMarkdown', 'status', 'revision', 'createdAt', 'updatedAt', 'nodes', 'nodeTypes', 'relations', 'relationTypes', 'memberships', 'blobs', 'assets', 'attachments', 'deletionBatches', 'snapshots', 'receipts', 'importedData'], 'project');
  check(project.format === 'traceweave.obsidian-project' && project.formatVersion === '1.0', t('Неподдерживаемая версия проекта.', "Unsupported project version."), 'unsupported_format');
  array(project.requiredFeatures, 'requiredFeatures'); check(project.requiredFeatures.length === 0, t('Проект требует неподдерживаемые возможности.', "The project requires unsupported features."), 'unsupported_feature');
  id(project.id, 'project.id'); label(project.title, 'project.title', 200); bytes(project.descriptionMarkdown, 'project.descriptionMarkdown', 1048576);
  check(project.status === 'active' || project.status === 'archived', t('Неверный статус проекта.', "Invalid project status.")); integer(project.revision, 'project.revision'); timestamp(project.createdAt, 'project.createdAt'); timestamp(project.updatedAt, 'project.updatedAt');
  for (const name of ['nodes', 'nodeTypes', 'relations', 'relationTypes', 'memberships', 'blobs', 'assets', 'attachments', 'deletionBatches', 'snapshots'] as const) array(project[name], name);
  const nodes = uniqueIds(project.nodes, 'nodes'), types = uniqueIds(project.nodeTypes, 'nodeTypes'), relations = uniqueIds(project.relations, 'relations'), blobs = uniqueIds(project.blobs, 'blobs'), assets = uniqueIds(project.assets, 'assets');
  const batches = uniqueIds(project.deletionBatches, 'deletionBatches'); uniqueIds(project.attachments, 'attachments'); uniqueIds(project.snapshots, 'snapshots');
  const codes = new Set<string>();
  for (const type of project.nodeTypes) {
    keys(type, ['id', 'code', 'name', 'color', 'iconKey', 'isHidden', 'isSystem'], 'nodeType'); code(type.code, 'nodeType.code'); check(!codes.has(type.code), t('Повторный код типа.', "Duplicate type code.")); codes.add(type.code);
    label(type.name, 'nodeType.name', 80); check(/^#[a-fA-F0-9]{6}$/.test(type.color), t('Неверный цвет типа.', "Invalid type color.")); text(type.iconKey, 'nodeType.iconKey', 80, 1); check((NODE_ICON_KEYS as readonly string[]).includes(type.iconKey), t('Ключ иконки отсутствует в поддерживаемом каталоге.', "The icon key is not in the supported catalog."), 'invalid_icon'); bool(type.isHidden, 'nodeType.isHidden'); bool(type.isSystem, 'nodeType.isSystem');
    if (type.code === 'group') check(type.isSystem, t('Тип group должен оставаться системным.', "The group type must remain a system type."));
  }
  check(codes.has('note') && codes.has('group'), t('Отсутствует обязательный тип note/group.', "A required note/group type is missing."));
  const relationCodes = new Set<string>();
  for (const type of project.relationTypes) { object(type, 'relationType'); keys(type, ['code', 'name', 'defaultDirected'], 'relationType'); code(type.code, 'relationType.code'); check(!relationCodes.has(type.code), t('Повторный тип связи.', "Duplicate relationship type.")); relationCodes.add(type.code); label(type.name, 'relationType.name', 80); bool(type.defaultDirected, 'relationType.defaultDirected'); }
  const notePaths = new Set<string>();
  for (const node of project.nodes) {
    keys(node, ['id', 'title', 'notePath', 'noteHash', 'typeId', 'iconEmoji', 'assessment', 'confidence', 'attributes', 'evidence', 'x', 'y', 'zIndex', 'createdAt', 'updatedAt', 'deletedAt', 'deletionBatchId', 'missing', 'subtitle', 'tags', 'origin', 'extensions'], 'node');
    label(node.title, 'node.title', 200); validateRelativePath(node.notePath, 'node.notePath', true); const path = node.notePath.normalize('NFC').toLowerCase(); check(!notePaths.has(path), t('Заметка уже привязана к другому узлу.', "The note is already linked to another node."), 'duplicate_note'); notePaths.add(path);
    check(node.noteHash === null || HASH.test(node.noteHash), t('Неверный хеш заметки.', "Invalid note hash.")); id(node.typeId, 'node.typeId'); check(types.has(node.typeId), t('Отсутствует тип узла.', "The node type is missing."), 'missing_reference'); nullableText(node.iconEmoji, 'node.iconEmoji', 32); if (node.iconEmoji !== null) check(validEmoji(node.iconEmoji), t('Требуется одна последовательность Emoji17.0.', "Exactly one Emoji 17.0 sequence is required."));
    assessment(node, 'node'); finite(node.x, 'node.x', -MAX_COORDINATE, MAX_COORDINATE); finite(node.y, 'node.y', -MAX_COORDINATE, MAX_COORDINATE); integer(node.zIndex, 'node.zIndex', -2147483648, 2147483647);
    timestamp(node.createdAt, 'node.createdAt'); timestamp(node.updatedAt, 'node.updatedAt'); deletion(node, 'node'); bool(node.missing, 'node.missing'); nullableText(node.subtitle, 'node.subtitle', 500);
    array(node.tags, 'node.tags'); check(node.tags.length <= 50, t('Слишком много тегов.', "Too many tags.")); const tags = new Set<string>(); for (const tag of node.tags) { label(tag, 'node.tags', 50); const value = folded(tag); check(!tags.has(value), t('Повторный тег.', "Duplicate tag.")); tags.add(value); }
    validateAttributes(node.attributes, 'node.attributes'); validateEvidence(node.evidence, nodes, assets, 'node.evidence'); metadata(node.origin, 'node.origin'); metadata(node.extensions, 'node.extensions', 16384);
    if (node.deletionBatchId !== null) check(batches.get(node.deletionBatchId)?.nodeIds.includes(node.id), t('Узел не включён в свой пакет удаления.', "The node is not included in its deletion batch."), 'missing_reference');
  }
  for (const relation of project.relations) {
    keys(relation, ['id', 'sourceNodeId', 'targetNodeId', 'relationType', 'label', 'directed', 'bidirectional', 'assessment', 'confidence', 'noteMarkdown', 'evidence', 'deletedAt', 'deletionBatchId', 'createdAt', 'updatedAt', 'origin'], 'relation');
    id(relation.sourceNodeId, 'relation.source'); id(relation.targetNodeId, 'relation.target'); check(nodes.has(relation.sourceNodeId) && nodes.has(relation.targetNodeId), t('Конец связи не существует.', "A relationship endpoint does not exist."), 'missing_reference'); check(relation.sourceNodeId !== relation.targetNodeId, t('Самосвязь запрещена.', "Self-links are forbidden."), 'self_relation');
    code(relation.relationType, 'relation.relationType'); nullableText(relation.label, 'relation.label', 200); bool(relation.directed, 'relation.directed'); bool(relation.bidirectional, 'relation.bidirectional'); check(!relation.bidirectional || relation.directed, t('Двусторонняя связь должна быть направленной.', "A bidirectional relationship must be directed.")); assessment(relation, 'relation'); bytes(relation.noteMarkdown, 'relation.noteMarkdown', 65536);
    timestamp(relation.createdAt, 'relation.createdAt'); timestamp(relation.updatedAt, 'relation.updatedAt'); deletion(relation, 'relation'); validateEvidence(relation.evidence, nodes, assets, 'relation.evidence'); metadata(relation.origin, 'relation.origin');
    if (relation.deletedAt === null) check(nodes.get(relation.sourceNodeId)!.deletedAt === null && nodes.get(relation.targetNodeId)!.deletedAt === null, t('Активная связь ведёт в корзину.', "An active relationship points to a trashed node."), 'deleted_reference');
    if (relation.deletionBatchId !== null) check(batches.get(relation.deletionBatchId)?.relationIds.includes(relation.id), t('Связь не включена в свой пакет удаления.', "The relationship is not included in its deletion batch."), 'missing_reference');
  }
  const membershipIds = new Set<ID>();
  for (const membership of project.memberships) {
    object(membership, 'membership'); keys(membership, ['groupNodeId', 'memberNodeId', 'sortOrder'], 'membership'); id(membership.groupNodeId, 'membership.group'); id(membership.memberNodeId, 'membership.member'); integer(membership.sortOrder, 'membership.sortOrder');
    const group = nodes.get(membership.groupNodeId), member = nodes.get(membership.memberNodeId);
    check(group && member && group.deletedAt === null && member.deletedAt === null, t('Членство ссылается на отсутствующий/удалённый узел.', "Membership refers to a missing or trashed node."), 'missing_reference');
    check(types.get(group.typeId)!.code === 'group' && types.get(member.typeId)!.code !== 'group' && group.id !== member.id, t('Разрешён один уровень групп.', "Only one level of grouping is allowed."), 'invalid_group');
    check(!membershipIds.has(member.id), t('Узел уже входит в группу.', "The node already belongs to a group."), 'membership_conflict'); membershipIds.add(member.id);
  }
  const blobPaths = new Set<string>();
  for (const blob of project.blobs) {
    keys(blob, ['id', 'path', 'sha256', 'byteSize', 'mimeType', 'mediaKind'], 'blob'); validateRelativePath(blob.path, 'blob.path'); check(isAllowedResourcePath(blob.path, true), t('Оригинал должен находиться вне скрытых и служебных папок.', "Originals must stay outside hidden and metadata folders."));
    const path = blob.path.toLowerCase(); check(!blobPaths.has(path), t('Оригиналы имеют одинаковый путь.', "Originals have the same path.")); blobPaths.add(path); check(!notePaths.has(path), t('Путь оригинала совпадает с заметкой.', "An original has the same path as a note.")); validateBlob(blob);
  }
  for (const asset of project.assets) {
    keys(asset, ['id', 'blobId', 'originalName', 'title', 'mimeType', 'mediaKind', 'byteSize', 'sha256', 'createdAt', 'deletedAt', 'deletionBatchId', 'sourceUrl', 'sourceAuthor', 'sourceCreatedAt', 'noteMarkdown', 'origin'], 'asset');
    id(asset.blobId, 'asset.blobId'); const blob = blobs.get(asset.blobId); check(blob, t('Отсутствует оригинал материала.', "The material's original is missing."), 'missing_reference'); validateBlob(asset);
    check(['sha256', 'byteSize', 'mimeType', 'mediaKind'].every(key => asset[key as keyof Asset] === blob[key as keyof BlobRecord]), t('Материал и оригинал расходятся.', "The material and its original do not match."));
    text(asset.originalName, 'asset.originalName', 1024, 1); check(!hasControlCharacters(asset.originalName), t('Недопустимое имя файла.', "Invalid filename.")); label(asset.title, 'asset.title', 200); timestamp(asset.createdAt, 'asset.createdAt'); deletion(asset, 'asset');
    if (asset.sourceUrl !== null) httpUrl(asset.sourceUrl, 'asset.sourceUrl'); nullableText(asset.sourceAuthor, 'asset.sourceAuthor', 500); if (asset.sourceCreatedAt !== null) timestamp(asset.sourceCreatedAt, 'asset.sourceCreatedAt'); bytes(asset.noteMarkdown, 'asset.noteMarkdown', 65536); metadata(asset.origin, 'asset.origin');
    if (asset.deletionBatchId !== null) check(batches.has(asset.deletionBatchId), t('Пакет удаления материала отсутствует.', "The material's deletion batch is missing."));
  }
  const pairs = new Set<string>(), primary = new Set<ID>();
  for (const attachment of project.attachments) {
    keys(attachment, ['id', 'nodeId', 'assetId', 'role', 'sortOrder', 'caption'], 'attachment'); id(attachment.nodeId, 'attachment.nodeId'); id(attachment.assetId, 'attachment.assetId'); check(nodes.has(attachment.nodeId) && assets.has(attachment.assetId), t('Вложение ссылается на отсутствующий объект.', "An attachment refers to a missing object."), 'missing_reference');
    check(attachment.role === 'primary' || attachment.role === 'attachment', t('Неверная роль вложения.', "Invalid attachment role.")); integer(attachment.sortOrder, 'attachment.sortOrder'); nullableText(attachment.caption, 'attachment.caption', 10000);
    const pair = `${attachment.nodeId}:${attachment.assetId}`; check(!pairs.has(pair), t('Повторная привязка материала.', "Duplicate material attachment.")); pairs.add(pair);
    if (attachment.role === 'primary') { check(!primary.has(attachment.nodeId), t('У документа несколько основных материалов.', "The document has multiple primary materials.")); primary.add(attachment.nodeId); }
    if (nodes.get(attachment.nodeId)!.deletedAt === null) check(assets.get(attachment.assetId)!.deletedAt === null, t('Активный документ ссылается на удалённый материал.', "An active document refers to a trashed material."), 'deleted_reference');
  }
  for (const batch of project.deletionBatches) {
    keys(batch, ['id', 'nodeIds', 'relationIds', 'memberships', 'createdAt'], 'deletionBatch'); timestamp(batch.createdAt, 'deletionBatch.createdAt');
    for (const [ids, index, name] of [[batch.nodeIds, nodes, 'nodeIds'], [batch.relationIds, relations, 'relationIds']] as const) { array(ids, name); check(new Set(ids).size === ids.length, t('Повтор объекта в пакете удаления.', "Duplicate object in a deletion batch.")); for (const value of ids) { id(value, name); check(index.has(value), t('Отсутствует объект пакета удаления.', "A deletion batch object is missing."), 'missing_reference'); } }
    array(batch.memberships, 'deletionBatch.memberships'); for (const membership of batch.memberships) { object(membership, 'deletedMembership'); keys(membership, ['groupNodeId', 'memberNodeId', 'sortOrder'], 'deletedMembership'); integer(membership.sortOrder, 'deletedMembership.sortOrder'); check(nodes.has(membership.groupNodeId) && nodes.has(membership.memberNodeId), t('Отсутствует исторический участник группы.', "A historical group member is missing.")); }
  }
  for (const snapshot of project.snapshots) {
    keys(snapshot, ['id', 'title', 'path', 'sourceRevision', 'createdAt', 'assetIds'], 'snapshot'); label(snapshot.title, 'snapshot.title', 200); validateRelativePath(snapshot.path, 'snapshot.path');
    check(isAllowedSnapshotPath(snapshot.path, project.id, snapshot.id), t('Небезопасный путь снимка.', 'Unsafe snapshot path.'), 'unsafe_path'); integer(snapshot.sourceRevision, 'snapshot.sourceRevision', 0, project.revision); timestamp(snapshot.createdAt, 'snapshot.createdAt'); array(snapshot.assetIds, 'snapshot.assetIds'); check(new Set(snapshot.assetIds).size === snapshot.assetIds.length, t('Повтор материала снимка.', "Duplicate snapshot material.")); for (const assetId of snapshot.assetIds) check(assets.has(assetId), t('Отсутствует закреплённый материал снимка.', "A pinned snapshot material is missing."), 'missing_reference');
  }
  metadata(project.receipts, 'receipts'); for (const [operationId, receipt] of Object.entries(project.receipts)) { id(operationId, 'receipt.id'); object(receipt, 'receipt'); keys(receipt, ['hash', 'revision', 'timestamp'], 'receipt'); check(HASH.test(receipt.hash), t('Неверный хеш операции.', "Invalid operation hash.")); integer(receipt.revision, 'receipt.revision', 0, project.revision); timestamp(receipt.timestamp, 'receipt.timestamp'); }
  metadata(project.importedData, 'importedData');
}

function validateBlob(blob: Pick<BlobRecord, 'sha256' | 'byteSize' | 'mimeType' | 'mediaKind'>): void {
  check(typeof blob.sha256 === 'string' && HASH.test(blob.sha256), t('Неверный SHA-256 оригинала.', "Invalid original SHA-256.")); integer(blob.byteSize, 'blob.byteSize', 0, 536870912); text(blob.mimeType, 'blob.mimeType', 200, 1); check(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(blob.mimeType), t('Неверный MIME.', "Invalid MIME type.")); check(MEDIA.includes(blob.mediaKind), t('Неизвестный вид материала.', "Unknown material kind."));
}
function activeNode(project: Project, nodeId: ID): ProjectNode { const node = project.nodes.find(item => item.id === nodeId); check(node && node.deletedAt === null, t(`Узел ${nodeId} отсутствует или в корзине.`, `Node ${nodeId} is missing or in the trash.`), 'node_not_found'); return node; }
function systemType(project: Project, code: string): ID { const type = project.nodeTypes.find(item => item.code === code); check(type, t(`Тип ${code} отсутствует.`, `Type ${code} is missing.`)); return type.id; }
function newNode(project: Project, nodeId: ID, title: string, notePath: string, typeId: ID, hash: string | undefined, now: string): ProjectNode {
  id(nodeId, 'node.id'); check(!project.nodes.some(node => node.id === nodeId), t('Узел с таким ID уже существует.', "A node with this ID already exists."), 'duplicate_id');
  return { id: nodeId, title: normalized(title), notePath, noteHash: hash ?? null, typeId, iconEmoji: null, assessment: 'unreviewed', confidence: null, attributes: [], evidence: [], x: 0, y: 0, zIndex: 0, createdAt: now, updatedAt: now, deletedAt: null, deletionBatchId: null, missing: false, subtitle: null, tags: [], origin: { kind: 'manual' }, extensions: {} };
}
function assignMembers(project: Project, groupId: ID, nodeIds: ID[]): void {
  const group = activeNode(project, groupId); check(project.nodeTypes.find(type => type.id === group.typeId)?.code === 'group', t('Узел не является группой.', "The node is not a group."), 'invalid_group'); check(new Set(nodeIds).size === nodeIds.length, t('Повтор участника группы.', "Duplicate group member."));
  for (const nodeId of nodeIds) { activeNode(project, nodeId); check(!project.memberships.some(item => item.memberNodeId === nodeId && item.groupNodeId !== groupId), t('Узел входит в другую группу.', "The node belongs to another group."), 'membership_conflict'); }
  project.memberships = project.memberships.filter(item => item.groupNodeId !== groupId);
  project.memberships.push(...nodeIds.map((memberNodeId, sortOrder) => ({ groupNodeId: groupId, memberNodeId, sortOrder })));
}
function normalizeChanges(changes: NodeChanges): NodeChanges {
  const output = structuredClone(changes);
  if (output.title !== undefined) output.title = normalized(output.title);
  if (output.tags !== undefined) output.tags = output.tags.map(normalized);
  if (output.attributes !== undefined) output.attributes = output.attributes.map(attribute => ({ ...attribute, key: normalized(attribute.key) }));
  return output;
}

/** Execute a transaction against an isolated copy; validate references only at the final state. */
export function applyCommands(project: Project, commands: Command[], now = new Date().toISOString()): Project {
  validateProject(project); timestamp(now, 'now'); array(commands, 'commands'); check(commands.length >= 1 && commands.length <= 200, t('Пакет должен содержать 1–200 команд.', "A batch must contain 1–200 commands."));
  check(project.revision < Number.MAX_SAFE_INTEGER, t('Достигнут предел ревизии.', "The revision limit has been reached."), 'revision_exhausted');
  const next = structuredClone(project);
  for (const rawCommand of commands) {
    object(rawCommand, 'command'); const command = structuredClone(rawCommand);
    if (next.status === 'archived') {
      const reconciliation = command.kind === 'node.update' && Object.keys(command.changes).every(key => ['notePath', 'noteHash', 'missing'].includes(key));
      const unarchive = command.kind === 'project.update' && command.changes.status === 'active' && Object.keys(command.changes).length === 1;
      check(reconciliation || unarchive, t('Проект архивирован. Сначала верните его в активное состояние.', "The project is archived. Make it active before editing."), 'project_archived');
    }
    switch (command.kind) {
      case 'node.create': {
        keys(command, ['kind', 'id', 'title', 'notePath', 'typeId', 'noteHash', 'x', 'y'], 'command');
        const node = newNode(next, command.id, command.title, command.notePath, command.typeId ?? systemType(next, 'note'), command.noteHash, now); node.x = command.x ?? 0; node.y = command.y ?? 0; next.nodes.push(node); break;
      }
      case 'node.update': {
        keys(command, ['kind', 'nodeId', 'changes'], 'command'); object(command.changes, 'changes'); keys(command.changes, ['title', 'typeId', 'iconEmoji', 'assessment', 'confidence', 'attributes', 'evidence', 'notePath', 'noteHash', 'missing', 'subtitle', 'tags', 'extensions'], 'changes');
        const reconciliation = Object.keys(command.changes).every(key => ['notePath', 'noteHash', 'missing'].includes(key));
        const node = reconciliation ? next.nodes.find(item => item.id === command.nodeId) : activeNode(next, command.nodeId); check(node, t('Узел не найден.', "Node not found."), 'node_not_found'); Object.assign(node, normalizeChanges(command.changes), { updatedAt: now }); break;
      }
      case 'nodes.move': {
        keys(command, ['kind', 'positions'], 'command'); array(command.positions, 'positions'); const positions = new Map<ID, { x: number; y: number }>();
        for (const position of command.positions) { object(position, 'position'); keys(position, ['nodeId', 'x', 'y'], 'position'); check(!positions.has(position.nodeId), t('Повтор координат узла.', "Duplicate node coordinates."), 'ambiguous_move'); activeNode(next, position.nodeId); finite(position.x, 'x', -MAX_COORDINATE, MAX_COORDINATE); finite(position.y, 'y', -MAX_COORDINATE, MAX_COORDINATE); positions.set(position.nodeId, { x: position.x, y: position.y }); }
        const shifts = new Map<ID, { x: number; y: number }>();
        for (const [nodeId, position] of positions) { const node = activeNode(next, nodeId); if (next.nodeTypes.find(type => type.id === node.typeId)?.code === 'group') for (const membership of next.memberships.filter(item => item.groupNodeId === nodeId)) {
          const member = activeNode(next, membership.memberNodeId), expected = { x: member.x + position.x - node.x, y: member.y + position.y - node.y }, explicit = positions.get(member.id);
          check(!explicit || (explicit.x === expected.x && explicit.y === expected.y), t('Неоднозначное перемещение группы и участника.', "Ambiguous move of a group and its member."), 'ambiguous_move'); shifts.set(member.id, expected);
        } }
        for (const [nodeId, position] of positions) shifts.set(nodeId, position);
        for (const [nodeId, position] of shifts) Object.assign(activeNode(next, nodeId), position, { updatedAt: now }); break;
      }
      case 'relation.create': {
        keys(command, ['kind', 'relation'], 'command'); check(!next.relations.some(relation => relation.id === command.relation.id), t('Связь с таким ID уже существует.', "A relationship with this ID already exists."), 'duplicate_id');
        if (command.relation.relationType === 'related' && !next.relationTypes.some(type => type.code === 'related')) next.relationTypes.push({ code: 'related', name: 'Связано с', defaultDirected: false });
        next.relations.push(command.relation); break;
      }
      case 'relation.update': {
        keys(command, ['kind', 'relationId', 'changes'], 'command'); object(command.changes, 'changes'); keys(command.changes, ['sourceNodeId', 'targetNodeId', 'relationType', 'label', 'directed', 'bidirectional', 'assessment', 'confidence', 'noteMarkdown', 'evidence', 'deletedAt', 'deletionBatchId', 'updatedAt', 'origin'], 'changes');
        check(!own(command.changes, 'deletedAt') && !own(command.changes, 'deletionBatchId'), t('Для корзины используйте команды удаления/восстановления.', "Use delete/restore commands to change trash state."));
        const relation = next.relations.find(item => item.id === command.relationId && item.deletedAt === null); check(relation, t('Связь отсутствует или в корзине.', "The relationship is missing or in the trash."), 'relation_not_found'); Object.assign(relation, command.changes, { updatedAt: now }); break;
      }
      case 'type.upsert': {
        keys(command, ['kind', 'type'], 'command'); const old = next.nodeTypes.find(type => type.id === command.type.id);
        if (old?.isSystem) check(old.code === command.type.code && command.type.isSystem, t('Нельзя менять системную семантику типа.', "System type semantics cannot be changed."));
        if (!old) check(!command.type.isSystem, t('Нельзя создавать новый системный тип.', "A new system type cannot be created."));
        next.nodeTypes = next.nodeTypes.filter(type => type.id !== command.type.id); next.nodeTypes.push(command.type); break;
      }
      case 'group.create': {
        keys(command, ['kind', 'id', 'title', 'notePath', 'nodeIds', 'noteHash'], 'command'); array(command.nodeIds, 'nodeIds'); const group = newNode(next, command.id, command.title, command.notePath, systemType(next, 'group'), command.noteHash, now);
        const members = command.nodeIds.map(nodeId => activeNode(next, nodeId)); if (members.length) { group.x = members.reduce((sum, node) => sum + node.x, 0) / members.length; group.y = members.reduce((sum, node) => sum + node.y, 0) / members.length; }
        next.nodes.push(group); assignMembers(next, group.id, command.nodeIds); break;
      }
      case 'group.members': keys(command, ['kind', 'groupId', 'nodeIds'], 'command'); array(command.nodeIds, 'nodeIds'); assignMembers(next, command.groupId, command.nodeIds); break;
      case 'group.ungroup': {
        keys(command, ['kind', 'groupId'], 'command'); const group = activeNode(next, command.groupId); check(group.typeId === systemType(next, 'group'), t('Узел не является группой.', "The node is not a group.")); next.memberships = next.memberships.filter(item => item.groupNodeId !== group.id); group.typeId = systemType(next, 'note'); group.updatedAt = now; break;
      }
      case 'elements.trash': {
        keys(command, ['kind', 'nodeIds', 'relationIds', 'groupMode'], 'command'); array(command.nodeIds, 'nodeIds'); array(command.relationIds, 'relationIds'); check(['group_only', 'group_with_members'].includes(command.groupMode), t('Неверный режим удаления группы.', "Invalid group deletion mode."));
        const nodeIds = new Set(command.nodeIds), relationIds = new Set(command.relationIds); for (const nodeId of nodeIds) activeNode(next, nodeId);
        if (command.groupMode === 'group_with_members') for (const membership of next.memberships) if (nodeIds.has(membership.groupNodeId)) nodeIds.add(membership.memberNodeId);
        for (const relation of next.relations) if (relation.deletedAt === null && (nodeIds.has(relation.sourceNodeId) || nodeIds.has(relation.targetNodeId))) relationIds.add(relation.id);
        for (const relationId of relationIds) check(next.relations.some(item => item.id === relationId && item.deletedAt === null), t('Удаляемая связь не найдена.', "The relationship to delete was not found."), 'relation_not_found');
        check(nodeIds.size + relationIds.size > 0, t('Не выбраны объекты для удаления.', "No objects were selected for deletion.")); const batchId = crypto.randomUUID();
        const memberships = next.memberships.filter(item => nodeIds.has(item.groupNodeId) || nodeIds.has(item.memberNodeId)); next.memberships = next.memberships.filter(item => !memberships.includes(item));
        for (const node of next.nodes) if (nodeIds.has(node.id)) Object.assign(node, { deletedAt: now, deletionBatchId: batchId, updatedAt: now });
        for (const relation of next.relations) if (relationIds.has(relation.id)) Object.assign(relation, { deletedAt: now, deletionBatchId: batchId, updatedAt: now });
        next.deletionBatches.push({ id: batchId, nodeIds: [...nodeIds], relationIds: [...relationIds], memberships, createdAt: now }); break;
      }
      case 'trash.restore': {
        keys(command, ['kind', 'batchId'], 'command'); const batch = next.deletionBatches.find(item => item.id === command.batchId); check(batch, t('Пакет удаления не найден.', "Deletion batch not found."), 'batch_not_found');
        check(batch.nodeIds.some(nodeId => next.nodes.find(node => node.id === nodeId)?.deletionBatchId === batch.id) || batch.relationIds.some(relationId => next.relations.find(relation => relation.id === relationId)?.deletionBatchId === batch.id), t('Пакет уже восстановлен.', "The batch has already been restored."), 'restore_conflict');
        for (const nodeId of batch.nodeIds) { const node = next.nodes.find(item => item.id === nodeId)!; check(node.deletionBatchId === batch.id, t('Узел удалён другим пакетом.', "The node was deleted by another batch."), 'restore_conflict'); Object.assign(node, { deletedAt: null, deletionBatchId: null, updatedAt: now }); }
        for (const relationId of batch.relationIds) { const relation = next.relations.find(item => item.id === relationId)!; check(relation.deletionBatchId === batch.id, t('Связь удалена другим пакетом.', "The relationship was deleted by another batch."), 'restore_conflict'); Object.assign(relation, { deletedAt: null, deletionBatchId: null, updatedAt: now }); }
        next.memberships.push(...batch.memberships); break;
      }
      case 'asset.register': {
        keys(command, ['kind', 'asset', 'blob'], 'command'); check(!next.assets.some(asset => asset.id === command.asset.id), t('Материал с таким ID уже существует.', "A material with this ID already exists."), 'duplicate_id');
        const blob = next.blobs.find(item => item.id === command.blob.id); if (blob) check((['id', 'path', 'sha256', 'byteSize', 'mimeType', 'mediaKind'] as const).every(key => blob[key] === command.blob[key]), t('ID оригинала занят другим содержимым.', "The original ID is already used by different content."), 'blob_conflict'); else next.blobs.push(command.blob); next.assets.push(command.asset); break;
      }
      case 'asset.update': {
        keys(command, ['kind', 'assetId', 'changes'], 'command'); object(command.changes, 'changes'); keys(command.changes, ['title', 'sourceUrl', 'sourceAuthor', 'sourceCreatedAt', 'noteMarkdown'], 'changes');
        const asset = next.assets.find(item => item.id === command.assetId && item.deletedAt === null); check(asset, t('Материал отсутствует или в корзине.', "The material is missing or in the trash."), 'asset_not_found'); Object.assign(asset, command.changes); if (command.changes.title !== undefined) asset.title = normalized(command.changes.title); break;
      }
      case 'attachment.attach': {
        keys(command, ['kind', 'attachment'], 'command'); const attachment = command.attachment; activeNode(next, attachment.nodeId); check(next.assets.some(asset => asset.id === attachment.assetId && asset.deletedAt === null), t('Материал отсутствует или в корзине.', "The material is missing or in the trash."), 'asset_not_found');
        check(!next.attachments.some(item => item.id === attachment.id && (item.nodeId !== attachment.nodeId || item.assetId !== attachment.assetId)), t('ID привязки уже существует.', "The attachment ID already exists."), 'duplicate_id'); const old = next.attachments.find(item => item.nodeId === attachment.nodeId && item.assetId === attachment.assetId);
        if (attachment.role === 'primary') for (const item of next.attachments) if (item.nodeId === attachment.nodeId) item.role = 'attachment';
        if (old) { const oldId = old.id; Object.assign(old, attachment, { id: oldId }); } else next.attachments.push(attachment); break;
      }
      case 'attachment.detach': keys(command, ['kind', 'attachmentId'], 'command'); check(next.attachments.some(item => item.id === command.attachmentId), t('Привязка не найдена.', "Attachment not found."), 'attachment_not_found'); next.attachments = next.attachments.filter(item => item.id !== command.attachmentId); break;
      case 'attachment.primary': {
        keys(command, ['kind', 'attachmentId'], 'command'); const attachment = next.attachments.find(item => item.id === command.attachmentId); check(attachment, t('Привязка не найдена.', "Attachment not found."), 'attachment_not_found'); activeNode(next, attachment.nodeId); for (const item of next.attachments) if (item.nodeId === attachment.nodeId) item.role = item.id === attachment.id ? 'primary' : 'attachment'; break;
      }
      case 'project.update': keys(command, ['kind', 'changes'], 'command'); object(command.changes, 'changes'); keys(command.changes, ['title', 'descriptionMarkdown', 'status'], 'changes'); Object.assign(next, command.changes); if (command.changes.title !== undefined) next.title = normalized(command.changes.title); break;
      case 'snapshot.register': keys(command, ['kind', 'snapshot'], 'command'); check(!next.snapshots.some(snapshot => snapshot.id === command.snapshot.id), t('ID снимка уже существует.', "The snapshot ID already exists."), 'duplicate_id'); next.snapshots.push(command.snapshot); break;
      default: fail(t('Неизвестная команда.', "Unknown command."), 'unknown_command');
    }
  }
  next.revision += 1; next.updatedAt = now; validateProject(next); return next;
}

/** Literal Unicode search. No regex, SQL wildcard or truncation of the indexed body. */
export function searchProject(project: Project, query: string, bodies: ReadonlyMap<ID, string> | Record<ID, string> = {}, caseSensitive = false): SearchHit[] {
  const normalizedQuery = query.normalize('NFC'); if (normalizedQuery.length === 0) return [];
  const needle = caseSensitive ? normalizedQuery : caseFold(normalizedQuery); const hits: SearchHit[] = [];
  const bodyFor = (nodeId: ID): string => bodies instanceof Map ? (bodies as ReadonlyMap<ID, string>).get(nodeId) ?? '' : (bodies as Record<ID, string>)[nodeId] ?? '';
  for (const node of project.nodes) {
    if (node.deletedAt !== null) continue;
    const fields: [string, string][] = [['title', node.title], ['body', bodyFor(node.id)], ['subtitle', node.subtitle ?? ''], ['tags', node.tags.join(' ')]];
    for (const attribute of node.attributes) fields.push([`attribute:${attribute.id}`, `${attribute.key}: ${typeof attribute.value === 'object' && attribute.value !== null ? JSON.stringify(attribute.value) : String(attribute.value ?? '')}`]);
    for (const [field, value] of fields) { const source = value.normalize('NFC'), haystack = caseSensitive ? source : caseFold(source), index = haystack.indexOf(needle); if (index >= 0) hits.push({ nodeId: node.id, field, snippet: source.slice(Math.max(0, index - 60), index + needle.length + 100) }); }
  }
  return hits;
}

export interface ProjectedRelation { id: ID; sourceNodeId: ID; targetNodeId: ID; relationIds: ID[]; directed: boolean; bidirectional: boolean; relationType: string; label: string | null }
export interface GraphProjection { nodes: ProjectNode[]; relations: ProjectedRelation[] }
/** Presentation-only grouping. Original endpoints and relation IDs are never changed. */
export function projectGraph(project: Project, collapsedGroupIds: readonly ID[] = []): GraphProjection {
  const collapsed = new Set(collapsedGroupIds), types = new Map(project.nodeTypes.map(type => [type.id, type.code]));
  const active = new Map(project.nodes.filter(node => node.deletedAt === null).map(node => [node.id, node]));
  for (const groupId of collapsed) if (!active.has(groupId) || types.get(active.get(groupId)!.typeId) !== 'group') collapsed.delete(groupId);
  const owners = new Map(project.memberships.filter(item => collapsed.has(item.groupNodeId)).map(item => [item.memberNodeId, item.groupNodeId]));
  const projected = new Map<string, ProjectedRelation>();
  for (const relation of project.relations) {
    if (relation.deletedAt !== null) continue;
    let source = owners.get(relation.sourceNodeId) ?? relation.sourceNodeId, target = owners.get(relation.targetNodeId) ?? relation.targetNodeId;
    if (source === target) continue;
    if (!relation.directed && source > target) [source, target] = [target, source];
    const aggregated = owners.has(relation.sourceNodeId) || owners.has(relation.targetNodeId);
    const key = aggregated ? JSON.stringify([source, target, relation.relationType, relation.directed, relation.bidirectional]) : relation.id;
    const existing = projected.get(key);
    if (existing) { existing.relationIds.push(relation.id); existing.label = t(`${existing.relationIds.length} связей`, `${existing.relationIds.length} relationships`); }
    else projected.set(key, { id: aggregated ? `aggregate:${relation.id}` : relation.id, sourceNodeId: source, targetNodeId: target, relationIds: [relation.id], directed: relation.directed, bidirectional: relation.bidirectional, relationType: relation.relationType, label: relation.label });
  }
  return { nodes: [...active.values()].filter(node => !owners.has(node.id)), relations: [...projected.values()] };
}

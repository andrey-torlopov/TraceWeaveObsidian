import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Asset, Attribute, Evidence, Project, ProjectNode, ReadableReportResult, Relation, VaultLink } from './types';
import { copyChecked, digestFile, resolveSafe, safeRelative, verifiedMediaInfo } from './storage/files';
import { hasControlCharacters, isTechnicalPath } from './storage/layout';
import { t } from './i18n';
import { markdownDestination, markdownLabel, prepareReportMarkdown, relocateReportMarkdown, type PreparedMarkdown, type ReportLink } from './report-markdown';

const MAX_NOTE_BYTES = 5_242_880;
const MAX_TEXT_BYTES = 67_108_864;
const CATEGORIES = ['images', 'video', 'audio', 'documents', 'archives', 'other'] as const;
type Category = typeof CATEGORIES[number];
interface FileCopy { source: string; relative: string; sha256: string; byteSize: number; embeddable: boolean }
interface NoteCapture { node: ProjectNode; ordinal: number; proof: { sha256: string; byteSize: number }; markdown: PreparedMarkdown }
interface ReportOptions { configDir?: string; resolveLink?: (sourcePath: string, link: string) => Promise<VaultLink | null>; assertUnchanged?: () => Promise<void> }

/** Empty means vault root. User paths must be visible vault-relative folders, never configuration or metadata. */
export function validateReportFolder(value: string, configDir?: string): string {
  if (value === '') return '';
  safeRelative(value, configDir);
  if (isTechnicalPath(value, configDir) || value.split('/').some(part => part.startsWith('.') || /[<>"|?*#]/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error(t('Небезопасная папка отчётов.', 'Unsafe report folder.'));
  return value;
}
function safeName(value: string, fallback: string): string {
  const cleaned = [...value.normalize('NFC')].map(character => hasControlCharacters(character) ? '-' : character).join('').replace(/[<>:"/\\|?*#]/gu, '-').replace(/\s+/gu, ' ').trim().replace(/^\.+|[. ]+$/gu, '');
  const extension = path.posix.extname(cleaned), suffix = /^\.[\p{L}\p{N}]{1,12}$/u.test(extension) ? extension : '';
  const characters = [...(suffix ? cleaned.slice(0, -suffix.length) : cleaned)];
  while (Buffer.byteLength(characters.join('') + suffix) > 180) characters.pop();
  const truncated = (characters.join('') + suffix).replace(/[. ]+$/gu, '');
  return !truncated || ['twdata', '_traceweave'].includes(truncated.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(truncated) ? fallback : truncated;
}
const pathKey = (value: string) => value.normalize('NFC').toLowerCase();
const join = (parent: string, child: string) => parent ? `${parent}/${child}` : child;
const text = (value: string) => markdownLabel(value);
const link = (label: string, target: string) => `[${text(label)}](${markdownDestination(target)})`;
const nodeAnchor = (ordinal: number) => `tw-node-${ordinal}`;
const assetAnchor = (ordinal: number) => `tw-material-${ordinal}`;
function category(asset: Pick<Asset, 'mediaKind' | 'mimeType' | 'originalName'>): Category {
  if (asset.mediaKind === 'image' || asset.mimeType.startsWith('image/')) return 'images';
  if (asset.mediaKind === 'video' || asset.mimeType.startsWith('video/')) return 'video';
  if (asset.mediaKind === 'audio' || asset.mimeType.startsWith('audio/')) return 'audio';
  if (/\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar)$/iu.test(asset.originalName) || /(?:zip|compressed|archive|tar)/iu.test(asset.mimeType)) return 'archives';
  if (asset.mediaKind === 'text' || /^(?:text\/|application\/(?:pdf|msword|rtf|vnd\.openxmlformats|vnd\.oasis))/iu.test(asset.mimeType) || /\.(?:md|txt|pdf|docx?|xlsx?|pptx?|csv|rtf|odt|ods)$/iu.test(asset.originalName)) return 'documents';
  return 'other';
}
function date(value: string): string { return Number.isFinite(Date.parse(value)) ? value.slice(0, 10) + ' ' + value.slice(11, 19) + ' UTC' : t('не указана', 'not specified'); }
function assessment(value: ProjectNode['assessment']): string { return ({ unreviewed: t('не проверено', 'unreviewed'), confirmed_by_user: t('подтверждено пользователем', 'confirmed by user'), hypothesis: t('гипотеза', 'hypothesis'), refuted_by_user: t('опровергнуто пользователем', 'refuted by user') })[value]; }
function confidence(value: ProjectNode['confidence']): string { return value === null ? t('не указана', 'not specified') : ({ low: t('низкая', 'low'), medium: t('средняя', 'medium'), high: t('высокая', 'high') })[value]; }
function attributeValue(attribute: Attribute): string {
  const value = attribute.value;
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? t('да', 'yes') : t('нет', 'no');
  if (typeof value === 'object') return 'latitude' in value ? `${value.latitude}, ${value.longitude}${value.accuracyMeters === null ? '' : ` (±${value.accuracyMeters} ${t('м', 'm')})`}` : value.value;
  return String(value);
}
function errorDetail(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function visibleSource(relative: string, configDir?: string): string {
  safeRelative(relative, configDir);
  if (relative.split('/').some(part => part.startsWith('.') || part.toLowerCase() === '_traceweave') || /[?#]/u.test(relative)) throw new Error(t('Недопустимый исходный путь.', 'Invalid source path.'));
  return relative;
}
async function readNote(vaultRoot: string, relative: string, configDir?: string): Promise<{ content: string; proof: { sha256: string; byteSize: number } }> {
  const absolute = await resolveSafe(vaultRoot, visibleSource(relative, configDir), false, configDir), handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > MAX_NOTE_BYTES) throw new Error(t('Заметка отсутствует или превышает лимит 5 MiB.', 'The note is unavailable or exceeds the 5 MiB limit.'));
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(t('Заметка изменилась во время чтения.', 'The note changed during reading.'));
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), proof: { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length } };
  } finally { await handle.close(); }
}
async function ensureParent(root: string, relative: string, configDir?: string): Promise<string> {
  if (!relative) return fs.realpath(root);
  const absolute = await resolveSafe(root, `${relative}/.report-folder-probe`, true, configDir);
  return path.dirname(absolute);
}
async function unusedName(directory: string, base: string, excluded: ReadonlySet<string> = new Set()): Promise<string> {
  const used = new Set((await fs.readdir(directory)).map(pathKey));
  for (let index = 1; index < 100_000; index++) { const name = base + (index === 1 ? '' : ` (${index})`); if (!used.has(pathKey(name)) && !excluded.has(pathKey(name))) return name; }
  throw new Error(t('Не удалось подобрать свободное имя отчёта.', 'Unable to choose an unused report name.'));
}

/** Produce an ordinary, self-contained vault folder. The project and its original files remain untouched. */
export async function exportReadableReport(vaultRoot: string, input: Project, reportFolder: string, options: ReportOptions = {}): Promise<ReadableReportResult> {
  const project = structuredClone(input), parent = validateReportFolder(reportFolder, options.configDir), nodes = project.nodes.filter(node => !node.deletedAt).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const assets = project.assets.filter(asset => !asset.deletedAt), activeIds = new Set(nodes.map(node => node.id)), relations = project.relations.filter(relation => !relation.deletedAt && activeIds.has(relation.sourceNodeId) && activeIds.has(relation.targetNodeId));
  for (const source of [...nodes.map(node => node.notePath), ...project.blobs.filter(blob => assets.some(asset => asset.blobId === blob.id)).map(blob => blob.path)]) {
    visibleSource(source, options.configDir);
    if (parent && (pathKey(parent) === pathKey(source) || pathKey(parent).startsWith(pathKey(source) + '/') || (source === project.blobs.find(blob => blob.path === source)?.path && pathKey(parent).startsWith(pathKey(path.posix.dirname(source)) + '/')))) throw new Error(t('Папка отчётов пересекается с исходными файлами.', 'The report folder overlaps source files.'));
  }
  const parentAbsolute = await ensureParent(vaultRoot, parent, options.configDir);
  let base = safeName(project.title, t('Исследование', 'Research'));
  try { validateReportFolder(join(parent, base), options.configDir); } catch { base += ' ' + t('отчёт', 'report'); validateReportFolder(join(parent, base), options.configDir); }
  // Hidden staging is intentionally outside the final visible report and is always removed on failure.
  const staging = path.join(parentAbsolute, `.traceweave-report-${randomUUID()}`); await fs.mkdir(staging, { mode: 0o700 });
  const notes: NoteCapture[] = [], copies = new Map<string, FileCopy>(), assetCopies = new Map<string, FileCopy>(), names = new Map<Category, Set<string>>(CATEGORIES.map(value => [value, new Set()]));
  const nodesByPath = new Map<string, NoteCapture>(), assetOrdinals = new Map(assets.map((asset, index) => [asset.id, index + 1]));
  let totalTextBytes = 0;
  try {
    for (const value of CATEGORIES) await fs.mkdir(path.join(staging, 'Attachments', value), { recursive: true });
    for (const [index, node] of nodes.entries()) {
      let captured: Awaited<ReturnType<typeof readNote>>;
      try { captured = await readNote(vaultRoot, node.notePath, options.configDir); }
      catch (error) { throw new Error(t(`Не удалось прочитать заметку «${node.title}»: `, `Unable to read note “${node.title}”: `) + errorDetail(error)); }
      totalTextBytes += captured.proof.byteSize; if (totalTextBytes > MAX_TEXT_BYTES) throw new Error(t('Суммарный текст отчёта превышает 64 MiB.', 'The report text exceeds 64 MiB.'));
      const entry: NoteCapture = { node, ordinal: index + 1, proof: captured.proof, markdown: prepareReportMarkdown(captured.content, index + 1) }; notes.push(entry); nodesByPath.set(pathKey(node.notePath), entry);
    }
    const copy = async (source: string, name: string, group: Category, expected?: { sha256: string; byteSize: number }): Promise<FileCopy> => {
      visibleSource(source, options.configDir); const existing = copies.get(pathKey(source));
      if (existing) { if (expected && (existing.sha256 !== expected.sha256 || existing.byteSize !== expected.byteSize)) throw new Error(t('Несогласованные данные вложения.', 'Inconsistent attachment metadata.')); return existing; }
      const absolute = await resolveSafe(vaultRoot, source, false, options.configDir), sanitized = safeName(name, t('Файл', 'File')), suffix = path.posix.extname(sanitized), stem = sanitized.slice(0, sanitized.length - suffix.length), used = names.get(group)!;
      let filename = sanitized, index = 1; while (used.has(pathKey(filename))) filename = `${stem} (${++index})${suffix}`;
      used.add(pathKey(filename)); const relative = `Attachments/${group}/${filename}`;
      const proof = await copyChecked(absolute, path.join(staging, relative), expected), media = await verifiedMediaInfo(absolute, filename); const result = { source, relative, ...proof, embeddable: ['image', 'audio', 'video'].includes(media.mediaKind) || media.mimeType === 'application/pdf' }; copies.set(pathKey(source), result); return result;
    };
    for (const asset of assets) {
      const blob = project.blobs.find(value => value.id === asset.blobId);
      if (!blob || blob.sha256 !== asset.sha256 || blob.byteSize !== asset.byteSize) throw new Error(t(`Не найден оригинал материала «${asset.title}».`, `The original material “${asset.title}” is unavailable.`));
      try { assetCopies.set(asset.id, await copy(blob.path, asset.originalName, category(asset), { sha256: asset.sha256, byteSize: asset.byteSize })); }
      catch (error) { throw new Error(t(`Не удалось скопировать материал «${asset.title}»: `, `Unable to copy material “${asset.title}”: `) + errorDetail(error)); }
    }
    const nodeLink = (id: string): string => { const found = notes.find(note => note.node.id === id); return found ? link(found.node.title, '#^' + nodeAnchor(found.ordinal)) : text(t('узел вне отчёта', 'node outside report')); };
    const localize = (sourcePath: string) => async (raw: string, embed: boolean): Promise<ReportLink> => {
      const destination = raw.trim(); let decoded: string;
      try { decoded = decodeURIComponent(destination); } catch { return { target: null, embed: false, suffix: t('некорректная ссылка', 'invalid link') }; }
      if (hasControlCharacters(decoded) || decoded.includes('\\') || /^\/\//u.test(decoded)) return { target: null, embed: false, suffix: t('небезопасная ссылка', 'unsafe link') };
      if (/^[a-z][a-z\d+.-]*:/iu.test(decoded)) {
        try { const url = new URL(decoded); if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password) return { target: destination, embed: false }; }
        catch { /* Invalid or unsupported external targets are rendered as inert labels below. */ }
        return { target: null, embed: false, suffix: t('небезопасная ссылка', 'unsafe link') };
      }
      const marker = decoded.search(/[?#]/u), pathname = marker < 0 ? decoded : decoded.slice(0, marker), subpath = marker < 0 ? '' : decoded.slice(marker);
      const rooted = pathname.startsWith('/'), candidate = pathname ? path.posix.normalize(rooted ? pathname.slice(1) : path.posix.join(path.posix.dirname(sourcePath), pathname)) : sourcePath;
      const explicit = /^\.?\.?\//u.test(pathname) || rooted;
      const candidates = [candidate, ...(explicit ? [] : [pathname])].filter(Boolean);
      let resolved: VaultLink | null = null;
      for (const value of candidates) { try { visibleSource(value, options.configDir); } catch { return { target: null, embed: false, suffix: t('небезопасная ссылка', 'unsafe link') }; } }
      // Only exact paths resolve without Obsidian's metadata cache. Basenames must be unambiguous.
      const findNote = (value: string) => nodesByPath.get(pathKey(value)) ?? nodesByPath.get(pathKey(value + '.md'));
      if (options.resolveLink) resolved = await options.resolveLink(sourcePath, destination);
      if (resolved) visibleSource(resolved.path, options.configDir);
      let note = resolved ? findNote(resolved.path) : candidates.map(findNote).find(Boolean), copied = resolved ? copies.get(pathKey(resolved.path)) : candidates.map(value => copies.get(pathKey(value))).find(Boolean);
      if (resolved?.isNote && !note) return { target: null, embed: false, suffix: t('заметка вне исследования', 'note outside research') };
      if (!options.resolveLink && !note && !copied && !explicit && pathname && !pathname.includes('/')) {
        const matching = notes.filter(value => path.posix.basename(value.node.notePath, '.md') === pathname || path.posix.basename(value.node.notePath) === pathname);
        if (matching.length === 1) note = matching[0];
      }
      if (note) {
        let anchor = '#^' + nodeAnchor(note.ordinal);
        if (subpath.startsWith('#^')) anchor = '#^' + (note.markdown.blocks.get(subpath.slice(2)) ?? nodeAnchor(note.ordinal));
        else if (subpath.startsWith('#')) { const heading = note.markdown.headings.get(subpath.slice(1).replace(/[*_`]/gu, '').trim().toLowerCase()); if (heading) anchor = '#' + heading; }
        return { target: anchor, embed: false, suffix: embed ? t('заметка в отчёте', 'note in report') : undefined };
      }
      if (!copied) {
        const source = resolved?.path ?? candidates.find(value => /\.[^/]+$/u.test(value));
        if (resolved?.isNote || (source && /\.md$/iu.test(source))) return { target: null, embed: false, suffix: t('заметка вне исследования', 'note outside research') };
        if (source) {
          let absolute: string; try { absolute = await resolveSafe(vaultRoot, source, false, options.configDir); const stat = await fs.lstat(absolute); if (!stat.isFile()) return { target: null, embed: false, suffix: t('файл вне отчёта', 'file outside report') }; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { target: null, embed: false, suffix: t('файл не найден', 'file not found') }; throw error; }
          const extension = path.posix.extname(source).toLowerCase(), media = resolved ?? { mediaKind: /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/u.test(extension) ? 'image' : /\.(mp4|mov|webm|mkv)$/u.test(extension) ? 'video' : /\.(mp3|wav|m4a|ogg|flac)$/u.test(extension) ? 'audio' : 'file', mimeType: '', originalName: path.posix.basename(source) };
          copied = await copy(source, path.posix.basename(source), category({ mediaKind: media.mediaKind, mimeType: media.mimeType, originalName: path.posix.basename(source) }));
        }
      }
      return copied ? { target: copied.relative + subpath, embed: embed && copied.embeddable } : { target: null, embed: false, suffix: t('ссылка вне отчёта', 'link outside report') };
    };
    let fragmentOrdinal = nodes.length + 1;
    const render = (content: string, sourcePath: string, prepared = false) => relocateReportMarkdown(prepared ? content : prepareReportMarkdown(content, fragmentOrdinal++).text, localize(sourcePath));
    const safeUrl = async (value: string, sourcePath = '') => { const found = await localize(sourcePath)(value, false); return found.target ? link(value, found.target) : text(value) + ` (${text(found.suffix ?? t('ссылка недоступна', 'link unavailable'))})`; };
    const evidence = async (values: Evidence[], sourcePath: string): Promise<string> => {
      const lines: string[] = [];
      for (const value of values) {
        const asset = assets.find(item => item.id === value.assetId), target = value.sourceKind === 'node' ? nodeLink(value.sourceNodeId ?? '') : value.sourceKind === 'asset' ? asset ? link(asset.title, '#^' + assetAnchor(assetOrdinals.get(asset.id)!)) : text(t('материал вне отчёта', 'material outside report')) : value.url ? await safeUrl(value.url, sourcePath) : text(t('источник не указан', 'source not specified'));
        lines.push(`- ${value.label ? text(value.label) + ': ' : ''}${target}${value.locator ? '; ' + text(value.locator) : ''}${value.accessedAt ? '; ' + t('дата обращения: ', 'accessed: ') + text(value.accessedAt) : ''}`);
        if (value.quote) lines.push(value.quote.split(/\r?\n/u).map(line => '> ' + text(line)).join('\n'));
        if (value.note) lines.push(await render(value.note, sourcePath));
      }
      return lines.join('\n\n');
    };
    const sections = [`# ${text(project.title)}`, `${t('Создано', 'Created')}: ${date(project.createdAt)} · ${t('Обновлено', 'Updated')}: ${date(project.updatedAt)}`, link(t('Схема исследования', 'Research graph'), 'scheme.canvas')];
    if (project.descriptionMarkdown) sections.push(await render(project.descriptionMarkdown, ''));
    sections.push(`## ${t('Содержание', 'Contents')}\n\n` + notes.map(note => `- ${link(`${note.ordinal}. ${note.node.title}`, '#^' + nodeAnchor(note.ordinal))}`).join('\n'));
    for (const capture of notes) {
      const { node, ordinal } = capture, type = project.nodeTypes.find(value => value.id === node.typeId);
      sections.push(`## ${ordinal}. ${text(node.title)}`, `📅 ${t('Создано', 'Created')}: ${date(node.createdAt)} · ${t('Обновлено', 'Updated')}: ${date(node.updatedAt)} ^${nodeAnchor(ordinal)}`);
      const metadata = [`**${t('Тип', 'Type')}:** ${text(type?.name ?? t('не указан', 'not specified'))}`, `**${t('Оценка', 'Assessment')}:** ${assessment(node.assessment)}; **${t('уверенность', 'confidence')}:** ${confidence(node.confidence)}`];
      if (node.subtitle) metadata.push(`**${t('Подзаголовок', 'Subtitle')}:** ${text(node.subtitle)}`);
      if (node.tags.length) metadata.push(`**${t('Теги', 'Tags')}:** ${node.tags.map(text).join(', ')}`);
      const memberships = project.memberships.filter(value => value.memberNodeId === node.id && activeIds.has(value.groupNodeId));
      if (memberships.length) metadata.push(`**${t('Группы', 'Groups')}:** ${memberships.map(value => nodeLink(value.groupNodeId)).join(', ')}`);
      const members = project.memberships.filter(value => value.groupNodeId === node.id && activeIds.has(value.memberNodeId)).sort((a, b) => a.sortOrder - b.sortOrder);
      if (members.length) metadata.push(`**${t('Состав группы', 'Group members')}:** ${members.map(value => nodeLink(value.memberNodeId)).join(', ')}`);
      sections.push(metadata.join('\n\n'));
      for (const attribute of [...node.attributes].sort((a, b) => a.sortOrder - b.sortOrder)) sections.push(`- **${text(attribute.key)}:** ${attribute.valueType === 'url' && typeof attribute.value === 'string' ? await safeUrl(attribute.value, node.notePath) : text(attributeValue(attribute))}`);
      const connected = relations.filter(value => value.sourceNodeId === node.id || value.targetNodeId === node.id);
      if (connected.length) sections.push(`### ${ordinal}. ${t('Связи', 'Relations')}`);
      for (const relation of connected) {
        const kind = project.relationTypes.find(value => value.code === relation.relationType)?.name ?? relation.relationType;
        const arrow = relation.bidirectional ? '↔' : relation.directed ? '→' : '—';
        sections.push(`- ${nodeLink(relation.sourceNodeId)} ${arrow} ${nodeLink(relation.targetNodeId)} — **${text(kind)}**${relation.label ? ': ' + text(relation.label) : ''}\n  ${t('Оценка', 'Assessment')}: ${assessment(relation.assessment)}; ${t('уверенность', 'confidence')}: ${confidence(relation.confidence)}; ${t('создано', 'created')}: ${date(relation.createdAt)}; ${t('обновлено', 'updated')}: ${date(relation.updatedAt)}`);
        if (relation.noteMarkdown) sections.push(await render(relation.noteMarkdown, node.notePath));
        if (relation.evidence.length) sections.push(await evidence(relation.evidence, node.notePath));
      }
      sections.push(`### ${ordinal}. ${t('Заметка', 'Note')}`, await render(capture.markdown.text, node.notePath, true));
      const attached = project.attachments.filter(value => value.nodeId === node.id && assetCopies.has(value.assetId)).sort((a, b) => a.sortOrder - b.sortOrder);
      if (attached.length) sections.push(`### ${ordinal}. ${t('Вложения', 'Attachments')}`);
      for (const attachment of attached) { const asset = assets.find(value => value.id === attachment.assetId)!; sections.push(`- ${link(asset.title || asset.originalName, assetCopies.get(asset.id)!.relative)}${attachment.caption ? ' — ' + text(attachment.caption) : ''}${attachment.role === 'primary' ? ` (${t('основное', 'primary')})` : ''}`); }
      if (node.evidence.length) sections.push(`### ${ordinal}. ${t('Источники', 'Evidence')}`, await evidence(node.evidence, node.notePath));
    }
    if (assets.length) sections.push(`## ${t('Материалы исследования', 'Research materials')}`);
    for (const asset of assets) {
      const copied = assetCopies.get(asset.id)!;
      sections.push(`### ${text(asset.title || asset.originalName)}`, `${link(asset.originalName, copied.relative)} ^${assetAnchor(assetOrdinals.get(asset.id)!)}`, `${t('Добавлено', 'Added')}: ${date(asset.createdAt)}`);
      if (asset.sourceAuthor) sections.push(`**${t('Автор источника', 'Source author')}:** ${text(asset.sourceAuthor)}`);
      if (asset.sourceCreatedAt) sections.push(`**${t('Дата источника', 'Source date')}:** ${text(asset.sourceCreatedAt)}`);
      if (asset.sourceUrl) sections.push(`**${t('Источник', 'Source')}:** ${await safeUrl(asset.sourceUrl)}`);
      if (asset.noteMarkdown) sections.push(await render(asset.noteMarkdown, ''));
    }
    const registeredCopies = new Set([...assetCopies.values()].map(value => value.relative));
    const additional = [...copies.values()].filter(value => !registeredCopies.has(value.relative));
    if (additional.length) sections.push(`## ${t('Файлы из заметок', 'Files linked in notes')}\n\n` + additional.map(value => '- ' + link(path.posix.basename(value.relative), value.relative)).join('\n'));
    const summary = sections.filter(Boolean).join('\n\n') + '\n';
    if (Buffer.byteLength(summary) > MAX_TEXT_BYTES) throw new Error(t('Сформированный отчёт превышает 64 MiB.', 'The generated report exceeds 64 MiB.'));
    await fs.writeFile(path.join(staging, 'summary.md'), summary, { flag: 'wx', mode: 0o600 });
    const verifySources = async () => {
      for (const capture of notes) { const proof = await digestFile(await resolveSafe(vaultRoot, capture.node.notePath, false, options.configDir), {}, MAX_NOTE_BYTES); if (proof.sha256 !== capture.proof.sha256 || proof.byteSize !== capture.proof.byteSize) throw new Error(t('Исходная заметка изменилась. Повторите экспорт.', 'A source note changed. Repeat the export.')); }
      for (const value of copies.values()) { const proof = await digestFile(await resolveSafe(vaultRoot, value.source, false, options.configDir)); if (proof.sha256 !== value.sha256 || proof.byteSize !== value.byteSize) throw new Error(t('Исходное вложение изменилось. Повторите экспорт.', 'A source attachment changed. Repeat the export.')); }
    };
    const excludedNames = new Set<string>();
    // Every supported desktop platform reserves a fresh name without replacing somebody else's report.
    for (;;) {
      const finalName = await unusedName(parentAbsolute, base, excludedNames), directory = join(parent, finalName), reserved = path.join(parentAbsolute, finalName);
      const winLock = path.join(parentAbsolute, `.traceweave-report-lock-${createHash('sha256').update(finalName).digest('hex')}`);
      let lock: fs.FileHandle | undefined;
      try {
        if (process.platform === 'win32') {
          try { lock = await fs.open(winLock, 'wx', 0o600); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { excludedNames.add(pathKey(finalName)); continue; } throw error; }
          try { await fs.lstat(reserved); excludedNames.add(pathKey(finalName)); await lock.close(); lock = undefined; await fs.unlink(winLock); continue; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        } else {
          try { await fs.mkdir(reserved, { mode: 0o700 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { excludedNames.add(pathKey(finalName)); continue; } throw error; }
        }
        const outputCanvas = createCanvas(project, notes, relations, join(directory, 'summary.md'));
        try {
          await fs.writeFile(path.join(staging, 'scheme.canvas'), JSON.stringify(outputCanvas, null, 2) + '\n', { mode: 0o600 });
          // A reconfiguration or revision change aborts publication. Recheck file bytes after the callback too.
          await options.assertUnchanged?.(); await verifySources();
          const currentParent = parent ? path.dirname(await resolveSafe(vaultRoot, `${parent}/summary.md`, false, options.configDir)) : await fs.realpath(vaultRoot);
          if (currentParent !== parentAbsolute) throw new Error(t('Папка отчётов изменилась.', 'The report folder changed.'));
          // POSIX atomically replaces our empty reservation; Windows atomically renames to an absent directory.
          await fs.rename(staging, reserved);
        } catch (error) { if (process.platform !== 'win32') await fs.rmdir(reserved); throw error; }
        return { directory, summaryPath: join(directory, 'summary.md'), canvasPath: join(directory, 'scheme.canvas') };
      } finally { if (lock) { await lock.close(); await fs.unlink(winLock); } }
    }

  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}
interface CanvasText { id: string; type: 'text'; x: number; y: number; width: number; height: number; text: string; color?: string }
interface CanvasGroup { id: string; type: 'group'; x: number; y: number; width: number; height: number; label: string }
interface CanvasEdge { id: string; fromNode: string; fromSide: 'left' | 'right'; toNode: string; toSide: 'left' | 'right'; fromEnd: 'none' | 'arrow'; toEnd: 'none' | 'arrow'; label: string }
function createCanvas(project: Project, notes: NoteCapture[], relations: Relation[], summaryPath: string): { nodes: (CanvasText | CanvasGroup)[]; edges: CanvasEdge[] } {
  const texts: CanvasText[] = notes.map(note => ({ id: `node-${note.ordinal}`, type: 'text', x: Math.round(note.node.x), y: Math.round(note.node.y), width: 245, height: 112, text: `[${text(note.node.title)}](${markdownDestination(summaryPath)}#^${nodeAnchor(note.ordinal)})` }));
  const byId = new Map(notes.map(note => [note.node.id, note])), groups: CanvasGroup[] = [];
  for (const note of notes) {
    const members = project.memberships.filter(value => value.groupNodeId === note.node.id).map(value => byId.get(value.memberNodeId)).filter((value): value is NoteCapture => !!value);
    if (!members.length) continue;
    const points = [note, ...members], x = Math.round(Math.min(...points.map(value => value.node.x)) - 24), y = Math.round(Math.min(...points.map(value => value.node.y)) - 40);
    groups.push({ id: `group-${note.ordinal}`, type: 'group', x, y, width: Math.round(Math.max(...points.map(value => value.node.x + 245)) - x + 24), height: Math.round(Math.max(...points.map(value => value.node.y + 112)) - y + 24), label: note.node.title });
  }
  texts.sort((a, b) => notes[Number(a.id.slice(5)) - 1].node.zIndex - notes[Number(b.id.slice(5)) - 1].node.zIndex);
  const edges: CanvasEdge[] = relations.map((relation, index) => {
    const source = byId.get(relation.sourceNodeId)!, target = byId.get(relation.targetNodeId)!, forward = source.node.x <= target.node.x;
    const typeName = project.relationTypes.find(value => value.code === relation.relationType)?.name ?? relation.relationType;
    return { id: `edge-${index + 1}`, fromNode: `node-${source.ordinal}`, fromSide: forward ? 'right' : 'left', toNode: `node-${target.ordinal}`, toSide: forward ? 'left' : 'right', fromEnd: relation.bidirectional ? 'arrow' : 'none', toEnd: relation.directed || relation.bidirectional ? 'arrow' : 'none', label: relation.label ? `${typeName}: ${relation.label}` : typeName };
  });
  return { nodes: [...groups, ...texts], edges };
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { VaultLink, WorkbenchService } from '../types';
import { safeExternalUrl } from './graphModel';
import remarkWikiLinks from './remarkWikiLinks';
import { t } from '../i18n';
import { hasControlCharacters } from '../storage/layout';

export const MAX_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
const rasterMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
type LinkService = Pick<WorkbenchService, 'resolveVaultLink' | 'openVaultLink'>;
interface LinkProps { sourcePath: string; link: string; service: LinkService }
interface Resolved { key: string; pending: boolean; target: VaultLink | null; error: string | null }

/** Hide only a closed leading Properties block in the preview; never change the note source. */
export function notePreviewBody(text: string): string {
  const opening = /^\uFEFF?---[ \t]*\r?\n/u.exec(text);
  if (!opening) return text;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gmu;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(text);
  return end ? text.slice(end.index + end[0].length) : text;
}

/** Candidate syntax only. The host authoritatively checks indexed path, scope, symlinks and bytes. */
export function isVaultDestination(raw: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(raw.trim()); } catch { return false; }
  return decoded.length > 0 && !hasControlCharacters(decoded) && !/^[a-z][a-z\d+.-]*:|^\/\/|\\/iu.test(decoded);
}
function localResourceURL(url: string): boolean {
  try { const parsed=new URL(url);return parsed.protocol==='app:'||(parsed.protocol==='file:'&&['','localhost'].includes(parsed.hostname)); } catch { return false; }
}
function useResolvedLink({ service, sourcePath, link }: LinkProps): Resolved {
  const key = `${sourcePath}\0${link}`;
  const [state, setState] = useState<Resolved>({ key, pending: true, target: null, error: null });
  const allowed = isVaultDestination(link);
  useEffect(() => {
    let cancelled = false;
    if (allowed) void service.resolveVaultLink(sourcePath, link).then(target => {
      if (!cancelled) setState({ key, pending: false, target, error: target ? null : t('Файл в этом хранилище не найден.', 'File not found in this vault.') });
    }).catch((error: unknown) => {
      if (!cancelled) setState({ key, pending: false, target: null, error: error instanceof Error ? error.message : t('Не удалось проверить локальный файл.', 'Could not check the local file.') });
    });
    return () => { cancelled = true; };
  }, [service, sourcePath, link, key, allowed]);
  if (!allowed) return { key, pending: false, target: null, error: t('Автоматическая загрузка внешнего ресурса запрещена.', 'Automatic loading of external resources is blocked.') };
  return state.key === key ? state : { key, pending: true, target: null, error: null };
}
function LocalLink({ children, ...props }: LinkProps & { children: React.ReactNode }) {
  const result = useResolvedLink(props), [error, setError] = useState<string | null>(null);
  return <span className="tw-vault-link-wrap"><button type="button" className="tw-vault-link" role="link" disabled={result.pending || !result.target}
    title={result.target ? `${result.target.openMode === 'reveal' ? t('Показать файл: ', 'Show file: ') : ''}${result.target.path}` : result.error ?? t('Проверка файла…', 'Checking file…')} onClick={() => {
      setError(null); void props.service.openVaultLink(props.sourcePath, props.link).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : t('Не удалось открыть файл.', 'Could not open the file.')));
    }}>{children}</button>{error && <span role="alert"> {error}</span>}</span>;
}
export function VaultMarkdownLink({ children, ...props }: LinkProps & { children: React.ReactNode }) {
  const external = safeExternalUrl(props.link);
  if (external) return <a href={external} target="_blank" rel="noopener noreferrer">{children}</a>;
  return isVaultDestination(props.link) ? <LocalLink {...props}>{children}</LocalLink> : <span>{children}</span>;
}
function VaultMedia({ target, alt }: { target: VaultLink; alt?: string }) {
  const audio = useRef<HTMLAudioElement>(null), video = useRef<HTMLVideoElement>(null);
  const mediaKey=`${target.mediaKind}\0${target.resourceUrl}`,[failedAt,setFailedAt]=useState<string|null>(null),failed=failedAt===mediaKey;
  useEffect(() => {
    const player = target.mediaKind === 'audio' ? audio.current : target.mediaKind === 'video' ? video.current : null;
    return () => { if (player) { player.pause(); player.removeAttribute('src'); player.load(); } };
  }, [target.resourceUrl, target.mediaKind, failed]);
  if (!localResourceURL(target.resourceUrl)) return <span className="tw-image-blocked">{t('Недопустимый адрес локального ресурса.', 'Invalid local resource URL.')}</span>;
  if (failed) return <span className="tw-image-blocked">{t('Просмотр не поддерживается; оригинал доступен по кнопке.', 'Preview is not supported; use the button to access the original.')}</span>;
  if (target.mediaKind === 'image' && rasterMimes.has(target.mimeType) && Number.isSafeInteger(target.byteSize) && target.byteSize >= 0 && target.byteSize < MAX_INLINE_IMAGE_BYTES) return <img className="tw-vault-image" src={target.resourceUrl} alt={alt || target.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedAt(mediaKey)} />;
  if (target.mediaKind === 'audio') return <audio ref={audio} src={target.resourceUrl} controls preload="none" onError={() => setFailedAt(mediaKey)} />;
  if (target.mediaKind === 'video') return <video className="tw-vault-video" ref={video} src={target.resourceUrl} controls preload="none" onError={() => setFailedAt(mediaKey)} />;
  return <span className="tw-image-blocked">{target.mediaKind === 'image' ? t('Изображение слишком велико или формат не поддерживается.', 'The image is too large or its format is not supported.') : t('Для этого формата встроенный просмотр недоступен.', 'Inline preview is not available for this format.')}</span>;
}
export function VaultMarkdownEmbed({ alt, ...props }: LinkProps & { alt?: string }) {
  const result = useResolvedLink(props), [error, setError] = useState<string | null>(null), target = result.target;
  if (!isVaultDestination(props.link)) return <span className="tw-image-blocked">▧ {alt || t('Изображение из текста', 'Image from text')} · {t('внешняя загрузка отключена', 'external loading is disabled')}</span>;
  if (!target) return <span className="tw-image-blocked">▧ {alt || t('Вложение', 'Attachment')} · {result.pending ? t('проверка файла…', 'checking file…') : result.error}</span>;
  return <span className="tw-vault-embed">
    {!target.isNote && target.mimeType !== 'application/pdf' && <span className="tw-vault-embed-preview"><VaultMedia key={`${target.path}\0${target.resourceUrl}`} target={target} alt={alt} /></span>}
    <button type="button" className="tw-vault-link" title={target.path} onClick={() => {
      setError(null); void props.service.openVaultLink(props.sourcePath, props.link).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : t('Не удалось открыть оригинал.', 'Could not open the original.')));
    }}>{target.openMode === 'reveal' ? t('Показать файл', 'Show file') : target.isNote ? t('Открыть заметку', 'Open note') : target.mimeType === 'application/pdf' ? t('Открыть PDF', 'Open PDF') : target.mediaKind === 'file' ? t('Показать файл', 'Show file') : t('Показать оригинал', 'Show original')}: {alt || target.title}</button>
    {error && <span role="alert"> {error}</span>}
  </span>;
}
/** Local note rendering keeps the note's own sourcePath; no Asset registration or copying occurs. */
export function VaultMarkdown({ text, sourcePath, service, preserveProperties = false }: { text: string; sourcePath: string; service: LinkService; preserveProperties?: boolean }) {
  const components = useMemo<Components>(()=>({
    a: ({ href, children }) => <VaultMarkdownLink sourcePath={sourcePath} service={service} link={href ?? ''}>{children}</VaultMarkdownLink>,
    img: ({ src, alt }) => <VaultMarkdownEmbed sourcePath={sourcePath} service={service} link={typeof src === 'string' ? src : ''} alt={alt} />,
  }),[sourcePath,service]);
  return <div className="tw-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLinks]} skipHtml
    urlTransform={candidate => isVaultDestination(candidate) || safeExternalUrl(candidate) ? candidate : ''}
    components={components}>{preserveProperties ? text : notePreviewBody(text)}</ReactMarkdown></div>;
}

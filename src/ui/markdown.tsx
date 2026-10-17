import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeExternalUrl } from './graphModel';
import type { WorkbenchService } from '../types';
import { VaultMarkdown } from './vaultMarkdown';
import { t } from '../i18n';

/** Never execute HTML or request Markdown images, including images in linked notes. */
export function SafeMarkdown({ text, sourcePath, service }: { text: string; sourcePath?: string; service?: WorkbenchService }) {
  if (sourcePath && service) return <VaultMarkdown text={text} sourcePath={sourcePath} service={service} />;
  return <div className="tw-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="tw-image-blocked">▧ {alt || t('Изображение из текста', 'Image from text')} · {t('откройте заметку в Obsidian', 'open the note in Obsidian')}</span>,
    a: ({ href, children }) => safeExternalUrl(href) ? <a href={safeExternalUrl(href)} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  }}>{text}</ReactMarkdown></div>;
}

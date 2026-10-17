import React from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkbenchService } from '../types';
import { VaultMarkdown } from './vaultMarkdown';
import { t } from '../i18n';

export interface ReportPreviewOptions {
  title: string;
  text: string;
  sourcePath: string;
  service: WorkbenchService;
}

/** The host verifies the immutable report and authorizes its source path before mounting. */
export function mountReportPreview(container: HTMLElement, options: ReportPreviewOptions): () => void {
  const root = createRoot(container);
  root.render(<main className="tw-obsidian tw-report-view" aria-label={t(`Отчёт: ${options.title}`, `Report: ${options.title}`)}>
    <header className="tw-report-heading"><span className="tw-eyebrow">{t('TRACEWEAVE · ОТЧЁТ', 'TRACEWEAVE · REPORT')}</span><h1>{options.title}</h1><p className="tw-muted">{t('Неизменяемый снимок · только чтение. Изменения исходных заметок не меняют этот отчёт.', 'Immutable snapshot · read only. Changes to source notes do not change this report.')}</p></header>
    <section className="tw-report-content" aria-label={t('Содержимое отчёта', 'Report contents')} tabIndex={0}>
      <VaultMarkdown text={options.text} sourcePath={options.sourcePath} service={options.service} preserveProperties />
    </section>
  </main>);
  return () => root.unmount();
}

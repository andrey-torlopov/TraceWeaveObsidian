import React from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkbenchService } from '../types';
import { VaultMarkdown } from './vaultMarkdown';

export interface ReportPreviewOptions {
  title: string;
  text: string;
  sourcePath: string;
  service: WorkbenchService;
}

/** The host verifies the immutable report and authorizes its source path before mounting. */
export function mountReportPreview(container: HTMLElement, options: ReportPreviewOptions): () => void {
  const root = createRoot(container);
  root.render(<main className="tw-obsidian tw-report-view" aria-label={`Отчёт: ${options.title}`}>
    <header className="tw-report-heading"><span className="tw-eyebrow">TRACEWEAVE · ОТЧЁТ</span><h1>{options.title}</h1><p className="tw-muted">Неизменяемый снимок · только чтение. Изменения исходных заметок не меняют этот отчёт.</p></header>
    <section className="tw-report-content" aria-label="Содержимое отчёта" tabIndex={0}>
      <VaultMarkdown text={options.text} sourcePath={options.sourcePath} service={options.service} preserveProperties />
    </section>
  </main>);
  return () => root.unmount();
}

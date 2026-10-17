import { t } from './i18n';
import { digest, strictJSON, type ProjectRepository } from './storage/repository';
import { verifyReport } from './portability';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const REPORT = new RegExp(`^(\\.twdata/projects/(${UUID})/reports/(${UUID}))/report\\.md$`, 'u');
export const MAX_REPORT_PREVIEW_BYTES = 16_777_216;

/** A hidden viewer is scoped to one registered immutable snapshot, never arbitrary metadata. */
export function reportDocumentInfo(relative: string): { directory: string; projectId: string; snapshotId: string } | null {
  const match = REPORT.exec(relative);
  return match && match[0] === relative ? { directory: match[1]!, projectId: match[2]!, snapshotId: match[3]! } : null;
}

export async function loadReportDocument(repository: ProjectRepository, relative: string): Promise<{ title: string; text: string; sourcePath: string }> {
  const info = reportDocumentInfo(relative);
  if (!info) throw new Error(t('Можно открыть только Markdown зарегистрированного снимка TraceWeave.', "Only Markdown from a registered TraceWeave snapshot can be opened."));
  const project = await repository.read(info.projectId);
  const record = project.snapshots.find(snapshot => snapshot.id === info.snapshotId && snapshot.path === `${info.directory}/snapshot.json`);
  if (!record) throw new Error(t('Снимок отсутствует в исследовании.', "The snapshot is not registered in this research."));
  const integrity = strictJSON<{ reportSha256?: unknown }>(await repository.readText(`${info.directory}/integrity.json`, 16_777_216));
  if (typeof integrity.reportSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(integrity.reportSha256)) throw new Error(t('Некорректная контрольная сумма отчёта.', "Invalid report checksum."));
  await verifyReport(repository.vaultRoot, record);
  let text: string;
  try { text = await repository.readText(relative, MAX_REPORT_PREVIEW_BYTES); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'file_limit') throw new Error(t('Отчёт превышает лимит предпросмотра 16 MiB. Полный файл сохранён; откройте его через файловый менеджер.', "The report exceeds the 16 MiB preview limit. The complete file is saved; open it in your file manager."));
    throw error;
  }
  if (digest(text) !== integrity.reportSha256) throw new Error(t('Отчёт изменился во время чтения. Снимок не показан.', "The report changed while being read. The snapshot was not displayed."));
  return { title: record.title, text, sourcePath: relative };
}

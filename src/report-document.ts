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
  if (!info) throw new Error('Можно открыть только Markdown зарегистрированного снимка TraceWeave.');
  const project = await repository.read(info.projectId);
  const record = project.snapshots.find(snapshot => snapshot.id === info.snapshotId && snapshot.path === `${info.directory}/snapshot.json`);
  if (!record) throw new Error('Снимок отсутствует в исследовании.');
  const integrity = strictJSON<{ reportSha256?: unknown }>(await repository.readText(`${info.directory}/integrity.json`, 16_777_216));
  if (typeof integrity.reportSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(integrity.reportSha256)) throw new Error('Некорректная контрольная сумма отчёта.');
  await verifyReport(repository.vaultRoot, record);
  let text: string;
  try { text = await repository.readText(relative, MAX_REPORT_PREVIEW_BYTES); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'file_limit') throw new Error('Отчёт превышает лимит предпросмотра 16 MiB. Полный файл сохранён; откройте его через файловый менеджер.');
    throw error;
  }
  if (digest(text) !== integrity.reportSha256) throw new Error('Отчёт изменился во время чтения. Снимок не показан.');
  return { title: record.title, text, sourcePath: relative };
}

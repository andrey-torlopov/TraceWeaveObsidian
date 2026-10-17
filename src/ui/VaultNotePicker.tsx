import React, { useState } from 'react';
import { localeCode, t } from '../i18n';

interface Note { path: string; title: string }
export function VaultNotePicker({ notes, value, onChange }: { notes: readonly Note[]; value: string; onChange: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const folded = query.trim().normalize('NFC').toLocaleLowerCase(localeCode());
  const matches = [...notes].filter((note) => `${note.title}\n${note.path}`.normalize('NFC').toLocaleLowerCase(localeCode()).includes(folded)).sort((a, b) => a.path.localeCompare(b.path, localeCode()));
  return <section className="tw-vault-note-picker"><label className="tw-field"><span>{t('Поиск заметок по имени или пути', 'Find notes by name or path')}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Любая папка этого vault', 'Any folder in this vault')} /></label>
    <p className="tw-muted">{t('Markdown-заметки из всех папок vault, включая Исследования/Заметки. Скрытые служебные файлы .twdata недоступны для подключения.', 'Markdown notes from all vault folders, including Исследования/Заметки. Hidden .twdata technical files cannot be linked.')}</p>
    <div className="tw-note-options" role="listbox" aria-label={t('Заметки во всех папках vault', 'Notes in all vault folders')}>{matches.map((note) => <button key={note.path} type="button" role="option" aria-selected={note.path === value} onClick={() => onChange(note.path)}><strong>{note.title}</strong><span>{note.path}</span></button>)}{!matches.length && <p className="tw-muted">{notes.length ? t('По этому запросу заметок нет.', 'No notes match this search.') : t('Нет доступных Markdown-заметок для подключения.', 'No Markdown notes are available to link.')}</p>}</div>
    {value && <p className="tw-selected-note"><span>{t('Выбрана заметка:', 'Selected note:')}</span> <strong>{value}</strong>{!notes.some((note) => note.path === value) && <span className="tw-error"> · {t('Файл сейчас недоступен', 'File is currently unavailable')}</span>}</p>}
  </section>;
}

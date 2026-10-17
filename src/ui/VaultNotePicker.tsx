import React, { useState } from 'react';

interface Note { path: string; title: string }
export function VaultNotePicker({ notes, value, onChange }: { notes: readonly Note[]; value: string; onChange: (path: string) => void }) {
  const [query, setQuery] = useState('');
  const folded = query.trim().normalize('NFC').toLocaleLowerCase();
  const matches = [...notes].filter((note) => `${note.title}\n${note.path}`.normalize('NFC').toLocaleLowerCase().includes(folded)).sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return <section className="tw-vault-note-picker"><label className="tw-field"><span>Поиск заметок по имени или пути</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Любая папка этого vault" /></label>
    <p className="tw-muted">Markdown-заметки из всех папок vault, включая Исследования/Заметки. Скрытые служебные файлы .twdata недоступны для подключения.</p>
    <div className="tw-note-options" role="listbox" aria-label="Заметки во всех папках vault">{matches.map((note) => <button key={note.path} type="button" role="option" aria-selected={note.path === value} onClick={() => onChange(note.path)}><strong>{note.title}</strong><span>{note.path}</span></button>)}{!matches.length && <p className="tw-muted">{notes.length ? 'По этому запросу заметок нет.' : 'Нет доступных Markdown-заметок для подключения.'}</p>}</div>
    {value && <p className="tw-selected-note"><span>Выбрана заметка:</span> <strong>{value}</strong>{!notes.some((note) => note.path === value) && <span className="tw-error"> · Файл сейчас недоступен</span>}</p>}
  </section>;
}

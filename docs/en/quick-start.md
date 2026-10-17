# Quick Start

*[Русский](../ru/quick-start.md)*

[Install and enable TraceWeave](installation.md). The interface currently uses Russian; the labels below match the actual buttons.

## Start with Your Notes

1. Run **TraceWeave: Открыть исследование** (Open research) from the command palette.
2. Select **Создать исследование**, enter a name, and save.
3. Choose **Подключить заметку из vault** and select a Markdown file from any ordinary folder in the same vault. The note stays in place. Alternatively, right-click a note in Obsidian's file explorer and use **Подключить к TraceWeave**, or run **TraceWeave: Подключить текущую заметку к исследованию** for the open note.
4. Choose **+ Документ** to create another document. Its Markdown file is placed under `Исследования/Заметки/`.
5. Select a card and choose **Открыть заметку** to edit its text with Obsidian's native editor. **Метаданные** edits the graph title, type, assessment, attributes and sources.

The graph contains only explicitly connected documents. A `[[wikilink]]` in note text does not automatically create a graph relationship.

## Connect and Organize

Drag a connector between cards, or use **+ Связь** in a document's inspector. Enter an optional label, set direction and assessment, then save. New relationships mean “related”; there is no type picker. **Гипотеза** renders a dashed line. Other assessments use a solid line.

Zoom out to see circular nodes; zoom in to read cards again. Use **Читать** to expand a card or **Показать всё** to fit the graph. Use Shift+click for multiple selection, then **Сгруппировать**. Groups have one level; collapsing a group does not change the actual relationship endpoints.

Switch to **Досье** for a list or cards, **Материалы** for the file library and **Корзина** to restore a deletion batch. Graph deletion keeps Markdown and original files.

## Add Files and Preserve Work

In the inspector, choose **Добавить файлы** to import and attach selected files. **Из библиотеки** attaches an existing library item. Images, audio and video can be previewed when their format is supported; PDF and arbitrary files remain available even without an embedded viewer.

Use **Отчёт** to capture a read-only snapshot; **Снимки** opens existing ones. Use **Копия vault ZIP** for a portable backup of the current research, then keep that ZIP somewhere outside the vault. Despite the button's name, it does not copy the entire vault. Read [what backup includes and its import limitations](backup-import.md) before relying on it.

[Features](features.md) · [Data and security](data-and-security.md) · [Documentation](index.md)

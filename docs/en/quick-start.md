# Quick Start

*[Русский](../ru/quick-start.md)*

[Install and enable TraceWeave](installation.md). The labels below match TraceWeave **0.2.0**, with Russian equivalents alongside the English labels. The interface follows Obsidian's language; override it under **Settings → TraceWeave → Interface language**.

## Start with Your Notes

1. Run **TraceWeave: Open research** (**Открыть исследование**) from the command palette.
2. Select **Create research** (**Создать исследование**), enter a name, and save.
3. Choose **+ Document** (**+ Документ**), enter a node title and choose **Choose a vault note** (**Выбрать заметку из хранилища**). Select a Markdown file from an ordinary folder in the same vault. Its text, Properties, filename and location stay unchanged; the graph title may differ from its filename.
4. To create a note instead, choose **Create a new note** (**Создать новую заметку**) in that dialog. Obsidian's new-note location setting determines its folder. An existing file is never replaced; a name collision receives a numbered suffix.
5. Double-click a node, or choose **Open note** (**Открыть заметку**), to open its bound file in Obsidian's editor. **Metadata** (**Метаданные**) edits the graph title, type, assessment, attributes and sources.

You can also right-click a note in Obsidian's file explorer → **Link to TraceWeave** (**Подключить к TraceWeave**), or run **TraceWeave: Link current note to research** (**Подключить текущую заметку к исследованию**). These shortcuts use the note's filename as its initial graph title.

The graph contains only explicitly connected documents. A `[[wikilink]]` in note text does not automatically create a graph relationship.

## Connect and Organize

Drag a connector between cards, or use **+ Relation** (**+ Связь**) in a document's inspector. Enter an optional label, set direction and assessment, then save. New relationships mean “related”; there is no type picker. **Hypothesis** (**Гипотеза**) renders a dashed line. Other assessments use a solid line.

Zoom out to see circular nodes; zoom in to read cards again. Use **Read** (**Читать**) to expand a card; double-click opens the note instead of expanding it. **Show all** (**Показать всё**) fits the graph. Use Shift+click for multiple selection, then **Group selection** (**Сгруппировать**). Groups have one level; collapsing a group does not change the actual relationship endpoints.

Switch to **Dossier** (**Досье**) for a list or cards, **Materials** (**Материалы**) for the file library and **Trash** (**Корзина**) to restore a deletion batch. Graph deletion keeps Markdown and original files.

## Add Files and Preserve Work

In the inspector, choose **Add files** (**Добавить файлы**) to import and attach selected files. **From library** (**Из библиотеки**) attaches an existing library item. Images, audio and video can be previewed when their format is supported; PDF and arbitrary files remain available even without an embedded viewer.

The default visible data folder is `TWData`. Attachments are grouped by type under `TWData/projects/<stable research folder>/`; reports and ZIP exports use `TWData/exports/`. Change the parent under **Settings → TraceWeave → Data folder** (**Папка данных**). It does not set the folder for node notes.

Use **Export report** (**Экспорт отчёта**) for a phone-readable `summary.md` and `scheme.canvas`, or **Report snapshot** (**Снимок отчёта**) for an immutable capture. **Snapshots** (**Снимки**) opens saved captures. **Vault backup ZIP** (**Копия vault ZIP**) creates a portable backup of the selected research; keep a copy outside the vault. Despite its name, it does not copy the entire vault. Read [backup contents and import limits](backup-import.md).

## Check Missing Notes and Files

Choose **Project diagnostics** (**Диагностика проекта**) beside import/export. It checks linked notes and registered file hashes. Missing, changed or invalid files appear with their paths; affected graph and dossier nodes turn red.

Opening a missing node note offers **Choose a vault note** or **Create a new note**. A replacement note uses the node title and Obsidian's folder setting; relinking keeps the node ID, attributes and relationships. Restore missing originals from your backup, then run diagnostics again. The plugin does not silently accept changed original bytes.

[Features](features.md) · [Data and security](data-and-security.md) · [Documentation](index.md)

# Features and Files

*[Русский](../ru/features.md)*

## Research over Ordinary Markdown

Create separate investigations with one graph each. Connect existing notes from visible folders anywhere in the same vault without copying them. New documents use visible `Исследования/Заметки/` folders. Edit text in Obsidian, read cards on the graph, or browse a dossier as a list or cards.

Document metadata includes type, an optional per-card emoji, assessment, confidence, typed attributes and evidence. Attributes support text, number, boolean, date, date/time, URL and coordinates. Evidence can reference another document, a registered file or an explicit URL, with a quotation, locator and comment.

Search and filter the research by text, type, assessment and group. Renaming a note through Obsidian updates its central binding. If a note was moved and edited while Obsidian was closed, explicitly relink it through **Метаданные → Привязка заметки**; the node ID and relationships remain intact.

## Relationships and Groups

Create multiple relationships between the same documents, with an optional label, direction, assessment, confidence, note and evidence. New relationships use one “related” type. Only a user-entered label appears on the graph; historical type values are preserved for transfer. A hypothesis is dashed.

Cards become circles below zoom 0.58 and recover their expanded state when you zoom in. One-level groups can collapse and project their members' relationships without rewriting original endpoints. Undo/redo covers metadata operations; note text follows Obsidian's native editing history. Trash preserves files and supports batch restoration.

## Any File as Material

Import explicitly selected files, including files outside the vault; the plugin copies them into `Исследования/Вложения/`. Originals are immutable managed copies with SHA-256, and the same material may have independent attachments to documents. Detaching one attachment does not delete an original. A file can be up to **512 MiB**.

| Material | Available behavior |
|---|---|
| PNG, JPEG, WebP, GIF | Local preview after signature and size checks |
| Audio and video | Local controls without autoplay when Obsidian's engine supports the container and codec |
| PDF | Open the visible original with Obsidian's native viewer |
| Archives, extensionless files, other binaries | Listed and preserved; reveal the file in the system file manager |
| HTML, SVG, unknown formats | Retained as files; no active-content preview |

**Материалы → Проверить оригиналы** checks the library for missing or changed files. The plugin library lists arbitrary formats independently of Obsidian's **Show all file types** setting. Enable that setting separately if you also want such files in the native file explorer.

## Links and Snapshots

Vault wikilinks, local Markdown links and embeds resolve from the source note's path. Supported local images and media are previewed; embedded notes lead to the native editor instead of recursively rendering the vault. Remote images are not fetched automatically. Merely linking a file does not register it in the material library or add it to exports.

Reports capture explicit documents, their connecting relationships and registered attached materials. Later edits do not change the snapshot. The report view is read-only; large reports above the **16 MiB preview limit** remain stored in full and can be revealed in the file manager. Captured snapshot PDFs and other files are revealed there; visible source PDFs still open natively.

[Backup and import/export](backup-import.md) · [Data and security](data-and-security.md) · [Documentation](index.md)

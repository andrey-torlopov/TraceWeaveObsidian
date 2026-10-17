# Backup, Reports and Project Transfer

*[Русский](../ru/backup-import.md)*

## Choose the Right Copy

| Purpose | Action | Included data |
|---|---|---|
| Restore the exact vault or roll back an update | Close Obsidian and copy the whole vault, including hidden files | `.twdata/`, all notes, resources, local journals and vault configuration |
| Move one research project between plugin installations | **Копия vault ZIP** | Confirmed project state, bound notes, registered materials, trash and report snapshot files |
| Transfer a project to/from TraceWeave web | **Архив для TraceWeave**, then **Импорт ZIP** | Portable TraceWeave archive 2.0 under its fixed schema |
| Preserve a readable result at one point in time | **Отчёт**, then **Снимки** | A read-only snapshot of explicit documents, their relationships and attached registered originals |

**Копия vault ZIP** means a backup of the selected research, despite its name. It is not a filesystem backup of every file in the vault. Save exported ZIPs outside the vault as well: their working location is hidden `.twdata/exports/`, revealed in the file manager after export.

## Plugin Backup

The plugin writes `traceweave.obsidian-backup/1.0`. It includes the current confirmed project, notes from any bound vault folder, registered original files, trash, snapshot files and retained import sources. Local command history, UI cache and unsaved buffers from other editors are outside this format.

A file mentioned only by a wikilink, Markdown path or embed is not automatically a registered material. Such arbitrary linked resources are not automatically copied into the backup or report. Import/register them explicitly when the research must carry them; use a full vault copy for everything.

To restore a portable copy, choose **Импорт ZIP** and select the archive. The importer checks the archive, schemas, relationships, file sizes and hashes before publishing a new research project. It generates new IDs and updates graph endpoints and registered attachment bindings together. It never merges the copy into an existing research or overwrites the original project.

**Known limitation: ordinary `[[wikilinks]]` and relative Markdown file/image paths are not fully rewritten during ZIP import.** Imported files have new paths, while some text links retain old targets; they may break or refer to source-vault files. Graph relations are remapped separately. Check note links and media after import, especially when moving to another vault. A complete filesystem copy preserves the original vault layout.

Plugin backups from 0.1.0/0.1.1 are accepted with their historical metadata roots. This is different from updating the plugin in place: an update keeps the same research identity and migrates storage automatically, while ZIP import creates an independent copy.

## TraceWeave Web Archives

Use **Архив для TraceWeave** to produce archive **2.0** for the [web application](https://github.com/andrey-torlopov/TraceWeave). Plugin backup 1.0 is a separate format and is not the web importer's input. The archive schema is validated locally without fetching schemas from the network.

Some local MIME types transfer as generic files with unchanged bytes. Fields that cannot fit the fixed archive schema cause an explicit failure; choose plugin backup to preserve the local model. Unsupported UI properties from imported projects are retained as imported data rather than silently discarded.

Import also accepts the pinned historical archive 1.0 profiles and the old Obsidian export with `Documents/`, `Relations/` and metadata files. In the old export, the current rendered Markdown is kept in full and the original ZIP is retained as a hashed historical source. Missing trash/report history cannot be reconstructed; warnings describe these limits. Prefer archive 2.0 when the original application is available.

## Reports and Recovery

**Отчёт** captures the selected nodes, or the explicit active set when no nodes are selected. Later edits do not alter its stored text or originals. **Снимки** opens the saved report in a read-only view. The preview limit is **16 MiB**; a larger valid report is stored completely and **Показать файл снимка** reveals it in the file manager. Snapshot PDFs and unsupported captured files can also be revealed there.

A report is a result, not a replacement for a restorable project backup. Keep complete backups before upgrades and verify them in a separate vault. Returning from the hidden-data layout to 0.1.0/0.1.1 requires the whole pre-migration vault copy; replacing the plugin binary alone is insufficient.

## Import Limits

Archives are limited to **10 GiB ZIP**, **20 GiB unpacked**, **50,000 entries**, expansion ratio **1,000**, with smaller limits for individual JSON/text files. Original materials are limited to **512 MiB** each. Traversal paths, symlinks, encrypted entries, collisions, unaccounted payloads and integrity failures are rejected. Do not repair a failed import by manually merging `.twdata/projects/` trees or deleting migration markers.

[Installation and updates](installation.md) · [Data and security](data-and-security.md) · [Storage protocol, in Russian](../storage.md) · [Documentation](index.md)

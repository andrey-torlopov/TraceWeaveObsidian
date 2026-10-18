# Backup, Reports and Project Transfer

*[Русский](../ru/backup-import.md)*

## Choose the Right Copy

| Purpose | Action | Included data |
|---|---|---|
| Restore the exact vault or roll back an update | Close Obsidian and copy the whole vault, including hidden files | `.twdata/`, all notes, resources, local journals and vault configuration |
| Move one research project between plugin installations | **Vault backup ZIP** (**Копия vault ZIP**) | Confirmed project state, bound notes, registered materials, trash and report snapshot files |
| Transfer a project to/from TraceWeave web | **TraceWeave archive** (**Архив для TraceWeave**), then **Import ZIP** (**Импорт ZIP**) | Portable TraceWeave archive 2.0 under its fixed schema |
| Read research on a phone without TraceWeave | **Export report** (**Экспорт отчёта**) | `summary.md`, `scheme.canvas` and copies of active materials in `Attachments/` |
| Preserve an internal snapshot at one point in time | **Report snapshot** (**Снимок отчёта**), then **Snapshots** (**Снимки**) | A read-only snapshot of explicit documents, their relationships and attached registered originals |

**Vault backup ZIP** (**Копия vault ZIP**) means a backup of the selected research, despite its name. It is not a filesystem backup of every file in the vault. ZIP exports are saved in the visible `TWData/exports/<stable research folder>/`, or under your configured data folder, and revealed in the file manager. Keep a copy outside the vault as well.

## Plugin Backup

The plugin writes `traceweave.obsidian-backup/1.0`. It includes the current confirmed project, notes from any bound vault folder, registered original files, trash, snapshot files and retained import sources. Local command history, UI cache and unsaved buffers from other editors are outside this format.

A file mentioned only by a wikilink, Markdown path or embed is not automatically a registered material. Such arbitrary linked resources are not automatically copied into the backup or internal snapshot. The readable vault report separately resolves local links as described below. Import/register them explicitly when the research must carry them; use a full vault copy for everything.

To restore a portable copy, choose **Import ZIP** (**Импорт ZIP**) and select the archive. The importer checks the archive, schemas, relationships, file sizes and hashes before publishing a new research project. It generates new IDs and updates graph endpoints and registered attachment bindings together. It never merges the copy into an existing research or overwrites the original project. Imported note payloads become ordinary visible Markdown files under `Исследования/Заметки/<new project ID>/`; this explicit archive import is separate from opening or linking an existing vault note. Originals use the configured `projects/` tree, snapshots use `exports/`, and retained source ZIPs use the project's `archives/` folder.

**Known limitation: ordinary `[[wikilinks]]` and relative Markdown file/image paths are not fully rewritten during ZIP import.** Imported files have new paths, while some text links retain old targets; they may break or refer to source-vault files. Graph relations are remapped separately. Check note links and media after import, especially when moving to another vault. A complete filesystem copy preserves the original vault layout.

Plugin backups from 0.1.0/0.1.1 are accepted with their historical metadata roots. This is different from updating the plugin in place: an update keeps the same research identity and migrates storage automatically, while ZIP import creates an independent copy.

## TraceWeave Web Archives

Use **TraceWeave archive** (**Архив для TraceWeave**) to produce archive **2.0** for the [web application](https://github.com/andrey-torlopov/TraceWeave). Plugin backup 1.0 is a separate format and is not the web importer's input. The archive schema is validated locally without fetching schemas from the network.

Some local MIME types transfer as generic files with unchanged bytes. Fields that cannot fit the fixed archive schema cause an explicit failure; choose plugin backup to preserve the local model. Unsupported UI properties from imported projects are retained as imported data rather than silently discarded.

Import also accepts the pinned historical archive 1.0 profiles and the old Obsidian export with `Documents/`, `Relations/` and metadata files. In the old export, the current rendered Markdown is kept in full and the original ZIP is retained as a hashed historical source. Missing trash/report history cannot be reconstructed; warnings describe these limits. Prefer archive 2.0 when the original application is available.

## Readable Report for Desktop and Mobile

1. In **Settings → TraceWeave → Data folder**, choose the visible parent relative to the vault. The default is `TWData`; reports go into its `exports/` folder. Click **Save**. This setting also controls registered material folders, while node notes follow Obsidian's own new-note setting.
2. Open the research and choose **Export report**. The export includes all active nodes, regardless of search filters, selection or collapsed groups. Save note edits and metadata forms first; unsaved form values are outside the export.
3. Open `summary.md` in the created folder. The plugin opens it automatically. On a phone, open the same file after your sync service has transferred the whole report folder.

```text
TWData/exports/Research title/
  summary.md
  scheme.canvas
  Attachments/
    images/
    video/
    audio/
    documents/
    archives/
    other/
```

Only categories with exported files need to contain files. The folder name follows the current research title; characters unsupported in filenames are replaced. When that destination already exists, including because it contains another export, a new folder `Research title (2)`, `(3)`, and so on is created. Existing reports and source files are never overwritten. Changing the data-folder setting controls future report destinations; existing reports remain where they were created.

`summary.md` combines notes in creation order and shows creation/update dates from node metadata, attributes, relationships, evidence and attachment links. No dates or metadata are inserted into the original notes. Local links to included notes and files are redirected into the report. Code examples retain their literal text. Unavailable sources are reported explicitly; missing required notes or changed registered originals stop export.

`scheme.canvas` is a native Obsidian Canvas containing the original node positions and labeled relationships, including direction. Open it with Obsidian's **Canvas** core plugin enabled. It is a schematic copy; it does not depend on TraceWeave or preserve the interactive editing behavior of its graph. Canvas cards link to the corresponding report sections.

The output is a separate point-in-time copy, not a restorable project backup. Changing the research later does not update an existing report. Use **Export report** again to create a new copy.

The report is stored in a visible folder, so it can travel through your vault's normal sync service independently of hidden `.twdata`. Ensure Markdown, Canvas and the required attachment types are enabled in that service; file size limits and media playback depend on your sync plan and device. Mobile TraceWeave itself remains unsupported.

## Reports and Recovery

**Report snapshot** (**Снимок отчёта**) captures the selected nodes, or the explicit active set when no nodes are selected. New snapshots use `TWData/exports/<stable research folder>/snapshots/<snapshot ID>/` under the configured parent; their JSON, Markdown, integrity record and captured files remain together. Historical snapshots retain their original paths. Later edits do not alter their stored text or originals. **Snapshots** (**Снимки**) opens the saved report in a read-only view. The preview limit is **16 MiB**; a larger valid report is stored completely and **Reveal snapshot file** (**Показать файл снимка**) reveals it in the file manager. Snapshot PDFs and unsupported captured files can also be revealed there.

A report is a result, not a replacement for a restorable project backup. Keep complete backups before upgrades and verify them in a separate vault. **Downgrading from 0.2.0 to 0.1.6 or older requires the whole pre-upgrade vault copy, including hidden `.twdata/`; replacing the plugin binary alone is insufficient.**

The 0.2.0 upgrade copies valid registered originals into visible type-based folders and updates bindings behind a metadata-history barrier. Old files remain for existing text links; missing or changed originals keep their old paths and appear in **Project diagnostics**. Existing node notes and historical snapshots are not moved by this upgrade.

Changing **Data folder** first prepares verified copies, then applies journaled binding changes and publishes the new folder setting. An interrupted change is resumed from `.twdata/layout-change.json` after repository recovery. Keep the old files and journal until recovery finishes; do not manually combine directory trees. Completed reports are not moved. The plugin does not accept changed original bytes as a new baseline automatically.

## Import Limits

Archives are limited to **10 GiB ZIP**, **20 GiB unpacked**, **50,000 entries**, expansion ratio **1,000**, with smaller limits for individual JSON/text files. Original materials are limited to **512 MiB** each. Traversal paths, symlinks, encrypted entries, collisions, unaccounted payloads and integrity failures are rejected. Do not repair a failed import by manually merging `.twdata/projects/` trees or deleting migration markers.

[Installation and updates](installation.md) · [Data and security](data-and-security.md) · [Storage protocol, in Russian](../storage.md) · [Documentation](index.md)
